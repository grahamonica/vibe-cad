import { createHash } from "node:crypto";
import { createDeflate } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../cad/store.ts";
import type { View } from "../cad/types.ts";
import { packDisplayBody, VIEW_LIMITS } from "../cad/view-wire.ts";

// Large vendor assemblies cannot fit in one MCP message. Pin the exact result
// snapshot and deliver display-precision meshes through bounded, app-readable resources.
const caches = new WeakMap<
  Store,
  Map<string, { expires: number; data: Buffer; bytes: number; lease: number }>
>();
// A multiple of three makes independently encoded slices concatenate into the
// existing base64 stream. Retain compressed bytes, not expanded UTF-16 strings.
const chunkBytes = VIEW_LIMITS.chunkBytes;
const deliveryBudget = VIEW_LIMITS.compressedBytes;
function cache(store: Store) {
  let entries = caches.get(store);
  if (!entries) caches.set(store, (entries = new Map()));
  for (const [id, entry] of entries)
    if (entry.expires < Date.now()) entries.delete(id);
  return entries;
}
export async function deliverView(store: Store, view: View): Promise<Record<string, unknown>> {
  const values = view.geometry.bodies.reduce((n, body) => n + body.mesh.vertices.length + body.mesh.normals.length + body.mesh.triangles.length + body.edges.lines.length, 0);
  // Do not first allocate a full decimal JSON copy of a known-large mesh.
  if (values < 32768 && Buffer.byteLength(JSON.stringify(view)) <= VIEW_LIMITS.inlineBytes) return { view };
  const header = { ...view, geometry: { ...view.geometry, bodies: [] } };
  let decodedBytes = 0;
  function record(value: unknown) {
    const text = JSON.stringify(value) + "\n";
    const bytes = Buffer.byteLength(text);
    if (bytes > VIEW_LIMITS.recordBytes) throw Error("A CAD view record exceeds its delivery budget");
    decodedBytes += bytes;
    if (decodedBytes > VIEW_LIMITS.decodedBytes) throw Error("CAD view exceeds its decoded delivery budget");
    return text;
  }
  function* records() {
    yield record({ type: "header", view: header, bodyCount: view.geometry.bodies.length });
    for (const body of view.geometry.bodies)
      yield record({ type: "body", body: packDisplayBody(body, bytes => Buffer.from(bytes).toString("base64")) });
    yield record({ type: "complete" });
  }
  // Compress one record at a time instead of allocating decimal/binary copies
  // of the entire assembly. The retained memory budget stays at 32 MiB.
  const source = Readable.from(records(), { highWaterMark: 1 });
  const stream = createDeflate();
  // pipeline propagates producer errors to the consumer and tears down both
  // streams. Plain pipe leaves generator errors as uncaught process errors.
  const finished = pipeline(source, stream).then(() => undefined, error => error);
  const blocks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const block of stream) {
      bytes += block.length;
      if (bytes > deliveryBudget)
        throw Error("CAD editor snapshot exceeds its delivery budget");
      blocks.push(block);
    }
    const error = await finished;
    if (error) throw error;
  } finally {
    source.destroy();
    stream.destroy();
    await finished;
  }
  const data = Buffer.concat(blocks, bytes);
  const entries = cache(store);
  const token = createHash('sha256').update(data).digest('hex');
  const existing = entries.get(token);
  if (existing) existing.expires = Date.now() + 15 * 60_000;
  let total = [...entries.values()].reduce((n, e) => n + e.bytes, 0);
  for (const [id, entry] of entries) {
    if (entries.size < 8 && total + (existing ? 0 : data.length) <= deliveryBudget) break;
    if (id === token || entry.lease > Date.now()) continue;
    entries.delete(id); total -= entry.bytes;
  }
  if (!existing && (entries.size >= 8 || total + data.length > deliveryBudget)) throw Error('Too many models loading at once; wait for the active model or close inactive editor panels');
  if (!existing) entries.set(token, { expires: Date.now() + 15 * 60_000, data, bytes: data.length, lease: 0 });
  return {
    viewChunks: {
      uriPrefix: `cad-view://${token}/`,
      count: Math.ceil(data.length / chunkBytes),
      compressedBytes: data.length,
      encoding: "deflate-ndjson-base64",
      documentId: view.document.id,
      revision: view.document.revision,
    },
  };
}
export function registerViewResources(server: McpServer, store: Store) {
  server.registerResource(
    "CAD editor snapshot",
    new ResourceTemplate("cad-view://{snapshot}/{chunk}", { list: undefined }),
    { mimeType: "application/json" },
    async (uri, variables) => {
      const entry = cache(store).get(String(variables.snapshot));
      const index = Number(variables.chunk);
      if (
        !entry ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= Math.ceil(entry.data.length / chunkBytes)
      ) {
        throw Error(
          "CAD editor snapshot is unavailable; reopen the current document",
        );
      }
      entry.expires = Date.now() + 15 * 60_000;
      const count = Math.ceil(entry.data.length / chunkBytes);
      entry.lease = index === count - 1 ? 0 : Date.now() + 30_000;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              index,
              count,
              data: entry.data.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
            }),
          },
        ],
      };
    },
  );
}
