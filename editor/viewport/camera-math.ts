import { Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../../cad/types.ts';

/** Local yaw/pitch rotates both eye and up, so passing either pole has no clamp. */
export function freeOrbit(position: Vec3, target: Vec3, up: Vec3, dx: number, dy: number) {
  const eye = new Vector3(...position).sub(new Vector3(...target));
  const upward = new Vector3(...up).normalize();
  const right = upward.clone().cross(eye).normalize();
  const q = new Quaternion().setFromAxisAngle(right, -dy)
    .multiply(new Quaternion().setFromAxisAngle(upward, -dx));
  return {
    position: eye.applyQuaternion(q).add(new Vector3(...target)).toArray() as Vec3,
    up: upward.applyQuaternion(q).normalize().toArray() as Vec3,
  };
}
