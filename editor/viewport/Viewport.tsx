import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { DisplayStyle, Frame, Geometry, Sketch, TopologyRef, Vec2, Vec3, View } from "../../cad/types.ts";
import { sketchRegions, selectRegions, insidePolygon } from "../../cad/sketch-geometry.ts";
import { CadScene, palette, type Orientation, type ScenePick } from "./scene.ts";
import { SketchSession, type SketchOp, type SketchTool } from "../sketch/session.ts";
import { entityPolyline } from "../sketch/model.ts";
import type { Pick } from "../panels/dialogs.tsx";

export interface ViewportHandle {
  orient(o: Orientation): void;
  normalTo(frame: Frame): void;
  lookAlong(direction: Vec3): void;
  session(): SketchSession | undefined;
}
export interface ViewportProps {
  view: View | null;
  highlight: { refs: TopologyRef[]; planes: string[] };
  ghost: Geometry | null;
  solidPreview: boolean;
  planes: { id: string; name: string; frame: Frame }[];
  sketches: { sketch: Sketch; frame: Frame }[];
  profile?: { sketchId: string; seeds: Vec2[] };
  editing?: { sketch: Sketch; frame: Frame };
  sketchTool: SketchTool;
  pickFilter: { faces: boolean; edges: boolean; planes: boolean };
  explode?: number;
  explodeOffsets?: Record<string, Vec3>;
  /** Section view: keep normal · p ≤ offset. */
  section?: { normal: Vec3; offset: number } | null;
  gizmo?: { componentId: string; bodyIds: string[]; position: Vec3 };
  fadeBodies?: boolean;
  /** Bodies left out of the view (Isolate shows only some components). */
  hiddenBodies?: Set<string>;
  /** false hides tangent edges. */
  tangentEdges?: boolean;
  /** The view's display style; parts with their own display mode keep it. */
  displayStyle?: DisplayStyle;
  onPick: (pick: Pick | null, additive: boolean) => void;
  onHover?: (pick: Pick | null) => void;
  onContextMenu: (pick: Pick | null, x: number, y: number) => void;
  onDoubleClick: (pick: Pick | null) => void;
  onCamera: (position: Vec3, target: Vec3) => void;
  onSketchCommit: (ops: SketchOp[], reason?: string) => Promise<Sketch | undefined>;
  onSketchChange: () => void;
  onEditValue: (constraintId: string, value: number, at: [number, number]) => void;
  onComponentDrag?: (componentId: string, delta: Vec3) => void;
}
const toWorld = (f: Frame, p: Vec2) =>
  new THREE.Vector3(...f.origin)
    .addScaledVector(new THREE.Vector3(...f.xDir), p[0])
    .addScaledVector(new THREE.Vector3(...f.yDir), p[1]);

export const Viewport = forwardRef<ViewportHandle, ViewportProps>(function Viewport(props, handle) {
  const host = useRef<HTMLDivElement>(null),
    sceneRef = useRef<CadScene | null>(null),
    sessionRef = useRef<SketchSession | undefined>(undefined),
    propsRef = useRef(props),
    sketchLines = useRef<{ id: string; segments: [THREE.Vector3, THREE.Vector3][]; construction: string[] }[]>([]),
    regionsRef = useRef<{ seed: Vec2; polygon: Vec2[]; holes: Vec2[][] }[]>([]),
    [failed, setFailed] = useState(false);
  propsRef.current = props;
  useImperativeHandle(handle, () => ({
    orient: (o) => sceneRef.current?.orient(o),
    normalTo: (f) => sceneRef.current?.normalTo(f),
    lookAlong: (d) => sceneRef.current?.lookAlong(d),
    session: () => sessionRef.current,
  }));
  // Scene lifetime.
  useEffect(() => {
    if (!host.current) return;
    let scene: CadScene;
    try {
      scene = new CadScene(host.current);
    } catch {
      setFailed(true);
      return;
    }
    sceneRef.current = scene;
    scene.onCameraChange = (position, target) => propsRef.current.onCamera(position, target);
    scene.onComponentDrag = (id, delta) => propsRef.current.onComponentDrag?.(id, delta);
    const canvas = scene.renderer.domElement;
    let down: { x: number; y: number; button: number } | undefined;
    const toPick = (e: PointerEvent | MouseEvent): Pick | null => {
      const p = propsRef.current;
      // Profile regions and visible sketches take priority over faces.
      if (p.profile) {
        const target = p.sketches.find((x) => x.sketch.id === p.profile!.sketchId);
        if (target) {
          const local = scene.planePoint(e.clientX, e.clientY, target.frame);
          if (local) {
            const region = regionsRef.current
              .filter((r) => insidePolygon(local, r.polygon) && !r.holes.some((h) => insidePolygon(local, h)))
              .sort((a, b) => area(a.polygon) - area(b.polygon))[0];
            if (region) return { kind: "sketch", id: target.sketch.id, seed: region.seed };
          }
        }
      }
      const sketchHit = pickSketch(e);
      if (sketchHit) return sketchHit;
      const hit = scene.pick(e.clientX, e.clientY, p.pickFilter);
      return fromScene(hit);
    };
    const pickSketch = (e: PointerEvent | MouseEvent): Pick | null => {
      const rect = canvas.getBoundingClientRect(),
        px = e.clientX - rect.left,
        py = e.clientY - rect.top;
      let best: Pick | null = null,
        bestD = 6;
      for (const s of sketchLines.current)
        for (let i = 0; i < s.segments.length; i++) {
          const [a, b] = s.segments[i];
          const [ax, ay] = scene.toScreen(a),
            [bx, by] = scene.toScreen(b);
          const dx = bx - ax,
            dy = by - ay,
            l2 = dx * dx + dy * dy;
          const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
          const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
          if (d < bestD) {
            bestD = d;
            const entity = s.construction[i];
            best = entity ? { kind: "sketchLine", sketchId: s.id, entityId: entity } : { kind: "sketch", id: s.id };
          }
        }
      return best;
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, button: e.button };
      const session = sessionRef.current;
      if (session && e.button === 0 && !scene.cubeHit(e.clientX, e.clientY)) {
        if (session.pointerDown(e)) canvas.setPointerCapture(e.pointerId);
      }
    };
    const onMove = (e: PointerEvent) => {
      scene.cubeHover(e.clientX, e.clientY);
      const session = sessionRef.current;
      if (session) {
        session.pointerMove(e);
        return;
      }
      if (e.buttons) return;
      const pick = toPick(e);
      scene.setHover(toScene(pick));
      canvas.style.cursor = pick ? "pointer" : "";
      propsRef.current.onHover?.(pick);
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = undefined;
      const moved = start ? Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4 : true;
      const session = sessionRef.current;
      if (session && e.button === 0 && !moved && !scene.cubeHit(e.clientX, e.clientY)) {
        session.pointerUp(e);
        return;
      }
      if (session && e.button === 0) {
        session.pointerUp(e);
        if (!scene.cubeHit(e.clientX, e.clientY)) return;
      }
      if (moved || !start) return;
      if (e.button === 0) {
        const dir = scene.cubeHit(e.clientX, e.clientY);
        if (dir) {
          scene.lookAlong(dir);
          return;
        }
        if (dir === null) return;
        if (session) return;
        propsRef.current.onPick(toPick(e), e.shiftKey || e.metaKey || e.ctrlKey);
      } else if (e.button === 2) {
        propsRef.current.onContextMenu(session ? null : toPick(e), e.clientX, e.clientY);
      }
    };
    const onDouble = (e: MouseEvent) => {
      const session = sessionRef.current;
      if (session) {
        session.doubleClick(e);
        return;
      }
      if (scene.cubeHit(e.clientX, e.clientY) !== undefined) {
        scene.orient("iso");
        return;
      }
      propsRef.current.onDoubleClick(toPick(e));
    };
    const onLeave = () => {
      scene.setHover(null);
      scene.cubeHover(null);
    };
    const noMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("dblclick", onDouble);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("contextmenu", noMenu);
    // Alt temporarily orbits with the left button while sketching.
    const alt = (e: KeyboardEvent) => {
      if (!sessionRef.current) return;
      scene.setMouseMode(e.altKey ? "orbit" : "sketch");
    };
    window.addEventListener("keydown", alt);
    window.addEventListener("keyup", alt);
    return () => {
      window.removeEventListener("keydown", alt);
      window.removeEventListener("keyup", alt);
      sessionRef.current?.dispose();
      sessionRef.current = undefined;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);
  // Bodies and previews.
  // Streamed bodies arrive at one pinned revision; refresh the scene as they arrive.
  const geometryKey = props.view ? `${props.view.document.id}:${props.view.document.revision}:${props.view.geometry.bodies.length}` : "none";
  useEffect(() => {
    sceneRef.current?.setGeometry(props.view, {
      ghost: props.ghost,
      solidPreview: props.solidPreview,
      fadeBodies: props.fadeBodies,
      hiddenBodies: props.hiddenBodies,
      tangentEdges: props.tangentEdges,
      displayStyle: props.displayStyle,
    });
    sceneRef.current?.setExplode(props.explode ?? 0, props.explodeOffsets);
    if (props.gizmo) sceneRef.current?.attachGizmo(props.gizmo.componentId, props.gizmo.bodyIds, props.gizmo.position);
    sceneRef.current?.setSelection(props.highlight.refs, props.highlight.planes);
  }, [geometryKey, props.ghost, props.solidPreview, props.fadeBodies, JSON.stringify(props.gizmo), [...(props.hiddenBodies ?? [])].join(), props.tangentEdges, props.displayStyle]);
  // Exploding only moves bodies.
  useEffect(() => {
    sceneRef.current?.setExplode(props.explode ?? 0, props.explodeOffsets);
  }, [props.explode, JSON.stringify(props.explodeOffsets)]);
  useEffect(() => {
    sceneRef.current?.setSection(props.section ?? null);
  }, [JSON.stringify(props.section ?? null)]);
  useEffect(() => {
    sceneRef.current?.setSelection(props.highlight.refs, props.highlight.planes);
  }, [JSON.stringify(props.highlight)]);
  // Restore the saved camera once per document.
  const restored = useRef<string | null>(null);
  useEffect(() => {
    const scene = sceneRef.current,
      v = props.view;
    if (!scene || !v || !v.geometry.bodies.length || restored.current === v.document.id) return;
    restored.current = v.document.id;
    if (v.document.viewport) scene.restoreCamera(v.document.viewport.position, v.document.viewport.target);
    requestAnimationFrame(() => scene.orient(v.document.viewport ? "fit" : "iso", false));
  }, [props.view?.document.id, props.view?.geometry.bodies.length]);
  // Datum planes.
  const planeKey = JSON.stringify(props.planes);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const span = props.view?.geometry.bodies.reduce((m, b) => Math.max(m, ...b.bounds[1].map((v, i) => Math.abs(v - b.bounds[0][i]))), 0) ?? 0;
    const size = Math.max(60, span * 1.25);
    scene.setPlanes(props.planes.map((p) => ({ ...p, size })));
  }, [planeKey, geometryKey]);
  // Visible (not edited) sketches and profile regions.
  const sketchKey = JSON.stringify([props.sketches.map((s) => [s.sketch, s.frame]), props.profile, props.editing?.sketch.id]);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const child of [...scene.sketchGroup.children]) {
      (child as any).geometry?.dispose?.();
      const m = (child as any).material;
      if (m?.isLineMaterial) scene.releaseLineMaterial(m);
      else m?.dispose?.();
      scene.sketchGroup.remove(child);
    }
    sketchLines.current = [];
    regionsRef.current = [];
    for (const { sketch, frame } of props.sketches) {
      if (sketch.id === props.editing?.sketch.id) continue;
      const segments: [THREE.Vector3, THREE.Vector3][] = [],
        construction: string[] = [];
      for (const e of sketch.entities) {
        if (e.type === "point") continue;
        const pts = entityPolyline(e, 64).map((p) => toWorld(frame, p));
        for (let i = 0; i + 1 < pts.length; i++) {
          segments.push([pts[i], pts[i + 1]]);
          construction.push(e.construction && e.type === "line" ? e.id : "");
        }
      }
      sketchLines.current.push({ id: sketch.id, segments, construction });
      if (segments.length) {
        const geo = new LineSegmentsGeometry();
        geo.setPositions(segments.flatMap(([a, b]) => [...a.toArray(), ...b.toArray()]));
        const profileSketch = props.profile?.sketchId === sketch.id;
        const line = new LineSegments2(geo, scene.lineMaterial(profileSketch ? palette.ink : palette.slate, profileSketch ? 1.6 : 1.2, { depthTest: false, transparent: true } as any));
        line.renderOrder = 8;
        scene.sketchGroup.add(line);
      }
      if (props.profile?.sketchId === sketch.id) {
        const regions = sketchRegions(sketch);
        let chosen = new Set<number>();
        try {
          const picked = selectRegions(regions, props.profile.seeds.length ? props.profile.seeds : undefined);
          chosen = new Set(picked.map((r) => regions.indexOf(r)));
        } catch {
          chosen = new Set();
        }
        regions.forEach((r, i) => {
          regionsRef.current.push({ seed: r.sample, polygon: r.outer.polygon, holes: r.holes.map((h) => h.polygon) });
          const shape = new THREE.Shape(r.outer.polygon.map((p) => new THREE.Vector2(p[0], p[1])));
          for (const h of r.holes) shape.holes.push(new THREE.Path(h.polygon.map((p) => new THREE.Vector2(p[0], p[1]))));
          const mesh = new THREE.Mesh(
            new THREE.ShapeGeometry(shape),
            new THREE.MeshBasicMaterial({
              color: chosen.has(i) ? palette.accent : palette.slate,
              transparent: true,
              opacity: chosen.has(i) ? 0.32 : 0.1,
              depthTest: false,
              side: THREE.DoubleSide,
            }),
          );
          mesh.matrixAutoUpdate = false;
          mesh.matrix.makeBasis(new THREE.Vector3(...frame.xDir), new THREE.Vector3(...frame.yDir), new THREE.Vector3(...frame.normal)).setPosition(...frame.origin);
          mesh.renderOrder = 7;
          scene.sketchGroup.add(mesh);
        });
      }
    }
    scene.invalidate();
  }, [sketchKey]);
  // Sketch editing session.
  const editingId = props.editing?.sketch.id;
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    sessionRef.current?.dispose();
    sessionRef.current = undefined;
    if (!props.editing) return;
    const session = new SketchSession(scene, props.editing.sketch, props.editing.frame, {
      commit: (ops, reason) => propsRef.current.onSketchCommit(ops, reason),
      changed: () => propsRef.current.onSketchChange(),
      editValue: (id, value, at) => propsRef.current.onEditValue(id, value, at),
    });
    session.setTool(props.sketchTool);
    sessionRef.current = session;
    scene.normalTo(props.editing.frame);
    propsRef.current.onSketchChange();
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = undefined;
    };
  }, [editingId]);
  useEffect(() => {
    if (props.editing && sessionRef.current) sessionRef.current.update(props.editing.sketch, props.editing.frame);
  }, [JSON.stringify(props.editing?.sketch), JSON.stringify(props.editing?.frame)]);
  useEffect(() => {
    if (sessionRef.current && sessionRef.current.tool !== props.sketchTool) sessionRef.current.setTool(props.sketchTool);
  }, [props.sketchTool]);
  return (
    <div className="viewport-host" ref={host} aria-label="3D CAD viewport" tabIndex={-1}>
      {failed && <p className="viewport-error">WebGL is unavailable. Enable hardware acceleration to use the 3D viewport.</p>}
    </div>
  );
});
function area(poly: Vec2[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}
function fromScene(hit: ScenePick): Pick | null {
  if (hit.kind === "face") return { kind: "face", ref: hit.ref };
  if (hit.kind === "edge") return { kind: "edge", ref: hit.ref };
  if (hit.kind === "plane") return { kind: "plane", id: hit.planeId };
  return null;
}
function toScene(p: Pick | null): ScenePick | null {
  if (!p) return null;
  if (p.kind === "face" || p.kind === "edge") return { kind: p.kind, ref: p.ref, point: p.ref.point ?? [0, 0, 0] };
  if (p.kind === "plane") return { kind: "plane", planeId: p.id, point: [0, 0, 0] };
  return null;
}
