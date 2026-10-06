// In-place sketch editing on a plane in the 3D viewport.
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Constraint, Entity, Frame, Sketch, Vec2 } from "../../cad/types.ts";
import { solveSketch, measureConstraint } from "../../cad/solver.ts";
import { arcGeometry, circumcircle, point, sketchRegions, TAU } from "../../cad/sketch-geometry.ts";
import { trimOps } from "./trim.ts";
import { palette, type CadScene } from "../viewport/scene.ts";
import { cornerEntities, offsetEntities, patternEntities, type PatternOptions } from "../../cad/sketch-tools.ts";
import { formatLength, getUnits, unitLabel } from "../units.ts";
import {
  add,
  anchorPoints,
  dimensionShape,
  dimensional,
  dist,
  distanceToEntity,
  dot,
  entityPolyline,
  formatMm,
  lineIntersection,
  mul,
  niceStep,
  norm,
  perp,
  relationGlyphs,
  relationSymbols,
  snapPoint,
  sub,
  type PointRef,
  type Snap,
  type SnapTarget,
} from "./model.ts";

export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "centerRectangle"
  | "circle"
  | "arc"
  | "tangentArc"
  | "polygon"
  | "slot"
  | "spline"
  | "point"
  | "dimension"
  | "trim"
  | "offset"
  | "mirror"
  | "fillet"
  | "chamfer"
  | "convert"
  | "pattern";
export type SketchOp = Record<string, any>;
const splineValues = (points: Vec2[]) => Object.fromEntries(points.flatMap((p, i) => [[`x${i}`, p[0]], [`y${i}`, p[1]]]));
export interface SessionHost {
  /** Commit operations through edit_sketch; resolves with the updated sketch. */
  commit(ops: SketchOp[], reason?: string): Promise<Sketch | undefined>;
  changed(): void;
  editValue(constraintId: string, value: number, at: [number, number]): void;
}
type Hit =
  | { kind: "point"; ref: PointRef; p: Vec2 }
  | { kind: "entity"; id: string; p: Vec2 }
  | { kind: "region"; index: number };

export class SketchSession {
  tool: SketchTool = "select";
  construction = false;
  polygonSides = 6;
  /** Last used offset distance and corner fillet/chamfer size. */
  offsetDistance = 5;
  cornerSize = 5;
  /** Offset: the chain picked to offset. */
  private toolPicked = new Set<string>();
  private toolPreview: Entity[] = [];
  private readout?: HTMLDivElement;
  showRelations = true;
  readonly selection = {
    entities: new Set<string>(),
    constraints: new Set<string>(),
    points: [] as PointRef[],
  };
  private sketch: Sketch;
  private frame: Frame;
  private display?: Sketch;
  private clicks: Snap[] = [];
  private cursor?: Snap;
  private hover?: Hit;
  private chain?: { p: Vec2; target?: SnapTarget; job?: Promise<string[]> };
  private press?: { x: number; y: number; hit?: Hit; p: Vec2; box?: boolean };
  private dragging = false;
  private boxEnd?: Vec2;
  private dimPick: (Hit & { kind: "point" | "entity" })[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private optimistic: Entity[] = [];
  private lastAddedConstraints: string[] = [];
  private staticGroup = new THREE.Group();
  private dynamicGroup = new THREE.Group();
  private gridGroup = new THREE.Group();
  private labels = new Map<string, HTMLDivElement>();
  private labelPositions = new Map<string, Vec2>();
  private removeUpdater: () => void;
  private gridStep = 0;
  private disposed = false;
  constructor(
    private scene: CadScene,
    sketch: Sketch,
    frame: Frame,
    private host: SessionHost,
  ) {
    this.sketch = sketch;
    this.frame = frame;
    this.gridGroup.userData.noFit = true;
    this.dynamicGroup.userData.noFit = true;
    scene.sketchLayer.add(this.gridGroup, this.staticGroup, this.dynamicGroup);
    this.removeUpdater = scene.addLabelUpdater(() => this.placeLabels());
    scene.setMouseMode("sketch");
    this.rebuild();
  }
  get current() {
    return this.sketch;
  }
  get pending() {
    return this.optimistic.length > 0;
  }
  update(sketch: Sketch, frame: Frame) {
    this.sketch = sketch;
    this.frame = frame;
    this.display = undefined;
    this.optimistic = [];
    for (const id of [...this.selection.entities]) if (!sketch.entities.some((e) => e.id === id)) this.selection.entities.delete(id);
    for (const id of [...this.selection.constraints]) if (!sketch.constraints.some((c) => c.id === id)) this.selection.constraints.delete(id);
    this.selection.points = this.selection.points.filter((p) => sketch.entities.some((e) => e.id === p.entityId));
    this.rebuild();
  }
  setTool(tool: SketchTool) {
    if (this.tool === "convert" && tool !== "convert") this.scene.setHover(null);
    this.tool = tool;
    this.clicks = [];
    this.chain = undefined;
    this.dimPick = [];
    this.toolPreview = [];
    this.showReadout();
    // Offset works on geometry selected beforehand.
    this.toolPicked = new Set(
      tool === "offset"
        ? [...this.selection.entities].filter((id) => ["line", "arc", "circle", "rectangle"].includes(this.sketch.entities.find((e) => e.id === id)?.type ?? ""))
        : [],
    );
    if (tool === "offset") this.selection.entities.clear();
    this.rebuild();
    this.host.changed();
  }
  /** Prompt for the active sketch tool. */
  get hint(): string {
    switch (this.tool) {
      case "offset":
        return this.toolPicked.size ? "Click to place the offset" : "Select geometry to offset";
      case "mirror":
        return this.selection.entities.size ? "Select a centerline to mirror about · Shift-click any line" : "Select geometry to mirror";
      case "fillet":
      case "chamfer":
        return `Select a corner · ${this.tool === "fillet" ? "R" : ""}${formatLength(this.cornerSize)} ${unitLabel()}`;
      case "convert":
        return "Select model edges or faces to convert";
      case "pattern":
        return this.centerPick ? "Select the point, circle or arc to turn about" : this.selection.entities.size ? "Set the pattern, then accept" : "Select geometry to pattern";
      case "spline":
        return this.clicks.length < 2 ? "Click to place fit points" : "Double-click or Enter to finish · click the first point to close";
    }
    return "";
  }
  clearSelection() {
    this.selection.entities.clear();
    this.selection.constraints.clear();
    this.selection.points = [];
    this.rebuild();
    this.host.changed();
  }
  // -------------------------------------------------------------------------
  // Coordinates
  private world(p: Vec2, lift = 0) {
    const f = this.frame;
    return new THREE.Vector3(...f.origin)
      .addScaledVector(new THREE.Vector3(...f.xDir), p[0])
      .addScaledVector(new THREE.Vector3(...f.yDir), p[1])
      .addScaledVector(new THREE.Vector3(...f.normal), lift);
  }
  private px() {
    return this.scene.pixelSize();
  }
  private local(e: PointerEvent | MouseEvent): Vec2 | null {
    return this.scene.planePoint(e.clientX, e.clientY, this.frame);
  }
  private screen(p: Vec2) {
    return this.scene.toScreen(this.world(p));
  }
  // -------------------------------------------------------------------------
  // Rendering
  private segmentsObject(segments: [Vec2, Vec2][], color: string, width: number, dashed = false, opacity = 1) {
    if (!segments.length) return undefined;
    const positions: number[] = [];
    for (const [a, b] of segments) positions.push(...this.world(a).toArray(), ...this.world(b).toArray());
    const geo = new LineSegmentsGeometry();
    geo.setPositions(positions);
    const px = this.px();
    const material = this.scene.lineMaterial(color, width, {
      dashed,
      dashSize: 5 * px,
      gapSize: 3 * px,
      transparent: opacity < 1 || true,
      opacity,
      depthTest: false,
    } as any);
    const line = new LineSegments2(geo, material as LineMaterial);
    if (dashed) line.computeLineDistances();
    line.renderOrder = 20;
    return line;
  }
  private polylineSegments(points: Vec2[]): [Vec2, Vec2][] {
    const out: [Vec2, Vec2][] = [];
    for (let i = 0; i + 1 < points.length; i++) out.push([points[i], points[i + 1]]);
    return out;
  }
  private clearGroup(group: THREE.Group) {
    for (const child of [...group.children]) {
      (child as any).geometry?.dispose?.();
      const m = (child as any).material;
      if (m?.isLineMaterial) this.scene.releaseLineMaterial(m);
      else m?.dispose?.();
      group.remove(child);
    }
  }
  private shown() {
    const base = this.display ?? this.sketch;
    return this.optimistic.length ? { ...base, entities: [...base.entities, ...this.optimistic] } : base;
  }
  rebuild() {
    if (this.disposed) return;
    this.clearGroup(this.staticGroup);
    const s = this.shown(),
      free = new Set(s.solver.free ?? s.entities.map((e) => e.id)),
      fully = s.solver.dof === 0;
    const groups = new Map<string, { color: string; width: number; dashed: boolean; segs: [Vec2, Vec2][] }>();
    const push = (key: string, color: string, width: number, dashed: boolean, segs: [Vec2, Vec2][]) => {
      const g = groups.get(key) ?? { color, width, dashed, segs: [] };
      g.segs.push(...segs);
      groups.set(key, g);
    };
    const hoverId = this.hover?.kind === "entity" ? this.hover.id : undefined;
    for (const e of s.entities) {
      if (e.type === "point") continue;
      const segs = this.polylineSegments(entityPolyline(e));
      const selected = this.selection.entities.has(e.id) || this.toolPicked.has(e.id),
        hovered = hoverId === e.id;
      const color = selected || hovered ? palette.accent : e.construction ? palette.slate : fully || !free.has(e.id) ? palette.ink : palette.slate;
      const key = `${color}|${e.construction}|${selected || hovered}`;
      push(key, color, selected || hovered ? 2.4 : e.construction ? 1.2 : 1.8, e.construction, segs);
    }
    for (const g of groups.values()) {
      const obj = this.segmentsObject(g.segs, g.color, g.width, g.dashed);
      if (obj) this.staticGroup.add(obj);
    }
    // Points: endpoints, centers and point entities.
    const pointSet: { p: Vec2; color: string; size: number }[] = [];
    for (const e of s.entities) {
      for (const a of anchorPoints(e)) {
        if (a.kind === "mid" || (e.type === "rectangle" && a.kind === "center")) continue;
        const selected = this.selection.points.some((x) => x.entityId === e.id && x.anchor === a.anchor) || (e.type === "point" && this.selection.entities.has(e.id));
        const hovered = this.hover?.kind === "point" && this.hover.ref.entityId === e.id && this.hover.ref.anchor === a.anchor;
        const isPoint = e.type === "point";
        if (e.construction && isPoint && !selected && !hovered && e.values.x === 0 && e.values.y === 0) continue;
        pointSet.push({
          p: a.p,
          color: selected || hovered ? palette.accent : fully || !free.has(e.id) ? palette.ink : palette.slate,
          size: selected || hovered ? 8 : isPoint ? 6.5 : a.kind === "center" ? 4.5 : 5,
        });
      }
    }
    if (pointSet.length) this.staticGroup.add(this.pointsObject(pointSet));
    // Origin.
    const o = 14 * this.px();
    const origin = this.segmentsObject([[[0, 0], [o, 0]]], "#B34238", 1.6);
    const originY = this.segmentsObject([[[0, 0], [0, o]]], "#34834F", 1.6);
    if (origin) this.staticGroup.add(origin);
    if (originY) this.staticGroup.add(originY);
    // Dimensions.
    const px = this.px(),
      dimSegs: [Vec2, Vec2][] = [],
      selSegs: [Vec2, Vec2][] = [];
    for (const c of s.constraints) {
      const shape = dimensionShape(s, c, px);
      if (!shape) continue;
      const target = this.selection.constraints.has(c.id) ? selSegs : dimSegs;
      target.push(...shape.lines);
      for (const arrow of shape.arrows) {
        const back = mul(arrow.dir, -7 * px),
          side = mul(perp(arrow.dir), 2.4 * px);
        target.push([arrow.at, add(add(arrow.at, back), side)], [arrow.at, add(sub(arrow.at, side), mul(arrow.dir, 7 * px))]);
      }
      for (const arc of shape.arcs) {
        const n = 32,
          pts = Array.from({ length: n + 1 }, (_, i) => add(arc.center, [arc.radius * Math.cos(arc.start + (arc.sweep * i) / n), arc.radius * Math.sin(arc.start + (arc.sweep * i) / n)]));
        target.push(...this.polylineSegments(pts));
      }
    }
    const dims = this.segmentsObject(dimSegs, palette.ink, 1, false, 0.85);
    if (dims) this.staticGroup.add(dims);
    const sel = this.segmentsObject(selSegs, palette.accent, 1.4);
    if (sel) this.staticGroup.add(sel);
    this.rebuildGrid(true);
    this.syncLabels(s);
    this.renderDynamic();
  }
  private pointsObject(points: { p: Vec2; color: string; size: number }[]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(points.flatMap((x) => this.world(x.p).toArray()), 3));
    const colors = points.flatMap((x) => new THREE.Color(x.color).toArray());
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute("size", new THREE.Float32BufferAttribute(points.map((x) => x.size * Math.min(window.devicePixelRatio, 2)), 1));
    const material = new THREE.ShaderMaterial({
      vertexShader: "attribute float size; varying vec3 vColor; void main(){ vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = size; }",
      fragmentShader: "varying vec3 vColor; void main(){ vec2 c = gl_PointCoord - 0.5; if (dot(c,c) > 0.25) discard; gl_FragColor = vec4(vColor, 1.0); }",
      vertexColors: true,
      depthTest: false,
      transparent: true,
    });
    const obj = new THREE.Points(geo, material);
    obj.renderOrder = 25;
    return obj;
  }
  private rebuildGrid(force = false) {
    const step = niceStep(this.px() * 22);
    if (!force && step === this.gridStep) return;
    this.gridStep = step;
    this.clearGroup(this.gridGroup);
    const extent = step * 60;
    const minor: [Vec2, Vec2][] = [],
      major: [Vec2, Vec2][] = [];
    for (let i = -60; i <= 60; i++) {
      const target = i % 5 === 0 ? major : minor;
      target.push([[i * step, -extent], [i * step, extent]], [[-extent, i * step], [extent, i * step]]);
    }
    const build = (segs: [Vec2, Vec2][], opacity: number) => {
      const positions: number[] = [];
      for (const [a, b] of segs) positions.push(...this.world(a, -0.001).toArray(), ...this.world(b, -0.001).toArray());
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: palette.slate, transparent: true, opacity, depthWrite: false }));
    };
    this.gridGroup.add(build(minor, 0.08), build(major, 0.16));
  }
  private renderDynamic() {
    this.clearGroup(this.dynamicGroup);
    const px = this.px();
    const preview = this.previewEntities();
    const segs: [Vec2, Vec2][] = [];
    for (const e of preview) segs.push(...this.polylineSegments(entityPolyline(e)));
    const obj = this.segmentsObject(segs, palette.accent, 1.8, this.construction);
    if (obj) this.dynamicGroup.add(obj);
    if (this.cursor && this.tool !== "select") {
      const guides = this.segmentsObject(this.cursor.guides, palette.slate, 1, true, 0.9);
      if (guides) this.dynamicGroup.add(guides);
      const marker = this.cursor.marker;
      const c = this.cursor.p,
        r = 4.5 * px;
      const ring: [Vec2, Vec2][] =
        marker === "mid"
          ? [[[c[0] - r, c[1] - r], [c[0] + r, c[1] - r]], [[c[0] + r, c[1] - r], [c[0], c[1] + r]], [[c[0], c[1] + r], [c[0] - r, c[1] - r]]]
          : marker
            ? this.polylineSegments(Array.from({ length: 17 }, (_, i) => add(c, [r * Math.cos((i / 16) * TAU), r * Math.sin((i / 16) * TAU)])))
            : [[[c[0] - r, c[1]], [c[0] + r, c[1]]], [[c[0], c[1] - r], [c[0], c[1] + r]]];
      const m = this.segmentsObject(ring, marker ? palette.accent : palette.slate, 1.3);
      if (m) this.dynamicGroup.add(m);
    }
    if (this.press?.box && this.boxEnd) {
      const a = this.press.p,
        b = this.boxEnd;
      const box = this.segmentsObject(
        [[a, [b[0], a[1]]], [[b[0], a[1]], b], [b, [a[0], b[1]]], [[a[0], b[1]], a]],
        palette.slate,
        1,
        true,
      );
      if (box) this.dynamicGroup.add(box);
    }
    // Region hover fill in select mode.
    if (this.hover?.kind === "region") {
      const region = sketchRegions(this.shown())[this.hover.index];
      if (region) {
        const shape = new THREE.Shape(region.outer.polygon.map((p) => new THREE.Vector2(p[0], p[1])));
        for (const h of region.holes) shape.holes.push(new THREE.Path(h.polygon.map((p) => new THREE.Vector2(p[0], p[1]))));
        const geo = new THREE.ShapeGeometry(shape);
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: palette.slate, transparent: true, opacity: 0.14, depthTest: false, side: THREE.DoubleSide }));
        const f = this.frame;
        mesh.matrixAutoUpdate = false;
        mesh.matrix.makeBasis(new THREE.Vector3(...f.xDir), new THREE.Vector3(...f.yDir), new THREE.Vector3(...f.normal)).setPosition(...f.origin);
        mesh.renderOrder = 15;
        this.dynamicGroup.add(mesh);
      }
    }
    this.scene.invalidate();
  }
  private syncLabels(s: Sketch) {
    const px = this.px(),
      seen = new Set<string>(),
      glyphs: Vec2[] = [];
    const ensure = (key: string, className: string, text: string, constraintId: string) => {
      seen.add(key);
      let el = this.labels.get(key);
      if (!el) {
        el = document.createElement("div");
        el.dataset.constraint = constraintId;
        this.wireLabel(el, constraintId);
        this.scene.overlay.appendChild(el);
        this.labels.set(key, el);
      }
      el.className = className;
      if (el.textContent !== text) el.textContent = text;
      return el;
    };
    for (const c of s.constraints) {
      const selected = this.selection.constraints.has(c.id);
      const shape = dimensionShape(s, c, px);
      if (shape) {
        ensure(`d:${c.id}`, `sketch-dimension${selected ? " selected" : ""}${c.driven ? " driven" : ""}`, shape.text, c.id);
        this.labelPositions.set(`d:${c.id}`, shape.label);
        continue;
      }
      const symbol = relationSymbols[c.type];
      if (!symbol || !this.showRelations) continue;
      // Coincidences are implied by shared points; show them only when involved geometry is selected.
      if ((c.type === "coincident" || c.type === "pointOn") && !selected && !c.entityIds.some((id) => this.selection.entities.has(id))) continue;
      relationGlyphs(s, c, px).forEach((p, i) => {
        ensure(`r:${c.id}:${i}`, `sketch-relation${selected ? " selected" : ""}`, symbol, c.id);
        // Several relations on one entity sit side by side.
        let q = p;
        for (let k = 1; k < 8 && glyphs.some((g) => dist(g, q) < 10 * px); k++) q = add(p, [k * 12 * px, 0]);
        glyphs.push(q);
        this.labelPositions.set(`r:${c.id}:${i}`, q);
      });
    }
    for (const [key, el] of this.labels)
      if (!seen.has(key)) {
        el.remove();
        this.labels.delete(key);
        this.labelPositions.delete(key);
      }
    this.scene.invalidate();
  }
  private placeLabels() {
    if (this.disposed) return;
    for (const [key, el] of this.labels) {
      const p = this.labelPositions.get(key);
      if (!p) continue;
      const [x, y, visible] = this.screen(p);
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      el.style.display = visible ? "" : "none";
    }
    this.rebuildGrid();
  }
  private wireLabel(el: HTMLDivElement, constraintId: string) {
    let start: { x: number; y: number; moved: boolean } | undefined;
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3) start.moved = true;
      if (start.moved && el.classList.contains("sketch-dimension")) {
        const p = this.local(e);
        if (p) {
          this.labelPositions.set(`d:${constraintId}`, p);
          this.placeLabels();
        }
      }
    });
    el.addEventListener("pointerup", (e) => {
      if (!start) return;
      const moved = start.moved;
      start = undefined;
      if (moved && el.classList.contains("sketch-dimension")) {
        const p = this.local(e);
        if (p) void this.enqueue([{ op: "label", constraintId, label: p }], "Moved dimension");
        return;
      }
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
        this.selection.entities.clear();
        this.selection.points = [];
        this.selection.constraints.clear();
      }
      if (this.selection.constraints.has(constraintId)) this.selection.constraints.delete(constraintId);
      else this.selection.constraints.add(constraintId);
      this.rebuild();
      this.host.changed();
    });
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const c = this.sketch.constraints.find((c) => c.id === constraintId);
      if (!c || c.value === undefined) return;
      const rect = el.getBoundingClientRect();
      this.host.editValue(constraintId, measureConstraint(this.sketch, c) ?? c.value, [rect.left + rect.width / 2, rect.top + rect.height / 2]);
    });
  }
  // -------------------------------------------------------------------------
  // Hit testing
  private hitTest(p: Vec2, withRegions = false): Hit | undefined {
    const s = this.shown(),
      px = this.px();
    let best: Hit | undefined,
      bestD = 8 * px;
    for (const e of s.entities)
      for (const a of anchorPoints(e)) {
        if (a.kind === "mid") continue;
        const d = dist(a.p, p);
        if (d < bestD) {
          bestD = d;
          best = e.type === "point" ? { kind: "entity", id: e.id, p: a.p } : { kind: "point", ref: { entityId: e.id, anchor: a.anchor }, p: a.p };
        }
      }
    if (best) return best;
    bestD = 8 * px;
    for (const e of s.entities) {
      if (e.type === "point") continue;
      const d = distanceToEntity(e, p);
      if (d < bestD) {
        bestD = d;
        best = { kind: "entity", id: e.id, p };
      }
    }
    if (best || !withRegions) return best;
    const regions = sketchRegions(s);
    let smallest = -1;
    regions.forEach((r, i) => {
      if (inside(p, r.outer.polygon) && !r.holes.some((h) => inside(p, h.polygon)) && (smallest < 0 || r.area < regions[smallest].area)) smallest = i;
    });
    return smallest >= 0 ? { kind: "region", index: smallest } : undefined;
  }
  // -------------------------------------------------------------------------
  // Pointer handling
  pointerDown(e: PointerEvent) {
    if (e.button !== 0) return false;
    const p = this.local(e);
    if (!p) return false;
    if (this.tool === "select") {
      const hit = this.hitTest(p);
      this.press = { x: e.clientX, y: e.clientY, hit, p, box: !hit };
      this.dragging = false;
      return true;
    }
    this.press = { x: e.clientX, y: e.clientY, p };
    return true;
  }
  pointerMove(e: PointerEvent) {
    const p = this.local(e);
    if (!p) return;
    if (this.press && this.tool === "select" && e.buttons & 1) {
      const moved = Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 3;
      if (moved && this.press.hit && this.press.hit.kind !== "region") {
        this.dragging = true;
        this.liveDrag(this.press.hit, p);
        return;
      }
      if (moved && this.press.box) {
        this.boxEnd = p;
        this.renderDynamic();
        return;
      }
    }
    if (this.tool === "select") {
      const hit = this.hitTest(p, true);
      if (JSON.stringify(hit) !== JSON.stringify(this.hover)) {
        const entityChanged = hit?.kind !== this.hover?.kind || (hit?.kind !== "region" && JSON.stringify(hit) !== JSON.stringify(this.hover));
        this.hover = hit;
        if (entityChanged) this.rebuild();
        else this.renderDynamic();
      }
      return;
    }
    if (this.tool === "convert") {
      // Model edges and faces behind the sketch.
      const pick = this.scene.pick(e.clientX, e.clientY, { edges: true, faces: true });
      this.scene.setHover(pick.kind === "edge" || pick.kind === "face" ? pick : null);
      return;
    }
    if (["offset", "mirror", "fillet", "chamfer", "pattern"].includes(this.tool)) {
      this.toolHover(p, e);
      return;
    }
    const from = this.anchorFrom();
    this.cursor = snapPoint(this.shown(), p, this.px(), { from });
    if (this.tool === "dimension") {
      const hit = this.hitTest(p);
      if (JSON.stringify(hit) !== JSON.stringify(this.hover)) {
        this.hover = hit;
        this.rebuild();
        return;
      }
    }
    this.renderDynamic();
  }
  pointerUp(e: PointerEvent) {
    const press = this.press;
    this.press = undefined;
    if (!press) return;
    const p = this.local(e);
    if (!p) return;
    if (this.tool === "select") {
      if (this.dragging && press.hit && press.hit.kind !== "region") {
        this.dragging = false;
        this.commitDrag(press.hit, p);
        return;
      }
      if (press.box && this.boxEnd) {
        this.boxSelect(press.p, this.boxEnd, e.shiftKey || e.metaKey || e.ctrlKey);
        this.boxEnd = undefined;
        this.renderDynamic();
        return;
      }
      this.boxEnd = undefined;
      this.clickSelect(press.hit, e.shiftKey || e.metaKey || e.ctrlKey);
      return;
    }
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) return;
    if (this.tool === "convert") {
      const pick = this.scene.pick(e.clientX, e.clientY, { edges: true, faces: true });
      if (pick.kind !== "edge" && pick.kind !== "face") return;
      const { point: _point, ...ref } = pick.ref;
      void this.enqueue([{ op: "convert", refs: [ref], construction: this.construction }], "Converted model edges");
      return;
    }
    if (this.tool === "offset") return this.offsetClick(p);
    if (this.tool === "mirror") return this.mirrorClick(p, e.shiftKey || e.metaKey || e.ctrlKey);
    if (this.tool === "pattern") return this.patternClick(p);
    if (this.tool === "fillet" || this.tool === "chamfer") return this.cornerClick(p);
    const snap = snapPoint(this.shown(), p, this.px(), { from: this.anchorFrom() });
    if (this.tool === "dimension") this.dimensionClick(p, snap);
    else if (this.tool === "trim") this.trimAt(p);
    else this.toolClick(snap);
  }
  doubleClick(e: MouseEvent) {
    if (this.tool === "line") this.endChain();
    if (this.tool === "spline") this.finishSpline();
    void e;
  }
  keyDown(e: KeyboardEvent): boolean {
    const key = e.key.toLowerCase();
    if (e.key === "Escape") {
      if (this.toolPicked.size) {
        this.toolPicked.clear();
        this.toolPreview = [];
        this.showReadout();
        this.rebuild();
        this.host.changed();
      } else if (this.clicks.length || this.chain || this.dimPick.length) {
        this.clicks = [];
        this.endChain();
        this.dimPick = [];
        this.renderDynamic();
      } else if (this.tool !== "select") this.setTool("select");
      else this.clearSelection();
      return true;
    }
    if (e.key === "Enter") {
      if (this.tool === "spline") this.finishSpline();
      else this.endChain();
      return true;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      this.deleteSelection();
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const map: Record<string, SketchTool> = { l: "line", r: "rectangle", c: "circle", a: "arc", p: "point", d: "dimension", t: "trim", s: "select", v: "select", g: "polygon" };
    if (map[key]) {
      this.setTool(map[key]);
      return true;
    }
    if (key === "x") {
      this.toggleConstruction();
      return true;
    }
    return false;
  }
  private anchorFrom(): Vec2 | undefined {
    if (this.tool === "line" && this.chain) return this.chain.p;
    if (["line", "tangentArc"].includes(this.tool) && this.clicks[0]) return this.clicks[0].p;
    return undefined;
  }
  // -------------------------------------------------------------------------
  // Selection
  private clickSelect(hit: Hit | undefined, additive: boolean) {
    if (!additive) {
      this.selection.entities.clear();
      this.selection.constraints.clear();
      this.selection.points = [];
    }
    if (hit?.kind === "entity") {
      if (this.selection.entities.has(hit.id)) this.selection.entities.delete(hit.id);
      else this.selection.entities.add(hit.id);
    } else if (hit?.kind === "point") {
      const i = this.selection.points.findIndex((x) => x.entityId === hit.ref.entityId && x.anchor === hit.ref.anchor);
      if (i >= 0) this.selection.points.splice(i, 1);
      else this.selection.points.push(hit.ref);
    }
    this.rebuild();
    this.host.changed();
  }
  private boxSelect(a: Vec2, b: Vec2, additive: boolean) {
    if (!additive) this.clearSelection();
    const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
      hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const within = (p: Vec2) => p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1];
    for (const e of this.shown().entities) if (entityPolyline(e).every(within)) this.selection.entities.add(e.id);
    this.rebuild();
    this.host.changed();
  }
  private liveDrag(hit: Hit, p: Vec2) {
    const clone: Sketch = structuredClone(this.sketch);
    try {
      if (hit.kind === "entity") {
        const e = clone.entities.find((x) => x.id === hit.id)!;
        if (e.type === "circle") {
          e.values.radius = Math.max(0.01, dist(p, [e.values.x, e.values.y]));
          solveSketch(clone);
        } else {
          const offset = sub(p, hit.p);
          const anchor = e.type === "arc" ? "mid" : "center";
          solveSketch(clone, { drag: { entityId: e.id, anchor, target: add(point(this.sketch.entities.find((x) => x.id === e.id)!, anchor), offset) } });
        }
      } else if (hit.kind === "point") solveSketch(clone, { drag: { entityId: hit.ref.entityId, anchor: hit.ref.anchor, target: p } });
      this.display = clone;
      this.rebuild();
    } catch {
      /* conflicting drag frame: keep the last valid display */
    }
  }
  private commitDrag(hit: Hit, p: Vec2) {
    if (hit.kind === "entity") {
      const e = this.sketch.entities.find((x) => x.id === hit.id)!;
      if (e.type === "circle") {
        void this.enqueue([{ op: "set", entityId: e.id, values: { radius: Math.max(0.01, dist(p, [e.values.x, e.values.y])) } }], "Resized circle");
        return;
      }
      const anchor = e.type === "arc" ? "mid" : "center";
      void this.enqueue([{ op: "drag", entityId: e.id, anchor, target: add(point(e, anchor), sub(p, hit.p)) }], "Dragged sketch geometry");
    } else if (hit.kind === "point")
      void this.enqueue([{ op: "drag", entityId: hit.ref.entityId, anchor: hit.ref.anchor, target: p }], "Dragged sketch point");
  }
  deleteSelection() {
    const ops: SketchOp[] = [];
    for (const id of this.selection.constraints) ops.push({ op: "unconstrain", constraintId: id });
    const removed = new Set(this.selection.entities);
    for (const p of this.selection.points) {
      const e = this.sketch.entities.find((x) => x.id === p.entityId);
      if (e?.type === "point") removed.add(e.id);
    }
    for (const id of removed) ops.push({ op: "delete", entityId: id });
    const dropped = new Set([...this.selection.constraints]);
    const filtered = ops.filter((o) => o.op !== "unconstrain" || !this.sketch.constraints.find((c) => c.id === o.constraintId)?.entityIds.some((id) => removed.has(id)) || dropped.has(o.constraintId));
    if (!filtered.length) return;
    // Constraints on deleted entities disappear with them.
    const final = filtered.filter((o) => !(o.op === "unconstrain" && this.sketch.constraints.find((c) => c.id === o.constraintId)?.entityIds.some((id) => removed.has(id))));
    this.clearSelection();
    void this.enqueue(final, "Deleted sketch items");
  }
  toggleConstruction() {
    const ids = [...this.selection.entities];
    if (!ids.length) {
      this.construction = !this.construction;
      this.renderDynamic();
      this.host.changed();
      return;
    }
    const all = ids.every((id) => this.sketch.entities.find((e) => e.id === id)?.construction);
    void this.enqueue(ids.map((id) => ({ op: "construction", entityId: id, construction: !all })), "Toggled construction");
  }
  /** Apply a relation to the current selection. */
  relate(type: Constraint["type"]) {
    const ents = [...this.selection.entities],
      pts = this.selection.points;
    const op: SketchOp = { op: "constrain", type };
    if (pts.length === 2 && !ents.length) Object.assign(op, { entities: pts.map((p) => p.entityId), anchors: pts.map((p) => p.anchor) });
    else if (pts.length === 1 && ents.length === 1) Object.assign(op, { entities: [pts[0].entityId, ents[0]], anchors: [pts[0].anchor] });
    else if (pts.length === 2 && ents.length === 1) Object.assign(op, { entities: [pts[0].entityId, pts[1].entityId, ents[0]], anchors: pts.map((p) => p.anchor) });
    else if (type === "fixed") {
      const ids = [...new Set([...ents, ...pts.map((p) => p.entityId)])];
      void this.enqueue(ids.map((id) => ({ op: "constrain", type: "fixed", entities: [id] })), "Fixed geometry");
      return;
    } else if (type === "symmetric" && ents.length === 3) {
      const lines = ents.filter((id) => this.sketch.entities.find((e) => e.id === id)?.type === "line");
      const axis = lines.at(-1)!;
      const others = ents.filter((id) => id !== axis);
      Object.assign(op, { entities: [...others, axis], anchors: ["center", "center"] });
    } else Object.assign(op, { entities: ents });
    void this.enqueue([op], `Added ${type} relation`);
  }
  // -------------------------------------------------------------------------
  // Commit queue
  enqueue(ops: SketchOp[] | (() => Promise<SketchOp[]> | SketchOp[]), reason: string, optimistic: Entity[] = []): Promise<string[]> {
    this.optimistic.push(...optimistic);
    if (optimistic.length) this.rebuild();
    const job = this.queue.then(async () => {
      const list = typeof ops === "function" ? await ops() : ops;
      if (!list.length) return [];
      const before = new Set(this.sketch.entities.map((e) => e.id)),
        beforeConstraints = new Set(this.sketch.constraints.map((c) => c.id));
      const result = await this.host.commit(list, reason);
      if (!result) {
        this.optimistic = [];
        this.rebuild();
        return [];
      }
      // Keep queued operations consistent before React delivers the new view.
      this.sketch = result;
      this.lastAddedConstraints = result.constraints.filter((c) => !beforeConstraints.has(c.id)).map((c) => c.id);
      return result.entities.filter((e) => !before.has(e.id)).map((e) => e.id);
    });
    this.queue = job.catch(() => {
      this.optimistic = [];
      this.rebuild();
    });
    return job;
  }
  /** Ensure a fixed construction point at the sketch origin, returning a ref usable in ops. */
  private originRef(ops: SketchOp[]): string {
    const existing = this.sketch.entities.find(
      (e) => e.type === "point" && e.values.x === 0 && e.values.y === 0 && this.sketch.constraints.some((c) => c.type === "fixed" && c.entityIds[0] === e.id),
    );
    if (existing) return existing.id;
    if (!ops.some((o) => o.ref === "$origin")) ops.unshift({ op: "add", ref: "$origin", type: "point", values: { x: 0, y: 0 }, construction: true }, { op: "constrain", type: "fixed", entities: ["$origin"] });
    return "$origin";
  }
  private relateSnap(ops: SketchOp[], entity: string, anchor: string, target?: SnapTarget, resolved?: string) {
    if (!target) return;
    if (target.kind === "origin") {
      const o = this.originRef(ops);
      ops.push({ op: "constrain", type: "coincident", entities: [entity, o], anchors: [anchor, "center"] });
    } else if (target.kind === "point")
      ops.push({ op: "constrain", type: "coincident", entities: [entity, resolved ?? target.entityId], anchors: [anchor, target.anchor] });
    else ops.push({ op: "constrain", type: "pointOn", entities: [entity, target.entityId], anchors: [anchor] });
  }
  // -------------------------------------------------------------------------
  // Drawing tools
  private previewEntities(): Entity[] {
    if (["offset", "fillet", "chamfer", "pattern"].includes(this.tool)) return this.toolPreview;
    const c = this.cursor?.p;
    if (!c) return [];
    const mk = (type: Entity["type"], values: Record<string, number>): Entity => ({ id: "preview", type, values, construction: this.construction });
    const first = this.clicks[0]?.p;
    switch (this.tool) {
      case "line":
        return this.chain ? [mk("line", { x1: this.chain.p[0], y1: this.chain.p[1], x2: c[0], y2: c[1] })] : [];
      case "rectangle":
        return first ? rectangleLines(first, c).map((v) => mk("line", v)) : [];
      case "centerRectangle":
        return first ? rectangleLines(sub(mul(first, 2), c), c).map((v) => mk("line", v)) : [];
      case "circle":
        return first ? [mk("circle", { x: first[0], y: first[1], radius: Math.max(dist(first, c), 1e-6) })] : [];
      case "arc": {
        if (this.clicks.length === 1) return [mk("line", { x1: first![0], y1: first![1], x2: c[0], y2: c[1] })];
        if (this.clicks.length === 2) {
          const arc = threePointArc(first!, this.clicks[1].p, c);
          return arc ? [mk("arc", arc)] : [];
        }
        return [];
      }
      case "tangentArc": {
        if (!first) return [];
        const arc = this.tangentArcValues(c);
        return arc ? [mk("arc", arc.values)] : [];
      }
      case "polygon":
        return first ? polygonLines(first, c, this.polygonSides).map((v) => mk("line", v)) : [];
      case "slot": {
        if (this.clicks.length === 1) return [mk("line", { x1: first![0], y1: first![1], x2: c[0], y2: c[1] })];
        if (this.clicks.length === 2) {
          const w = slotGeometry(first!, this.clicks[1].p, c);
          return w ? [...w.lines.map((v) => mk("line", v)), ...w.arcs.map((v) => mk("arc", v))] : [];
        }
        return [];
      }
      case "spline":
        return first ? [mk("spline", splineValues([...this.clicks.map((k) => k.p), this.closesSpline(c) ? first : c]))] : [];
    }
    return [];
  }
  /** Whether a click at p would close the spline onto its first fit point. */
  private closesSpline(p: Vec2) {
    return this.clicks.length >= 3 && dist(p, this.clicks[0].p) < 8 * this.px();
  }
  /** Commit the fit points placed so far as one spline. */
  private finishSpline(close = false) {
    const clicks = this.clicks;
    this.clicks = [];
    this.renderDynamic();
    this.host.changed();
    if (clicks.length < 2) return;
    const points = clicks.map((k) => k.p);
    if (close) points.push(clicks[0].p);
    const values = splineValues(points),
      construction = this.construction;
    const ops: SketchOp[] = [{ op: "add", ref: "$s", type: "spline", values, construction }];
    this.relateSnap(ops, "$s", "start", clicks[0].target);
    // The closing relation joins the first and last fit points, so it survives trimming.
    if (close) ops.push({ op: "constrain", type: "coincident", entities: ["$s", "$s"], anchors: ["p0", `p${points.length - 1}`] });
    else this.relateSnap(ops, "$s", "end", clicks[clicks.length - 1].target);
    void this.enqueue(ops, "Drew spline", [{ id: "pending-spline", type: "spline", values, construction }]);
  }
  private tangentArcValues(end: Vec2) {
    const start = this.clicks[0];
    if (start?.target?.kind !== "point") return undefined;
    const e = this.shown().entities.find((x) => x.id === (start.target as any).entityId);
    if (!e || (e.type !== "line" && e.type !== "arc")) return undefined;
    const atEnd = (start.target as any).anchor === "end";
    let t: Vec2;
    if (e.type === "line") t = norm(atEnd ? sub(point(e, "end"), point(e, "start")) : sub(point(e, "start"), point(e, "end")));
    else {
      const c = point(e, "center"),
        r = sub(start.p, c);
      const g = arcGeometry(e)!;
      // Arc travels counter-clockwise from start to end in arcGeometry terms.
      const ccwTangent = perp(norm(r));
      const leavingEnd = g.ccw ? atEnd : !atEnd;
      t = leavingEnd ? ccwTangent : mul(ccwTangent, -1);
    }
    const s = start.p,
      d = sub(end, s),
      n = perp(t),
      k = dot(d, d) / (2 * dot(d, n));
    if (!Number.isFinite(k) || Math.abs(k) > 1e5) return undefined;
    const center = add(s, mul(n, k)),
      r = Math.abs(k);
    const a0 = Math.atan2(s[1] - center[1], s[0] - center[0]),
      a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
    const ccw = cross2(t, sub(center, s)) > 0;
    let sweep = ccw ? ((a1 - a0) % TAU + TAU) % TAU : -(((a0 - a1) % TAU + TAU) % TAU);
    const mid = add(center, [r * Math.cos(a0 + sweep / 2), r * Math.sin(a0 + sweep / 2)]);
    return { values: { x1: s[0], y1: s[1], xm: mid[0], ym: mid[1], x2: end[0], y2: end[1] }, entity: e, anchor: atEnd ? "end" : "start" };
  }
  private endChain() {
    this.chain = undefined;
    this.clicks = [];
    this.renderDynamic();
  }
  private toolClick(snap: Snap) {
    const p = snap.p,
      construction = this.construction;
    switch (this.tool) {
      case "spline": {
        if (this.closesSpline(p)) return this.finishSpline(true);
        // The second click of a double-click lands on the last point.
        if (this.clicks.length && dist(this.clicks[this.clicks.length - 1].p, p) < 1e-6) return;
        this.clicks.push(snap);
        // Ending on existing geometry finishes the spline there.
        if (this.clicks.length >= 2 && (snap.target?.kind === "point" || snap.target?.kind === "origin")) return this.finishSpline();
        this.renderDynamic();
        this.host.changed();
        return;
      }
      case "point": {
        const ops: SketchOp[] = [{ op: "add", ref: "$p", type: "point", values: { x: p[0], y: p[1] }, construction }];
        this.relateSnap(ops, "$p", "center", snap.target);
        void this.enqueue(ops, "Added point", [{ id: "pending", type: "point", values: { x: p[0], y: p[1] }, construction }]);
        return;
      }
      case "line": {
        if (!this.chain) {
          this.chain = { p, target: snap.target };
          return;
        }
        const start = this.chain;
        if (dist(start.p, p) < 1e-6) return;
        const previous = start.job;
        const values = { x1: start.p[0], y1: start.p[1], x2: p[0], y2: p[1] };
        const job = this.enqueue(
          async () => {
            const ops: SketchOp[] = [{ op: "add", ref: "$l", type: "line", values, construction }];
            const prevIds = previous ? await previous.catch(() => []) : [];
            const prev = prevIds.find((id) => this.sketch.entities.find((e) => e.id === id)?.type === "line");
            if (prev) ops.push({ op: "constrain", type: "coincident", entities: ["$l", prev], anchors: ["start", "end"] });
            else this.relateSnap(ops, "$l", "start", start.target);
            this.relateSnap(ops, "$l", "end", snap.target);
            if (snap.hint === "H") ops.push({ op: "constrain", type: "horizontal", entities: ["$l"] });
            if (snap.hint === "V") ops.push({ op: "constrain", type: "vertical", entities: ["$l"] });
            return ops;
          },
          "Drew line",
          [{ id: `pending-${Math.random()}`, type: "line", values, construction }],
        );
        // Closing onto an existing point ends the chain.
        if (snap.target?.kind === "point" || snap.target?.kind === "origin") {
          this.chain = undefined;
          return;
        }
        this.chain = { p, job };
        return;
      }
      case "rectangle":
      case "centerRectangle": {
        if (!this.clicks.length) {
          this.clicks = [snap];
          return;
        }
        const first = this.clicks[0];
        this.clicks = [];
        const a = this.tool === "rectangle" ? first.p : sub(mul(first.p, 2), p);
        if (Math.abs(a[0] - p[0]) < 1e-6 || Math.abs(a[1] - p[1]) < 1e-6) return;
        const lines = rectangleLines(a, p);
        const ops: SketchOp[] = lines.map((values, i) => ({ op: "add", ref: `$l${i}`, type: "line", values, construction }));
        for (let i = 0; i < 4; i++) ops.push({ op: "constrain", type: "coincident", entities: [`$l${i}`, `$l${(i + 1) % 4}`], anchors: ["end", "start"] });
        ops.push(
          { op: "constrain", type: "horizontal", entities: ["$l0"] },
          { op: "constrain", type: "horizontal", entities: ["$l2"] },
          { op: "constrain", type: "vertical", entities: ["$l1"] },
          { op: "constrain", type: "vertical", entities: ["$l3"] },
        );
        if (this.tool === "rectangle") {
          this.relateSnap(ops, "$l0", "start", first.target);
          this.relateSnap(ops, "$l1", "end", snap.target);
        } else {
          ops.push(
            { op: "add", ref: "$d", type: "line", values: { x1: a[0], y1: a[1], x2: p[0], y2: p[1] }, construction: true },
            { op: "constrain", type: "coincident", entities: ["$d", "$l0"], anchors: ["start", "start"] },
            { op: "constrain", type: "coincident", entities: ["$d", "$l1"], anchors: ["end", "end"] },
            { op: "add", ref: "$c", type: "point", values: { x: first.p[0], y: first.p[1] }, construction: true },
            { op: "constrain", type: "midpoint", entities: ["$c", "$d"], anchors: ["center"] },
          );
          this.relateSnap(ops, "$c", "center", first.target);
        }
        void this.enqueue(ops, "Drew rectangle", lines.map((values, i) => ({ id: `pending-${i}`, type: "line", values, construction })));
        return;
      }
      case "circle": {
        if (!this.clicks.length) {
          this.clicks = [snap];
          return;
        }
        const center = this.clicks[0];
        this.clicks = [];
        const radius = dist(center.p, p);
        if (radius < 1e-6) return;
        const values = { x: center.p[0], y: center.p[1], radius };
        const ops: SketchOp[] = [{ op: "add", ref: "$c", type: "circle", values, construction }];
        this.relateSnap(ops, "$c", "center", center.target);
        if (snap.target?.kind === "curve" || snap.target?.kind === "point")
          ops.push(snap.target.kind === "point" ? { op: "constrain", type: "pointOn", entities: [snap.target.entityId, "$c"], anchors: [snap.target.anchor] } : { op: "constrain", type: "tangent", entities: ["$c", snap.target.entityId] });
        void this.enqueue(ops, "Drew circle", [{ id: "pending", type: "circle", values, construction }]);
        return;
      }
      case "arc": {
        this.clicks.push(snap);
        if (this.clicks.length < 3) return;
        const [s0, s1, s2] = this.clicks;
        this.clicks = [];
        const values = threePointArc(s0.p, s1.p, s2.p);
        if (!values) return;
        const ops: SketchOp[] = [{ op: "add", ref: "$a", type: "arc", values, construction }];
        this.relateSnap(ops, "$a", "start", s0.target);
        this.relateSnap(ops, "$a", "end", s1.target);
        void this.enqueue(ops, "Drew arc", [{ id: "pending", type: "arc", values, construction }]);
        return;
      }
      case "tangentArc": {
        if (!this.clicks.length) {
          if (snap.target?.kind !== "point") return;
          const e = this.shown().entities.find((x) => x.id === (snap.target as any).entityId);
          if (!e || !["line", "arc"].includes(e.type) || !["start", "end"].includes((snap.target as any).anchor)) return;
          this.clicks = [snap];
          return;
        }
        const arc = this.tangentArcValues(p);
        this.clicks = [];
        if (!arc) return;
        const ops: SketchOp[] = [
          { op: "add", ref: "$a", type: "arc", values: arc.values, construction },
          { op: "constrain", type: "coincident", entities: ["$a", arc.entity.id], anchors: ["start", arc.anchor] },
          { op: "constrain", type: "tangent", entities: ["$a", arc.entity.id] },
        ];
        this.relateSnap(ops, "$a", "end", snap.target);
        void this.enqueue(ops, "Drew tangent arc", [{ id: "pending", type: "arc", values: arc.values, construction }]);
        return;
      }
      case "polygon": {
        if (!this.clicks.length) {
          this.clicks = [snap];
          return;
        }
        const center = this.clicks[0];
        this.clicks = [];
        const n = this.polygonSides,
          lines = polygonLines(center.p, p, n);
        if (dist(center.p, p) < 1e-6) return;
        const ops: SketchOp[] = [{ op: "add", ref: "$c", type: "circle", values: { x: center.p[0], y: center.p[1], radius: dist(center.p, p) }, construction: true }];
        lines.forEach((values, i) => ops.push({ op: "add", ref: `$l${i}`, type: "line", values, construction }));
        for (let i = 0; i < n; i++) {
          ops.push({ op: "constrain", type: "coincident", entities: [`$l${i}`, `$l${(i + 1) % n}`], anchors: ["end", "start"] });
          ops.push({ op: "constrain", type: "pointOn", entities: [`$l${i}`, "$c"], anchors: ["start"] });
          if (i) ops.push({ op: "constrain", type: "equal", entities: [`$l${i}`, "$l0"] });
        }
        this.relateSnap(ops, "$c", "center", center.target);
        void this.enqueue(ops, `Drew ${n}-sided polygon`, lines.map((values, i) => ({ id: `pending-${i}`, type: "line", values, construction })));
        return;
      }
      case "slot": {
        this.clicks.push(snap);
        if (this.clicks.length < 3) return;
        const [c0, c1, w] = this.clicks;
        this.clicks = [];
        const g = slotGeometry(c0.p, c1.p, w.p);
        if (!g) return;
        const ops: SketchOp[] = [
          { op: "add", ref: "$t", type: "line", values: g.lines[0], construction },
          { op: "add", ref: "$b", type: "line", values: g.lines[1], construction },
          { op: "add", ref: "$r", type: "arc", values: g.arcs[0], construction },
          { op: "add", ref: "$l", type: "arc", values: g.arcs[1], construction },
          { op: "constrain", type: "coincident", entities: ["$t", "$r"], anchors: ["end", "start"] },
          { op: "constrain", type: "coincident", entities: ["$r", "$b"], anchors: ["end", "start"] },
          { op: "constrain", type: "coincident", entities: ["$b", "$l"], anchors: ["end", "start"] },
          { op: "constrain", type: "coincident", entities: ["$l", "$t"], anchors: ["end", "start"] },
          { op: "constrain", type: "tangent", entities: ["$t", "$r"] },
          { op: "constrain", type: "tangent", entities: ["$b", "$r"] },
          { op: "constrain", type: "tangent", entities: ["$t", "$l"] },
          { op: "constrain", type: "tangent", entities: ["$b", "$l"] },
          { op: "constrain", type: "equal", entities: ["$r", "$l"] },
        ];
        void this.enqueue(ops, "Drew slot", [...g.lines.map((values, i) => ({ id: `pending-l${i}`, type: "line" as const, values, construction })), ...g.arcs.map((values, i) => ({ id: `pending-a${i}`, type: "arc" as const, values, construction }))]);
        return;
      }
    }
  }
  // -------------------------------------------------------------------------
  // Smart dimension
  private dimensionClick(p: Vec2, snap: Snap) {
    const hit = this.hitTest(p);
    const s = this.sketch;
    if (hit && hit.kind !== "region" && this.dimPick.length < 2) {
      const first = this.dimPick[0];
      const entityOf = (h: Hit & { kind: "point" | "entity" }) => s.entities.find((e) => e.id === (h.kind === "entity" ? h.id : h.ref.entityId))!;
      const e = entityOf(hit as any);
      const singleRound = !first && hit.kind === "entity" && (e.type === "circle" || e.type === "arc");
      if (!first || singleRound || hit.kind !== "entity" || entityOf(first).id !== e.id || first.kind === "point") {
        if (!(first && hit.kind === "entity" && first.kind === "entity" && first.id === hit.id)) {
          this.dimPick.push(hit as any);
          this.rebuild();
          return;
        }
      }
    }
    if (!this.dimPick.length) return;
    // Third click (or click on empty space) places the dimension.
    const picks = this.dimPick;
    this.dimPick = [];
    const label = snap.p;
    const op = this.dimensionOp(picks, label);
    if (!op) {
      this.rebuild();
      return;
    }
    const job = this.enqueue([op], "Added dimension");
    void job.then(() => {
      const id = this.lastAddedConstraints.at(-1),
        c = this.sketch.constraints.find((x) => x.id === id);
      if (!c || c.value === undefined) return;
      const [x, y] = this.screen(c.label ?? label);
      const rect = this.scene.renderer.domElement.getBoundingClientRect();
      this.host.editValue(c.id, measureConstraint(this.sketch, c) ?? c.value, [rect.left + x, rect.top + y]);
    });
  }
  private dimensionOp(picks: (Hit & { kind: "point" | "entity" })[], label: Vec2): SketchOp | undefined {
    const s = this.sketch;
    const entity = (h: Hit & { kind: "point" | "entity" }) => s.entities.find((e) => e.id === (h.kind === "entity" ? h.id : h.ref.entityId))!;
    const base = { op: "constrain", label };
    if (picks.length === 1) {
      const h = picks[0],
        e = entity(h);
      if (h.kind === "entity" && e.type === "circle") return { ...base, type: "diameter", entities: [e.id], value: e.values.radius * 2 };
      if (h.kind === "entity" && e.type === "arc") return { ...base, type: "radius", entities: [e.id], value: arcGeometry(e)!.radius };
      if (h.kind === "entity" && e.type === "line") {
        const a = point(e, "start"),
          b = point(e, "end");
        const mode = linearMode(a, b, label);
        if (mode === "aligned") return { ...base, type: "length", entities: [e.id], value: dist(a, b) };
        const k = mode === "x" ? 0 : 1;
        return { ...base, type: "distance", entities: [e.id, e.id], anchors: ["start", "end"], axis: mode, value: Math.abs(a[k] - b[k]) };
      }
      if (e.type === "point" || h.kind === "point") {
        // Point to origin.
        const p = h.kind === "point" ? h.p : point(e, "center");
        const mode = linearMode([0, 0], p, label);
        return {
          ...base,
          type: "dimension",
          entities: [e.id],
          dimension: e.type === "point" ? (mode === "y" ? "y" : "x") : `${mode === "y" ? "y" : "x"}${h.kind === "point" && h.ref.anchor === "end" ? "2" : "1"}`,
          value: mode === "y" ? p[1] : p[0],
        };
      }
      return undefined;
    }
    const [h1, h2] = picks,
      e1 = entity(h1),
      e2 = entity(h2);
    const p1 = h1.kind === "point" ? h1.p : point(e1, "center"),
      a1 = h1.kind === "point" ? h1.ref.anchor : "center";
    if (h1.kind === "entity" && h2.kind === "entity" && e1.type === "line" && e2.type === "line") {
      const o = lineIntersection(e1, e2);
      const u = norm(sub(point(e1, "end"), point(e1, "start"))),
        v = norm(sub(point(e2, "end"), point(e2, "start")));
      if (o && Math.abs(cross2(u, v)) > 1e-3) {
        const angle = (Math.atan2(Math.abs(cross2(u, v)), dot(u, v)) * 180) / Math.PI;
        return { ...base, type: "angle", entities: [e1.id, e2.id], value: angle };
      }
      return { ...base, type: "distance", entities: [e1.id, e2.id], value: Math.abs(lineDistance(point(e1, "center"), e2)) };
    }
    if (e2.type === "line" && h2.kind === "entity") return { ...base, type: "distance", entities: [e1.id, e2.id], anchors: [a1], value: Math.abs(lineDistance(p1, e2)) };
    if (e1.type === "line" && h1.kind === "entity") {
      const p2 = h2.kind === "point" ? h2.p : point(e2, "center");
      return { ...base, type: "distance", entities: [e2.id, e1.id], anchors: [h2.kind === "point" ? h2.ref.anchor : "center"], value: Math.abs(lineDistance(p2, e1)) };
    }
    const p2 = h2.kind === "point" ? h2.p : point(e2, "center"),
      a2 = h2.kind === "point" ? h2.ref.anchor : "center";
    const mode = linearMode(p1, p2, label);
    const value = mode === "aligned" ? dist(p1, p2) : Math.abs(p1[mode === "x" ? 0 : 1] - p2[mode === "x" ? 0 : 1]);
    if (value < 1e-9) return undefined;
    return { ...base, type: "distance", entities: [e1.id, e2.id], anchors: [a1, a2], ...(mode !== "aligned" ? { axis: mode } : {}), value };
  }
  /** Drive a dimension by an equation over document variables. */
  setExpression(constraintId: string, expression: string) {
    void this.enqueue([{ op: "value", constraintId, expression }], "Set dimension equation");
    this.host.changed();
  }
  setValue(constraintId: string, value: number) {
    // The next fillet, chamfer or offset starts from the size just typed.
    const c = this.sketch.constraints.find((x) => x.id === constraintId);
    if (c?.type === "offset") this.offsetDistance = value;
    if ((this.tool === "fillet" && c?.type === "radius") || (this.tool === "chamfer" && c?.type === "distance")) this.cornerSize = value;
    void this.enqueue([{ op: "value", constraintId, value }], "Changed dimension");
    this.host.changed();
  }
  // -------------------------------------------------------------------------
  // Offset, mirror, fillet and chamfer
  /** Connected lines and arcs through an entity, or the closed shape itself. */
  private chainOf(id: string): string[] {
    const s = this.sketch,
      start = s.entities.find((e) => e.id === id);
    if (!start) return [];
    if (start.type === "circle" || start.type === "rectangle") return [id];
    if (start.type !== "line" && start.type !== "arc") return [];
    const ends = (e: Entity) => [point(e, "start"), point(e, "end")];
    const near = (a: Vec2, b: Vec2) => dist(a, b) < 1e-6 * Math.max(1, Math.hypot(a[0], a[1]));
    const out = new Set([id]),
      queue = [start];
    while (queue.length) {
      const e = queue.pop()!;
      for (const o of s.entities) {
        if (out.has(o.id) || (o.type !== "line" && o.type !== "arc") || o.construction !== start.construction) continue;
        if (ends(o).some((p) => ends(e).some((q) => near(p, q)))) {
          out.add(o.id);
          queue.push(o);
        }
      }
    }
    return [...out];
  }
  /** Offset distance for a cursor position, in steps that suit the zoom. */
  private offsetAt(p: Vec2) {
    const s = this.sketch;
    const d = Math.min(...[...this.toolPicked].map((id) => distanceToEntity(s.entities.find((e) => e.id === id)!, p)));
    // Steps that suit the zoom, in the units on screen.
    const scale = getUnits() === "in" ? 25.4 : 1,
      step = niceStep((this.px() * 4) / scale) * scale;
    return Math.max(step, Math.round(d / step) * step);
  }
  private cornerAt(p: Vec2): [string, string] | undefined {
    const lines = this.sketch.entities.filter((e) => e.type === "line"),
      px = this.px();
    let best: { d: number; pair: [string, string] } | undefined;
    for (let i = 0; i < lines.length; i++)
      for (let j = i + 1; j < lines.length; j++)
        for (const ka of ["start", "end"])
          for (const kb of ["start", "end"]) {
            const a = point(lines[i], ka),
              b = point(lines[j], kb);
            if (dist(a, b) > 1e-6 * Math.max(1, Math.hypot(a[0], a[1]))) continue;
            const d = dist(a, p);
            if (d < 14 * px && (!best || d < best.d)) best = { d, pair: [lines[i].id, lines[j].id] };
          }
    return best?.pair;
  }
  /** A floating value next to the cursor while a tool sizes geometry. */
  private showReadout(text?: string, at?: { x: number; y: number }) {
    if (!text || !at) {
      this.readout?.remove();
      this.readout = undefined;
      return;
    }
    if (!this.readout) {
      this.readout = document.createElement("div");
      this.readout.className = "sketch-readout";
      this.scene.overlay.appendChild(this.readout);
    }
    const rect = this.scene.renderer.domElement.getBoundingClientRect();
    this.readout.textContent = text;
    this.readout.style.transform = `translate(${at.x - rect.left + 14}px, ${at.y - rect.top + 14}px)`;
  }
  private toolHover(p: Vec2, e: PointerEvent) {
    this.cursor = undefined;
    const preview = (build: (clone: Sketch, id: () => string) => string[]) => {
      try {
        const clone = structuredClone(this.sketch);
        let n = 0;
        const made = build(clone, () => `preview-${n++}`);
        this.toolPreview = clone.entities.filter((x) => made.includes(x.id));
      } catch {
        this.toolPreview = [];
      }
    };
    if (this.tool === "offset" && this.toolPicked.size) {
      const distance = this.offsetAt(p);
      preview((clone, id) => offsetEntities(clone, [...this.toolPicked], { distance, toward: p }, id));
      this.showReadout(this.toolPreview.length ? `${formatLength(distance)} ${unitLabel()}` : undefined, { x: e.clientX, y: e.clientY });
      this.renderDynamic();
      return;
    }
    if (this.tool === "fillet" || this.tool === "chamfer") {
      const pair = this.cornerAt(p);
      this.toolPreview = [];
      if (pair)
        preview((clone, id) => {
          const made = cornerEntities(clone, pair, this.tool === "fillet" ? { kind: "fillet", radius: this.cornerSize } : { kind: "chamfer", distance: this.cornerSize }, id);
          return [made, ...pair];
        });
      this.renderDynamic();
      return;
    }
    // Offset before a pick, and mirror: highlight what a click would take.
    const hit = this.hitTest(p);
    if (JSON.stringify(hit) !== JSON.stringify(this.hover)) {
      this.hover = hit?.kind === "entity" ? hit : undefined;
      this.rebuild();
    }
  }
  /** Open the value editor on the newest relation of a type, so the user can type its size. */
  private editNewest(type: Constraint["type"], at: Vec2) {
    const c = [...this.sketch.constraints].reverse().find((x) => this.lastAddedConstraints.includes(x.id) && x.type === type);
    if (!c || c.value === undefined) return;
    const [x, y] = this.screen(at);
    const rect = this.scene.renderer.domElement.getBoundingClientRect();
    this.host.editValue(c.id, measureConstraint(this.sketch, c) ?? c.value, [rect.left + x, rect.top + y]);
  }
  private offsetClick(p: Vec2) {
    if (!this.toolPicked.size) {
      const hit = this.hitTest(p);
      if (hit?.kind !== "entity") return;
      const ids = this.chainOf(hit.id);
      if (!ids.length) return;
      this.toolPicked = new Set(ids);
      this.hover = undefined;
      this.rebuild();
      this.host.changed();
      return;
    }
    const ids = [...this.toolPicked],
      distance = this.offsetAt(p);
    this.offsetDistance = distance;
    this.toolPicked = new Set();
    this.toolPreview = [];
    this.showReadout();
    this.rebuild();
    this.host.changed();
    void this.enqueue([{ op: "offset", entities: ids, distance, toward: p }], "Offset sketch geometry").then(() => this.editNewest("offset", p));
  }
  private mirrorClick(p: Vec2, additive: boolean) {
    const hit = this.hitTest(p);
    const id = hit?.kind === "entity" ? hit.id : hit?.kind === "point" ? hit.ref.entityId : undefined;
    if (!id) return;
    const e = this.sketch.entities.find((x) => x.id === id)!;
    const selected = [...this.selection.entities].filter((x) => x !== id);
    // A centerline is the mirror line; Shift makes any other line the mirror line.
    if (selected.length && e.type === "line" && (e.construction || additive)) {
      this.selection.entities.clear();
      this.rebuild();
      this.host.changed();
      void this.enqueue([{ op: "mirror", entities: selected, axis: id }], "Mirrored sketch geometry");
      return;
    }
    if (this.selection.entities.has(id)) this.selection.entities.delete(id);
    else this.selection.entities.add(id);
    this.rebuild();
    this.host.changed();
  }
  /** Sketch pattern: set while the PropertyManager waits for a center pick. */
  centerPick?: (entityId: string) => void;
  private patternClick(p: Vec2) {
    const hit = this.hitTest(p);
    const id = hit?.kind === "entity" ? hit.id : hit?.kind === "point" ? hit.ref.entityId : undefined;
    if (!id) return;
    if (this.centerPick) {
      const e = this.sketch.entities.find((x) => x.id === id)!;
      if (e.type === "point" || e.type === "circle" || e.type === "arc") {
        const pick = this.centerPick;
        this.centerPick = undefined;
        pick(id);
        this.host.changed();
      }
      return;
    }
    if (this.selection.entities.has(id)) this.selection.entities.delete(id);
    else this.selection.entities.add(id);
    this.rebuild();
    this.host.changed();
  }
  /** Show the copies a pattern would add, without saving. */
  previewPattern(o: PatternOptions | null) {
    this.toolPreview = [];
    const ids = [...this.selection.entities];
    if (o && ids.length)
      try {
        const clone = structuredClone(this.sketch);
        let n = 0;
        const made = patternEntities(clone, ids, o, () => `preview-${n++}`);
        this.toolPreview = clone.entities.filter((x) => made.includes(x.id));
      } catch {
        this.toolPreview = [];
      }
    this.renderDynamic();
  }
  /** Add the pattern to the sketch; resolves when it is saved. */
  commitPattern(o: PatternOptions) {
    const ids = [...this.selection.entities];
    if (!ids.length) return Promise.resolve([] as string[]);
    this.toolPreview = [];
    this.selection.entities.clear();
    this.rebuild();
    return this.enqueue([{ op: "pattern", entities: ids, kind: o.kind, count: o.count, spacing: o.spacing, direction: o.direction, angle: o.angle, center: o.center }], "Sketch pattern");
  }
  private cornerClick(p: Vec2) {
    const pair = this.cornerAt(p);
    if (!pair) return;
    const fillet = this.tool === "fillet";
    this.toolPreview = [];
    this.renderDynamic();
    void this.enqueue(
      [fillet ? { op: "fillet", entities: pair, radius: this.cornerSize } : { op: "chamfer", entities: pair, distance: this.cornerSize }],
      fillet ? "Sketch fillet" : "Sketch chamfer",
    ).then(() => this.editNewest(fillet ? "radius" : "distance", p));
  }
  // -------------------------------------------------------------------------
  // Trim
  private trimAt(p: Vec2) {
    const hit = this.hitTest(p);
    if (!hit || hit.kind !== "entity") return;
    const s = this.sketch,
      e = s.entities.find((x) => x.id === hit.id)!;
    const ops = trimOps(s, e, p);
    if (ops) void this.enqueue(ops, "Trimmed sketch geometry");
  }
  dispose() {
    this.disposed = true;
    this.showReadout();
    this.removeUpdater();
    for (const el of this.labels.values()) el.remove();
    this.labels.clear();
    this.clearGroup(this.staticGroup);
    this.clearGroup(this.dynamicGroup);
    this.clearGroup(this.gridGroup);
    this.scene.sketchLayer.remove(this.staticGroup, this.dynamicGroup, this.gridGroup);
    this.scene.setMouseMode("model");
    this.scene.invalidate();
  }
}

// ---------------------------------------------------------------------------
const cross2 = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
function lineDistance(p: Vec2, e: Entity) {
  const a = point(e, "start"),
    u = sub(point(e, "end"), a),
    l = Math.max(Math.hypot(...u), 1e-9);
  return cross2(u, sub(p, a)) / l;
}
function inside(p: Vec2, poly: Vec2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
/** SolidWorks-style placement: above/below gives a horizontal dimension, beside gives vertical. */
function linearMode(a: Vec2, b: Vec2, label: Vec2): "aligned" | "x" | "y" {
  const minX = Math.min(a[0], b[0]),
    maxX = Math.max(a[0], b[0]),
    minY = Math.min(a[1], b[1]),
    maxY = Math.max(a[1], b[1]);
  const dx = maxX - minX,
    dy = maxY - minY;
  if (dx < 1e-9) return "y";
  if (dy < 1e-9) return "x";
  const withinX = label[0] > minX && label[0] < maxX,
    withinY = label[1] > minY && label[1] < maxY;
  if (withinX && !withinY) return "x";
  if (withinY && !withinX) return "y";
  return "aligned";
}
function rectangleLines(a: Vec2, b: Vec2) {
  const [x0, y0] = a,
    [x1, y1] = b;
  return [
    { x1: x0, y1: y0, x2: x1, y2: y0 },
    { x1: x1, y1: y0, x2: x1, y2: y1 },
    { x1: x1, y1: y1, x2: x0, y2: y1 },
    { x1: x0, y1: y1, x2: x0, y2: y0 },
  ];
}
function polygonLines(c: Vec2, v: Vec2, n: number) {
  const r = dist(c, v),
    a0 = Math.atan2(v[1] - c[1], v[0] - c[0]);
  const pts = Array.from({ length: n }, (_, i) => add(c, [r * Math.cos(a0 + (i * TAU) / n), r * Math.sin(a0 + (i * TAU) / n)]));
  return pts.map((p, i) => ({ x1: p[0], y1: p[1], x2: pts[(i + 1) % n][0], y2: pts[(i + 1) % n][1] }));
}
function threePointArc(start: Vec2, end: Vec2, through: Vec2) {
  const g = circumcircle(start, through, end);
  if (!g) return undefined;
  const ang = (p: Vec2) => Math.atan2(p[1] - g.center[1], p[0] - g.center[0]);
  const a = ang(start),
    b = ang(end),
    t = ang(through);
  const ccw = ((t - a) % TAU + TAU) % TAU < ((b - a) % TAU + TAU) % TAU;
  const sweep = ccw ? ((b - a) % TAU + TAU) % TAU : -(((a - b) % TAU + TAU) % TAU);
  const m = add(g.center, [g.radius * Math.cos(a + sweep / 2), g.radius * Math.sin(a + sweep / 2)]);
  return { x1: start[0], y1: start[1], xm: m[0], ym: m[1], x2: end[0], y2: end[1] };
}
function slotGeometry(c0: Vec2, c1: Vec2, w: Vec2) {
  const d = sub(c1, c0);
  if (Math.hypot(...d) < 1e-6) return undefined;
  const u = norm(d),
    n = perp(u),
    r = Math.abs(dot(sub(w, c0), n));
  if (r < 1e-6) return undefined;
  const t0 = add(c0, mul(n, r)),
    t1 = add(c1, mul(n, r)),
    b1 = add(c1, mul(n, -r)),
    b0 = add(c0, mul(n, -r));
  const rm = add(c1, mul(u, r)),
    lm = add(c0, mul(u, -r));
  return {
    lines: [
      { x1: t0[0], y1: t0[1], x2: t1[0], y2: t1[1] },
      { x1: b1[0], y1: b1[1], x2: b0[0], y2: b0[1] },
    ],
    arcs: [
      { x1: t1[0], y1: t1[1], xm: rm[0], ym: rm[1], x2: b1[0], y2: b1[1] },
      { x1: b0[0], y1: b0[1], xm: lm[0], ym: lm[1], x2: t0[0], y2: t0[1] },
    ],
  };
}

export { formatMm, dimensional, trimOps };
