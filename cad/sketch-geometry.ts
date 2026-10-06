// Shared 2D sketch geometry: entity anchors, arc math, curve intersections and
// planar region detection. Used by the solver, the kernel and the editor.
import type { Entity, Sketch, Vec2 } from "./types.ts";

export const TAU = Math.PI * 2;
const hypot = (x: number, y: number) => Math.hypot(x, y);

/** Circumcircle of three points, or undefined when they are collinear. */
export function circumcircle(
  a: Vec2,
  b: Vec2,
  c: Vec2,
): { center: Vec2; radius: number } | undefined {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return undefined;
  const aa = a[0] ** 2 + a[1] ** 2,
    bb = b[0] ** 2 + b[1] ** 2,
    cc = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / d,
    (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / d,
  ];
  return { center, radius: hypot(a[0] - center[0], a[1] - center[1]) };
}

const norm = (a: number) => ((a % TAU) + TAU) % TAU;

/** Three-point arc as center/radius and a counter-clockwise angular span. */
export function arcGeometry(e: Entity) {
  const v = e.values,
    a: Vec2 = [v.x1, v.y1],
    m: Vec2 = [v.xm, v.ym],
    b: Vec2 = [v.x2, v.y2];
  const circle = circumcircle(a, m, b);
  if (!circle) return undefined;
  const { center, radius } = circle,
    angle = (p: Vec2) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const ta = angle(a),
    tm = angle(m),
    tb = angle(b);
  // Counter-clockwise from a reaches m before b?
  const ccw = norm(tm - ta) < norm(tb - ta);
  const start = ccw ? ta : tb,
    sweep = ccw ? norm(tb - ta) : norm(ta - tb);
  return { center, radius, start, sweep: sweep || TAU, ccw };
}

// ---------------------------------------------------------------------------
// Splines: cubic Bézier spans through fit points

export type Bez = [Vec2, Vec2, Vec2, Vec2];
/** Fit points of a spline, in order. */
export function fitPoints(e: Entity): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; `x${i}` in e.values; i++) out.push([e.values[`x${i}`], e.values[`y${i}`]]);
  return out;
}
/**
 * Cubic Bézier spans of a spline through its fit points, with Catmull-Rom
 * tangents. A spline whose last point repeats its first is closed and smooth
 * all the way round.
 */
export function splineSpans(points: Vec2[]): Bez[] {
  const n = points.length;
  if (n < 2) return [];
  const closed = n > 3 && hypot(points[0][0] - points[n - 1][0], points[0][1] - points[n - 1][1]) < 1e-9;
  const at = (i: number): Vec2 =>
    closed && i < 0
      ? points[n - 2]
      : closed && i >= n
        ? points[1]
        : i < 0
      ? [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]]
      : i >= n
        ? [2 * points[n - 1][0] - points[n - 2][0], 2 * points[n - 1][1] - points[n - 2][1]]
        : points[i];
  const spans: Bez[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const p0 = at(i),
      p3 = at(i + 1),
      a = at(i - 1),
      b = at(i + 2);
    spans.push([p0, [p0[0] + (p3[0] - a[0]) / 6, p0[1] + (p3[1] - a[1]) / 6], [p3[0] - (b[0] - p0[0]) / 6, p3[1] - (b[1] - p0[1]) / 6], p3]);
  }
  return spans;
}
export function bezierPoint(b: Bez, t: number): Vec2 {
  const u = 1 - t,
    w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [w[0] * b[0][0] + w[1] * b[1][0] + w[2] * b[2][0] + w[3] * b[3][0], w[0] * b[0][1] + w[1] * b[1][1] + w[2] * b[2][1] + w[3] * b[3][1]];
}
export function bezierTangent(b: Bez, t: number): Vec2 {
  const u = 1 - t;
  return [
    3 * (u * u * (b[1][0] - b[0][0]) + 2 * u * t * (b[2][0] - b[1][0]) + t * t * (b[3][0] - b[2][0])),
    3 * (u * u * (b[1][1] - b[0][1]) + 2 * u * t * (b[2][1] - b[1][1]) + t * t * (b[3][1] - b[2][1])),
  ];
}
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** The part of a Bézier between parameters t0 and t1 (de Casteljau). */
export function splitBezier(b: Bez, t0: number, t1: number): Bez {
  const cut = (c: Bez, t: number): [Bez, Bez] => {
    const ab = lerp(c[0], c[1], t),
      bc = lerp(c[1], c[2], t),
      cd = lerp(c[2], c[3], t),
      abc = lerp(ab, bc, t),
      bcd = lerp(bc, cd, t),
      m = lerp(abc, bcd, t);
    return [
      [c[0], ab, abc, m],
      [m, bcd, cd, c[3]],
    ];
  };
  const left = t1 < 1 ? cut(b, t1)[0] : b;
  return t0 > 0 ? cut(left, t0 / t1)[1] : left;
}
/** Closest parameter on a Bézier to a point. */
function bezierClosest(b: Bez, p: Vec2): number {
  let best = 0,
    bestD = Infinity;
  for (let i = 0; i <= 32; i++) {
    const q = bezierPoint(b, i / 32),
      d = hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bestD) {
      bestD = d;
      best = i / 32;
    }
  }
  // Newton on (B(t) − p) · B'(t) = 0.
  for (let k = 0; k < 20; k++) {
    const q = bezierPoint(b, best),
      d = bezierTangent(b, best),
      h = 1e-6,
      d2 = bezierTangent(b, Math.min(1, best + h));
    const f = (q[0] - p[0]) * d[0] + (q[1] - p[1]) * d[1];
    const df = d[0] * d[0] + d[1] * d[1] + (q[0] - p[0]) * (d2[0] - d[0]) / h + (q[1] - p[1]) * (d2[1] - d[1]) / h;
    if (Math.abs(df) < 1e-18) break;
    const next = Math.max(0, Math.min(1, best - f / df));
    if (Math.abs(next - best) < 1e-14) break;
    best = next;
  }
  return best;
}

/** Whether a spline's last fit point repeats its first. */
export function splineClosed(points: Vec2[]) {
  const n = points.length - 1;
  return n > 2 && hypot(points[0][0] - points[n][0], points[0][1] - points[n][1]) < 1e-9;
}
/**
 * Parameter range of the part of a spline that is kept, in span units (fit
 * point i sits at i). Trimming narrows the range instead of refitting, so the
 * kept curve is exactly the original. A closed spline's range may run past its
 * seam.
 */
export function splineRange(e: Entity): [number, number] {
  return "from" in e.values ? [e.values.from, e.values.to] : [0, fitPoints(e).length - 1];
}
/** Point at a global parameter; closed splines wrap round. */
export function splineAt(points: Vec2[], u: number): Vec2 {
  const spans = splineSpans(points),
    n = spans.length;
  if (splineClosed(points) && (u < 0 || u > n)) u = ((u % n) + n) % n;
  const i = Math.max(0, Math.min(n - 1, Math.floor(u)));
  return bezierPoint(spans[i], Math.max(0, Math.min(1, u - i)));
}
/** Global parameter (0 … number of spans) of the closest point on the full spline. */
export function splineParam(points: Vec2[], p: Vec2): number {
  let best = 0,
    bestD = Infinity;
  splineSpans(points).forEach((b, i) => {
    const t = bezierClosest(b, p),
      q = bezierPoint(b, t),
      d = hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bestD) {
      bestD = d;
      best = i + t;
    }
  });
  return best;
}
/** Signed distance from p to the kept curve of a spline (left of the direction of travel is positive). */
export function splineDistance(e: Entity, p: Vec2): number {
  let best = Infinity,
    signed = 0;
  for (const b of splineBeziers(e)) {
    const t = bezierClosest(b, p),
      q = bezierPoint(b, t),
      d = hypot(q[0] - p[0], q[1] - p[1]);
    if (d < best) {
      const tan = bezierTangent(b, t),
        l = hypot(tan[0], tan[1]) || 1;
      best = d;
      signed = (tan[0] * (p[1] - q[1]) - tan[1] * (p[0] - q[0])) / l;
    }
  }
  return signed;
}
/** Exact Bézier spans of the kept part of a spline. */
export function splineBeziers(e: Entity): Bez[] {
  const points = fitPoints(e),
    spans = splineSpans(points),
    n = spans.length;
  if (!n) return [];
  let [from, to] = splineRange(e);
  if (!splineClosed(points)) {
    from = Math.max(0, Math.min(n, from));
    to = Math.max(0, Math.min(n, to));
  }
  const out: Bez[] = [];
  for (let u = from; u < to - 1e-9; ) {
    const k = Math.floor(u + 1e-9),
      next = Math.min(to, k + 1),
      t0 = Math.max(0, u - k),
      t1 = Math.min(1, next - k),
      span = spans[((k % n) + n) % n];
    out.push(t0 < 1e-9 && t1 > 1 - 1e-9 ? span : splitBezier(span, t0, t1));
    u = next;
  }
  return out;
}
/** Points where two sketch entities cross. */
export function entityIntersections(a: Entity, b: Entity, tol = 1e-6): Vec2[] {
  const curves = (e: Entity) => sketchCurves({ entities: [{ ...e, construction: false }] } as unknown as Sketch);
  return curves(a).flatMap((x) => curves(b).flatMap((y) => intersect(x, y, tol)));
}

/** Named reference points on sketch entities used by constraints and snapping. */
export function point(e: Entity, anchor = "center"): Vec2 {
  const v = e.values;
  switch (e.type) {
    case "point":
      return [v.x, v.y];
    case "line":
      if (anchor === "start") return [v.x1, v.y1];
      if (anchor === "end") return [v.x2, v.y2];
      return [(v.x1 + v.x2) / 2, (v.y1 + v.y2) / 2];
    case "arc":
      if (anchor === "start") return [v.x1, v.y1];
      if (anchor === "end") return [v.x2, v.y2];
      if (anchor === "mid") return [v.xm, v.ym];
      return (
        circumcircle([v.x1, v.y1], [v.xm, v.ym], [v.x2, v.y2])?.center ?? [
          (v.x1 + v.x2) / 2,
          (v.y1 + v.y2) / 2,
        ]
      );
    case "spline": {
      const pts = fitPoints(e),
        [from, to] = splineRange(e);
      const m = /^p(\d+)$/.exec(anchor);
      if (m && pts[Number(m[1])]) return pts[Number(m[1])];
      if (pts.length < 2) return pts[0] ?? [0, 0];
      // The ends of the kept curve, or its middle.
      return splineAt(pts, anchor === "start" ? from : anchor === "end" ? to : (from + to) / 2);
    }
    case "rectangle": {
      const signs: Record<string, Vec2> = {
        topLeft: [-1, 1],
        topRight: [1, 1],
        bottomLeft: [-1, -1],
        bottomRight: [1, -1],
      };
      const s = signs[anchor];
      if (s) return [v.x + (s[0] * v.width) / 2, v.y + (s[1] * v.height) / 2];
      return [v.x, v.y];
    }
    default:
      return [v.x, v.y];
  }
}

export const anchorsFor = (type: Entity["type"]) =>
  type === "spline"
    ? ["start", "end", "mid"]
    : type === "rectangle"
    ? ["center", "topLeft", "topRight", "bottomLeft", "bottomRight"]
    : type === "circle" || type === "point"
      ? ["center"]
      : type === "line"
        ? ["start", "end", "center", "mid"]
        : ["start", "end", "mid", "center"];

// ---------------------------------------------------------------------------
// Curves and planar regions

export type Curve =
  | { kind: "line"; a: Vec2; b: Vec2; source: string }
  | {
      kind: "arc";
      center: Vec2;
      radius: number;
      start: number;
      sweep: number;
      source: string;
    }
  | { kind: "circle"; center: Vec2; radius: number; source: string }
  | { kind: "bezier"; p: Bez; source: string };

/** Non-construction profile curves of a sketch. Points are not curves. */
export function sketchCurves(s: Sketch): Curve[] {
  const curves: Curve[] = [];
  for (const e of s.entities) {
    if (e.construction) continue;
    const v = e.values;
    if (e.type === "line")
      curves.push({ kind: "line", a: [v.x1, v.y1], b: [v.x2, v.y2], source: e.id });
    else if (e.type === "circle")
      curves.push({ kind: "circle", center: [v.x, v.y], radius: v.radius, source: e.id });
    else if (e.type === "arc") {
      const g = arcGeometry(e);
      if (g)
        curves.push({
          kind: "arc",
          center: g.center,
          radius: g.radius,
          start: g.start,
          sweep: g.sweep,
          source: e.id,
        });
    } else if (e.type === "spline") {
      for (const p of splineBeziers(e)) curves.push({ kind: "bezier", p, source: e.id });
    } else if (e.type === "rectangle") {
      const corners: Vec2[] = [
        [v.x - v.width / 2, v.y - v.height / 2],
        [v.x + v.width / 2, v.y - v.height / 2],
        [v.x + v.width / 2, v.y + v.height / 2],
        [v.x - v.width / 2, v.y + v.height / 2],
      ];
      corners.forEach((c, i) =>
        curves.push({ kind: "line", a: c, b: corners[(i + 1) % 4], source: e.id }),
      );
    }
  }
  return curves;
}

const pointAtAngle = (c: Vec2, r: number, t: number): Vec2 => [
  c[0] + r * Math.cos(t),
  c[1] + r * Math.sin(t),
];

/** Parameter of an angle inside an arc span, or undefined when outside. */
function arcParam(curve: { start: number; sweep: number }, angle: number, tol: number) {
  const d = norm(angle - curve.start);
  if (d <= curve.sweep + tol) return Math.min(d, curve.sweep);
  if (d >= TAU - tol) return 0;
  return undefined;
}

function circleIntersections(c1: Vec2, r1: number, c2: Vec2, r2: number, tol: number): Vec2[] {
  const dx = c2[0] - c1[0],
    dy = c2[1] - c1[1],
    d = hypot(dx, dy);
  if (d < tol || d > r1 + r2 + tol || d < Math.abs(r1 - r2) - tol) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d),
    h2 = r1 * r1 - a * a,
    h = h2 > 0 ? Math.sqrt(h2) : 0;
  const mx = c1[0] + (a * dx) / d,
    my = c1[1] + (a * dy) / d;
  if (h < tol) return [[mx, my]];
  return [
    [mx + (h * dy) / d, my - (h * dx) / d],
    [mx - (h * dy) / d, my + (h * dx) / d],
  ];
}

function lineCircle(a: Vec2, b: Vec2, c: Vec2, r: number, tol: number): Vec2[] {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    fx = a[0] - c[0],
    fy = a[1] - c[1];
  const A = dx * dx + dy * dy,
    B = 2 * (fx * dx + fy * dy),
    C = fx * fx + fy * fy - r * r;
  let disc = B * B - 4 * A * C;
  if (disc < -tol * A) return [];
  disc = Math.max(disc, 0);
  const s = Math.sqrt(disc),
    ts = s < 1e-12 ? [-B / (2 * A)] : [(-B - s) / (2 * A), (-B + s) / (2 * A)];
  return ts.map((t) => [a[0] + t * dx, a[1] + t * dy] as Vec2);
}

/** Parameter of a point on a curve (t in [0,1] for lines; angle offset for arcs/circles). */
function paramOn(curve: Curve, p: Vec2, tol: number): number | undefined {
  if (curve.kind === "bezier") {
    const t = bezierClosest(curve.p, p),
      q = bezierPoint(curve.p, t);
    return hypot(q[0] - p[0], q[1] - p[1]) <= tol ? t : undefined;
  }
  if (curve.kind === "line") {
    const dx = curve.b[0] - curve.a[0],
      dy = curve.b[1] - curve.a[1],
      l2 = dx * dx + dy * dy;
    if (l2 < 1e-18) return undefined;
    const t = ((p[0] - curve.a[0]) * dx + (p[1] - curve.a[1]) * dy) / l2;
    const len = Math.sqrt(l2);
    const dist = Math.abs((p[0] - curve.a[0]) * dy - (p[1] - curve.a[1]) * dx) / len;
    if (dist > tol || t < -tol / len || t > 1 + tol / len) return undefined;
    return Math.min(1, Math.max(0, t));
  }
  const d = hypot(p[0] - curve.center[0], p[1] - curve.center[1]);
  if (Math.abs(d - curve.radius) > tol) return undefined;
  const angle = Math.atan2(p[1] - curve.center[1], p[0] - curve.center[0]);
  if (curve.kind === "circle") return norm(angle);
  return arcParam(curve, angle, tol / Math.max(curve.radius, 1e-9));
}

/** Roots of f along a Bézier, found on a fine polyline and refined by bisection. */
function bezierRoots(b: Bez, f: (p: Vec2) => number): Vec2[] {
  const out: Vec2[] = [];
  const n = 48;
  let t0 = 0,
    f0 = f(b[0]);
  for (let i = 1; i <= n; i++) {
    const t1 = i / n,
      f1 = f(bezierPoint(b, t1));
    if (f0 === 0) out.push(bezierPoint(b, t0));
    else if (f0 * f1 < 0) {
      let lo = t0,
        hi = t1,
        flo = f0;
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2,
          fm = f(bezierPoint(b, mid));
        if (flo * fm <= 0) hi = mid;
        else {
          lo = mid;
          flo = fm;
        }
      }
      out.push(bezierPoint(b, (lo + hi) / 2));
    }
    t0 = t1;
    f0 = f1;
  }
  if (f0 === 0) out.push(b[3]);
  return out;
}
function bezierIntersections(a: Extract<Curve, { kind: "bezier" }>, b: Curve): Vec2[] {
  const ends: Vec2[] = [a.p[0], a.p[3]];
  if (b.kind === "line") {
    const d: Vec2 = [b.b[0] - b.a[0], b.b[1] - b.a[1]];
    return [...bezierRoots(a.p, (q) => d[0] * (q[1] - b.a[1]) - d[1] * (q[0] - b.a[0])), ...ends, b.a, b.b];
  }
  if (b.kind === "circle" || b.kind === "arc") {
    const roots = bezierRoots(a.p, (q) => hypot(q[0] - b.center[0], q[1] - b.center[1]) - b.radius);
    if (b.kind === "arc") ends.push(pointAtAngle(b.center, b.radius, b.start), pointAtAngle(b.center, b.radius, b.start + b.sweep));
    return [...roots, ...ends];
  }
  // Two Béziers: polyline crossings refined by Newton on B1(t) = B2(s).
  const out: Vec2[] = [...ends, b.p[0], b.p[3]];
  const n = 32;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const p1 = bezierPoint(a.p, i / n),
        p2 = bezierPoint(a.p, (i + 1) / n),
        q1 = bezierPoint(b.p, j / n),
        q2 = bezierPoint(b.p, (j + 1) / n);
      const r: Vec2 = [p2[0] - p1[0], p2[1] - p1[1]],
        s: Vec2 = [q2[0] - q1[0], q2[1] - q1[1]],
        den = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(den) < 1e-18) continue;
      const u = ((q1[0] - p1[0]) * s[1] - (q1[1] - p1[1]) * s[0]) / den,
        v = ((q1[0] - p1[0]) * r[1] - (q1[1] - p1[1]) * r[0]) / den;
      if (u < -0.01 || u > 1.01 || v < -0.01 || v > 1.01) continue;
      let t = (i + u) / n,
        w = (j + v) / n;
      for (let k = 0; k < 30; k++) {
        const e1 = bezierPoint(a.p, t),
          e2 = bezierPoint(b.p, w),
          d1 = bezierTangent(a.p, t),
          d2 = bezierTangent(b.p, w);
        const fx = e1[0] - e2[0],
          fy = e1[1] - e2[1],
          det = -d1[0] * d2[1] + d2[0] * d1[1];
        if (Math.abs(det) < 1e-18) break;
        const dt = (-fx * -d2[1] + d2[0] * -fy) / det,
          dw = (d1[0] * -fy - -fx * d1[1]) / det;
        t = Math.max(0, Math.min(1, t + dt));
        w = Math.max(0, Math.min(1, w + dw));
        if (Math.abs(dt) + Math.abs(dw) < 1e-14) break;
      }
      out.push(bezierPoint(a.p, t));
    }
  return out;
}

function intersect(a: Curve, b: Curve, tol: number): Vec2[] {
  let points: Vec2[] = [];
  if (a.kind === "bezier" || b.kind === "bezier") {
    points = a.kind === "bezier" ? bezierIntersections(a, b) : bezierIntersections(b as Extract<Curve, { kind: "bezier" }>, a);
    return points.filter((p) => paramOn(a, p, tol) !== undefined && paramOn(b, p, tol) !== undefined);
  }
  if (a.kind === "line" && b.kind === "line") {
    const r: Vec2 = [a.b[0] - a.a[0], a.b[1] - a.a[1]],
      s: Vec2 = [b.b[0] - b.a[0], b.b[1] - b.a[1]],
      denom = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(denom) > 1e-12) {
      const qp: Vec2 = [b.a[0] - a.a[0], b.a[1] - a.a[1]],
        t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
      points = [[a.a[0] + t * r[0], a.a[1] + t * r[1]]];
    }
    // Overlapping collinear segments share their endpoints.
    points.push(a.a, a.b, b.a, b.b);
  } else if (a.kind === "line" || b.kind === "line") {
    const line = (a.kind === "line" ? a : b) as Extract<Curve, { kind: "line" }>,
      round = (a.kind === "line" ? b : a) as Exclude<Curve, { kind: "line" | "bezier" }>;
    points = lineCircle(line.a, line.b, round.center, round.radius, tol);
    points.push(line.a, line.b);
    if (round.kind === "arc")
      points.push(
        pointAtAngle(round.center, round.radius, round.start),
        pointAtAngle(round.center, round.radius, round.start + round.sweep),
      );
  } else {
    const ra = a as Exclude<Curve, { kind: "line" | "bezier" }>,
      rb = b as Exclude<Curve, { kind: "line" | "bezier" }>;
    points = circleIntersections(ra.center, ra.radius, rb.center, rb.radius, tol);
    for (const round of [ra, rb])
      if (round.kind === "arc")
        points.push(
          pointAtAngle(round.center, round.radius, round.start),
          pointAtAngle(round.center, round.radius, round.start + round.sweep),
        );
  }
  return points.filter(
    (p) => paramOn(a, p, tol) !== undefined && paramOn(b, p, tol) !== undefined,
  );
}

export type Piece =
  | { kind: "line"; a: Vec2; b: Vec2; source: string }
  | { kind: "bezier"; p: Bez; a: Vec2; b: Vec2; source: string }
  | {
      kind: "arc";
      center: Vec2;
      radius: number;
      /** start angle and signed sweep (negative = clockwise traversal) */
      start: number;
      sweep: number;
      a: Vec2;
      b: Vec2;
      source: string;
    };

export interface Loop {
  pieces: Piece[];
  area: number;
  polygon: Vec2[];
}
export interface Region {
  outer: Loop;
  holes: Loop[];
  level: number;
  area: number;
  sample: Vec2;
}

const reversePiece = (p: Piece): Piece =>
  p.kind === "line"
    ? { ...p, a: p.b, b: p.a }
    : p.kind === "bezier"
      ? { ...p, p: [p.p[3], p.p[2], p.p[1], p.p[0]], a: p.b, b: p.a }
      : { ...p, start: p.start + p.sweep, sweep: -p.sweep, a: p.b, b: p.a };

export function samplePiece(p: Piece, segmentsPerTurn = 72): Vec2[] {
  if (p.kind === "line") return [p.a, p.b];
  if (p.kind === "bezier") return Array.from({ length: 25 }, (_, i) => bezierPoint(p.p, i / 24));
  const n = Math.max(2, Math.ceil((Math.abs(p.sweep) / TAU) * segmentsPerTurn));
  return Array.from({ length: n + 1 }, (_, i) =>
    pointAtAngle(p.center, p.radius, p.start + (p.sweep * i) / n),
  );
}

export function piecePoint(p: Piece, t: number): Vec2 {
  if (p.kind === "line") return [p.a[0] + (p.b[0] - p.a[0]) * t, p.a[1] + (p.b[1] - p.a[1]) * t];
  if (p.kind === "bezier") return bezierPoint(p.p, t);
  return pointAtAngle(p.center, p.radius, p.start + p.sweep * t);
}

function polygonArea(poly: Vec2[]) {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

export function insidePolygon(p: Vec2, poly: Vec2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}

function loopFrom(pieces: Piece[]): Loop {
  const polygon: Vec2[] = [];
  for (const p of pieces) polygon.push(...samplePiece(p).slice(0, -1));
  return { pieces, polygon, area: polygonArea(polygon) };
}

/** Interior sample point of a polygon with holes (widest scanline span). */
function interiorPoint(outer: Vec2[], holes: Vec2[][]): Vec2 {
  const ys = outer.map((p) => p[1]),
    lo = Math.min(...ys),
    hi = Math.max(...ys);
  let best: Vec2 = outer[0],
    width = -1;
  for (let k = 1; k < 24; k++) {
    const y = lo + ((hi - lo) * k) / 24 + 1e-7 * (hi - lo);
    const xs: number[] = [];
    for (const poly of [outer, ...holes])
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i],
          b = poly[j];
        if (a[1] > y !== b[1] > y)
          xs.push(((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]);
      }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2)
      if (xs[i + 1] - xs[i] > width) {
        width = xs[i + 1] - xs[i];
        best = [(xs[i] + xs[i + 1]) / 2, y];
      }
  }
  return best;
}

/**
 * Split curves at their intersections and return bounded planar regions.
 * Nested, non-touching contours alternate between material and holes (level);
 * intersecting contours form one connected arrangement whose faces are all level 1.
 */
export function sketchRegions(s: Sketch): Region[] {
  const curves = sketchCurves(s);
  if (!curves.length) return [];
  const extent = Math.max(
    1,
    ...curves.flatMap((c) =>
      c.kind === "line"
        ? [Math.abs(c.a[0]), Math.abs(c.a[1]), Math.abs(c.b[0]), Math.abs(c.b[1])]
        : c.kind === "bezier"
          ? c.p.flatMap((q) => [Math.abs(q[0]), Math.abs(q[1])])
          : [Math.abs(c.center[0]) + c.radius, Math.abs(c.center[1]) + c.radius],
    ),
  );
  const tol = 1e-6 * extent;
  // Split parameters per curve.
  const splits: number[][] = curves.map((c) =>
    c.kind === "line" || c.kind === "bezier" ? [0, 1] : c.kind === "arc" ? [0, c.sweep] : [],
  );
  for (let i = 0; i < curves.length; i++)
    for (let j = i + 1; j < curves.length; j++)
      for (const p of intersect(curves[i], curves[j], tol)) {
        const ti = paramOn(curves[i], p, tol),
          tj = paramOn(curves[j], p, tol);
        if (ti !== undefined) splits[i].push(ti);
        if (tj !== undefined) splits[j].push(tj);
      }
  // Vertices merged by tolerance.
  const vertices: Vec2[] = [];
  const vertexOf = (p: Vec2) => {
    const found = vertices.findIndex((v) => hypot(v[0] - p[0], v[1] - p[1]) < tol * 10);
    if (found >= 0) return found;
    vertices.push(p);
    return vertices.length - 1;
  };
  interface Edge {
    piece: Piece;
    u: number;
    v: number;
  }
  const edges: Edge[] = [];
  const fullCircles: { curve: Extract<Curve, { kind: "circle" }> }[] = [];
  curves.forEach((c, i) => {
    const ts = [...splits[i]].sort((a, b) => a - b);
    if (c.kind === "bezier") {
      // Pieces between intersection parameters, ends snapped to the merged vertices.
      const unique = ts.filter((t, k) => k === 0 || (() => {
        const p = bezierPoint(c.p, t),
          q = bezierPoint(c.p, ts[k - 1]);
        return hypot(p[0] - q[0], p[1] - q[1]) > tol * 10;
      })());
      for (let k = 0; k + 1 < unique.length; k++) {
        const sub = splitBezier(c.p, unique[k], unique[k + 1]);
        const u = vertexOf(sub[0]),
          v = vertexOf(sub[3]);
        const p: Bez = [vertices[u], sub[1], sub[2], vertices[v]];
        edges.push({ piece: { kind: "bezier", p, a: vertices[u], b: vertices[v], source: c.source }, u, v });
      }
      return;
    }
    if (c.kind === "line") {
      const len = hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]);
      const unique = ts.filter((t, k) => k === 0 || (t - ts[k - 1]) * len > tol * 10);
      for (let k = 0; k + 1 < unique.length; k++) {
        const a: Vec2 = [c.a[0] + (c.b[0] - c.a[0]) * unique[k], c.a[1] + (c.b[1] - c.a[1]) * unique[k]],
          b: Vec2 = [
            c.a[0] + (c.b[0] - c.a[0]) * unique[k + 1],
            c.a[1] + (c.b[1] - c.a[1]) * unique[k + 1],
          ];
        const u = vertexOf(a),
          v = vertexOf(b);
        edges.push({ piece: { kind: "line", a: vertices[u], b: vertices[v], source: c.source }, u, v });
      }
    } else {
      const angles =
        c.kind === "circle"
          ? ts.filter((t, k) => k === 0 || (t - ts[k - 1]) * c.radius > tol * 10)
          : ts.filter((t, k) => k === 0 || (t - ts[k - 1]) * c.radius > tol * 10);
      if (c.kind === "circle" && angles.length === 0) {
        fullCircles.push({ curve: c });
        return;
      }
      const base = c.kind === "arc" ? c.start : 0;
      const stops = c.kind === "circle" ? [...angles, angles[0] + TAU] : angles;
      for (let k = 0; k + 1 < stops.length; k++) {
        const start = base + stops[k],
          sweep = stops[k + 1] - stops[k];
        if (sweep * c.radius < tol * 10) continue;
        const u = vertexOf(pointAtAngle(c.center, c.radius, start)),
          v = vertexOf(pointAtAngle(c.center, c.radius, start + sweep));
        edges.push({
          piece: {
            kind: "arc",
            center: c.center,
            radius: c.radius,
            start,
            sweep,
            a: vertices[u],
            b: vertices[v],
            source: c.source,
          },
          u,
          v,
        });
      }
    }
  });
  // Overlapping collinear curves produce duplicate pieces; keep one.
  const seenPieces = new Set<string>();
  for (let i = edges.length - 1; i >= 0; i--) {
    const e = edges[i],
      mid = piecePoint(e.piece, 0.5),
      key = `${Math.min(e.u, e.v)}:${Math.max(e.u, e.v)}:${Math.round(mid[0] / (tol * 100))}:${Math.round(mid[1] / (tol * 100))}`;
    if (seenPieces.has(key)) edges.splice(i, 1);
    else seenPieces.add(key);
  }
  // Prune dangling edges (vertices of degree one), repeatedly.
  let alive = edges.map(() => true);
  for (let changed = true; changed; ) {
    changed = false;
    const degree = new Map<number, number>();
    edges.forEach((e, i) => {
      if (!alive[i]) return;
      degree.set(e.u, (degree.get(e.u) ?? 0) + 1);
      degree.set(e.v, (degree.get(e.v) ?? 0) + 1);
    });
    edges.forEach((e, i) => {
      if (alive[i] && e.u !== e.v && ((degree.get(e.u) ?? 0) < 2 || (degree.get(e.v) ?? 0) < 2)) {
        alive[i] = false;
        changed = true;
      }
    });
  }
  let live = edges.filter((_, i) => alive[i]);
  // Half-edges with outgoing direction angles sampled slightly along the piece.
  interface Half {
    edge: number;
    from: number;
    to: number;
    piece: Piece;
    angle: number;
    used: boolean;
  }
  const trace = (list: Edge[]) => {
    const halves: Half[] = [];
    list.forEach((e, i) => {
      const forward = e.piece,
        backward = reversePiece(e.piece);
      for (const [piece, from, to] of [
        [forward, e.u, e.v],
        [backward, e.v, e.u],
      ] as const) {
        const origin = vertices[from],
          q = piecePoint(piece, 1e-3);
        halves.push({
          edge: i,
          from,
          to,
          piece,
          angle: Math.atan2(q[1] - origin[1], q[0] - origin[0]),
          used: false,
        });
      }
    });
    const outgoing = new Map<number, number[]>();
    halves.forEach((h, i) => {
      const around = outgoing.get(h.from) ?? [];
      around.push(i);
      outgoing.set(h.from, around);
    });
    for (const around of outgoing.values())
      around.sort((a, b) => halves[a].angle - halves[b].angle);
    const twin = (i: number) => (i % 2 === 0 ? i + 1 : i - 1);
    const traced: { loop: Loop; vertices: number[]; edges: number[] }[] = [];
    for (let i = 0; i < halves.length; i++) {
      if (halves[i].used) continue;
      const pieces: Piece[] = [],
        visited: number[] = [],
        used: number[] = [];
      let h = i,
        guard = 0;
      while (!halves[h].used && guard++ < halves.length + 2) {
        halves[h].used = true;
        pieces.push(halves[h].piece);
        visited.push(halves[h].from);
        used.push(halves[h].edge);
        const around = outgoing.get(halves[h].to)!,
          back = around.indexOf(twin(h));
        // Next edge clockwise from the reversed incoming edge keeps the face on the left.
        h = around[(back - 1 + around.length) % around.length];
      }
      traced.push({ loop: loopFrom(pieces), vertices: visited, edges: used });
    }
    return traced;
  };
  let loops = trace(live);
  // A bridge edge appears twice in one face boundary; it bounds no region.
  for (let pass = 0; pass < 20; pass++) {
    const bridges = new Set<number>();
    for (const l of loops) {
      const count = new Map<number, number>();
      for (const e of l.edges) count.set(e, (count.get(e) ?? 0) + 1);
      for (const [e, n] of count) if (n > 1) bridges.add(e);
    }
    if (!bridges.size) break;
    live = live.filter((_, i) => !bridges.has(i));
    loops = trace(live);
  }
  // Connected components (by shared vertices) of the live arrangement.
  const parent = vertices.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of live) parent[find(e.u)] = find(e.v);
  interface Component {
    outer?: Loop;
    faces: Loop[];
  }
  const components = new Map<string, Component>();
  for (const { loop, vertices: vs } of loops) {
    const key = `v${find(vs[0])}`;
    const c = components.get(key) ?? { faces: [] };
    if (loop.area > tol * tol) c.faces.push(loop);
    else if (!c.outer || loop.area < c.outer.area) c.outer = loop;
    components.set(key, c);
  }
  fullCircles.forEach(({ curve }, i) => {
    const piece: Piece = {
      kind: "arc",
      center: curve.center,
      radius: curve.radius,
      start: 0,
      sweep: TAU,
      a: pointAtAngle(curve.center, curve.radius, 0),
      b: pointAtAngle(curve.center, curve.radius, 0),
      source: curve.source,
    };
    const face = loopFrom([piece]);
    components.set(`c${i}`, { faces: [face], outer: loopFrom([reversePiece(piece)]) });
  });
  const list = [...components.values()].filter((c) => c.faces.length && c.outer);
  // Direct container of each component: smallest face of another component enclosing it.
  const container = new Map<Component, { face: Loop; owner: Component } | undefined>();
  for (const c of list) {
    const probe = c.outer!.polygon[0];
    let best: { face: Loop; owner: Component } | undefined;
    for (const other of list) {
      if (other === c) continue;
      for (const face of other.faces)
        if (insidePolygon(probe, face.polygon) && (!best || face.area < best.face.area))
          best = { face, owner: other };
    }
    container.set(c, best);
  }
  const level = (c: Component): number => {
    const parentFace = container.get(c);
    return parentFace ? level(parentFace.owner) + 1 : 1;
  };
  const regions: Region[] = [];
  for (const c of list)
    for (const face of c.faces) {
      const holes = list
        .filter((d) => container.get(d)?.face === face)
        .map((d) => {
          const outer = d.outer!;
          return loopFrom(outer.pieces);
        });
      regions.push({
        outer: face,
        holes,
        level: level(c),
        area: face.area - holes.reduce((sum, h) => sum + Math.abs(h.area), 0),
        sample: interiorPoint(
          face.polygon,
          holes.map((h) => h.polygon),
        ),
      });
    }
  return regions;
}

/** Regions selected by seed points, or the default odd-level material regions. */
export function selectRegions(regions: Region[], seeds?: Vec2[]): Region[] {
  if (!seeds?.length) return regions.filter((r) => r.level % 2 === 1);
  const chosen = new Set<Region>();
  for (const seed of seeds) {
    const hit = regions
      .filter(
        (r) =>
          insidePolygon(seed, r.outer.polygon) &&
          !r.holes.some((h) => insidePolygon(seed, h.polygon)),
      )
      .sort((a, b) => a.area - b.area)[0];
    if (!hit) throw Error("A selected sketch region no longer exists; reselect the profile");
    chosen.add(hit);
  }
  return [...chosen];
}

/** Closest point on an entity to p, for snapping and point-on-curve constraints. */
export function nearestOnEntity(e: Entity, p: Vec2): Vec2 | undefined {
  const v = e.values;
  if (e.type === "line") {
    const dx = v.x2 - v.x1,
      dy = v.y2 - v.y1,
      l2 = dx * dx + dy * dy;
    if (l2 < 1e-18) return [v.x1, v.y1];
    const t = Math.max(0, Math.min(1, ((p[0] - v.x1) * dx + (p[1] - v.y1) * dy) / l2));
    return [v.x1 + t * dx, v.y1 + t * dy];
  }
  if (e.type === "spline") {
    let best: Vec2 | undefined,
      bestD = Infinity;
    for (const span of splineBeziers(e)) {
      const q = bezierPoint(span, bezierClosest(span, p)),
        d = hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    return best;
  }
  if (e.type === "circle" || e.type === "arc") {
    const g =
      e.type === "circle"
        ? { center: [v.x, v.y] as Vec2, radius: v.radius, start: 0, sweep: TAU }
        : arcGeometry(e);
    if (!g) return undefined;
    const angle = Math.atan2(p[1] - g.center[1], p[0] - g.center[0]);
    const t = arcParam(g, angle, 0);
    if (t === undefined) {
      const a = pointAtAngle(g.center, g.radius, g.start),
        b = pointAtAngle(g.center, g.radius, g.start + g.sweep);
      return hypot(a[0] - p[0], a[1] - p[1]) < hypot(b[0] - p[0], b[1] - p[1]) ? a : b;
    }
    return pointAtAngle(g.center, g.radius, angle);
  }
  return undefined;
}
