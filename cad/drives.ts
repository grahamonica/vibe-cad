// Power transmission geometry: involute spur gears, timing pulleys and belts.
// Pure math (2D profiles and lengths); the kernel turns profiles into solids.
import type { Vec2 } from "./types.ts";

/** Timing belt families: pitch, pitch-line differential and belt thickness (mm). */
export const belts = {
  GT2: { pitch: 2, pld: 0.254, thickness: 1.38, groove: 0.75 },
  "HTD 3M": { pitch: 3, pld: 0.381, thickness: 2.4, groove: 1.14 },
  "HTD 5M": { pitch: 5, pld: 0.5715, thickness: 3.8, groove: 2.06 },
} as const;
export type BeltType = keyof typeof belts;

export interface GearSpec {
  module: number;
  teeth: number;
  /** Pressure angle in degrees. */
  pressureAngle: number;
  /** Backlash of a pair of these gears (mm): each tooth is thinned by half of it at the pitch circle. */
  backlash?: number;
}
/**
 * How far each flank turns toward its tooth's middle for the backlash
 * (radians). A turned involute is still an involute of the same base circle,
 * so the thinned flank stays exact.
 */
export const backlashTurn = (g: GearSpec) => (g.backlash ?? 0) / (4 * gearRadii(g).pitch);
export const gearRadii = (g: GearSpec) => {
  const pitch = (g.module * g.teeth) / 2;
  return {
    pitch,
    base: pitch * Math.cos((g.pressureAngle * Math.PI) / 180),
    tip: pitch + g.module,
    root: pitch - 1.25 * g.module,
  };
};
/** Center distance of two meshing spur gears of one module. */
export const centerDistance = (module: number, a: number, b: number) => (module * (a + b)) / 2;

const inv = (a: number) => Math.tan(a) - a;
const polar = (r: number, t: number): Vec2 => [r * Math.cos(t), r * Math.sin(t)];

/**
 * One tooth of an involute spur gear centered on angle 0, as point lists:
 * the left flank from root to tip and the right flank from tip to root. The
 * flanks are involutes of the base circle; below it they run radially to the root.
 */
export function toothFlanks(g: GearSpec, samples = 8) {
  const { base, tip, root } = gearRadii(g),
    alpha = (g.pressureAngle * Math.PI) / 180;
  // Half the tooth's angular thickness at the pitch circle, then at any radius.
  const halfPitch = Math.PI / (2 * g.teeth);
  const halfAt = (r: number) => halfPitch + inv(alpha) - inv(Math.acos(Math.min(1, base / r)));
  const start = Math.max(base, root);
  const radii = Array.from({ length: samples + 1 }, (_, i) => start + ((tip - start) * i) / samples);
  const right = radii.map((r) => polar(r, -halfAt(r)));
  const left = radii.map((r) => polar(r, halfAt(r)));
  return { right, left, root, tip, rootStart: start, tipHalf: halfAt(tip), baseHalf: halfAt(start) };
}

/**
 * The right flank of the tooth centered on angle 0, root to tip, as cubic
 * Béziers whose end tangents are the involute's own (two spans stay within a
 * few microns of the true involute at common sizes).
 */
export function flankBeziers(g: GearSpec, spans = 2): [Vec2, Vec2, Vec2, Vec2][] {
  const { base, tip, root } = gearRadii(g),
    lo = Math.max(base, root) + 1e-9;
  return Array.from({ length: spans }, (_, i) => flankBezier(g, lo + ((tip - lo) * i) / spans, lo + ((tip - lo) * (i + 1)) / spans));
}
function flankBezier(g: GearSpec, from: number, to: number): [Vec2, Vec2, Vec2, Vec2] {
  const { base } = gearRadii(g),
    alpha = (g.pressureAngle * Math.PI) / 180;
  const half = (r: number) => Math.PI / (2 * g.teeth) + inv(alpha) - inv(Math.acos(Math.min(1, base / r)));
  const at = (r: number) => polar(r, -half(r));
  const r0 = from,
    r1 = to;
  const p0 = at(r0),
    p3 = at(r1);
  // Tangents by small steps along the involute, scaled for a Hermite-to-Bézier fit.
  const h = (r1 - r0) * 1e-4;
  const d0 = at(r0 + h).map((v, i) => (v - p0[i]) / h),
    d3 = p3.map((v, i) => (v - at(r1 - h)[i]) / h);
  const k = (r1 - r0) / 3;
  return [p0, [p0[0] + d0[0] * k, p0[1] + d0[1] * k], [p3[0] - d3[0] * k, p3[1] - d3[1] * k], p3];
}
/** Length of an open belt around two pitch circles with centers C apart. */
export function beltLength(r1: number, r2: number, c: number) {
  if (c <= Math.abs(r1 - r2)) throw Error("The pulleys overlap; move them further apart");
  const d = r1 - r2;
  return 2 * Math.sqrt(c * c - d * d) + Math.PI * (r1 + r2) + 2 * d * Math.asin(d / c);
}
/** Center distance that gives a belt of the given pitch length (bisection). */
export function centerFor(r1: number, r2: number, length: number) {
  let lo = Math.abs(r1 - r2) + 1e-9,
    hi = length;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (beltLength(r1, r2, mid) < length) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
/**
 * The outline of an open belt over two circles at (0, 0) and (c, 0) with
 * radii r1 and r2: two tangent lines and two wrap arcs, as three-point arcs.
 */
export function beltLoop(r1: number, r2: number, c: number) {
  // The tangent's normal n satisfies n·(c, 0) = r1 − r2: it touches both circles at π/2 − φ.
  const phi = Math.asin((r1 - r2) / c);
  const a1 = Math.PI / 2 - phi,
    a2 = -Math.PI / 2 + phi;
  const on = (cx: number, r: number, t: number): Vec2 => [cx + r * Math.cos(t), r * Math.sin(t)];
  return {
    lines: [
      [on(0, r1, a1), on(c, r2, a1)],
      [on(c, r2, a2), on(0, r1, a2)],
    ] as [Vec2, Vec2][],
    // Wrap arcs: round the far side of each pulley.
    arcs: [
      [on(0, r1, a1), on(0, r1, Math.PI), on(0, r1, 2 * Math.PI + a2)],
      [on(c, r2, a2), on(c, r2, 0), on(c, r2, a1)],
    ] as [Vec2, Vec2, Vec2][],
  };
}
