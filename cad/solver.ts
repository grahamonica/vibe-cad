// Geometric constraint solver for 2D sketches. Variables are entity values;
// each constraint contributes residual equations. Connected groups are solved
// independently with damped Gauss-Newton (Levenberg-Marquardt) from the current
// geometry, so under-constrained sketches move as little as possible.
import type { Sketch, Entity, Constraint, Vec2 } from "./types.ts";
import { point, circumcircle, anchorsFor, splineDistance } from "./sketch-geometry.ts";
export { point } from "./sketch-geometry.ts";

export const entityFields: Record<Entity["type"], string[]> = {
  point: ["x", "y"],
  rectangle: ["x", "y", "width", "height"],
  circle: ["x", "y", "radius"],
  line: ["x1", "y1", "x2", "y2"],
  arc: ["x1", "y1", "xm", "ym", "x2", "y2"],
  // Splines carry any number of fit points; see fieldsOf.
  spline: [],
};
/** Value keys of an entity: fixed per type, or x0, y0 … per fit point for splines. */
export function fieldsOf(e: Pick<Entity, "type" | "values">): string[] {
  if (e.type !== "spline") return entityFields[e.type];
  const out: string[] = [];
  for (let i = 0; `x${i}` in e.values; i++) out.push(`x${i}`, `y${i}`);
  // A trimmed spline keeps the parameter range of its kept part.
  if ("from" in e.values || "to" in e.values) out.push("from", "to");
  return out;
}

export const constraintTypes = [
  "horizontal",
  "vertical",
  "coincident",
  "distance",
  "length",
  "angle",
  "equal",
  "parallel",
  "perpendicular",
  "collinear",
  "concentric",
  "tangent",
  "midpoint",
  "pointOn",
  "symmetric",
  "fixed",
  "dimension",
  "radius",
  "diameter",
  "offset",
  "pattern",
] as const;

const norm = (v: Vec2) => Math.hypot(v[0], v[1]);
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const vec = (e: Entity): Vec2 => [
  e.values.x2 - e.values.x1,
  e.values.y2 - e.values.y1,
];
const isRound = (e: Entity) => e.type === "circle" || e.type === "arc";
function round(e: Entity): { center: Vec2; radius: number } {
  if (e.type === "circle")
    return { center: [e.values.x, e.values.y], radius: e.values.radius };
  const v = e.values;
  return (
    circumcircle([v.x1, v.y1], [v.xm, v.ym], [v.x2, v.y2]) ?? {
      center: [(v.x1 + v.x2) / 2, (v.y1 + v.y2) / 2],
      radius: 1e6,
    }
  );
}
/** Signed perpendicular distance from p to the infinite line through e. */
function lineDistance(p: Vec2, e: Entity) {
  const u = vec(e),
    l = Math.max(norm(u), 1e-9);
  return cross(u, sub(p, [e.values.x1, e.values.y1])) / l;
}
const signOf = (n: number) => (n < 0 ? -1 : 1);
const twoEntity = new Set([
  "coincident",
  "distance",
  "angle",
  "equal",
  "parallel",
  "perpendicular",
  "collinear",
  "concentric",
  "tangent",
  "midpoint",
  "pointOn",
]);

export function validateConstraint(s: Sketch, c: Constraint) {
  const es = c.entityIds.map((id) => s.entities.find((e) => e.id === id));
  if (es.some((e) => !e)) throw Error("Unknown constraint entity");
  const [a, b, axis] = es as Entity[];
  if (!(constraintTypes as readonly string[]).includes(c.type))
    throw Error(`Unknown constraint ${c.type}`);
  const count = c.entityIds.length;
  if (twoEntity.has(c.type) && count !== 2)
    throw Error(`${c.type} requires two entities`);
  if (
    ["length", "fixed", "dimension", "radius", "diameter"].includes(c.type) &&
    count !== 1
  )
    throw Error(`${c.type} requires one entity`);
  if (
    (c.type === "horizontal" || c.type === "vertical") &&
    !(
      (count === 1 && a.type === "line") ||
      (count === 2 && c.anchors?.length === 2)
    )
  )
    throw Error(`${c.type} requires a line or two points`);
  if (c.type === "offset") {
    if (count < 2 || count % 2) throw Error("Offset pairs each source with its copy");
    for (let i = 0; i < count; i += 2) {
      const [src, copy] = [es[i]!, es[i + 1]!];
      const family = (e: Entity) => (isRound(e) ? "round" : e.type);
      if (family(src) !== family(copy) || !["line", "round", "rectangle"].includes(family(src)))
        throw Error("Offset pairs lines, circles, arcs or rectangles with copies of the same kind");
    }
    if (!((c.value ?? 0) > 0)) throw Error("Offset distance must be positive");
  }
  if (c.type === "pattern") {
    const p = c.pattern;
    if (!p || p.count < 2 || p.count > 200 || p.sources < 1) throw Error("Pattern needs a count of at least 2 and source geometry");
    const offset = p.kind === "circular" ? 1 : 0;
    if (count !== offset + p.sources * p.count) throw Error("Pattern entities do not match its count");
    for (let k = 1; k < p.count; k++)
      for (let j = 0; j < p.sources; j++) {
        const src = es[offset + j]!,
          copy = es[offset + k * p.sources + j]!;
        if (src.type !== copy.type || src.type === "rectangle" && p.kind === "circular")
          throw Error("Pattern copies must match their sources (rectangles pattern only along a line)");
      }
    if (!Number.isFinite(c.value) || (p.kind === "linear" ? (c.value ?? 0) <= 0 : !((c.value ?? 0) > 0 && (c.value ?? 0) <= 360)))
      throw Error(p.kind === "linear" ? "Pattern spacing must be positive" : "Pattern angle must be between 0 and 360 degrees");
  }
  if (c.type === "symmetric" && count !== 2 && count !== 3)
    throw Error("Symmetric requires two entities and an optional line");
  if (c.type === "symmetric" && count === 3 && axis.type !== "line")
    throw Error("Symmetry axis must be a line");
  if (
    ["parallel", "perpendicular", "collinear", "angle"].includes(c.type) &&
    es.some((e) => e?.type !== "line")
  )
    throw Error(`${c.type} requires lines`);
  if (c.type === "length" && a.type !== "line")
    throw Error("Length requires a line");
  if (c.type === "concentric" && !(isRound(a) && isRound(b)))
    throw Error("Concentric requires circles or arcs");
  if (
    c.type === "equal" &&
    !(
      (a.type === "line" && b.type === "line") ||
      (isRound(a) && isRound(b))
    )
  )
    throw Error("Equal requires two lines or two circles/arcs");
  if (
    c.type === "tangent" &&
    !(
      (isRound(a) && (isRound(b) || b.type === "line")) ||
      (isRound(b) && a.type === "line")
    )
  )
    throw Error("Tangent requires a circle or arc and a line, circle or arc");
  if ((c.type === "radius" || c.type === "diameter") && !isRound(a))
    throw Error(`${c.type} requires a circle or arc`);
  if (c.type === "midpoint" && b.type !== "line")
    throw Error("Midpoint requires a point and a line");
  if (c.type === "pointOn" && !(b.type === "line" || b.type === "spline" || isRound(b)))
    throw Error("Point on requires a line, circle, arc or spline");
  if (c.type === "dimension" && !fieldsOf(a).includes(c.dimension ?? ""))
    throw Error("Unknown dimension");
  if (
    ["distance", "dimension", "length", "angle", "radius", "diameter", "offset", "pattern"].includes(
      c.type,
    ) &&
    !Number.isFinite(c.value)
  )
    throw Error("Constraint requires a finite value");
  if (
    ["length", "radius", "diameter"].includes(c.type) &&
    (c.value ?? 0) <= 0
  )
    throw Error(`${c.type} must be positive`);
  if (c.type === "angle" && !((c.value ?? 0) > 0 && (c.value ?? 0) < 180))
    throw Error("Angle must be between 0 and 180 degrees");
  for (let i = 0; i < (c.anchors?.length ?? 0); i++) {
    const e = es[i];
    if (!e) throw Error("Too many anchors");
    if (c.anchors![i] === "curve" && ["line", "arc", "circle"].includes(e.type))
      continue;
    // Spline fit points are anchors p0, p1, ….
    const fit = e.type === "spline" && /^p(\d+)$/.exec(c.anchors![i]);
    if (fit && `x${fit[1]}` in e.values) continue;
    if (!anchorsFor(e.type).includes(c.anchors![i]))
      throw Error(`Invalid ${e.type} anchor`);
  }
}

/** Residual equations of one constraint (zero when satisfied). */
function residual(c: Constraint, lookup: Map<string, Entity>): number[] {
  const es = c.entityIds.map((id) => {
    const e = lookup.get(id);
    if (!e) throw Error(`Constraint ${c.id} references missing entity ${id}`);
    return e;
  });
  const [a, b] = es;
  const p = point(a, c.anchors?.[0]);
  const q = b ? point(b, c.anchors?.[1]) : ([0, 0] as Vec2);
  const ref = c.reference ?? [];
  switch (c.type) {
    case "dimension":
      return [a.values[c.dimension!] - c.value!];
    case "fixed":
      return fieldsOf(a).map((key, i) => a.values[key] - ref[i]);
    case "horizontal":
      return b ? [p[1] - q[1]] : [a.values.y2 - a.values.y1];
    case "vertical":
      return b ? [p[0] - q[0]] : [a.values.x2 - a.values.x1];
    case "coincident":
    case "concentric": {
      if (c.type === "concentric") {
        const ca = round(a).center,
          cb = round(b).center;
        return [ca[0] - cb[0], ca[1] - cb[1]];
      }
      return [p[0] - q[0], p[1] - q[1]];
    }
    case "midpoint": {
      const m = point(b, "center");
      return [p[0] - m[0], p[1] - m[1]];
    }
    case "pointOn": {
      if (b.type === "line") return [lineDistance(p, b)];
      if (b.type === "spline") return [splineDistance(b, p)];
      const r = round(b);
      return [norm(sub(p, r.center)) - r.radius];
    }
    case "distance": {
      if (c.axis) {
        const k = c.axis === "x" ? 0 : 1;
        // Legacy constraints store a signed offset; new ones store magnitude and orientation.
        return ref.length
          ? [ref[0] * (p[k] - q[k]) - c.value!]
          : [p[k] - q[k] - c.value!];
      }
      if (b.type === "line" && (!c.anchors?.[1] || c.anchors[1] === "curve")) {
        const from = a.type === "line" && !c.anchors?.[0] ? point(a, "center") : p;
        const d = lineDistance(from, b);
        return [(ref[0] ?? signOf(d)) * d - c.value!];
      }
      if (isRound(b) && c.anchors?.[1] === "curve") {
        const r = round(b);
        return [Math.abs(norm(sub(p, r.center)) - r.radius) - c.value!];
      }
      return [norm(sub(p, q)) - c.value!];
    }
    case "length":
      return [norm(vec(a)) - c.value!];
    case "radius":
      return [round(a).radius - c.value!];
    case "diameter":
      return [2 * round(a).radius - c.value!];
    case "angle": {
      const u = vec(a),
        v = vec(b),
        scale = Math.max(norm(u) * norm(v), 1e-9);
      const target = ((ref[0] ?? 1) * c.value! * Math.PI) / 180;
      // sin(theta - target) vanishes at the stored orientation.
      return [
        ((cross(u, v) * Math.cos(target) - dot(u, v) * Math.sin(target)) /
          scale) *
          10,
      ];
    }
    case "equal":
      return [
        isRound(a)
          ? round(a).radius - round(b).radius
          : norm(vec(a)) - norm(vec(b)),
      ];
    case "parallel":
    case "perpendicular": {
      const u = vec(a),
        v = vec(b),
        scale = Math.max(norm(u) * norm(v), 1);
      return [
        ((c.type === "parallel" ? cross(u, v) : dot(u, v)) / scale) * 10,
      ];
    }
    case "collinear":
      return [
        lineDistance([b.values.x1, b.values.y1], a),
        lineDistance([b.values.x2, b.values.y2], a),
      ];
    case "symmetric": {
      if (es.length === 3) {
        const axis = es[2],
          m: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2],
          u = vec(axis),
          l = Math.max(norm(u), 1e-9);
        return [lineDistance(m, axis), dot(sub(p, q), u) / l];
      }
      const k = c.axis === "y" ? 1 : 0;
      return [p[k] + q[k] - 2 * (c.value ?? 0), p[1 - k] - q[1 - k]];
    }
    case "offset": {
      const out: number[] = [];
      for (let i = 0; i < es.length; i += 2) {
        const src = es[i],
          copy = es[i + 1],
          side = ref[i / 2] ?? 1,
          d = side * c.value!;
        if (src.type === "line")
          out.push(lineDistance([copy.values.x1, copy.values.y1], src) - d, lineDistance([copy.values.x2, copy.values.y2], src) - d);
        else if (src.type === "rectangle")
          out.push(
            copy.values.x - src.values.x,
            copy.values.y - src.values.y,
            copy.values.width - src.values.width - 2 * d,
            copy.values.height - src.values.height - 2 * d,
          );
        else {
          const rs = round(src),
            rc = round(copy);
          out.push(rc.center[0] - rs.center[0], rc.center[1] - rs.center[1], rc.radius - rs.radius - d);
        }
      }
      return out;
    }
    case "pattern": {
      const pt = c.pattern!,
        offset = pt.kind === "circular" ? 1 : 0;
      const center = pt.kind === "circular" ? point(es[0], "center") : ([0, 0] as Vec2);
      // Instance k moves a source point by k steps.
      const move = (q: Vec2, k: number): Vec2 => {
        if (pt.kind === "linear") {
          const t = ((pt.angle ?? 0) * Math.PI) / 180;
          return [q[0] + k * c.value! * Math.cos(t), q[1] + k * c.value! * Math.sin(t)];
        }
        const full = Math.abs(c.value! - 360) < 1e-9;
        const t = (k * c.value! * Math.PI) / 180 / (full ? pt.count : pt.count - 1),
          d = sub(q, center);
        return [center[0] + d[0] * Math.cos(t) - d[1] * Math.sin(t), center[1] + d[0] * Math.sin(t) + d[1] * Math.cos(t)];
      };
      const out: number[] = [];
      for (let k = 1; k < pt.count; k++)
        for (let j = 0; j < pt.sources; j++) {
          const src = es[offset + j],
            copy = es[offset + k * pt.sources + j];
          const anchors =
            src.type === "line"
              ? ["start", "end"]
              : src.type === "arc"
                ? ["start", "mid", "end"]
                : src.type === "rectangle"
                  ? ["bottomLeft", "topRight"]
                  : src.type === "spline"
                    ? fieldsOf(src).filter((f) => f[0] === "x").map((f) => `p${f.slice(1)}`)
                    : ["center"];
          for (const anchor of anchors) {
            const target = move(point(src, anchor), k),
              actual = point(copy, anchor);
            out.push(actual[0] - target[0], actual[1] - target[1]);
          }
          if (src.type === "circle") out.push(copy.values.radius - src.values.radius);
          if (src.type === "spline" && "from" in src.values) out.push(copy.values.from - src.values.from, copy.values.to - src.values.to);
        }
      return out;
    }
    case "tangent": {
      if (a.type === "line" || b.type === "line") {
        const line = a.type === "line" ? a : b,
          r = round(a.type === "line" ? b : a);
        return [Math.abs(lineDistance(r.center, line)) - r.radius];
      }
      const ra = round(a),
        rb = round(b),
        d = norm(sub(ra.center, rb.center));
      // Internal tangency when one circle encloses the other.
      return ref[0] === -1 ||
        (ref.length === 0 && d < Math.abs(ra.radius - rb.radius))
        ? [d - Math.abs(ra.radius - rb.radius)]
        : [d - ra.radius - rb.radius];
    }
  }
  return [];
}

/** Implicit equations of an entity itself. A three-point arc keeps its middle
 * point on the perpendicular bisector so it contributes five, not six, freedoms. */
function implicit(e: Entity): number[] {
  if (e.type !== "arc") return [];
  const v = e.values;
  return [
    Math.hypot(v.xm - v.x1, v.ym - v.y1) - Math.hypot(v.xm - v.x2, v.ym - v.y2),
  ];
}

/** Orientation data captured when a constraint is created, so later solves keep the configuration. */
export function captureReference(s: Sketch, c: Constraint) {
  const lookup = new Map(s.entities.map((e) => [e.id, e]));
  const es = c.entityIds.map((id) => lookup.get(id)!);
  const [a, b] = es;
  if (c.type === "fixed") {
    c.reference = fieldsOf(a).map((k) => a.values[k]);
  } else if (c.type === "angle") {
    c.reference = [signOf(cross(vec(a), vec(b)))];
  } else if (c.type === "distance" && c.axis && c.reference === undefined) {
    const p = point(a, c.anchors?.[0]),
      q = point(b, c.anchors?.[1]),
      k = c.axis === "x" ? 0 : 1;
    if ((c.value ?? 0) >= 0) c.reference = [signOf(p[k] - q[k])];
  } else if (
    c.type === "distance" &&
    b?.type === "line" &&
    (!c.anchors?.[1] || c.anchors[1] === "curve")
  ) {
    const from = a.type === "line" && !c.anchors?.[0] ? point(a, "center") : point(a, c.anchors?.[0]);
    c.reference = [signOf(lineDistance(from, b))];
  } else if (c.type === "offset") {
    // Which side each copy lies on.
    c.reference = [];
    for (let i = 0; i < es.length; i += 2) {
      const src = es[i],
        copy = es[i + 1];
      c.reference.push(
        src.type === "line"
          ? signOf(lineDistance(point(copy, "center"), src))
          : src.type === "rectangle"
            ? signOf(copy.values.width - src.values.width)
            : signOf(round(copy).radius - round(src).radius),
      );
    }
  } else if (c.type === "tangent" && isRound(a) && isRound(b)) {
    const ra = round(a),
      rb = round(b),
      d = norm(sub(ra.center, rb.center));
    c.reference = [d < Math.abs(ra.radius - rb.radius) + 1e-9 ? -1 : 1];
  }
}

/** Current measured value of a dimensional constraint, for display or driven dimensions. */
export function measureConstraint(s: Sketch, c: Constraint): number | undefined {
  const lookup = new Map(s.entities.map((e) => [e.id, e]));
  const es = c.entityIds.map((id) => lookup.get(id));
  if (es.some((e) => !e)) return undefined;
  const [a, b] = es as Entity[];
  const p = point(a, c.anchors?.[0]);
  switch (c.type) {
    case "dimension":
      return a.values[c.dimension!];
    case "length":
      return norm(vec(a));
    case "radius":
      return round(a).radius;
    case "diameter":
      return round(a).radius * 2;
    case "pattern": {
      const pt = c.pattern!;
      if (pt.kind === "circular") return c.value;
      const src = es[0]!,
        copy = es[pt.sources]!,
        p0 = point(src, src.type === "line" ? "start" : src.type === "rectangle" ? "bottomLeft" : src.type === "arc" ? "start" : "center"),
        p1 = point(copy, copy.type === "line" ? "start" : copy.type === "rectangle" ? "bottomLeft" : copy.type === "arc" ? "start" : "center");
      return norm(sub(p1, p0));
    }
    case "offset":
      return a.type === "line"
        ? Math.abs(lineDistance(point(b, "center"), a))
        : a.type === "rectangle"
          ? Math.abs(b.values.width - a.values.width) / 2
          : Math.abs(round(b).radius - round(a).radius);
    case "angle": {
      const u = vec(a),
        v = vec(b);
      return (Math.atan2(Math.abs(cross(u, v)), dot(u, v)) * 180) / Math.PI;
    }
    case "distance": {
      if (c.axis) {
        const q = point(b, c.anchors?.[1]),
          k = c.axis === "x" ? 0 : 1;
        return Math.abs(p[k] - q[k]);
      }
      if (b.type === "line" && (!c.anchors?.[1] || c.anchors[1] === "curve"))
        return Math.abs(
          lineDistance(a.type === "line" && !c.anchors?.[0] ? point(a, "center") : p, b),
        );
      return norm(sub(p, point(b, c.anchors?.[1])));
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Numerical core

interface Block {
  entities: Entity[];
  f: () => number[];
  weight: number;
  soft?: boolean;
}

function solveDense(a: number[][], b: number[]): number[] {
  const n = b.length,
    m = a.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++)
      if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;
    [m[i], m[pivot]] = [m[pivot], m[i]];
    const d = m[i][i];
    if (Math.abs(d) < 1e-14) continue;
    for (let k = i; k <= n; k++) m[i][k] /= d;
    for (let j = i + 1; j < n; j++) {
      const f = m[j][i];
      if (f === 0) continue;
      for (let k = i; k <= n; k++) m[j][k] -= f * m[i][k];
    }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(m[i][i]) < 1e-14) continue;
    let sum = m[i][n];
    for (let k = i + 1; k < n; k++) sum -= m[i][k] * x[k];
    x[i] = sum;
  }
  return x;
}

export function matrixRank(rows: number[][], columns: number): number {
  if (!rows.length || !columns) return 0;
  const m = rows.map((r) => [...r]);
  const scale = Math.max(1e-12, ...m.flat().map(Math.abs));
  let rank = 0;
  for (let c = 0; c < columns && rank < m.length; c++) {
    let p = rank;
    for (let i = rank + 1; i < m.length; i++)
      if (Math.abs(m[i][c]) > Math.abs(m[p][c])) p = i;
    if (Math.abs(m[p][c]) < 1e-7 * scale) continue;
    [m[rank], m[p]] = [m[p], m[rank]];
    const d = m[rank][c];
    for (let j = c; j < columns; j++) m[rank][j] /= d;
    for (let i = rank + 1; i < m.length; i++) {
      const f = m[i][c];
      if (f === 0) continue;
      for (let j = c; j < columns; j++) m[i][j] -= f * m[rank][j];
    }
    rank++;
  }
  return rank;
}

/** Which variables are fixed by the rows (zero in every nullspace vector). */
export function determinedColumns(rows: number[][], columns: number): boolean[] {
  const result = new Array(columns).fill(false);
  if (!rows.length) return result;
  const m = rows.map((r) => [...r]);
  const scale = Math.max(1e-12, ...m.flat().map(Math.abs));
  const pivots: number[] = [];
  let rank = 0;
  for (let c = 0; c < columns && rank < m.length; c++) {
    let p = rank;
    for (let i = rank + 1; i < m.length; i++)
      if (Math.abs(m[i][c]) > Math.abs(m[p][c])) p = i;
    if (Math.abs(m[p][c]) < 1e-7 * scale) continue;
    [m[rank], m[p]] = [m[p], m[rank]];
    const d = m[rank][c];
    for (let j = 0; j < columns; j++) m[rank][j] /= d;
    for (let i = 0; i < m.length; i++) {
      if (i === rank) continue;
      const f = m[i][c];
      if (f === 0) continue;
      for (let j = 0; j < columns; j++) m[i][j] -= f * m[rank][j];
    }
    pivots.push(c);
    rank++;
  }
  const free = [...Array(columns).keys()].filter((c) => !pivots.includes(c));
  pivots.forEach((c, row) => {
    result[c] = free.every((f) => Math.abs(m[row][f]) < 1e-6);
  });
  return result;
}

interface Variable {
  e: Entity;
  key: string;
}

function evaluate(blocks: Block[], hardOnly = false) {
  const out: number[] = [];
  for (const b of blocks)
    if (!hardOnly || !b.soft) for (const r of b.f()) out.push(r * b.weight);
  return out;
}

/** Jacobian rows for blocks (sparse per block, assembled dense over vars). */
function jacobian(blocks: Block[], vars: Variable[], index: Map<string, number>, hardOnly = false) {
  const rows: number[][] = [];
  for (const block of blocks) {
    if (hardOnly && block.soft) continue;
    const base = block.f().map((r) => r * block.weight);
    const local = base.map(() => new Array(vars.length).fill(0));
    for (const e of block.entities)
      for (const key of fieldsOf(e)) {
        const k = index.get(`${e.id}\u0000${key}`);
        if (k === undefined) continue;
        const x = e.values[key],
          h = 1e-6 * Math.max(1, Math.abs(x));
        e.values[key] = x + h;
        const plus = block.f();
        e.values[key] = x - h;
        const minus = block.f();
        e.values[key] = x;
        plus.forEach((r, i) => (local[i][k] = ((r - minus[i]) * block.weight) / (2 * h)));
      }
    rows.push(...local);
  }
  return rows;
}

function levenberg(blocks: Block[], vars: Variable[], iterations: number) {
  if (!vars.length || !blocks.length) return;
  const index = new Map(vars.map((v, i) => [`${v.e.id}\u0000${v.key}`, i]));
  const get = () => vars.map((v) => v.e.values[v.key]);
  const set = (x: number[]) => vars.forEach((v, i) => (v.e.values[v.key] = x[i]));
  const cost = () => evaluate(blocks).reduce((s, r) => s + r * r, 0);
  let lambda = 1e-3,
    current = cost();
  for (let iter = 0; iter < iterations; iter++) {
    const res = evaluate(blocks);
    if (Math.max(0, ...evaluate(blocks, true).map(Math.abs)) < 1e-10 && !blocks.some((b) => b.soft))
      break;
    const j = jacobian(blocks, vars, index),
      n = vars.length;
    const a = Array.from({ length: n }, () => new Array(n).fill(0)),
      g = new Array(n).fill(0);
    j.forEach((row, r) => {
      const nz: number[] = [];
      row.forEach((v, i) => v !== 0 && nz.push(i));
      for (const i of nz) {
        g[i] -= row[i] * res[r];
        for (const k of nz) a[i][k] += row[i] * row[k];
      }
    });
    let improved = false;
    for (let attempt = 0; attempt < 8 && !improved; attempt++) {
      const damped = a.map((row, i) =>
        row.map((v, k) => (i === k ? v + lambda * (v + 1e-6) + 1e-12 : v)),
      );
      const delta = solveDense(damped, g),
        old = get();
      set(old.map((x, i) => x + delta[i]));
      const next = cost();
      if (Number.isFinite(next) && next < current) {
        current = next;
        lambda = Math.max(1e-12, lambda / 4);
        improved = true;
        if (Math.max(...delta.map(Math.abs)) < 1e-13) return;
      } else {
        set(old);
        lambda *= 8;
      }
    }
    if (!improved) return;
  }
}

export interface SolveOptions {
  /** Pull one entity anchor toward a sketch-plane target while keeping constraints exact. */
  drag?: { entityId: string; anchor?: string; target: Vec2 };
  /** Values the user just typed: kept as given when the relations allow it. */
  hold?: { entityId: string; keys: string[] }[];
}

export function solveSketch(s: Sketch, options: SolveOptions = {}): void {
  if (s.entities.length > 300 || s.constraints.length > 600)
    throw Error("Sketch exceeds 300 entities or 600 constraints");
  for (const c of s.constraints) validateConstraint(s, c);
  const lookup = new Map(s.entities.map((e) => [e.id, e]));
  const blocks: Block[] = [];
  for (const c of s.constraints) {
    if (c.driven) continue;
    blocks.push({
      entities: c.entityIds.map((id) => lookup.get(id)!),
      f: () => residual(c, lookup),
      weight: 1,
    });
  }
  for (const e of s.entities)
    if (e.type === "arc")
      blocks.push({ entities: [e], f: () => implicit(e), weight: 1 });
  // Connected entity groups are independent systems.
  const parent = new Map(s.entities.map((e) => [e.id, e.id]));
  const find = (x: string): string => {
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const b of blocks)
    for (const e of b.entities.slice(1))
      parent.set(find(e.id), find(b.entities[0].id));
  const groups = new Map<string, { entities: Entity[]; blocks: Block[] }>();
  for (const e of s.entities) {
    const key = find(e.id),
      g = groups.get(key) ?? { entities: [], blocks: [] };
    g.entities.push(e);
    groups.set(key, g);
  }
  for (const b of blocks) groups.get(find(b.entities[0].id))!.blocks.push(b);
  const drag = options.drag && lookup.get(options.drag.entityId);
  let dof = 0,
    worst = 0,
    redundant = 0;
  const free = new Set<string>();
  for (const group of groups.values()) {
    // Converted model edges are given, not solved for.
    const vars = group.entities
      .filter((e) => !e.projected)
      .flatMap((e) => fieldsOf(e).map((key) => ({ e, key })));
    if (drag && group.entities.includes(drag)) {
      const target = options.drag!.target,
        anchor = options.drag!.anchor;
      const soft: Block = {
        entities: [drag],
        f: () => {
          const p = point(drag, anchor);
          return [p[0] - target[0], p[1] - target[1]];
        },
        weight: 0.05,
        soft: true,
      };
      levenberg([...group.blocks, soft], vars, 30);
    }
    // Typed values hold while everything else adapts; if that cannot satisfy the
    // relations, every value may move.
    const held = new Set((options.hold ?? []).flatMap((h) => h.keys.map((k) => `${h.entityId}\u0000${k}`)));
    const movable = vars.filter((v) => !held.has(`${v.e.id}\u0000${v.key}`));
    if (movable.length < vars.length) {
      const before = vars.map((v) => v.e.values[v.key]);
      levenberg(group.blocks, movable, 100);
      if (Math.max(0, ...evaluate(group.blocks).map(Math.abs)) > 1e-7) vars.forEach((v, i) => (v.e.values[v.key] = before[i]));
    }
    levenberg(group.blocks, vars, 100);
    const res = evaluate(group.blocks);
    worst = Math.max(worst, ...res.map(Math.abs));
    if (group.blocks.length) {
      const index = new Map(vars.map((v, i) => [`${v.e.id}\u0000${v.key}`, i]));
      const j = jacobian(group.blocks, vars, index);
      const rank = matrixRank(j, vars.length);
      dof += vars.length - rank;
      redundant += j.length - rank;
      if (rank < vars.length) {
        const fixed = determinedColumns(j, vars.length);
        vars.forEach((v, i) => {
          if (!fixed[i]) free.add(v.e.id);
        });
      }
    } else {
      dof += vars.length;
      for (const e of group.entities) if (!e.projected) free.add(e.id);
    }
  }
  if (!Number.isFinite(worst) || worst > 1e-5)
    throw Error(
      `Conflicting constraints (residual ${worst.toPrecision(3)} mm). Change rejected.`,
    );
  for (const e of s.entities) {
    for (const key of fieldsOf(e)) {
      const v = e.values[key];
      if (!Number.isFinite(v) || Math.abs(v) > 10000)
        throw Error("Sketch dimensions must be finite and within ±10000 mm");
      if (["radius", "width", "height"].includes(key) && v <= 0)
        throw Error(`${key} must be positive`);
    }
    if (e.type === "line" && norm(vec(e)) < 1e-6)
      throw Error("A line cannot have zero length");
    if (e.type === "arc") {
      const v = e.values,
        area = (v.xm - v.x1) * (v.y2 - v.y1) - (v.ym - v.y1) * (v.x2 - v.x1);
      if (Math.abs(area) < 1e-8) throw Error("Arc points must not be collinear");
    }
  }
  s.solver = {
    dof,
    residual: worst,
    status: dof === 0 ? "fully-constrained" : "under-constrained",
    ...(redundant > 0 ? { redundant } : {}),
    ...(free.size ? { free: [...free] } : {}),
  };
}
