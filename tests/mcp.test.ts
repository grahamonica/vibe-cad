import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcp, uiUri, modelToolNames } from "../runtime/mcp.ts";
import { Store } from "../cad/store.ts";
import { closeKernel } from "../cad/geometry.ts";
const dir = await mkdtemp(join(tmpdir(), "vibe-cad-mcp-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
test("MCP handshake, typed tools, annotations, self-contained UI resource, mutations and schema errors", async () => {
  const server = createMcp(new Store(dir)),
    client = new Client({ name: "CAD integration test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.listTools();
    assert.ok(result.tools.length >= 35);
    const get = result.tools.find((t) => t.name === "inspect_document")!,
      create = result.tools.find((t) => t.name === "create_document")!,
      del = result.tools.find((t) => t.name === "delete_feature")!;
    assert.equal(get.annotations?.readOnlyHint, true);
    assert.equal(create.annotations?.destructiveHint, false);
    assert.equal((create._meta?.ui as any).resourceUri, uiUri);
    assert.equal(del.annotations?.destructiveHint, true);
    assert.ok(get.outputSchema);
    assert.ok(result.tools.every((t) => t.inputSchema && t.outputSchema));
    const modelTools = result.tools.filter(t => (t._meta?.ui as any)?.visibility.includes("model"));
    assert.deepEqual(new Set(modelTools.map(t => t.name)), modelToolNames);
    assert.ok(modelTools.length <= 24, "Main CAD tools must fit in the host catalog");
    assert.ok(modelTools.some(t => t.name === "open_cad"));
    assert.ok(modelTools.some(t => t.name === "run_steps"));
    // Codex's function schema converter expects a schema object in array items,
    // whereas Zod tuples otherwise advertise Draft-07 `items: [schemas]`.
    const visit = (value: any): void => {
      if (!value || typeof value !== "object") return;
      if (value.type === "array") assert.ok(!Array.isArray(value.items));
      for (const child of Object.values(value)) visit(child);
    };
    result.tools.forEach(t => visit(t.inputSchema));
    const schemas = await client.callTool({ name: "get_tool_schema", arguments: { names: ["fillet_edges", "create_sketch"] } });
    assert.ok(!schemas.isError, JSON.stringify(schemas));
    const listed = (schemas.structuredContent as any).tools;
    assert.deepEqual(listed.map((t: any) => t.name), ["fillet_edges", "create_sketch"]);
    assert.equal(listed[1].inputSchema.properties.origin.minItems, 3);
    assert.equal(listed[1].inputSchema.properties.origin.maxItems, 3);
    assert.equal(
      result.tools.find((t) => t.name === "open_cad")?._meta?.ui &&
        (result.tools.find((t) => t.name === "open_cad")!._meta!.ui as any)
          .resourceUri,
      uiUri,
    );
    assert.equal(
      (result.tools.find((t) => t.name === "run_steps")!._meta!.ui as any)
        .resourceUri,
      uiUri,
    );
    assert.equal(
      result.tools.find((t) => t.name === "open_cad")!._meta![
        "openai/outputTemplate"
      ],
      uiUri,
    );
    const doc = await client.callTool({
      name: "create_document",
      arguments: { name: "MCP model" },
    });
    assert.ok(!doc.isError);
    assert.equal(doc._meta?.["openai/outputTemplate"], uiUri);
    const id = (doc.structuredContent as any).document.id;
    const badVector = await client.callTool({
      name: "create_sketch",
      arguments: { documentId: id, expectedRevision: 0, plane: "XY", origin: [0, 0] },
    });
    assert.equal(badVector.isError, true, "Vector arity must still be validated");
    const sketch = await client.callTool({
      name: "create_sketch",
      arguments: { documentId: id, expectedRevision: 0, plane: "XY" },
      _meta: { "vibe-cad/source": "user" },
    });
    assert.equal((sketch.structuredContent as any).document.revision, 1);
    assert.ok((sketch._meta?.view as any).geometry);
    assert.equal(
      (doc._meta?.view as any).document.history.at(-1).source,
      "assistant",
    );
    assert.equal(
      (sketch._meta?.view as any).document.history.at(-1).source,
      "user",
    );
    const bad = await client.callTool({
      name: "set_dimension",
      arguments: {
        documentId: id,
        expectedRevision: 0,
        featureId: "bad",
        dimension: "width",
        value: 10,
      },
    });
    assert.equal(bad.isError, true);
    const invalid = await client.callTool({
      name: "add_sketch_entity",
      arguments: {
        documentId: id,
        expectedRevision: 1,
        sketchId: "bad",
        type: "circle",
        values: { x: 0, y: 0, radius: -1 },
      },
    });
    assert.equal(invalid.isError, true);
    const unchanged = await client.callTool({
      name: "inspect_document",
      arguments: { documentId: id },
    });
    assert.equal((unchanged.structuredContent as any).document.revision, 1);
    const batch = await client.callTool({
      name: "run_steps",
      arguments: {
        documentId: id,
        steps: [
          {
            tool: "create_sketch",
            args: { plane: "XZ", name: "Embedded sketch" },
          },
        ],
      },
    });
    assert.ok(!batch.isError, JSON.stringify(batch));
    assert.equal((batch.structuredContent as any).ok, true);
    const embedded = batch._meta?.view as any;
    assert.equal(embedded.document.id, id);
    assert.equal(embedded.document.sketches.at(-1).name, "Embedded sketch");
    const saved = await client.callTool({
      name: "inspect_document",
      arguments: { documentId: id },
    });
    assert.equal(
      (saved.structuredContent as any).document.revision,
      embedded.document.revision,
    );
    const exported = await client.callTool({
      name: "export_file",
      arguments: { documentId: id, format: "json" },
    });
    assert.ok(!exported.isError);
    const download = exported._meta!.download as any;
    assert.equal(
      download.filename,
      (exported.structuredContent as any).filename,
    );
    assert.equal(
      JSON.parse(Buffer.from(download.base64, "base64").toString()).id,
      id,
    );
    const resources = await client.listResources();
    assert.ok(resources.resources.some((r) => r.uri === uiUri));
    const ui = await client.readResource({ uri: uiUri });
    const html = (ui.contents[0] as any).text;
    assert.ok(html.includes("Vibe CAD"));
    assert.ok(html.includes("3D CAD viewport"));
    assert.ok(!/<script[^>]+src=/.test(html));
    assert.equal(ui.contents[0].mimeType, "text/html;profile=mcp-app");
  } finally {
    await client.close();
    await server.close();
  }
});
