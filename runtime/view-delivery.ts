import { randomUUID } from "node:crypto";
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
  Map<string, { expires: number; chunks: string[] }>
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
  if (data.length > 64 * 1024 * 1024)
    throw Error("CAD editor snapshot exceeds its delivery budget");
  const entries = cache(store);
  while (entries.size >= 4) entries.delete(entries.keys().next().value!);
  const token = randomUUID();
  const chunks = [];
  for (let at = 0; at < data.length; at += chunkSize)
    chunks.push(data.slice(at, at + chunkSize));
  entries.set(token, { expires: Date.now() + 5 * 60_000, chunks });
  return {
    viewChunks: {
      uriPrefix: `cad-view://${token}/`,
      count: chunks.length,
      encoding: "deflate-ndjson-base64",
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
