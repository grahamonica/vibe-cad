// Plane axes shared by the kernel and the tools, so positions given on a face
// mean the same thing everywhere.
import type { Vec3 } from "./types.ts";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => mul(a, 1 / (Math.hypot(...a) || 1));

/** In-plane X and Y axes for a plane normal: X follows world X (or Z for steep planes). */
export function axesFor(normal: Vec3): { xDir: Vec3; yDir: Vec3 } {
  const n = unit(normal);
  if (Math.abs(n[2]) > 0.9) {
    const x = unit(sub([1, 0, 0], mul(n, n[0])));
    return { xDir: x, yDir: cross(n, x) };
  }
  const y = unit(sub([0, 0, 1], mul(n, n[2])));
  return { xDir: cross(y, n), yDir: y };
}
/** A face's "origin" frame: the world origin projected onto its plane. */
export function originFrame(center: Vec3, normal: Vec3) {
  const n = unit(normal),
    d = center[0] * n[0] + center[1] * n[1] + center[2] * n[2];
  return { origin: mul(n, d), normal: n, ...axesFor(n) };
}
