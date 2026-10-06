import init from "replicad-opencascadejs";
import {importColoredStep} from "./step-appearance.ts";
import { STL_TRIANGLE_LIMIT, stlTriangleCount } from "./stl.ts";
import { eigenvalues, type Tensor } from "./mass.ts";
import { axesFor } from "./frame.ts";
import { defaultPrintWall, printedMass } from "./standards.ts";
import { backlashTurn, beltLength, beltLoop, belts, centerFor, flankBeziers, gearRadii, toothFlanks, type BeltType, type GearSpec } from "./drives.ts";
import { profileOutline, type MemberProfile } from "./weldments.ts";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { topologyKey } from "./topology-key.ts";
import * as r from "replicad";
import { Quaternion, Vector3 } from "three";
import { bodyPlacements, direction as placedDirection, placeGeometry, point as placedPoint, solveComponents, type SolveReport } from "./assembly.ts";
import { composeSheet, resolveViews, cameraFor, sheetDimensions, type ViewInput, type ViewCamera } from "./drawing.ts";
import { toSVG, toPDF, toDXF } from "./drawing-export.ts";
import {
  sketchRegions,
  selectRegions,
  piecePoint,
  arcGeometry,
  splineBeziers,
  point as sketchPoint,
  TAU,
  type Region,
  type Loop,
  type Piece,
} from "./sketch-geometry.ts";
import { holeDimensions } from "./standards.ts";
import { solveSketch } from "./solver.ts";
import {
  edgeNames,
  historyNames,
  namesByOrder,
  ownerOf,
  profileNames,
  toolNames,
  transferNames,
  type NamedShape,
  type Names,
} from "./naming.ts";
import type {
  Document,
  Sketch,
  Feature,
  Entity,
  Vec2,
  Vec3,
  Topology,
  TopologyRef,
  Geometry,
  RenderBody,
  Placement,
  Frame,
  PlaneRef,
  AxisRef,
  ReferencePlane,
  Component,
  ThreadRecord,
} from "./types.ts";
import { allComponents, componentOf } from "./types.ts";
let ready: Promise<void> | undefined;
export function initKernel() {
  return (ready ??= readFile(
    process.env.VIBE_CAD_ROOT
      ? `${process.env.VIBE_CAD_ROOT}/dist/kernel.wasm`
      : createRequire(import.meta.url).resolve("replicad-opencascadejs/wasm"),
  )
    .then((wasmBinary) =>
      init({
        wasmBinary,
        // Load the replaceable kernel bytes from the local plugin package.
        locateFile: (file: string) => file,
        print: () => {},
        printErr: () => {},
      }),
    )
    .then((oc) => {
      r.setOC(oc);
    }));
}

// ---------------------------------------------------------------------------
// Vector helpers
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3) => Math.hypot(...a);
const unit = (a: Vec3): Vec3 => {
  const l = length(a);
  if (l < 1e-12) throw Error("Direction must be nonzero");
  return mul(a, 1 / l);
};
const close = (a: number[], b: number[], tol = 1e-5) =>
  a.every((v, i) => Math.abs(v - b[i]) < tol);
const clean = (n: number) =>
  Math.abs(n) < 1e-7 ? 0 : Math.round(n * 100000) / 100000;

// ---------------------------------------------------------------------------
// Topology identity: geometry signatures relative to the body bounds.
function signature(shape: r.Face | r.Edge, bounds: [Vec3, Vec3]): number[] {
  const isFace = shape instanceof r.Face,
    center = isFace
      ? r.measureShapeSurfaceProperties(shape).centerOfMass
      : (shape as r.Edge).pointAt(0.5).toTuple();
  const direction = isFace
    ? shape.normalAt().toTuple()
    : (shape as r.Edge).tangentAt(0.5).toTuple();
  return [
    ...center.map((v, i) =>
      clean((v - bounds[0][i]) / Math.max(bounds[1][i] - bounds[0][i], 1e-6)),
    ),
    ...direction.map(clean),
  ];
}
function circleOf(edge: r.Edge): { center: Vec3; normal: Vec3; radius: number } | undefined {
  const a = new Vector3(...edge.pointAt(0).toTuple()),
    b = new Vector3(...edge.pointAt(0.33).toTuple()),
    c = new Vector3(...edge.pointAt(0.66).toTuple());
  const u = b.sub(a),
    v = c.sub(a),
    n = u.clone().cross(v);
  if (n.lengthSq() < 1e-12) return undefined;
  const offset = v
    .clone()
    .cross(n)
    .multiplyScalar(u.lengthSq())
    .add(n.clone().cross(u).multiplyScalar(v.lengthSq()))
    .divideScalar(2 * n.lengthSq());
  return {
    radius: offset.length(),
    center: a.add(offset).toArray() as Vec3,
    normal: n.normalize().toArray() as Vec3,
  };
}
interface TopologySet {
  metadata: Topology[];
  objects: Map<string, r.Face | r.Edge>;
  hashes: Map<number, string>;
  /** Earlier geometric identities, still accepted for references saved before names. */
  legacy: Map<string, r.Face | r.Edge>;
}
const topologyCache = new WeakMap<r.Shape3D, TopologySet>();
/** Persistent face names of a shape, set by the build as each feature completes. */
const shapeNames = new WeakMap<r.Shape3D, Names>();
function named<T extends r.Shape3D>(shape: T, names: Names): T {
  shapeNames.set(shape, names);
  return shape;
}
const namesOf = (shape: r.Shape3D): Names => shapeNames.get(shape) ?? new Map();
const input = (shape: r.Shape3D): NamedShape => ({ shape, names: namesOf(shape) });
function topologies(bodyId: string, shape: r.Shape3D): TopologySet {
  const cached = topologyCache.get(shape);
  if (cached && cached.metadata[0]?.bodyId === bodyId) return cached;
  const bounds = shape.boundingBox.bounds,
    metadata: Topology[] = [],
    objects = new Map<string, r.Face | r.Edge>(),
    legacy = new Map<string, r.Face | r.Edge>(),
    ambiguous = new Set<string>(),
    hashes = new Map<number, string>();
  const faceNames = shapeNames.get(shape),
    edgeNameMap = faceNames ? edgeNames(shape, faceNames) : undefined;
  const faceList = shape.faces,
    edgeList = shape.edges;
  for (const [kind, list] of [
    ["face", faceList],
    ["edge", edgeList],
  ] as const) {
    for (const item of list) {
      const sig = signature(item, bounds);
      const legacyId = `${bodyId}:${kind}:${topologyKey(JSON.stringify([kind, item.geomType, sig]))}`;
      const name = kind === "face" ? faceNames?.get(item.hashCode) : edgeNameMap?.get(item.hashCode);
      const id = name ? `${bodyId}:${kind}:${topologyKey(`name:${name}`)}` : legacyId;
      if (objects.has(id))
        throw Error(
          "Ambiguous topology identity; model cannot be safely selected",
        );
      objects.set(id, item);
      if (legacy.has(legacyId)) ambiguous.add(legacyId);
      else legacy.set(legacyId, item);
      hashes.set(item.hashCode, id);
      let center =
        kind === "face"
          ? r.measureShapeSurfaceProperties(item as r.Face).centerOfMass
          : (item as r.Edge).pointAt(0.5).toTuple();
      let normal =
        kind === "face" ? (item as r.Face).normalAt().toTuple() : undefined;
      let radius: number | undefined,
        axis: Topology["axis"];
      if (kind === "edge" && item.geomType === "CIRCLE") {
        const circle = circleOf(item as r.Edge);
        if (circle) {
          radius = circle.radius;
          center = circle.center;
          normal = circle.normal;
          axis = { origin: circle.center, direction: circle.normal };
        }
      }
      let concave: boolean | undefined;
      if (kind === "face" && ["CYLINDRE", "CYLINDER", "CONE"].includes(item.geomType)) {
        const rim = (item as r.Face).edges.find((e) => e.geomType === "CIRCLE");
        const circle = rim && circleOf(rim);
        if (circle) {
          axis = { origin: circle.center, direction: circle.normal };
          if (item.geomType !== "CONE") radius = circle.radius;
          // A hole's wall faces its axis: judged at a point on the face, where its normal is taken.
          const face = item as r.Face,
            p = face.pointOnSurface(0.5, 0.5).toTuple(),
            n = face.normalAt(p).toTuple(),
            off = sub(p, circle.center),
            radial = sub(off, mul(unit(circle.normal), dot(off, unit(circle.normal))));
          concave = dot(radial, n) < 0;
        }
      }
      if (kind === "edge" && item.geomType === "LINE") {
        const e = item as r.Edge;
        axis = {
          origin: e.pointAt(0).toTuple(),
          direction: unit(sub(e.pointAt(1).toTuple(), e.pointAt(0).toTuple())),
        };
      }
      const label =
        normal && item.geomType === "PLANE"
          ? ["−X", "+X", "−Y", "+Y", "−Z", "+Z"][
              Math.abs(normal[0]) > 0.999
                ? normal[0] > 0
                  ? 1
                  : 0
                : Math.abs(normal[1]) > 0.999
                  ? normal[1] > 0
                    ? 3
                    : 2
                  : normal[2] > 0
                    ? 5
                    : 4
            ] + " face"
          : kind === "face"
            ? item.geomType.toLowerCase() + " face"
            : item.geomType.toLowerCase() + " edge";
      metadata.push({
        ...(concave !== undefined ? { concave } : {}),
        id,
        bodyId,
        kind,
        geomType: item.geomType,
        signature: sig,
        center,
        normal,
        radius,
        ...(axis ? { axis } : {}),
        label,
        ...(kind === "face"
          ? { area: r.measureArea(item as r.Face) }
          : {
              length: (item as r.Edge).length,
              endpoints: [
                (item as r.Edge).startPoint.toTuple(),
                (item as r.Edge).endPoint.toTuple(),
              ] as [Vec3, Vec3],
            }),
      });
    }
  }
  // A geometric identity shared by several faces or edges no longer says which one was meant.
  for (const id of ambiguous) legacy.delete(id);
  const set = { metadata, objects, hashes, legacy };
  topologyCache.set(shape, set);
  return set;
}
const placedObjects = new WeakMap<r.Shape3D, Map<string, r.Face | r.Edge>>();
function resolve(shape: r.Shape3D, ref: TopologyRef): r.Face | r.Edge {
  const saved = placedObjects.get(shape);
  if (saved) {
    const item = saved.get(ref.id);
    if (!item) throw Error("Selection no longer resolves; reselect geometry");
    return item;
  }
  const set = topologies(ref.bodyId, shape);
  const obj = set.objects.get(ref.id) ?? set.legacy.get(ref.id);
  if (!obj)
    throw Error(
      `Selection ${ref.semantic ?? ref.id} no longer resolves after rebuild. Reselect the geometry.`,
    );
  return obj;
}

// ---------------------------------------------------------------------------
// Frames, datum planes and axes
const toFrame = (p: r.Plane): Frame => ({
  origin: p.origin.toTuple(),
  xDir: p.xDir.toTuple(),
  yDir: p.yDir.toTuple(),
  normal: p.zDir.toTuple(),
});
const toPlane = (f: Frame) => new r.Plane(f.origin, f.xDir, f.normal);
function principalFrame(name: "XY" | "XZ" | "YZ", origin: Vec3 = [0, 0, 0]): Frame {
  const p = r.makePlane(name, origin);
  try {
    return toFrame(p);
  } finally {
    p.delete();
  }
}
/** Sketch axes for an arbitrary normal: horizontal faces keep +X; others keep +Z up. */
function faceFrame(face: r.Face, mode: "origin" | "face-center"): Frame {
  if (face.geomType !== "PLANE") throw Error("Select a planar face");
  const normal = face.normalAt().toTuple(),
    center = r.measureShapeSurfaceProperties(face).centerOfMass;
  if (mode === "face-center") {
    // Legacy placement retained for documents created before origin-projected face sketches.
    const p = new r.Plane(center, Math.abs(normal[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0], normal);
    try {
      return toFrame(p);
    } finally {
      p.delete();
    }
  }
  const n = unit(normal),
    { xDir, yDir } = axesFor(n);
  return { origin: mul(n, dot(center, n)), xDir, yDir, normal: n };
}
function frameFromPoints(points: [Vec3, Vec3, Vec3]): Frame {
  const [a, b, c] = points,
    normal = unit(cross(sub(b, a), sub(c, a))),
    xDir = unit(sub(b, a));
  return { origin: a, xDir, yDir: cross(normal, xDir), normal };
}
function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const k = unit(axis),
    c = Math.cos(angle),
    s = Math.sin(angle);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}
function framePoint(f: Frame, p: Vec2): Vec3 {
  return add(add(f.origin, mul(f.xDir, p[0])), mul(f.yDir, p[1]));
}

interface ToolRecord {
  solids: r.Shape3D[];
  op: "fuse" | "cut" | "common";
  bodyId: string;
}
/** A model edge seen in a sketch plane: a line, or a circle or arc parallel to the plane. */
function projectEdge(edge: r.Edge, frame: Frame): { type: "line" | "circle" | "arc"; values: Record<string, number> } {
  const local = (p: Vec3): [number, number] => [dot(sub(p, frame.origin), frame.xDir), dot(sub(p, frame.origin), frame.yDir)];
  const scale = Math.max(1, edge.length);
  if (edge.geomType === "LINE") {
    const a = local(edge.startPoint.toTuple()),
      b = local(edge.endPoint.toTuple());
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 * scale) throw Error("This edge runs perpendicular to the sketch plane");
    return { type: "line", values: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] } };
  }
  if (edge.geomType === "CIRCLE") {
    const c = circleOf(edge);
    if (!c || Math.abs(Math.abs(dot(c.normal, frame.normal)) - 1) > 1e-6)
      throw Error("Only circles and arcs parallel to the sketch plane can be converted");
    const center = local(c.center);
    const start = edge.startPoint.toTuple(),
      end = edge.endPoint.toTuple();
    if (length(sub(start, end)) < 1e-7 * scale) return { type: "circle", values: { x: center[0], y: center[1], radius: c.radius } };
    const a = local(start),
      m = local(edge.pointAt(0.5).toTuple()),
      b = local(end);
    return { type: "arc", values: { x1: a[0], y1: a[1], xm: m[0], ym: m[1], x2: b[0], y2: b[1] } };
  }
  throw Error(`${edge.geomType.toLowerCase()} edges cannot be converted yet; convert lines, circles and arcs`);
}
class Build {
  shapes = new Map<string, r.Shape3D>();
  sketchFrames = new Map<string, Frame>();
  planeFrames = new Map<string, Frame>();
  tools = new Map<string, ToolRecord>();
  warnings: string[] = [];
  private resolvingPlanes = new Set<string>();
  constructor(readonly doc: Document) {}
  own(id: string, shape: r.Shape3D) {
    const previous = this.shapes.get(id);
    if (previous && previous !== shape) previous.delete();
    this.shapes.set(id, shape);
  }
  body(id: string, feature: Feature) {
    const b = this.shapes.get(id);
    if (!b) throw Error(`${feature.name}: target body is unavailable`);
    return b;
  }
  /** Sketched bends as built, for the flat pattern. */
  bends: { featureId: string; sketchId: string; entityId: string; angle: number; up: boolean }[] = [];
  /** Threads on cylindrical faces, for display and drawings. */
  threads: ThreadRecord[] = [];
  /** Gear and pulley bodies. */
  drives = new Map<string, NonNullable<RenderBody["drive"]>>();
  /** Edge flanges as built, for the flat pattern. */
  flanges = new Map<
    string,
    {
      bodyId: string;
      A: Vec3;
      B: Vec3;
      m: Vec3;
      up: Vec3;
      angle: number;
      R: number;
      T: number;
      straight: number;
      parent?: string;
      /** Where the flange's section plane starts (x along m, y along up, normal along A→B). */
      origin: Vec3;
      /** Wall carried past either end by a closed corner, mm. */
      extend?: { A?: number; B?: number };
    }
  >();
  /** Sketches whose converted edges were projected in this build, with their solved values. */
  sketchUpdates: Record<string, Record<string, Record<string, number>>> = {};
  sketch(id: string, feature?: Feature): Sketch {
    const s = this.doc.sketches.find((s) => s.id === id);
    if (!s) throw Error(`${feature?.name ?? "Feature"}: missing sketch`);
    if (!this.sketchUpdates[s.id] && s.entities.some((e) => e.projected)) this.reproject(s);
    return s;
  }
  /**
   * Converted edges follow the model: project each referenced edge as it is at
   * this point of the history, then solve the sketch around the new positions.
   */
  private reproject(s: Sketch) {
    this.sketchUpdates[s.id] = {};
    const frame = this.sketchFrame(s);
    for (const e of s.entities) {
      if (!e.projected) continue;
      let edge: r.Edge;
      try {
        edge = this.findEdge(e.projected);
      } catch {
        throw Error(`${s.name}: a converted edge no longer exists at this point of the history; delete or convert it again`);
      }
      const projected = projectEdge(edge, frame);
      if (projected.type !== e.type) throw Error(`${s.name}: a converted edge changed shape; convert it again`);
      e.values = projected.values;
    }
    try {
      solveSketch(s);
    } catch (error) {
      throw Error(`${s.name} no longer solves after its converted edges moved: ${(error as Error).message}`);
    }
    this.sketchUpdates[s.id] = Object.fromEntries(s.entities.map((e) => [e.id, { ...e.values }]));
  }
  /** Diagonal of everything modeled so far, for through-all extents. */
  span() {
    let lo: Vec3 = [Infinity, Infinity, Infinity],
      hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const s of this.shapes.values()) {
      const [a, b] = s.boundingBox.bounds;
      lo = lo.map((v, i) => Math.min(v, a[i])) as Vec3;
      hi = hi.map((v, i) => Math.max(v, b[i])) as Vec3;
    }
    return Number.isFinite(lo[0]) ? length(sub(hi, lo)) + 10 : 1000;
  }
  findFace(ref: TopologyRef): r.Face {
    const body = this.shapes.get(ref.bodyId);
    if (!body) throw Error("Referenced body is unavailable");
    const face = resolve(body, ref);
    if (!(face instanceof r.Face)) throw Error("Reference must be a face");
    return face;
  }
  findEdge(ref: TopologyRef): r.Edge {
    const body = this.shapes.get(ref.bodyId);
    if (!body) throw Error("Referenced body is unavailable");
    const edge = resolve(body, ref);
    if (!(edge instanceof r.Edge)) throw Error("Reference must be an edge");
    return edge;
  }
  planeRef(ref: PlaneRef): Frame {
    if (ref.kind === "principal") {
      const f = principalFrame(ref.plane);
      return { ...f, origin: mul(f.normal, ref.offset ?? 0) };
    }
    if (ref.kind === "reference") return this.referencePlane(ref.planeId);
    return faceFrame(this.findFace(ref.ref), "origin");
  }
  referencePlane(id: string): Frame {
    const cached = this.planeFrames.get(id);
    if (cached) return cached;
    const p = this.doc.referencePlanes?.find((p) => p.id === id);
    if (!p) throw Error("Reference plane is missing");
    if (this.resolvingPlanes.has(id)) throw Error("Reference planes depend on each other cyclically");
    this.resolvingPlanes.add(id);
    try {
      const frame = this.evaluatePlane(p);
      this.planeFrames.set(id, frame);
      return frame;
    } finally {
      this.resolvingPlanes.delete(id);
    }
  }
  private evaluatePlane(p: ReferencePlane): Frame {
    const d = p.definition;
    if (!d) return principalFrame(p.plane, p.origin);
    switch (d.kind) {
      case "offset": {
        const base = this.planeRef(d.base),
          normal = d.flip ? mul(base.normal, -1) : base.normal;
        return {
          origin: add(base.origin, mul(base.normal, d.distance)),
          xDir: base.xDir,
          yDir: d.flip ? mul(base.yDir, -1) : base.yDir,
          normal,
        };
      }
      case "angle": {
        const base = this.planeRef(d.base),
          axis = this.axis(d.axis),
          angle = (d.angle * Math.PI) / 180;
        const turn = (v: Vec3) => rotateAbout(v, axis.direction, angle);
        // Project the base origin onto the axis so the plane contains the axis.
        const along = dot(sub(base.origin, axis.origin), axis.direction),
          origin = add(axis.origin, mul(axis.direction, along));
        return {
          origin,
          xDir: unit(turn(base.xDir)),
          yDir: unit(turn(base.yDir)),
          normal: unit(turn(base.normal)),
        };
      }
      case "midplane": {
        const a = this.planeRef(d.a),
          b = this.planeRef(d.b);
        if (Math.abs(Math.abs(dot(a.normal, b.normal)) - 1) > 1e-6)
          throw Error("Mid-plane references must be parallel");
        const offset = dot(sub(b.origin, a.origin), a.normal);
        return { ...a, origin: add(a.origin, mul(a.normal, offset / 2)) };
      }
      case "three-point":
        return frameFromPoints(d.points);
      case "normal-to-edge": {
        const edge = this.findEdge(d.edge),
          origin = edge.pointAt(d.position).toTuple(),
          normal = unit(edge.tangentAt(d.position).toTuple()),
          { xDir, yDir } = axesFor(normal);
        return { origin, xDir, yDir, normal };
      }
    }
  }
  sketchFrame(s: Sketch): Frame {
    const cached = this.sketchFrames.get(s.id);
    if (cached) return cached;
    let frame: Frame;
    if (s.referencePlaneId) frame = this.referencePlane(s.referencePlaneId);
    else if (s.support) {
      const face = this.findFace(s.support);
      if (face.geomType !== "PLANE") throw Error("Sketches require a planar support face");
      frame = faceFrame(face, s.frameMode ?? "face-center");
    } else frame = principalFrame(s.plane, s.origin);
    this.sketchFrames.set(s.id, frame);
    return frame;
  }
  axis(ref: AxisRef): { origin: Vec3; direction: Vec3 } {
    switch (ref.kind) {
      case "principal":
        return {
          origin: [0, 0, 0],
          direction: ref.axis === "X" ? [1, 0, 0] : ref.axis === "Y" ? [0, 1, 0] : [0, 0, 1],
        };
      case "custom":
        return { origin: ref.origin, direction: unit(ref.direction) };
      case "sketch": {
        const s = this.sketch(ref.sketchId),
          e = s.entities.find((e) => e.id === ref.entityId);
        if (!e || e.type !== "line") throw Error("Axis must be a sketch line");
        const f = this.sketchFrame(s),
          a = framePoint(f, [e.values.x1, e.values.y1]),
          b = framePoint(f, [e.values.x2, e.values.y2]);
        return { origin: a, direction: unit(sub(b, a)) };
      }
      case "edge": {
        const edge = this.findEdge(ref.ref);
        if (edge.geomType === "LINE") {
          const a = edge.startPoint.toTuple(),
            b = edge.endPoint.toTuple();
          return { origin: a, direction: unit(sub(b, a)) };
        }
        const c = circleOf(edge);
        if (!c) throw Error("Axis edge must be straight or circular");
        return { origin: c.center, direction: c.normal };
      }
      case "face": {
        const face = this.findFace(ref.ref);
        const rim = face.edges.find((e) => e.geomType === "CIRCLE"),
          c = rim && circleOf(rim);
        if (!c) throw Error("Axis face must be cylindrical or conical");
        return { origin: c.center, direction: c.normal };
      }
    }
  }
  dispose() {
    for (const t of this.tools.values()) t.solids.forEach((s) => s.delete());
    this.tools.clear();
  }
}

// ---------------------------------------------------------------------------
// Sketch profiles
function loopDrawing(loop: Loop): r.Drawing {
  const pieces: Piece[] = [];
  for (const p of loop.pieces) {
    // A closed arc cannot be drawn through three points; split it in half.
    if (p.kind === "arc" && Math.abs(Math.abs(p.sweep) - TAU) < 1e-9) {
      if (loop.pieces.length === 1)
        return r.drawCircle(p.radius).translate(p.center[0], p.center[1]);
      const mid = piecePoint(p, 0.5);
      pieces.push(
        { ...p, sweep: p.sweep / 2, b: mid },
        { ...p, start: p.start + p.sweep / 2, sweep: p.sweep / 2, a: mid },
      );
    } else pieces.push(p);
  }
  const start = pieces[0].a;
  let pen = r.draw(start);
  pieces.forEach((p, i) => {
    // The final piece ends exactly on the first point so the wire closes.
    const last = i === pieces.length - 1,
      end = last ? start : p.b;
    if (p.kind === "line") {
      if (!last) pen = pen.lineTo(end);
    } else if (p.kind === "bezier") pen = pen.cubicBezierCurveTo(end, p.p[1], p.p[2]);
    else pen = pen.threePointsArcTo(end, piecePoint(p, 0.5));
  });
  return pen.close();
}
function regionDrawing(region: Region): r.Drawing {
  let drawing = loopDrawing(region.outer);
  for (const hole of region.holes) drawing = drawing.cut(loopDrawing(hole));
  return drawing;
}
function profileRegions(s: Sketch, seeds?: Vec2[]): Region[] {
  const regions = selectRegions(sketchRegions(s), seeds);
  if (!regions.length)
    throw Error(
      `Open sketch profile in ${s.name}. Connect line and arc endpoints into a closed outline.`,
    );
  return regions;
}
function fuseAll(solids: r.Shape3D[]): r.Shape3D {
  let result = solids[0];
  for (const s of solids.slice(1)) {
    const next = result.fuse(s);
    result.delete();
    s.delete();
    result = next;
  }
  return result;
}
function singleProfile(s: Sketch, plane: r.Plane): r.Sketch {
  const regions = profileRegions(s);
  if (regions.length !== 1 || regions[0].holes.length)
    throw Error(`${s.name}: select one closed profile without nested or disjoint contours`);
  const mapped = loopDrawing(regions[0].outer).sketchOnPlane(plane);
  if (!(mapped instanceof r.Sketch))
    throw Error(`${s.name}: profile must be one closed wire`);
  return mapped;
}
function pathDrawing(s: Sketch, reverse: boolean): r.Drawing {
  const es = s.entities.filter((e) => !e.construction && e.type !== "point");
  if (!es.length) throw Error(`${s.name}: sweep path is empty`);
  if (es.length === 1 && ["circle", "rectangle"].includes(es[0].type)) {
    if (reverse) throw Error("Reverse path is supported for line and arc paths");
    return loopDrawing(profileRegions(s)[0].outer);
  }
  if (es.some((e) => !["line", "arc", "spline"].includes(e.type)))
    throw Error("Sweep path must be one connected line/arc/spline chain, or one closed circle/rectangle");
  const endsOf = (e: Entity): [[number, number], [number, number]] =>
    e.type === "spline" ? [sketchPoint(e, "start"), sketchPoint(e, "end")] : [[e.values.x1, e.values.y1], [e.values.x2, e.values.y2]];
  const endpoints = es.flatMap((e) => endsOf(e));
  const nodes = endpoints.filter((point, i) => !endpoints.slice(0, i).some((p) => close(p, point)));
  const degree = (p: number[]) => endpoints.filter((x) => close(x, p)).length;
  if (nodes.some((p) => degree(p) > 2)) throw Error("Sweep path branches; select a single connected chain");
  const ends = nodes.filter((p) => degree(p) === 1);
  if (ends.length !== 0 && ends.length !== 2) throw Error("Sweep path is disconnected");
  const start: [number, number] = ends.length ? ends[reverse ? 1 : 0] : endpoints[reverse ? 1 : 0];
  let cursor = start,
    pen = r.draw(start);
  const pending = es.map((e) => structuredClone(e));
  while (pending.length) {
    let index = pending.findIndex((e) => close(endsOf(e)[0], cursor));
    let backwards = false;
    if (index < 0) {
      index = pending.findIndex((e) => close(endsOf(e)[1], cursor));
      backwards = true;
    }
    if (index < 0) throw Error("Sweep path is disconnected");
    const e = pending.splice(index, 1)[0],
      v = e.values;
    const end: [number, number] = backwards ? endsOf(e)[0] : endsOf(e)[1];
    if (e.type === "spline") {
      const spans = splineBeziers(e);
      if (backwards) for (const b of spans.reverse()) pen = pen.cubicBezierCurveTo(b[0], b[2], b[1]);
      else for (const b of spans) pen = pen.cubicBezierCurveTo(b[3], b[1], b[2]);
    } else pen = e.type === "arc" ? pen.threePointsArcTo(end, [v.xm, v.ym]) : pen.lineTo(end);
    cursor = end;
  }
  return close(cursor, start) ? pen.close() : pen.done();
}

// ---------------------------------------------------------------------------
// Primitive tools
/** Solid of revolution of a trapezoid: a cone frustum from r1 at `at` to r2 after `height` along `dir`. */
function frustum(at: Vec3, dir: Vec3, r1: number, r2: number, height: number): r.Shape3D {
  const d = unit(dir),
    perp = axesFor(d).xDir;
  const plane = new r.Plane(at, perp, cross(perp, d));
  try {
    const pen = r.draw([0, 0]).lineTo([r1, 0]).lineTo([r2, height]).lineTo([0, height]).close();
    return (pen.sketchOnPlane(plane) as r.Sketch).revolve(d, { origin: at }).asShape3D();
  } finally {
    plane.delete();
  }
}
/** Boolean of two named solids; faces keep their names through the kernel's history. */
function booleanOp(a: r.Shape3D, b: r.Shape3D, op: "fuse" | "cut" | "common", featureId: string): r.Shape3D {
  const oc = r.getOC() as any;
  const Builder = op === "fuse" ? oc.BRepAlgoAPI_Fuse : op === "cut" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common;
  const builder = new Builder(a.wrapped, b.wrapped);
  try {
    builder.Build();
    builder.SimplifyResult(true, true, 1e-3);
    const result = r.cast(builder.Shape());
    if (!r.isShape3D(result)) throw Error("the operation did not produce a solid");
    return named(result, historyNames(builder, result, [input(a), input(b)], featureId));
  } finally {
    builder.delete();
  }
}
function applyOp(
  body: r.Shape3D | undefined,
  solid: r.Shape3D,
  op: "new" | "join" | "cut" | "intersect" | "fuse" | "common",
  featureId: string,
) {
  if (op === "new") return solid;
  if (!body) throw Error("Target body is unavailable");
  return booleanOp(body, solid, op === "cut" ? "cut" : op === "intersect" || op === "common" ? "common" : "fuse", featureId);
}
/** A moved or mirrored copy named after its original. */
function copyOf(source: r.Shape3D, copy: r.Shape3D, prefix: string): r.Shape3D {
  return named(copy, namesByOrder(copy, source, namesOf(source), prefix));
}

// ---------------------------------------------------------------------------
// Feature tools
function extrudeTool(ctx: Build, f: Feature): r.Shape3D {
  const p = f.params,
    s = ctx.sketch(p.sketchId, f),
    frame = ctx.sketchFrame(s),
    regions = profileRegions(s, p.regions);
  const sign = (p.reverse ? -1 : 1) * ((p.distance ?? 1) < 0 ? -1 : 1),
    dir = mul(frame.normal, sign),
    distance = Math.abs(p.distance ?? 10),
    end = p.endType ?? "blind";
  let forward = distance,
    backward = 0;
  let trim: { origin: Vec3; normal: Vec3 } | undefined;
  if (end === "symmetric") forward = backward = distance / 2;
  else if (end === "two-sided") backward = Math.abs(p.distance2 ?? distance);
  else if (end === "through-all") forward = ctx.span() * 2;
  else if (end === "through-all-both") forward = backward = ctx.span() * 2;
  else if (end === "up-to-face") {
    if (!p.upTo) throw Error(`${f.name}: select the face to extrude up to`);
    const face = ctx.findFace(p.upTo);
    if (face.geomType !== "PLANE") throw Error(`${f.name}: up-to face must be planar`);
    const n = unit(face.normalAt().toTuple()),
      c = r.measureShapeSurfaceProperties(face).centerOfMass,
      along = dot(dir, n);
    if (Math.abs(Math.abs(along) - 1) < 1e-9) {
      forward = dot(sub(c, frame.origin), n) / along;
      if (forward <= 1e-6) throw Error(`${f.name}: the face is behind the sketch; reverse the direction`);
    } else {
      forward = ctx.span() * 2;
      trim = { origin: c, normal: n };
    }
  }
  const plane = toPlane({ ...frame, origin: add(frame.origin, mul(dir, -backward)) });
  let solid: r.Shape3D;
  try {
    solid = fuseAll(
      regions.map((region) =>
        (regionDrawing(region).sketchOnPlane(plane) as r.Sketch).extrude(
          forward + backward,
          { extrusionDirection: dir },
        ),
      ),
    );
  } finally {
    plane.delete();
  }
  if (trim) {
    const side = dot(sub(frame.origin, trim.origin), trim.normal) >= 0 ? "positive" : "negative";
    const cutter = new r.Plane(trim.origin, axesFor(trim.normal).xDir, trim.normal);
    try {
      const kept = solid.cutPlane(cutter, 0, side);
      solid.delete();
      if (!kept) throw Error(`${f.name}: the profile does not reach the selected face`);
      solid = kept;
    } finally {
      cutter.delete();
    }
  }
  if (p.draftAngle) {
    const lateral = solid.faces.filter(
      (face) => face.geomType !== "PLANE" || Math.abs(dot(unit(face.normalAt().toTuple()), dir)) < 0.999,
    );
    const neutral = new r.Plane(add(frame.origin, mul(dir, -backward)), frame.xDir, dir);
    try {
      const angle = (p.draftOutward ? -1 : 1) * p.draftAngle;
      const drafted = solid.draft(angle, (finder) => finder.inList(lateral), neutral);
      solid.delete();
      solid = drafted;
    } catch (error) {
      throw Error(`${f.name}: cannot draft these faces at ${p.draftAngle}°. Reduce the angle.`);
    } finally {
      neutral.delete();
    }
  }
  return named(solid, profileNames(solid, f.id, s, { ...frame, origin: add(frame.origin, mul(dir, -backward)) }));
}
function revolveTool(ctx: Build, f: Feature): r.Shape3D {
  const p = f.params,
    s = ctx.sketch(p.sketchId, f),
    frame = ctx.sketchFrame(s),
    regions = profileRegions(s, p.regions);
  const axis = p.axisRef
    ? ctx.axis(p.axisRef)
    : { origin: p.axisOrigin ?? s.origin, direction: unit(p.axis ?? [0, 1, 0]) };
  const angle = Math.min(360, Math.abs(p.angle ?? 360));
  const plane = toPlane(frame);
  let solid: r.Shape3D;
  try {
    solid = fuseAll(
      regions.map((region) =>
        (regionDrawing(region).sketchOnPlane(plane) as r.Sketch)
          .revolve(axis.direction, { origin: axis.origin, angle })
          .asShape3D(),
      ),
    );
  } finally {
    plane.delete();
  }
  const turn = p.symmetric ? -angle / 2 : p.reverse ? -angle : 0;
  if (turn && angle < 360) {
    const rotated = solid.rotate(turn, axis.origin, axis.direction);
    solid = rotated;
  }
  const undo = turn && angle < 360 ? (-turn * Math.PI) / 180 : 0;
  const back = (q: Vec3) => add(axis.origin, rotateAbout(sub(q, axis.origin), unit(axis.direction), undo));
  return named(solid, profileNames(solid, f.id, s, frame, back));
}
function loftTool(ctx: Build, f: Feature): r.Shape3D {
  const p = f.params,
    planes: r.Plane[] = [],
    sections: r.Sketch[] = [];
  let builder: any;
  try {
    for (const id of p.sketchIds) {
      const s = ctx.sketch(id, f),
        plane = toPlane(ctx.sketchFrame(s));
      planes.push(plane);
      sections.push(singleProfile(s, plane));
    }
    builder = new (r.getOC().BRepOffsetAPI_ThruSections)(true, !!p.ruled, 1e-6);
    for (const section of sections) builder.AddWire(section.wire.wrapped);
    builder.Build();
    const solid = r.cast(builder.Shape()).asShape3D();
    const first = ctx.sketch(p.sketchIds[0], f);
    return named(solid, profileNames(solid, f.id, first, ctx.sketchFrame(first)));
  } finally {
    builder?.delete();
    sections.forEach((s) => s.delete());
    planes.forEach((p) => p.delete());
  }
}
function sweepTool(ctx: Build, f: Feature): r.Shape3D {
  const p = f.params,
    profileDoc = ctx.sketch(p.profileSketchId, f),
    pathDoc = ctx.sketch(p.pathSketchId, f);
  const profilePlane = toPlane(ctx.sketchFrame(profileDoc)),
    pathPlane = toPlane(ctx.sketchFrame(pathDoc));
  let profile: r.Sketch | undefined,
    path: r.Sketch | undefined,
    face: r.Face | undefined,
    vertex: r.Vertex | undefined,
    builder: any;
  try {
    profile = singleProfile(profileDoc, profilePlane);
    const mapped = pathDrawing(pathDoc, !!p.reversePath).sketchOnPlane(pathPlane);
    if (!(mapped instanceof r.Sketch)) throw Error("Sweep path must be one wire");
    path = mapped;
    const tangent = path.wire.tangentAt(1e-9),
      start = path.wire.startPoint;
    try {
      const direction = tangent.toTuple(),
        normal = profilePlane.zDir.toTuple();
      if (Math.abs(dot(direction, normal)) / length(direction) < 0.999999)
        throw Error("Sweep profile plane must be perpendicular to the path at its start");
      vertex = r.makeVertex(start);
    } finally {
      tangent.delete();
      start.delete();
    }
    face = profile.face();
    if (r.measureDistanceBetween(face, vertex!) > 1e-5)
      throw Error("Sweep path must start on the profile; use Reverse path or move the sketch plane");
    const oc = r.getOC();
    builder = new oc.BRepOffsetAPI_MakePipeShell(path.wire.wrapped);
    const modes: Record<string, any> = {
      right: oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner,
      round: oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner,
      transformed: oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed,
    };
    builder.SetTransitionMode(modes[p.transition ?? "transformed"]);
    if (p.frenet) builder.SetMode(true);
    builder.Add(profile.wire.wrapped, false, p.transition === "round");
    builder.Build();
    if (!builder.MakeSolid()) throw Error("Sweep could not close a solid");
    const solid = r.cast(builder.Shape()).asShape3D();
    return named(solid, profileNames(solid, f.id, profileDoc, ctx.sketchFrame(profileDoc)));
  } finally {
    builder?.delete();
    face?.delete();
    vertex?.delete();
    profile?.delete();
    path?.delete();
    profilePlane.delete();
    pathPlane.delete();
  }
}
/** The open chain of profile lines and arcs of a rib sketch, as a polyline. */
function openChain(s: Sketch): Vec2[] {
  const items = s.entities.filter((e) => !e.construction && (e.type === "line" || e.type === "arc"));
  if (!items.length) throw Error("draw the rib profile as an open line or arc chain");
  const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 * Math.max(1, Math.hypot(...a));
  const ends = (e: Entity): [Vec2, Vec2] => [sketchPoint(e, "start"), sketchPoint(e, "end")];
  const degree = (p: Vec2, self: Entity) => items.filter((o) => o !== self && ends(o).some((q) => near(p, q))).length;
  const first = items.find((e) => degree(ends(e)[0], e) === 0 || degree(ends(e)[1], e) === 0);
  if (!first) throw Error("the rib profile must be open, not a closed loop");
  const samples = (e: Entity, reversed: boolean): Vec2[] => {
    let pts: Vec2[];
    if (e.type === "line") pts = ends(e);
    else {
      const g = arcGeometry(e)!;
      pts = Array.from({ length: 17 }, (_, i) => {
        const t = g.start + (g.sweep * i) / 16;
        return [g.center[0] + g.radius * Math.cos(t), g.center[1] + g.radius * Math.sin(t)] as Vec2;
      });
      if (!near(pts[0], ends(e)[0])) pts.reverse();
    }
    return reversed ? pts.reverse() : pts;
  };
  const used = new Set([first]);
  const startFree = degree(ends(first)[0], first) === 0;
  let chain = samples(first, !startFree);
  for (;;) {
    const tail = chain.at(-1)!;
    const next = items.find((e) => !used.has(e) && ends(e).some((q) => near(q, tail)));
    if (!next) break;
    used.add(next);
    chain = [...chain, ...samples(next, !near(ends(next)[0], tail)).slice(1)];
  }
  if (used.size !== items.length) throw Error("the rib sketch must hold one connected profile");
  return chain;
}
/**
 * Rib parallel to its sketch plane: the region between the open profile and
 * the part (the profile extended at both ends until it meets the part),
 * thickened symmetrically about the sketch plane.
 */
function ribTool(ctx: Build, f: Feature, body: r.Shape3D): r.Shape3D {
  const p = f.params,
    s = ctx.sketch(p.sketchId, f),
    frame = ctx.sketchFrame(s),
    chain = openChain(s),
    span = ctx.span() * 2;
  if (!(p.thickness > 0)) throw Error("give the rib a thickness");
  const unit2 = (v: Vec2): Vec2 => {
    const l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l];
  };
  const at = (q: Vec2) => framePoint(frame, q);
  const n = chain.length;
  const t0 = unit2([chain[0][0] - chain[1][0], chain[0][1] - chain[1][1]]),
    t1 = unit2([chain[n - 1][0] - chain[n - 2][0], chain[n - 1][1] - chain[n - 2][1]]);
  const extended: Vec2[] = [[chain[0][0] + t0[0] * span, chain[0][1] + t0[1] * span], ...chain, [chain[n - 1][0] + t1[0] * span, chain[n - 1][1] + t1[1] * span]];
  const chord = unit2([chain[n - 1][0] - chain[0][0], chain[n - 1][1] - chain[0][1]]);
  const left: Vec2 = [-chord[1], chord[0]];
  // The part's cross-section in the sketch plane.
  const [lo, hi] = body.boundingBox.bounds;
  const center3 = mul(add(lo, hi), 0.5),
    c: Vec2 = [dot(sub(center3, frame.origin), frame.xDir), dot(sub(center3, frame.origin), frame.yDir)];
  const square = r.makePolygon([at([c[0] - span, c[1] - span]), at([c[0] + span, c[1] - span]), at([c[0] + span, c[1] + span]), at([c[0] - span, c[1] + span])]);
  const oc = r.getOC() as any;
  const sectionOp = new oc.BRepAlgoAPI_Common(body.wrapped, square.wrapped);
  sectionOp.Build();
  const section = r.cast(sectionOp.Shape());
  sectionOp.delete();
  const mid = chain[Math.floor((n - 1) / 2)],
    after = chain[Math.floor((n - 1) / 2) + 1] ?? chain[n - 1],
    probeBase: Vec2 = [(mid[0] + after[0]) / 2, (mid[1] + after[1]) / 2];
  // The bounded piece next to the profile on one side, if the part closes it.
  const pieceOn = (side: number): r.Face | undefined => {
    const far = extended.map((q) => [q[0] + left[0] * side * span, q[1] + left[1] * side * span] as Vec2).reverse();
    const region = r.makePolygon([...extended, ...far].map(at));
    const cut = new oc.BRepAlgoAPI_Cut(region.wrapped, section.wrapped);
    cut.Build();
    const pieces = r.cast(cut.Shape());
    cut.delete();
    const eps = Math.max(1e-3, p.thickness * 1e-3);
    const probe = r.makeVertex(at([probeBase[0] + left[0] * side * eps, probeBase[1] + left[1] * side * eps]));
    const farEdge = r.makeVertex(at([probeBase[0] + left[0] * side * span, probeBase[1] + left[1] * side * span]));
    const faces = pieces instanceof r.Face ? [pieces] : ((pieces as any).faces as r.Face[]);
    const piece = faces.find((face) => r.measureDistanceBetween(face, probe) < 1e-6);
    // A piece that runs out to the far boundary never met the part.
    const bounded = piece && r.measureDistanceBetween(piece, farEdge) > span * 0.1 && r.measureArea(piece) < span * span * 0.25;
    return bounded ? piece : undefined;
  };
  const sides = p.flip === true ? [-1] : p.flip === false ? [1] : [1, -1];
  let piece: r.Face | undefined;
  for (const side of sides) if ((piece = pieceOn(side))) break;
  if (!piece) throw Error("the rib does not reach the part; flip its side or extend the profile toward the part");
  const normal = frame.normal;
  const slab = r.basicFaceExtrusion(piece.clone().translate(mul(normal, -p.thickness / 2)) as r.Face, new r.Vector(mul(normal, p.thickness)));
  return named(slab, profileNames(slab, f.id, s, { ...frame, origin: add(frame.origin, mul(normal, -p.thickness / 2)) }));
}
/** Sheet metal settings of a body, from its base flange. */
function sheetOf(ctx: Build, bodyId: string, name: string) {
  const base = ctx.doc.features.find((x) => x.type === "sheet" && x.bodyId === bodyId && !x.suppressed);
  if (!base) throw Error(`${name}: flanges go on a sheet metal body; start it with a base flange`);
  const frame = ctx.sketchFrame(ctx.sketch(base.params.sketchId));
  return {
    thickness: base.params.thickness as number,
    radius: base.params.bendRadius as number,
    k: (base.params.kFactor as number) ?? 0.44,
    normal: frame.normal,
    frame,
    /** The sheet spans these heights along the normal from the base sketch plane. */
    span: (base.params.reverse ? [-base.params.thickness, 0] : [0, base.params.thickness]) as [number, number],
  };
}
/**
 * Geometry of an edge flange in its own cross-section: u runs outward from the
 * sheet's side face, v up from the far sheet face, the selected edge at
 * (0, T). The bend turns by `angle` about (0, T + R) and the wall continues
 * tangent; `length` is measured from the outer virtual sharp.
 */
export function flangeSection(T: number, R: number, angleDeg: number, length: number) {
  const th = (angleDeg * Math.PI) / 180;
  const C: Vec2 = [0, T + R];
  const dir = (t: number): Vec2 => [Math.sin(t), -Math.cos(t)];
  const at = (r0: number, t: number): Vec2 => [C[0] + r0 * dir(t)[0], C[1] + r0 * dir(t)[1]];
  const outerEnd = at(R + T, th),
    innerEnd = at(R, th),
    w: Vec2 = [Math.cos(th), Math.sin(th)];
  // Outer virtual sharp: the far sheet face (v = 0) meets the wall's outer line.
  const sharp: Vec2 = Math.abs(w[1]) < 1e-9 ? outerEnd : [outerEnd[0] - (outerEnd[1] / w[1]) * w[0], 0];
  const straight = length - Math.hypot(outerEnd[0] - sharp[0], outerEnd[1] - sharp[1]);
  return { th, C, dir, at, outerEnd, innerEnd, w, straight };
}
function flangeTool(ctx: Build, f: Feature, body: r.Shape3D): r.Shape3D {
  const p = f.params,
    sheet = sheetOf(ctx, f.bodyId, f.name),
    T = sheet.thickness,
    R = p.bendRadius ?? sheet.radius,
    angle = p.angle ?? 90;
  if (!(angle > 0 && angle <= 180)) throw Error("flange angle must be between 0 and 180 degrees");
  const edge = resolve(body, p.edge) as r.Edge;
  if (!(edge instanceof r.Edge) || edge.geomType !== "LINE") throw Error("flanges go on straight edges");
  let A = edge.startPoint.toTuple(),
    B = edge.endPoint.toTuple();
  const faces = body.faces.filter((face) => face.geomType === "PLANE" && face.edges.some((e) => e.isSame(edge)));
  // Of the two faces at the edge, the side face is the sheet's thickness (T
  // across, square to the other): on the base outline or at the end of a flange.
  const span = length(sub(B, A));
  const square = (a: r.Face, b: r.Face) => Math.abs(dot(unit(a.normalAt().toTuple()), unit(b.normalAt().toTuple()))) < 1e-6;
  // On the base outline the sheet face lies flat like the base flange; at a
  // flange's end, the side face is the one exactly T across.
  // Merged faces (a base end that took flange caps) are no longer T across, so
  // the base-plane rule decides when the thickness test cannot.
  const across = (face: r.Face) => r.measureArea(face) / span;
  const thin = faces.filter((face) => Math.abs(across(face) - T) < 1e-6 * Math.max(1, T) && faces.some((o) => o !== face && square(o, face)));
  const flat = faces.find((face) => Math.abs(Math.abs(dot(unit(face.normalAt().toTuple()), sheet.normal)) - 1) < 1e-6);
  const side = thin.length === 1 ? thin[0] : flat ? faces.find((face) => face !== flat && square(face, flat)) : undefined;
  const top = side && faces.find((face) => face !== side && square(face, side));
  if (!side || !top) throw Error("pick an edge along the sheet's outline, where a sheet face meets the thickness");
  // A flange on another flange's end unrolls after it in the flat pattern.
  const owner = ownerOf(namesOf(body).get(side.hashCode) ?? ""),
    parent = ctx.flanges.has(owner) ? owner : undefined;
  const center = (face: r.Face) => r.measureShapeSurfaceProperties(face).centerOfMass;
  // Face normals of a solid point out of the material.
  const m = unit(side.normalAt().toTuple()),
    n = unit(top.normalAt().toTuple());
  // Bending "up" turns toward n, keeping the edge's own face inside the bend.
  const up = p.flip ? mul(n, -1) : n;
  const s = flangeSection(T, R, angle, p.length);
  if (s.straight < -1e-9) throw Error(`flange length must be at least ${(p.length - s.straight).toFixed(3)} mm to clear the bend`);
  // Section plane: x along m, y along up, normal along the edge.
  let e = unit(sub(B, A));
  if (dot(cross(e, m), up) < 0) {
    [A, B] = [B, A];
    e = mul(e, -1);
  }
  // Origin at the edge's far-face corner when bending away from the edge's face.
  const origin = p.flip ? A : sub(A, mul(n, T));
  const plane = new r.Plane(origin, m, e);
  try {
    const { at, outerEnd, innerEnd, w, straight, th } = s;
    const mid1 = at(R + T, th / 2),
      mid2 = at(R, th / 2);
    const outerTop: Vec2 = [outerEnd[0] + w[0] * straight, outerEnd[1] + w[1] * straight],
      innerTop: Vec2 = [innerEnd[0] + w[0] * straight, innerEnd[1] + w[1] * straight];
    let pen = r.draw([0, 0]).threePointsArcTo(outerEnd, mid1);
    if (straight > 1e-9) pen = pen.lineTo(outerTop).lineTo(innerTop).lineTo(innerEnd);
    else pen = pen.lineTo(innerEnd);
    const drawing = pen.threePointsArcTo([0, T], mid2).close();
    const solid = (drawing.sketchOnPlane(plane) as r.Sketch).extrude(span) as r.Shape3D;
    ctx.flanges.set(f.id, { bodyId: f.bodyId, A, B, m, up, angle, R, T, straight, origin, ...(parent ? { parent } : {}) });
    // Names by role: bend surfaces, wall faces, end and the two caps along the edge.
    const names: Names = new Map();
    for (const face of solid.faces) {
      const c = center(face),
        local: Vec2 = [dot(sub(c, origin), m), dot(sub(c, origin), up)];
      const along = dot(sub(c, A), e);
      let role: string;
      if (face.geomType !== "PLANE") role = Math.hypot(local[0] - s.C[0], local[1] - s.C[1]) > R + T / 2 ? "bend-outer" : "bend-inner";
      else if (Math.abs(along) < 1e-6 * span) role = "cap-start";
      else if (Math.abs(along - span) < 1e-6 * span) role = "cap-end";
      else if (Math.abs(local[0]) < 1e-6 && local[1] <= T + 1e-6) role = "root";
      else {
        const nn = unit(face.normalAt().toTuple()),
          wn: Vec3 = add(mul(m, w[0]), mul(up, w[1]));
        // The wall faces lie on lines through the bend ends along w.
        const off = (q: Vec2) => Math.abs(w[0] * (local[1] - q[1]) - w[1] * (local[0] - q[0]));
        role = Math.abs(dot(nn, wn)) > 0.999 ? "end" : off(outerEnd) < off(innerEnd) ? "wall-outer" : "wall-inner";
      }
      names.set(face.hashCode, `${f.id}:${role}`);
    }
    return named(solid, names);
  } finally {
    plane.delete();
  }
}
/**
 * A closed corner: two 90° edge flanges meeting at an outside corner of the
 * base have their walls carried across the corner gap. The first wall covers
 * the end of the second, out to its outer face; the second runs up to the
 * first wall's inside face, less the gap. Only the walls extend, so the bends
 * stop at the base corner and the square left between them is the corner relief.
 */
function closeCorner(ctx: Build, f: Feature, body: r.Shape3D): r.Shape3D {
  const p = f.params,
    sheet = sheetOf(ctx, f.bodyId, f.name);
  const [f1, f2] = (p.flanges as string[]).map((id) => {
    const fl = ctx.flanges.get(id);
    if (!fl || fl.bodyId !== f.bodyId) throw Error("a closed corner joins two edge flanges of this sheet metal part");
    return fl;
  });
  if (f1.parent || f2.parent) throw Error("closed corners join flanges on the base outline");
  if ([f1, f2].some((fl) => Math.abs(fl.angle - 90) > 1e-6)) throw Error("closed corners join 90° flanges");
  if (dot(f1.up, f2.up) < 1 - 1e-6) throw Error("both flanges must bend to the same side");
  if ([f1, f2].some((fl) => fl.straight <= 1e-9)) throw Error("both flanges need a straight wall beyond the bend");
  const n = sheet.normal,
    O = sheet.frame.origin,
    onBase = (q: Vec3) => sub(q, mul(n, dot(sub(q, O), n)));
  type End = "A" | "B";
  let corner: [End, End] | undefined;
  for (const k1 of ["A", "B"] as End[]) for (const k2 of ["A", "B"] as End[]) if (length(sub(onBase(f1[k1]), onBase(f2[k2]))) < 1e-6) corner = [k1, k2];
  if (!corner) throw Error("the flanges must meet at a corner of the base");
  const along = (fl: typeof f1, end: End) => mul(unit(sub(fl.B, fl.A)), end === "B" ? 1 : -1);
  // Past its end, each wall heads out over the other flange: an outside corner.
  if (dot(along(f1, corner[0]), f2.m) < 1 - 1e-6 || dot(along(f2, corner[1]), f1.m) < 1 - 1e-6)
    throw Error("closed corners close the gap at an outside corner, between flanges on square edges");
  const gap = (p.gap as number | undefined) ?? 0.1;
  const reach = [f2.R + f2.T, f1.R - gap];
  if (reach[1] <= 1e-9) throw Error(`the gap must be less than the bend radius (${f1.R} mm)`);
  if (f1.extend?.[corner[0]] || f2.extend?.[corner[1]]) throw Error("that corner is already closed");
  let result = body;
  [f1, f2].forEach((fl, i) => {
    const end = corner![i],
      L = reach[i],
      e = unit(sub(fl.B, fl.A)),
      span = length(sub(fl.B, fl.A));
    const s = flangeSection(fl.T, fl.R, fl.angle, 0);
    const top = (q: Vec2): Vec2 => [q[0] + s.w[0] * fl.straight, q[1] + s.w[1] * fl.straight];
    // The wall's section, swept from the end of the flange across the corner.
    const plane = new r.Plane(add(fl.origin, mul(e, end === "B" ? span : -L)), fl.m, e);
    try {
      const wall = (r.draw(s.outerEnd).lineTo(top(s.outerEnd)).lineTo(top(s.innerEnd)).lineTo(s.innerEnd).close().sketchOnPlane(plane) as r.Sketch).extrude(L) as r.Shape3D;
      result = booleanOp(result, named(wall, new Map(wall.faces.map((face, k) => [face.hashCode, `${f.id}:${i}:f${k}`]))), "fuse", f.id);
    } finally {
      plane.delete();
    }
    fl.extend = { ...fl.extend, [end]: L };
  });
  return result;
}
interface HoleLayout {
  frame: Frame;
  points: Vec3[];
  /** Stable identity of each hole instance, for the names of its faces. */
  ids: string[];
  direction: Vec3;
}
function holeLayout(ctx: Build, f: Feature, body: r.Shape3D): HoleLayout {
  const p = f.params;
  let frame: Frame,
    positions: Vec2[] = p.positions ?? [],
    ids: string[] = positions.map((_, i) => p.positionIds?.[i] ?? String(i)),
    inward: Vec3 | undefined;
  if (p.sketchId) {
    const s = ctx.sketch(p.sketchId, f);
    frame = ctx.sketchFrame(s);
    const centers = s.entities.filter((e) => e.type === "point" || (e.type === "circle" && !e.construction));
    positions = centers.map((e) => [e.values.x, e.values.y] as Vec2);
    ids = centers.map((e) => e.id);
    if (s.support) inward = mul(frame.normal, -1);
  } else if (p.face) {
    const face = resolve(body, p.face) as r.Face;
    if (face.geomType !== "PLANE") throw Error("Hole requires a planar face");
    frame = faceFrame(face, p.frame ?? "face-center");
    inward = mul(frame.normal, -1);
  } else {
    frame = principalFrame(p.plane ?? "XY", p.origin ?? [0, 0, 0]);
    if (!p.sketchId) inward = frame.normal;
  }
  if (!positions.length) throw Error(`${f.name}: place at least one hole center`);
  if (!inward) {
    // Drill toward the material.
    const [lo, hi] = body.boundingBox.bounds,
      center = mul(add(lo, hi), 0.5);
    inward = dot(sub(center, frame.origin), frame.normal) >= 0 ? frame.normal : mul(frame.normal, -1);
  }
  if (p.reverse) inward = mul(inward, -1);
  return { frame, points: positions.map((xy) => framePoint(frame, xy)), ids, direction: inward };
}
function holeTools(ctx: Build, f: Feature, body: r.Shape3D): r.Shape3D[] {
  const p = f.params,
    dims = holeDimensions(p),
    { points, ids, direction } = holeLayout(ctx, f, body),
    through = ctx.span() * 2,
    depth = p.depth ?? through;
  const tools: r.Shape3D[] = [];
  points.forEach((point, k) => {
    const base = `${f.id}:${ids[k]}`;
    const add3 = (solid: r.Shape3D, part: string) => tools.push(named(solid, toolNames(solid, `${base}:${part}`, direction)));
    const start = add(point, mul(direction, -0.1));
    add3(r.makeCylinder(dims.diameter / 2, depth + 0.1, start, direction), "drill");
    if (p.depth && p.tipAngle) {
      const tip = dims.diameter / 2 / Math.tan(((p.tipAngle / 2) * Math.PI) / 180);
      add3(frustum(add(point, mul(direction, depth)), direction, dims.diameter / 2, 1e-4, tip), "tip");
    }
    if (dims.counterbore) {
      if (dims.counterbore.diameter <= dims.diameter)
        throw Error(`${f.name}: counterbore diameter must exceed hole diameter`);
      add3(r.makeCylinder(dims.counterbore.diameter / 2, dims.counterbore.depth + 0.1, start, direction), "cbore");
    }
    if (dims.countersink) {
      if (dims.countersink.diameter <= dims.diameter)
        throw Error(`${f.name}: countersink diameter must exceed hole diameter`);
      const half = ((dims.countersink.angle / 2) * Math.PI) / 180,
        height = (dims.countersink.diameter - dims.diameter) / 2 / Math.tan(half);
      add3(
        frustum(start, direction, dims.countersink.diameter / 2 + 0.1 * Math.tan(half), dims.diameter / 2, height + 0.1),
        "csink",
      );
    }
  });
  return tools;
}
function edgeSelector(
  shape: r.Shape3D,
  p: Record<string, any>,
  value: any,
): ((e: r.Edge) => any) | undefined {
  const refs = p.edges as TopologyRef[] | undefined;
  if (p.faces?.length) {
    const selected = p.faces.flatMap((ref: TopologyRef) => (resolve(shape, ref) as r.Face).edges);
    return (edge) => (selected.some((e: r.Edge) => e.isSame(edge)) ? value : null);
  }
  if (refs?.length) {
    const selected = refs.map((ref) => resolve(shape, ref));
    return (edge) => (selected.some((e) => e.isSame(edge)) ? value : null);
  }
  if (p.selector === "vertical")
    return (edge) => (Math.abs(edge.tangentAt(0.5).toTuple()[2]) > 0.999 ? value : null);
  if (p.selector === "horizontal")
    return (edge) => (Math.abs(edge.tangentAt(0.5).toTuple()[2]) < 0.001 ? value : null);
  return undefined;
}
/**
 * Move planar faces along their normals; a positive offset adds material. The
 * faces around each moved face must be square to it, so they simply extend or
 * shorten and the result is exact. The moved face keeps its name, so sketches,
 * mates and dimensions on it follow it.
 */
function moveFaceShape(body: r.Shape3D, faces: r.Face[], offset: number, featureId: string): r.Shape3D {
  const names = namesOf(body);
  // Faces around each edge, found once (meshes have many faces).
  const around = new Map<number, r.Face[]>();
  for (const g of body.faces) for (const e of g.edges) around.set(e.hashCode, [...(around.get(e.hashCode) ?? []), g]);
  const prisms = faces.map((face, k) => {
    if (face.geomType !== "PLANE") throw Error("Move Face offsets planar faces");
    const n = unit(face.normalAt().toTuple()),
      center = r.measureShapeSurfaceProperties(face).centerOfMass;
    for (const edge of face.edges) {
      const neighbor = (around.get(edge.hashCode) ?? []).find((g) => !g.isSame(face) && g.edges.some((e) => e.isSame(edge)));
      if (!neighbor) continue;
      for (const t of [0.2, 0.5, 0.8]) {
        const at = edge.pointAt(t);
        if (Math.abs(dot(unit(neighbor.normalAt(at).toTuple()), n)) > 1e-6)
          throw Error("the faces around a moved face must be square to it; use a cut or extrude for other shapes");
      }
    }
    const prism = r.basicFaceExtrusion(face.clone() as r.Face, new r.Vector(mul(n, offset)));
    const base = names.get(face.hashCode) ?? `${featureId}:face${k}`,
      out: Names = new Map();
    prism.faces.forEach((g, i) => {
      const cap = g.geomType === "PLANE" && Math.abs(Math.abs(dot(unit(g.normalAt().toTuple()), n)) - 1) < 1e-9;
      const far = cap && Math.abs(dot(sub(r.measureShapeSurfaceProperties(g).centerOfMass, center), n)) > Math.abs(offset) / 2;
      out.set(g.hashCode, far ? base : cap ? `${featureId}:${k}:start` : `${featureId}:${k}:side${i}`);
    });
    return named(prism, out);
  });
  let result = body;
  for (const prism of prisms) result = booleanOp(result, prism, offset > 0 ? "fuse" : "cut", featureId);
  return result;
}

/**
 * A thread on a cylindrical face. Cosmetic threads change nothing in the solid
 * (the usual, lightweight way); modeled threads cut an ISO 60° helical groove.
 */
function threadOn(body: r.Shape3D, face: r.Face, p: Record<string, any>, featureId: string): { shape: r.Shape3D; record: Omit<ThreadRecord, "bodyId" | "featureId"> } {
  if (face.geomType !== "CYLINDRE") throw Error("threads go on cylindrical faces (shafts or holes)");
  const rim = face.edges.map((e) => (e.geomType === "CIRCLE" ? circleOf(e) : undefined)).filter((c): c is NonNullable<ReturnType<typeof circleOf>> => !!c);
  if (rim.length < 2) throw Error("the cylinder needs two circular ends");
  // A fixed axis direction (its largest component positive) so "start" means the same end every rebuild.
  const raw = unit(rim[0].normal),
    major = raw.reduce((k, v, i) => (Math.abs(v) > Math.abs(raw[k]) ? i : k), 0),
    axis = raw[major] < 0 ? mul(raw, -1) : raw,
    radius = rim[0].radius;
  // The two ends along the axis; the thread starts at one of them.
  const ends = rim.map((c) => dot(c.center, axis)).sort((a, b) => a - b);
  const [lo, hi] = [ends[0], ends[ends.length - 1]],
    base = rim[0].center,
    at = (t: number): Vec3 => add(sub(base, mul(axis, dot(base, axis))), mul(axis, t));
  const reverse = !!p.reverse,
    span = hi - lo,
    length = Math.min(p.length ?? span, span);
  const direction = reverse ? mul(axis, -1) : axis,
    startPoint = at(reverse ? hi : lo);
  // Internal when the face looks toward its axis (a hole), external on a shaft.
  const probe = face.pointOnSurface(0.5, 0.5).toTuple(),
    radial = sub(probe, add(startPoint, mul(direction, dot(sub(probe, startPoint), direction))));
  const internal = dot(unit(face.normalAt(probe).toTuple()), unit(radial)) < 0;
  const D = p.diameter as number,
    P = p.pitch as number;
  const record = { faceId: "", label: p.label as string, origin: startPoint, direction, radius, diameter: D, length, pitch: P, internal, modeled: p.mode === "modeled", through: length >= span - 1e-6, ...(p.hand === "left" ? { leftHand: true } : {}) };
  if (p.mode !== "modeled") return { shape: body, record };
  // Modeled: the shaft is the major diameter, the hole the tap drill.
  if (!internal && Math.abs(2 * radius - D) > 0.05 * D) throw Error(`the shaft is Ø${(2 * radius).toFixed(2)}; an ${p.label} thread needs Ø${D}`);
  if (internal && (2 * radius >= D || 2 * radius < D - 1.3 * P)) throw Error(`the hole is Ø${(2 * radius).toFixed(2)}; tap ${p.label} at about Ø${(D - P).toFixed(2)}`);
  const tan = Math.tan(Math.PI / 6);
  // ISO 60° flanks: the groove narrows from the open side to its root.
  const profile: [number, number][] = internal
    ? (() => {
        const rMajor = D / 2,
          rIn = radius - 0.2 * P,
          half = (x: number) => P / 16 + (rMajor - x) * tan;
        return [[rIn, -half(rIn)], [rMajor, -P / 16], [rMajor, P / 16], [rIn, half(rIn)]];
      })()
    : (() => {
        const rRoot = (D - 1.226869 * P) / 2,
          rOut = D / 2 + 0.2 * P,
          half = (x: number) => P / 8 + (x - rRoot) * tan;
        return [[rOut, -half(rOut)], [rRoot, -P / 8], [rRoot, P / 8], [rOut, half(rOut)]];
      })();
  // The groove starts a pitch before the end so the thread runs out cleanly.
  const start = sub(startPoint, mul(direction, P)),
    helix = r.makeHelix(P, length + P, internal ? radius : (D - 1.226869 * P) / 2, start, direction, p.hand === "left");
  // The profile lies in the plane through the axis where the helix begins.
  const x0 = unit(sub(helix.startPoint.toTuple(), start)),
    plane = new r.Plane(start, x0, cross(direction, x0));
  try {
    let pen = r.draw(profile[0]);
    for (const q of profile.slice(1)) pen = pen.lineTo(q);
    const sketch = pen.close().sketchOnPlane(plane) as r.Sketch;
    const groove = r.genericSweep(sketch.wire, helix, { frenet: true }) as r.Shape3D;
    return { shape: booleanOp(body, named(groove, new Map(groove.faces.map((g, i) => [g.hashCode, `${featureId}:thread${i}`]))), "cut", featureId), record };
  } finally {
    plane.delete();
  }
}

/** The 2D outline of an involute spur gear, teeth turned by `phase` degrees. */
function gearDrawing(g: GearSpec, phase: number): r.Drawing {
  const t = toothFlanks(g),
    step = TAU / g.teeth,
    turn = (phase * Math.PI) / 180;
  const at = (p: Vec2, angle: number): Vec2 => [p[0] * Math.cos(angle) - p[1] * Math.sin(angle), p[0] * Math.sin(angle) + p[1] * Math.cos(angle)];
  const radial = t.root < t.rootStart,
    thin = backlashTurn(g);
  const rootPoint = (angle: number, side: 1 | -1): Vec2 => [t.root * Math.cos(angle + side * (t.baseHalf - thin)), t.root * Math.sin(angle + side * (t.baseHalf - thin))];
  let pen: r.DrawingPen | undefined,
    first: Vec2 | undefined;
  // One cubic per flank: the right flank root to tip, the left its mirror tip to root.
  const flank = flankBeziers(g).map((b) => b.map((p) => at(p, thin))),
    mirrored = flank.map((b) => b.map(([x, y]) => [x, -y] as Vec2).reverse()).reverse();
  const curve = (spans: Vec2[][]) => {
    for (const b of spans) pen = pen!.cubicBezierCurveTo(b[3], b[1], b[2]);
  };
  for (let k = 0; k < g.teeth; k++) {
    const angle = turn + k * step,
      right = flank.map((b) => b.map((p) => at(p, angle))),
      left = mirrored.map((b) => b.map((p) => at(p, angle)));
    const start = radial ? rootPoint(angle, -1) : right[0][0];
    if (!pen) {
      pen = r.draw(start);
      first = start;
    } else pen = pen.threePointsArcTo(start, [t.root * Math.cos(angle - step / 2), t.root * Math.sin(angle - step / 2)]);
    if (radial) pen = pen.lineTo(right[0][0]);
    curve(right);
    pen = pen.threePointsArcTo(left[0][0], [t.tip * Math.cos(angle), t.tip * Math.sin(angle)]);
    curve(left);
    if (radial) pen = pen.lineTo(rootPoint(angle, 1));
  }
  const last = turn + (g.teeth - 1) * step;
  pen = pen!.threePointsArcTo(first!, [t.root * Math.cos(last + step / 2), t.root * Math.sin(last + step / 2)]);
  return pen.close();
}
/** Solid from a 2D drawing on a frame, extruded along the frame normal; faces named by role. */
function drawnSolid(drawing: r.Drawing, frame: Frame, width: number, featureId: string, bore?: number): r.Shape3D {
  const plane = toPlane(frame);
  try {
    let solid = (drawing.sketchOnPlane(plane) as r.Sketch).extrude(width) as r.Shape3D;
    if (bore) solid = solid.cut((r.drawCircle(bore / 2).sketchOnPlane(plane) as r.Sketch).extrude(width) as r.Shape3D);
    const names: Names = new Map();
    solid.faces.forEach((face, i) => {
      const along = face.geomType === "PLANE" ? dot(sub(r.measureShapeSurfaceProperties(face).centerOfMass, frame.origin), frame.normal) : undefined;
      const isBore = bore && face.geomType === "CYLINDRE" && face.edges.some((e) => Math.abs((circleOf(e)?.radius ?? 0) - bore / 2) < 1e-6);
      names.set(face.hashCode, isBore ? `${featureId}:bore` : along !== undefined && Math.abs(along) < 1e-6 ? `${featureId}:back` : along !== undefined && Math.abs(along - width) < 1e-6 ? `${featureId}:front` : `${featureId}:f${i}`);
    });
    return named(solid, names);
  } finally {
    plane.delete();
  }
}
/** A frame on a plane, moved to a center given in the plane's own coordinates. */
const centered = (frame: Frame, center: Vec2): Frame => ({ ...frame, origin: add(add(frame.origin, mul(frame.xDir, center[0])), mul(frame.yDir, center[1])) });

/**
 * One structural member along a sketch line: the profile swept straight along
 * it, its ends cut where it meets other members of its group (mitered, or
 * butted with the earlier member running through).
 */
function memberSolid(ctx: Build, f: Feature): r.Shape3D {
  const p = f.params,
    s = ctx.sketch(p.sketchId, f),
    frame = ctx.sketchFrame(s);
  const lineOf = (id: string) => {
    const e = s.entities.find((x) => x.id === id && x.type === "line");
    if (!e) throw Error("members follow sketch lines");
    return [framePoint(frame, [e.values.x1, e.values.y1]), framePoint(frame, [e.values.x2, e.values.y2])] as [Vec3, Vec3];
  };
  const [P, Q] = lineOf(p.entityId),
    dir = unit(sub(Q, P)),
    L = length(sub(Q, P));
  const profile = p.profile as MemberProfile,
    half = (profile.kind === "round-tube" ? profile.width : Math.max(profile.width, profile.height ?? profile.width)) / 2,
    across = profile.width / 2;
  const group = (p.group as string[]) ?? [p.entityId],
    index = group.indexOf(p.entityId);
  // Each end: where it meets another member of the group, and how it is cut there.
  const cuts: { point: Vec3; normal: Vec3 }[] = [];
  let startExtra = 0,
    endExtra = 0;
  for (const [J, u, atStart] of [
    [P, mul(dir, -1), true],
    [Q, dir, false],
  ] as [Vec3, Vec3, boolean][]) {
    const other = group
      .map((id, i) => ({ id, i }))
      .filter((x) => x.id !== p.entityId)
      .map((x) => ({ ...x, line: lineOf(x.id) }))
      .find((x) => x.line.some((q) => length(sub(q, J)) < 1e-6));
    const reach = half * 3;
    if (atStart) startExtra = other ? reach : 0;
    else endExtra = other ? reach : 0;
    if (!other) {
      // A T-joint: this end lands partway along another member, so it stops at that member's side.
      const tee = group
        .filter((id) => id !== p.entityId)
        .map(lineOf)
        .find(([a, b]) => {
          const d = sub(b, a),
            t = dot(sub(J, a), d) / dot(d, d);
          return t > 1e-6 && t < 1 - 1e-6 && length(sub(J, add(a, mul(d, t)))) < 1e-6;
        });
      if (tee) cuts.push({ point: sub(J, mul(u, across)), normal: u });
      continue;
    }
    const far = length(sub(other.line[0], J)) < 1e-6 ? other.line[1] : other.line[0],
      v = unit(sub(far, J));
    if (p.corner === "butt") {
      // The earlier member runs through to the other's far side; the later stops at its near side.
      cuts.push({ point: add(J, mul(u, other.i > index ? across : -across)), normal: u });
    } else cuts.push({ point: J, normal: unit(add(u, v)) });
  }
  const xAx = unit(cross(frame.normal, dir)),
    start = sub(P, mul(dir, startExtra));
  const plane = new r.Plane(start, xAx, dir);
  try {
    const outline = profileOutline(profile);
    const draw = (o: Vec2[] | { radius: number }) => {
      if ("radius" in o) return r.drawCircle(o.radius);
      let pen = r.draw(o[0]);
      for (const q of o.slice(1)) pen = pen.lineTo(q);
      return pen.close();
    };
    let drawing = draw(outline.outer);
    if (outline.inner) drawing = drawing.cut(draw(outline.inner));
    let solid = (drawing.sketchOnPlane(plane) as r.Sketch).extrude(L + startExtra + endExtra) as r.Shape3D;
    for (const c of cuts) {
      const cutter = new r.Plane(c.point, axesFor(c.normal).xDir, c.normal);
      try {
        const kept = solid.cutPlane(cutter, 0, "negative") as r.Shape3D | null;
        if (!kept) throw Error("a member corner cut removed the whole member");
        solid.delete();
        solid = kept;
      } finally {
        cutter.delete();
      }
    }
    return named(solid, new Map(solid.faces.map((face, i) => [face.hashCode, `${f.id}:f${i}`])));
  } finally {
    plane.delete();
  }
}
/**
 * Fillet weld beads: a right-triangle bead of the given leg in each chosen
 * inside corner, along the straight edge where two flat faces meet.
 */
function weldBeads(body: r.Shape3D, edges: r.Edge[], leg: number, featureId: string): r.Shape3D {
  let result = body;
  edges.forEach((edge, k) => {
    if (edge.geomType !== "LINE") throw Error("weld beads go along straight edges");
    const faces = body.faces.filter((face) => face.geomType === "PLANE" && face.edges.some((e) => e.isSame(edge)));
    if (faces.length !== 2) throw Error("a weld bead needs the edge between two flat faces");
    const A = edge.startPoint.toTuple(),
      B = edge.endPoint.toTuple(),
      e = unit(sub(B, A)),
      mid = mul(add(A, B), 0.5);
    // In each face: the direction square to the edge, pointing into the face.
    const [d1, d2] = faces.map((face) => {
      const n = unit(face.normalAt().toTuple()),
        d = unit(cross(n, e)),
        c = r.measureShapeSurfaceProperties(face).centerOfMass;
      return dot(sub(c, mid), d) >= 0 ? d : mul(d, -1);
    });
    const n1 = unit(faces[0].normalAt().toTuple());
    // An inside corner: the second face rises on the side the first face looks toward.
    if (dot(n1, d2) <= 1e-6) throw Error("weld beads go in inside corners, where two faces meet at less than 180°");
    const bead = r.makePolygon([A, add(A, mul(d1, leg)), add(A, mul(d2, leg))]);
    const prism = r.basicFaceExtrusion(bead as unknown as r.Face, new r.Vector(sub(B, A)));
    result = booleanOp(result, named(prism, new Map(prism.faces.map((face, i) => [face.hashCode, `${featureId}:bead${k}:${i}`]))), "fuse", featureId);
  });
  return result;
}

/**
 * A sketched bend: the sheet folds along a sketch line by an angle. The fixed
 * side stays; the material within half a bend allowance of the line becomes
 * the bend (a cylindrical shell of inside radius R); the moving side turns
 * about the bend's axis. Faces keep their names on both sides.
 */
function bendSheet(ctx: Build, f: Feature, body: r.Shape3D): r.Shape3D {
  const p = f.params,
    sheet = sheetOf(ctx, f.bodyId, f.name),
    T = sheet.thickness,
    R = p.bendRadius ?? sheet.radius,
    theta = ((p.angle as number) * Math.PI) / 180;
  if (!(p.angle > 0 && p.angle < 180)) throw Error("bend angle must be between 0 and 180 degrees");
  const s = ctx.sketch(p.sketchId, f),
    line = s.entities.find((e) => e.id === p.entityId && e.type === "line");
  if (!line) throw Error("bend along a sketch line");
  const sf = ctx.sketchFrame(s),
    n = sheet.normal,
    O = sheet.frame.origin;
  // The line on the base plane: e along it, u across toward the moving side.
  const onBase = (q: Vec3) => sub(q, mul(n, dot(sub(q, O), n)));
  const P1 = onBase(framePoint(sf, [line.values.x1, line.values.y1])),
    P2 = onBase(framePoint(sf, [line.values.x2, line.values.y2]));
  const e = unit(sub(P2, P1));
  let u = unit(cross(n, e));
  const BA = theta * (R + sheet.k * T),
    half = BA / 2,
    big = 1e5;
  // A slab of the sheet's plane between two offsets across the line.
  const slab = (lo: number, hi: number) => {
    const plane = new r.Plane(sub(sub(P1, mul(e, big)), mul(n, big)), u, e);
    try {
      return (r
        .draw([lo, 0])
        .lineTo([hi, 0])
        .lineTo([hi, 2 * big])
        .lineTo([lo, 2 * big])
        .close()
        .sketchOnPlane(plane) as r.Sketch).extrude(2 * big) as r.Shape3D;
    } finally {
      plane.delete();
    }
  };
  const volumeOf = (shape: r.Shape3D) => (shape.isNull ? 0 : r.measureVolume(shape));
  // By default the larger side stays put; flipSide moves the other one.
  const plus = booleanOp(body, slab(half, big), "common", f.id),
    minus = booleanOp(body, slab(-big, -half), "common", f.id);
  let [fixed, moving] = volumeOf(plus) > volumeOf(minus) ? [plus, minus] : [minus, plus];
  if (p.flipSide) [fixed, moving] = [moving, fixed];
  if (moving === minus) u = mul(u, -1);
  if (volumeOf(moving) < 1e-9) throw Error("the bend line must cross the sheet");
  // The strip that becomes the bend must run square across the sheet.
  const strip = booleanOp(body, slab(-half, half), "common", f.id),
    along = strip.boundingBox.bounds,
    corners = [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => [along[i][0], along[j][1], along[k][2]] as Vec3)));
  const es = corners.map((c) => dot(sub(c, P1), e)),
    e0 = Math.min(...es),
    e1 = Math.max(...es);
  if (Math.abs(volumeOf(strip) - BA * T * (e1 - e0)) > 1e-6 * Math.max(1, volumeOf(strip)))
    throw Error("the sheet must cross the bend line square, without holes or notches in the bend");
  strip.delete();
  const [v0, v1] = sheet.span,
    up = !p.flip;
  // The bend's center line, offset from the sheet by the inside radius.
  const cv = up ? v1 + R : v0 - R,
    center = add(add(P1, mul(u, -half)), mul(n, cv));
  const sectorPlane = new r.Plane(add(sub(P1, mul(u, half)), mul(e, e0)), u, e);
  let bend: r.Shape3D;
  try {
    // In the section: x across the line, y along the normal, centered on the bend's axis.
    const a0 = up ? -Math.PI / 2 : Math.PI / 2,
      a1 = up ? a0 + theta : a0 - theta;
    const at = (r0: number, a: number): Vec2 => [r0 * Math.cos(a), cv + r0 * Math.sin(a)];
    const drawing = r
      .draw(at(R, a0))
      .threePointsArcTo(at(R, a1), at(R, (a0 + a1) / 2))
      .lineTo(at(R + T, a1))
      .threePointsArcTo(at(R + T, a0), at(R + T, (a0 + a1) / 2))
      .close();
    bend = (drawing.sketchOnPlane(sectorPlane) as r.Sketch).extrude(e1 - e0) as r.Shape3D;
  } finally {
    sectorPlane.delete();
  }
  named(
    bend,
    new Map(
      bend.faces.map((face, i) => [
        face.hashCode,
        `${f.id}:${face.geomType === "PLANE" ? `bend-end${i}` : face.edges.some((ed) => Math.abs((circleOf(ed)?.radius ?? 0) - R) < 1e-6) ? "bend-inner" : "bend-outer"}`,
      ]),
    ),
  );
  // Close the gap the bend allowance leaves, then turn the moving side about the axis.
  const moved = moving
    .clone()
    .translate(mul(u, -BA))
    .rotate(((up ? 1 : -1) * p.angle * (dot(cross(u, n), e) > 0 ? 1 : -1)) as number, center, e) as r.Shape3D;
  const placed = copyOf(moving, moved, "");
  return booleanOp(booleanOp(fixed, bend, "fuse", f.id), placed, "fuse", f.id);
}

/** Hash codes of seam edges: edges a face meets on both sides of itself. */
function seamEdges(shape: r.Shape3D, topology?: ReturnType<typeof topologies>): Set<number> {
  const oc = r.getOC() as any,
    seams = new Set<number>();
  for (const face of shape.faces)
    for (const edge of face.edges) if (oc.BRep_Tool.IsClosed(edge.wrapped, face.wrapped)) seams.add(edge.hashCode);
  if (topology) for (const hash of sameSurfaceEdges(shape, topology)) seams.add(hash);
  return seams;
}
/**
 * Tangent edges, as SolidWorks calls them: where two faces meet smoothly (a
 * fillet's boundary, the joint between a gear flank's spans). Drawn unless
 * the viewer turns tangent edges off.
 */
function tangentEdgeIds(shape: r.Shape3D, topology: ReturnType<typeof topologies>, hidden: Set<number>): string[] {
  const faces = new Map<number, r.Face[]>();
  for (const face of shape.faces)
    for (const e of face.edges) {
      const list = faces.get(e.hashCode) ?? [];
      if (!list.some((f) => f.isSame(face))) list.push(face);
      faces.set(e.hashCode, list);
    }
  const out: string[] = [];
  for (const edge of shape.edges) {
    const pair = faces.get(edge.hashCode);
    if (hidden.has(edge.hashCode) || pair?.length !== 2) continue;
    const p = edge.pointAt(0.5).toTuple();
    try {
      const [n1, n2] = pair.map((f) => unit(f.normalAt(p).toTuple()));
      const id = topology.hashes.get(edge.hashCode);
      if (id && dot(n1, n2) > Math.cos(Math.PI / 180)) out.push(id);
    } catch {
      /* a degenerate edge: leave it drawn */
    }
  }
  return out;
}
/**
 * Edges between two faces of one surface: a cylinder or plane split in two
 * (an extruded circle's side is two half-cylinders). There is no edge on the
 * part there, so, like seams, they are not drawn.
 */
function sameSurfaceEdges(shape: r.Shape3D, topology: ReturnType<typeof topologies>): Set<number> {
  const meta = new Map(topology.metadata.map((t) => [t.id, t]));
  const sides = new Map<number, Topology[]>();
  for (const face of shape.faces) {
    const t = meta.get(topology.hashes.get(face.hashCode) ?? "");
    if (!t) continue;
    for (const e of face.edges) {
      const list = sides.get(e.hashCode) ?? [];
      if (!list.includes(t)) list.push(t);
      sides.set(e.hashCode, list);
    }
  }
  const tol = 1e-6;
  const same = (a: Topology, b: Topology) => {
    if (a.geomType !== b.geomType) return false;
    if (a.geomType === "PLANE")
      return !!a.normal && !!b.normal && Math.abs(Math.abs(dot(unit(a.normal), unit(b.normal))) - 1) < 1e-9 && Math.abs(dot(sub(a.center, b.center), unit(a.normal))) < tol;
    if ((a.geomType === "CYLINDRE" || a.geomType === "SPHERE") && a.axis && b.axis && a.radius !== undefined && b.radius !== undefined) {
      const u = unit(a.axis.direction),
        off = sub(b.axis.origin, a.axis.origin);
      const onAxis = a.geomType === "SPHERE" ? length(off) < tol : length(sub(off, mul(u, dot(off, u)))) < tol;
      return Math.abs(Math.abs(dot(u, unit(b.axis.direction))) - 1) < 1e-9 && onAxis && Math.abs(a.radius - b.radius) < tol;
    }
    return false;
  };
  const out = new Set<number>();
  for (const [hash, list] of sides) if (list.length === 2 && same(list[0], list[1])) out.add(hash);
  return out;
}

/** Parsed imported files by content hash, most recently used last. */
const importCache = new Map<string, {shape:r.Shape3D; colors:Map<number,string>}>();
/**
 * A watertight STL mesh as a solid. Facets are sewn into a shell and coplanar
 * facets are merged into single planar faces, so a mesh of a machined part
 * comes back with flat faces and straight edges that take sketches, cuts,
 * holes and fillets. Curved areas stay faceted.
 */
export function stlSolid(bytes: Uint8Array, scale: number): r.Shape3D {
  const triangles = stlTriangleCount(bytes);
  if (!triangles) throw Error("the file could not be read as STL (no triangles)");
  if (triangles > STL_TRIANGLE_LIMIT)
    throw Error(`the mesh has ${triangles.toLocaleString("en-US")} triangles; meshes up to ${STL_TRIANGLE_LIMIT.toLocaleString("en-US")} triangles import as solids. Reduce it first.`);
  const oc = r.getOC() as any,
    file = `/import-${Math.random().toString(36).slice(2)}.stl`;
  oc.FS.writeFile(file, bytes);
  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T) => (trash.push(x), x);
  try {
    const reader = keep(new oc.StlAPI_Reader()),
      raw = keep(new oc.TopoDS_Shell());
    if (!reader.Read(raw, file)) throw Error("the file could not be read as STL");
    // The reader returns loose facets; sew them along their shared edges.
    const sewing = keep(new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false)),
      sewProgress = keep(new oc.Message_ProgressRange());
    sewing.Add(raw);
    sewing.Perform(sewProgress);
    if (sewing.NbFreeEdges() > 0)
      throw Error(`the mesh is not watertight (${sewing.NbFreeEdges()} open edges), so it cannot become a solid`);
    const sewn = keep(sewing.SewedShape());
    const unify = keep(new oc.ShapeUpgrade_UnifySameDomain(sewn, true, true, false));
    unify.Build();
    const merged = keep(unify.Shape());
    const shells = keep(new oc.TopExp_Explorer(merged, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    // One solid per closed shell, oriented outward.
    const pieces: r.Shape3D[] = [];
    for (; shells.More(); shells.Next()) {
      const shell = oc.TopoDS.Shell(shells.Current());
      if (!oc.BRep_Tool.IsClosed(shell))
        throw Error("the mesh is not watertight (it has open edges), so it cannot become a solid");
      // SolidFromShell orients the shell so the material is inside it.
      const fix = keep(new oc.ShapeFix_Solid());
      pieces.push(r.cast(fix.SolidFromShell(shell)) as r.Shape3D);
    }
    if (!pieces.length) throw Error("the mesh has no closed surface");
    // A shell inside another one is a cavity; separate shells are separate lumps.
    pieces.sort((a, b) => r.measureVolume(b) - r.measureVolume(a));
    const lumps: r.Shape3D[] = [];
    for (const piece of pieces) {
      const volume = r.measureVolume(piece),
        host = lumps.findIndex((lump) => Math.abs(r.measureVolume(lump.clone().intersect(piece.clone())) - volume) < 1e-6 * Math.max(1, volume));
      if (host >= 0) lumps[host] = lumps[host].cut(piece);
      else lumps.push(piece);
    }
    const solid = lumps.length === 1 ? lumps[0] : (r.makeCompound(lumps) as unknown as r.Shape3D);
    return scale === 1 ? solid : (solid.scale(scale, [0, 0, 0]) as r.Shape3D);
  } finally {
    oc.FS.unlink(file);
    for (const x of trash.reverse()) x.delete();
  }
}

/** Constant or variable-radius fillet; the round of each edge is named after the edge. */
function filletShape(body: r.Shape3D, p: Record<string, any>, featureId: string): r.Shape3D {
  const oc = r.getOC() as any,
    builder = new oc.BRepFilletAPI_MakeFillet(body.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  const arrays: { delete(): void }[] = [];
  try {
    let count = 0;
    if (p.profiles) {
      for (const profile of p.profiles) {
        const edge = resolve(body, profile.edge) as r.Edge;
        if (profile.points.length === 2) builder.Add(profile.points[0].radius, profile.points[1].radius, edge.wrapped);
        else {
          const law = new oc.NCollection_Array1_gp_Pnt2d(1, profile.points.length);
          arrays.push(law);
          profile.points.forEach((q: any, i: number) => {
            const point = new oc.gp_Pnt2d(q.position, q.radius);
            try {
              law.SetValue(i + 1, point);
            } finally {
              point.delete();
            }
          });
          builder.Add(law, edge.wrapped);
        }
        count++;
      }
    } else {
      const select = edgeSelector(body, p, p.radius);
      for (const edge of body.edges) {
        const radius = select ? select(edge) : p.radius;
        if (!radius) continue;
        builder.Add(radius, edge.wrapped);
        count++;
      }
    }
    if (!count) throw Error("select at least one edge to fillet");
    builder.Build();
    const result = r.cast(builder.Shape());
    if (!r.isShape3D(result)) throw Error("the fillet did not produce a solid");
    return named(result, historyNames(builder, result, [input(body)], featureId, { fromEdges: "round" }));
  } finally {
    builder.delete();
    arrays.forEach((a) => a.delete());
  }
}
/** Equal, two-distance or distance-angle chamfer; each bevel is named after its edge. */
function chamfer(body: r.Shape3D, p: Record<string, any>, name: string, featureId: string): r.Shape3D {
  const kind = p.chamferType ?? "equal";
  const oc = r.getOC() as any,
    builder = new oc.BRepFilletAPI_MakeChamfer(body.wrapped);
  try {
    let count = 0;
    if (kind === "equal") {
      const select = edgeSelector(body, p, p.distance);
      for (const edge of body.edges) {
        const distance = select ? select(edge) : p.distance;
        if (!distance) continue;
        builder.Add(distance, edge.wrapped);
        count++;
      }
    } else {
      const edges = (p.edges as TopologyRef[] | undefined)?.map((ref) => resolve(body, ref) as r.Edge);
      if (!edges?.length) throw Error(`${name}: select edges for an asymmetric chamfer`);
      const faces = body.faces;
      for (const edge of edges) {
        const adjacent = faces.filter((face) => face.edges.some((e) => e.isSame(edge)));
        const reference = adjacent[p.flip ? 1 : 0] ?? adjacent[0];
        if (!reference) continue;
        if (kind === "two-distance") builder.Add(p.distance, p.distance2 ?? p.distance, edge.wrapped, reference.wrapped);
        else builder.AddDA(p.distance, ((p.angle ?? 45) * Math.PI) / 180, edge.wrapped, reference.wrapped);
        count++;
      }
    }
    if (!count) throw Error(`${name}: select at least one edge to chamfer`);
    builder.Build();
    const result = r.cast(builder.Shape());
    if (!r.isShape3D(result)) throw Error("the chamfer did not produce a solid");
    return named(result, historyNames(builder, result, [input(body)], featureId, { fromEdges: "bevel" }));
  } finally {
    builder.delete();
  }
}
/** Hollow a solid; inner walls are named after the outer faces they offset. */
function shellShape(body: r.Shape3D, faces: r.Face[], thickness: number, featureId: string): r.Shape3D {
  const oc = r.getOC() as any,
    remove = new oc.NCollection_List_TopoDS_Shape(),
    builder = new oc.BRepOffsetAPI_MakeThickSolid();
  try {
    for (const face of faces) remove.Append(face.wrapped);
    builder.MakeThickSolidByJoin(
      body.wrapped,
      remove,
      -thickness,
      1e-3,
      oc.BRepOffset_Mode.BRepOffset_Skin,
      false,
      false,
      oc.GeomAbs_JoinType.GeomAbs_Arc,
      false,
    );
    const result = r.cast(builder.Shape());
    if (!r.isShape3D(result)) throw Error("the shell did not produce a solid");
    return named(result, historyNames(builder, result, [input(body)], featureId, { fromFaces: "inner" }));
  } finally {
    builder.delete();
    remove.delete();
  }
}
/** Draft faces about a neutral plane; drafted faces keep their names. */
function draftShape(body: r.Shape3D, faces: r.Face[], angle: number, neutral: Frame, featureId: string): r.Shape3D {
  const oc = r.getOC() as any,
    builder = new oc.BRepOffsetAPI_DraftAngle(body.wrapped),
    origin = new oc.gp_Pnt(...neutral.origin),
    direction = new oc.gp_Dir(...neutral.normal),
    plane = new oc.gp_Pln(origin, direction);
  try {
    for (const face of faces) builder.Add(face.wrapped, direction, (angle * Math.PI) / 180, plane, false);
    builder.Build();
    if (!builder.IsDone()) throw Error("draft failed");
    const result = r.cast(builder.ModifiedShape(body.wrapped));
    if (!r.isShape3D(result)) throw Error("the draft did not produce a solid");
    return named(
      result,
      historyNames(builder, result, [input(body)], featureId, {
        modified: (face) => [r.cast(builder.ModifiedShape(face.wrapped))],
      }),
    );
  } finally {
    builder.delete();
    plane.delete();
    direction.delete();
    origin.delete();
  }
}
function patternTransform(shape: r.Shape3D, p: Record<string, any>, axis: { origin: Vec3; direction: Vec3 } | undefined, i: number, j = 0): r.Shape3D {
  const copy = shape.clone();
  if (p.kind === "circular") {
    const full = Math.abs(p.angle - 360) < 1e-8;
    const step = p.angle / (full ? p.count : p.count - 1);
    const rotated = copy.rotate(i * step, axis!.origin, axis!.direction);
    return rotated;
  }
  let offset = mul(p.direction, p.spacing * i);
  if (j && p.direction2) offset = add(offset, mul(p.direction2, (p.spacing2 ?? p.spacing) * j));
  return copy.translate(offset);
}
function instances(p: Record<string, any>): [number, number][] {
  const out: [number, number][] = [];
  const count2 = p.kind === "circular" ? 1 : (p.count2 ?? 1);
  for (let j = 0; j < count2; j++)
    for (let i = 0; i < p.count; i++) {
      if (i === 0 && j === 0) continue;
      const number = j * p.count + i + 1;
      if (p.skippedInstances?.includes(number)) continue;
      out.push([i, j]);
    }
  return out;
}
function mirrorFrame(ctx: Build, p: Record<string, any>): Frame {
  if (p.mirrorPlane) return ctx.planeRef(p.mirrorPlane);
  return principalFrame(p.plane ?? "YZ", p.origin ?? [0, 0, 0]);
}

/** Build every body of a document, returning shapes and placement frames. */
export async function buildModel(doc: Document): Promise<Build> {
  doc = structuredClone(doc);
  for (const sk of doc.sketches)
    if (sk.referencePlaneId) {
      const plane = doc.referencePlanes?.find((p) => p.id === sk.referencePlaneId);
      if (!plane) throw Error("Sketch reference plane is missing");
      sk.plane = plane.plane;
      sk.origin = [...plane.origin];
    }
  await initKernel();
  const ctx = new Build(doc);
  try {
    for (const f of doc.features) {
      if (f.suppressed) continue;
      const p = f.params;
      const record = (solids: r.Shape3D[], op: ToolRecord["op"]) =>
        ctx.tools.set(f.id, {
          solids: solids.map((solid) => named(solid.clone(), namesOf(solid))),
          op,
          bodyId: f.bodyId,
        });
      try {
        switch (f.type) {
          case "extrude":
          case "revolve":
          case "loft":
          case "sweep": {
            const solid =
              f.type === "extrude"
                ? extrudeTool(ctx, f)
                : f.type === "revolve"
                  ? revolveTool(ctx, f)
                  : f.type === "loft"
                    ? loftTool(ctx, f)
                    : sweepTool(ctx, f);
            const op = p.operation ?? "new";
            record([solid], op === "cut" ? "cut" : op === "intersect" ? "common" : "fuse");
            if (op === "new") ctx.own(f.bodyId, solid);
            else {
              const body = ctx.body(f.bodyId, f);
              try {
                ctx.own(f.bodyId, applyOp(body, solid, op, f.id));
              } finally {
                solid.delete();
              }
            }
            break;
          }
          case "hole": {
            const body = ctx.body(f.bodyId, f),
              tools = holeTools(ctx, f, body);
            let result = body;
            for (const tool of tools) {
              const next = booleanOp(result, tool, "cut", f.id);
              if (result !== body) result.delete();
              result = next;
            }
            ctx.tools.set(f.id, { solids: tools, op: "cut", bodyId: f.bodyId });
            ctx.own(f.bodyId, result);
            break;
          }
          case "fillet": {
            const body = ctx.body(f.bodyId, f);
            try {
              ctx.own(f.bodyId, filletShape(body, p, f.id));
            } catch (error) {
              if (error instanceof Error && !error.message.includes("WebAssembly") && !/^\d+$/.test(error.message))
                throw error;
              throw Error(
                `${f.name}: cannot construct the fillet at these radii. Reduce the radius or change the selected geometry.`,
              );
            }
            break;
          }
          case "chamfer": {
            const body = ctx.body(f.bodyId, f);
            try {
              ctx.own(f.bodyId, chamfer(body, p, f.name, f.id));
            } catch (error) {
              if (error instanceof Error && !error.message.includes("WebAssembly") && !/^\d+$/.test(error.message))
                throw error;
              throw Error(
                `${f.name}: cannot construct the chamfer at this distance. Reduce the distance or change the selected edges.`,
              );
            }
            break;
          }
          case "pattern": {
            const body = ctx.body(f.bodyId, f);
            const axis =
              p.kind === "circular"
                ? p.axisRef
                  ? ctx.axis(p.axisRef)
                  : { origin: p.axisOrigin ?? [0, 0, 0], direction: unit(p.axis) }
                : undefined;
            if (p.kind !== "circular" && p.directionRef) {
              const d = ctx.axis(p.directionRef).direction;
              p.direction = p.reverseDirection ? mul(d, -1) : d;
            }
            const sources: string[] = p.featureIds ?? (p.featureId ? [p.featureId] : []);
            let result = body;
            const step = (copy: r.Shape3D, op: ToolRecord["op"]) => {
              const next = booleanOp(result, copy, op, f.id);
              copy.delete();
              if (result !== body) result.delete();
              result = next;
            };
            try {
              if (sources.length) {
                for (const id of sources) {
                  const tool = ctx.tools.get(id);
                  if (!tool) throw Error(`${f.name}: a patterned feature is suppressed or unavailable`);
                  if (tool.bodyId !== f.bodyId) throw Error(`${f.name}: patterned features must belong to the same body`);
                  for (const [i, j] of instances(p))
                    for (const solid of tool.solids)
                      step(copyOf(solid, patternTransform(solid, p, axis, i, j), `${f.id}:${i}.${j}:`), tool.op);
                }
              } else {
                for (const [i, j] of instances(p))
                  step(copyOf(body, patternTransform(body, p, axis, i, j), `${f.id}:${i}.${j}:`), "fuse");
              }
              ctx.own(f.bodyId, result);
            } catch (error) {
              if (result !== body) result.delete();
              throw error;
            }
            break;
          }
          case "mirror": {
            const body = ctx.body(f.bodyId, f),
              frame = mirrorFrame(ctx, p),
              plane = toPlane(frame);
            try {
              const sources: string[] = p.featureIds ?? [];
              let result = body;
              const step = (copy: r.Shape3D, op: ToolRecord["op"]) => {
                const next = booleanOp(result, copy, op, f.id);
                copy.delete();
                if (result !== body) result.delete();
                result = next;
              };
              try {
                if (sources.length)
                  for (const id of sources) {
                    const tool = ctx.tools.get(id);
                    if (!tool) throw Error(`${f.name}: a mirrored feature is suppressed or unavailable`);
                    for (const solid of tool.solids) step(copyOf(solid, solid.clone().mirror(plane), `${f.id}:m:`), tool.op);
                  }
                else step(copyOf(body, body.clone().mirror(plane), `${f.id}:m:`), "fuse");
                ctx.own(f.bodyId, result);
              } catch (error) {
                if (result !== body) result.delete();
                throw error;
              }
            } finally {
              plane.delete();
            }
            break;
          }
          case "boolean": {
            const body = ctx.body(f.bodyId, f),
              other = ctx.shapes.get(p.toolBodyId);
            if (!other) throw Error("Boolean tool body is unavailable");
            ctx.own(
              f.bodyId,
              booleanOp(body, other, p.operation === "union" ? "fuse" : p.operation === "subtract" ? "cut" : "common", f.id),
            );
            break;
          }
          case "shell": {
            const body = ctx.body(f.bodyId, f),
              faces = (p.faces as TopologyRef[]).map((ref) => resolve(body, ref) as r.Face);
            ctx.own(f.bodyId, shellShape(body, faces, p.thickness, f.id));
            break;
          }
          case "thread": {
            const body = ctx.body(f.bodyId, f),
              face = resolve(body, p.face as TopologyRef);
            if (!(face instanceof r.Face)) throw Error("select the cylindrical face to thread");
            const { shape, record } = threadOn(body, face, p, f.id);
            ctx.threads.push({ ...record, bodyId: f.bodyId, featureId: f.id, faceId: (p.face as TopologyRef).id });
            if (shape !== body) ctx.own(f.bodyId, shape);
            break;
          }
          case "moveFace": {
            const body = ctx.body(f.bodyId, f),
              faces = (p.faces as TopologyRef[]).map((ref) => resolve(body, ref) as r.Face);
            ctx.own(f.bodyId, moveFaceShape(body, faces, p.offset, f.id));
            break;
          }
          case "draft": {
            const body = ctx.body(f.bodyId, f),
              faces = (p.faces as TopologyRef[]).map((ref) => resolve(body, ref) as r.Face),
              neutral = ctx.planeRef(p.neutral);
            const pull = p.reverse ? mul(neutral.normal, -1) : neutral.normal;
            try {
              ctx.own(f.bodyId, draftShape(body, faces, p.angle, { ...neutral, normal: pull }, f.id));
            } catch {
              throw Error(`${f.name}: cannot draft the selected faces at ${p.angle}°.`);
            }
            break;
          }
          case "split": {
            const body = ctx.body(f.bodyId, f),
              frame = ctx.planeRef(p.plane),
              plane = toPlane(frame);
            try {
              const parts = body.split(plane);
              const positive = parts.positive as r.Shape3D | null,
                negative = parts.negative as r.Shape3D | null;
              parts.on?.delete();
              if (!positive || !negative)
                throw Error(`${f.name}: the plane does not cut through the body`);
              // The faces of each half lie on the faces of the body; the cut face is new.
              const onPlane = (face: r.Face) =>
                face.geomType === "PLANE" &&
                Math.abs(dot(sub(r.measureShapeSurfaceProperties(face).centerOfMass, frame.origin), frame.normal)) < 1e-6
                  ? `${f.id}:cut`
                  : undefined;
              for (const half of [positive, negative]) named(half, transferNames(half, [input(body)], f.id, onPlane));
              const keep = p.keep ?? "both";
              ctx.own(f.bodyId, keep === "negative" ? negative : positive);
              if (keep === "both" && p.newBodyId) ctx.own(p.newBodyId, negative);
              else (keep === "negative" ? positive : negative).delete();
            } finally {
              plane.delete();
            }
            break;
          }
          case "scale": {
            const body = ctx.body(f.bodyId, f);
            ctx.own(f.bodyId, copyOf(body, body.clone().scale(p.factor, p.center ?? [0, 0, 0]), ""));
            break;
          }
          case "sheet": {
            // The base flange is the profile at the sheet thickness.
            const solid = extrudeTool(ctx, { ...f, params: { sketchId: p.sketchId, distance: p.thickness, reverse: !!p.reverse, endType: "blind" } });
            record([solid], "fuse");
            ctx.own(f.bodyId, solid);
            break;
          }
          case "flange": {
            const body = ctx.body(f.bodyId, f);
            const flange = flangeTool(ctx, f, body);
            record([flange], "fuse");
            try {
              ctx.own(f.bodyId, booleanOp(body, flange, "fuse", f.id));
            } finally {
              flange.delete();
            }
            break;
          }
          case "corner": {
            ctx.own(f.bodyId, closeCorner(ctx, f, ctx.body(f.bodyId, f)));
            break;
          }
          case "bend": {
            const body = ctx.body(f.bodyId, f);
            ctx.own(f.bodyId, bendSheet(ctx, f, body));
            ctx.bends.push({ featureId: f.id, sketchId: f.params.sketchId, entityId: f.params.entityId, angle: f.params.angle, up: !f.params.flip });
            break;
          }
          case "member": {
            ctx.own(f.bodyId, memberSolid(ctx, f));
            break;
          }
          case "weld": {
            const body = ctx.body(f.bodyId, f),
              edges = (p.edges as TopologyRef[]).map((ref) => resolve(body, ref) as r.Edge);
            ctx.own(f.bodyId, weldBeads(body, edges, p.size, f.id));
            break;
          }
          case "gear": {
            const spec = { module: p.module, teeth: p.teeth, pressureAngle: p.pressureAngle ?? 20, backlash: p.backlash ?? 0 };
            const { root } = gearRadii(spec);
            if (p.bore && p.bore / 2 >= root - spec.module) throw Error(`the bore is too large for a gear with root diameter ${(2 * root).toFixed(2)}`);
            ctx.own(f.bodyId, drawnSolid(gearDrawing(spec, p.phase ?? 0), centered(ctx.planeRef(p.plane), p.center ?? [0, 0]), p.width, f.id, p.bore || undefined));
            ctx.drives.set(f.bodyId, { teeth: p.teeth, module: p.module, width: p.width, backlash: spec.backlash });
            break;
          }
          case "pulley": {
            const belt = belts[p.belt as BeltType];
            if (!belt) throw Error("unknown belt type");
            const pitchRadius = (p.teeth * belt.pitch) / (2 * Math.PI),
              outside = pitchRadius - belt.pld;
            ctx.drives.set(f.bodyId, { teeth: p.teeth });
            // Grooves as circles on the outside diameter, one per belt tooth.
            let profile = r.drawCircle(outside);
            for (let k = 0; k < p.teeth; k++) {
              const a = (k * TAU) / p.teeth;
              profile = profile.cut(r.drawCircle(belt.groove).translate(outside * Math.cos(a), outside * Math.sin(a)));
            }
            const frame = centered(ctx.planeRef(p.plane), p.center ?? [0, 0]);
            if (p.bore && p.bore / 2 >= outside - belt.groove - 1) throw Error("the bore is too large for this pulley");
            let solid = drawnSolid(profile, frame, p.width, f.id, p.bore || undefined);
            if (p.flanges) {
              // Flanges either side keep the belt on.
              const fd = p.flangeDiameter ?? 2 * outside + 4,
                ft = p.flangeThickness ?? 1;
              for (const at of [-ft, p.width]) {
                const flange = drawnSolid(r.drawCircle(fd / 2), { ...frame, origin: add(frame.origin, mul(frame.normal, at)) }, ft, `${f.id}:flange${at < 0 ? 0 : 1}`, p.bore || undefined);
                solid = booleanOp(solid, flange, "fuse", f.id);
              }
            }
            ctx.own(f.bodyId, solid);
            break;
          }
          case "rib": {
            const body = ctx.body(f.bodyId, f);
            const rib = ribTool(ctx, f, body);
            record([rib], "fuse");
            try {
              ctx.own(f.bodyId, booleanOp(body, rib, "fuse", f.id));
            } finally {
              rib.delete();
            }
            break;
          }
          case "import": {
            const bytes = doc.blobs?.[p.blob];
            if (!bytes) throw Error("the imported file is unavailable");
            // Files never change, so the parsed solid is cached by content and scale.
            const key = `${p.blob}:${p.format ?? "step"}:${p.scale ?? 1}`;
            let cached = importCache.get(key);
            if (!cached) {
              let shape: r.AnyShape;
              let colors=new Map<number,string>();
              if (p.format === "stl") shape = stlSolid(bytes, p.scale ?? 1);
              else
                try {
                  ({shape,faceColors:colors}=await importColoredStep(bytes));
                } catch {
                  throw Error("the file could not be read as STEP");
                }
              const solids = shape instanceof r.Solid ? [shape as r.Shape3D] : r.isShape3D(shape) ? shape.solids : [];
              if (!solids.length) throw Error(`the ${p.format === "stl" ? "STL" : "STEP"} file has no solid bodies`);
              cached = {shape:solids.length === 1 ? solids[0].clone() : (r.makeCompound(solids.map((x) => x.clone())) as unknown as r.Shape3D),colors};
              shape.delete();
              importCache.set(key, cached);
              for (const old of [...importCache.keys()].slice(0, Math.max(0, importCache.size - 8))) {
                importCache.get(old)!.shape.delete();
                importCache.delete(old);
              }
            } else {
              importCache.delete(key);
              importCache.set(key, cached);
            }
            const solid = cached.shape.clone();
            // The file never changes, so face order is a stable identity.
            const names: Names = new Map();
            solid.faces.forEach((face, i) => names.set(face.hashCode, `${f.id}:f${i}`));
            ctx.own(f.bodyId, named(solid, names));
            break;
          }
          case "transform": {
            const body = ctx.body(f.bodyId, f);
            const moved = body
              .clone()
              .rotate(p.angle ?? 0, p.rotationOrigin ?? [0, 0, 0], p.axis ?? [0, 0, 1])
              .translate(p.translation);
            if (p.copy && p.newBodyId) ctx.own(p.newBodyId, copyOf(body, moved, `${f.id}:copy:`));
            else ctx.own(f.bodyId, copyOf(body, moved, ""));
            break;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw Error(message.startsWith(f.name) ? message : `${f.name}: ${message}`);
      }
      // Every body this feature touched carries names; anything unnamed is new geometry.
      for (const id of [f.bodyId, p.newBodyId].filter(Boolean)) {
        const current = ctx.shapes.get(id);
        if (current && !shapeNames.has(current)) named(current, transferNames(current, [], f.id));
      }
      for (const id of [f.bodyId, p.newBodyId].filter(Boolean)) {
        const current = ctx.shapes.get(id);
        if (!current) continue;
        if (current.isNull || !current.solids.length || r.measureVolume(current) <= 1e-8)
          throw Error(`${f.name} did not produce a valid solid`);
        // Imported files keep their own tolerances; features built on them are checked.
        if (f.type === "import") continue;
        const check = new (r.getOC().BRepCheck_Analyzer)(current.wrapped, true);
        try {
          if (!check.IsValid())
            throw Error(
              `${f.name}: the resulting solid has invalid topology or surfaces. Change the feature parameters.`,
            );
        } finally {
          check.delete();
        }
      }
    }
    // Placement of everything the editor shows in place, including unused sketches.
    for (const s of doc.sketches)
      try {
        ctx.sketchFrame(s);
        ctx.sketch(s.id);
      } catch (e) {
        ctx.warnings.push((e as Error).message.startsWith(s.name) ? (e as Error).message : `${s.name}: ${(e as Error).message}`);
      }
    for (const plane of doc.referencePlanes ?? [])
      try {
        ctx.referencePlane(plane.id);
      } catch (e) {
        ctx.warnings.push(`${plane.name}: ${(e as Error).message}`);
      }
    return ctx;
  } catch (error) {
    ctx.dispose();
    for (const s of ctx.shapes.values()) s.delete();
    throw error;
  }
}
export async function buildShapes(doc: Document): Promise<Map<string, r.Shape3D>> {
  const ctx = await buildModel(doc);
  ctx.dispose();
  return ctx.shapes;
}
/**
 * Principal moments of inertia (unit density) from moments about six axes
 * through the center of mass; the kernel's inertia matrix itself is not exposed.
 */
function principalMoments(properties: any, center: Vec3): [number, number, number] {
  const [xx, yy, zz, xy, yz, xz] = inertiaTensor(properties, center);
  return eigenvalues([
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ]);
}
/** Inertia tensor (unit density) about axes through `center`: xx, yy, zz, xy, yz, xz matrix entries. */
function inertiaTensor(properties: any, center: Vec3): Tensor {
  const oc = r.getOC() as any,
    g = properties._wrapped ?? properties.wrapped;
  const about = (d: Vec3) => {
    const origin = new oc.gp_Pnt(...center),
      dir = new oc.gp_Dir(...d),
      axis = new oc.gp_Ax1(origin, dir);
    try {
      return g.MomentOfInertia(axis) as number;
    } finally {
      axis.delete();
      dir.delete();
      origin.delete();
    }
  };
  const h = Math.SQRT1_2;
  const xx = about([1, 0, 0]),
    yy = about([0, 1, 0]),
    zz = about([0, 0, 1]);
  // n·I·n for n on a diagonal gives the off-diagonal entries.
  const xy = about([h, h, 0]) - (xx + yy) / 2,
    yz = about([0, h, h]) - (yy + zz) / 2,
    xz = about([h, 0, h]) - (xx + zz) / 2;
  return [xx, yy, zz, xy, yz, xz];
}
export async function rebuild(doc: Document): Promise<Geometry> {
  const ctx = await buildModel(doc);
  ctx.dispose();
  const shapes = ctx.shapes;
  try {
    const bodies: RenderBody[] = [];
    // Mass of a solid (g): the typed-in part mass spread over the visible solids,
    // printed walls around a partly filled interior, or solid material.
    const suppressed = suppressedBodies(doc);
    const shown = [...shapes].filter(([id]) => !suppressed.has(id) && doc.bodies.some((b) => b.id === id && !b.hidden));
    const shownVolume = shown.reduce((sum, [, shape]) => sum + r.measureVolume(shape), 0);
    const material = doc.material;
    const massOf = (shape: r.Shape3D): number | undefined =>
      doc.massOverride !== undefined
        ? (doc.massOverride * r.measureVolume(shape)) / Math.max(1e-9, shownVolume)
        : material?.printed
          ? printedMass(r.measureVolume(shape), r.measureArea(shape), material.density, (material.infill ?? 100) / 100, material.wall ?? defaultPrintWall)
          : material
            ? (r.measureVolume(shape) * material.density) / 1000
            : undefined;
    for (const [id, shape] of shapes) {
      const body = doc.bodies.find((b) => b.id === id);
      if (!body || suppressed.has(id)) continue;
      const topology = topologies(id, shape),
        names = namesOf(shape);
      for (const face of shape.faces) {
        const tid = topology.hashes.get(face.hashCode),
          t = tid && topology.metadata.find((x) => x.id === tid),
          name = names.get(face.hashCode);
        if (t && name) t.featureId = ownerOf(name);
      }
      const sourceColors=new Map<string,string>();
      if(body.importAppearance) for(const feature of doc.features.filter(f=>f.type==="import"&&f.bodyId===id)) {
        const p=feature.params as any, cached=importCache.get(`${p.blob}:${p.format ?? "step"}:${p.scale ?? 1}`);
        cached?.shape.faces.forEach((face,i)=>{const c=cached.colors.get(face.hashCode);if(c)sourceColors.set(`${feature.id}:f${i}`,c);});
      }
      const mesh = shape.mesh({ tolerance: 0.05, angularTolerance: 0.15 }),
        allEdges = shape.meshEdges({ tolerance: 0.05, angularTolerance: 0.15 });
      // Seam edges (where a cylinder or other closed surface wraps round) and joints between two
      // faces of one surface are not model edges; like other CAD systems, they are never drawn.
      const seams = seamEdges(shape, topology),
        edges = { ...allEdges, edgeGroups: allEdges.edgeGroups.filter((g) => !seams.has(g.edgeId)) },
        tangent = tangentEdgeIds(shape, topology, seams);
      const properties = r.measureShapeVolumeProperties(shape);
      const mass = massOf(shape),
        density = mass === undefined ? 0 : mass / Math.max(1e-12, r.measureVolume(shape));
      bodies.push({
        id,
        name: body.name,
        ...displayed(
          doc.components?.find((c) => c.bodyIds.includes(id)),
          {
            color: body.color,
            hidden: body.hidden,
            ...(body.opacity !== undefined ? { opacity: body.opacity } : {}),
            ...(body.style ? { style: body.style } : {}),
            ...(body.texture ? { texture: body.texture } : {}),
          },
        ),
        mesh: {
          ...mesh,
          faceGroups: mesh.faceGroups.map((g) => ({
            ...g,
            id: topology.hashes.get(g.faceId)!,
            ...(sourceColors.has(names.get(g.faceId) ?? "") ? {color:sourceColors.get(names.get(g.faceId)!)} : {}),
          })),
        },
        edges: {
          ...edges,
          edgeGroups: edges.edgeGroups.map((g) => ({
            ...g,
            id: topology.hashes.get(g.edgeId)!,
          })),
        },
        topology: topology.metadata,
        ...(tangent.length ? { tangentEdges: tangent } : {}),
        ...(ctx.threads.some((t) => t.bodyId === id) ? { threads: ctx.threads.filter((t) => t.bodyId === id) } : {}),
        ...(ctx.drives.has(id) ? { drive: ctx.drives.get(id) } : {}),
        bounds: shape.boundingBox.bounds,
        volume: r.measureVolume(shape),
        surfaceArea: r.measureArea(shape),
        centerOfMass: properties.centerOfMass,
        ...(mass !== undefined
          ? {
              mass,
              ...(doc.material ? { material: doc.material.name } : {}),
              massSource: doc.massOverride !== undefined ? ("override" as const) : ("material" as const),
              // g·mm² about the principal axes through the center of mass, the
              // solid taken as evenly dense at its average density.
              inertia: principalMoments(properties, properties.centerOfMass).map((m) => m * density) as [number, number, number],
              inertiaTensor: inertiaTensor(properties, properties.centerOfMass).map((m) => m * density) as Tensor,
            }
          : {}),
      });
      properties.delete();
    }
    bodies.push(...(await instanceBodies(doc)));
    const geometry = placeGeometry(doc, {
      bodies,
      warnings: [
        ...doc.sketches
          .filter((s) => s.solver.dof > 0)
          .map((s) => `${s.name}: ${s.solver.dof} degrees of freedom`),
        ...ctx.warnings,
      ],
    });
    // Belts follow their pulleys: built in place once the assembly is solved.
    for (const c of doc.components ?? []) {
      if (!c.belt || c.suppressed || c.belt.pulleys.some((p) => doc.components?.find((x) => x.id === p)?.suppressed)) continue;
      const belt = await beltSolid(doc, c, geometry.placements!);
      try {
        const id = `${c.id}/belt`;
        geometry.bodies.push({ ...renderSolid(id, belt.name, "#70798C", belt.shape, beltDensity), ...displayed(c, { color: "#70798C", hidden: false }) });
        geometry.placements![id] = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
        if (belt.warning) geometry.warnings.push(belt.warning);
      } finally {
        belt.shape.delete();
      }
    }
    geometry.frames = {
      sketches: Object.fromEntries(ctx.sketchFrames),
      planes: Object.fromEntries(ctx.planeFrames),
    };
    if (Object.keys(ctx.sketchUpdates).length) geometry.sketchUpdates = ctx.sketchUpdates;
    return geometry;
  } finally {
    for (const s of shapes.values()) s.delete();
  }
}
/**
 * Model edges (or every edge of the given faces) projected into a sketch, for
 * Convert Entities. Edges that project to a point and duplicate projections
 * of a face's boundary are skipped.
 */
export async function projectEdges(doc: Document, sketchId: string, refs: TopologyRef[]) {
  const ctx = await buildModel(doc);
  try {
    const s = ctx.sketch(sketchId),
      frame = ctx.sketchFrame(s);
    const out: { ref: TopologyRef; type: "line" | "circle" | "arc"; values: Record<string, number> }[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const body = ctx.shapes.get(ref.bodyId);
      if (!body) throw Error("Convert edges of this document's bodies");
      const item = resolve(body, ref);
      const set = topologies(ref.bodyId, body);
      const edges = item instanceof r.Face ? item.edges : [item as r.Edge];
      for (const edge of edges) {
        const id = set.hashes.get(edge.hashCode);
        if (!id || seen.has(id)) continue;
        let projected;
        try {
          projected = projectEdge(edge, frame);
        } catch (error) {
          if (item instanceof r.Face) continue;
          throw error;
        }
        const key = `${projected.type}:${Object.values(projected.values).map((v) => v.toFixed(6)).join(",")}`;
        if (seen.has(key)) continue;
        seen.add(id);
        seen.add(key);
        out.push({ ref: { id, bodyId: ref.bodyId, kind: "edge", geomType: edge.geomType }, ...projected });
      }
    }
    if (!out.length) throw Error("Nothing to convert: pick edges or faces whose edges lie parallel to the sketch");
    return out;
  } finally {
    ctx.dispose();
    for (const shape of ctx.shapes.values()) shape.delete();
  }
}

/**
 * Flat pattern of a sheet metal body: the base face as built (with any holes
 * cut through it) plus each edge flange unrolled outward by its bend allowance
 * θ(R + K·T) and straight length. Coordinates are in the base sketch plane.
 */
async function flatShape(doc: Document, bodyId: string) {
  const base = doc.features.find((f) => f.type === "sheet" && f.bodyId === bodyId && !f.suppressed);
  if (!base) throw Error("This body is not sheet metal; start it with a base flange");
  // Sketched bends unroll by taking the sheet as it was before the first one;
  // holes, cuts and flanges must come before them.
  const bendFeatures = doc.features.filter((f) => f.type === "bend" && !f.suppressed && f.bodyId === bodyId),
    firstBend = bendFeatures.length ? doc.features.indexOf(bendFeatures[0]) : -1;
  if (firstBend >= 0) {
    const later = doc.features.slice(firstBend).find((f) => f.type !== "bend" && !f.suppressed && f.bodyId === bodyId);
    if (later) throw Error(`${later.name}: the flat pattern needs holes, cuts and flanges made before the sketched bends`);
  }
  const ctx = await buildModel(firstBend >= 0 ? { ...doc, features: doc.features.map((f) => (f.type === "bend" ? { ...f, suppressed: true } : f)) } : doc);
  const created: r.AnyShape[] = [];
  try {
    const body = ctx.shapes.get(bodyId);
    if (!body) throw Error("Sheet metal body is unavailable");
    const T = base.params.thickness as number,
      K = (base.params.kFactor as number) ?? 0.44;
    const frame = ctx.sketchFrame(ctx.sketch(base.params.sketchId));
    // Flat coordinates match the kernel transform below: y = normal × x.
    const yAxis = cross(frame.normal, frame.xDir);
    const toLocal = (q: Vec3): [number, number] => [dot(sub(q, frame.origin), frame.xDir), dot(sub(q, frame.origin), yAxis)];
    const height = (q: Vec3) => dot(sub(q, frame.origin), frame.normal);
    // The base face: the largest planar face lying on either sheet face plane.
    const baseFaces = body.faces.filter((face) => {
      if (face.geomType !== "PLANE" || Math.abs(Math.abs(dot(unit(face.normalAt().toTuple()), frame.normal)) - 1) > 1e-6) return false;
      const h = height(r.measureShapeSurfaceProperties(face).centerOfMass);
      return Math.abs(h) < 1e-6 || Math.abs(Math.abs(h) - T) < 1e-6;
    });
    if (!baseFaces.length) throw Error("The base flange face is no longer flat; the flat pattern needs it");
    baseFaces.sort((a, b) => r.measureArea(b) - r.measureArea(a));
    const flat = (q: Vec3): Vec3 => [...toLocal(q), 0];
    // The base face, exact (arcs, holes), moved into the flat XY plane.
    const oc = r.getOC() as any;
    const origin = new oc.gp_Pnt(...frame.origin),
      zDir = new oc.gp_Dir(...frame.normal),
      xDir = new oc.gp_Dir(...frame.xDir),
      ax3 = new oc.gp_Ax3(origin, zDir, xDir),
      trsf = new oc.gp_Trsf();
    trsf.SetTransformation(ax3);
    const moved = new oc.BRepBuilderAPI_Transform(baseFaces[0].wrapped, trsf, true);
    let shape: r.AnyShape = r.cast(moved.Shape());
    moved.delete();
    [trsf, ax3, xDir, zDir, origin].forEach((x) => x.delete());
    const lift = shape.boundingBox.bounds[0][2];
    if (Math.abs(lift) > 1e-9) shape = shape.translate([0, 0, -lift]);
    created.push(shape);
    const bends: { a: [number, number]; b: [number, number]; label: string }[] = [];
    // Each flange's strip in the flat: its start edge, outward direction and depth.
    const strips = new Map<string, { a: Vec3; b: Vec3; out: Vec3; depth: number; e3: Vec3; A3: Vec3 }>();
    // A flange's bend direction with every parent bend undone, to label it UP or DOWN.
    const unfolded = (id: string, v: Vec3): Vec3 => {
      const fl = ctx.flanges.get(id)!;
      if (!fl.parent) return v;
      const p = ctx.flanges.get(fl.parent)!;
      return unfolded(fl.parent, rotateAbout(v, cross(p.m, p.up), (-p.angle * Math.PI) / 180));
    };
    for (const [featureId, fl] of ctx.flanges) {
      if (fl.bodyId !== bodyId) continue;
      const feature = doc.features.find((x) => x.id === featureId)!;
      const ba = ((fl.angle * Math.PI) / 180) * (fl.R + K * fl.T),
        depth = ba + Math.max(0, fl.straight);
      let a: Vec3, b: Vec3, out: Vec3;
      const parent = fl.parent ? strips.get(fl.parent) : undefined;
      if (parent) {
        // On the end of another flange: the far edge of that flange's strip.
        const e3 = unit(sub(fl.B, fl.A));
        if (Math.abs(Math.abs(dot(e3, parent.e3)) - 1) > 1e-6) throw Error(`${feature.name}: the flat pattern unrolls flanges on the end of a flange`);
        const along = unit(sub(parent.b, parent.a)),
          mapped = (q: Vec3) => add(add(parent.a, mul(along, dot(sub(q, parent.A3), parent.e3))), mul(parent.out, parent.depth));
        a = mapped(fl.A);
        b = mapped(fl.B);
        out = parent.out;
      } else {
        if (!(Math.abs(height(fl.A)) < 1e-6 || Math.abs(Math.abs(height(fl.A)) - T) < 1e-6))
          throw Error(`${feature.name}: the flat pattern unrolls flanges on the base flange's outline or on flange ends`);
        a = flat(fl.A);
        b = flat(fl.B);
        out = [dot(fl.m, frame.xDir), dot(fl.m, yAxis), 0];
      }
      strips.set(featureId, { a, b, out, depth, e3: unit(sub(fl.B, fl.A)), A3: fl.A });
      const flatAlong = unit(sub(b, a));
      // The strip, and its wall carried past either end by a closed corner (beyond the bend zone).
      const pieces = [[a, b, add(b, mul(out, depth)), add(a, mul(out, depth))]];
      for (const [end, from, way] of [
        ["A", a, -1],
        ["B", b, 1],
      ] as const) {
        const L = fl.extend?.[end];
        if (!L) continue;
        const start = add(from, mul(out, ba)),
          past = mul(flatAlong, way * L);
        pieces.push([start, add(start, past), add(add(start, past), mul(out, depth - ba)), add(start, mul(out, depth - ba))]);
      }
      for (const piece of pieces) {
        const strip = r.makePolygon(piece);
        const fused = new oc.BRepAlgoAPI_Fuse(shape.wrapped, strip.wrapped);
        fused.Build();
        fused.SimplifyResult(true, true, 1e-6);
        shape = r.cast(fused.Shape());
        fused.delete();
        created.push(strip, shape);
      }
      const c1 = add(a, mul(out, ba / 2)),
        c2 = add(b, mul(out, ba / 2));
      bends.push({
        a: [c1[0], c1[1]],
        b: [c2[0], c2[1]],
        label: `${dot(unfolded(featureId, fl.up), frame.normal) >= 0 ? "UP" : "DOWN"} ${Math.round(fl.angle * 100) / 100}° R${Math.round(fl.R * 1000) / 1000}`,
      });
    }
    // Each sketched bend's line, clipped to the blank.
    const outline = bendFeatures.length ? flatSegments(shape) : [];
    for (const f of bendFeatures) {
      const s = ctx.sketch(f.params.sketchId),
        line = s.entities.find((e) => e.id === f.params.entityId);
      if (!line) continue;
      const sf = ctx.sketchFrame(s),
        p1 = toLocal(framePoint(sf, [line.values.x1, line.values.y1])),
        p2 = toLocal(framePoint(sf, [line.values.x2, line.values.y2]));
      const d: [number, number] = [p2[0] - p1[0], p2[1] - p1[1]];
      const hits: number[] = [];
      for (const [a, b] of outline) {
        const r2: [number, number] = [b[0] - a[0], b[1] - a[1]],
          den = d[0] * r2[1] - d[1] * r2[0];
        if (Math.abs(den) < 1e-12) continue;
        const t = ((a[0] - p1[0]) * r2[1] - (a[1] - p1[1]) * r2[0]) / den,
          w = ((a[0] - p1[0]) * d[1] - (a[1] - p1[1]) * d[0]) / den;
        if (w >= -1e-9 && w <= 1 + 1e-9) hits.push(t);
      }
      if (hits.length < 2) continue;
      const lo = Math.min(...hits),
        hi = Math.max(...hits);
      bends.push({
        a: [p1[0] + d[0] * lo, p1[1] + d[1] * lo],
        b: [p1[0] + d[0] * hi, p1[1] + d[1] * hi],
        label: `${f.params.flip ? "DOWN" : "UP"} ${Math.round(f.params.angle * 100) / 100}° R${Math.round((f.params.bendRadius ?? base.params.bendRadius) * 1000) / 1000}`,
      });
    }
    // The unrolled shape outlives the build; everything else is released.
    created.splice(created.indexOf(shape), 1);
    return { shape, bends, thickness: T };
  } finally {
    for (const shape of created) shape.delete();
    ctx.dispose();
    for (const shape of ctx.shapes.values()) shape.delete();
  }
}
/** Cut edges of an unrolled shape; seams between the base and a flange bound two faces and are not cut. */
function flatSegments(shape: r.AnyShape) {
    const faceCount = new Map<number, number>();
    for (const face of (shape as any).faces as r.Face[]) for (const edge of face.edges) faceCount.set(edge.hashCode, (faceCount.get(edge.hashCode) ?? 0) + 1);
    const segments: [[number, number], [number, number]][] = [];
    for (const edge of (shape as any).edges as r.Edge[]) {
      if ((faceCount.get(edge.hashCode) ?? 0) > 1) continue;
      const n = edge.geomType === "LINE" ? 1 : 32;
      for (let i = 0; i < n; i++) {
        const a = edge.pointAt(i / n).toTuple(),
          b = edge.pointAt((i + 1) / n).toTuple();
        segments.push([[a[0], a[1]], [b[0], b[1]]]);
      }
    }
    return segments;
}
export async function flatPattern(doc: Document, bodyId: string) {
  const { shape, bends, thickness } = await flatShape(doc, bodyId);
  try {
    const segments = flatSegments(shape);
    const xs = segments.flatMap((s) => [s[0][0], s[1][0]]),
      ys = segments.flatMap((s) => [s[0][1], s[1][1]]);
    return {
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number],
      segments,
      bends,
      thickness,
    };
  } finally {
    shape.delete();
  }
}

// ---------------------------------------------------------------------------
// Inserted parts

/** Identity of a document and, recursively, of the parts it inserts. */
function linkKey(doc: Document, linked = doc.linked ?? {}, path: string[] = []): string {
  const parts = (doc.components ?? []).flatMap((c) => {
    const source = c.source && linked[c.source.documentId];
    return source && !path.includes(source.id) ? [linkKey(source, linked, [...path, doc.id])] : [];
  });
  return `${doc.id}@${doc.revision}(${parts.sort().join(",")})`;
}
const instanceGeometry = new Map<string, Geometry>();
function insertedPart(doc: Document, c: Component): Document {
  const source = c.source && doc.linked?.[c.source.documentId];
  if (!source) throw Error(`The part inserted as ${c.name} is unavailable`);
  return { ...source, linked: doc.linked };
}
type Shown = Pick<RenderBody, "color" | "hidden" | "opacity" | "style" | "texture">;
/** A body as its component shows it: the component's appearance, transparency, display mode and visibility over the body's own. */
function displayed(c: Component | undefined, body: Shown): Shown {
  const d = c?.display;
  const opacity = Math.min(body.opacity ?? 1, d?.opacity ?? 1),
    style = d?.style ?? body.style,
    // A component color without a texture of its own replaces the part's look entirely.
    texture = d?.texture ?? (d?.color ? undefined : body.texture);
  return {
    color: d?.color ?? body.color,
    hidden: body.hidden || !!d?.hidden,
    ...(opacity < 1 ? { opacity } : {}),
    ...(style ? { style } : {}),
    ...(texture ? { texture } : {}),
  };
}
/** Bodies of the document's own components that are suppressed. */
const suppressedBodies = (doc: Document) => new Set((doc.components ?? []).filter((c) => c.suppressed).flatMap((c) => c.bodyIds));
/** An inserted part's own geometry, rebuilt once per revision. */
async function partGeometry(source: Document) {
  const key = linkKey(source);
  let geometry = instanceGeometry.get(key);
  if (!geometry) {
    geometry = await rebuild(source);
    instanceGeometry.set(key, geometry);
    if (instanceGeometry.size > 32) instanceGeometry.delete(instanceGeometry.keys().next().value!);
  }
  return geometry;
}
/** Generated belts: neoprene over glass-fiber cords, about 1.25 g/cm³. */
const beltDensity = 1.25;
/**
 * A timing belt over two pulley components, in assembly coordinates, from
 * where the solved assembly puts the pulleys. Sized to the nearest whole
 * number of teeth; a warning gives the center distance that belt needs when
 * the pulleys are elsewhere.
 */
async function beltSolid(doc: Document, c: Component, placements: Record<string, Placement>) {
  const pulleys = await Promise.all(
    c.belt!.pulleys.map(async (cid) => {
      const comp = allComponents(doc).find((x) => x.id === cid);
      if (!comp?.source) throw Error(`${c.name}: its pulleys must be inserted pulley parts`);
      const source = insertedPart(doc, comp),
        feature = source.features.find((f) => f.type === "pulley" && !f.suppressed);
      if (!feature) throw Error(`${c.name}: ${comp.name} is not a timing pulley`);
      const body = (await partGeometry(source)).bodies.find((b) => b.id === feature.bodyId);
      if (!body) throw Error(`${c.name}: ${comp.name} has no pulley body`);
      // The shaft: square to the pulley's largest flat face, through its center of mass.
      const end = body.topology.filter((t) => t.kind === "face" && t.geomType === "PLANE" && t.normal).sort((x, y) => (y.area ?? 0) - (x.area ?? 0))[0];
      const p = placements[`${comp.id}/${body.id}`] ?? { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
      const type = feature.params.belt as BeltType,
        belt = belts[type];
      return { name: comp.name, center: placedPoint(body.centerOfMass, p), axis: unit(placedDirection(end.normal!, p)), type, belt, width: feature.params.width as number, pitchRadius: ((feature.params.teeth as number) * belt.pitch) / (2 * Math.PI) };
    }),
  );
  const [a, b] = pulleys;
  if (a.type !== b.type) throw Error(`${c.name}: the pulleys take different belts (${a.type} and ${b.type})`);
  if (Math.abs(Math.abs(dot(a.axis, b.axis)) - 1) > 1e-6) throw Error(`${c.name}: the pulley shafts must be parallel`);
  const d = sub(b.center, a.center),
    offset = dot(d, a.axis);
  if (Math.abs(offset) > 0.5) throw Error(`${c.name}: the pulleys are ${Math.abs(offset).toFixed(2)} mm out of line; align their mid-planes`);
  const inPlane = sub(d, mul(a.axis, offset)),
    center = length(inPlane);
  const belt = a.belt,
    pitchLength = beltLength(a.pitchRadius, b.pitchRadius, center),
    teeth = Math.round(pitchLength / belt.pitch),
    exact = centerFor(a.pitchRadius, b.pitchRadius, teeth * belt.pitch);
  const width = c.belt!.width ?? Math.max(1, Math.min(a.width, b.width) - 1);
  // The belt sits on the pulleys' outside diameter, one belt thickness deep, centered on the first pulley's mid-plane.
  const loop = (r1: number, r2: number) => {
    const { lines, arcs } = beltLoop(r1, r2, center);
    return r
      .draw(lines[0][0])
      .lineTo(lines[0][1])
      .threePointsArcTo(arcs[1][0], arcs[1][1])
      .lineTo(lines[1][1])
      .threePointsArcTo(arcs[0][0], arcs[0][1])
      .close();
  };
  const inner = [a.pitchRadius - belt.pld, b.pitchRadius - belt.pld];
  const plane = new r.Plane(sub(a.center, mul(a.axis, width / 2)), unit(inPlane), a.axis);
  try {
    const profile = loop(inner[0] + belt.thickness, inner[1] + belt.thickness).cut(loop(inner[0], inner[1]));
    const solid = (profile.sketchOnPlane(plane) as r.Sketch).extrude(width) as r.Shape3D;
    const shape = named(solid, new Map(solid.faces.map((face, i) => [face.hashCode, `${c.id}:belt:f${i}`])));
    const name = `${a.type} belt ${teeth}T ${Math.round(teeth * belt.pitch)} mm`;
    const warning =
      Math.abs(center - exact) > 0.05 ? `${c.name}: the pulleys are ${center.toFixed(2)} mm apart; a ${teeth}-tooth belt needs ${exact.toFixed(2)} mm` : undefined;
    return { shape, name, warning };
  } finally {
    plane.delete();
  }
}
/** A generated solid as a render body: mesh, edges, topology and mass from a density (g/cm³). */
function renderSolid(id: string, name: string, color: string, shape: r.Shape3D, density: number): RenderBody {
  const topology = topologies(id, shape);
  const mesh = shape.mesh({ tolerance: 0.05, angularTolerance: 0.15 }),
    allEdges = shape.meshEdges({ tolerance: 0.05, angularTolerance: 0.15 }),
    seams = seamEdges(shape, topology);
  const properties = r.measureShapeVolumeProperties(shape);
  try {
    const volume = r.measureVolume(shape),
      perMm3 = density / 1000;
    return {
      id,
      name,
      color,
      hidden: false,
      mesh: { ...mesh, faceGroups: mesh.faceGroups.map((g) => ({ ...g, id: topology.hashes.get(g.faceId)! })) },
      edges: { ...allEdges, edgeGroups: allEdges.edgeGroups.filter((g) => !seams.has(g.edgeId)).map((g) => ({ ...g, id: topology.hashes.get(g.edgeId)! })) },
      topology: topology.metadata,
      ...((tangent) => (tangent.length ? { tangentEdges: tangent } : {}))(tangentEdgeIds(shape, topology, seams)),
      bounds: shape.boundingBox.bounds,
      volume,
      surfaceArea: r.measureArea(shape),
      centerOfMass: properties.centerOfMass,
      mass: volume * perMm3,
      massSource: "material",
      inertia: principalMoments(properties, properties.centerOfMass).map((m) => m * perMm3) as [number, number, number],
      inertiaTensor: inertiaTensor(properties, properties.centerOfMass).map((m) => m * perMm3) as Tensor,
    };
  } finally {
    properties.delete();
  }
}
/** Bodies of inserted parts, as instances named `${component}/${body}`. */
async function instanceBodies(doc: Document): Promise<RenderBody[]> {
  const out: RenderBody[] = [];
  for (const c of allComponents(doc)) {
    if (!c.source || c.suppressed) continue;
    const geometry = await partGeometry(insertedPart(doc, c));
    const visible = geometry.bodies.filter((b) => !b.hidden);
    const prefix = `${c.id}/`;
    for (const b of visible) {
      const copy = structuredClone(b);
      // The component's look decides whether the part's texture shows.
      const { texture: _texture, ...own } = copy;
      out.push({
        ...own,
        ...displayed(c, copy),
        id: prefix + b.id,
        name: visible.length > 1 ? `${c.name} · ${b.name}` : c.name,
        mesh: { ...copy.mesh, faceGroups: copy.mesh.faceGroups.map(({color,...g}) => ({ ...g, ...(color && !c.display?.color && !c.display?.texture ? {color} : {}), id: prefix + g.id })) },
        edges: { ...copy.edges, edgeGroups: copy.edges.edgeGroups.map((g) => ({ ...g, id: prefix + g.id })) },
        // Features of the part are edited in the part document.
        topology: copy.topology.map(({ featureId: _, ...t }) => ({ ...t, id: prefix + t.id, bodyId: prefix + t.bodyId })),
        ...(copy.threads ? { threads: copy.threads.map((t) => ({ ...t, bodyId: prefix + t.bodyId, faceId: prefix + t.faceId })) } : {}),
        ...(copy.tangentEdges ? { tangentEdges: copy.tangentEdges.map((id) => prefix + id) } : {}),
      });
    }
  }
  return out;
}
/** Solids of inserted parts, placed as in their own document and named per instance. */
async function instanceShapes(doc: Document, shapes: Map<string, r.Shape3D>) {
  const built = new Map<string, Map<string, r.Shape3D>>();
  try {
    for (const c of allComponents(doc)) {
      if (!c.source || c.suppressed) continue;
      const source = insertedPart(doc, c);
      let placed = built.get(source.id);
      if (!placed) {
        placed = await buildPlacedShapes(source);
        built.set(source.id, placed);
      }
      for (const [bodyId, shape] of placed)
        if (!source.bodies.find((b) => b.id === bodyId)?.hidden)
          shapes.set(`${c.id}/${bodyId}`, named(shape.clone(), namesOf(shape)));
    }
  } finally {
    for (const placed of built.values()) for (const shape of placed.values()) shape.delete();
  }
}
/** Display name of a body of this document or of an inserted part. */
function bodyName(doc: Document, id: string): string | undefined {
  const own = doc.bodies.find((b) => b.id === id);
  if (own) return own.name;
  const c = componentOf(doc, id);
  return c?.name;
}
const bodyHidden = (doc: Document, id: string) => !!doc.bodies.find((b) => b.id === id)?.hidden || !!componentOf(doc, id)?.display?.hidden;

export async function exportModel(
  doc: Document,
  format: "step" | "stl" | "json",
  bodyId?: string,
) {
  if (format === "json")
    return {
      bytes: new TextEncoder().encode(JSON.stringify(doc, null, 2)),
      mime: "application/json",
    };
  const shapes = await buildPlacedShapes(doc);
  try {
    const selected = bodyId
      ? ([shapes.get(bodyId)].filter(Boolean) as r.Shape3D[])
      : [...shapes.entries()]
          .filter(([id]) => !bodyHidden(doc, id))
          .map(([, shape]) => shape);
    if (!selected.length) throw Error("No solids to export");
    let compound: r.AnyShape | undefined;
    const blob =
      format === "step"
        ? r.exportSTEP(
            selected.map((shape, i) => ({
              shape,
              name: bodyName(doc, [...shapes.entries()].find(([, s]) => s === shape)?.[0] ?? "") ?? `Part ${i + 1}`,
            })),
            { unit: "MM", modelUnit: "MM" },
          )
        : (compound = r.makeCompound(selected)).blobSTL({
            binary: true,
            tolerance: 0.05,
            angularTolerance: 0.1,
          });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    compound?.delete();
    return {
      bytes,
      mime: format === "step" ? "application/step" : "model/stl",
    };
  } finally {
    for (const s of shapes.values()) s.delete();
  }
}
export type OutlineEntity =
  | { kind: "line"; a: Vec2; b: Vec2 }
  | { kind: "circle"; center: Vec2; radius: number }
  /** Counter-clockwise from start to end angle, in degrees. */
  | { kind: "arc"; center: Vec2; radius: number; start: number; end: number }
  | { kind: "polyline"; points: Vec2[] };
/**
 * Outline of a planar face at 1:1 in its own plane, for cutting a plate:
 * lines, circles and arcs exact, other curves as fine polylines. The outline
 * starts at the origin (lower-left corner of its bounds); `thickness` is the
 * distance to the nearest parallel face behind it.
 */
export async function faceOutline(doc: Document, ref: TopologyRef) {
  const shapes = await buildPlacedShapes(doc);
  try {
    const shape = shapes.get(ref.bodyId);
    if (!shape) throw Error("Unknown body");
    const face = resolve(shape, ref);
    if (!(face instanceof r.Face) || face.geomType !== "PLANE") throw Error("Select a planar face to export its outline");
    const n = unit(face.normalAt().toTuple()),
      { xDir, yDir } = axesFor(n),
      origin = r.measureShapeSurfaceProperties(face).centerOfMass;
    const flat = (p: Vec3): Vec2 => [dot(sub(p, origin), xDir), dot(sub(p, origin), yDir)];
    const entities: OutlineEntity[] = [];
    for (const edge of face.edges) {
      const a = flat(edge.startPoint.toTuple()),
        b = flat(edge.endPoint.toTuple());
      const circle = edge.geomType === "CIRCLE" ? circleOf(edge) : undefined;
      if (edge.geomType === "LINE") entities.push({ kind: "line", a, b });
      else if (circle) {
        const center = flat(circle.center);
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7) entities.push({ kind: "circle", center, radius: circle.radius });
        else {
          const angle = (p: Vec2) => (Math.atan2(p[1] - center[1], p[0] - center[0]) * 180) / Math.PI;
          const norm = (x: number) => ((x % 360) + 360) % 360;
          const s = angle(a),
            e = angle(b),
            m = angle(flat(edge.pointAt(0.5).toTuple()));
          // DXF arcs run counter-clockwise; flip the ends when the edge runs the other way.
          const ccw = norm(m - s) < norm(e - s);
          entities.push({ kind: "arc", center, radius: circle.radius, start: norm(ccw ? s : e), end: norm(ccw ? e : s) });
        }
      } else entities.push({ kind: "polyline", points: Array.from({ length: 65 }, (_, i) => flat(edge.pointAt(i / 64).toTuple())) });
    }
    // Bounds from the curves themselves, so arcs and circles count fully.
    const pts: Vec2[] = entities.flatMap((x) =>
      x.kind === "line"
        ? [x.a, x.b]
        : x.kind === "polyline"
          ? x.points
          : Array.from({ length: 73 }, (_, i) => {
              const t = x.kind === "circle" ? (i / 72) * 360 : x.start + ((((x.end - x.start) % 360) + 360) % 360 || 360) * (i / 72);
              return [x.center[0] + x.radius * Math.cos((t * Math.PI) / 180), x.center[1] + x.radius * Math.sin((t * Math.PI) / 180)] as Vec2;
            }),
    );
    const minX = Math.min(...pts.map((p) => p[0])),
      minY = Math.min(...pts.map((p) => p[1])),
      shift = (p: Vec2): Vec2 => [p[0] - minX, p[1] - minY];
    const shifted = entities.map((x): OutlineEntity =>
      x.kind === "line"
        ? { ...x, a: shift(x.a), b: shift(x.b) }
        : x.kind === "polyline"
          ? { ...x, points: x.points.map(shift) }
          : { ...x, center: shift(x.center) },
    );
    let thickness: number | undefined;
    for (const other of shape.faces) {
      if (other.geomType !== "PLANE" || Math.abs(dot(unit(other.normalAt().toTuple()), n) + 1) > 1e-9) continue;
      const depth = dot(sub(origin, r.measureShapeSurfaceProperties(other).centerOfMass), n);
      if (depth > 1e-9 && (thickness === undefined || depth < thickness)) thickness = depth;
    }
    return {
      entities: shifted,
      width: Math.max(...pts.map((p) => p[0])) - minX,
      height: Math.max(...pts.map((p) => p[1])) - minY,
      ...(thickness !== undefined ? { thickness } : {}),
    };
  } finally {
    for (const s of shapes.values()) s.delete();
  }
}
export async function measureGeometry(
  doc: Document,
  refs: TopologyRef[],
  bodyId?: string,
) {
  const shapes = await buildPlacedShapes(doc);
  try {
    if (refs.length === 2) {
      const items = refs.map((ref) => {
        const s = shapes.get(ref.bodyId);
        if (!s) throw Error("Unknown body");
        return resolve(s, ref);
      });
      const result: Record<string, any> = {
        distance: r.measureDistanceBetween(items[0], items[1]),
        units: "mm",
      };
      // Angle between planar faces or straight edges.
      const direction = (item: r.Face | r.Edge) =>
        item instanceof r.Face
          ? item.geomType === "PLANE"
            ? item.normalAt().toTuple()
            : undefined
          : item.geomType === "LINE"
            ? item.tangentAt(0.5).toTuple()
            : undefined;
      const [da, db] = items.map(direction);
      if (da && db) {
        const c = Math.abs(dot(unit(da), unit(db)));
        result.angle = (Math.acos(Math.min(1, c)) * 180) / Math.PI;
      }
      return result;
    }
    if (refs.length === 1) {
      const ref = refs[0],
        shape = shapes.get(ref.bodyId);
      if (!shape) throw Error("Unknown body");
      const item = resolve(shape, ref);
      if (ref.kind === "edge") {
        const circle = item.geomType === "CIRCLE" ? circleOf(item as r.Edge) : undefined;
        return {
          length: r.measureLength(item),
          ...(circle ? { radius: circle.radius, diameter: circle.radius * 2 } : {}),
          units: "mm",
        };
      }
      return { area: r.measureArea(item as r.Face), units: "mm²" };
    }
    const s = shapes.get(bodyId ?? [...shapes.keys()][0]);
    if (!s) throw Error("Select geometry to measure");
    const props = r.measureShapeVolumeProperties(s),
      result = {
        volume: r.measureVolume(s),
        surfaceArea: r.measureArea(s),
        bounds: s.boundingBox.bounds,
        centerOfMass: props.centerOfMass,
        units: "mm",
      };
    props.delete();
    return result;
  } finally {
    for (const s of shapes.values()) s.delete();
  }
}
/**
 * Interference detection over the assembly, as SolidWorks does it: every
 * pair of bodies from different components (or among the given bodies) that
 * overlap, with the volume they share. Bodies that only touch do not count.
 */
export async function interferences(doc: Document, only?: string[], excludeHidden = false) {
  const shapes = await buildPlacedShapes(doc);
  try {
    const ids = [...shapes.keys()].filter((id) => (!only || only.includes(id)) && !(excludeHidden && bodyHidden(doc, id)));
    const owner = (id: string) => componentOf(doc, id)?.id ?? id,
      name = (id: string) => componentOf(doc, id)?.name ?? doc.bodies.find((b) => b.id === id)?.name ?? id;
    const boxes = new Map(ids.map((id) => [id, shapes.get(id)!.boundingBox.bounds]));
    const apart = (p: number[][], q: number[][]) => [0, 1, 2].some((k) => p[0][k] > q[1][k] + 1e-6 || q[0][k] > p[1][k] + 1e-6);
    const pairs: { a: string; b: string; aName: string; bName: string; volume: number }[] = [];
    let checked = 0;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i], ids[j]];
        if (owner(a) === owner(b) || apart(boxes.get(a)!, boxes.get(b)!)) continue;
        checked++;
        const common = shapes.get(a)!.clone().intersect(shapes.get(b)!.clone());
        const volume = common.isNull ? 0 : r.measureVolume(common);
        common.delete();
        if (volume > 1e-6) pairs.push({ a, b, aName: name(a), bName: name(b), volume });
      }
    return { interferes: pairs.length > 0, pairs: pairs.sort((x, y) => y.volume - x.volume), bodies: ids.length, checked };
  } finally {
    for (const s of shapes.values()) s.delete();
  }
}
export async function interference(doc: Document, a: string, b: string) {
  const shapes = await buildPlacedShapes(doc);
  try {
    const x = shapes.get(a),
      y = shapes.get(b);
    if (!x || !y) throw Error("Both bodies must exist");
    const common = x.intersect(y);
    try {
      const volume = common.isNull ? 0 : r.measureVolume(common);
      return { interferes: volume > 1e-6, volume, units: "mm³" };
    } finally {
      common.delete();
    }
  } finally {
    for (const s of shapes.values()) s.delete();
  }
}

/**
 * Move a component through its travel (rotation in degrees about an axis, or
 * translation in mm along it) and check it against the rest of the assembly
 * at each step: interference volume with each other body and the smallest gap.
 */
/**
 * Where lines pass through solids: for each line (a point and a direction),
 * the bodies it crosses with the distances along it where it enters and leaves.
 */
export async function lineCrossings(doc: Document, lines: { origin: Vec3; direction: Vec3 }[], length = 2000) {
  const shapes = await buildPlacedShapes(doc);
  try {
    return lines.map((line) => {
      const n = unit(line.direction),
        start = sub(line.origin, mul(n, length / 2));
      // A thin probe along the line; what it shares with a solid is the crossing.
      const probe = r.makeCylinder(0.01, length, start, n);
      const hits: { bodyId: string; enter: number; exit: number }[] = [];
      try {
        for (const [bodyId, shape] of shapes) {
          const [lo, hi] = shape.boundingBox.bounds;
          const near = [0, 1, 2].every((k) => {
            const a = Math.min(start[k], start[k] + n[k] * length) - 0.1,
              b = Math.max(start[k], start[k] + n[k] * length) + 0.1;
            return b >= lo[k] && a <= hi[k];
          });
          if (!near) continue;
          const common = shape.clone().intersect(probe.clone());
          try {
            if (common.isNull || r.measureVolume(common) < 1e-9) continue;
            for (const piece of common.solids.length ? common.solids : [common]) {
              const box = piece.boundingBox.bounds,
                corners = [box[0], box[1]].map((p) => dot(sub(p, line.origin), n));
              hits.push({ bodyId, enter: Math.min(...corners), exit: Math.max(...corners) });
            }
          } finally {
            common.delete();
          }
        }
      } finally {
        probe.delete();
      }
      return hits.sort((a, b) => a.enter - b.enter);
    });
  } finally {
    for (const s of shapes.values()) s.delete();
  }
}
export async function motionSweep(
  doc: Document,
  moving: string[],
  motion: { kind: "rotate" | "translate"; origin: Vec3; direction: Vec3; from: number; to: number; steps: number },
  against?: string[],
  /** Parts geared to the moving one: each turns `factor` times the motion about its own axis. */
  followers: { ids: string[]; origin: Vec3; direction: Vec3; factor: number; mesh: number[]; meshTolerance: number; meshPeriod?: number }[] = [],
) {
  const shapes = await buildPlacedShapes(doc);
  try {
    const mover = moving.map((id) => shapes.get(id)).filter((s): s is r.Shape3D => !!s);
    if (!mover.length) throw Error("The moving component has no visible bodies");
    const groups = [
      { ids: moving, origin: motion.origin, direction: unit(motion.direction), factor: 1, mesh: [] as number[], meshTolerance: 0, meshPeriod: undefined as number | undefined },
      ...followers.map((f) => ({ ...f, direction: unit(f.direction) })),
    ];
    const inMotion = new Set(groups.flatMap((g) => g.ids));
    const others = [...shapes].filter(([id]) => !inMotion.has(id) && (!against || against.includes(id)));
    if (!others.length && groups.length < 2) throw Error("Nothing to check against");
    const name = (id: string) => {
      const c = componentOf(doc, id);
      return c ? c.name : (doc.bodies.find((b) => b.id === id)?.name ?? id);
    };
    const n = unit(motion.direction);
    const otherBoxes = others.map(([, other]) => other.boundingBox.bounds);
    // The distance between two boxes, less a margin for box tolerance: a lower bound on their solids' gap.
    const boxGap = (a: number[][], b: number[][]) =>
      Math.max(0, Math.hypot(...[0, 1, 2].map((k) => Math.max(0, a[0][k] - b[1][k], b[0][k] - a[1][k]))) - 1e-4);
    const steps = [];
    // Meshing pairs sampled within their first tooth: overlap by place in the tooth cycle.
    const meshSamples = new Map<string, { phase: number; volume: number }[]>();
    for (let i = 0; i <= motion.steps; i++) {
      const value = motion.from + ((motion.to - motion.from) * i) / motion.steps;
      const placed = groups.flatMap((g, group) =>
        g.ids.flatMap((id) => {
          const shape = shapes.get(id);
          if (!shape) return [];
          const moved = (motion.kind === "rotate" ? shape.clone().rotate(g.factor * value, g.origin, g.direction) : shape.clone().translate(mul(n, value))) as r.Shape3D;
          return [{ id, group, shape: moved, box: moved.boundingBox.bounds }];
        }),
      );
      let clearance = Infinity,
        closest = "";
      const hits: { with: string; volume: number; by?: string }[] = [];
      const overlap = (a: r.Shape3D, b: r.Shape3D) => {
        const common = a.clone().intersect(b.clone());
        const volume = common.isNull ? 0 : r.measureVolume(common);
        common.delete();
        return volume;
      };
      const by = (p: (typeof placed)[number]) => (p.group > 0 ? { by: name(p.id) } : {});
      // Gears in mesh always touch, so they count only when they overlap; the mesh
      // repeats every tooth, so one tooth's worth of travel shows any clash.
      const meshed = placed.flatMap((p) => placed.filter((o) => o.group > p.group && groups[o.group].mesh.includes(p.group)).map((o) => ({ p, o })));
      for (const { p, o } of meshed) {
        const g = groups[o.group],
          key = `${p.id}|${o.id}`,
          travel = Math.abs(value - motion.from);
        let volume: number;
        if (g.meshPeriod !== undefined && travel > g.meshPeriod + 1e-9) {
          // Past the first tooth the mesh repeats: take the sample at the same place in the cycle.
          const phase = travel % g.meshPeriod,
            cycle = (x: number) => Math.min(Math.abs(x - phase), g.meshPeriod! - Math.abs(x - phase));
          const samples = meshSamples.get(key) ?? [];
          volume = samples.length ? samples.reduce((best, s) => (cycle(s.phase) < cycle(best.phase) ? s : best)).volume : 0;
        } else {
          volume = boxGap(p.box, o.box) > 0 ? 0 : overlap(p.shape, o.shape);
          meshSamples.set(key, [...(meshSamples.get(key) ?? []), { phase: travel % (g.meshPeriod ?? Infinity), volume }]);
        }
        if (volume > g.meshTolerance) hits.push({ with: name(o.id), volume, ...by(p) });
      }
      // Each moving part against the still ones, and geared parts not in mesh against each other.
      const candidates = [
        ...placed.flatMap((p) => others.map(([id, other], k) => ({ p, id, other, box: otherBoxes[k] }))),
        ...placed.flatMap((p) => placed.filter((o) => o.group > p.group && !groups[o.group].mesh.includes(p.group)).map((o) => ({ p, id: o.id, other: o.shape, box: o.box }))),
      ];
      // Exact distances only where the boxes allow a closer approach, nearest box first.
      const pairs = candidates.map((c) => ({ ...c, gap: boxGap(c.p.box, c.box) })).sort((a, b) => a.gap - b.gap);
      for (const { p, id, other, gap: lower } of pairs) {
        if (lower > clearance && lower > 1e-6) break;
        const gap = r.measureDistanceBetween(p.shape, other);
        if (gap < clearance) {
          clearance = gap;
          closest = name(id);
        }
        if (gap > 1e-6) continue;
        const volume = overlap(p.shape, other);
        if (volume > 1e-6) hits.push({ with: name(id), volume, ...by(p) });
      }
      for (const { shape } of placed) shape.delete();
      steps.push({ value, clearance: hits.length ? 0 : clearance, closest, interference: hits });
    }
    return sweepSummary(motion.kind, steps);
  } finally {
    for (const s of shapes.values()) s.delete();
  }
}
type SweepStep = { value: number; clearance: number; closest: string; interference: { with: string; volume: number; by?: string }[] };
/** Collisions and the tightest clearance of a sweep; clearance is null where nothing but touching parts was in reach. */
function sweepSummary(kind: string, steps: SweepStep[], limit?: { value: number; reason: string }) {
  const colliding = steps.filter((s) => s.interference.length);
  const tightest = steps.reduce((a, b) => (b.clearance < a.clearance ? b : a));
  const finite = (x: number) => (Number.isFinite(x) ? x : null);
  return {
    kind,
    steps: steps.map((s) => ({ ...s, clearance: finite(s.clearance) })),
    collides: colliding.length > 0,
    collisions: colliding.map((s) => ({
      value: s.value,
      with: [...new Set(s.interference.map((h) => (h.by ? `${h.by} hits ${h.with}` : h.with)))],
      volume: s.interference.reduce((t, h) => t + h.volume, 0),
    })),
    minimumClearance: { value: finite(tightest.clearance), at: tightest.value, with: tightest.closest },
    ...(limit ? { limit } : {}),
  };
}
/**
 * A motion check through a mechanism: the driving part turns (or slides) by
 * each step and the whole assembly is solved again from the step before, so
 * a linkage follows, and whatever is mated to a moving part rides with it.
 * Parts mated to each other touch by design: they count only if they
 * overlap. A step the mechanism cannot reach ends the sweep there.
 */
export async function mechanismSweep(
  doc: Document,
  driver: string,
  motion: { kind: "rotate" | "translate"; origin: Vec3; direction: Vec3; from: number; to: number; steps: number },
  against?: string[],
  /** Bodies of gear-mated parts and the overlap their mesh is allowed. */
  meshed: { a: string[]; b: string[]; tolerance: number }[] = [],
) {
  const { shapes, metadata, components: base } = await placedModel(doc);
  try {
    if (!base[driver]) throw Error("The moving component is not in this assembly");
    const n = unit(motion.direction);
    const ownerOf = (bodyId: string) => doc.components?.find((c) => c.bodyIds.includes(bodyId))?.id ?? componentOf(doc, bodyId)?.id;
    const name = (id: string) => {
      const c = componentOf(doc, id);
      return c ? c.name : (doc.bodies.find((b) => b.id === id)?.name ?? id);
    };
    // Parts mated directly to each other.
    const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
    const mated = new Set<string>();
    for (const m of doc.mates ?? []) {
      if (m.suppressed) continue;
      const [x, y] = [componentOf(doc, m.moving.bodyId)?.id, componentOf(doc, m.target.bodyId)?.id];
      if (x && y) mated.add(pairKey(x, y));
    }
    const meshAllowance = (x: string, y: string) => meshed.find((p) => (p.a.includes(x) && p.b.includes(y)) || (p.a.includes(y) && p.b.includes(x)))?.tolerance ?? 1e-6;
    const boxGap = (a: number[][], b: number[][]) =>
      Math.max(0, Math.hypot(...[0, 1, 2].map((k) => Math.max(0, a[0][k] - b[1][k], b[0][k] - a[1][k]))) - 1e-4);
    const overlap = (a: r.Shape3D, b: r.Shape3D) => {
      const common = a.clone().intersect(b.clone());
      const volume = common.isNull ? 0 : r.measureVolume(common);
      common.delete();
      return volume;
    };
    // Mates already flagged before moving do not stop the sweep.
    const flaggedBefore: SolveReport = { mates: {}, components: {} };
    solveComponents(doc, metadata, { report: flaggedBefore });
    const drive = (p: Placement, value: number): Placement => {
      if (motion.kind === "translate") return { position: add(p.position, mul(n, value)), quaternion: p.quaternion };
      const turn = new Quaternion().setFromAxisAngle(new Vector3(...n), (value * Math.PI) / 180);
      const o = new Vector3(...motion.origin);
      return {
        position: new Vector3(...p.position).sub(o).applyQuaternion(turn).add(o).toArray() as Vec3,
        quaternion: turn.multiply(new Quaternion(...p.quaternion)).normalize().toArray() as Placement["quaternion"],
      };
    };
    /** The rigid motion from one placement of a part to another. */
    const relative = (to: Placement, from: Placement): Placement => {
      const turn = new Quaternion(...to.quaternion).multiply(new Quaternion(...from.quaternion).invert()).normalize();
      return { position: new Vector3(...to.position).sub(new Vector3(...from.position).applyQuaternion(turn)).toArray() as Vec3, quaternion: turn.toArray() as Placement["quaternion"] };
    };
    const still = (p: Placement) => Math.hypot(...p.position) < 1e-9 && Math.abs(Math.abs(p.quaternion[3]) - 1) < 1e-12;
    const steps: SweepStep[] = [];
    let limit: { value: number; reason: string } | undefined,
      previous = base;
    for (let i = 0; i <= motion.steps; i++) {
      const value = motion.from + ((motion.to - motion.from) * i) / motion.steps;
      const wanted = drive(base[driver], value),
        report: SolveReport = { mates: {}, components: {} };
      const solved = solveComponents(doc, metadata, { initial: { ...previous, [driver]: wanted }, anchor: [driver], report });
      const broken = Object.entries(report.mates).find(([id, m]) => m.status === "over" && flaggedBefore.mates[id]?.status !== "over");
      const strayed = relative(solved[driver], wanted);
      if (broken || !still(strayed)) {
        limit = { value, reason: broken ? `The mechanism cannot reach ${Math.round(value * 1000) / 1000}: ${broken[1].message}` : `${name(driver)} cannot move that way; its mates hold it` };
        break;
      }
      previous = solved;
      // Bodies that moved, each by its part's motion from the start.
      const movedParts = new Set(Object.keys(solved).filter((id) => base[id] && !still(relative(solved[id], base[id]))));
      const placed: { id: string; part: string; shape: r.Shape3D; box: number[][] }[] = [];
      const others: { id: string; part?: string; shape: r.Shape3D; box: number[][] }[] = [];
      for (const [id, shape] of shapes) {
        const part = ownerOf(id),
          belt = part ? doc.components?.find((c) => c.id === part)?.belt : undefined;
        // A belt on a moving pulley runs with it.
        if (belt && belt.pulleys.some((p) => movedParts.has(p))) continue;
        if (part && movedParts.has(part)) {
          const moved = transformShape(shape, relative(solved[part], base[part])) as r.Shape3D;
          placed.push({ id, part, shape: moved, box: moved.boundingBox.bounds });
        } else if (!against || against.includes(id)) others.push({ id, part, shape, box: shape.boundingBox.bounds });
      }
      let clearance = Infinity,
        closest = "";
      const hits: SweepStep["interference"] = [];
      const by = (p: (typeof placed)[number]) => (p.part !== driver ? { by: name(p.id) } : {});
      const candidates = [
        ...placed.flatMap((p) => others.map((o) => ({ p, o }))),
        ...placed.flatMap((p, k) => placed.slice(k + 1).filter((o) => o.part !== p.part).map((o) => ({ p, o }))),
      ];
      const pairs = candidates.map((c) => ({ ...c, gap: boxGap(c.p.box, c.o.box), touching: !!c.o.part && mated.has(pairKey(c.p.part, c.o.part)) })).sort((a, b) => a.gap - b.gap);
      for (const { p, o, gap: lower, touching } of pairs) {
        if (touching) {
          // Mated parts touch by design: only an overlap counts, and they set no clearance.
          if (lower > 0) continue;
          const volume = overlap(p.shape, o.shape);
          if (volume > meshAllowance(p.id, o.id)) hits.push({ with: name(o.id), volume, ...by(p) });
          continue;
        }
        if (lower > clearance && lower > 1e-6) continue;
        const gap = r.measureDistanceBetween(p.shape, o.shape);
        if (gap < clearance) {
          clearance = gap;
          closest = name(o.id);
        }
        if (gap > 1e-6) continue;
        const volume = overlap(p.shape, o.shape);
        if (volume > 1e-6) hits.push({ with: name(o.id), volume, ...by(p) });
      }
      for (const { shape } of placed) shape.delete();
      steps.push({ value, clearance: hits.length ? 0 : clearance, closest, interference: hits });
    }
    if (!steps.length) throw Error(limit?.reason ?? "The mechanism cannot start");
    return sweepSummary(motion.kind, steps, limit);
  } finally {
    for (const s of shapes.values()) s.delete();
  }
}
function transformShape<T extends r.Shape<any>>(shape: T, p: Placement): T {
  const quat = new Quaternion(...p.quaternion).normalize();
  const angle = 2 * Math.acos(Math.max(-1, Math.min(1, quat.w)));
  const axis = new Vector3(quat.x, quat.y, quat.z);
  let result = shape.clone();
  if (axis.length() > 1e-9) {
    const rotated = result.rotate(
      (angle * 180) / Math.PI,
      [0, 0, 0],
      axis.normalize().toArray() as Vec3,
    );
    result.delete();
    result = rotated;
  }
  const translated = result.translate(p.position);
  result.delete();
  return translated;
}
async function buildPlacedShapes(doc: Document) {
  return (await placedModel(doc)).shapes;
}
/** The assembled solids, with the unplaced topology and component placements they were solved from. */
async function placedModel(doc: Document) {
  const shapes = await buildShapes(doc);
  for (const id of suppressedBodies(doc)) {
    shapes.get(id)?.delete();
    shapes.delete(id);
  }
  try {
    await instanceShapes(doc, shapes);
    const metadata = [...shapes.entries()].flatMap(
      ([id, shape]) => topologies(id, shape).metadata,
    );
    const components = solveComponents(doc, metadata);
    const placements = bodyPlacements(doc, components, shapes.keys());
    for (const [id, shape] of shapes) {
      const local = topologies(id, shape),
        p = placements[id] ?? { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
      const transformed = named(transformShape(shape, p), new Map());
      shapeNames.set(transformed, namesByOrder(transformed, shape, namesOf(shape)));
      // Placed faces and edges by the ids (and earlier ids) of their unplaced originals.
      const counterpart = new Map<string, r.Face | r.Edge>();
      const faces = transformed.faces,
        edges = transformed.edges;
      shape.faces.forEach((f, i) => counterpart.set(`f${f.hashCode}`, faces[i]));
      shape.edges.forEach((e, i) => counterpart.set(`e${e.hashCode}`, edges[i]));
      const objects = new Map<string, r.Face | r.Edge>();
      for (const [tid, item] of [...local.objects, ...local.legacy]) {
        const placed = counterpart.get(`${item instanceof r.Face ? "f" : "e"}${item.hashCode}`);
        if (placed && !objects.has(tid)) objects.set(tid, placed);
      }
      placedObjects.set(transformed, objects);
      shapes.set(id, transformed);
      shape.delete();
    }
    for (const c of doc.components ?? []) {
      if (!c.belt || c.suppressed || c.belt.pulleys.some((p) => doc.components?.find((x) => x.id === p)?.suppressed)) continue;
      const { shape } = await beltSolid(doc, c, placements),
        id = `${c.id}/belt`,
        local = topologies(id, shape);
      placedObjects.set(shape, new Map([...local.objects, ...local.legacy]));
      shapes.set(id, shape);
    }
    return { shapes, metadata, components };
  } catch (e) {
    for (const shape of shapes.values()) shape.delete();
    throw e;
  }
}
/** Flat pattern views keyed by model state and body. */
const flatViews = new Map<string, { visible: string[]; hidden: string[]; bbox: [number, number, number, number]; bends: { a: Vec2; b: Vec2; label: string }[] }>();
/** Hidden-line projections keyed by model state and camera. */
const projectionCache = new Map<string, { visible: string[]; hidden: string[]; bbox: [number, number, number, number]; sectionSegments?: [Vec2, Vec2][] }>();
function modelKey(doc: Document, sheet: { bodyIds: string[] }) {
  return topologyKey(
    JSON.stringify([doc.sketches, doc.features, doc.bodies.map((b) => [b.id, b.hidden]), doc.referencePlanes, doc.components, doc.mates, doc.componentPatterns, sheet.bodyIds, linkKey(doc)]),
  );
}
function projectShape(shape: r.AnyShape, camera: ViewCamera) {
  const cam = new r.ProjectionCamera([0, 0, 0], camera.dir, camera.x);
  try {
    // Faces of one surface (an extruded circle's two half-cylinders) are merged on the projected
    // copy, and continuity recoded so seams count as smooth: neither draws a line.
    const oc = r.getOC() as any;
    const unify = new oc.ShapeUpgrade_UnifySameDomain(shape.wrapped, true, true, false);
    unify.Build();
    const merged = r.cast(unify.Shape()) as r.AnyShape;
    unify.delete();
    oc.BRepLib.EncodeRegularity(merged.wrapped, 1e-6);
    let drawing: ReturnType<typeof r.drawProjection>;
    try {
      drawing = r.drawProjection(merged as any, cam);
    } finally {
      merged.delete();
    }
    const visible = drawing.visible.toSVGPaths().flat() as string[];
    const hidden = drawing.hidden.toSVGPaths().flat() as string[];
    const box = drawing.visible.toSVGViewBox(0).split(/\s+/).map(Number);
    const bbox: [number, number, number, number] = [box[0], box[1], box[0] + box[2], box[1] + box[3]];
    return { visible, hidden, bbox };
  } finally {
    cam.delete();
  }
}
export async function renderDrawing(doc: Document, drawingId: string, format: "svg" | "pdf" | "dxf" = "svg") {
  const sheet = doc.drawings?.find((d) => d.id === drawingId);
  if (!sheet) throw Error("Drawing not found");
  const views = resolveViews(sheet);
  const shapes = await buildPlacedShapes(doc);
  const created: r.AnyShape[] = [];
  try {
    const sources = [...shapes.entries()].filter(([id]) => sheet.bodyIds.includes(id) && !bodyHidden(doc, id));
    if (!sources.length) throw Error("Drawing has no source solids");
    const key = modelKey(doc, sheet);
    const explodeOffsets: Record<string, Vec3> = {};
    for (const [id] of sources) {
      const c = componentOf(doc, id);
      if (c) explodeOffsets[id] = c.explode;
    }
    const solidsFor = (exploded: boolean) =>
      sources.map(([id, s]) => {
        if (!exploded || !explodeOffsets[id]) return s;
        const moved = s.clone().translate(explodeOffsets[id]);
        created.push(moved);
        return moved;
      });
    const inputs: ViewInput[] = [];
    const pending = [...views];
    for (let guard = 0; pending.length && guard < 100; guard++) {
      const v = pending.shift()!;
      const parent = v.parentId ? inputs.find((i) => i.view.id === v.parentId) : undefined;
      if (v.parentId && !parent) {
        if (!views.some((x) => x.id === v.parentId)) throw Error(`${v.name}: its parent view was deleted`);
        pending.push(v);
        continue;
      }
      const scale = v.scale ?? (v.kind === "detail" && parent ? parent.scale * 2 : sheet.scale);
      const offsets = v.exploded ? explodeOffsets : undefined;
      if (v.kind === "detail") {
        if (!parent || !v.detail) throw Error(`${v.name}: detail views need a parent view and circle`);
        const c = v.detail.center,
          rad = v.detail.radius;
        inputs.push({
          view: v,
          camera: parent.camera,
          scale,
          visible: parent.visible,
          hidden: parent.hidden,
          bbox: [c[0] - rad, -c[1] - rad, c[0] + rad, -c[1] + rad],
          sectionSegments: parent.sectionSegments,
          offsets: parent.offsets,
        });
        continue;
      }
      if (v.kind === "flat") {
        // The unfolded blank, looked at from above its base flange plane.
        if (!v.bodyId) throw Error(`${v.name}: choose the sheet metal body to unfold`);
        const flatKey = `${key}|flat|${v.bodyId}`;
        let flat = flatViews.get(flatKey);
        if (!flat) {
          const pattern = await flatPattern(doc, v.bodyId);
          const [x0, y0, x1, y1] = pattern.bounds;
          flat = {
            visible: pattern.segments.map(([a, b]) => `M ${a[0]} ${-a[1]} L ${b[0]} ${-b[1]}`),
            hidden: [],
            bbox: [x0, -y1, x1, -y0],
            bends: pattern.bends.map((b) => ({ a: [b.a[0], -b.a[1]] as Vec2, b: [b.b[0], -b.b[1]] as Vec2, label: b.label })),
          };
          flatViews.set(flatKey, flat);
          if (flatViews.size > 16) flatViews.delete(flatViews.keys().next().value!);
        }
        inputs.push({ view: v, camera: cameraFor("top"), scale, ...flat });
        continue;
      }
      let camera: ViewCamera;
      let cut: { origin: Vec3; normal: Vec3 } | undefined;
      if (v.kind === "section") {
        if (!parent || !v.section) throw Error(`${v.name}: section views need a parent view and cut line`);
        const pc = parent.camera,
          [a, b] = [v.section.a, v.section.b];
        const toWorld = (p: Vec2): Vec3 => add(mul(pc.x, p[0]), mul(pc.y, p[1]));
        const A = toWorld(a);
        const l2 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1,
          d2 = [(b[0] - a[0]) / l2, (b[1] - a[1]) / l2];
        // Viewing direction: to the left of a→b in the parent's model plane (flip reverses).
        let look = unit(add(mul(pc.x, -d2[1]), mul(pc.y, d2[0])));
        if (v.section.flip) look = mul(look, -1);
        const dir = mul(look, -1);
        // The section keeps the cut line's sheet alignment: a horizontal cut stays
        // horizontal (x along the line), a vertical cut stays vertical (y along it).
        if (Math.abs(d2[0]) >= Math.abs(d2[1])) {
          const x = unit(add(mul(pc.x, Math.sign(d2[0]) * d2[0]), mul(pc.y, Math.sign(d2[0]) * d2[1])));
          camera = { dir, x, y: cross(dir, x) };
        } else {
          const y = unit(add(mul(pc.x, Math.sign(d2[1]) * d2[0]), mul(pc.y, Math.sign(d2[1]) * d2[1])));
          const x = cross(y, dir);
          camera = { dir, x, y };
        }
        cut = { origin: A, normal: look };
      } else camera = cameraFor(v.orientation ?? "front");
      const cacheKey = `${key}|${JSON.stringify(camera)}|${v.exploded ? 1 : 0}|${JSON.stringify(cut ?? null)}`;
      let projection = projectionCache.get(cacheKey);
      if (!projection) {
        let solids = solidsFor(!!v.exploded);
        let sectionSegments: [Vec2, Vec2][] | undefined;
        if (cut) {
          const plane = new r.Plane(cut.origin, camera.x, cut.normal);
          try {
            const kept: r.Shape3D[] = [];
            for (const s of solids) {
              const half = s.cutPlane(plane, 0, "positive");
              if (half) {
                kept.push(half as r.Shape3D);
                created.push(half);
              }
            }
            if (!kept.length) throw Error(`${v.name}: the section line does not cross the part`);
            solids = kept;
            sectionSegments = [];
            for (const s of kept)
              for (const face of s.faces) {
                if (face.geomType !== "PLANE") continue;
                const fn = face.normalAt().toTuple(),
                  fc = r.measureShapeSurfaceProperties(face).centerOfMass;
                if (Math.abs(Math.abs(dot(fn, cut.normal)) - 1) > 1e-6 || Math.abs(dot(sub(fc, cut.origin), cut.normal)) > 1e-5) continue;
                for (const edge of face.edges) {
                  let prev: Vec2 | undefined;
                  const steps = edge.geomType === "LINE" ? 1 : 24;
                  for (let i = 0; i <= steps; i++) {
                    const p = edge.pointAt(i / steps).toTuple(),
                      q: Vec2 = [dot(p, camera.x), -dot(p, camera.y)];
                    if (prev) sectionSegments.push([prev, q]);
                    prev = q;
                  }
                }
              }
          } finally {
            plane.delete();
          }
        }
        // makeCompound consumes its inputs; give it clones.
        const compound = r.makeCompound(solids.map((x) => x.clone()));
        created.push(compound);
        projection = { ...projectShape(compound, camera), sectionSegments };
        projectionCache.set(cacheKey, projection);
        if (projectionCache.size > 32) projectionCache.delete(projectionCache.keys().next().value!);
      }
      inputs.push({ view: v, camera, scale, ...projection, offsets, ...(cut ? { cut } : {}) });
    }
    const geometry = await rebuild(doc);
    const composed = composeSheet(doc, sheet, inputs, geometry);
    const { width, height } = sheetDimensions(sheet);
    const title = sheet.title || doc.name;
    return {
      drawingId: sheet.id,
      revision: doc.revision,
      svg: toSVG(composed.prims, width, height, sheet.name),
      ...(format === "pdf" ? { pdf: toPDF(composed.prims, width, height, title) } : {}),
      ...(format === "dxf" ? { dxf: toDXF(composed.prims, height) } : {}),
      views: composed.views,
      labels: composed.labels,
      projection: sheet.projection,
      width,
      height,
    };
  } finally {
    for (const s of created) s.delete();
    for (const s of shapes.values()) s.delete();
  }
}
