// Mass properties of several bodies together: total mass, center of mass and
// inertia, and the numbers a spinning weapon is judged by.
import type { Vec3 } from "./types.ts";

/** Inertia tensor entries xx, yy, zz, xy, yz, xz (g·mm²) about the center of mass. */
export type Tensor = [number, number, number, number, number, number];
export interface MassItem {
  mass: number;
  center: Vec3;
  tensor: Tensor;
}

/** Eigenvalues of a symmetric 3×3 matrix by Jacobi rotations, smallest first. */
export function eigenvalues(matrix: number[][]): [number, number, number] {
  const a = matrix.map((row) => [...row]);
  const [xx, yy, zz] = [a[0][0], a[1][1], a[2][2]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] ** 2;
    if (off < 1e-18 * (xx * xx + yy * yy + zz * zz)) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]),
          t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p],
            akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k],
            aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
      }
  }
  return [a[0][0], a[1][1], a[2][2]].sort((u, v) => u - v) as [number, number, number];
}

const matrix = ([xx, yy, zz, xy, yz, xz]: Tensor) => [
  [xx, xy, xz],
  [xy, yy, yz],
  [xz, yz, zz],
];
/** The tensor seen in a frame rotated by R (columns are the rotated axes): R·I·Rᵀ. */
export function rotateTensor(t: Tensor, R: [Vec3, Vec3, Vec3]): Tensor {
  const I = matrix(t),
    rot = [0, 1, 2].map((i) => [R[0][i], R[1][i], R[2][i]]);
  const out = [0, 1, 2].map((i) => [0, 1, 2].map((j) => {
    let sum = 0;
    for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) sum += rot[i][k] * I[k][l] * rot[j][l];
    return sum;
  }));
  return [out[0][0], out[1][1], out[2][2], out[0][1], out[1][2], out[0][2]];
}
/** Several bodies as one: masses add, centers average by mass, tensors move by the parallel-axis theorem. */
export function combine(items: MassItem[]): MassItem {
  const mass = items.reduce((s, x) => s + x.mass, 0);
  if (!(mass > 0)) return { mass: 0, center: [0, 0, 0], tensor: [0, 0, 0, 0, 0, 0] };
  const center = [0, 1, 2].map((k) => items.reduce((s, x) => s + x.mass * x.center[k], 0) / mass) as Vec3;
  const tensor: Tensor = [0, 0, 0, 0, 0, 0];
  for (const x of items) {
    const [dx, dy, dz] = [0, 1, 2].map((k) => x.center[k] - center[k]);
    const shift: Tensor = [x.mass * (dy * dy + dz * dz), x.mass * (dx * dx + dz * dz), x.mass * (dx * dx + dy * dy), -x.mass * dx * dy, -x.mass * dy * dz, -x.mass * dx * dz];
    for (let k = 0; k < 6; k++) tensor[k] += x.tensor[k] + shift[k];
  }
  return { mass, center, tensor };
}
export const principal = (t: Tensor) => eigenvalues(matrix(t));
/** Moment of inertia about an axis (g·mm²), and how far the center of mass sits off it (mm). */
export function aboutAxis(m: MassItem, origin: Vec3, direction: Vec3): { inertia: number; offset: number } {
  const len = Math.hypot(...direction),
    n = direction.map((v) => v / len) as Vec3;
  const I = matrix(m.tensor);
  let nIn = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) nIn += n[i] * I[i][j] * n[j];
  const d = [0, 1, 2].map((k) => m.center[k] - origin[k]) as Vec3,
    along = d[0] * n[0] + d[1] * n[1] + d[2] * n[2],
    offset = Math.sqrt(Math.max(0, d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - along * along));
  return { inertia: nIn + m.mass * offset * offset, offset };
}
/**
 * A spinning weapon at a speed: stored energy (J), tip speed (m/s) at the
 * largest radius, and the force its imbalance puts on the bearings (N).
 */
export function spin(inertia: number, mass: number, offset: number, radius: number, rpm: number) {
  const omega = (rpm * 2 * Math.PI) / 60;
  return {
    energy: 0.5 * inertia * 1e-9 * omega * omega,
    tipSpeed: radius * 1e-3 * omega,
    imbalanceForce: mass * 1e-3 * offset * 1e-3 * omega * omega,
  };
}
