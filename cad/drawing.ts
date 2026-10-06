// Mechanical drawing composition. Views, dimensions and annotations become a
// display list in sheet millimeters (y down), rendered to SVG, PDF and DXF.
import type {
  Document,
  DrawingAnnotation,
  DrawingDimension,
  DrawingEdge,
  DrawingPoint,
  DrawingProjection,
  DrawingSheet,
  DrawingView,
  Geometry,
  SheetSize,
  ThreadRecord,
  Topology,
  Vec2,
  Vec3,
  ViewOrientation,
} from "./types.ts";
import { holeDimensions } from "./standards.ts";
import { topologyIndex, type TopologyLookup } from "./topology-key.ts";
import { allComponents, componentOwns } from "./types.ts";

// ---------------------------------------------------------------------------
// Sheets
export const sheetSizes: Record<SheetSize, [number, number]> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
  "ANSI A": [279.4, 215.9],
  "ANSI B": [431.8, 279.4],
  "ANSI C": [558.8, 431.8],
  "ANSI D": [863.6, 558.8],
};
export function sheetDimensions(sheet: Pick<DrawingSheet, "size" | "orientation">) {
  const [w, h] = sheetSizes[sheet.size] ?? sheetSizes.A4;
  return sheet.orientation === "portrait" ? { width: h, height: w } : { width: w, height: h };
}
const MARGIN = 10;
const TITLE_W = 180,
  TITLE_H = 36;
export function titleBlockBounds(sheet: DrawingSheet) {
  const { width, height } = sheetDimensions(sheet);
  const w = Math.min(TITLE_W, width - 2 * MARGIN);
  return { x: width - MARGIN - w, y: height - MARGIN - TITLE_H, w, h: TITLE_H };
}

// ---------------------------------------------------------------------------
// Vector helpers
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const along3 = (p: Vec3, d: Vec3, k: number): Vec3 => [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + d[2] * k];
const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const len2 = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit2 = (a: Vec2): Vec2 => {
  const l = len2(a) || 1;
  return [a[0] / l, a[1] / l];
};
const perp2 = (a: Vec2): Vec2 => [-a[1], a[0]];

// ---------------------------------------------------------------------------
// Orientation
const orientations: Record<ViewOrientation, { dir: Vec3; x: Vec3 }> = {
  front: { dir: [0, -1, 0], x: [1, 0, 0] },
  back: { dir: [0, 1, 0], x: [-1, 0, 0] },
  top: { dir: [0, 0, 1], x: [1, 0, 0] },
  bottom: { dir: [0, 0, -1], x: [1, 0, 0] },
  right: { dir: [1, 0, 0], x: [0, 1, 0] },
  left: { dir: [-1, 0, 0], x: [0, -1, 0] },
  iso: { dir: norm3([1, -1, 1]), x: norm3([1, 1, 0]) },
  dimetric: { dir: norm3([0.9, -1, 0.55]), x: norm3([1, 0.9, 0]) },
  trimetric: { dir: norm3([0.6, -1, 0.75]), x: norm3([1, 0.6, 0]) },
};
export interface ViewCamera {
  dir: Vec3;
  x: Vec3;
  y: Vec3;
}
export function cameraFor(o: ViewOrientation): ViewCamera {
  const { dir, x } = orientations[o] ?? orientations.front;
  return { dir, x, y: cross(dir, x) };
}
/** Orthographic neighbour of a view in a given sheet direction. */
export function projectedOrientation(parent: ViewOrientation, side: "left" | "right" | "above" | "below", projection: "first" | "third"): ViewOrientation {
  const third: Record<string, Partial<Record<typeof side, ViewOrientation>>> = {
    front: { right: "right", left: "left", above: "top", below: "bottom" },
    top: { below: "front", above: "back", right: "right", left: "left" },
    right: { left: "front", right: "back", above: "top", below: "bottom" },
    left: { right: "front", left: "back", above: "top", below: "bottom" },
    back: { right: "left", left: "right", above: "top", below: "bottom" },
    bottom: { above: "front", below: "back", right: "right", left: "left" },
  };
  const flip = { left: "right", right: "left", above: "below", below: "above" } as const;
  const s = projection === "third" ? side : flip[side];
  return third[parent]?.[s] ?? "iso";
}

// ---------------------------------------------------------------------------
/** Views of a sheet, generating the standard arrangement for legacy sheets. */
export function resolveViews(sheet: DrawingSheet): DrawingView[] {
  if (sheet.views?.length) return sheet.views;
  const { width, height } = sheetDimensions(sheet);
  const third = sheet.projection !== "first";
  const left = width * 0.3,
    right = width * 0.66,
    upper = height * 0.3,
    lower = height * 0.6;
  // Third angle: top above front, right view to the right of front.
  // First angle: top below front, right view to the left of front.
  return third
    ? [
        { id: "front", name: "Front", kind: "base", orientation: "front", position: [left, lower] },
        { id: "top", name: "Top", kind: "projected", orientation: "top", parentId: "front", position: [left, upper] },
        { id: "right", name: "Right", kind: "projected", orientation: "right", parentId: "front", position: [right, lower] },
        { id: "iso", name: "Isometric", kind: "base", orientation: "iso", position: [right, upper] },
      ]
    : [
        { id: "front", name: "Front", kind: "base", orientation: "front", position: [right, upper] },
        { id: "top", name: "Top", kind: "projected", orientation: "top", parentId: "front", position: [right, lower] },
        { id: "right", name: "Right", kind: "projected", orientation: "right", parentId: "front", position: [left, upper] },
        { id: "iso", name: "Isometric", kind: "base", orientation: "iso", position: [left, lower] },
      ];
}

// ---------------------------------------------------------------------------
// Display list
export type Cmd =
  | ["M", number, number]
  | ["L", number, number]
  | ["A", number, number, number, number, number, number, number]
  | ["C", number, number, number, number, number, number]
  | ["Z"];
export interface Style {
  width: number;
  dash?: number[];
  color?: string;
  fill?: string;
  layer?: string;
}
export type Prim =
  | { k: "path"; cmds: Cmd[]; style: Style }
  | { k: "text"; at: Vec2; text: string; size: number; anchor: "start" | "middle" | "end"; rotate?: number; bold?: boolean; layer?: string }
  | { k: "clip"; center: Vec2; radius: number }
  | { k: "unclip" }
  | { k: "group"; id?: string; attrs?: Record<string, string> }
  | { k: "endgroup" };
const THICK = 0.35,
  THIN = 0.18,
  TEXT = 3.5,
  SMALL = 2.5;
const solid = (width = THIN, layer = "annotation"): Style => ({ width, layer });
export class DisplayList {
  prims: Prim[] = [];
  path(cmds: Cmd[], style: Style) {
    if (cmds.length > 1) this.prims.push({ k: "path", cmds, style });
  }
  line(a: Vec2, b: Vec2, style: Style = solid()) {
    this.path([["M", a[0], a[1]], ["L", b[0], b[1]]], style);
  }
  poly(points: Vec2[], style: Style = solid(), closed = false) {
    if (points.length < 2) return;
    const cmds: Cmd[] = [["M", points[0][0], points[0][1]]];
    for (const p of points.slice(1)) cmds.push(["L", p[0], p[1]]);
    if (closed) cmds.push(["Z"]);
    this.path(cmds, style);
  }
  rect(x: number, y: number, w: number, h: number, style: Style = solid()) {
    this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], style, true);
  }
  circle(c: Vec2, r: number, style: Style = solid()) {
    this.path(
      [
        ["M", c[0] + r, c[1]],
        ["A", r, r, 0, 0, 1, c[0] - r, c[1]],
        ["A", r, r, 0, 0, 1, c[0] + r, c[1]],
        ["Z"],
      ],
      style,
    );
  }
  /** Arc from angle a0 to a1 (radians, y-down sheet, increasing clockwise on screen). */
  arc(c: Vec2, r: number, a0: number, a1: number, style: Style = solid()) {
    const pts: Vec2[] = [];
    const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)));
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    this.poly(pts, style);
  }
  text(at: Vec2, text: string, size = TEXT, anchor: "start" | "middle" | "end" = "middle", rotate = 0, bold = false) {
    this.prims.push({ k: "text", at, text, size, anchor, rotate, bold });
  }
  begin(attrs: Record<string, string>) {
    this.prims.push({ k: "group", attrs });
  }
  end() {
    this.prims.push({ k: "endgroup" });
  }
  arrow(tip: Vec2, direction: Vec2, size = 2.8) {
    const d = unit2(direction),
      n = perp2(d);
    const base = sub2(tip, mul2(d, size));
    this.path(
      [
        ["M", tip[0], tip[1]],
        ["L", base[0] + n[0] * size * 0.18, base[1] + n[1] * size * 0.18],
        ["L", base[0] - n[0] * size * 0.18, base[1] - n[1] * size * 0.18],
        ["Z"],
      ],
      { width: THIN, fill: "#1E1E1E", layer: "annotation" },
    );
  }
}

// ---------------------------------------------------------------------------
// SVG path parsing (HLR output) into transformed commands
function parsePath(d: string): Cmd[] {
  const tokens = d.match(/[MLAZCQHV]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const out: Cmd[] = [];
  let i = 0,
    cmd = "";
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    if (cmd === "M") out.push(["M", num(), num()]);
    else if (cmd === "L") out.push(["L", num(), num()]);
    else if (cmd === "A") out.push(["A", num(), num(), num(), num(), num(), num(), num()]);
    else if (cmd === "C") out.push(["C", num(), num(), num(), num(), num(), num()]);
    else if (cmd === "Q") {
      // Elevate quadratic to cubic using the current point.
      const last = out.at(-1),
        p0 = last ? endOf(last) : [0, 0],
        q = [num(), num()],
        p = [num(), num()];
      out.push(["C", p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1]), p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1]), p[0], p[1]]);
    } else if (cmd === "Z") {
      out.push(["Z"]);
    } else i++;
  }
  return out;
}
function endOf(c: Cmd): Vec2 {
  if (c[0] === "M" || c[0] === "L") return [c[1], c[2]];
  if (c[0] === "A") return [c[6], c[7]];
  if (c[0] === "C") return [c[5], c[6]];
  return [0, 0];
}
function transformCmds(cmds: Cmd[], f: (p: Vec2) => Vec2, scale: number): Cmd[] {
  return cmds.map((c): Cmd => {
    if (c[0] === "M" || c[0] === "L") {
      const p = f([c[1], c[2]]);
      return [c[0], p[0], p[1]];
    }
    if (c[0] === "A") {
      const p = f([c[6], c[7]]);
      return ["A", c[1] * scale, c[2] * scale, c[3], c[4], c[5], p[0], p[1]];
    }
    if (c[0] === "C") {
      const a = f([c[1], c[2]]),
        b = f([c[3], c[4]]),
        p = f([c[5], c[6]]);
      return ["C", a[0], a[1], b[0], b[1], p[0], p[1]];
    }
    return c;
  });
}
/** Flatten commands to polylines for picking, hatching and bounding boxes. */
export function flatten(cmds: Cmd[]): Vec2[][] {
  const out: Vec2[][] = [];
  let current: Vec2[] = [],
    start: Vec2 = [0, 0],
    at: Vec2 = [0, 0];
  for (const c of cmds) {
    if (c[0] === "M") {
      if (current.length > 1) out.push(current);
      at = start = [c[1], c[2]];
      current = [at];
    } else if (c[0] === "L") {
      at = [c[1], c[2]];
      current.push(at);
    } else if (c[0] === "C") {
      const p0 = at;
      for (let i = 1; i <= 12; i++) {
        const t = i / 12,
          u = 1 - t;
        current.push([
          u * u * u * p0[0] + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
          u * u * u * p0[1] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
        ]);
      }
      at = [c[5], c[6]];
    } else if (c[0] === "A") {
      const pts = arcPoints(at, c);
      current.push(...pts.slice(1));
      at = [c[6], c[7]];
    } else if (c[0] === "Z") {
      current.push(start);
      at = start;
    }
  }
  if (current.length > 1) out.push(current);
  return out;
}
/** SVG endpoint arc to center parametrization. */
export function arcCenter(from: Vec2, c: Extract<Cmd, ["A", ...number[]]>) {
  let [, rx, ry, , large, sweep, x, y] = c;
  const dx = (from[0] - x) / 2,
    dy = (from[1] - y) / 2;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * dy * dy - ry * ry * dx * dx,
    den = rx * rx * dy * dy + ry * ry * dx * dx;
  const k = sign * Math.sqrt(Math.max(0, num / den));
  const cx = k * ((rx * dy) / ry) + (from[0] + x) / 2,
    cy = k * (-(ry * dx) / rx) + (from[1] + y) / 2;
  const a0 = Math.atan2((from[1] - cy) / ry, (from[0] - cx) / rx);
  let a1 = Math.atan2((y - cy) / ry, (x - cx) / rx);
  let delta = a1 - a0;
  if (sweep && delta < 0) delta += Math.PI * 2;
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  return { cx, cy, rx, ry, a0, delta };
}
function arcPoints(from: Vec2, c: Extract<Cmd, ["A", ...number[]]>): Vec2[] {
  const { cx, cy, rx, ry, a0, delta } = arcCenter(from, c);
  const n = Math.max(4, Math.ceil(Math.abs(delta) / (Math.PI / 18)));
  return Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos(a0 + (delta * i) / n), cy + ry * Math.sin(a0 + (delta * i) / n)] as Vec2);
}

// ---------------------------------------------------------------------------
// Projected view input from the kernel
export interface ViewInput {
  view: DrawingView;
  camera: ViewCamera;
  scale: number;
  visible: string[];
  hidden: string[];
  /** Bounds of the projected model in SVG model coordinates (u, -v). */
  bbox: [number, number, number, number];
  /** Section face boundary segments, SVG model coordinates. */
  sectionSegments?: [Vec2, Vec2][];
  /** Body ids drawn in this view, with explode offsets applied. */
  offsets?: Record<string, Vec3>;
  /** Flat pattern bend centerlines, SVG model coordinates. */
  bends?: { a: Vec2; b: Vec2; label: string }[];
  /** A section view's cutting plane; the kept material lies along its normal. */
  cut?: { origin: Vec3; normal: Vec3 };
}
export interface ViewTransform {
  input: ViewInput;
  bodies: Geometry["bodies"];
  center: Vec2;
  /** Model 3D point → sheet. */
  sheet(p: Vec3, bodyId?: string): Vec2;
  /** SVG model coords → sheet. */
  map(p: Vec2): Vec2;
  scale: number;
}
function transformFor(input: ViewInput, bodies: Geometry["bodies"]): ViewTransform {
  const [x0, y0, x1, y1] = input.bbox;
  const center: Vec2 = [(x0 + x1) / 2, (y0 + y1) / 2];
  const s = input.scale,
    pos = input.view.position;
  const map = (p: Vec2): Vec2 => [pos[0] + (p[0] - center[0]) * s, pos[1] + (p[1] - center[1]) * s];
  return {
    input,
    bodies,
    center,
    scale: s,
    map,
    sheet: (p: Vec3, bodyId?: string) => {
      const o = (bodyId && input.offsets?.[bodyId]) || [0, 0, 0];
      const q: Vec3 = [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
      return map([dot(q, input.camera.x), -dot(q, input.camera.y)]);
    },
  };
}

// ---------------------------------------------------------------------------
const fmt = (n: number, decimals = 2) => {
  const r = Number(n.toFixed(decimals));
  return String(Object.is(r, -0) ? 0 : r);
};
/** Units of the sheet being composed (one sheet at a time per kernel worker). */
let inches = false;
/** A model length as dimensioned: millimeters, or decimal inches without the leading zero (ANSI). */
const len = (mm: number, decimals?: number) => {
  if (!inches) return fmt(mm, decimals ?? 2);
  const r = (mm / 25.4).toFixed(decimals ?? 3);
  return (Number(r) === 0 ? (0).toFixed(decimals ?? 3) : r).replace(/^(-?)0\./, "$1.");
};
const hatch = (segments: [Vec2, Vec2][], spacing = 2.5): [Vec2, Vec2][] => {
  // 45° hatch: rotate into (s, t) with s along the hatch direction.
  const out: [Vec2, Vec2][] = [];
  if (!segments.length) return out;
  const c = Math.SQRT1_2;
  const toST = (p: Vec2): Vec2 => [(p[0] + p[1]) * c, (p[1] - p[0]) * c];
  const fromST = (q: Vec2): Vec2 => [(q[0] - q[1]) * c, (q[0] + q[1]) * c];
  const segs = segments.map(([a, b]) => [toST(a), toST(b)] as [Vec2, Vec2]);
  const ts = segs.flatMap(([a, b]) => [a[1], b[1]]);
  const lo = Math.min(...ts),
    hi = Math.max(...ts);
  for (let t = Math.ceil(lo / spacing) * spacing; t <= hi; t += spacing) {
    const xs: number[] = [];
    for (const [a, b] of segs) {
      if ((a[1] > t) === (b[1] > t)) continue;
      xs.push(a[0] + ((t - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) out.push([fromST([xs[i], t]), fromST([xs[i + 1], t])]);
  }
  return out;
};

interface Composed {
  prims: Prim[];
  views: DrawingProjection[];
  width: number;
  height: number;
  /** Text anchor of each dimension (sheet mm) and the view it belongs to. */
  labels: { id: string; view: string; at: Vec2 }[];
}
/** Compose the complete sheet: frame, views, dimensions, annotations. */
export function composeSheet(doc: Document, sheet: DrawingSheet, inputs: ViewInput[], geometry: Geometry): Composed {
  inches = doc.units === "in";
  const { width, height } = sheetDimensions(sheet);
  const list = new DisplayList();
  const topo = topologyIndex(geometry.bodies.flatMap((b) => b.topology));
  frame(list, doc, sheet);
  const transforms = new Map<string, ViewTransform>();
  const sources = geometry.bodies.filter((b) => sheet.bodyIds.includes(b.id) && !b.hidden);
  for (const input of inputs) transforms.set(input.view.id, transformFor(input, sources));
  const pick: DrawingProjection[] = [];
  for (const input of inputs) {
    const t = transforms.get(input.view.id)!,
      v = input.view;
    list.prims.push({ k: "group", id: v.id });
    const clip = v.kind === "detail" && v.detail ? { center: t.map(svgOf(v.detail.center)), radius: v.detail.radius * t.scale } : undefined;
    if (clip) list.prims.push({ k: "clip", ...clip });
    if (v.hiddenLines ?? sheet.hiddenLines)
      if (!["iso", "dimetric", "trimetric"].includes(v.orientation ?? "") && input.hidden.length) {
        list.begin({ "data-hidden-lines": "true" });
        for (const d of input.hidden) list.path(transformCmds(parsePath(d), t.map, t.scale), { width: THIN, dash: [1.6, 0.8], layer: "hidden" });
        list.end();
      }
    for (const d of input.visible) list.path(transformCmds(parsePath(d), t.map, t.scale), { width: THICK, layer: "visible" });
    if (input.sectionSegments?.length) {
      const segs = input.sectionSegments.map(([a, b]) => [t.map(a), t.map(b)] as [Vec2, Vec2]);
      for (const [a, b] of hatch(segs)) list.line(a, b, { width: THIN, layer: "hatch" });
    }
    if (!["iso", "dimetric", "trimetric"].includes(v.orientation ?? "") && v.kind !== "flat") threadMarks(list, t, v.hiddenLines ?? sheet.hiddenLines ?? false);
    if (clip) {
      list.prims.push({ k: "unclip" });
      list.circle(clip.center, clip.radius, { width: THIN, layer: "annotation" });
    }
    // Automatic center marks for circles seen face-on.
    const edges = viewEdges(t, geometry, sheet, v);
    if (!["iso", "dimetric", "trimetric"].includes(v.orientation ?? "") && v.kind !== "section") {
      const seen = new Set<string>();
      for (const e of edges)
        if (e.circle && e.visible) {
          const key = `${e.circle.center[0].toFixed(2)},${e.circle.center[1].toFixed(2)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (clip && len2(sub2(e.circle.center, clip.center)) > clip.radius) continue;
          centerMark(list, e.circle.center, e.circle.radius);
        }
    }
    // Flat pattern bend centerlines with direction, angle and radius.
    for (const bend of input.bends ?? []) {
      const a = t.map(bend.a),
        b = t.map(bend.b),
        u = mul2(sub2(b, a), 1 / (len2(sub2(b, a)) || 1));
      list.line(sub2(a, mul2(u, 2)), add2(b, mul2(u, 2)), { width: THIN, dash: [6, 1.2, 1.2, 1.2], layer: "center" });
      const mid = mul2(add2(a, b), 0.5);
      const angle = (Math.atan2(u[1], u[0]) * 180) / Math.PI,
        upright = angle > 90 || angle < -90 ? angle + 180 : angle;
      list.text(add2(mid, mul2([u[1], -u[0]], u[0] < 0 ? -1.4 : 1.4)), bend.label, SMALL, "middle", upright);
    }
    // Labels.
    const [, y0, , y1] = input.bbox;
    const below: Vec2 = [v.position[0], v.position[1] + ((y1 - y0) / 2) * t.scale + 7];
    if (v.kind === "section" && v.section) list.text(below, `SECTION ${v.section.label}-${v.section.label}`, TEXT, "middle", 0, true);
    else if (v.kind === "detail" && v.detail) list.text([v.position[0], v.position[1] + (v.detail.radius * t.scale) + 7], `DETAIL ${v.detail.label} (${ratio(t.scale)})`, TEXT, "middle", 0, true);
    else if (v.kind === "flat") list.text(below, "FLAT PATTERN", TEXT, "middle", 0, true);
    else if (v.showLabel) list.text(below, v.name.toUpperCase(), SMALL);
    list.prims.push({ k: "endgroup" });
    // Pick data and bounds in sheet coordinates.
    const [bx0, by0, bx1, by1] = input.bbox;
    const a = t.map([bx0, by0]),
      b = t.map([bx1, by1]);
    pick.push({
      name: v.id,
      id: v.id,
      label: v.name,
      kind: v.kind,
      bounds: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])],
      measureBounds: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])],
      circles: edges.filter((e) => e.circle && e.visible).map((e) => ({ reference: e.ref, center: e.circle!.center, radius: e.circle!.radius })),
      scale: t.scale,
      origin: t.map([0, 0]),
      xAxis: input.camera.x,
      yAxis: input.camera.y,
      direction: input.camera.dir,
      edges,
    });
  }
  // Section lines and detail circles on parent views.
  for (const input of inputs) {
    const v = input.view,
      parent = v.parentId ? transforms.get(v.parentId) : undefined;
    if (!parent) continue;
    if (v.kind === "section" && v.section) sectionLine(list, parent, v);
    if (v.kind === "detail" && v.detail) {
      const c = parent.map(svgOf(v.detail.center)),
        r = v.detail.radius * parent.scale;
      list.circle(c, r, { width: THIN, dash: [6, 1.5, 1, 1.5], layer: "annotation" });
      list.text(add2(c, [r * 0.75 + 3, -r * 0.75 - 2]), v.detail.label, 5, "middle", 0, true);
    }
  }
  const labels: Composed["labels"] = [];
  for (const dim of sheet.dimensions) {
    const start = list.prims.length;
    list.begin({ "data-dimension": dim.id });
    const value = dimension(list, doc, sheet, dim, transforms, topo, (at) => labels.push({ id: dim.id, view: dim.view, at }));
    list.end();
    const group = list.prims[start] as Extract<Prim, { k: "group" }>;
    if (value !== undefined) group.attrs!["data-value"] = fmt(value, 4);
  }
  for (const a of sheet.annotations ?? []) {
    list.begin({ "data-annotation": a.id });
    annotation(list, doc, sheet, a, transforms, topo, geometry);
    list.end();
  }
  return { prims: list.prims, views: pick, width, height, labels };
}
const svgOf = (p: Vec2): Vec2 => [p[0], -p[1]];
export const ratio = (scale: number) =>
  scale >= 1 ? `${fmt(scale, 3)} : 1` : `1 : ${fmt(1 / scale, 3)}`;
/** The root diameter of a thread: the minor diameter of a shaft, the major diameter of a hole. */
const rootRadius = (th: ThreadRecord) => (th.internal ? th.diameter / 2 : th.diameter / 2 - 0.613435 * th.pitch);
/**
 * Cosmetic threads in the simplified convention (ISO 6410, ASME Y14.6): roots
 * as thin lines with a thick limit line where the thread stops, and a thin
 * three-quarter circle seen end-on. A hole's thread is hidden unless a
 * section cuts along it. Modeled threads draw their real edges instead.
 */
function threadMarks(list: DisplayList, t: ViewTransform, hiddenLines: boolean) {
  const { camera, cut } = t.input,
    tol = 1e-3;
  for (const body of t.bodies)
    for (const th of body.threads ?? []) {
      if (th.modeled) continue;
      const end = along3(th.origin, th.direction, th.length),
        side = (p: Vec3) => (cut ? dot(sub3(p, cut.origin), cut.normal) : 0),
        so = side(th.origin),
        se = side(end);
      // The section removed the whole thread.
      if (Math.max(so, se) < -tol) continue;
      const facing = dot(th.direction, camera.dir),
        root = rootRadius(th) * t.scale,
        crest = (th.diameter / 2) * t.scale;
      const start = list.prims.length;
      list.begin({ "data-thread": th.featureId });
      if (Math.abs(facing) > 0.999) {
        // End-on: drawn where a thread end faces the viewer (camera.dir points at the
        // viewer), or where the section cuts across the thread. Open in the upper right.
        const originNearer = dot(th.origin, camera.dir) >= dot(end, camera.dir),
          cutAcross = !!cut && Math.min(so, se) < -tol && Math.max(so, se) > tol;
        if (originNearer || th.through || cutAcross)
          list.arc(t.sheet(th.origin, body.id), root, (5 * Math.PI) / 180, (265 * Math.PI) / 180, { width: THIN, layer: "thread" });
      } else if (Math.abs(facing) < 1e-3) {
        const a = t.sheet(th.origin, body.id),
          b = t.sheet(end, body.id),
          n = perp2(unit2(sub2(b, a)));
        const sectioned = !!cut && Math.abs(so) < tol && Math.abs(se) < tol,
          hidden = th.internal && !sectioned;
        if (!hidden || hiddenLines) {
          const thin: Style = hidden ? { width: THIN, dash: [1.6, 0.8], layer: "hidden" } : { width: THIN, layer: "thread" },
            limit: Style = hidden ? thin : { width: THICK, layer: "visible" };
          for (const k of [1, -1]) list.line(add2(a, mul2(n, k * root)), add2(b, mul2(n, k * root)), thin);
          if (!th.through) list.line(add2(b, mul2(n, crest)), add2(b, mul2(n, -crest)), limit);
        }
      }
      if (list.prims.length > start + 1) list.end();
      else list.prims.length = start;
    }
}
/** The thread on the cylinder a circular edge bounds, if any. */
function threadAt(t: ViewTransform, tp: Topology, topo: TopologyLookup): ThreadRecord | undefined {
  const body = t.bodies.find((b) => b.id === tp.bodyId);
  return body?.threads?.find((th) => {
    if (!tp.radius || Math.abs(tp.radius - th.radius) > 1e-4) return false;
    if (tp.normal && Math.abs(dot(norm3(tp.normal), th.direction)) < 0.999) return false;
    const offset = sub3(tp.center, th.origin),
      s = dot(offset, th.direction);
    if (Math.hypot(...sub3(offset, along3([0, 0, 0], th.direction, s))) > 1e-3) return false;
    // Within the threaded cylinder: its face centroid sits halfway along it.
    const face = topo.get(th.faceId),
      span = face ? 2 * Math.abs(dot(sub3(face.center, th.origin), th.direction)) : Infinity;
    return s > -1e-3 && s < span + 1e-3;
  });
}
/** A thread's designation as called out, sizes in metric (M10×1.5, LH when left-handed). */
const threadDesignation = (th: ThreadRecord) => `${th.label}${th.leftHand ? " LH" : ""}`;
function centerMark(list: DisplayList, c: Vec2, r: number) {
  const e = r + 2;
  const style: Style = { width: THIN, dash: [5, 1, 1, 1], layer: "center" };
  list.begin({ "data-centerline": "true" });
  list.line([c[0] - e, c[1]], [c[0] + e, c[1]], style);
  list.line([c[0], c[1] - e], [c[0], c[1] + e], style);
  list.end();
}
function sectionLine(list: DisplayList, parent: ViewTransform, v: DrawingView) {
  const s = v.section!;
  const a = parent.map(svgOf(s.a)),
    b = parent.map(svgOf(s.b));
  // Arrows show the viewing direction: left of a→b in model space (flip reverses).
  const u = unit2(sub2(b, a)),
    n = mul2(perp2(u), s.flip ? 1 : -1);
  const ext = 4;
  const a2 = sub2(a, mul2(u, ext)),
    b2 = add2(b, mul2(u, ext));
  list.line(a2, b2, { width: THIN, dash: [8, 1.5, 1.5, 1.5], layer: "annotation" });
  // Thick ends, and arrows pointing in the viewing direction.
  list.line(a2, add2(a2, mul2(u, 5)), { width: 0.7, layer: "annotation" });
  list.line(b2, sub2(b2, mul2(u, 5)), { width: 0.7, layer: "annotation" });
  for (const end of [a2, b2]) {
    list.line(end, add2(end, mul2(n, 8)), { width: THIN, layer: "annotation" });
    list.arrow(add2(end, mul2(n, 8)), n, 3);
    list.text(add2(add2(end, mul2(n, 12)), [0, 1.8]), s.label, 5, "middle", 0, true);
  }
}

// ---------------------------------------------------------------------------
/** Model edges projected into a view, for picking and center marks. */
function viewEdges(t: ViewTransform, geometry: Geometry, sheet: DrawingSheet, v: DrawingView): DrawingEdge[] {
  // Sections and flat patterns are not projections of the model's faces and edges.
  if (v.kind === "section" || v.kind === "flat") return [];
  const out: DrawingEdge[] = [];
  const dir = t.input.camera.dir;
  const visibleSegs = t.input.visible.flatMap((d) => flatten(transformCmds(parsePath(d), t.map, t.scale)));
  const grid = new Map<string, [Vec2, Vec2][]>();
  const cell = 2;
  for (const poly of visibleSegs)
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i],
        b = poly[i + 1];
      const minX = Math.floor(Math.min(a[0], b[0]) / cell),
        maxX = Math.floor(Math.max(a[0], b[0]) / cell),
        minY = Math.floor(Math.min(a[1], b[1]) / cell),
        maxY = Math.floor(Math.max(a[1], b[1]) / cell);
      for (let x = minX; x <= maxX; x++)
        for (let y = minY; y <= maxY; y++) {
          const key = `${x},${y}`;
          const list = grid.get(key) ?? [];
          list.push([a, b]);
          grid.set(key, list);
        }
    }
  const nearVisible = (p: Vec2) => {
    const key = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    return (grid.get(key) ?? []).some(([a, b]) => segmentDistance(p, a, b) < 0.25);
  };
  const detail = v.kind === "detail" && v.detail ? { c: t.map(svgOf(v.detail.center)), r: v.detail.radius * t.scale } : undefined;
  for (const body of geometry.bodies) {
    if (!sheet.bodyIds.includes(body.id) || body.hidden) continue;
    const byId = new Map(body.topology.map((x) => [x.id, x]));
    for (const g of body.edges.edgeGroups) {
      const tp = byId.get(g.id);
      if (!tp) continue;
      const pts: Vec2[] = [];
      for (let i = g.start; i < g.start + g.count; i++) {
        const p: Vec3 = [body.edges.lines[i * 3], body.edges.lines[i * 3 + 1], body.edges.lines[i * 3 + 2]];
        const q = t.sheet(p, body.id);
        if (!pts.length || len2(sub2(pts[pts.length - 1], q)) > 1e-6) pts.push(q);
      }
      if (pts.length < 2) continue;
      if (detail && pts.every((p) => len2(sub2(p, detail.c)) > detail.r)) continue;
      const mid = pts[Math.floor(pts.length / 2)];
      const visible = nearVisible(mid) || nearVisible(pts[0]);
      const faceOn = tp.geomType === "CIRCLE" && tp.radius && tp.normal && Math.abs(dot(tp.normal, dir)) > 0.999;
      out.push({
        ref: { id: tp.id, bodyId: tp.bodyId, kind: "edge", geomType: tp.geomType, signature: tp.signature },
        points: pts,
        visible,
        ...(faceOn ? { circle: { center: t.sheet(tp.center, body.id), radius: tp.radius! * t.scale } } : {}),
        depth: dot(tp.center, dir),
      } as DrawingEdge & { depth: number });
    }
  }
  // Rims that project onto each other: only the one nearest the viewer is pickable.
  const groups = new Map<string, (DrawingEdge & { depth: number })[]>();
  for (const e of out as (DrawingEdge & { depth: number })[])
    if (e.circle) {
      const key = `${e.circle.center[0].toFixed(4)},${e.circle.center[1].toFixed(4)},${e.circle.radius.toFixed(4)}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
  for (const list of groups.values()) {
    list.sort((a, b) => b.depth - a.depth || a.ref.id.localeCompare(b.ref.id));
    for (const e of list.slice(1)) {
      e.visible = false;
      delete e.circle;
    }
  }
  for (const e of out as any[]) delete e.depth;
  return out;
}
function segmentDistance(p: Vec2, a: Vec2, b: Vec2) {
  const d = sub2(b, a),
    l2 = d[0] * d[0] + d[1] * d[1];
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2));
  return len2(sub2(p, add2(a, mul2(d, t))));
}

// ---------------------------------------------------------------------------
// Dimensions
function pointOf(dp: DrawingPoint, topo: TopologyLookup): Vec3 {
  const t = topo.get(dp.ref.id);
  if (!t) throw Error("Drawing dimension no longer resolves; reselect the geometry");
  if (dp.anchor === "start" && t.endpoints) return t.endpoints[0];
  if (dp.anchor === "end" && t.endpoints) return t.endpoints[1];
  return t.center;
}
const tolText = (d: DrawingDimension) => {
  const tol = d.tolerance;
  if (!tol) return undefined;
  if (tol.kind === "symmetric") return { inline: ` ±${len(tol.upper, d.decimals)}` };
  return { upper: tol.upper, lower: tol.lower ?? 0 };
};
function dimensionText(list: DisplayList, at: Vec2, base: string, d: DrawingDimension, value: number, rotate = 0) {
  const t = tolText(d);
  const text = d.text ?? `${d.prefix ?? ""}${base}${d.suffix ?? ""}`;
  if (t && "upper" in t && t.upper !== undefined) {
    if (d.tolerance!.kind === "limits") {
      list.text([at[0], at[1] - 1.9], len(value + t.upper, d.decimals), 2.8, "middle", rotate);
      list.text([at[0], at[1] + 1.6], len(value - Math.abs(t.lower), d.decimals), 2.8, "middle", rotate);
      return;
    }
    list.text(at, text, TEXT, "end", rotate);
    list.text([at[0] + 0.8, at[1] - 1.6], `+${len(t.upper, d.decimals)}`, 2.2, "start", rotate);
    list.text([at[0] + 0.8, at[1] + 1.4], `-${len(Math.abs(t.lower ?? 0), d.decimals)}`, 2.2, "start", rotate);
    return;
  }
  list.text(at, text + (t && "inline" in t ? t.inline : ""), TEXT, "middle", rotate);
}
/** Linear dimension between sheet points p and q, measured along `axis` (unit sheet vector). */
function linearDim(list: DisplayList, p: Vec2, q: Vec2, axis: Vec2, text: Vec2, label: string, d: DrawingDimension, value: number) {
  const n = perp2(axis);
  const off = (pt: Vec2) => (text[0] - pt[0]) * n[0] + (text[1] - pt[1]) * n[1];
  const pa = add2(p, mul2(n, off(p))),
    qa = add2(q, mul2(n, off(q)));
  const gap = 1,
    over = 2;
  for (const [from, to] of [
    [p, pa],
    [q, qa],
  ] as [Vec2, Vec2][]) {
    const v = sub2(to, from),
      l = len2(v);
    if (l < 1e-6) continue;
    const u = mul2(v, 1 / l);
    list.line(add2(from, mul2(u, Math.min(gap, l))), add2(to, mul2(u, over)), { width: THIN, layer: "dimension" });
  }
  const span = len2(sub2(qa, pa)),
    u = unit2(sub2(qa, pa));
  const along = (text[0] - pa[0]) * u[0] + (text[1] - pa[1]) * u[1];
  const inside = span > 12;
  if (inside) {
    list.line(pa, qa, { width: THIN, layer: "dimension" });
    list.arrow(pa, mul2(u, -1));
    list.arrow(qa, u);
  } else {
    list.line(sub2(pa, mul2(u, 7)), add2(qa, mul2(u, 7)), { width: THIN, layer: "dimension" });
    list.arrow(pa, u);
    list.arrow(qa, mul2(u, -1));
  }
  if (along < -1) list.line(pa, add2(pa, mul2(u, along)), { width: THIN, layer: "dimension" });
  if (along > span + 1) list.line(qa, add2(pa, mul2(u, along)), { width: THIN, layer: "dimension" });
  // Text sits just above the dimension line, aligned with it (ISO).
  const angle = Math.atan2(u[1], u[0]);
  // Text reads from the bottom or the right of the sheet (ISO 129).
  let rot = (angle * 180) / Math.PI;
  if (rot > 89.99) rot -= 180;
  else if (rot <= -90.01) rot += 180;
  const up = perp2([Math.cos((rot * Math.PI) / 180), Math.sin((rot * Math.PI) / 180)]);
  const base = add2(add2(pa, mul2(u, along)), mul2(up, -1.2));
  dimensionText(list, base, label, d, value, Math.abs(rot) < 0.01 ? 0 : rot);
}
function dimension(
  list: DisplayList,
  doc: Document,
  sheet: DrawingSheet,
  d: DrawingDimension,
  transforms: Map<string, ViewTransform>,
  topo: TopologyLookup,
  report: (at: Vec2) => void = () => {},
): number | undefined {
  const t = transforms.get(d.view);
  if (!t) throw Error("Drawing dimension refers to a deleted view");
  const center = t.input.view.position;
  const textAt = (fallback: Vec2): Vec2 => {
    const at = d.position ? add2(center, d.position) : fallback;
    report(at);
    return at;
  };
  const decimals = d.decimals ?? 2;
  // Legacy dimensions.
  if (!d.type) {
    if (d.kind && d.reference) {
      const tp = topo.get(d.reference.id);
      if (!tp?.radius) throw Error("Diameter/radius callout reference is stale or not circular");
      const c = t.sheet(tp.center, tp.bodyId),
        r = tp.radius * t.scale;
      const th = threadAt(t, tp, topo);
      radial(list, c, r, tp.radius, d.kind, textAt(add2(c, [r + (d.offset ?? 8), -(r + (d.offset ?? 8))])), d, th && threadDesignation(th));
      return d.kind === "diameter" ? tp.radius * 2 : tp.radius;
    }
    let pts: Vec2[];
    if (d.refs)
      pts = d.refs.map((r) => {
        const tp = topo.get(r.id);
        if (!tp) throw Error("Drawing dimension no longer resolves; reselect geometry");
        return t.sheet(tp.center, tp.bodyId);
      });
    else {
      // Overall size from exact body bounds, projected into this view.
      pts = [];
      for (const b of t.bodies)
        for (const x of [b.bounds[0][0], b.bounds[1][0]])
          for (const y of [b.bounds[0][1], b.bounds[1][1]])
            for (const z of [b.bounds[0][2], b.bounds[1][2]]) pts.push(t.sheet([x, y, z], b.id));
      if (!pts.length) {
        const [x0, y0, x1, y1] = t.input.bbox;
        pts = [t.map([x0, y1]), t.map([x1, y0])];
      }
    }
    const horizontal = d.axis !== "vertical";
    const xs = pts.map((p) => p[0]),
      ys = pts.map((p) => p[1]);
    const [bx0, , bx1, by1] = t.input.bbox;
    const top = t.map([bx0, by1]),
      right = t.map([bx1, by1]);
    const value = (horizontal ? Math.max(...xs) - Math.min(...xs) : Math.max(...ys) - Math.min(...ys)) / t.scale;
    if (value < 1e-6) throw Error("Dimension has zero projected length");
    const p: Vec2 = horizontal ? [Math.min(...xs), ys[xs.indexOf(Math.min(...xs))]] : [xs[ys.indexOf(Math.min(...ys))], Math.min(...ys)];
    const q: Vec2 = horizontal ? [Math.max(...xs), ys[xs.indexOf(Math.max(...xs))]] : [xs[ys.indexOf(Math.max(...ys))], Math.max(...ys)];
    const level = horizontal ? Math.max(top[1], ...ys) + (d.offset ?? 8) : Math.max(right[0], ...xs) + (d.offset ?? 8);
    const text: Vec2 = horizontal ? [(p[0] + q[0]) / 2, level] : [level, (p[1] + q[1]) / 2];
    linearDim(list, p, q, horizontal ? [1, 0] : [0, -1], textAt(text), len(value, d.decimals), d, value);
    return value;
  }
  const pts = (d.points ?? []).map((dp) => {
    const tp = topo.get(dp.ref.id);
    if (!tp) throw Error("Drawing dimension no longer resolves; reselect the geometry");
    return { dp, tp, sheet: t.sheet(pointOf(dp, topo), tp.bodyId) };
  });
  if (d.type === "ordinate") {
    // An edge's extension line leaves from its end nearest the row, not its middle.
    const ends = pts.map((x) => (x.tp.endpoints && !["start", "end"].includes(x.dp.anchor ?? "") ? x.tp.endpoints.map((e) => t.sheet(e, x.tp.bodyId)) : [x.sheet]));
    ordinate(
      list,
      pts.map((x) => x.sheet),
      ends,
      d.axis !== "vertical",
      t,
      d,
      (fallback) => textAt(fallback),
    );
    return undefined;
  }
  if (d.type === "radius" || d.type === "diameter" || d.type === "hole") {
    const tp = pts[0]?.tp;
    if (!tp?.radius) throw Error("Select a circular edge for a diameter, radius or hole callout");
    const c = t.sheet(tp.center, tp.bodyId),
      r = tp.radius * t.scale;
    const at = textAt(add2(c, [r + 10, -(r + 8)]));
    if (d.type === "hole") holeCallout(list, doc, sheet, tp, c, r, at, t, topo);
    else {
      const th = threadAt(t, tp, topo);
      radial(list, c, r, tp.radius, d.type, at, d, th && threadDesignation(th));
    }
    return d.type === "radius" ? tp.radius : tp.radius * 2;
  }
  if (d.type === "angle") {
    const lines = pts.filter((x) => x.tp.endpoints);
    if (lines.length < 2) throw Error("Angle dimensions need two straight edges");
    const seg = (x: (typeof lines)[number]): [Vec2, Vec2] => [t.sheet(x.tp.endpoints![0], x.tp.bodyId), t.sheet(x.tp.endpoints![1], x.tp.bodyId)];
    const [a, b] = [seg(lines[0]), seg(lines[1])];
    const ua = unit2(sub2(a[1], a[0])),
      ub = unit2(sub2(b[1], b[0]));
    const det = ua[0] * ub[1] - ua[1] * ub[0];
    if (Math.abs(det) < 1e-6) throw Error("The edges are parallel");
    const s = ((b[0][0] - a[0][0]) * ub[1] - (b[0][1] - a[0][1]) * ub[0]) / det;
    const o = add2(a[0], mul2(ua, s));
    const at = textAt(add2(o, mul2(unit2(add2(ua, ub)), 15)));
    const radius = len2(sub2(at, o));
    // Choose the ray directions toward the text.
    const pickDir = (u: Vec2) => (((at[0] - o[0]) * u[0] + (at[1] - o[1]) * u[1]) >= 0 ? u : mul2(u, -1));
    const da = pickDir(ua),
      db = pickDir(ub);
    let a0 = Math.atan2(da[1], da[0]),
      a1 = Math.atan2(db[1], db[0]);
    let delta = a1 - a0;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    a1 = a0 + delta;
    list.arc(o, radius, a0, a1, { width: THIN, layer: "dimension" });
    const value = (Math.abs(delta) * 180) / Math.PI;
    const e0 = add2(o, mul2([Math.cos(a0), Math.sin(a0)], radius)),
      e1 = add2(o, mul2([Math.cos(a1), Math.sin(a1)], radius));
    list.arrow(e0, mul2(perp2([Math.cos(a0), Math.sin(a0)]), delta > 0 ? -1 : 1), 2.4);
    list.arrow(e1, mul2(perp2([Math.cos(a1), Math.sin(a1)]), delta > 0 ? 1 : -1), 2.4);
    dimensionText(list, add2(at, [0, -1]), `${fmt(value, Math.min(decimals, 1))}°`, d, value);
    return value;
  }
  // Linear dimensions.
  let p: Vec2, q: Vec2;
  if (pts.length === 1 && pts[0].tp.endpoints) {
    p = t.sheet(pts[0].tp.endpoints[0], pts[0].tp.bodyId);
    q = t.sheet(pts[0].tp.endpoints[1], pts[0].tp.bodyId);
  } else if (pts.length >= 2) {
    p = pts[0].sheet;
    q = pts[1].sheet;
    // Point to edge: perpendicular foot on the edge line.
    const [x, y] = pts;
    const edgeOnly = [x, y].filter((z) => z.dp.anchor === "edge" && z.tp.endpoints);
    if (edgeOnly.length === 1) {
      const e = edgeOnly[0],
        other = e === x ? y : x;
      const a0 = t.sheet(e.tp.endpoints![0], e.tp.bodyId),
        a1 = t.sheet(e.tp.endpoints![1], e.tp.bodyId),
        u = unit2(sub2(a1, a0));
      const q0 = other.sheet,
        k = (q0[0] - a0[0]) * u[0] + (q0[1] - a0[1]) * u[1];
      p = q0;
      q = add2(a0, mul2(u, k));
    }
    if (x.dp.anchor === "edge" && y.dp.anchor === "edge" && x.tp.endpoints && y.tp.endpoints) {
      const a0 = t.sheet(x.tp.endpoints[0], x.tp.bodyId),
        a1 = t.sheet(x.tp.endpoints[1], x.tp.bodyId),
        u = unit2(sub2(a1, a0));
      const b0 = t.sheet(y.tp.endpoints[0], y.tp.bodyId);
      const n = perp2(u),
        dist = (b0[0] - a0[0]) * n[0] + (b0[1] - a0[1]) * n[1];
      p = mul2(add2(a0, a1), 0.5);
      q = add2(p, mul2(n, dist));
    }
  } else throw Error("Select one straight edge or two points to dimension");
  const axis: Vec2 = d.type === "horizontal" ? [1, 0] : d.type === "vertical" ? [0, -1] : unit2(sub2(q, p));
  const value = Math.abs((q[0] - p[0]) * axis[0] + (q[1] - p[1]) * axis[1]) / t.scale;
  if (value < 1e-6) throw Error("Dimension has zero projected length");
  const mid = mul2(add2(p, q), 0.5);
  linearDim(list, p, q, axis, textAt(add2(mid, mul2(perp2(axis), 10))), len(value, d.decimals), d, value);
  return value;
}
/**
 * Ordinate dimensions (ASME Y14.5, ISO 129-1): each point's distance from the
 * first along one axis, every value at the end of its own extension line on a
 * shared row. Points with the same value share one line; values closer than
 * the text height spread apart with jogged lines.
 */
function ordinate(list: DisplayList, points: Vec2[], ends: Vec2[][], horizontal: boolean, t: ViewTransform, d: DrawingDimension, place: (fallback: Vec2) => Vec2) {
  if (!points.length) throw Error("An ordinate dimension needs its zero point");
  // k: the measured sheet axis (x for horizontal), j: the axis the lines run along.
  const k = horizontal ? 0 : 1,
    j = 1 - k;
  const [bx0, by0, bx1, by1] = t.input.bbox,
    a = t.map([bx0, by0]),
    b = t.map([bx1, by1]),
    lo = Math.min(a[j], b[j]),
    hi = Math.max(a[j], b[j]);
  // The row: above (horizontal) or right of (vertical) the view unless placed elsewhere.
  const fallback: Vec2 = horizontal ? [t.input.view.position[0], lo - 10] : [hi + 10, t.input.view.position[1]];
  const row = place(fallback)[j],
    out = row < (lo + hi) / 2 ? -1 : 1;
  const zero = points[0][k];
  const values = points.map((p) => Math.abs(p[k] - zero) / t.scale);
  list.begin({ "data-values": values.map((v) => fmt(v, 4)).join(",") });
  // One line per distinct value, from the point nearest the row.
  const items: { at: number; from: number; value: number }[] = [];
  points.forEach((p, i) => {
    const from = ends[i].reduce((best, e) => (Math.abs(row - e[j]) < Math.abs(row - best) ? e[j] : best), p[j]);
    const same = items.find((x) => Math.abs(x.at - p[k]) < 1e-3);
    if (!same) items.push({ at: p[k], from, value: values[i] });
    else if (Math.abs(row - from) < Math.abs(row - same.from)) same.from = from;
  });
  items.sort((x, y) => x.at - y.at);
  // Spread crowded values to at least a text height apart.
  const gap = 4.2,
    pos = items.map((x) => x.at);
  for (let pass = 0; pass < 100; pass++) {
    let moved = false;
    for (let i = 1; i < pos.length; i++) {
      const overlap = gap - (pos[i] - pos[i - 1]);
      if (overlap > 1e-6) {
        pos[i - 1] -= overlap / 2;
        pos[i] += overlap / 2;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const at = (along: number, across: number): Vec2 => (horizontal ? [along, across] : [across, along]);
  const style: Style = { width: THIN, layer: "dimension" };
  items.forEach((item, i) => {
    const toward = Math.sign(row - item.from) || out,
      start = item.from + toward * 1,
      jogged = Math.abs(pos[i] - item.at) > 1e-6,
      knee = row - toward * 3;
    if (jogged && Math.abs(knee - start) > 1e-6 && Math.sign(knee - start) === toward) {
      list.poly([at(item.at, start), at(item.at, knee), at(pos[i], row - toward * 1), at(pos[i], row)], style);
    } else list.line(at(item.at, start), at(pos[i], row), style);
    const label = `${d.prefix ?? ""}${len(item.value, d.decimals)}${d.suffix ?? ""}`;
    // Horizontal ordinates read from the bottom of the sheet, along their lines.
    if (horizontal) list.text([pos[i] + 1.2, row + out * 1], label, TEXT, out < 0 ? "start" : "end", -90);
    else list.text([row + out * 1, pos[i] + 1.2], label, TEXT, out > 0 ? "start" : "end");
  });
  list.end();
}
function radial(list: DisplayList, c: Vec2, r: number, modelRadius: number, kind: "radius" | "diameter", at: Vec2, d: DrawingDimension, thread?: string) {
  const u = unit2(sub2(at, c));
  const rim = add2(c, mul2(u, r));
  const shoulder: Vec2 = [at[0] + (u[0] >= 0 ? -1 : 1) * 0, at[1]];
  if (kind === "diameter") {
    const far = sub2(c, mul2(u, r));
    list.line(far, shoulder, { width: THIN, layer: "dimension" });
    list.arrow(rim, u);
    list.arrow(far, mul2(u, -1));
  } else {
    list.line(c, shoulder, { width: THIN, layer: "dimension" });
    list.arrow(rim, u);
  }
  // A threaded cylinder's diameter reads as its thread designation.
  const label = kind === "diameter" && thread ? thread : `${kind === "diameter" ? "Ø" : "R"}${len(kind === "diameter" ? modelRadius * 2 : modelRadius, d.decimals)}`;
  const right = u[0] >= 0;
  const textEnd: Vec2 = [at[0] + (right ? 12 : -12), at[1]];
  list.line(at, textEnd, { width: THIN, layer: "dimension" });
  dimensionTextAligned(list, [(at[0] + textEnd[0]) / 2, at[1] - 1.2], label, d);
}
function dimensionTextAligned(list: DisplayList, at: Vec2, label: string, d: DrawingDimension) {
  const t = tolText(d);
  list.text(at, (d.text ?? `${d.prefix ?? ""}${label}${d.suffix ?? ""}`) + (t && "inline" in t ? t.inline : ""), TEXT, "middle");
}
function holeCallout(list: DisplayList, doc: Document, sheet: DrawingSheet, tp: Topology, c: Vec2, r: number, at: Vec2, t: ViewTransform, topo: TopologyLookup) {
  const diameter = tp.radius! * 2;
  const near = (a?: number) => a !== undefined && Math.abs(a - diameter) < 1e-3;
  // The hole feature whose drill, counterbore or countersink matches this rim.
  const candidates = doc.features
    .filter((f) => f.type === "hole" && !f.suppressed && f.bodyId === tp.bodyId)
    .map((f) => {
      try {
        return { f, dims: holeDimensions(f.params) };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is { f: (typeof doc.features)[number]; dims: ReturnType<typeof holeDimensions> } => !!x)
    .filter(({ dims }) => near(dims.diameter) || near(dims.counterbore?.diameter) || near(dims.countersink?.diameter));
  const lines: string[] = [];
  const hole = candidates[0],
    thread = threadAt(t, tp, topo);
  if (thread) {
    // Identical threads on parallel axes in this body count together (4× M5×0.8).
    const same = (t.bodies.find((b) => b.id === tp.bodyId)?.threads ?? []).filter(
      (x) => x.label === thread.label && x.internal === thread.internal && Math.abs(x.length - thread.length) < 1e-6 && Math.abs(dot(x.direction, thread.direction)) > 0.999,
    );
    const prefix = same.length > 1 ? `${same.length}× ` : "";
    if (thread.internal) {
      lines.push(`${prefix}${threadDesignation(thread)}${thread.through ? " THRU" : ` DEEP ${len(thread.length)}`}`, `TAP DRILL Ø${len(thread.radius * 2)}`);
      if (hole?.dims.counterbore) lines.push(`CBORE Ø${len(hole.dims.counterbore.diameter)} DEEP ${len(hole.dims.counterbore.depth)}`);
      if (hole?.dims.countersink) lines.push(`CSK Ø${len(hole.dims.countersink.diameter)} × ${fmt(hole.dims.countersink.angle, 0)}°`);
    } else lines.push(`${prefix}${threadDesignation(thread)}`, ...(thread.through ? [] : [`THREAD LENGTH ${len(thread.length)}`]));
  } else if (hole) {
    const p = hole.f.params,
      dims = hole.dims;
    let instances = Math.max(1, p.positions?.length ?? doc.sketches.find((s) => s.id === p.sketchId)?.entities.filter((e) => e.type === "point" || e.type === "circle").length ?? 1);
    for (const pattern of doc.features)
      if (pattern.type === "pattern" && !pattern.suppressed && (pattern.params.featureIds ?? [pattern.params.featureId]).includes(hole.f.id))
        instances *= Math.max(1, pattern.params.count * (pattern.params.count2 ?? 1) - (pattern.params.skippedInstances?.length ?? 0));
    const prefix = instances > 1 ? `${instances}× ` : "";
    const depth = p.depth ? ` DEEP ${len(p.depth)}` : " THRU";
    // Thread designations stay metric (M5×0.8); sizes follow the sheet units.
    if (dims.thread) lines.push(`${prefix}${dims.thread.size}×${fmt(dims.thread.pitch)}${depth}`, `TAP DRILL Ø${len(dims.diameter)}`);
    else lines.push(`${prefix}Ø${len(dims.diameter)}${depth}`);
    if (dims.counterbore) lines.push(`CBORE Ø${len(dims.counterbore.diameter)} DEEP ${len(dims.counterbore.depth)}`);
    if (dims.countersink) lines.push(`CSK Ø${len(dims.countersink.diameter)} × ${fmt(dims.countersink.angle, 0)}°`);
  } else {
    // A plain cylindrical cut: count matching rims seen face-on.
    const rims = [...topo.values()].filter(
      (x) => x.kind === "edge" && x.radius && Math.abs(x.radius - tp.radius!) < 1e-6 && x.normal && Math.abs(dot(x.normal, t.input.camera.dir)) > 0.999 && sheet.bodyIds.includes(x.bodyId),
    );
    const centers = new Set(rims.map((x) => { const q = t.sheet(x.center, x.bodyId); return `${q[0].toFixed(2)},${q[1].toFixed(2)}`; }));
    lines.push(`${centers.size > 1 ? `${centers.size}× ` : ""}Ø${len(diameter)}`);
  }
  const u = unit2(sub2(at, c));
  const rim = add2(c, mul2(u, r));
  list.line(rim, at, { width: THIN, layer: "dimension" });
  list.arrow(rim, mul2(u, -1));
  const right = u[0] >= 0;
  const width = Math.max(...lines.map((l) => l.length)) * 2.1;
  list.line(at, [at[0] + (right ? width : -width), at[1]], { width: THIN, layer: "dimension" });
  lines.forEach((l, i) => list.text([at[0] + (right ? 1 : -1), at[1] - 1.2 + i * 4.6], l, TEXT, right ? "start" : "end"));
}

// ---------------------------------------------------------------------------
// Annotations
function annotation(
  list: DisplayList,
  doc: Document,
  sheet: DrawingSheet,
  a: DrawingAnnotation,
  transforms: Map<string, ViewTransform>,
  topo: TopologyLookup,
  geometry: Geometry,
) {
  const where = (view: string, ref: { id: string; bodyId: string }) => {
    const t = transforms.get(view),
      tp = topo.get(ref.id);
    if (!t || !tp) throw Error("Drawing annotation no longer resolves; reselect the geometry");
    return { t, tp, p: t.sheet(tp.center, tp.bodyId) };
  };
  switch (a.type) {
    case "note": {
      const lines = a.text.split(/\n/);
      lines.forEach((l, i) => list.text([a.position[0], a.position[1] + i * (a.size ?? TEXT) * 1.45], l, a.size ?? TEXT, "start"));
      if (a.leader) {
        const { p } = where(a.leader.view, a.leader.ref);
        const start: Vec2 = [a.position[0] - 1.5, a.position[1] - (a.size ?? TEXT) * 0.35];
        list.line(start, p, solid());
        list.arrow(p, sub2(p, start));
      }
      return;
    }
    case "balloon": {
      const { p } = where(a.view, a.ref);
      const item = a.item ?? bomItems(doc, sheet, geometry.bodies).find((x) => x.bodyIds.includes(a.ref.bodyId))?.item ?? 1;
      const r = 4.5;
      const u = unit2(sub2(p, a.position));
      list.line(add2(a.position, mul2(u, r)), p, solid());
      list.circle(p, 0.6, { width: THIN, fill: "#1E1E1E", layer: "annotation" });
      list.circle(a.position, r, solid(0.25));
      list.text([a.position[0], a.position[1] + 1.25], String(item), TEXT, "middle");
      return;
    }
    case "bom": {
      const rows = bomItems(doc, sheet, geometry.bodies);
      const cols = [12, 70, 14, 40];
      const head = ["ITEM", "PART", "QTY", "MATERIAL"];
      const rowH = 6;
      const total = cols.reduce((s, c) => s + c, 0);
      const h = rowH * (rows.length + 1);
      // The table stays inside the frame wherever it is placed.
      const { width, height } = sheetDimensions(sheet);
      const x = Math.max(MARGIN + 1, Math.min(a.position[0], width - MARGIN - 1 - total)),
        top = Math.max(MARGIN + 1, Math.min(a.position[1], height - MARGIN - 1 - h));
      list.rect(x, top, total, h, solid(0.3));
      for (let i = 1; i <= rows.length; i++) list.line([x, top + i * rowH], [x + total, top + i * rowH], solid());
      let cx = x;
      cols.slice(0, -1).forEach((c) => {
        cx += c;
        list.line([cx, top], [cx, top + h], solid());
      });
      const cell = (row: number, col: number, text: string, bold = false) => {
        const x0 = x + cols.slice(0, col).reduce((s, c) => s + c, 0);
        list.text([col === 1 || col === 3 ? x0 + 1.5 : x0 + cols[col] / 2, top + row * rowH + 4.2], text, row === 0 ? 2.5 : 3, col === 1 || col === 3 ? "start" : "middle", 0, bold);
      };
      head.forEach((t, i) => cell(0, i, t, true));
      rows.forEach((r, i) => {
        cell(i + 1, 0, String(r.item));
        cell(i + 1, 1, r.name);
        cell(i + 1, 2, String(r.quantity));
        cell(i + 1, 3, r.material ?? sheet.material ?? "");
      });
      return;
    }
    case "centermark": {
      const { tp, t } = where(a.view, a.ref);
      if (!tp.radius) throw Error("Center marks need a circular edge");
      centerMark(list, t.sheet(tp.center, tp.bodyId), tp.radius * t.scale);
      return;
    }
    case "centerline": {
      const t = transforms.get(a.view);
      const [e1, e2] = a.refs.map((r) => topo.get(r.id));
      if (!t || !e1?.endpoints || !e2?.endpoints) throw Error("Centerlines need two straight edges");
      const p0 = mul2(add2(t.sheet(e1.endpoints[0], e1.bodyId), t.sheet(e2.endpoints[0], e2.bodyId)), 0.5);
      let p1 = mul2(add2(t.sheet(e1.endpoints[1], e1.bodyId), t.sheet(e2.endpoints[1], e2.bodyId)), 0.5);
      // Pair the closer endpoints.
      const alt = mul2(add2(t.sheet(e1.endpoints[0], e1.bodyId), t.sheet(e2.endpoints[1], e2.bodyId)), 0.5);
      if (len2(sub2(alt, p0)) > len2(sub2(p1, p0))) p1 = mul2(add2(t.sheet(e1.endpoints[1], e1.bodyId), t.sheet(e2.endpoints[0], e2.bodyId)), 0.5);
      const u = unit2(sub2(p1, p0));
      list.line(sub2(p0, mul2(u, 3)), add2(p1, mul2(u, 3)), { width: THIN, dash: [6, 1.2, 1.2, 1.2], layer: "center" });
      return;
    }
    case "surface": {
      const { p } = where(a.view, a.ref);
      const o = a.position;
      list.line(p, o, solid());
      list.poly([[o[0] - 3, o[1] - 3], [o[0], o[1] + 2], [o[0] + 6, o[1] - 8], [o[0] + 16, o[1] - 8]], solid(0.25));
      list.text([o[0] + 9, o[1] - 9.5], a.roughness, 2.8, "middle");
      return;
    }
    case "datum": {
      const { p } = where(a.view, a.ref);
      const o = a.position;
      list.line(p, [o[0], o[1] + 3.5], solid());
      list.path([["M", p[0] - 2, p[1]], ["L", p[0] + 2, p[1]], ["L", p[0], p[1] - 2.8], ["Z"]], { width: THIN, fill: "#1E1E1E", layer: "annotation" });
      list.rect(o[0] - 3.5, o[1] - 3.5, 7, 7, solid(0.25));
      list.text([o[0], o[1] + 1.3], a.label, TEXT, "middle");
      return;
    }
    case "weld": {
      // AWS A2.4: the arrow meets the reference line at the knee; the fillet
      // triangle (perpendicular leg on the left) hangs below for the arrow side.
      const { p, tp } = where(a.view, a.ref);
      const knee = a.position,
        s = knee[0] >= p[0] ? 1 : -1,
        reach = 24,
        end: Vec2 = [knee[0] + s * reach, knee[1]];
      list.line(p, knee, solid());
      list.arrow(p, sub2(p, knee));
      list.line(knee, end, solid());
      const welds = doc.features.filter((f) => f.type === "weld" && !f.suppressed && f.bodyId === tp.bodyId);
      const bead = welds.find((f) => f.id === tp.featureId) ?? (new Set(welds.map((f) => f.params.size)).size === 1 ? welds[0] : undefined);
      const leg = a.leg ?? (bead?.params.size as number | undefined);
      const h = 3,
        x0 = knee[0] + (s * reach) / 2 - h / 2;
      const fillet = (below: boolean) => {
        const y = knee[1],
          v = below ? h : -h,
          baseline = below ? y + h - 0.1 : y - 0.8;
        list.poly([[x0, y], [x0, y + v], [x0 + h, y]], solid(0.25), true);
        if (leg !== undefined) list.text([x0 - 0.8, baseline], len(leg), 3, "end");
        if (a.length !== undefined) list.text([x0 + h + 0.8, baseline], len(a.length), 3, "start");
      };
      const sides = a.sides ?? "arrow";
      if (sides !== "other") fillet(true);
      if (sides !== "arrow") fillet(false);
      if (a.allAround) list.circle(knee, 1.6, solid(0.25));
      if (a.field) {
        // Field weld: a flag on a staff at the knee, pointing toward the tail.
        list.line(knee, [knee[0], knee[1] - 5.5], solid(0.25));
        list.path([["M", knee[0], knee[1] - 5.5], ["L", knee[0] + s * 3.2, knee[1] - 4.6], ["L", knee[0], knee[1] - 3.7], ["Z"]], { width: THIN, fill: "#1E1E1E", layer: "annotation" });
      }
      if (a.process) {
        list.line(end, [end[0] + s * 2.5, end[1] - 2.5], solid());
        list.line(end, [end[0] + s * 2.5, end[1] + 2.5], solid());
        list.text([end[0] + s * 3.5, end[1] + 1.1], a.process, 3, s > 0 ? "start" : "end");
      }
      return;
    }
    case "gdt": {
      const { p } = where(a.view, a.ref);
      const o = a.position;
      const cells = [8, 4 + `${a.diametral ? "Ø" : ""}${len(a.tolerance, 3)}`.length * 2.1, ...(a.datums ?? []).map(() => 7)];
      const h = 7;
      const total = cells.reduce((s, c) => s + c, 0);
      list.rect(o[0], o[1] - h / 2, total, h, solid(0.25));
      let x = o[0];
      cells.slice(0, -1).forEach((c) => {
        x += c;
        list.line([x, o[1] - h / 2], [x, o[1] + h / 2], solid());
      });
      gdtSymbol(list, a.characteristic, [o[0] + 4, o[1]]);
      list.text([o[0] + cells[0] + cells[1] / 2, o[1] + 1.2], `${a.diametral ? "Ø" : ""}${len(a.tolerance, 3)}`, 3, "middle");
      let dx = o[0] + cells[0] + cells[1];
      for (const datum of a.datums ?? []) {
        list.text([dx + 3.5, o[1] + 1.2], datum, 3, "middle");
        dx += 7;
      }
      list.line([o[0], o[1]], p, solid());
      list.arrow(p, sub2(p, o));
      return;
    }
  }
}
function gdtSymbol(list: DisplayList, kind: string, c: Vec2) {
  const s = solid(0.25);
  const [x, y] = c;
  switch (kind) {
    case "flatness":
      list.poly([[x - 2.5, y + 1.2], [x - 1.2, y - 1.2], [x + 2.5, y - 1.2], [x + 1.2, y + 1.2]], s, true);
      break;
    case "straightness":
      list.line([x - 2.5, y], [x + 2.5, y], s);
      break;
    case "circularity":
      list.circle(c, 2, s);
      break;
    case "cylindricity":
      list.circle(c, 1.6, s);
      list.line([x - 2.6, y + 2.2], [x - 0.6, y - 2.2], s);
      list.line([x + 0.6, y + 2.2], [x + 2.6, y - 2.2], s);
      break;
    case "parallelism":
      list.line([x - 2, y + 2], [x - 0.5, y - 2], s);
      list.line([x + 0.5, y + 2], [x + 2, y - 2], s);
      break;
    case "perpendicularity":
      list.line([x - 2.5, y + 2], [x + 2.5, y + 2], s);
      list.line([x, y + 2], [x, y - 2.5], s);
      break;
    case "angularity":
      list.poly([[x + 2.5, y + 2], [x - 2.5, y + 2], [x + 2.2, y - 2]], s);
      break;
    case "position":
      list.circle(c, 1.6, s);
      list.line([x - 2.6, y], [x + 2.6, y], s);
      list.line([x, y - 2.6], [x, y + 2.6], s);
      break;
    case "concentricity":
      list.circle(c, 2.2, s);
      list.circle(c, 1.1, s);
      break;
    case "symmetry":
      list.line([x - 2.5, y - 1.5], [x + 2.5, y - 1.5], s);
      list.line([x - 1.5, y], [x + 1.5, y], s);
      list.line([x - 2.5, y + 1.5], [x + 2.5, y + 1.5], s);
      break;
    case "profile":
      list.arc(c, 2.2, Math.PI, 2 * Math.PI, s);
      break;
    case "runout":
      list.line([x - 2, y + 2], [x + 2, y - 2], s);
      list.arrow([x + 2, y - 2], [1, -1], 1.6);
      break;
  }
}
export function bomItems(doc: Document, sheet: DrawingSheet, bodies: Geometry["bodies"] = []): { item: number; name: string; bodyIds: string[]; quantity: number; material?: string }[] {
  const components = allComponents(doc).filter((c) => sheet.bodyIds.some((id) => componentOwns(c, id)));
  if (components.length) {
    // Instances of one inserted part, and components with identical names, are one item.
    const groups = new Map<string, { name: string; bodyIds: string[]; quantity: number; material?: string }>();
    for (const c of components) {
      const key = c.source ? `part:${c.source.documentId}` : `name:${c.name}`;
      const part = c.source && doc.linked?.[c.source.documentId];
      // A generated belt is ordered by its current size.
      const name = (part && part.name) || (c.belt && bodies.find((b) => b.id === `${c.id}/belt`)?.name) || c.name;
      const material = (part ? part.material?.name : doc.material?.name) || undefined;
      const g = groups.get(key) ?? { name, bodyIds: [], quantity: 0, ...(material ? { material } : {}) };
      g.bodyIds.push(...sheet.bodyIds.filter((id) => componentOwns(c, id)));
      g.quantity++;
      groups.set(key, g);
    }
    return [...groups.values()].map((g, i) => ({ item: i + 1, ...g }));
  }
  return doc.bodies
    .filter((b) => sheet.bodyIds.includes(b.id))
    .map((b, i) => ({ item: i + 1, name: b.name, bodyIds: [b.id], quantity: 1, ...(doc.material ? { material: doc.material.name } : {}) }));
}

// ---------------------------------------------------------------------------
// Frame, zones and title block
function frame(list: DisplayList, doc: Document, sheet: DrawingSheet) {
  const { width, height } = sheetDimensions(sheet);
  const m = MARGIN;
  list.rect(m, m, width - 2 * m, height - 2 * m, { width: 0.5, layer: "border" });
  // Zones every ~50 mm: numbers across, letters down.
  const cols = Math.max(2, Math.round((width - 2 * m) / 50)),
    rows = Math.max(2, Math.round((height - 2 * m) / 50));
  const zw = (width - 2 * m) / cols,
    zh = (height - 2 * m) / rows;
  for (let i = 0; i <= cols; i++) {
    const x = m + i * zw;
    if (i > 0 && i < cols) {
      list.line([x, m], [x, m - 4], solid(0.25));
      list.line([x, height - m], [x, height - m + 4], solid(0.25));
    }
    if (i < cols) {
      list.text([x + zw / 2, m - 3], String(i + 1), 2.5);
      list.text([x + zw / 2, height - m + 6.5], String(i + 1), 2.5);
    }
  }
  for (let j = 0; j <= rows; j++) {
    const y = m + j * zh;
    if (j > 0 && j < rows) {
      list.line([m, y], [m - 4, y], solid(0.25));
      list.line([width - m, y], [width - m + 4, y], solid(0.25));
    }
    if (j < rows) {
      const letter = String.fromCharCode(65 + j);
      list.text([m - 5, y + zh / 2 + 1], letter, 2.5);
      list.text([width - m + 5, y + zh / 2 + 1], letter, 2.5);
    }
  }
  // Title block.
  const tb = titleBlockBounds(sheet);
  const { x, y, w, h } = tb;
  list.rect(x, y, w, h, { width: 0.5, layer: "border" });
  const k = w / TITLE_W;
  const vx = (v: number) => x + v * k;
  const r1 = y + 12,
    r2 = y + 20,
    r3 = y + 28;
  list.line([x, r1], [x + w, r1], solid(0.25));
  list.line([x, r2], [x + w, r2], solid(0.25));
  list.line([x, r3], [x + w, r3], solid(0.25));
  list.line([vx(100), y], [vx(100), y + h], solid(0.25));
  list.line([vx(160), y], [vx(160), r1], solid(0.25));
  list.line([vx(125), r1], [vx(125), r2], solid(0.25));
  list.line([vx(145), r1], [vx(145), r2], solid(0.25));
  list.line([vx(50), r1], [vx(50), r3], solid(0.25));
  list.line([vx(140), r2], [vx(140), y + h], solid(0.25));
  list.line([vx(50), r3], [vx(50), y + h], solid(0.25));
  list.line([vx(155), r3], [vx(155), y + h], solid(0.25));
  const cell = (cx: number, cy: number, label: string, value: string, size = 3, bold = false) => {
    list.text([vx(cx) + 1.2, cy + 2.4], label, 1.8, "start");
    if (value) list.text([vx(cx) + 1.2, cy + (size > 4 ? 9.5 : 6.6)], value, size, "start", 0, bold);
  };
  cell(0, y, "TITLE", sheet.title || doc.name, 5, true);
  cell(100, y, "DRAWING NO.", sheet.drawingNumber || "", 3.5, true);
  cell(160, y, "REV", sheet.revisionLabel || "", 3.5);
  cell(0, r1, "MATERIAL", sheet.material || doc.material?.name || "", 3);
  cell(50, r1, "FINISH", sheet.finish || "", 3);
  cell(100, r1, "SCALE", ratio(sheet.scale), 3);
  cell(125, r1, "SIZE", sheet.size, 3);
  cell(145, r1, "SHEET", `${(doc.drawings ?? []).findIndex((d) => d.id === sheet.id) + 1} / ${(doc.drawings ?? []).length || 1}`, 3);
  cell(0, r2, "DRAWN", sheet.author || "", 3);
  cell(50, r2, "DATE", sheet.date || "", 3);
  cell(100, r2, "CHECKED", sheet.checkedBy || "", 3);
  cell(140, r2, "APPROVED", sheet.approvedBy || "", 3);
  cell(0, r3, "TOLERANCES", sheet.generalTolerance || (doc.units === "in" ? ".XX ±.01  .XXX ±.005 · in" : "ISO 2768-m · mm"), 2.5);
  cell(50, r3, "COMPANY", sheet.company || "", 2.8);
  cell(140, r3, sheet.projection === "first" ? "1ST ANGLE" : "3RD ANGLE", "", 2.5);
  projectionSymbol(list, [vx(155) + (25 * k) / 2 - 1, r3 + 4.4], sheet.projection);
}
function projectionSymbol(list: DisplayList, c: Vec2, projection: "first" | "third") {
  const s = solid(0.25);
  // Truncated cone: side view (trapezoid) and end view (two circles).
  const cone = (x: number) => list.poly([[x - 3, c[1] - 1.2], [x + 3, c[1] - 2.4], [x + 3, c[1] + 2.4], [x - 3, c[1] + 1.2]], s, true);
  const ends = (x: number) => {
    list.circle([x, c[1]], 2.4, s);
    list.circle([x, c[1]], 1.2, s);
  };
  if (projection === "third") {
    cone(c[0] - 4.5);
    ends(c[0] + 5);
  } else {
    ends(c[0] - 5);
    cone(c[0] + 4.5);
  }
}
export type { Composed };
/** Reject layouts whose views leave the drawing border. */
export function assertViewsFit(sheet: DrawingSheet, views: DrawingProjection[]) {
  const { width, height } = sheetDimensions(sheet);
  for (const v of views) {
    const [x, y, w, h] = v.bounds;
    if (x < MARGIN - 0.5 || y < MARGIN - 0.5 || x + w > width - MARGIN + 0.5 || y + h > height - MARGIN + 0.5)
      throw Error(`Drawing views do not fit the sheet at this scale: ${v.label ?? v.name} leaves the border. Use a smaller scale, a larger sheet, or move the view.`);
  }
}
