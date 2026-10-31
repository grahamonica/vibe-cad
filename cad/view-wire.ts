import type { RenderBody } from "./types.ts";

// Keep CAD topology and solid measurements untouched. Display buffers use the
// same float32 precision as the viewport's GPU attributes. Sending float64 here
// preserved bits the renderer immediately discarded and inflated large views.
/** One producer/consumer contract; cache limits do not define model validity. */
export const VIEW_LIMITS = {
  inlineBytes: 256 * 1024,
  compressedBytes: 32 * 1024 * 1024,
  decodedBytes: 64 * 1024 * 1024,
  recordBytes: 32 * 1024 * 1024,
  chunkBytes: 384 * 1024,
} as const;

export type WireBody = Omit<RenderBody, "mesh" | "edges"> & {
  mesh: Omit<RenderBody["mesh"], "vertices" | "normals" | "triangles"> & {
    encoding: "f32-u32-le" | "f64-u32-le";
    vertices: string | number[];
    normals: string | number[];
    triangles: string | number[];
  };
  edges: Omit<RenderBody["edges"], "lines"> & { lines: string | number[] };
};

export function packDisplayBody(
  body: RenderBody,
  base64: (bytes: Uint8Array) => string,
): WireBody {
  const pack = (values: number[], integer = false) => {
    const encodedLength = 4 * Math.ceil(values.length * 4 / 3);
    let jsonLength = values.length ? values.length + 1 : 2;
    for (const value of values) {
      if (!Number.isFinite(value)) throw Error("Invalid display coordinate");
      if (integer && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
        throw Error("Invalid display triangle index");
      if (jsonLength <= encodedLength) jsonLength += String(value).length;
    }
    // Measure numeric text without allocating a whole decimal JSON array. This
    // preserves the smaller representation for zero-heavy normals/box meshes.
    if (jsonLength <= encodedLength) return values;
    const bytes = new Uint8Array(values.length * 4);
    const data = new DataView(bytes.buffer);
    values.forEach((value, i) => {
      if (integer) data.setUint32(i * 4, value, true);
      else data.setFloat32(i * 4, value, true);
    });
    return base64(bytes);
  };
  return {
    ...body,
    mesh: {
      ...body.mesh,
      encoding: "f32-u32-le",
      vertices: pack(body.mesh.vertices),
      normals: pack(body.mesh.normals),
      triangles: pack(body.mesh.triangles, true),
    },
    edges: { ...body.edges, lines: pack(body.edges.lines) },
  };
}

export function unpackDisplayBody(body: WireBody | RenderBody): RenderBody {
  if (!("encoding" in body.mesh)) return body as RenderBody;
  const encoding = body.mesh.encoding;
  if (encoding !== "f64-u32-le" && encoding !== "f32-u32-le")
    throw Error("Unknown CAD display buffer encoding");
  const unpack = (value: string | number[], integer = false) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") throw Error("Invalid CAD display buffer");
    const binary = atob(value);
    const width = integer || encoding === "f32-u32-le" ? 4 : 8;
    if (binary.length % width) throw Error("Truncated CAD display buffer");
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const data = new DataView(bytes.buffer);
    return Array.from({ length: bytes.length / width }, (_, i) =>
      integer ? data.getUint32(i * width, true)
        : width === 4 ? data.getFloat32(i * width, true) : data.getFloat64(i * width, true),
    );
  };
  const { encoding: _, ...mesh } = body.mesh as WireBody["mesh"];
  return {
    ...body,
    mesh: {
      ...mesh,
      vertices: unpack(mesh.vertices),
      normals: unpack(mesh.normals),
      triangles: unpack(mesh.triangles, true),
    },
    edges: { ...body.edges, lines: unpack(body.edges.lines) },
  };
}
