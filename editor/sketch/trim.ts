// Power trim for the sketcher: remove the piece of a curve between its
// neighboring intersections with other sketch geometry.
import type { Entity, Sketch, Vec2 } from "../../cad/types.ts";
import { arcGeometry, entityIntersections, fitPoints, nearestOnEntity, point, splineAt, splineClosed, splineParam, splineRange, TAU } from "../../cad/sketch-geometry.ts";
import { add, dist, dot, entityPolyline, mul, norm, perp, sub } from "./model.ts";

type SketchOp = Record<string, any>;
const cross2 = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];

/**
 * Power trim: remove the piece of an entity between its neighboring
 * intersections. Each new end gets a relation to the entity that bounds it, so
 * the trimmed outline stays closed when the sketch changes.
 */
export function trimOps(s: Sketch, e: Entity, p: Vec2): SketchOp[] | undefined {
  const others = s.entities.filter((x) => x.id !== e.id && x.type !== "point");
  const hits: { p: Vec2; id: string }[] = [];
  for (const o of others) for (const q of intersections(e, o)) hits.push({ p: q, id: o.id });
  const crossings = hits.map((h) => h.p);
  const bound = (entity: string, anchor: string, at: Vec2): SketchOp[] => {
    const hit = hits.find((h) => dist(h.p, at) < 1e-6),
      b = hit && s.entities.find((x) => x.id === hit.id);
    if (!b || b.type === "rectangle") return [];
    if (b.type === "line" || b.type === "arc" || b.type === "spline")
      for (const end of ["start", "end"])
        if (dist(point(b, end), at) < 1e-6) return [{ op: "constrain", type: "coincident", entities: [entity, b.id], anchors: [anchor, end] }];
    return [{ op: "constrain", type: "pointOn", entities: [entity, b.id], anchors: [anchor] }];
  };
  if (e.type === "line") {
    const a = point(e, "start"),
      b = point(e, "end"),
      d = sub(b, a),
      l2 = dot(d, d);
    const param = (q: Vec2) => dot(sub(q, a), d) / l2;
    const ts = [...new Set(crossings.map(param).filter((t) => t > 1e-6 && t < 1 - 1e-6).map((t) => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
    const tp = param(p);
    const lo = [...ts].reverse().find((t) => t < tp) ?? 0,
      hi = ts.find((t) => t > tp) ?? 1;
    if (lo === 0 && hi === 1) return [{ op: "delete", entityId: e.id }];
    const at = (t: number): Vec2 => add(a, mul(d, t));
    const touching = (anchor: string) => s.constraints.filter((c) => c.entityIds[0] === e.id && c.anchors?.[0] === anchor || (c.entityIds[1] === e.id && c.anchors?.[1] === anchor));
    const lengthDims = s.constraints.filter((c) => (c.type === "length" || c.type === "dimension") && c.entityIds[0] === e.id);
    if (lo === 0) {
      const q = at(hi);
      return [...touching("start").map((c) => ({ op: "unconstrain", constraintId: c.id })), ...lengthDims.map((c) => ({ op: "unconstrain", constraintId: c.id })), { op: "set", entityId: e.id, values: { x1: q[0], y1: q[1] } }, ...bound(e.id, "start", q)];
    }
    if (hi === 1) {
      const q = at(lo);
      return [...touching("end").map((c) => ({ op: "unconstrain", constraintId: c.id })), ...lengthDims.map((c) => ({ op: "unconstrain", constraintId: c.id })), { op: "set", entityId: e.id, values: { x2: q[0], y2: q[1] } }, ...bound(e.id, "end", q)];
    }
    const q0 = at(lo),
      q1 = at(hi);
    const endRelations = touching("end");
    return [
      ...endRelations.map((c) => ({ op: "unconstrain", constraintId: c.id })),
      ...lengthDims.map((c) => ({ op: "unconstrain", constraintId: c.id })),
      { op: "set", entityId: e.id, values: { x2: q0[0], y2: q0[1] } },
      { op: "add", ref: "$n", type: "line", values: { x1: q1[0], y1: q1[1], x2: b[0], y2: b[1] }, construction: e.construction },
      { op: "constrain", type: "collinear", entities: [e.id, "$n"] },
      ...bound(e.id, "end", q0),
      ...bound("$n", "start", q1),
      ...endRelations.map((c) => {
        const other = c.entityIds[0] === e.id ? 1 : 0;
        return { op: "constrain", type: c.type, entities: ["$n", c.entityIds[other]], anchors: ["end", c.anchors?.[other] ?? "center"] };
      }),
    ];
  }
  if (e.type === "spline") {
    // Trimming narrows the kept parameter range, so the kept curve is exactly
    // the original one and every fit point still shapes it.
    const points = fitPoints(e),
      n = points.length - 1,
      closed = splineClosed(points),
      [from, to] = splineRange(e);
    const lift = (u: number) => (closed && u < from - 1e-9 ? u + n : u);
    const us = crossings
      .map((q) => lift(splineParam(points, q)))
      .filter((u) => u > from + 1e-6 && u < to - 1e-6)
      .sort((x, y) => x - y)
      .filter((u, i, all) => i === 0 || u - all[i - 1] > 1e-9);
    const up = lift(splineParam(points, p));
    const range = (a: number, b: number) => ({ from: a, to: b });
    if (closed && !("from" in e.values)) {
      // A whole closed spline keeps the part from the next crossing round to the previous one.
      if (us.length < 2) return [{ op: "delete", entityId: e.id }];
      const lo = [...us].reverse().find((u) => u < up),
        hi = us.find((u) => u > up);
      const kept = lo === undefined || hi === undefined ? range(us[0], us[us.length - 1]) : range(hi, lo + n);
      return [{ op: "set", entityId: e.id, values: kept }, ...bound(e.id, "start", splineAt(points, kept.from)), ...bound(e.id, "end", splineAt(points, kept.to))];
    }
    const lo = [...us].reverse().find((u) => u < up) ?? from,
      hi = us.find((u) => u > up) ?? to;
    if (lo === from && hi === to) return [{ op: "delete", entityId: e.id }];
    const touching = (anchor: string) =>
      s.constraints.filter((c) => c.entityIds.some((id, i) => id === e.id && c.anchors?.[i] === anchor));
    const at = (u: number) => splineAt(points, u);
    if (lo === from) return [...touching("start").map((c) => ({ op: "unconstrain", constraintId: c.id })), { op: "set", entityId: e.id, values: range(hi, to) }, ...bound(e.id, "start", at(hi))];
    if (hi === to) return [...touching("end").map((c) => ({ op: "unconstrain", constraintId: c.id })), { op: "set", entityId: e.id, values: range(from, lo) }, ...bound(e.id, "end", at(lo))];
    // A cut in the middle leaves two pieces of the same curve.
    const endRelations = touching("end");
    return [
      ...endRelations.map((c) => ({ op: "unconstrain", constraintId: c.id })),
      { op: "set", entityId: e.id, values: range(from, lo) },
      { op: "add", ref: "$n", type: "spline", values: { ...e.values, ...range(hi, to) }, construction: e.construction },
      ...bound(e.id, "end", at(lo)),
      ...bound("$n", "start", at(hi)),
      ...endRelations.map((c) => {
        const other = c.entityIds[0] === e.id ? 1 : 0;
        return { op: "constrain", type: c.type, entities: ["$n", c.entityIds[other]], anchors: ["end", c.anchors?.[other] ?? "center"] };
      }),
    ];
  }
  if (e.type === "circle" || e.type === "arc") {
    const g = e.type === "circle" ? { center: [e.values.x, e.values.y] as Vec2, radius: e.values.radius, start: 0, sweep: TAU } : arcGeometry(e)!;
    const rel = (q: Vec2) => (((Math.atan2(q[1] - g.center[1], q[0] - g.center[0]) - g.start) % TAU) + TAU) % TAU;
    const ts = [...new Set(crossings.map(rel).filter((t) => t > 1e-6 && t < g.sweep - 1e-6).map((t) => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
    const tp = rel(p);
    if (!ts.length) return [{ op: "delete", entityId: e.id }];
    const at = (t: number): Vec2 => [g.center[0] + g.radius * Math.cos(g.start + t), g.center[1] + g.radius * Math.sin(g.start + t)];
    const arcValues = (t0: number, t1: number) => {
      const a = at(t0),
        b = at(t1),
        m = at((t0 + t1) / 2);
      return { x1: a[0], y1: a[1], xm: m[0], ym: m[1], x2: b[0], y2: b[1] };
    };
    const relations = s.constraints.filter((c) => c.entityIds.includes(e.id));
    if (e.type === "circle") {
      // Keep the complementary arc.
      const lo = [...ts].reverse().find((t) => t < tp) ?? ts[ts.length - 1] - TAU,
        hi = ts.find((t) => t > tp) ?? ts[0] + TAU;
      return [
        { op: "delete", entityId: e.id },
        { op: "add", type: "arc", values: arcValues(hi, lo + TAU), construction: e.construction },
        ...relations.filter(() => false),
      ];
    }
    const lo = [...ts].reverse().find((t) => t < tp) ?? 0,
      hi = ts.find((t) => t > tp) ?? g.sweep;
    const ccwStartIsX1 = arcGeometry(e)!.ccw;
    const keep: [number, number][] = [];
    if (lo > 0) keep.push([0, lo]);
    if (hi < g.sweep) keep.push([hi, g.sweep]);
    if (!keep.length) return [{ op: "delete", entityId: e.id }];
    const ops: SketchOp[] = [{ op: "delete", entityId: e.id }];
    for (const [t0, t1] of keep) {
      const v = arcValues(t0, t1);
      ops.push({ op: "add", type: "arc", values: ccwStartIsX1 ? v : { x1: v.x2, y1: v.y2, xm: v.xm, ym: v.ym, x2: v.x1, y2: v.y1 }, construction: e.construction });
    }
    return ops;
  }
  return [{ op: "delete", entityId: e.id }];
}
function intersections(a: Entity, b: Entity): Vec2[] {
  if (a.type === "spline" || b.type === "spline") return entityIntersections(a, b);
  const out: Vec2[] = [];
  const curves = (e: Entity): ({ kind: "line"; a: Vec2; b: Vec2 } | { kind: "round"; c: Vec2; r: number; e: Entity })[] => {
    if (e.type === "line") return [{ kind: "line", a: point(e, "start"), b: point(e, "end") }];
    if (e.type === "rectangle") {
      const poly = entityPolyline(e);
      return poly.slice(0, 4).map((p, i) => ({ kind: "line" as const, a: p, b: poly[i + 1] }));
    }
    if (e.type === "circle") return [{ kind: "round", c: [e.values.x, e.values.y], r: e.values.radius, e }];
    if (e.type === "arc") {
      const g = arcGeometry(e);
      return g ? [{ kind: "round", c: g.center, r: g.radius, e }] : [];
    }
    return [];
  };
  const onEntity = (e: Entity, q: Vec2) => {
    const n = nearestOnEntity(e, q);
    return !n || dist(n, q) < 1e-6;
  };
  for (const x of curves(a))
    for (const y of curves(b)) {
      if (x.kind === "line" && y.kind === "line") {
        const r = sub(x.b, x.a),
          s = sub(y.b, y.a),
          d = cross2(r, s);
        if (Math.abs(d) < 1e-12) continue;
        const t = cross2(sub(y.a, x.a), s) / d,
          u = cross2(sub(y.a, x.a), r) / d;
        if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) out.push(add(x.a, mul(r, t)));
      } else if (x.kind === "round" && y.kind === "round") {
        const d = dist(x.c, y.c);
        if (d < 1e-9 || d > x.r + y.r || d < Math.abs(x.r - y.r)) continue;
        const k = (x.r * x.r - y.r * y.r + d * d) / (2 * d),
          h = Math.sqrt(Math.max(0, x.r * x.r - k * k));
        const u = norm(sub(y.c, x.c)),
          m = add(x.c, mul(u, k));
        for (const q of [add(m, mul(perp(u), h)), add(m, mul(perp(u), -h))]) if (onEntity(x.e, q) && onEntity(y.e, q)) out.push(q);
      } else {
        const line = (x.kind === "line" ? x : y) as { a: Vec2; b: Vec2 },
          round = (x.kind === "round" ? x : y) as { c: Vec2; r: number; e: Entity };
        const d = sub(line.b, line.a),
          f = sub(line.a, round.c);
        const A = dot(d, d),
          B = 2 * dot(f, d),
          C = dot(f, f) - round.r * round.r,
          disc = B * B - 4 * A * C;
        if (disc < 0) continue;
        for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
          if (t < -1e-9 || t > 1 + 1e-9) continue;
          const q = add(line.a, mul(d, t));
          if (onEntity(round.e, q)) out.push(q);
        }
      }
    }
  return out;
}
