import * as r from "replicad";
import type { Vec3 } from "./types.ts";

/** Only register newly owned native wrappers; never register borrowed references. */
export class NativeScope {
  private objects = new Set<{ delete(): void }>();
  own<T extends { delete(): void }>(object: T): T {
    this.objects.add(object);
    return object;
  }
  all<T extends { delete(): void }>(objects: T[]): T[] {
    objects.forEach(object => this.own(object));
    return objects;
  }
  dispose() {
    for (const object of [...this.objects].reverse()) object.delete();
    this.objects.clear();
  }
}

export function vectorTuple(vector: r.Vector): Vec3 {
  try { return vector.toTuple(); }
  finally { vector.delete(); }
}

export function curvePoint(curve: r.Edge["curve"], position: number): Vec3 {
  // Avoid the convenience API's temporary gp_Pnt → XYZ → Vector copies.
  const native = curve.wrapped, first = native.FirstParameter();
  const point = native.Value(first + (native.LastParameter() - first) * position);
  try { return [point.X(), point.Y(), point.Z()]; }
  finally { point.delete(); }
}

export function edgePoint(edge: r.Edge, position: number): Vec3 {
  const curve = edge.curve;
  try { return curvePoint(curve, position); }
  finally { curve.delete(); }
}

export function edgeTangent(edge: r.Edge, position: number): Vec3 {
  const curve = edge.curve;
  try { return vectorTuple(curve.tangentAt(position)); }
  finally { curve.delete(); }
}

/** Same UV midpoint and oriented normal as Face.normalAt(), without deferred native GC. */
export function faceSample(face: r.Face): { point: Vec3; normal: Vec3 } {
  const scope = new NativeScope();
  try {
    const oc = r.getOC() as any, bounds = face.UVBounds;
    const evaluator = scope.own(new oc.BRepGProp_Face(face.wrapped, false));
    const point = scope.own(new oc.gp_Pnt()), normal = scope.own(new oc.gp_Vec());
    evaluator.Normal((bounds.uMin + bounds.uMax) / 2, (bounds.vMin + bounds.vMax) / 2, point, normal);
    return { point: [point.X(), point.Y(), point.Z()], normal: [normal.X(), normal.Y(), normal.Z()] };
  } finally { scope.dispose(); }
}

export const faceNormal = (face: r.Face): Vec3 => faceSample(face).normal;
