// Pure sketch helpers for the in-place editor: hit testing, snapping,
// dimension layout and relation glyphs. Units are sketch millimeters.
import type { Constraint, Entity, Sketch, Vec2 } from "../../cad/types.ts";
import { arcGeometry, bezierPoint, circumcircle, fitPoints, nearestOnEntity, point, splineBeziers, TAU } from "../../cad/sketch-geometry.ts";
import { measureConstraint } from "../../cad/solver.ts";
import { formatLength } from "../units.ts";

export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
export const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < 1e-12 ? [1, 0] : [a[0] / l, a[1] / l];
};
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
export const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];

export interface PointRef {
  entityId: string;
  anchor: string;
}
/** Anchors that act as sketch points for selection, snapping and relations. */
export function anchorPoints(e: Entity): { anchor: string; p: Vec2; kind: "end" | "mid" | "center" }[] {
  const v = e.values;
  switch (e.type) {
    case "point":
      return [{ anchor: "center", p: [v.x, v.y], kind: "end" }];
    case "line":
      return [
        { anchor: "start", p: [v.x1, v.y1], kind: "end" },
        { anchor: "end", p: [v.x2, v.y2], kind: "end" },
        { anchor: "center", p: point(e, "center"), kind: "mid" },
      ];
    case "arc":
      return [
        { anchor: "start", p: [v.x1, v.y1], kind: "end" },
        { anchor: "end", p: [v.x2, v.y2], kind: "end" },
        { anchor: "center", p: point(e, "center"), kind: "center" },
      ];
    case "circle":
      return [{ anchor: "center", p: [v.x, v.y], kind: "center" }];
    case "spline": {
      // Every fit point is a sketch point. Untrimmed, the first and last are the
      // spline's ends; trimmed, the ends lie where the kept curve stops.
      const pts = fitPoints(e);
      if ("from" in v)
        return [
          { anchor: "start", p: point(e, "start"), kind: "end" as const },
          { anchor: "end", p: point(e, "end"), kind: "end" as const },
          ...pts.map((p, i) => ({ anchor: `p${i}`, p, kind: "end" as const })),
        ];
      return pts.map((p, i, all) => ({ anchor: i === 0 ? "start" : i === all.length - 1 ? "end" : `p${i}`, p, kind: "end" as const }));
    }
    case "rectangle":
      return [
        ...["topLeft", "topRight", "bottomLeft", "bottomRight"].map((anchor) => ({
          anchor,
          p: point(e, anchor),
          kind: "end" as "end" | "mid" | "center",
        })),
        { anchor: "center", p: point(e, "center"), kind: "center" as const },
      ];
  }
}
/** Polyline samples of an entity for drawing and hit testing. */
export function entityPolyline(e: Entity, segments = 96): Vec2[] {
  const v = e.values;
  if (e.type === "line") return [[v.x1, v.y1], [v.x2, v.y2]];
  if (e.type === "rectangle") {
    const x0 = v.x - v.width / 2,
      x1 = v.x + v.width / 2,
      y0 = v.y - v.height / 2,
      y1 = v.y + v.height / 2;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  }
  if (e.type === "circle")
    return Array.from({ length: segments + 1 }, (_, i) => [
      v.x + v.radius * Math.cos((i / segments) * TAU),
      v.y + v.radius * Math.sin((i / segments) * TAU),
    ]);
  if (e.type === "spline") {
    const spans = splineBeziers(e);
    if (!spans.length) return fitPoints(e);
    const per = Math.max(8, Math.ceil(segments / spans.length));
    return [spans[0][0], ...spans.flatMap((b) => Array.from({ length: per }, (_, i) => bezierPoint(b, (i + 1) / per)))];
  }
  if (e.type === "arc") {
    const g = arcGeometry(e);
    if (!g) return [[v.x1, v.y1], [v.x2, v.y2]];
    const n = Math.max(8, Math.ceil((g.sweep / TAU) * segments));
    return Array.from({ length: n + 1 }, (_, i) => [
      g.center[0] + g.radius * Math.cos(g.start + (g.sweep * i) / n),
      g.center[1] + g.radius * Math.sin(g.start + (g.sweep * i) / n),
    ]);
  }
  return [[v.x, v.y]];
}
export function distanceToEntity(e: Entity, p: Vec2) {
  if (e.type === "point") return dist(p, [e.values.x, e.values.y]);
  if (e.type === "rectangle") {
    const poly = entityPolyline(e);
    let best = Infinity;
    for (let i = 0; i + 1 < poly.length; i++) best = Math.min(best, segmentDistance(p, poly[i], poly[i + 1]));
    return best;
  }
  const q = nearestOnEntity(e, p);
  return q ? dist(p, q) : Infinity;
}
export function segmentDistance(p: Vec2, a: Vec2, b: Vec2) {
  const d = sub(b, a),
    l2 = dot(d, d);
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), d) / l2));
  return dist(p, add(a, mul(d, t)));
}

export type SnapTarget =
  | { kind: "point"; entityId: string; anchor: string }
  | { kind: "curve"; entityId: string }
  | { kind: "origin" };
export interface Snap {
  p: Vec2;
  target?: SnapTarget;
  hint?: "H" | "V";
  guides: [Vec2, Vec2][];
  marker?: "end" | "mid" | "center" | "curve" | "origin";
}
/** Find the best snap for a raw sketch point. `px` is millimeters per screen pixel. */
export function snapPoint(
  s: Sketch,
  raw: Vec2,
  px: number,
  options: { from?: Vec2; exclude?: Set<string>; grid?: boolean } = {},
): Snap {
  const reach = 9 * px;
  let best: Snap | undefined,
    bestD = reach;
  if (dist(raw, [0, 0]) < bestD) {
    bestD = dist(raw, [0, 0]);
    best = { p: [0, 0], target: { kind: "origin" }, guides: [], marker: "origin" };
  }
  for (const e of s.entities) {
    if (options.exclude?.has(e.id)) continue;
    for (const a of anchorPoints(e)) {
      const d = dist(raw, a.p);
      if (d < bestD) {
        bestD = d;
        best = { p: a.p, target: { kind: "point", entityId: e.id, anchor: a.anchor }, guides: [], marker: a.kind };
      }
    }
  }
  if (best) return best;
  // Curves.
  let curveD = 6 * px;
  for (const e of s.entities) {
    if (options.exclude?.has(e.id) || e.type === "point" || e.type === "rectangle") continue;
    const q = nearestOnEntity(e, raw);
    if (q && dist(q, raw) < curveD) {
      curveD = dist(q, raw);
      best = { p: q, target: { kind: "curve", entityId: e.id }, guides: [], marker: "curve" };
    }
  }
  let p: Vec2 = [...raw];
  const guides: [Vec2, Vec2][] = [];
  let hint: Snap["hint"];
  const align = 7 * px;
  if (options.from) {
    if (Math.abs(p[1] - options.from[1]) < align && Math.abs(p[0] - options.from[0]) > align) {
      p[1] = options.from[1];
      hint = "H";
    } else if (Math.abs(p[0] - options.from[0]) < align && Math.abs(p[1] - options.from[1]) > align) {
      p[0] = options.from[0];
      hint = "V";
    }
  }
  if (best) return { ...best, hint: undefined };
  // Alignment with existing points (inference lines).
  const points = s.entities
    .filter((e) => !options.exclude?.has(e.id))
    .flatMap((e) => anchorPoints(e).filter((a) => a.kind !== "mid").map((a) => a.p))
    .concat([[0, 0]]);
  if (hint !== "V")
    for (const q of points)
      if (Math.abs(p[0] - q[0]) < align) {
        p[0] = q[0];
        guides.push([q, [...p]]);
        break;
      }
  if (hint !== "H")
    for (const q of points)
      if (Math.abs(p[1] - q[1]) < align) {
        p[1] = q[1];
        guides.push([q, [...p]]);
        break;
      }
  if (options.grid !== false && !guides.length) {
    const step = niceStep(px * 10);
    if (hint !== "V") p[0] = Math.round(p[0] / step) * step;
    if (hint !== "H") p[1] = Math.round(p[1] / step) * step;
  }
  return { p, hint, guides };
}
export function niceStep(x: number) {
  const e = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-6))));
  const m = x / e;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
}
export const formatMm = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
};

// ---------------------------------------------------------------------------
// Dimensions
export interface DimensionShape {
  lines: [Vec2, Vec2][];
  arrows: { at: Vec2; dir: Vec2 }[];
  arcs: { center: Vec2; radius: number; start: number; sweep: number }[];
  label: Vec2;
  text: string;
}
export const dimensional = (c: Constraint) =>
  ["distance", "length", "angle", "radius", "diameter", "dimension", "offset", "pattern"].includes(c.type) &&
  c.value !== undefined;
/** Reference point of an entity for pattern dimensions. */
const anchorOf = (e: Entity): Vec2 => point(e, e.type === "line" || e.type === "arc" ? "start" : e.type === "rectangle" ? "bottomLeft" : "center");
/** A pattern's source and first copy (linear), or its center and the source (circular). */
function patternPoints(s: Sketch, c: Constraint): { center?: Vec2; first: Vec2; next: Vec2 } | undefined {
  const pt = c.pattern;
  const es = c.entityIds.map((id) => s.entities.find((e) => e.id === id));
  if (!pt || es.some((e) => !e)) return undefined;
  const offset = pt.kind === "circular" ? 1 : 0;
  return {
    center: pt.kind === "circular" ? point(es[0]!, "center") : undefined,
    first: anchorOf(es[offset]!),
    next: anchorOf(es[offset + pt.sources]!),
  };
}
/** The two points an offset dimension measures between: on the first source and its copy. */
function offsetPoints(src: Entity, copy: Entity, toward?: Vec2): [Vec2, Vec2] {
  if (src.type === "line") {
    const p = point(src, "center"),
      s0 = point(copy, "start"),
      u = norm(sub(point(copy, "end"), s0));
    return [p, add(s0, mul(u, dot(sub(p, s0), u)))];
  }
  if (src.type === "rectangle") return [point(src, "bottomRight"), point(copy, "bottomRight")];
  const r = (e: Entity) => (e.type === "circle" ? { center: [e.values.x, e.values.y] as Vec2, radius: e.values.radius } : circumcircle(point(e, "start"), point(e, "mid"), point(e, "end"))!);
  const a = r(src),
    b = r(copy);
  const u = toward ? norm(sub(toward, a.center)) : src.type === "arc" ? norm(sub(point(src, "mid"), a.center)) : norm([1, 1]);
  return [add(a.center, mul(u, a.radius)), add(a.center, mul(u, b.radius))];
}

function linear(p: Vec2, q: Vec2, label: Vec2, mode: "aligned" | "x" | "y", px: number): Omit<DimensionShape, "text"> {
  const over = 4 * px;
  let a: Vec2, b: Vec2, n: Vec2;
  if (mode === "x") {
    a = [p[0], label[1]];
    b = [q[0], label[1]];
    n = [0, label[1] >= Math.max(p[1], q[1]) ? 1 : -1];
  } else if (mode === "y") {
    a = [label[0], p[1]];
    b = [label[0], q[1]];
    n = [label[0] >= Math.max(p[0], q[0]) ? 1 : -1, 0];
  } else {
    const u = norm(sub(q, p));
    n = perp(u);
    const off = dot(sub(label, p), n);
    a = add(p, mul(n, off));
    b = add(q, mul(n, off));
    if (off < 0) n = mul(n, -1);
  }
  const ext = (from: Vec2, to: Vec2): [Vec2, Vec2] => {
    const d = sub(to, from),
      l = len(d);
    if (l < 1e-9) return [from, to];
    const u = mul(d, 1 / l);
    return [add(from, mul(u, Math.min(l, 2 * px))), add(to, mul(u, over))];
  };
  const u = norm(sub(b, a));
  // Arrows point outward from the label when the span is short.
  const span = dist(a, b),
    inside = span > 30 * px;
  const lines: [Vec2, Vec2][] = [ext(p, a), ext(q, b), [a, b]];
  // Extend the dimension line to the label when it sits outside the span.
  const t = dot(sub(label, a), u);
  if (t < 0) lines.push([a, add(a, mul(u, t))]);
  if (t > span) lines.push([b, add(a, mul(u, t))]);
  return {
    lines,
    arrows: [
      { at: a, dir: inside ? mul(u, -1) : u },
      { at: b, dir: inside ? u : mul(u, -1) },
    ],
    arcs: [],
    label,
  };
}
/** Default label position for a new or label-less dimension. */
export function defaultLabel(s: Sketch, c: Constraint, px: number): Vec2 {
  const lookup = (id: string) => s.entities.find((e) => e.id === id)!;
  const [a, b] = c.entityIds.map(lookup);
  const gap = 28 * px;
  if (!a) return [0, 0];
  if (c.type === "radius" || c.type === "diameter" || (c.type === "dimension" && c.dimension === "radius")) {
    const center = point(a, "center"),
      r = a.type === "circle" ? a.values.radius : (arcGeometry(a)?.radius ?? 1);
    return add(center, mul(norm([1, 1]), r + gap));
  }
  if (c.type === "length" || (c.type === "distance" && a.type === "line" && !b)) {
    const p = point(a, "start"),
      q = point(a, "end");
    return add(mul(add(p, q), 0.5), mul(perp(norm(sub(q, p))), gap));
  }
  if (c.type === "offset" && b) {
    const [p, q] = offsetPoints(a, b);
    return add(mul(add(p, q), 0.5), mul(perp(norm(sub(q, p))), gap));
  }
  if (c.type === "pattern") {
    const pp = patternPoints(s, c);
    if (!pp) return [0, 0];
    if (!pp.center) return add(mul(add(pp.first, pp.next), 0.5), mul(perp(norm(sub(pp.next, pp.first))), -gap));
    // Inside the circle of instances, halfway through the first step.
    const u = norm(add(norm(sub(pp.first, pp.center)), norm(sub(pp.next, pp.center))));
    return add(pp.center, mul(u, dist(pp.first, pp.center) * 0.55));
  }
  if (c.type === "angle" && b) {
    const o = lineIntersection(a, b) ?? point(a, "start");
    const da = norm(sub(point(a, "end"), point(a, "start"))),
      db = norm(sub(point(b, "end"), point(b, "start")));
    return add(o, mul(norm(add(da, db)), Math.max(gap * 1.5, 12 * px)));
  }
  const p = point(a, c.anchors?.[0]);
  const q = b ? (b.type === "line" && !c.anchors?.[1] ? point(b, "center") : point(b, c.anchors?.[1])) : p;
  const mid = mul(add(p, q), 0.5);
  if (c.axis === "x") return [mid[0], Math.max(p[1], q[1]) + gap];
  if (c.axis === "y") return [Math.max(p[0], q[0]) + gap, mid[1]];
  return add(mid, mul(perp(norm(sub(q, p))), gap));
}
export function lineIntersection(a: Entity, b: Entity): Vec2 | undefined {
  const p = point(a, "start"),
    r = sub(point(a, "end"), p),
    q = point(b, "start"),
    s = sub(point(b, "end"), q),
    d = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(d) < 1e-12) return undefined;
  const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / d;
  return add(p, mul(r, t));
}
export function dimensionShape(s: Sketch, c: Constraint, px: number): DimensionShape | null {
  if (!dimensional(c)) return null;
  const lookup = (id: string) => s.entities.find((e) => e.id === id);
  const es = c.entityIds.map(lookup);
  if (es.some((e) => !e)) return null;
  const [a, b] = es as Entity[];
  const label = c.label ?? defaultLabel(s, c, px);
  const value = measureConstraint(s, c) ?? c.value ?? 0;
  // Driven dimensions are shown in parentheses; equation-driven ones carry Σ.
  const wrap = (t: string) => (c.driven ? `(${t})` : c.expression ? `Σ${t}` : t);
  if (c.type === "radius" || c.type === "diameter" || (c.type === "dimension" && c.dimension === "radius")) {
    const g = a.type === "circle" ? { center: [a.values.x, a.values.y] as Vec2, radius: a.values.radius } : circumcircle(point(a, "start"), point(a, "mid"), point(a, "end"));
    if (!g) return null;
    const u = norm(sub(label, g.center));
    const rim = add(g.center, mul(u, g.radius));
    const diameter = c.type === "diameter";
    const lines: [Vec2, Vec2][] = diameter
      ? [[add(g.center, mul(u, -g.radius)), label]]
      : [[g.center, label]];
    const arrows = diameter
      ? [
          { at: rim, dir: u },
          { at: add(g.center, mul(u, -g.radius)), dir: mul(u, -1) },
        ]
      : [{ at: rim, dir: u }];
    return {
      lines,
      arrows,
      arcs: [],
      label,
      text: wrap(`${diameter ? "Ø" : "R"}${formatLength(diameter ? g.radius * 2 : g.radius)}`),
    };
  }
  if (c.type === "angle") {
    const o = lineIntersection(a, b);
    if (!o) return null;
    const ends = (e: Entity) => [point(e, "start"), point(e, "end")].sort((x, y) => dist(y, o) - dist(x, o));
    const da = norm(sub(ends(a)[0], o)),
      db = norm(sub(ends(b)[0], o));
    const r = Math.max(dist(label, o), 4 * px);
    const angA = Math.atan2(da[1], da[0]),
      angB = Math.atan2(db[1], db[0]);
    let start = angA,
      sweep = ((angB - angA) % TAU + TAU) % TAU;
    if (sweep > Math.PI) {
      start = angB;
      sweep = TAU - sweep;
    }
    return {
      lines: [],
      arrows: [],
      arcs: [{ center: o, radius: r, start, sweep }],
      label,
      text: wrap(`${formatMm(value)}°`),
    };
  }
  if (c.type === "dimension") {
    // Raw coordinate or size field: show from the sketch origin or along the entity.
    if (a.type === "rectangle" && (c.dimension === "width" || c.dimension === "height")) {
      const p = point(a, c.dimension === "width" ? "bottomLeft" : "bottomRight"),
        q = point(a, c.dimension === "width" ? "bottomRight" : "topRight");
      return { ...linear(p, q, label, c.dimension === "width" ? "x" : "y", px), text: wrap(formatLength(value)) };
    }
    const axis = c.dimension?.startsWith("x") ? "x" : c.dimension?.startsWith("y") ? "y" : undefined;
    if (!axis) return null;
    const field = c.dimension!,
      other = axis === "x" ? field.replace("x", "y") : field.replace("y", "x");
    const p: Vec2 = axis === "x" ? [a.values[field], a.values[other] ?? 0] : [a.values[other] ?? 0, a.values[field]];
    return { ...linear([0, 0], p, label, axis, px), text: wrap(formatLength(value)) };
  }
  if (c.type === "length") {
    return { ...linear(point(a, "start"), point(a, "end"), label, "aligned", px), text: wrap(formatLength(value)) };
  }
  if (c.type === "pattern") {
    const pp = patternPoints(s, c);
    if (!pp) return null;
    if (!pp.center) {
      if (dist(pp.first, pp.next) < 1e-9) return null;
      return { ...linear(pp.first, pp.next, label, "aligned", px), text: wrap(formatLength(value)) };
    }
    // Arc through the first step, labelled with the total angle.
    const r = Math.max(dist(label, pp.center), 4 * px);
    const a0 = Math.atan2(pp.first[1] - pp.center[1], pp.first[0] - pp.center[0]),
      a1 = Math.atan2(pp.next[1] - pp.center[1], pp.next[0] - pp.center[0]);
    const sweep = ((a1 - a0) % TAU + TAU) % TAU;
    return { lines: [], arrows: [], arcs: [{ center: pp.center, radius: r, start: a0, sweep }], label, text: wrap(`${c.pattern!.count}× ${formatMm(value)}°`) };
  }
  if (c.type === "offset") {
    const [p, q] = offsetPoints(a, b, a.type === "circle" || a.type === "arc" ? label : undefined);
    if (dist(p, q) < 1e-9) return null;
    return { ...linear(p, q, label, "aligned", px), text: wrap(formatLength(value)) };
  }
  // distance
  const p = a.type === "line" && !c.anchors?.[0] ? point(a, "center") : point(a, c.anchors?.[0]);
  if (b.type === "line" && (!c.anchors?.[1] || c.anchors[1] === "curve")) {
    const s0 = point(b, "start"),
      u = norm(sub(point(b, "end"), s0)),
      foot = add(s0, mul(u, dot(sub(p, s0), u)));
    return { ...linear(p, foot, label, "aligned", px), text: wrap(formatLength(value)) };
  }
  const q = point(b, c.anchors?.[1]);
  return {
    ...linear(p, q, label, c.axis === "x" ? "x" : c.axis === "y" ? "y" : "aligned", px),
    text: wrap(formatLength(value)),
  };
}

// ---------------------------------------------------------------------------
// Relation glyphs
export const relationSymbols: Partial<Record<Constraint["type"], string>> = {
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⊥",
  tangent: "T",
  equal: "=",
  concentric: "◎",
  midpoint: "M",
  collinear: "≡",
  symmetric: "S",
  fixed: "F",
  coincident: "•",
  pointOn: "•",
};
/** Where to draw each relation's glyph(s), offset from the geometry. */
export function relationGlyphs(s: Sketch, c: Constraint, px: number): Vec2[] {
  const symbol = relationSymbols[c.type];
  if (!symbol) return [];
  const es = c.entityIds.map((id) => s.entities.find((e) => e.id === id));
  if (es.some((e) => !e)) return [];
  const off = 11 * px;
  const near = (e: Entity): Vec2 => {
    if (e.type === "line") {
      const p = point(e, "start"),
        q = point(e, "end"),
        m = mul(add(p, q), 0.5);
      return add(m, mul(perp(norm(sub(q, p))), off));
    }
    if (e.type === "circle") return [e.values.x + e.values.radius * 0.71 + off, e.values.y + e.values.radius * 0.71 + off];
    if (e.type === "arc") return add(point(e, "mid"), [off, off]);
    return add(point(e, "center"), [off, off]);
  };
  if (c.type === "coincident" || c.type === "pointOn" || c.type === "midpoint")
    return [add(point(es[0]!, c.anchors?.[0]), [off * 0.8, -off * 0.8])];
  if (c.entityIds.length === 2 && c.anchors?.length === 2 && (c.type === "horizontal" || c.type === "vertical"))
    return [add(mul(add(point(es[0]!, c.anchors[0]), point(es[1]!, c.anchors[1])), 0.5), [0, off])];
  return (es as Entity[]).slice(0, c.type === "symmetric" ? 2 : 2).map(near);
}

/** Relations available for a selection, in the SolidWorks "Add Relations" spirit. */
export function availableRelations(s: Sketch, entities: string[], points: PointRef[]): Constraint["type"][] {
  const es = entities.map((id) => s.entities.find((e) => e.id === id)!).filter(Boolean);
  const lines = es.filter((e) => e.type === "line"),
    rounds = es.filter((e) => e.type === "circle" || e.type === "arc");
  const out: Constraint["type"][] = [];
  if (!points.length) {
    if (es.length === 1 && lines.length === 1) out.push("horizontal", "vertical");
    if (es.length === 2 && lines.length === 2) out.push("parallel", "perpendicular", "equal", "collinear");
    if (es.length === 2 && lines.length === 1 && rounds.length === 1) out.push("tangent");
    if (es.length === 2 && rounds.length === 2) out.push("concentric", "equal", "tangent");
    if (es.length === 3 && lines.length >= 1) out.push("symmetric");
  } else if (points.length === 1 && es.length === 1) {
    if (lines.length === 1) out.push("pointOn", "midpoint");
    if (rounds.length === 1) out.push("pointOn");
  } else if (points.length === 2 && !es.length) out.push("coincident", "horizontal", "vertical");
  else if (points.length === 2 && es.length === 1 && lines.length === 1) out.push("symmetric");
  if (es.length + points.length >= 1) out.push("fixed");
  return [...new Set(out)];
}
