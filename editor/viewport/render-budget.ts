import type { RenderBody } from '../../cad/types.ts';
import type { BufferGeometry } from 'three';

export const RENDER_BYTES = 128 * 1024 * 1024;

/** Count shared CPU backing stores once and each uploaded attribute once. */
export function renderMemoryBytes(bodies: RenderBody[], resources?: {
  geometries: Iterable<BufferGeometry>; buffers: Iterable<ArrayBufferView>;
}) {
  const cpu = new Set<object>(), gpu = new Set<object>();
  let bytes = 0;
  const retain = (a: number[] | ArrayBufferView) => {
    const key = ArrayBuffer.isView(a) ? a.buffer : a;
    if (cpu.has(key)) return;
    cpu.add(key);
    bytes += ArrayBuffer.isView(a) ? a.buffer.byteLength : a.length * 8;
  };
  for (const b of bodies) {
    for (const a of [b.mesh.vertices,b.mesh.normals,b.mesh.triangles,b.edges.lines]) retain(a);
    // Without prepared resources this is the source-buffer preflight. Once
    // prepared, include the actual attributes before any WebGL upload.
  }
  if (resources) {
    for (const a of resources.buffers) retain(a);
    for (const geometry of resources.geometries)
      for (const attribute of [...Object.values(geometry.attributes),...(geometry.index?[geometry.index]:[])]) {
        const storage = 'data' in attribute ? attribute.data : attribute;
        retain(storage.array);
        if (!gpu.has(storage)) { gpu.add(storage); bytes += storage.array.byteLength; }
      }
  }
  return bytes;
}

// Bound framebuffer and geometry allocations before handing them to WebGL.
export function renderPixelRatio(width: number, height: number, deviceRatio = 1) {
  const w = Math.max(1, width), h = Math.max(1, height);
  return Math.min(Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1,
    1.5, Math.sqrt(2_000_000 / (w * h)), 4096 / Math.max(w, h));
}

export function assertRenderBudget(bodies: RenderBody[], resources?: Parameters<typeof renderMemoryBytes>[1]) {
  const bytes = renderMemoryBytes(bodies,resources);
  if (bytes > RENDER_BYTES)
    throw Error(`This view needs ${Math.ceil(bytes/1048576)} MiB of geometry buffers, exceeding the 128 MiB viewport memory budget. Hide detailed components or reopen a smaller selection. Your saved model is unchanged.`);
}
