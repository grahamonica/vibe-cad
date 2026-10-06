// Sketch tools that build related geometry from existing entities, the way a
// CAD sketcher does: offset chains, mirror about a line, and fillet or chamfer
// a corner. Each adds the relations that keep the result associative.
import type { Constraint, Entity, Sketch, Vec2 } from "./types.ts";
import { arcGeometry, fitPoints, point } from "./sketch-geometry.ts";
import { captureReference, validateConstraint } from "./solver.ts";

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit = (a: Vec2): Vec2 => mul(a, 1 / (len(a) || 1));
const left = (a: Vec2): Vec2 => [-a[1], a[0]];
const same = (a: Vec2, b: Vec2) => len(sub(a, b)) < 1e-6 * Math.max(1, len(a));

type NewId = () => string;
function relate(s: Sketch, id: NewId, c: Omit<Constraint, "id">) {
  const full = { id: id(), ...c } as Constraint;
  validateConstraint(s, full);
  captureReference(s, full);
  s.constraints.push(full);
  return full;
}
function entity(s: Sketch, id: NewId, type: Entity["type"], values: Record<string, number>, construction = false): Entity {
  const e: Entity = { id: id(), type, values, construction };
  s.entities.push(e);
  return e;
}
const find = (s: Sketch, id: string) => {
  const e = s.entities.find((x) => x.id === id);
  if (!e) throw Error(`Sketch entity ${id} not found`);
  return e;
};

// ---------------------------------------------------------------------------
// Offset

const ends = (e: Entity): [Vec2, Vec2] | undefined =>
  e.type === "line" || e.type === "arc" ? [point(e, "start"), point(e, "end")] : undefined;
interface Link {
  e: Entity;
  /** Traversed from end to start. */
  reversed: boolean;
}
/** Lines and arcs ordered into chains through shared endpoints. */
function chains(list: Entity[]): { links: Link[]; closed: boolean }[] {
  const pool = list.filter((e) => ends(e));
  const out: { links: Link[]; closed: boolean }[] = [];
  const free = (p: Vec2, self: Entity) => !pool.some((o) => o !== self && ends(o)!.some((q) => same(p, q)));
  while (pool.length) {
    const first = pool.find((e) => free(ends(e)![0], e) || free(ends(e)![1], e)) ?? pool[0];
    const links: Link[] = [{ e: first, reversed: !free(ends(first)![0], first) && free(ends(first)![1], first) }];
    pool.splice(pool.indexOf(first), 1);
    const tail = () => {
      const l = links.at(-1)!;
      return ends(l.e)![l.reversed ? 0 : 1];
    };
    for (;;) {
      const t = tail();
      const next = pool.find((e) => ends(e)!.some((q) => same(q, t)));
      if (!next) break;
      links.push({ e: next, reversed: !same(ends(next)![0], t) });
      pool.splice(pool.indexOf(next), 1);
    }
    const head = ends(links[0].e)![links[0].reversed ? 1 : 0];
    out.push({ links, closed: links.length > 1 && same(head, tail()) });
  }
  return out;
}
/** Travel direction of an arc between its endpoints, counter-clockwise or not. */
const travelsCcw = (l: Link) => {
  const g = arcGeometry(l.e)!;
  return l.reversed ? !g.ccw : g.ccw;
};
/** Left normal of a link at a point on it, along its travel direction. */
function leftAt(l: Link, p: Vec2): Vec2 {
  if (l.e.type === "line") {
    const [a, b] = ends(l.e)!;
    return left(unit(l.reversed ? sub(a, b) : sub(b, a)));
  }
  const c = arcGeometry(l.e)!.center;
  const out = unit(sub(p, c));
  return travelsCcw(l) ? mul(out, -1) : out;
}
function nearestOn(e: Entity, p: Vec2): Vec2 {
  if (e.type === "line") {
    const [a, b] = ends(e)!,
      d = sub(b, a),
      t = Math.max(0, Math.min(1, dot(sub(p, a), d) / (dot(d, d) || 1)));
    return add(a, mul(d, t));
  }
  const g = e.type === "circle" ? { center: point(e), radius: e.values.radius } : arcGeometry(e)!;
  return add(g.center, mul(unit(sub(p, g.center)), g.radius));
}
/** Signed area of a closed chain: positive when it runs counter-clockwise. */
function area(links: Link[]) {
  const pts: Vec2[] = [];
  for (const l of links) {
    if (l.e.type === "line") {
      const [a, b] = ends(l.e)!;
      pts.push(l.reversed ? b : a);
    } else {
      const g = arcGeometry(l.e)!,
        ccw = travelsCcw(l);
      const v = sub(point(l.e, l.reversed ? "end" : "start"), g.center),
        from = Math.atan2(v[1], v[0]);
      for (let i = 0; i < 16; i++) {
        const t = from + ((ccw ? 1 : -1) * g.sweep * i) / 16;
        pts.push(add(g.center, [g.radius * Math.cos(t), g.radius * Math.sin(t)]));
      }
    }
  }
  let a = 0;
  pts.forEach((p, i) => (a += cross(p, pts[(i + 1) % pts.length])));
  return a / 2;
}
type Carrier = { kind: "line"; p: Vec2; d: Vec2 } | { kind: "circle"; c: Vec2; r: number };
function intersections(a: Carrier, b: Carrier): Vec2[] {
  if (a.kind === "line" && b.kind === "line") {
    const det = cross(a.d, b.d);
    if (Math.abs(det) < 1e-12) return [];
    return [add(a.p, mul(a.d, cross(sub(b.p, a.p), b.d) / det))];
  }
  if (a.kind === "circle" && b.kind === "line") return intersections(b, a);
  if (a.kind === "line" && b.kind === "circle") {
    const d = unit(a.d),
      f = sub(a.p, b.c),
      t0 = -dot(f, d),
      h2 = b.r * b.r - (dot(f, f) - t0 * t0);
    if (h2 < -1e-9) return [];
    const h = Math.sqrt(Math.max(0, h2));
    return [add(a.p, mul(d, t0 - h)), add(a.p, mul(d, t0 + h))];
  }
  const ca = a as Extract<Carrier, { kind: "circle" }>,
    cb = b as Extract<Carrier, { kind: "circle" }>;
  const dv = sub(cb.c, ca.c),
    dd = len(dv);
  if (dd < 1e-12 || dd > ca.r + cb.r + 1e-9 || dd < Math.abs(ca.r - cb.r) - 1e-9) return [];
  const x = (ca.r * ca.r - cb.r * cb.r + dd * dd) / (2 * dd),
    y = Math.sqrt(Math.max(0, ca.r * ca.r - x * x));
  const u = unit(dv),
    m = add(ca.c, mul(u, x));
  return [add(m, mul(left(u), y)), add(m, mul(left(u), -y))];
}
/** Values of an arc on a circle between two points, travelling the same way as before. */
function arcValues(center: Vec2, r: number, start: Vec2, end: Vec2, ccw: boolean) {
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]),
    a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const TAU = Math.PI * 2;
  const sweep = ccw ? (((a1 - a0) % TAU) + TAU) % TAU : -((((a0 - a1) % TAU) + TAU) % TAU);
  const mid = add(center, [r * Math.cos(a0 + sweep / 2), r * Math.sin(a0 + sweep / 2)]);
  return { x1: start[0], y1: start[1], xm: mid[0], ym: mid[1], x2: end[0], y2: end[1] };
}

export interface OffsetOptions {
  distance: number;
  /** A point on the side to offset toward. */
  toward?: Vec2;
  side?: "inside" | "outside";
}
/**
 * Offset lines, arcs, circles and rectangles. Connected lines and arcs offset
 * as one chain whose corners are extended or trimmed to meet; one offset
 * dimension drives every copy. Returns the new entity ids.
 */
export function offsetEntities(s: Sketch, ids: string[], o: OffsetOptions, id: NewId): string[] {
  if (!(o.distance > 0)) throw Error("Offset distance must be positive");
  const sources = ids.map((x) => find(s, x));
  for (const e of sources)
    if (!["line", "arc", "circle", "rectangle"].includes(e.type)) throw Error("Offset lines, arcs, circles or rectangles");
  const pairs: string[] = [];
  const created: string[] = [];
  const d = o.distance;
  // Closed shapes on their own.
  for (const e of sources.filter((e) => e.type === "circle" || e.type === "rectangle")) {
    const inside =
      o.side === "inside" ||
      (!o.side &&
        !!o.toward &&
        (e.type === "circle"
          ? len(sub(o.toward, point(e))) < e.values.radius
          : Math.abs(o.toward[0] - e.values.x) < e.values.width / 2 && Math.abs(o.toward[1] - e.values.y) < e.values.height / 2));
    const k = inside ? -1 : 1;
    const values: Record<string, number> =
      e.type === "circle"
        ? { ...e.values, radius: e.values.radius + k * d }
        : { ...e.values, width: e.values.width + 2 * k * d, height: e.values.height + 2 * k * d };
    if ((values.radius ?? 1) <= 0 || (values.width ?? 1) <= 0 || (values.height ?? 1) <= 0)
      throw Error("The offset is larger than the shape");
    const copy = entity(s, id, e.type, values, e.construction);
    pairs.push(e.id, copy.id);
    created.push(copy.id);
  }
  // Chains of lines and arcs.
  for (const chain of chains(sources)) {
    const { links, closed } = chain;
    let k = 1;
    if (o.toward) {
      let best = { d: Infinity, l: links[0], p: [0, 0] as Vec2 };
      for (const l of links) {
        const p = nearestOn(l.e, o.toward),
          dd = len(sub(p, o.toward));
        if (dd < best.d) best = { d: dd, l, p };
      }
      k = dot(sub(o.toward, best.p), leftAt(best.l, best.p)) >= 0 ? 1 : -1;
    } else if (closed) {
      // Counter-clockwise loops have their inside on the left.
      const ccw = area(links) > 0;
      k = (o.side === "inside") === ccw ? 1 : -1;
    }
    const copies = links.map((l) => {
      const e = l.e;
      if (e.type === "line") {
        const v = mul(leftAt(l, point(e, "start")), k * d);
        return { l, values: { x1: e.values.x1 + v[0], y1: e.values.y1 + v[1], x2: e.values.x2 + v[0], y2: e.values.y2 + v[1] } };
      }
      const g = arcGeometry(e)!;
      // Left of a counter-clockwise arc is its center.
      const r = g.radius + (travelsCcw(l) ? -1 : 1) * k * d;
      if (r <= 1e-9) throw Error("The offset is larger than an arc radius");
      const scale = (p: Vec2) => add(g.center, mul(sub(p, g.center), r / g.radius));
      const [a, m, b] = (["start", "mid", "end"] as const).map((x) => scale(point(e, x)));
      return { l, values: { x1: a[0], y1: a[1], xm: m[0], ym: m[1], x2: b[0], y2: b[1] } };
    });
    const carrier = (c: (typeof copies)[number]): Carrier => {
      const v = c.values as Record<string, number>;
      if (c.l.e.type === "line") return { kind: "line", p: [v.x1, v.y1], d: [v.x2 - v.x1, v.y2 - v.y1] };
      const g = arcGeometry({ ...c.l.e, values: v })!;
      return { kind: "circle", c: g.center, r: g.radius };
    };
    const endKey = (c: (typeof copies)[number], atEnd: boolean) => ((c.l.reversed ? !atEnd : atEnd) ? "end" : "start");
    const getPoint = (c: (typeof copies)[number], anchor: "start" | "end"): Vec2 =>
      anchor === "start" ? [c.values.x1, c.values.y1] : [c.values.x2, c.values.y2];
    const setPoint = (c: (typeof copies)[number], anchor: "start" | "end", p: Vec2) => {
      if (c.l.e.type === "line") {
        if (anchor === "start") Object.assign(c.values, { x1: p[0], y1: p[1] });
        else Object.assign(c.values, { x2: p[0], y2: p[1] });
        return;
      }
      const g = arcGeometry({ ...c.l.e, values: c.values as Record<string, number> })!;
      const start = anchor === "start" ? p : getPoint(c, "start"),
        end = anchor === "end" ? p : getPoint(c, "end");
      Object.assign(c.values, arcValues(g.center, g.radius, start, end, g.ccw));
    };
    // Corners: where the copies of neighbors do not already meet, extend or trim them to their intersection.
    const joints: [number, number][] = [];
    for (let i = 0; i < copies.length - (closed ? 0 : 1); i++) joints.push([i, (i + 1) % copies.length]);
    const joined: { a: number; aKey: "start" | "end"; b: number; bKey: "start" | "end" }[] = [];
    for (const [i, j] of joints) {
      const A = copies[i],
        B = copies[j];
      const aKey = endKey(A, true),
        bKey = endKey(B, false);
      const pa = getPoint(A, aKey),
        pb = getPoint(B, bKey);
      if (!same(pa, pb)) {
        const guess = mul(add(pa, pb), 0.5);
        const hits = intersections(carrier(A), carrier(B)).sort((x, y) => len(sub(x, guess)) - len(sub(y, guess)));
        if (!hits.length) continue;
        setPoint(A, aKey, hits[0]);
        setPoint(B, bKey, hits[0]);
      }
      joined.push({ a: i, aKey, b: j, bKey });
    }
    const made = copies.map((c) => entity(s, id, c.l.e.type, c.values as Record<string, number>, c.l.e.construction));
    links.forEach((l, i) => pairs.push(l.e.id, made[i].id));
    created.push(...made.map((e) => e.id));
    for (const j of joined)
      relate(s, id, { type: "coincident", entityIds: [made[j.a].id, made[j.b].id], anchors: [j.aKey, j.bKey] });
  }
  if (pairs.length) relate(s, id, { type: "offset", entityIds: pairs, value: d });
  return created;
}

// ---------------------------------------------------------------------------
// Mirror

/** Mirror entities about a line, tied by symmetric relations. Returns the new ids. */
export function mirrorEntities(s: Sketch, ids: string[], axisId: string, id: NewId): string[] {
  const axis = find(s, axisId);
  if (axis.type !== "line") throw Error("Mirror about a line");
  const a = point(axis, "start"),
    u = unit(sub(point(axis, "end"), a));
  const reflect = (p: Vec2): Vec2 => sub(mul(add(a, mul(u, dot(sub(p, a), u))), 2), p);
  const created: string[] = [];
  for (const sourceId of ids) {
    if (sourceId === axisId) continue;
    const e = find(s, sourceId),
      v = e.values;
    const sym = (copy: Entity, anchors: [string, string][]) => {
      for (const [p, q] of anchors) relate(s, id, { type: "symmetric", entityIds: [e.id, copy.id, axis.id], anchors: [p, q] });
    };
    if (e.type === "point") {
      const p = reflect([v.x, v.y]);
      const copy = entity(s, id, "point", { x: p[0], y: p[1] }, e.construction);
      sym(copy, [["center", "center"]]);
      created.push(copy.id);
    } else if (e.type === "line") {
      const p = reflect([v.x1, v.y1]),
        q = reflect([v.x2, v.y2]);
      const copy = entity(s, id, "line", { x1: p[0], y1: p[1], x2: q[0], y2: q[1] }, e.construction);
      sym(copy, [
        ["start", "start"],
        ["end", "end"],
      ]);
      created.push(copy.id);
    } else if (e.type === "circle") {
      const c = reflect([v.x, v.y]);
      const copy = entity(s, id, "circle", { x: c[0], y: c[1], radius: v.radius }, e.construction);
      sym(copy, [["center", "center"]]);
      relate(s, id, { type: "equal", entityIds: [e.id, copy.id] });
      created.push(copy.id);
    } else if (e.type === "arc") {
      const [p, m, q] = (["start", "mid", "end"] as const).map((k) => reflect(point(e, k)));
      const copy = entity(s, id, "arc", { x1: p[0], y1: p[1], xm: m[0], ym: m[1], x2: q[0], y2: q[1] }, e.construction);
      sym(copy, [
        ["start", "start"],
        ["end", "end"],
      ]);
      relate(s, id, { type: "equal", entityIds: [e.id, copy.id] });
      created.push(copy.id);
    } else if (e.type === "spline") {
      const values: Record<string, number> = {},
        n = fitPoints(e).length;
      fitPoints(e).forEach((q, i) => {
        const r = reflect(q);
        values[`x${i}`] = r[0];
        values[`y${i}`] = r[1];
      });
      if ("from" in v) Object.assign(values, { from: v.from, to: v.to });
      const copy = entity(s, id, "spline", values, e.construction);
      sym(copy, [
        ...Array.from({ length: n }, (_, i): [string, string] => [`p${i}`, `p${i}`]),
        ...("from" in v
          ? ([
              ["start", "start"],
              ["end", "end"],
            ] as [string, string][])
          : []),
      ]);
      created.push(copy.id);
    } else if (e.type === "rectangle") {
      const vertical = Math.abs(u[0]) < 1e-9,
        horizontal = Math.abs(u[1]) < 1e-9;
      if (!vertical && !horizontal) throw Error("Mirror rectangles about a horizontal or vertical line");
      const c = reflect([v.x, v.y]);
      const copy = entity(s, id, "rectangle", { ...v, x: c[0], y: c[1] }, e.construction);
      sym(
        copy,
        vertical
          ? [
              ["bottomLeft", "bottomRight"],
              ["topRight", "topLeft"],
            ]
          : [
              ["bottomLeft", "topLeft"],
              ["topRight", "bottomRight"],
            ],
      );
      created.push(copy.id);
    }
  }
  if (!created.length) throw Error("Select geometry to mirror besides the mirror line");
  return created;
}

// ---------------------------------------------------------------------------
// Fillet and chamfer

/**
 * Round or bevel the corner between two lines that share an endpoint. The
 * lines are trimmed back; a construction point stays at the virtual sharp
 * corner so dimensions to the corner keep their meaning. Returns the new
 * arc or chamfer line id.
 */
export function cornerEntities(
  s: Sketch,
  lineIds: [string, string],
  o: { kind: "fillet"; radius: number } | { kind: "chamfer"; distance: number; distance2?: number },
  id: NewId,
): string {
  const [la, lb] = lineIds.map((x) => find(s, x));
  if (la.type !== "line" || lb.type !== "line") throw Error("Select two lines that meet at a corner");
  let corner: { a: "start" | "end"; b: "start" | "end" } | undefined;
  for (const ka of ["start", "end"] as const)
    for (const kb of ["start", "end"] as const) if (!corner && same(point(la, ka), point(lb, kb))) corner = { a: ka, b: kb };
  if (!corner) throw Error("The lines must share an endpoint");
  const P = point(la, corner.a);
  const farA = point(la, corner.a === "start" ? "end" : "start"),
    farB = point(lb, corner.b === "start" ? "end" : "start");
  const ua = unit(sub(farA, P)),
    ub = unit(sub(farB, P));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(ua, ub))));
  if (theta < 1e-3 || Math.PI - theta < 1e-3) throw Error("The lines are parallel at this corner");
  let ta: number, tb: number;
  if (o.kind === "fillet") {
    if (!(o.radius > 0)) throw Error("Fillet radius must be positive");
    ta = tb = o.radius / Math.tan(theta / 2);
  } else {
    if (!(o.distance > 0)) throw Error("Chamfer distance must be positive");
    ta = o.distance;
    tb = o.distance2 ?? o.distance;
  }
  if (ta >= len(sub(farA, P)) - 1e-9 || tb >= len(sub(farB, P)) - 1e-9)
    throw Error(`The ${o.kind} is larger than the lines it trims`);
  const Ta = add(P, mul(ua, ta)),
    Tb = add(P, mul(ub, tb));
  // Relations on the corner move to a construction point at the virtual sharp.
  const sharp = entity(s, id, "point", { x: P[0], y: P[1] }, true);
  const atCorner = (eid: string, anchor?: string) =>
    (eid === la.id && anchor === corner!.a) || (eid === lb.id && anchor === corner!.b);
  const kept: Constraint[] = [];
  for (const c of s.constraints) {
    const touches = c.entityIds.some((eid, i) => atCorner(eid, c.anchors?.[i]));
    const lengthOf = c.type === "length" && (c.entityIds[0] === la.id || c.entityIds[0] === lb.id);
    if (lengthOf) {
      // Length of a trimmed line becomes the distance from its far end to the sharp.
      const line = c.entityIds[0] === la.id ? la : lb,
        far = (line === la ? corner.a : corner.b) === "start" ? "end" : "start";
      kept.push({ ...c, type: "distance", entityIds: [line.id, sharp.id], anchors: [far, "center"], reference: undefined, axis: undefined });
      continue;
    }
    if (!touches) {
      kept.push(c);
      continue;
    }
    // The corner itself: both lines now pass through the sharp.
    if (c.type === "coincident" && c.entityIds.every((eid, i) => atCorner(eid, c.anchors?.[i]))) continue;
    kept.push({
      ...c,
      entityIds: c.entityIds.map((eid, i) => (atCorner(eid, c.anchors?.[i]) ? sharp.id : eid)),
      anchors: c.anchors?.map((k, i) => (atCorner(c.entityIds[i], k) ? "center" : k)),
    });
  }
  s.constraints = kept;
  const setEnd = (l: Entity, key: "start" | "end", p: Vec2) =>
    Object.assign(l.values, key === "start" ? { x1: p[0], y1: p[1] } : { x2: p[0], y2: p[1] });
  setEnd(la, corner.a, Ta);
  setEnd(lb, corner.b, Tb);
  for (const c of s.constraints.filter((c) => c.type === "distance" && c.entityIds[1] === sharp.id && c.reference === undefined))
    captureReference(s, c);
  relate(s, id, { type: "pointOn", entityIds: [sharp.id, la.id], anchors: ["center"] });
  relate(s, id, { type: "pointOn", entityIds: [sharp.id, lb.id], anchors: ["center"] });
  let made: Entity;
  if (o.kind === "fillet") {
    const center = add(P, mul(unit(add(ua, ub)), o.radius / Math.sin(theta / 2)));
    const mid = add(center, mul(unit(sub(P, center)), o.radius));
    made = entity(s, id, "arc", { x1: Ta[0], y1: Ta[1], xm: mid[0], ym: mid[1], x2: Tb[0], y2: Tb[1] }, la.construction && lb.construction);
    relate(s, id, { type: "tangent", entityIds: [made.id, la.id] });
    relate(s, id, { type: "tangent", entityIds: [made.id, lb.id] });
    relate(s, id, { type: "radius", entityIds: [made.id], value: o.radius });
  } else {
    made = entity(s, id, "line", { x1: Ta[0], y1: Ta[1], x2: Tb[0], y2: Tb[1] }, la.construction && lb.construction);
    relate(s, id, { type: "distance", entityIds: [made.id, sharp.id], anchors: ["start", "center"], value: ta });
    relate(s, id, { type: "distance", entityIds: [made.id, sharp.id], anchors: ["end", "center"], value: tb });
  }
  relate(s, id, { type: "coincident", entityIds: [made.id, la.id], anchors: ["start", corner.a] });
  relate(s, id, { type: "coincident", entityIds: [made.id, lb.id], anchors: ["end", corner.b] });
  return made.id;
}

// ---------------------------------------------------------------------------
// Patterns

export interface PatternOptions {
  kind: "linear" | "circular";
  /** Instances including the original. */
  count: number;
  /** Linear: distance between instances. */
  spacing?: number;
  /** Linear: direction in degrees from the sketch X axis. */
  direction?: number;
  /** Circular: total angle in degrees; 360 spaces instances evenly around. */
  angle?: number;
  /** Circular: a point, circle or arc to turn about, or sketch coordinates (default origin). */
  center?: string | Vec2;
}
/**
 * Repeat entities along a direction or around a center. One pattern relation
 * keeps every copy tied to its source, with the spacing or total angle as its
 * dimension. Returns the new entity ids.
 */
export function patternEntities(s: Sketch, ids: string[], o: PatternOptions, id: NewId): string[] {
  if (!Number.isInteger(o.count) || o.count < 2 || o.count > 100) throw Error("Pattern 2 to 100 instances");
  const sources = ids.map((x) => find(s, x));
  for (const e of sources)
    if (e.type === "rectangle" && o.kind === "circular") throw Error("Rectangles pattern only along a line; draw them as lines to rotate them");
  const ordered = [...new Set(sources)];
  let centerEntity: Entity | undefined;
  let move: (p: Vec2, k: number) => Vec2;
  if (o.kind === "linear") {
    if (!(o.spacing && o.spacing > 0)) throw Error("Give a positive pattern spacing");
    const t = ((o.direction ?? 0) * Math.PI) / 180,
      step: Vec2 = [o.spacing * Math.cos(t), o.spacing * Math.sin(t)];
    move = (p, k) => add(p, mul(step, k));
  } else {
    const total = o.angle ?? 360;
    if (!(total > 0 && total <= 360)) throw Error("Pattern angle must be between 0 and 360 degrees");
    if (typeof o.center === "string") centerEntity = find(s, o.center);
    else {
      const at = o.center ?? [0, 0];
      // Reuse a fixed point already there (such as the sketch origin).
      centerEntity = s.entities.find(
        (e) => e.type === "point" && same(point(e), at) && s.constraints.some((c) => c.type === "fixed" && c.entityIds[0] === e.id),
      );
      if (!centerEntity) {
        centerEntity = entity(s, id, "point", { x: at[0], y: at[1] }, true);
        relate(s, id, { type: "fixed", entityIds: [centerEntity.id] });
      }
    }
    const c = point(centerEntity, "center"),
      step = ((total * Math.PI) / 180) / (Math.abs(total - 360) < 1e-9 ? o.count : o.count - 1);
    move = (p, k) => {
      const d = sub(p, c),
        t = step * k;
      return [c[0] + d[0] * Math.cos(t) - d[1] * Math.sin(t), c[1] + d[0] * Math.sin(t) + d[1] * Math.cos(t)];
    };
  }
  const copies: string[] = [];
  for (let k = 1; k < o.count; k++)
    for (const e of ordered) {
      const v = e.values;
      let values: Record<string, number>;
      if (e.type === "line") {
        const a = move([v.x1, v.y1], k),
          b = move([v.x2, v.y2], k);
        values = { x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
      } else if (e.type === "arc") {
        const [a, m, b] = (["start", "mid", "end"] as const).map((x) => move(point(e, x), k));
        values = { x1: a[0], y1: a[1], xm: m[0], ym: m[1], x2: b[0], y2: b[1] };
      } else if (e.type === "circle") {
        const c = move([v.x, v.y], k);
        values = { x: c[0], y: c[1], radius: v.radius };
      } else if (e.type === "point") {
        const c = move([v.x, v.y], k);
        values = { x: c[0], y: c[1] };
      } else if (e.type === "spline") {
        values = {};
        fitPoints(e).forEach((q, i) => {
          const r = move(q, k);
          values[`x${i}`] = r[0];
          values[`y${i}`] = r[1];
        });
        if ("from" in v) Object.assign(values, { from: v.from, to: v.to });
      } else {
        const c = move([v.x, v.y], k);
        values = { ...v, x: c[0], y: c[1] };
      }
      copies.push(entity(s, id, e.type, values, e.construction).id);
    }
  relate(s, id, {
    type: "pattern",
    entityIds: [...(centerEntity ? [centerEntity.id] : []), ...ordered.map((e) => e.id), ...copies],
    value: o.kind === "linear" ? o.spacing! : (o.angle ?? 360),
    pattern: { kind: o.kind, count: o.count, sources: ordered.length, ...(o.kind === "linear" ? { angle: o.direction ?? 0 } : {}) },
  });
  return copies;
}
