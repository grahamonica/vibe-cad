// STL file facts shared by the import tool and the kernel.
/** Triangles in a binary or ASCII STL file. */
export function stlTriangleCount(bytes: Uint8Array): number {
  if (bytes.length >= 84) {
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (bytes.length === 84 + n * 50) return n;
  }
  const text = new TextDecoder().decode(bytes);
  return text.trimStart().startsWith("solid") ? (text.match(/\bfacet\s+normal\b/g)?.length ?? 0) : 0;
}
/** Largest mesh imported as a solid: each facet becomes a face before coplanar facets merge. */
export const STL_TRIANGLE_LIMIT = 60_000;
