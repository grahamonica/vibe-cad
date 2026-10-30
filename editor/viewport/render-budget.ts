import type { RenderBody } from '../../cad/types.ts';

// Bound framebuffer and geometry allocations before handing them to WebGL.
export function renderPixelRatio(width: number, height: number, deviceRatio = 1) {
  const w = Math.max(1, width), h = Math.max(1, height);
  return Math.min(Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1,
    1.5, Math.sqrt(2_000_000 / (w * h)), 4096 / Math.max(w, h));
}

export function assertRenderBudget(bodies: RenderBody[]) {
  let numbers = 0;
  for (const b of bodies) {
    numbers += b.mesh.vertices.length + b.mesh.normals.length + b.mesh.triangles.length + b.edges.lines.length;
  }
  // Conservative allowance for source arrays, typed attributes, picking and edge buffers.
  if (numbers * 24 > 128 * 1024 * 1024)
    throw Error('This view exceeds the viewport memory budget. Hide detailed components or reopen a smaller selection. Your saved model is unchanged.');
}
