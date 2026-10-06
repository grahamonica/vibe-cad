// Persistent topology names.
//
// Faces are named by the feature and generator that created them: the caps and
// one side per sketch curve of an extrusion, the wall and floor of each hole
// instance, the round of each filleted edge. Names travel through later
// features with the kernel's own history (kept, modified and generated shapes),
// so a hole wall keeps its name when the hole moves and a top face keeps its
// name when the part gets thicker. Edges are named by their adjacent faces.
// A face that a later feature splits gets numbered pieces, so a reference to
// the whole face stops resolving instead of silently picking one piece.
import * as r from "replicad";
import type { Sketch, Vec2, Vec3 } from "./types.ts";
import { bezierPoint, sketchCurves, type Curve } from "./sketch-geometry.ts";

/** Face hash → persistent name. */
export type Names = Map<number, string>;
export interface NamedShape {
  shape: r.Shape3D;
  names: Names;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(...a);
const unit = (a: Vec3): Vec3 => mul(a, 1 / (len(a) || 1));
const cross = (p: Vec3, q: Vec3): Vec3 => [
  p[1] * q[2] - p[2] * q[1],
  p[2] * q[0] - p[0] * q[2],
  p[0] * q[1] - p[1] * q[0],
];
const TOL = 1e-5;

/** Lexicographic order of points that ignores numeric noise. */
export function order(a: Vec3, b: Vec3, tol = 1e-6) {
  for (let i = 0; i < 3; i++) {
    const d = a[i] - b[i];
    if (Math.abs(d) > tol) return d;
  }
  return 0;
}
const centroid = (face: r.Face): Vec3 => r.measureShapeSurfaceProperties(face).centerOfMass;

/** Shapes of an OCCT history list; consumes and frees the list. */
export function shapesOf(list: any): r.AnyShape[] {
  const out: r.AnyShape[] = [];
  try {
    while (!list.IsEmpty()) {
      out.push(r.cast(list.First()));
      list.RemoveFirst();
    }
  } finally {
    list.delete();
  }
  return out;
}

function circle(edge: r.Edge): { center: Vec3; normal: Vec3; radius: number } | undefined {
  const a = edge.pointAt(0).toTuple(),
    b = edge.pointAt(0.33).toTuple(),
    c = edge.pointAt(0.66).toTuple();
  const u = sub(b, a),
    v = sub(c, a);
  const n = cross(u, v);
  const nn = dot(n, n);
  if (nn < 1e-14) return undefined;
  const t1 = mul(cross(v, n), dot(u, u)),
    t2 = mul(cross(n, u), dot(v, v));
  const offset = mul([t1[0] + t2[0], t1[1] + t2[1], t1[2] + t2[2]], 1 / (2 * nn));
  return { center: [a[0] + offset[0], a[1] + offset[1], a[2] + offset[2]], normal: unit(n), radius: len(offset) };
}
/** Direction with a canonical sign, so opposite normals describe the same surface. */
function canonical(d: Vec3): Vec3 {
  const n = unit(d);
  for (const v of n) if (Math.abs(v) > 1e-7) return v > 0 ? n : mul(n, -1);
  return n;
}
export interface SurfaceKey {
  type: string;
  values: number[];
}
/** Geometric description of the unbounded surface under a face. */
export function surfaceKey(face: r.Face): SurfaceKey | undefined {
  const g = face.geomType;
  try {
    if (g === "PLANE") {
      const n = canonical(face.normalAt().toTuple());
      return { type: "P", values: [...n, dot(n, centroid(face))] };
    }
    if (g === "CYLINDRE" || g === "CONE") {
      const rim = face.edges
        .filter((e) => e.geomType === "CIRCLE")
        .map(circle)
        .find(Boolean);
      if (!rim) return undefined;
      const axis = canonical(rim.normal);
      const foot = sub(rim.center, mul(axis, dot(rim.center, axis)));
      if (g === "CYLINDRE") return { type: "C", values: [...axis, ...foot, rim.radius] };
      const c = centroid(face);
      const h = dot(sub(c, rim.center), axis);
      const radial = len(sub(sub(c, rim.center), mul(axis, h)));
      const slope = Math.abs(h) > 1e-9 ? (radial - rim.radius) / h : 0;
      return { type: "K", values: [...axis, ...foot, rim.radius - slope * dot(sub(rim.center, foot), axis), slope] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
function sameSurface(a: SurfaceKey | undefined, b: SurfaceKey | undefined, tol = 1e-4) {
  if (!a || !b || a.type !== b.type || a.values.length !== b.values.length) return false;
  return a.values.every((v, i) => Math.abs(v - b.values[i]) <= tol * Math.max(1, Math.abs(v)));
}

/** Final names: pieces sharing a name are numbered along a fixed spatial order. */
function finalize(named: { face: r.Face; name: string }[]): Names {
  const groups = new Map<string, r.Face[]>();
  for (const n of named) groups.set(n.name, [...(groups.get(n.name) ?? []), n.face]);
  const out: Names = new Map();
  for (const [name, faces] of groups) {
    if (faces.length === 1) {
      out.set(faces[0].hashCode, name);
      continue;
    }
    faces
      .map((face) => ({ face, c: centroid(face) }))
      .sort((a, b) => order(a.c, b.c))
      .forEach((x, i) => out.set(x.face.hashCode, `${name}~${i}`));
  }
  return out;
}
/**
 * Faces still without a name are named after their named neighbors (a corner
 * blend between three rounds, a face closing a split); anything left after that
 * is new geometry numbered along a fixed order.
 */
function nameRemaining(result: r.Shape3D, assigned: Map<number, string>, featureId: string) {
  const faces = result.faces;
  const byEdge = new Map<number, number[]>();
  for (const face of faces)
    for (const edge of face.edges) byEdge.set(edge.hashCode, [...(byEdge.get(edge.hashCode) ?? []), face.hashCode]);
  for (let pass = 0; pass < 3; pass++) {
    const additions: [number, string][] = [];
    for (const face of faces) {
      if (assigned.has(face.hashCode)) continue;
      const neighbors = new Set<string>();
      for (const edge of face.edges)
        for (const other of byEdge.get(edge.hashCode) ?? []) {
          const name = other !== face.hashCode ? assigned.get(other) : undefined;
          if (name) neighbors.add(name);
        }
      if (neighbors.size) additions.push([face.hashCode, `${featureId}:at:${[...neighbors].sort().join("&")}`]);
    }
    if (!additions.length) break;
    for (const [hash, name] of additions) assigned.set(hash, name);
  }
  const named = faces.map((face) => ({ face, name: assigned.get(face.hashCode) ?? `${featureId}:new` }));
  return finalize(named);
}

export interface HistoryOptions {
  /** Faces generated from input faces (inner walls of a shell) get `feature:tag:face`. */
  fromFaces?: string;
  /** Faces generated from input edges (rounds, chamfers) get `feature:tag:edge`. */
  fromEdges?: string;
  /** Result faces of an input face, for builders without the standard history. */
  modified?: (face: r.Face) => r.AnyShape[];
}
/**
 * Names for the result of an OCCT builder from the names of its inputs, using
 * the builder's history. Earlier inputs win when faces merge.
 */
export function historyNames(
  builder: any,
  result: r.Shape3D,
  inputs: NamedShape[],
  featureId: string,
  options: HistoryOptions = {},
): Names {
  const present = new Set(result.faces.map((f) => f.hashCode));
  const assigned = new Map<number, string>();
  const offer = (shape: r.AnyShape, name: string) => {
    if (shape instanceof r.Face && present.has(shape.hashCode) && !assigned.has(shape.hashCode))
      assigned.set(shape.hashCode, name);
  };
  const modified = options.modified ?? ((face: r.Face) => shapesOf(builder.Modified(face.wrapped)));
  for (const input of inputs)
    for (const face of input.shape.faces) {
      const name = input.names.get(face.hashCode);
      if (!name) continue;
      if (present.has(face.hashCode)) offer(face, name);
      else for (const m of modified(face)) offer(m, name);
    }
  if (options.fromFaces)
    for (const input of inputs)
      for (const face of input.shape.faces) {
        const name = input.names.get(face.hashCode);
        if (name)
          for (const g of shapesOf(builder.Generated(face.wrapped)))
            offer(g, `${featureId}:${options.fromFaces}:${name}`);
      }
  if (options.fromEdges)
    for (const input of inputs) {
      const edges = edgeNames(input.shape, input.names);
      for (const edge of input.shape.edges) {
        const name = edges.get(edge.hashCode);
        if (name)
          for (const g of shapesOf(builder.Generated(edge.wrapped)))
            offer(g, `${featureId}:${options.fromEdges}:${name}`);
      }
    }
  return nameRemaining(result, assigned, featureId);
}

/**
 * Names for a shape made without history (a split): faces keep the name of the
 * input face on the same surface, nearest first; the rest are new.
 */
export function transferNames(
  result: r.Shape3D,
  inputs: NamedShape[],
  featureId: string,
  fallback?: (face: r.Face) => string | undefined,
): Names {
  const sources = inputs.flatMap((input) =>
    input.shape.faces.flatMap((face) => {
      const name = input.names.get(face.hashCode);
      return name ? [{ face, name, key: surfaceKey(face), hash: face.hashCode }] : [];
    }),
  );
  const assigned = new Map<number, string>();
  for (const face of result.faces) {
    const same = sources.find((s) => s.hash === face.hashCode);
    if (same) {
      assigned.set(face.hashCode, same.name);
      continue;
    }
    const key = surfaceKey(face);
    const matches = key ? sources.filter((s) => sameSurface(s.key, key)) : [];
    if (matches.length) {
      const c = centroid(face);
      matches.sort((a, b) => len(sub(centroid(a.face), c)) - len(sub(centroid(b.face), c)));
      assigned.set(face.hashCode, matches[0].name);
      continue;
    }
    const name = fallback?.(face);
    if (name) assigned.set(face.hashCode, name);
  }
  return nameRemaining(result, assigned, featureId);
}

/** Names of a shape whose faces correspond, in order, to a named shape (a moved copy). */
export function namesByOrder(result: r.Shape3D, before: r.Shape3D, names: Names, prefix = ""): Names {
  const a = before.faces,
    b = result.faces;
  const out: Names = new Map();
  if (a.length !== b.length) return out;
  b.forEach((face, i) => {
    const name = names.get(a[i].hashCode);
    if (name) out.set(face.hashCode, prefix + name);
  });
  return out;
}

/** Edge names from adjacent face names; parallel edges between the same faces are numbered. */
export function edgeNames(shape: r.Shape3D, faces: Names): Names {
  const adjacent = new Map<number, { edge: r.Edge; names: string[] }>();
  for (const face of shape.faces) {
    const name = faces.get(face.hashCode) ?? "?";
    for (const edge of face.edges) {
      const entry = adjacent.get(edge.hashCode) ?? { edge, names: [] };
      entry.names.push(name);
      adjacent.set(edge.hashCode, entry);
    }
  }
  const groups = new Map<string, { hash: number; edge: r.Edge }[]>();
  for (const [hash, { edge, names }] of adjacent) {
    const key = [...new Set(names)].sort().join("|");
    groups.set(key, [...(groups.get(key) ?? []), { hash, edge }]);
  }
  const out: Names = new Map();
  for (const [key, list] of groups) {
    if (list.length === 1) {
      out.set(list[0].hash, key);
      continue;
    }
    list
      .map((x) => ({ ...x, m: x.edge.pointAt(0.5).toTuple() }))
      .sort((a, b) => order(a.m, b.m))
      .forEach((x, i) => out.set(x.hash, `${key}#${i}`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generator names of new solids

/** Sketch curves with stable keys: the entity id, plus the side for rectangles. */
export function keyedCurves(s: Sketch): { key: string; curve: Curve }[] {
  const curves = sketchCurves(s);
  const count = new Map<string, number>();
  for (const c of curves) count.set(c.source, (count.get(c.source) ?? 0) + 1);
  const seen = new Map<string, number>();
  return curves.map((curve) => {
    const i = seen.get(curve.source) ?? 0;
    seen.set(curve.source, i + 1);
    return { key: count.get(curve.source)! > 1 ? `${curve.source}.${i}` : curve.source, curve };
  });
}
function distanceToCurve(c: Curve, p: Vec2): number {
  if (c.kind === "bezier") {
    let best = Infinity;
    for (let i = 0; i <= 64; i++) {
      const q = bezierPoint(c.p, i / 64);
      best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    // Refine around the closest sample.
    return best;
  }
  if (c.kind === "line") {
    const d: Vec2 = [c.b[0] - c.a[0], c.b[1] - c.a[1]];
    const l2 = d[0] * d[0] + d[1] * d[1];
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - c.a[0]) * d[0] + (p[1] - c.a[1]) * d[1]) / l2)) : 0;
    return Math.hypot(p[0] - c.a[0] - d[0] * t, p[1] - c.a[1] - d[1] * t);
  }
  const radial = Math.abs(Math.hypot(p[0] - c.center[0], p[1] - c.center[1]) - c.radius);
  if (c.kind === "circle") return radial;
  const TAU = Math.PI * 2;
  let d = (Math.atan2(p[1] - c.center[1], p[0] - c.center[0]) - c.start) % TAU;
  if (d < 0) d += TAU;
  const from = c.sweep >= 0 ? d : (TAU - d) % TAU;
  if (from <= Math.abs(c.sweep) + 1e-9) return radial;
  const at = (t: number): Vec2 => [c.center[0] + c.radius * Math.cos(t), c.center[1] + c.radius * Math.sin(t)];
  const a = at(c.start),
    b = at(c.start + c.sweep);
  return Math.min(Math.hypot(p[0] - a[0], p[1] - a[1]), Math.hypot(p[0] - b[0], p[1] - b[1]));
}
export interface ProfilePlane {
  origin: Vec3;
  xDir: Vec3;
  yDir: Vec3;
  normal: Vec3;
}
/**
 * Names of a swept solid (extrusion, revolution, loft, sweep): the face lying in
 * the profile plane is `start`, each face whose boundary runs along a profile
 * curve is `side:<curve>`, and the remaining caps are `end`. `back` maps a point
 * of the solid to where it was generated (undoing a rotation applied afterwards).
 */
export function profileNames(
  solid: r.Shape3D,
  featureId: string,
  sketch: Sketch,
  plane: ProfilePlane,
  back: (p: Vec3) => Vec3 = (p) => p,
): Names {
  const curves = keyedCurves(sketch);
  const tol = TOL * Math.max(1, len(sub(...solid.boundingBox.bounds)));
  const inPlane = (p: Vec3) => Math.abs(dot(sub(p, plane.origin), plane.normal)) < tol;
  const local = (p: Vec3): Vec2 => [dot(sub(p, plane.origin), plane.xDir), dot(sub(p, plane.origin), plane.yDir)];
  const named: { face: r.Face; name: string }[] = [];
  for (const face of solid.faces) {
    let name: string | undefined;
    const normal = back(face.normalAt().toTuple()),
      zero = back([0, 0, 0]);
    if (
      face.geomType === "PLANE" &&
      inPlane(back(centroid(face))) &&
      Math.abs(dot(unit(sub(normal, zero)), plane.normal)) > 0.9999
    )
      name = "start";
    else
      for (const edge of face.edges) {
        const points = [0.2, 0.5, 0.8].map((t) => back(edge.pointAt(t).toTuple()));
        if (!points.every(inPlane)) continue;
        let best: { key: string; d: number } | undefined;
        for (const { key, curve } of curves) {
          const d = Math.max(...points.map((p) => distanceToCurve(curve, local(p))));
          if (d < tol * 10 && (!best || d < best.d)) best = { key, d };
        }
        if (best) {
          name = `side:${best.key}`;
          break;
        }
      }
    named.push({ face, name: `${featureId}:${name ?? "end"}` });
  }
  return finalize(named);
}
/**
 * Names of a primitive tool along `direction` (a hole's drill, counterbore,
 * countersink or tip): the curved wall is `base`; the flat caps are `base-top`
 * (entry side) and `base-bottom`.
 */
export function toolNames(solid: r.Shape3D, base: string, direction: Vec3): Names {
  const out: Names = new Map();
  const caps = solid.faces.filter((f) => f.geomType === "PLANE");
  caps.sort((a, b) => dot(centroid(a), direction) - dot(centroid(b), direction));
  for (const face of solid.faces) if (face.geomType !== "PLANE") out.set(face.hashCode, base);
  caps.forEach((face, i) => out.set(face.hashCode, `${base}-${i === 0 ? "top" : i === caps.length - 1 ? "bottom" : i}`));
  return out;
}
/** Feature that created a named face. */
export const ownerOf = (name: string) => name.slice(0, name.indexOf(":"));
