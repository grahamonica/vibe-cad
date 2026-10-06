import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import type { View } from "../cad/types.ts";
import { inflateSync } from "node:zlib";

/** A PNG's size and RGBA pixels (our encoder writes filter 0 rows). */
function readPng(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
  let at = 8,
    width = 0,
    height = 0;
  const data: Buffer[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at),
      type = bytes.toString("ascii", at + 4, at + 8),
      body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") [width, height] = [body.readUInt32BE(0), body.readUInt32BE(4)];
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data)),
    pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) raw.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  return { width, height, pixels };
}
const count = (pixels: Buffer, test: (r: number, g: number, b: number) => boolean) => {
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) if (test(pixels[i], pixels[i + 1], pixels[i + 2])) n++;
  return n;
};

const dir = await mkdtemp(join(tmpdir(), "vibe-steps-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const store = new Store(join(dir, "docs")),
  tools = toolset(store);
async function run(name: string, args: any = {}, documentId?: string): Promise<any> {
  const t = tools.find((t) => t.name === name)!;
  const latest = documentId ? await store.read(documentId) : undefined;
  return t.handler(t.schema.parse({ ...(documentId ? { documentId } : {}), ...(latest && t.schema.shape.expectedRevision ? { expectedRevision: latest.revision } : {}), ...args }), "assistant");
}
const near = (a: number, b: number, tol: number, label: string) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);

test("run_steps: a part built in one request, with references to earlier steps and faces picked by description", async () => {
  const id = ((await store.create("Mount")) as View).document.id;
  const out = await run("run_steps", {
    steps: [
      { tool: "create_sketch", args: { plane: "XY" }, as: "s" },
      { tool: "add_sketch_entity", args: { sketchId: "@s.sketch", type: "rectangle", values: { x: 0, y: 0, width: 80, height: 50 } } },
      { tool: "extrude", args: { sketchId: "@s.sketch", distance: 6 }, as: "plate" },
      { tool: "create_hole", args: { bodyId: "@plate.body", face: { $face: { body: "@plate.body", normal: [0, 0, 1], extreme: [0, 0, 1] } }, frame: "origin", positions: [[-25, 0], [25, 0]], diameter: 8 }, as: "holes" },
      { tool: "fillet_edges", args: { bodyId: "@plate.body", radius: 5, edges: { $edges: { body: "@plate.body", type: "line", along: [0, 0, 1] } } } },
      { tool: "mass_properties", args: {}, as: "mass" },
    ],
  }, id);
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.steps.map((s: any) => s.ok), [true, true, true, true, true, true]);
  assert.ok(out.steps[2].created.body.length === 1 && out.steps[2].created.feature.length === 1);
  assert.equal(out.steps[1].created.entity.length, 1, "the rectangle");
  // 80 × 50 × 6, two Ø8 holes, four R5 corners.
  const volume = (80 * 50 - 2 * Math.PI * 16 - 4 * (25 - (Math.PI * 25) / 4)) * 6;
  near(out.view.geometry.bodies[0].volume, volume, 1e-6, "volume");
  assert.equal(out.document.revision, (await store.read(id)).revision);
  // The sketch has a free rectangle: the report says so.
  assert.equal(out.definition.status, "under");
  assert.ok(out.definition.notes.some((n: string) => /Sketch 1 is under-defined/.test(n)));
  assert.equal(out.steps[5].result.missing.length >= 0, true, "read-only results come back");
  // check_definition gives the same report in full.
  const definition = await run("check_definition", {}, id);
  assert.equal(definition.status, "under");
  assert.ok(definition.sketches[0].dof > 0);
});

test("run_steps: an ambiguous pick fails with a clear message and the whole batch is undone", async () => {
  const id = ((await store.create("Undo me")) as View).document.id;
  const before = await store.read(id);
  const out = await run("run_steps", {
    steps: [
      { tool: "create_sketch", args: { plane: "XY" }, as: "s" },
      { tool: "add_sketch_entity", args: { sketchId: "@s.sketch", type: "rectangle", values: { x: 0, y: 0, width: 40, height: 40 } } },
      { tool: "extrude", args: { sketchId: "@s.sketch", distance: 10 }, as: "block" },
      // Four side faces run up the block: which one?
      { tool: "create_sketch", args: { support: { $face: { body: "@block.body", type: "plane", along: [0, 0, 1] } } } },
    ],
  }, id);
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 4);
  assert.match(out.error, /4 faces match .*narrow it with near, extreme/);
  assert.equal(out.rolledBack, true);
  const after = await store.read(id);
  assert.equal(after.features.length, before.features.length);
  assert.equal(after.sketches.length, before.sketches.length);
  // Unknown tools and history tools are refused.
  const bad = await run("run_steps", { steps: [{ tool: "undo", args: {} }] }, id);
  assert.match(bad.error, /cannot run in a batch/);
});

test("run_steps: a part and an assembly built together; appearance, suppression, interference and definition", async () => {
  const out = await run("run_steps", {
    steps: [
      { tool: "create_document", args: { name: "Spacer" }, as: "spacer" },
      { tool: "create_sketch", args: { plane: "XY" }, as: "s" },
      { tool: "add_sketch_entity", args: { sketchId: "@s.sketch", type: "circle", values: { x: 0, y: 0, radius: 10 } } },
      { tool: "extrude", args: { sketchId: "@s.sketch", distance: 20 }, as: "body" },
      { tool: "create_document", args: { name: "Stack" }, as: "stack" },
      { tool: "insert_component", args: { partDocumentId: "@spacer.document", name: "Bottom" }, as: "bottom" },
      { tool: "insert_component", args: { partDocumentId: "@spacer.document", position: [0, 0, 15], name: "Top" }, as: "top" },
      { tool: "set_appearance", args: { objectId: "@top.component", transparency: 75, color: "#CE8147" } },
    ],
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.document.name, "Stack");
  assert.deepEqual(out.createdDocuments.length, 2);
  const stack = out.document.id,
    [bottom, top] = (await store.read(stack)).components!;
  let v: View = out.view;
  const topBody = v.geometry.bodies.find((b) => b.id.startsWith(`${top.id}/`))!;
  near(topBody.opacity!, 0.25, 1e-9, "75% transparent");
  assert.equal(topBody.color, "#CE8147");
  // The two spacers overlap by 5 mm of height: interference detection finds it.
  const clash = await run("check_interference", {}, stack);
  assert.equal(clash.interferes, true);
  near(clash.pairs[0].volume, Math.PI * 100 * 5, 1, "overlap volume");
  assert.deepEqual([clash.pairs[0].aName, clash.pairs[0].bName].sort(), ["Bottom", "Top"]);
  // Hidden still weighs and still interferes; suppressed is gone from the model, the BOM and the checks.
  v = await run("set_visibility", { objectId: top.id, hidden: true }, stack);
  assert.equal(v.geometry.bodies.find((b) => b.id.startsWith(`${top.id}/`))!.hidden, true);
  v = await run("set_component_suppressed", { componentId: top.id, suppressed: true }, stack);
  assert.ok(!v.geometry.bodies.some((b) => b.id.startsWith(`${top.id}/`)));
  assert.equal((await run("check_interference", {}, stack)).interferes, false);
  const bom = (await run("inspect_assembly", {}, stack)).bom;
  assert.equal(bom.reduce((n: number, line: any) => n + line.quantity, 0), 1);
  v = await run("set_component_suppressed", { componentId: top.id, suppressed: false }, stack);
  assert.ok(v.geometry.bodies.some((b) => b.id.startsWith(`${top.id}/`)));
  // Definition: the first part is fixed, the other free.
  const definition = await run("check_definition", {}, stack);
  assert.deepEqual(definition.components.map((c: any) => [c.name, c.status]), [["Bottom", "fixed"], ["Top", "under"]]);
  assert.equal(definition.status, "under");
  await run("set_visibility", { objectId: top.id, hidden: false }, stack);
  // Pictures from two angles, the top spacer highlighted: real PNGs the assistant can look at.
  const pictures = await run("capture_view", { views: ["iso", { direction: [1, 0, 0], name: "side" }], width: 320, height: 240, highlight: [top.id] }, stack);
  assert.deepEqual(pictures.views.map((x: any) => x.name), ["iso", "side"]);
  assert.equal(pictures.images.length, 2);
  for (const image of pictures.images) {
    const png = readPng(image.data);
    assert.deepEqual([png.width, png.height], [320, 240]);
    const white = count(png.pixels, (r, g, b) => r > 250 && g > 250 && b > 250),
      accent = count(png.pixels, (r, g, b) => r > 150 && g > 70 && g < 160 && b < 110 && r - b > 80);
    assert.ok(white > 0.3 * 320 * 240, `${image.name}: mostly background`);
    assert.ok(accent > 400, `${image.name}: the highlighted spacer shows (${accent} px)`);
  }
  assert.deepEqual(pictures.legend.map((l: any) => l.meaning), ["highlighted: Top"]);
  // A flagged mate is marked in red on its faces.
  const faces = (await store.view(await store.read(stack))).geometry.bodies.flatMap((b) => b.topology);
  const endOf = (cid: string, z: number) => faces.find((t) => t.bodyId.startsWith(`${cid}/`) && t.normal?.[2] === z)!;
  const refOf = (t: any) => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType });
  await run("add_mate", { type: "coincident", moving: refOf(endOf(top.id, -1)), target: refOf(endOf(bottom.id, 1)) }, stack);
  await run("add_mate", { type: "distance", value: 3, moving: refOf(endOf(top.id, -1)), target: refOf(endOf(bottom.id, 1)) }, stack);
  const flagged = await run("capture_view", { views: [{ direction: [1, -1, 0.4], name: "low" }], width: 320, height: 240 }, stack);
  assert.match(flagged.legend[0].meaning, /^Distance 1 over-defines Top: it conflicts with Coincident 1/);
  const red = count(readPng(flagged.images[0].data).pixels, (r, g, b) => r > 120 && g < 110 && b < 100 && r - g > 50);
  assert.ok(red > 300, `the over-defined spacer is marked (${red} px)`);
  const why = await run("check_definition", {}, stack);
  const distance = why.mates.find((m: any) => m.name === "Distance 1");
  assert.equal(distance.value, 3);
  assert.deepEqual([distance.moving.part, distance.moving.geometry, distance.target.part], ["Top", "flat face", "Bottom"]);
  near(distance.residual, 3, 1e-6, "3 mm from met");
});
