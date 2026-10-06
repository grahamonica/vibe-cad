import { Euler, Quaternion, Vector3 } from "three";
import { rotateTensor } from "./mass.ts";
import { findTopology } from "./topology-key.ts";
import { allComponents, componentOf, type ComponentInstance, type ComponentPattern } from "./types.ts";
import type {
  Document,
  Geometry,
  Mate,
  Placement,
  Topology,
  Vec3,
  TopologyRef,
} from "./types.ts";
const v = (a: Vec3) => new Vector3(...a);
const q = (p: Placement) => new Quaternion(...p.quaternion);
export function point(a: Vec3, p: Placement): Vec3 {
  return v(a).applyQuaternion(q(p)).add(v(p.position)).toArray() as Vec3;
}
export function direction(a: Vec3, p: Placement): Vec3 {
  return v(a).applyQuaternion(q(p)).toArray() as Vec3;
}
const identity = (): Placement => ({
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
});
/** A direction square to an axis, the same for the same axis. */
const square = (axis: Vector3) =>
  axis
    .clone()
    .cross(Math.abs(axis.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0))
    .normalize();
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
/** Rank of a matrix given by its columns (Gaussian elimination with full pivoting). */
function rank(columns: number[][]) {
  const rows = columns[0]?.length ?? 0;
  const M = Array.from({ length: rows }, (_, i) => columns.map((c) => c[i]));
  const scale = Math.max(1e-12, ...M.flat().map(Math.abs));
  let r = 0;
  for (let c = 0; c < columns.length && r < rows; c++) {
    let pivot = r;
    for (let i = r + 1; i < rows; i++) if (Math.abs(M[i][c]) > Math.abs(M[pivot][c])) pivot = i;
    if (Math.abs(M[pivot][c]) < 1e-7 * scale) continue;
    [M[r], M[pivot]] = [M[pivot], M[r]];
    for (let i = r + 1; i < rows; i++) {
      const f = M[i][c] / M[r][c];
      for (let k = c; k < columns.length; k++) M[i][k] -= f * M[r][k];
    }
    r++;
  }
  return r;
}
/** Solve A x = b by Gaussian elimination with partial pivoting (small dense systems). */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length,
    M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    const d = M[c][c] || 1e-300;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = M[r][n];
    for (let k = r + 1; k < n; k++) sum -= M[r][k] * x[k];
    x[r] = sum / (M[r][r] || 1e-300);
  }
  return x;
}
/**
 * How far a placed part has turned about a world axis (radians): the angle,
 * about that axis, from a fixed world direction to a direction fixed in the
 * part (square to the part's own local axis).
 */
function turnAbout(localAxis: Vector3, p: Placement, worldAxis: Vector3) {
  const n = worldAxis.clone().normalize(),
    u = square(localAxis.clone().normalize()).applyQuaternion(q(p)),
    w = square(n);
  return Math.atan2(n.dot(w.clone().cross(u)), w.dot(u));
}
/**
 * A gear mate's two turns: the target's about its axis, the moving part's
 * about its own axis pointed the target's way. The mate holds
 * moving = phase ± ratio × target (− for gears in external mesh).
 */
function gearTurns(targetAxis: Vector3, pb: Placement, movingAxis: Vector3, pa: Placement) {
  const nA = targetAxis.clone().applyQuaternion(q(pb)),
    nB = movingAxis.clone().applyQuaternion(q(pa));
  const s = Math.sign(nA.dot(nB)) || 1;
  return { target: turnAbout(targetAxis, pb, nA), moving: turnAbout(movingAxis, pa, nB.clone().multiplyScalar(s)), axis: nB.multiplyScalar(s) };
}
const gearWant = (m: Pick<Mate, "value" | "aligned" | "phase">, target: number) => ((m.phase ?? 0) * Math.PI) / 180 + (m.aligned ? 1 : -1) * m.value * target;
/**
 * The phase (degrees) that keeps two gears as they sit now: given each one's
 * axis and placement in the assembly, as the view reports them.
 */
export function gearPhase(ratio: number, aligned: boolean, target: { axis: Vec3; placement: Placement }, moving: { axis: Vec3; placement: Placement }) {
  const local = (axis: Vec3, p: Placement) => v(axis).applyQuaternion(q(p).invert());
  const t = gearTurns(local(target.axis, target.placement), target.placement, local(moving.axis, moving.placement), moving.placement);
  return (wrap(t.moving - (aligned ? 1 : -1) * ratio * t.target) * 180) / Math.PI;
}
/** Cylinder and plane of a tangent mate, placed. */
function tangentPair(ta: Topology, tb: Topology, pa: Placement, pb: Placement) {
  const round = (t: Topology) => t.kind === "face" && t.geomType !== "PLANE" && !!t.axis && !!t.radius;
  const movingIsCylinder = round(ta);
  const [cyl, plane, pc, pp] = movingIsCylinder ? [ta, tb, pa, pb] : [tb, ta, pb, pa];
  if (!round(cyl) || plane.geomType !== "PLANE" || !plane.normal)
    throw Error("Tangent mates join a cylindrical face and a planar face");
  return {
    movingIsCylinder,
    radius: cyl.radius!,
    axisPoint: v(point(cyl.axis!.origin, pc)),
    axis: v(direction(cyl.axis!.direction, pc)).normalize(),
    planePoint: v(point(plane.center, pp)),
    normal: v(direction(plane.normal, pp)).normalize(),
  };
}
/** One relaxation step: the cylinder axis lies parallel to the plane, one radius away, on its current side. */
function tangentStep(m: Mate, ta: Topology, tb: Topology, pa: Placement, pb: Placement) {
  let t = tangentPair(ta, tb, pa, pb);
  // Turn the moving part so the axis runs along the plane.
  const [turning, fixed] = t.movingIsCylinder ? [t.axis, t.normal] : [t.normal, t.axis];
  let goal = turning.clone().addScaledVector(fixed, -turning.dot(fixed));
  if (goal.length() < 1e-9) goal = new Vector3(1, 0, 0).cross(fixed).length() > 1e-6 ? new Vector3(1, 0, 0).cross(fixed) : new Vector3(0, 1, 0).cross(fixed);
  pa.quaternion = new Quaternion()
    .setFromUnitVectors(turning, goal.normalize())
    .multiply(q(pa))
    .normalize()
    .toArray() as Placement["quaternion"];
  t = tangentPair(ta, tb, pa, pb);
  const d = t.axisPoint.clone().sub(t.planePoint).dot(t.normal);
  const side = (d >= 0 ? 1 : -1) * (m.aligned ? -1 : 1);
  const move = side * t.radius - d;
  // The cylinder moves along the normal; a moving plane moves the other way.
  pa.position = v(pa.position)
    .addScaledVector(t.normal, t.movingIsCylinder ? move : -move)
    .toArray() as Vec3;
}
function tangentResidual(ta: Topology, tb: Topology, pa: Placement, pb: Placement) {
  const t = tangentPair(ta, tb, pa, pb);
  const d = t.axisPoint.clone().sub(t.planePoint).dot(t.normal);
  return Math.max(Math.abs(t.axis.dot(t.normal)), Math.abs(Math.abs(d) - t.radius));
}
/** Placement of instance k of a component pattern, from its source's solved placement. */
function patternPlacement(p: ComponentPattern, k: number, source: Placement, ref: Topology | undefined, frame: Placement): Placement {
  if (p.kind === "linear") {
    let d = ref ? v(direction(ref.axis?.direction ?? ref.normal ?? [1, 0, 0], frame)) : v(p.direction ?? [1, 0, 0]);
    if (d.length() < 1e-12) throw Error(`${p.name}: the pattern direction has no length`);
    d = d.normalize().multiplyScalar((p.spacing ?? 0) * k);
    return { position: v(source.position).add(d).toArray() as Vec3, quaternion: [...source.quaternion] };
  }
  const axis = ref?.axis ? { origin: point(ref.axis.origin, frame), direction: direction(ref.axis.direction, frame) } : p.axis;
  if (!axis) throw Error(`${p.name}: choose the axis to turn about`);
  const total = p.angle ?? 360,
    step = (total * Math.PI) / 180 / (Math.abs(total - 360) < 1e-9 ? p.count : p.count - 1);
  const turn = new Quaternion().setFromAxisAngle(v(axis.direction).normalize(), step * k);
  const o = v(axis.origin);
  return {
    position: v(source.position).sub(o).applyQuaternion(turn).add(o).toArray() as Vec3,
    quaternion: turn.clone().multiply(q(source)).normalize().toArray() as Placement["quaternion"],
  };
}
/** How a mate solved: met, over-defining (left unsolved), or unusable (missing or unsuitable geometry). */
export interface MateStatus {
  status: "ok" | "over" | "error";
  message?: string;
  /** For a mate left unsolved: how far it is from met (mm, or radians for a direction). */
  residual?: number;
}
/** Mate and component states, as SolidWorks shows them: (f) fixed, (-) under-defined, fully defined, (+) over-defined. */
export interface SolveReport {
  mates: Record<string, MateStatus>;
  components: Record<string, { status: "fixed" | "under" | "full" | "over"; dof: number }>;
}
export interface SolveOptions {
  /** Filled with each mate's and component's state. */
  report?: SolveReport;
  /** Starting placements by component id (such as the previous step of a motion) instead of the stored ones. */
  initial?: Record<string, Placement>;
  /** Components that should move least where a loop of mates has freedom to spare: a dragged or driven part. */
  anchor?: string[];
}
/** A placement's rotation as stored on a component: XYZ Euler angles in degrees. */
export function eulerDegrees(p: Placement): Vec3 {
  const e = new Euler().setFromQuaternion(q(p).normalize(), "XYZ");
  return [e.x, e.y, e.z].map((a) => (a * 180) / Math.PI) as Vec3;
}
/** Mates in play: not suppressed, and not on a suppressed component (SolidWorks sets those aside too). */
export function activeMates(doc: Document): Mate[] {
  const off = (bodyId: string) => !!componentOf(doc, bodyId)?.suppressed;
  return (doc.mates ?? []).filter((m) => !m.suppressed && !off(m.moving.bodyId) && !off(m.target.bodyId));
}
/**
 * Closed loops of mates, such as a four-bar lifter, as groups of components
 * that must be solved together. Grounded parts, and parts no mate moves, are
 * one fixed frame; gear mates drive one way and close no loop.
 */
export function mateLoops(doc: Document): string[][] {
  const mates = activeMates(doc);
  const nodeOf = (ref: TopologyRef) => {
    const c = componentOf(doc, ref.bodyId) as ComponentInstance | undefined;
    if (!c) return undefined;
    return c.patternOf ? (doc.componentPatterns?.find((p) => p.id === c.patternOf!.patternId)?.componentId ?? c.id) : c.id;
  };
  const moved = new Set(mates.map((m) => nodeOf(m.moving)));
  const grounded = new Set((doc.components ?? []).filter((c) => c.grounded).map((c) => c.id));
  const node = (id: string) => (grounded.has(id) || !moved.has(id) ? "#" : id);
  const adjacent = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacent.has(a)) adjacent.set(a, new Set());
    adjacent.get(a)!.add(b);
  };
  for (const m of mates) {
    if (m.type === "gear") continue;
    const [a, b] = [nodeOf(m.moving), nodeOf(m.target)];
    if (!a || !b || node(a) === node(b)) continue;
    link(node(a), node(b));
    link(node(b), node(a));
  }
  // Bridges (Tarjan): mates on no cycle.
  const found = new Map<string, number>(),
    low = new Map<string, number>(),
    bridges = new Set<string>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  let clock = 0;
  const visit = (u: string, from?: string) => {
    found.set(u, clock);
    low.set(u, clock++);
    for (const w of adjacent.get(u) ?? []) {
      if (w === from) continue;
      if (!found.has(w)) {
        visit(w, u);
        low.set(u, Math.min(low.get(u)!, low.get(w)!));
        if (low.get(w)! > found.get(u)!) bridges.add(key(u, w));
      } else low.set(u, Math.min(low.get(u)!, found.get(w)!));
    }
  };
  for (const u of adjacent.keys()) if (!found.has(u)) visit(u);
  // Parts joined by mates on a cycle, the fixed frame left out, form one loop.
  const root = new Map<string, string>();
  const find = (x: string): string => (root.get(x) === x ? x : find(root.get(x)!));
  for (const [u, ws] of adjacent)
    for (const w of ws) {
      if (u === "#" || w === "#" || bridges.has(key(u, w))) continue;
      if (!root.has(u)) root.set(u, u);
      if (!root.has(w)) root.set(w, w);
      root.set(find(u), find(w));
    }
  const groups = new Map<string, string[]>();
  for (const x of root.keys()) groups.set(find(x), [...(groups.get(find(x)) ?? []), x]);
  return [...groups.values()];
}
/** Solved placements of every component (and component pattern instance). */
export function solveComponents(doc: Document, topology: Topology[], options: SolveOptions = {}): Record<string, Placement> {
  const placements: Record<string, Placement> = {};
  const owner = new Map<string, string>();
  for (const c of doc.components ?? []) {
    const start = options.initial?.[c.id];
    placements[c.id] = start
      ? { position: [...start.position], quaternion: [...start.quaternion] }
      : {
          position: [...c.position],
          quaternion: new Quaternion()
            .setFromEuler(new Euler(...(c.rotation.map((n) => (n * Math.PI) / 180) as Vec3), "XYZ"))
            .toArray() as Placement["quaternion"],
        };
    for (const id of c.bodyIds) owner.set(id, c.id);
  }
  const refs = (ref: TopologyRef) => {
    const t = findTopology(topology, ref);
    if (!t)
      throw Error("Mate geometry no longer resolves; reselect its references");
    const componentId = owner.get(ref.bodyId) ?? componentOf(doc, ref.bodyId)?.id;
    if (!componentId) throw Error("Mate references must belong to components");
    return { t, componentId };
  };
  // Concentric mates use the axis of a circular edge or cylindrical face;
  // other mates use planar face normals.
  const axial = (t: Topology) =>
    (t.kind === "edge" && t.geomType === "CIRCLE") ||
    (t.kind === "face" && !!t.axis && t.geomType !== "PLANE");
  const normal = (t: Topology) => {
    if (axial(t)) return v(t.axis?.direction ?? t.normal!).normalize();
    if (t.kind === "face" && t.geomType !== "PLANE")
      throw Error(
        "Face mates require planar faces; select circular edges or cylindrical faces for concentric mates",
      );
    if (t.kind === "edge")
      throw Error("Axis mates require circular edges or cylindrical faces");
    if (!t.normal) throw Error("This selection has no mating plane or axis");
    return v(t.normal).normalize();
  };
  const anchor = (t: Topology): Vec3 => (axial(t) && t.axis ? t.axis.origin : t.center);
  const mates = activeMates(doc);
  const nameOf = (id: string) => doc.components?.find((c) => c.id === id)?.name ?? id;
  /** How far a mate is from being met (radians or mm). */
  const mateError = (m: Mate, a: { t: Topology }, b: { t: Topology }, pa: Placement, pb: Placement) => {
    if (m.type === "gear") {
      const t = gearTurns(normal(b.t), pb, normal(a.t), pa);
      return Math.abs(wrap(gearWant(m, t.target) - t.moving));
    }
    if (m.type === "tangent") return tangentResidual(a.t, b.t, pa, pb);
    const na = normal(a.t).applyQuaternion(q(pa)),
      nb = normal(b.t).applyQuaternion(q(pb));
    const delta = v(point(anchor(a.t), pa)).sub(v(point(anchor(b.t), pb)));
    if (m.type === "lock") return Math.max(delta.length(), 1 - Math.abs(q(pa).dot(q(pb))));
    const angle = Math.acos(Math.max(-1, Math.min(1, na.dot(nb))));
    if (m.type === "angle") return Math.abs(angle - (m.value * Math.PI) / 180);
    if (m.type === "perpendicular") return Math.abs(na.dot(nb));
    let residual = Math.abs(na.dot(nb) - (m.aligned ? 1 : -1));
    if (m.type === "coincident" || m.type === "distance") residual = Math.max(residual, Math.abs(delta.dot(nb) - (m.type === "distance" ? m.value : 0)));
    if (m.type === "concentric") residual = Math.max(residual, delta.addScaledVector(nb, -delta.dot(nb)).length());
    return residual;
  };
  /** A mate's residuals for simultaneous solving: millimeters, with directions scaled by a part-sized length. */
  const mateResidual = (m: Mate, a: { t: Topology }, b: { t: Topology }, pa: Placement, pb: Placement, size: number): number[] => {
    if (m.type === "gear") {
      const t = gearTurns(normal(b.t), pb, normal(a.t), pa);
      return [wrap(gearWant(m, t.target) - t.moving) * size];
    }
    if (m.type === "tangent") {
      const t = tangentPair(a.t, b.t, pa, pb);
      return [t.axis.dot(t.normal) * size, Math.abs(t.axisPoint.clone().sub(t.planePoint).dot(t.normal)) - t.radius];
    }
    const na = normal(a.t).applyQuaternion(q(pa)),
      nb = normal(b.t).applyQuaternion(q(pb));
    const delta = v(point(anchor(a.t), pa)).sub(v(point(anchor(b.t), pb)));
    if (m.type === "lock") {
      const turn = q(pb).invert().multiply(q(pa)),
        s = turn.w < 0 ? -2 : 2;
      return [turn.x * s * size, turn.y * s * size, turn.z * s * size, delta.x, delta.y, delta.z];
    }
    if (m.type === "perpendicular") return [na.dot(nb) * size];
    if (m.type === "angle") return [(na.dot(nb) - Math.cos((m.value * Math.PI) / 180)) * size];
    const off = na.clone().addScaledVector(nb, m.aligned ? -1 : 1).multiplyScalar(size);
    const out = [off.x, off.y, off.z];
    if (m.type === "coincident" || m.type === "distance") out.push(delta.dot(nb) - (m.type === "distance" ? m.value : 0));
    if (m.type === "concentric") {
      const side = delta.clone().addScaledVector(nb, -delta.dot(nb));
      out.push(side.x, side.y, side.z);
    }
    return out;
  };
  // Mates that cannot be solved at all (missing geometry, the wrong kinds of faces) are flagged and left out.
  const report: SolveReport = options.report ?? { mates: {}, components: {} };
  const over = (m: Mate, componentId: string, others: Mate[]) =>
    (report.mates[m.id] = { status: "over", message: `${m.name} over-defines ${nameOf(componentId)}${others.length ? `: it conflicts with ${others.map((o) => o.name).join(", ")}` : ""}` });
  const active: Mate[] = [];
  for (const m of mates) {
    try {
      const a = refs(m.moving),
        b = refs(m.target);
      if (a.componentId === b.componentId) throw Error("A mate must connect different components");
      if (a.componentId.includes("~") && !doc.components?.some((c) => c.id === a.componentId))
        throw Error("Pattern instances follow their source component; mate the source instead");
      // The kinds of geometry must suit the mate.
      mateError(m, a, b, identity(), identity());
      active.push(m);
    } catch (e) {
      report.mates[m.id] = { status: "error", message: `${m.name}: ${(e as Error).message}` };
    }
  }
  const grounded = new Set((doc.components ?? []).filter((c) => c.grounded).map((c) => c.id));
  const settled = new Set(grounded);
  // Directed assembly graph: the target is fixed first; all mates on one moving part are solved together.
  // A fixed part is never moved by a mate; its mates are only checked.
  const pending = new Set(active.map((m) => refs(m.moving).componentId).filter((id) => !grounded.has(id)));
  for (const c of doc.components ?? [])
    if (!pending.has(c.id)) settled.add(c.id);
  // Pattern instances are placed from their source once it and any reference it uses are settled.
  const placedPatterns = new Set<string>();
  const ownerOfRef = (ref: TopologyRef) => {
    const t = findTopology(topology, ref);
    if (!t) throw Error("A component pattern's direction or axis no longer resolves; reselect it");
    return { t, componentId: owner.get(ref.bodyId) ?? componentOf(doc, ref.bodyId)?.id };
  };
  const placePattern = (p: ComponentPattern) => {
    const ref = p.kind === "linear" ? p.directionRef : p.axisRef;
    const refOwner = ref ? ownerOfRef(ref) : undefined;
    const frame = refOwner?.componentId ? placements[refOwner.componentId] : identity();
    for (let k = 1; k < p.count; k++) placements[`${p.id}~${k}`] = patternPlacement(p, k, placements[p.componentId], refOwner?.t, frame);
    return refOwner;
  };
  const placePatterns = () => {
    for (let progress = true; progress; ) {
      progress = false;
      for (const p of doc.componentPatterns ?? []) {
        if (placedPatterns.has(p.id) || !settled.has(p.componentId)) continue;
        const ref = p.kind === "linear" ? p.directionRef : p.axisRef;
        const refOwner = ref ? ownerOfRef(ref) : undefined;
        if (refOwner?.componentId && !settled.has(refOwner.componentId)) continue;
        placePattern(p);
        for (let k = 1; k < p.count; k++) settled.add(`${p.id}~${k}`);
        placedPatterns.add(p.id);
        progress = true;
      }
    }
  };
  /** The component a pattern instance repeats; any other component itself. */
  const sourceOf = (id: string) => (id.includes("~") ? (doc.componentPatterns?.find((p) => p.id === id.split("~")[0])?.componentId ?? id) : id);
  /**
   * A closed loop of mates, solved all at once: damped least squares from
   * where the parts are, each step the smallest move that meets the mates
   * (anchored parts weighted to move least). The linkage keeps its branch and
   * the freedom it has left.
   */
  const solveLoop = (block: string[]) => {
    const member = (id: string) => block.includes(sourceOf(id));
    const loopMates = active
      .map((m) => ({ m, a: refs(m.moving), b: refs(m.target) }))
      .filter(({ a, b }) => member(a.componentId) && (member(b.componentId) || settled.has(b.componentId)));
    const start = new Map(block.map((id) => [id, { position: [...placements[id].position] as Vec3, quaternion: new Quaternion(...placements[id].quaternion) }]));
    let size = 10;
    for (const { a, b } of loopMates) size = Math.max(size, v(point(anchor(a.t), placements[a.componentId])).distanceTo(v(point(anchor(b.t), placements[b.componentId]))));
    /** Least squares over the free parts' placements; heavier parts move less. */
    type LoopMate = (typeof loopMates)[number];
    const attempt = (list: LoopMate[], free: string[], heavy: string[]) => {
      for (const id of block) placements[id] = { position: [...start.get(id)!.position], quaternion: start.get(id)!.quaternion.toArray() as Placement["quaternion"] };
      const weight = free.map((id) => (heavy.includes(id) ? 1e4 : 1));
      const n = free.length * 6;
      const set = (x: number[]) => {
        free.forEach((id, i) => {
          const w = new Vector3(x[6 * i + 3], x[6 * i + 4], x[6 * i + 5]).divideScalar(size),
            angle = w.length();
          const turn = angle > 1e-15 ? new Quaternion().setFromAxisAngle(w.divideScalar(angle), angle) : new Quaternion();
          placements[id] = {
            position: [0, 1, 2].map((k) => start.get(id)!.position[k] + x[6 * i + k]) as Vec3,
            quaternion: turn.multiply(start.get(id)!.quaternion).normalize().toArray() as Placement["quaternion"],
          };
        });
        for (const p of doc.componentPatterns ?? []) if (block.includes(p.componentId)) placePattern(p);
      };
      const residual = (x: number[]) => {
        set(x);
        return list.flatMap(({ m, a, b }) => mateResidual(m, a, b, placements[a.componentId], placements[b.componentId], size));
      };
      const cost = (r: number[]) => r.reduce((s, e) => s + e * e, 0);
      let x = new Array<number>(n).fill(0),
        r = residual(x),
        mu = 1e-6;
      for (let iteration = 0; iteration < 200 && Math.max(0, ...r.map(Math.abs)) > 1e-11; iteration++) {
        // Jacobian by central differences.
        const h = 1e-6 * size,
          J = r.map(() => new Array<number>(n).fill(0));
        for (let j = 0; j < n; j++) {
          const up = x.slice(),
            down = x.slice();
          up[j] += h;
          down[j] -= h;
          const [rp, rm] = [residual(up), residual(down)];
          for (let i = 0; i < r.length; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
        }
        const JtJ = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => J.reduce((s, row) => s + row[i] * row[j], 0)));
        const Jtr = Array.from({ length: n }, (_, i) => J.reduce((s, row, k) => s + row[i] * r[k], 0));
        let better = false;
        for (let tries = 0; tries < 40 && !better; tries++) {
          const step = solveLinear(
            JtJ.map((row, i) => row.map((e, j) => (i === j ? e + mu * weight[Math.floor(i / 6)] : e))),
            Jtr.map((e) => -e),
          );
          const next = x.map((e, j) => e + step[j]),
            rn = residual(next);
          if (cost(rn) < cost(r)) {
            [x, r] = [next, rn];
            mu = Math.max(mu / 10, 1e-12);
            better = true;
          } else mu *= 10;
        }
        if (!better) break;
      }
      set(x);
      return list.every(({ m, a, b }) => mateError(m, a, b, placements[a.componentId], placements[b.componentId]) <= 1e-5);
    };
    // A dragged or driven part stays exactly where it was put when the loop can close that way;
    // otherwise it moves least.
    const held = block.filter((id) => options.anchor?.includes(id));
    const solve = (list: LoopMate[]) => (held.length > 0 && attempt(list, block.filter((id) => !held.includes(id)), [])) || attempt(list, block, held);
    if (solve(loopMates)) return;
    // Over-defined: in the order they were added, each mate that the ones before it cannot meet with is
    // flagged and left out, as SolidWorks does; the loop is solved with the rest.
    const kept: LoopMate[] = [],
      left: LoopMate[] = [];
    for (const lm of loopMates)
      if (solve([...kept, lm])) kept.push(lm);
      else left.push(lm);
    // Each flagged mate names the mates it fights: those without which it could be met.
    for (const lm of left) over(lm.m, lm.a.componentId, kept.filter((k) => solve([...kept.filter((x) => x !== k), lm])).map((k) => k.m));
    solve(kept);
  };
  const loops = mateLoops(doc);
  const movingMates = (id: string) => active.filter((m) => refs(m.moving).componentId === id);
  /** Relax one part onto its mates from a starting placement; true when every mate is met. */
  const relax = (id: string, group: Mate[], from: Placement) => {
    placements[id] = { position: [...from.position], quaternion: [...from.quaternion] };
    for (let pass = 0; pass < 80; pass++) {
      for (const m of group) {
        const a = refs(m.moving),
          b = refs(m.target);
        if (a.componentId === b.componentId)
          throw Error("A mate must connect different components");
        const pa = placements[id],
          pb = placements[b.componentId];
        const na = normal(a.t).applyQuaternion(q(pa)),
          nb = normal(b.t).applyQuaternion(q(pb));
        if (m.type === "lock") {
          pa.quaternion = [...pb.quaternion];
          const delta = v(point(anchor(b.t), pb)).sub(
            v(direction(anchor(a.t), pa)),
          );
          pa.position = delta.toArray() as Vec3;
          continue;
        }
        if (m.type === "tangent") {
          tangentStep(m, a.t, b.t, pa, pb);
          continue;
        }
        if (m.type === "gear") {
          // Turn the moving part about its own axis (through its anchor) to the mated turn.
          const t = gearTurns(normal(b.t), pb, normal(a.t), pa);
          const turn = new Quaternion().setFromAxisAngle(t.axis, wrap(gearWant(m, t.target) - t.moving));
          const c = v(point(anchor(a.t), pa));
          pa.quaternion = turn.clone().multiply(q(pa)).normalize().toArray() as Placement["quaternion"];
          pa.position = v(pa.position).sub(c).applyQuaternion(turn).add(c).toArray() as Vec3;
          continue;
        }
        if (m.type === "angle" || m.type === "perpendicular") {
          const target = m.type === "perpendicular" ? 90 : m.value;
          const angle = Math.acos(Math.max(-1, Math.min(1, na.dot(nb))));
          let axis = na.clone().cross(nb);
          if (axis.length() < 1e-8)
            axis = na
              .clone()
              .cross(
                Math.abs(na.x) < 0.9
                  ? new Vector3(1, 0, 0)
                  : new Vector3(0, 1, 0),
              );
          const correction = new Quaternion().setFromAxisAngle(
            axis.normalize(),
            angle - (target * Math.PI) / 180,
          );
          pa.quaternion = correction
            .multiply(q(pa))
            .normalize()
            .toArray() as Placement["quaternion"];
        } else {
          const desired = nb.clone().multiplyScalar(m.aligned ? 1 : -1);
          const correction = new Quaternion().setFromUnitVectors(na, desired);
          pa.quaternion = correction
            .multiply(q(pa))
            .normalize()
            .toArray() as Placement["quaternion"];
        }
        const ac = v(point(anchor(a.t), pa)),
          bc = v(point(anchor(b.t), pb));
        if (m.type === "coincident" || m.type === "distance") {
          const offset = m.type === "distance" ? m.value : 0;
          pa.position = v(pa.position)
            .addScaledVector(nb, offset - ac.clone().sub(bc).dot(nb))
            .toArray() as Vec3;
        } else if (m.type === "concentric") {
          const delta = bc.sub(ac);
          delta.addScaledVector(nb, -delta.dot(nb));
          pa.position = v(pa.position).add(delta).toArray() as Vec3;
        }
      }
    }
    return group.every((m) => mateError(m, refs(m.moving), refs(m.target), placements[id], placements[refs(m.target).componentId]) <= 1e-5);
  };
  placePatterns();
  while (pending.size) {
    const id = [...pending].find((id) => !loops.some((g) => g.includes(id)) && movingMates(id).every((m) => settled.has(refs(m.target).componentId)));
    if (id === undefined) {
      // A loop whose outside targets are placed; or, for mates that point round
      // in a circle (A on B, B on A), everything left together.
      const ready = (g: string[]) =>
        g.every((x) => pending.has(x) && movingMates(x).every((m) => g.includes(sourceOf(refs(m.target).componentId)) || settled.has(refs(m.target).componentId)));
      const block = loops.find(ready) ?? [...pending];
      solveLoop(block);
      for (const x of block) {
        pending.delete(x);
        settled.add(x);
      }
      placePatterns();
      continue;
    }
    const group = movingMates(id),
      from = { position: [...placements[id].position] as Vec3, quaternion: [...placements[id].quaternion] as Placement["quaternion"] };
    if (!relax(id, group, from)) {
      // Over-defined: in the order they were added, each mate the earlier ones cannot meet with is flagged and left out.
      const kept: Mate[] = [],
        left: Mate[] = [];
      for (const m of group)
        if (relax(id, [...kept, m], from)) kept.push(m);
        else left.push(m);
      // Each flagged mate names the mates it fights: those without which it could be met.
      for (const m of left) over(m, id, kept.filter((k) => relax(id, [...kept.filter((x) => x !== k), m], from)));
      relax(id, kept, from);
    }
    pending.delete(id);
    settled.add(id);
    placePatterns();
  }
  for (const p of doc.componentPatterns ?? [])
    if (!placedPatterns.has(p.id)) throw Error(`${p.name}: its source or axis component could not be placed`);
  // A fixed part's own mates are only checked.
  for (const m of active) {
    const a = refs(m.moving),
      b = refs(m.target);
    if (grounded.has(a.componentId) && mateError(m, a, b, placements[a.componentId], placements[b.componentId]) > 1e-5)
      report.mates[m.id] = { status: "over", message: `${m.name} would move ${nameOf(a.componentId)}, which is fixed` };
  }
  for (const m of mates) report.mates[m.id] ??= { status: "ok" };
  for (const m of active)
    if (report.mates[m.id].status === "over") {
      const a = refs(m.moving),
        b = refs(m.target);
      report.mates[m.id].residual = Math.round(mateError(m, a, b, placements[a.componentId], placements[b.componentId]) * 1e6) / 1e6;
    }
  // How defined each part is: its remaining freedom on the mates it meets, what it is mated to held;
  // a part in a closed loop shares the loop's freedom (a linkage moves).
  const met = active.filter((m) => report.mates[m.id].status === "ok");
  const freedom = (ids: string[]) => {
    const size = 100,
      n = ids.length * 6;
    // A part's own mates, onto what it is mounted on (parts mated onto it do not hold it).
    const list = met.filter((m) => ids.includes(sourceOf(refs(m.moving).componentId)));
    if (!list.length) return n;
    const start = new Map(ids.map((id) => [id, placements[id]]));
    const residual = (x: number[]) => {
      ids.forEach((id, i) => {
        const p = start.get(id)!,
          w = new Vector3(x[6 * i + 3], x[6 * i + 4], x[6 * i + 5]).divideScalar(size),
          angle = w.length();
        const turn = angle > 1e-15 ? new Quaternion().setFromAxisAngle(w.divideScalar(angle), angle) : new Quaternion();
        placements[id] = { position: [0, 1, 2].map((k) => p.position[k] + x[6 * i + k]) as Vec3, quaternion: turn.multiply(q(p)).normalize().toArray() as Placement["quaternion"] };
      });
      return list.flatMap((m) => {
        const a = refs(m.moving),
          b = refs(m.target);
        return mateResidual(m, a, b, placements[a.componentId], placements[b.componentId], size);
      });
    };
    const zero = new Array<number>(n).fill(0),
      h = 1e-5;
    const columns = zero.map((_, j) => {
      const up = zero.slice(),
        down = zero.slice();
      up[j] = h;
      down[j] = -h;
      const [rp, rm] = [residual(up), residual(down)];
      return rp.map((e, i) => (e - rm[i]) / (2 * h));
    });
    for (const id of ids) placements[id] = start.get(id)!;
    return n - rank(columns);
  };
  for (const c of doc.components ?? []) {
    if (c.belt || c.suppressed) continue;
    const overDefined = active.some((m) => report.mates[m.id].status === "over" && refs(m.moving).componentId === c.id);
    if (grounded.has(c.id)) report.components[c.id] = { status: overDefined ? "over" : "fixed", dof: 0 };
    else if (overDefined) report.components[c.id] = { status: "over", dof: 0 };
    else {
      const loop = loops.find((g) => g.includes(c.id));
      const dof = loop ? freedom(loop) : freedom([c.id]);
      report.components[c.id] = { status: dof > 0 ? "under" : "full", dof };
    }
  }
  return placements;
}
/** Each body's placement: its component's, or none for a free body. */
export function bodyPlacements(doc: Document, components: Record<string, Placement>, bodyIds: Iterable<string>): Record<string, Placement> {
  const owner = new Map<string, string>();
  for (const c of doc.components ?? []) for (const id of c.bodyIds) owner.set(id, c.id);
  const result: Record<string, Placement> = {};
  for (const id of bodyIds) result[id] = components[owner.get(id) ?? componentOf(doc, id)?.id ?? ""] ?? identity();
  return result;
}
/** Solved placements of every body, by body id. */
export function solveAssembly(doc: Document, topology: Topology[], options: SolveOptions = {}): Record<string, Placement> {
  return bodyPlacements(doc, solveComponents(doc, topology, options), new Set([...doc.bodies.map((b) => b.id), ...topology.map((t) => t.bodyId)]));
}
/** Topology of placed geometry back in each body's own coordinates, as the solver takes it. */
export function localTopology(geometry: Geometry): Topology[] {
  return geometry.bodies.flatMap((b) => {
    const p = geometry.placements?.[b.id];
    if (!p) return b.topology;
    const undo = q(p).invert();
    const back = (a: Vec3) => v(a).sub(v(p.position)).applyQuaternion(undo).toArray() as Vec3,
      turn = (a: Vec3) => v(a).applyQuaternion(undo).toArray() as Vec3;
    return b.topology.map((t) => ({
      ...t,
      center: back(t.center),
      ...(t.normal ? { normal: turn(t.normal) } : {}),
      ...(t.axis ? { axis: { origin: back(t.axis.origin), direction: turn(t.axis.direction) } } : {}),
      ...(t.endpoints ? { endpoints: [back(t.endpoints[0]), back(t.endpoints[1])] as [Vec3, Vec3] } : {}),
    }));
  });
}
export function placeGeometry(doc: Document, geometry: Geometry): Geometry {
  const report: SolveReport = { mates: {}, components: {} };
  const placements = solveAssembly(
    doc,
    geometry.bodies.flatMap((b) => b.topology),
    { report },
  );
  // Flagged mates are reported, never silently repaired.
  for (const m of Object.values(report.mates)) if (m.status !== "ok" && m.message) geometry.warnings.push(m.message);
  if (doc.mates?.length) geometry.mateStatus = report.mates;
  if (doc.components?.length) geometry.componentStatus = report.components;
  for (const b of geometry.bodies) {
    const p = placements[b.id];
    const transform = (numbers: number[], normal = false) => {
      for (let i = 0; i < numbers.length; i += 3) {
        const a: Vec3 = [numbers[i], numbers[i + 1], numbers[i + 2]];
        const transformed = normal ? direction(a, p) : point(a, p);
        numbers[i] = transformed[0];
        numbers[i + 1] = transformed[1];
        numbers[i + 2] = transformed[2];
      }
    };
    transform(b.mesh.vertices);
    transform(b.mesh.normals, true);
    transform(b.edges.lines);
    for (const t of b.topology) {
      t.center = point(t.center, p);
      if (t.normal) t.normal = direction(t.normal, p);
      if (t.axis)
        t.axis = {
          origin: point(t.axis.origin, p),
          direction: direction(t.axis.direction, p),
        };
      if (t.endpoints)
        t.endpoints = [point(t.endpoints[0], p), point(t.endpoints[1], p)];
    }
    b.centerOfMass = point(b.centerOfMass, p);
    for (const t of b.threads ?? []) {
      t.origin = point(t.origin, p);
      t.direction = direction(t.direction, p);
    }
    if (b.inertiaTensor) b.inertiaTensor = rotateTensor(b.inertiaTensor, [direction([1, 0, 0], p), direction([0, 1, 0], p), direction([0, 0, 1], p)]);
    const vertices = b.mesh.vertices;
    b.bounds = [
      [Infinity, Infinity, Infinity],
      [-Infinity, -Infinity, -Infinity],
    ];
    for (let i = 0; i < vertices.length; i += 3)
      for (let k = 0; k < 3; k++) {
        b.bounds[0][k] = Math.min(b.bounds[0][k], vertices[i + k]);
        b.bounds[1][k] = Math.max(b.bounds[1][k], vertices[i + k]);
      }
  }
  return { ...geometry, placements };
}
/**
 * Exploded-view offsets: each component except the fixed reference moves out along the axis of its
 * concentric mate, off the face of its face mate, or away from the assembly
 * center, by about its own size. Components mated to a moved component move
 * with it first.
 */
export function autoExplode(doc: Document, geometry: Geometry, scale = 1): Record<string, Vec3> {
  const topology = geometry.bodies.flatMap((b) => b.topology);
  const boundsOf = (bodies: Geometry["bodies"]) => {
    const lo = new Vector3(Infinity, Infinity, Infinity),
      hi = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const b of bodies) {
      lo.min(v(b.bounds[0]));
      hi.max(v(b.bounds[1]));
    }
    return { lo, hi, center: lo.clone().add(hi).multiplyScalar(0.5) };
  };
  const all = boundsOf(geometry.bodies.filter((b) => !b.hidden));
  const offsets: Record<string, Vec3> = {};
  const components = allComponents(doc);
  // Grounding fixes the assembled pose, not its presentation. Keep one fixed
  // reference, while allowing a fully fixed imported assembly to explode.
  const anchor = components.find(c => c.grounded && geometry.bodies.some(b => !b.hidden && componentOf(doc,b.id)?.id === c.id));
  const mates = activeMates(doc);
  const parentOf = (id: string) => {
    for (const m of mates) {
      const moving = componentOf(doc, m.moving.bodyId),
        target = componentOf(doc, m.target.bodyId);
      if (moving?.id === id && target && target.id !== id) return { mate: m, target };
    }
    return undefined;
  };
  const visit = (c: (typeof components)[number], path: string[]): Vector3 => {
    if (offsets[c.id]) return v(offsets[c.id]);
    if (c.id === anchor?.id || path.includes(c.id)) return new Vector3();
    const own = boundsOf(geometry.bodies.filter((b) => componentOf(doc, b.id)?.id === c.id));
    if (!Number.isFinite(own.center.x)) return new Vector3();
    const link = parentOf(c.id);
    let dir: Vector3 | undefined,
      base = new Vector3();
    if (link) {
      base = visit(link.target, [...path, c.id]);
      const t = findTopology(topology, link.mate.target);
      const targetBounds = boundsOf(geometry.bodies.filter((b) => b.id === link.mate.target.bodyId));
      if (t?.axis && link.mate.type === "concentric") {
        dir = v(t.axis.direction).normalize();
        if (own.center.clone().sub(targetBounds.center).dot(dir) < 0) dir.negate();
      } else if (t?.normal) {
        dir = v(t.normal).normalize();
        if (own.center.clone().sub(targetBounds.center).dot(dir) < 0) dir.negate();
      }
    }
    if (!dir || dir.length() < 1e-9) dir = own.center.clone().sub(all.center);
    if (dir.length() < 1e-9) dir = new Vector3(0, 0, 1);
    dir.normalize();
    const size = own.hi.clone().sub(own.lo);
    const extent = Math.abs(size.x * dir.x) + Math.abs(size.y * dir.y) + Math.abs(size.z * dir.z);
    const offset = base.add(dir.multiplyScalar((extent * 1.4 + 5) * scale));
    offsets[c.id] = offset.toArray().map((n) => Math.round(n * 100) / 100) as Vec3;
    return offset.clone();
  };
  for (const c of components) visit(c, []);
  for (const c of components) offsets[c.id] ??= [0, 0, 0];
  return offsets;
}
