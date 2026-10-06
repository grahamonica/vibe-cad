// Weldment profiles: cross-sections of structural members as 2D outlines
// centered on the member's line (local x across, local y up from the sketch).
import type { Vec2 } from "./types.ts";

export type ProfileKind = "square-tube" | "rect-tube" | "round-tube" | "angle" | "flat-bar" | "channel";
export interface MemberProfile {
  kind: ProfileKind;
  /** Across (local x), or the outside diameter of a round tube. */
  width: number;
  /** Up (local y); square tubes use the width. */
  height?: number;
  /** Wall or leg thickness. */
  thickness: number;
}
/** Outer and inner (hollow) outlines as closed polygons, or circles for round tube. */
export function profileOutline(p: MemberProfile): { outer: Vec2[] | { radius: number }; inner?: Vec2[] | { radius: number } } {
  const w = p.width,
    h = p.kind === "square-tube" ? p.width : (p.height ?? p.width),
    t = p.thickness;
  const rect = (a: number, b: number): Vec2[] => [
    [-a / 2, -b / 2],
    [a / 2, -b / 2],
    [a / 2, b / 2],
    [-a / 2, b / 2],
  ];
  switch (p.kind) {
    case "square-tube":
    case "rect-tube":
      if (2 * t >= Math.min(w, h)) throw Error("the wall is too thick for the tube");
      return { outer: rect(w, h), inner: rect(w - 2 * t, h - 2 * t) };
    case "round-tube":
      if (2 * t >= w) throw Error("the wall is too thick for the tube");
      return { outer: { radius: w / 2 }, inner: { radius: w / 2 - t } };
    case "flat-bar":
      return { outer: rect(w, t) };
    case "angle":
      // An L with its outside corner at the bottom left of the bounding box.
      if (t >= Math.min(w, h)) throw Error("the legs are too thin for the thickness");
      return {
        outer: [
          [-w / 2, -h / 2],
          [w / 2, -h / 2],
          [w / 2, -h / 2 + t],
          [-w / 2 + t, -h / 2 + t],
          [-w / 2 + t, h / 2],
          [-w / 2, h / 2],
        ],
      };
    case "channel":
      // A U opening upward.
      if (2 * t >= w || t >= h) throw Error("the channel is too thin for the thickness");
      return {
        outer: [
          [-w / 2, -h / 2],
          [w / 2, -h / 2],
          [w / 2, h / 2],
          [w / 2 - t, h / 2],
          [w / 2 - t, -h / 2 + t],
          [-w / 2 + t, -h / 2 + t],
          [-w / 2 + t, h / 2],
          [-w / 2, h / 2],
        ],
      };
  }
}
/** Cross-section area (mm²). */
export function profileArea(p: MemberProfile): number {
  const { outer, inner } = profileOutline(p);
  const area = (o: Vec2[] | { radius: number }) =>
    "radius" in o ? Math.PI * o.radius ** 2 : Math.abs(o.reduce((s, q, i) => s + q[0] * o[(i + 1) % o.length][1] - o[(i + 1) % o.length][0] * q[1], 0)) / 2;
  return area(outer) - (inner ? area(inner) : 0);
}
export const profileLabel = (p: MemberProfile) =>
  p.kind === "round-tube"
    ? `Round tube Ø${p.width}×${p.thickness}`
    : p.kind === "flat-bar"
      ? `Flat bar ${p.width}×${p.thickness}`
      : `${{ "square-tube": "Square tube", "rect-tube": "Rectangular tube", angle: "Angle", channel: "Channel" }[p.kind]} ${p.width}×${p.kind === "square-tube" ? p.width : (p.height ?? p.width)}×${p.thickness}`;
