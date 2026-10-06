// Procedural appearance textures: grayscale patterns that tint the body's
// color, drawn once on a canvas and tiled. Each tile wraps seamlessly.
import type { Texture } from "../../cad/types.ts";
import { textureInfo } from "../../cad/appearance.ts";

const SIZE = 512;

/** Deterministic random numbers, so a texture looks the same every time. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Smooth value noise repeating every `period` lattice cells on both axes. */
function periodicNoise(period: number, seed: number) {
  const rand = random(seed),
    lattice = Array.from({ length: period * period }, rand);
  const at = (i: number, j: number) => lattice[((j % period) + period) % period * period + (((i % period) + period) % period)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const i = Math.floor(x),
      j = Math.floor(y),
      u = smooth(x - i),
      v = smooth(y - j);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * u,
      b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
    return a + (b - a) * v;
  };
}
/** Fill a canvas from a function giving the brightness (0 … 1) at each pixel. */
function paint(shade: (x: number, y: number) => number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!,
    image = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const v = Math.round(255 * Math.max(0, Math.min(1, shade(x, y)))),
        at = (y * SIZE + x) * 4;
      image.data[at] = image.data[at + 1] = image.data[at + 2] = v;
      image.data[at + 3] = 255;
    }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function brushedMetal() {
  // Fine streaks along x: each row has its own brightness, blurred a little across rows.
  const rand = random(11),
    rows = Array.from({ length: SIZE }, rand),
    streak = rows.map((_, y) => (rows[(y + SIZE - 1) % SIZE] + 2 * rows[y] + rows[(y + 1) % SIZE]) / 4);
  const drift = periodicNoise(8, 12),
    grain = random(13);
  return { color: paint((x, y) => 0.72 + 0.2 * streak[y] + 0.06 * drift((x / SIZE) * 8, (y / SIZE) * 64) + 0.03 * (grain() - 0.5)) };
}

function carbonFiber() {
  // 2 × 2 twill: eight tows per tile, each crossing over two and under two.
  const tows = 8,
    cell = SIZE / tows,
    fibers = random(21),
    lines = Array.from({ length: SIZE }, () => fibers());
  return {
    color: paint((x, y) => {
      const i = Math.floor(x / cell),
        j = Math.floor(y / cell),
        warp = (i + j) % 4 < 2;
      // Across the tow it rounds over like a cylinder; fibers run along it.
      const across = warp ? (x % cell) / cell : (y % cell) / cell,
        along = warp ? y : x;
      const round = Math.sin(Math.PI * across) ** 0.7;
      return 0.3 + 0.62 * round * (warp ? 1 : 0.82) + 0.06 * (lines[warp ? x : y] - 0.5) + 0.02 * Math.sin(along * 0.9);
    }),
  };
}

function diamondPlate() {
  // Raised lozenges on a 2 × 2 grid, alternating ±45° as on tread plate.
  const cells = 2,
    cell = SIZE / cells,
    length = cell * 0.42,
    width = cell * 0.075;
  const height = (x: number, y: number) => {
    const i = Math.floor(x / cell),
      j = Math.floor(y / cell),
      cx = (x % cell) - cell / 2,
      cy = (y % cell) - cell / 2,
      s = (i + j) % 2 ? 1 : -1;
    const u = (cx + s * cy) / Math.SQRT2,
      v = (cx - s * cy) / Math.SQRT2;
    const t = u / length;
    if (Math.abs(t) >= 1) return 0;
    const half = width * (1 - t * t),
      d = Math.abs(v) / half;
    return d >= 1 ? 0 : Math.min(1, (1 - d) * 3);
  };
  const speckle = random(31);
  return {
    color: paint((x, y) => 0.8 + 0.14 * height(x, y) + 0.04 * (speckle() - 0.5)),
    height: paint((x, y) => height(x, y)),
  };
}

function wood() {
  // Long grain along x: growth lines bent by low-frequency noise.
  const bend = periodicNoise(4, 41),
    fine = periodicNoise(32, 42);
  return {
    color: paint((x, y) => {
      const u = x / SIZE,
        w = y / SIZE;
      const ring = w * 14 + 1.6 * bend(u * 4, w * 4) + 0.15 * fine(u * 8, w * 32);
      const phase = ring - Math.floor(ring);
      // Light early wood, a narrow darker late-wood line.
      const late = phase > 0.78 ? Math.sin(((phase - 0.78) / 0.22) * Math.PI) : 0;
      return 0.86 - 0.24 * late + 0.06 * (fine(u * 32, w * 8) - 0.5);
    }),
  };
}

const makers: Record<Texture, () => { color: HTMLCanvasElement; height?: HTMLCanvasElement }> = {
  "brushed-metal": brushedMetal,
  "carbon-fiber": carbonFiber,
  "diamond-plate": diamondPlate,
  wood,
};
const drawn = new Map<Texture, { color: HTMLCanvasElement; height?: HTMLCanvasElement }>();
/** The texture's pattern (and relief), drawn once per page. */
export function textureCanvases(id: Texture) {
  let canvases = drawn.get(id);
  if (!canvases) drawn.set(id, (canvases = makers[id]()));
  return canvases;
}
const swatches = new Map<string, string>();
/** A small picture of the texture in a color, for appearance pickers. */
export function textureSwatch(id: Texture, color = textureInfo(id).color, size = 48) {
  const key = `${id}:${color}:${size}`;
  let url = swatches.get(key);
  if (!url) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = "multiply";
    // About one repeat of the pattern, so its scale reads.
    ctx.drawImage(textureCanvases(id).color, 0, 0, SIZE / 2, SIZE / 2, 0, 0, size, size);
    swatches.set(key, (url = canvas.toDataURL()));
  }
  return url;
}
