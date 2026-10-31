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

export function curvePoint(curve: r.Edge["curve"], position: number): Vec3 {
  // Avoid the convenience API's temporary gp_Pnt → XYZ → Vector copies.
  const native = curve.wrapped, first = native.FirstParameter();
  const point = native.Value(first + (native.LastParameter() - first) * position);
  try { return [point.X(), point.Y(), point.Z()]; }
  finally { point.delete(); }
}

export function edgePoint(edge: r.Edge | r.Wire, position: number): Vec3 {
  const curve = edge.curve;
  try { return curvePoint(curve, position); }
  finally { curve.delete(); }
}

export function edgeTangent(edge: r.Edge | r.Wire, position: number): Vec3 {
  const scope = new NativeScope();
  try {
    const oc = r.getOC() as any, curve = scope.own(edge.curve), native = curve.wrapped;
    const point = scope.own(new oc.gp_Pnt()), tangent = scope.own(new oc.gp_Vec());
    const first = native.FirstParameter();
    native.D1(first + (native.LastParameter() - first) * position, point, tangent);
    return [tangent.X(), tangent.Y(), tangent.Z()];
  } finally { scope.dispose(); }
}

/** Oriented surface sampling with explicit ownership, including optional point projection. */
export function faceSample(face: r.Face, at?: Vec3): { point: Vec3; normal: Vec3 } {
  const scope = new NativeScope();
  try {
    const oc = r.getOC() as any, bounds = face.UVBounds;
    const evaluator = scope.own(new oc.BRepGProp_Face(face.wrapped, false));
    const point = scope.own(new oc.gp_Pnt()), normal = scope.own(new oc.gp_Vec());
    let u = (bounds.uMin + bounds.uMax) / 2, v = (bounds.vMin + bounds.vMax) / 2;
    if (at) {
      const surface = scope.own(oc.BRep_Tool.Surface(face.wrapped));
      const input = scope.own(r.asPnt(at));
      const projection = scope.own(new oc.GeomAPI_ProjectPointOnSurf(input, surface, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad));
      const uv = projection.LowerDistanceParameters(0, 0);
      u = uv.U; v = uv.V;
    }
    evaluator.Normal(u, v, point, normal);
    return { point: [point.X(), point.Y(), point.Z()], normal: [normal.X(), normal.Y(), normal.Z()] };
  } finally { scope.dispose(); }
}

export const faceNormal = (face: r.Face): Vec3 => faceSample(face).normal;
