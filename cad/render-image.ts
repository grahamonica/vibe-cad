// Pictures of the model for the assistant: a small software renderer (depth
// buffer, shading, see-through bodies, model edges) and a PNG encoder, so a
// view can be captured from any angle without a GPU or a screenshot.
import type { DisplayStyle, RenderBody, Vec3 } from "./types.ts";

export interface PictureCamera {
  /** From the model toward the viewer. */
  dir: Vec3;
  /** Screen right and up. */
  x: Vec3;
  y: Vec3;
}
export interface PictureOptions {
  width: number;
  height: number;
  /** Bodies framed by the picture; all drawn bodies when empty. */
  focus?: Set<string>;
  /** Whole bodies drawn in another color. */
  tint?: Map<string, string>;
  /** Faces and edges (topology ids) drawn in another color. */
  faceTint?: Map<string, string>;
  edgeTint?: Map<string, string>;
  /** Bodies drawn see-through, whatever their own opacity. */
  ghost?: Set<string>;
  background?: string;
  /** The view's display style; a body's own display mode wins. */
  style?: DisplayStyle;
}
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  const n = m ? parseInt(m[1], 16) : 0x544841;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Render bodies (as placed) to RGBA pixels, looking along -camera.dir. */
export function renderPicture(bodies: RenderBody[], camera: PictureCamera, o: PictureOptions) {
  const ss = 2,
    W = o.width * ss,
    H = o.height * ss;
  const shown = bodies.filter((b) => !b.hidden);
  // Frame the focused bodies (or all) with a margin.
  let u0 = Infinity,
    u1 = -Infinity,
    v0 = Infinity,
    v1 = -Infinity,
    d0 = Infinity,
    d1 = -Infinity;
  for (const b of shown) {
    const framed = !o.focus?.size || o.focus.has(b.id);
    const vs = b.mesh.vertices;
    for (let i = 0; i < vs.length; i += 3) {
      const p = [vs[i], vs[i + 1], vs[i + 2]];
      const d = dot(p, camera.dir);
      d0 = Math.min(d0, d);
      d1 = Math.max(d1, d);
      if (!framed) continue;
      const u = dot(p, camera.x),
        v = dot(p, camera.y);
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
  }
  if (!Number.isFinite(u0)) u0 = v0 = d0 = -1, u1 = v1 = d1 = 1;
  const margin = 0.07,
    k = Math.min((W * (1 - 2 * margin)) / Math.max(1e-9, u1 - u0), (H * (1 - 2 * margin)) / Math.max(1e-9, v1 - v0));
  const uc = (u0 + u1) / 2,
    vc = (v0 + v1) / 2;
  const project = (p: ArrayLike<number>): [number, number, number] => [(dot(p, camera.x) - uc) * k + W / 2, H / 2 - (dot(p, camera.y) - vc) * k, dot(p, camera.dir)];
  const zbuf = new Float32Array(W * H).fill(-Infinity);
  const bg = hex(o.background ?? "#FFFFFF");
  const rgb = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) rgb.set(bg, i * 3);
  // A key light from the viewer, a little above and to the right.
  const L = [0, 1, 2].map((i) => camera.dir[i] * 0.8 + camera.y[i] * 0.45 + camera.x[i] * 0.25);
  const ll = Math.hypot(...L);
  const light = L.map((x) => x / ll);
  const shade = (n: ArrayLike<number>) => 0.34 + 0.66 * Math.abs(dot(n, light));
  type Tri = { p: [number, number, number][]; i: [number, number, number]; color: [number, number, number]; alpha: number };
  const opaque: Tri[] = [],
    clear: Tri[] = [];
  const styleOf = (b: RenderBody) => b.style ?? o.style ?? "shaded-edges";
  for (const b of shown) {
    const style = styleOf(b);
    // Wireframe draws no faces; hidden-line styles draw them flat white.
    if (style === "wireframe") continue;
    const flat = style === "hidden-removed" || style === "hidden-visible";
    const vs = b.mesh.vertices,
      ns = b.mesh.normals,
      tris = b.mesh.triangles;
    // A highlighted body stands out even when it is see-through.
    const base = hex(o.tint?.get(b.id) ?? (flat ? "#FFFFFF" : b.color)),
      opacity = flat ? 1 : (b.opacity ?? 1),
      alpha = o.ghost?.has(b.id) ? Math.min(opacity, 0.28) : o.tint?.has(b.id) ? Math.max(opacity, 0.85) : opacity;
    // Faces drawn in another color, by triangle index range.
    const faceColor = new Map<number, [number, number, number]>();
    if (o.faceTint?.size)
      for (const g of b.mesh.faceGroups) {
        const c = o.faceTint.get(g.id);
        if (c) for (let t = g.start; t < g.start + g.count; t += 3) faceColor.set(t, hex(c));
      }
    for (let t = 0; t < tris.length; t += 3) {
      const idx = [tris[t], tris[t + 1], tris[t + 2]];
      const tri: Tri = {
        p: idx.map((j) => project([vs[j * 3], vs[j * 3 + 1], vs[j * 3 + 2]])),
        i: idx.map((j) => (flat && !faceColor.has(t) && !o.tint?.has(b.id) ? 1 : shade([ns[j * 3], ns[j * 3 + 1], ns[j * 3 + 2]]))) as [number, number, number],
        color: faceColor.get(t) ?? base,
        alpha: faceColor.has(t) ? Math.max(alpha, 0.85) : alpha,
      };
      (tri.alpha >= 0.999 ? opaque : clear).push(tri);
    }
  }
  const raster = (tri: Tri, blend: boolean) => {
    const [a, b, c] = tri.p;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-12) return;
    const xmin = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))),
      xmax = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0]))),
      ymin = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))),
      ymax = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = ymin; y <= ymax; y++)
      for (let x = xmin; x <= xmax; x++) {
        const px = x + 0.5,
          py = y + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area,
          w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area,
          w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2],
          at = y * W + x;
        if (z <= zbuf[at]) continue;
        const light = w0 * tri.i[0] + w1 * tri.i[1] + w2 * tri.i[2];
        for (let k = 0; k < 3; k++) {
          const v = Math.min(255, tri.color[k] * light + 18 * light);
          rgb[at * 3 + k] = blend ? rgb[at * 3 + k] * (1 - tri.alpha) + v * tri.alpha : v;
        }
        if (!blend) zbuf[at] = z;
      }
  };
  for (const tri of opaque) raster(tri, false);
  // See-through bodies, farthest first, over what is solid behind them.
  clear.sort((p, q) => p.p[0][2] + p.p[1][2] + p.p[2][2] - (q.p[0][2] + q.p[1][2] + q.p[2][2]));
  for (const tri of clear) raster(tri, true);
  // Model edges in front: drawn where nothing solid is nearer.
  const eps = Math.max(1e-6, (d1 - d0) * 0.004);
  const ink = hex("#1E1E1E"),
    slate = hex("#70798C");
  /** `hidden` draws the parts behind a face dashed in slate (Hidden Lines Visible). */
  const line = (p: [number, number, number], q: [number, number, number], color: [number, number, number], width: number, strength: number, hidden = false) => {
    const n = Math.ceil(Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1]))) + 1;
    for (let s = 0; s <= n; s++) {
      const t = s / n,
        x = p[0] + (q[0] - p[0]) * t,
        y = p[1] + (q[1] - p[1]) * t,
        z = p[2] + (q[2] - p[2]) * t;
      for (let dy = -width; dy <= width; dy++)
        for (let dx = -width; dx <= width; dx++) {
          const X = Math.round(x + dx),
            Y = Math.round(y + dy);
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const at = Y * W + X;
          if (z < zbuf[at] - eps) {
            if (!hidden || s % (5 * ss) >= 3 * ss) continue;
            for (let k = 0; k < 3; k++) rgb[at * 3 + k] = rgb[at * 3 + k] * 0.2 + slate[k] * 0.8;
            continue;
          }
          for (let k = 0; k < 3; k++) rgb[at * 3 + k] = rgb[at * 3 + k] * (1 - strength) + color[k] * strength;
        }
    }
  };
  for (const b of shown) {
    const style = styleOf(b),
      lines = b.edges.lines,
      alpha = o.ghost?.has(b.id) ? 0.25 : (b.opacity ?? 1) < 1 && style !== "hidden-removed" && style !== "hidden-visible" ? 0.4 : 0.9;
    for (const g of b.edges.edgeGroups) {
      const tint = o.edgeTint?.get(g.id);
      // Shaded draws no edges, except highlighted ones.
      if (style === "shaded" && !tint) continue;
      for (let i = g.start; i + 1 < g.start + g.count; i += 2)
        line(project([lines[i * 3], lines[i * 3 + 1], lines[i * 3 + 2]]), project([lines[i * 3 + 3], lines[i * 3 + 4], lines[i * 3 + 5]]), tint ? hex(tint) : ink, tint ? 2 : 0, tint ? 1 : alpha, style === "hidden-visible");
    }
  }
  // Average each 2 × 2 block.
  const out = new Uint8Array(o.width * o.height * 4);
  for (let y = 0; y < o.height; y++)
    for (let x = 0; x < o.width; x++) {
      for (let k = 0; k < 3; k++) {
        let sum = 0;
        for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) sum += rgb[((y * ss + dy) * W + x * ss + dx) * 3 + k];
        out[(y * o.width + x) * 4 + k] = Math.round(sum / (ss * ss));
      }
      out[(y * o.width + x) * 4 + 3] = 255;
    }
  return out;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** RGBA pixels as a PNG file; `deflate` makes the zlib stream. */
export async function encodePng(width: number, height: number, rgba: Uint8Array, deflate: (data: Uint8Array) => Promise<Uint8Array>) {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length),
      view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13),
    hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) png.set(p, at), (at += p.length);
  return png;
}
/** Bytes as base64, without Buffer (the editor runs this too). */
export function base64(bytes: Uint8Array) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += abc[a >> 2] + abc[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? abc[((b & 15) << 2) | (c >> 6)] : "=") + (i + 2 < bytes.length ? abc[c & 63] : "=");
  }
  return out;
}
