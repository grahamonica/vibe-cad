import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcp } from "../runtime/mcp.ts";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { deliverView } from "../runtime/view-delivery.ts";
import { packDisplayBody, unpackDisplayBody } from "../cad/view-wire.ts";
import { closeKernel } from "../cad/geometry.ts";
import { receiveView } from "../editor/view-stream.ts";
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
    // Curved vendor geometry has noisy low float64 bits. Transport should retain
    // exactly what the GPU displays, while leaving selectable CAD data intact.
    const sourceBody = view.geometry.bodies[0];
    const precise = {...sourceBody, mesh:{...sourceBody.mesh,
      vertices:Array.from({length:192},(_,i)=>Math.PI*Math.sin(i)+0.123456789012345)},
      edges:{...sourceBody.edges,lines:[Math.PI,Math.E,0.123456789012345]}};
    const packed = packDisplayBody(precise,b=>Buffer.from(b).toString('base64'));
    assert.equal(packed.mesh.encoding,'f32-u32-le');
    assert.equal(typeof packed.mesh.vertices,'string');
    const decoded = unpackDisplayBody(packed);
    assert.ok(decoded.mesh.vertices instanceof Float32Array);
    assert.ok(decoded.mesh.triangles instanceof Uint32Array);
    assert.deepEqual(Array.from(decoded.mesh.vertices),Array.from(precise.mesh.vertices,Math.fround));
    assert.deepEqual(Array.from(decoded.edges.lines),Array.from(precise.edges.lines,Math.fround));
    assert.deepEqual(decoded.topology,precise.topology);
    assert.equal(packed.topologyEncoding,'body-relative-v1');
    assert.ok(packed.topology.every(t=>t.bodyId===undefined && !t.id.startsWith(precise.id)));
    assert.deepEqual(decoded.mesh.faceGroups,precise.mesh.faceGroups);
    assert.deepEqual(decoded.edges.edgeGroups,precise.edges.edgeGroups);
    assert.deepEqual(decoded.tangentEdges,precise.tangentEdges);
    assert.equal(decoded.volume,precise.volume);
    assert.equal(precise.mesh.vertices[0],0.123456789012345);
    const oldBytes=Buffer.alloc(precise.mesh.vertices.length*8);
    precise.mesh.vertices.forEach((v,i)=>oldBytes.writeDoubleLE(v,i*8));
    assert.deepEqual(Array.from(unpackDisplayBody({...precise,edges:{...precise.edges,lines:Array.from(precise.edges.lines)},mesh:{...precise.mesh,
      normals:Array.from(precise.mesh.normals),triangles:Array.from(precise.mesh.triangles),
      encoding:'f64-u32-le',vertices:oldBytes.toString('base64')}}).mesh.vertices),Array.from(precise.mesh.vertices,Math.fround));
    // Noisy unused vertices exercise multiple chunks without changing
    // solid geometry, topology references or the existing triangle indices.
    view.geometry.bodies[0].mesh.vertices = Array.from(
      { length: 400_002 },
      (_, i) => i < original.length ? original[i] : Math.fround(((Math.imul(i, 2654435761) >>> 0) / 2**32) * 40),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(view)) > 1024 * 1024);
    const transferMesh = view.geometry.bodies[0].mesh;
    const transferEdges = view.geometry.bodies[0].edges;
    const meta = await deliverView(store, view);
    assert.ok(Buffer.byteLength(JSON.stringify(meta)) < 1024);
    const chunks = meta.viewChunks as { uriPrefix: string; count: number };
    assert.ok(chunks.count > 1, "Exercise actual resource chunk boundaries");
    await invoke("set_variable", { name: "later_edit", expression: "1" });
    const parts: string[] = [];
    for (let i = 0; i < chunks.count; i++) {
      const resource = await client.readResource({ uri: chunks.uriPrefix + i });
      assert.ok(Buffer.byteLength(JSON.stringify(resource)) < 1024 * 1024);
      parts.push(JSON.parse((resource.contents[0] as any).text).data);
    }
    const restored = await receiveView(new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new Uint8Array(Buffer.from(part, "base64")));
        controller.close();
      },
    }), () => {});
    assert.equal(restored.document.revision, 3);
    assert.equal(restored.geometry.bodies[0].mesh.vertices.length, 400_002);
    const received = restored.geometry.bodies[0];
    for(const key of ['vertices','normals'] as const)
      assert.deepEqual(Array.from(received.mesh[key]),Array.from(transferMesh[key],Math.fround));
    assert.deepEqual(Array.from(received.mesh.triangles),Array.from(transferMesh.triangles));
    assert.deepEqual(Array.from(received.edges.lines),Array.from(transferEdges.lines,Math.fround));
    assert.deepEqual(received.mesh.faceGroups,transferMesh.faceGroups);
    assert.deepEqual(received.edges.edgeGroups,transferEdges.edgeGroups);
    assert.deepEqual(
      restored.geometry.bodies[0].topology,
      JSON.parse(JSON.stringify(view.geometry.bodies[0].topology)),
    );
    assert.equal(restored.geometry.bodies[0].volume, 48000);
    const invalid = {...view,geometry:{...view.geometry,bodies:[{...view.geometry.bodies[0],mesh:{...transferMesh,triangles:[-1]}}]}};
    await assert.rejects(deliverView(store, invalid), /Invalid display triangle index/);
    assert.ok((await deliverView(store, view)).view, "A producer failure must not poison later deliveries");
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
