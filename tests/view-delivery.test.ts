import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcp } from "../runtime/mcp.ts";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { deliverView } from "../runtime/view-delivery.ts";
import { closeKernel } from "../cad/geometry.ts";
test("large editor views stay below MCP message limits and retain an exact revision snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-view-delivery-")),
    store = new Store(dir);
  const server = createMcp(store),
    client = new Client({ name: "Large view test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    let view = await store.create("Transfer plate");
    const tools = toolset(store);
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name)!;
      view = (await t.handler(
        t.schema.parse({
          documentId: view.document.id,
          expectedRevision: view.document.revision,
          ...args,
        }),
        "assistant",
      )) as typeof view;
    };
    await invoke("create_sketch", { plane: "XY" });
    const sketchId = view.document.sketches[0].id;
    await invoke("add_sketch_entity", {
      sketchId,
      type: "rectangle",
      values: { x: 0, y: 0, width: 80, height: 50 },
    });
    await invoke("extrude", { sketchId, distance: 12 });
    const original = view.geometry.bodies[0].mesh.vertices;
    // Repeated unused vertices simulate a large tessellation without changing
    // solid geometry, topology references or the existing triangle indices.
    view.geometry.bodies[0].mesh.vertices = Array.from(
      { length: 4_000_000 },
      (_, i) => original[i % original.length],
    );
    assert.ok(Buffer.byteLength(JSON.stringify(view)) > 10 * 1024 * 1024);
    const meta = deliverView(store, view);
    assert.ok(Buffer.byteLength(JSON.stringify(meta)) < 1024);
    const chunks = meta.viewChunks as { uriPrefix: string; count: number };
    await invoke("set_variable", { name: "later_edit", expression: "1" });
    const parts = [];
    for (let i = 0; i < chunks.count; i++) {
      const resource = await client.readResource({ uri: chunks.uriPrefix + i });
      assert.ok(Buffer.byteLength(JSON.stringify(resource)) < 1024 * 1024);
      parts.push(JSON.parse((resource.contents[0] as any).text).data);
    }
    const records = inflateSync(Buffer.from(parts.join(""), "base64"))
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const restored = records[0].view;
    restored.geometry.bodies = records
      .filter((record) => record.type === "body")
      .map((record) => record.body);
    assert.equal(records.at(-1).type, "complete");
    assert.equal(restored.document.revision, 3);
    assert.equal(restored.geometry.bodies[0].mesh.vertices.length, 4_000_000);
    assert.deepEqual(
      restored.geometry.bodies[0].topology,
      JSON.parse(JSON.stringify(view.geometry.bodies[0].topology)),
    );
    assert.equal(restored.geometry.bodies[0].volume, 48000);
    await assert.rejects(
      client.readResource({ uri: chunks.uriPrefix + chunks.count }),
      /unavailable/,
    );
  } finally {
    await client.close();
    await server.close();
    await closeKernel();
    await rm(dir, { recursive: true, force: true });
  }
});
