import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../cad/store.ts";
import type { View } from "../cad/types.ts";

// Large vendor assemblies cannot fit in one MCP message. Pin the exact result
// snapshot and deliver it losslessly through bounded, app-readable resources.
const caches = new WeakMap<
  Store,
  Map<string, { expires: number; chunks: string[]; bytes: number; lease: number }>
>();
const chunkSize = 512 * 1024;
function cache(store: Store) {
  let entries = caches.get(store);
  if (!entries) caches.set(store, (entries = new Map()));
  for (const [id, entry] of entries)
    if (entry.expires < Date.now()) entries.delete(id);
  return entries;
}
export function deliverView(store: Store, view: View): Record<string, unknown> {
  const json = JSON.stringify(view);
  if (Buffer.byteLength(json) <= 256 * 1024) return { view };
  const header = { ...view, geometry: { ...view.geometry, bodies: [] } };
  const records =
    [
      JSON.stringify({
        type: "header",
        view: header,
        bodyCount: view.geometry.bodies.length,
      }),
      ...view.geometry.bodies.map((body) =>
        JSON.stringify({ type: "body", body }),
      ),
      JSON.stringify({ type: "complete" }),
    ].join("\n") + "\n";
  const data = deflateSync(records).toString("base64");
  if (data.length * 2 > 32 * 1024 * 1024)
    throw Error("CAD editor snapshot exceeds its delivery budget");
  const entries = cache(store);
  const token = createHash('sha256').update(data).digest('hex');
  const existing = entries.get(token);
  if (existing) existing.expires = Date.now() + 15 * 60_000;
  let total = [...entries.values()].reduce((n, e) => n + e.bytes, 0);
  for (const [id, entry] of entries) {
    if (entries.size < 8 && total + (existing ? 0 : data.length * 2) <= 32 * 1024 * 1024) break;
    if (id === token || entry.lease > Date.now()) continue;
    entries.delete(id); total -= entry.bytes;
  }
  if (!existing && (entries.size >= 8 || total + data.length * 2 > 32 * 1024 * 1024)) throw Error('Too many models loading at once; wait for the active model or close inactive editor panels');
  const chunks = [];
  for (let at = 0; at < data.length; at += chunkSize)
    chunks.push(data.slice(at, at + chunkSize));
  if (!existing) entries.set(token, { expires: Date.now() + 15 * 60_000, chunks, bytes: data.length * 2, lease: 0 });
  return {
    viewChunks: {
      uriPrefix: `cad-view://${token}/`,
      count: chunks.length,
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
        index >= entry.chunks.length
      ) {
        throw Error(
          "CAD editor snapshot is unavailable; reopen the current document",
        );
      }
      entry.expires = Date.now() + 15 * 60_000;
      entry.lease = index === entry.chunks.length - 1 ? 0 : Date.now() + 30_000;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              index,
              count: entry.chunks.length,
              data: entry.chunks[index],
            }),
          },
        ],
      };
    },
  );
}
