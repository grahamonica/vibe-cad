import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import { textureInfo } from "../cad/appearance.ts";
import type { View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-appearance-"));
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
/** RGBA pixels of one of our PNGs (filter 0 rows). */
function pixels(base64: string) {
  const bytes = Buffer.from(base64, "base64"),
    data: Buffer[] = [];
  let at = 8,
    width = 0;
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at),
      type = bytes.toString("ascii", at + 4, at + 8);
    if (type === "IHDR") width = bytes.readUInt32BE(at + 8);
    if (type === "IDAT") data.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data)),
    rows = raw.length / (width * 4 + 1),
    out = Buffer.alloc(width * rows * 4);
  for (let y = 0; y < rows; y++) raw.copy(out, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  return out;
}
const count = (px: Buffer, test: (r: number, g: number, b: number) => boolean) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (test(px[i], px[i + 1], px[i + 2])) n++;
  return n;
};
async function plate(name: string) {
  const id = ((await store.create(name)) as View).document.id;
  const out = await run("run_steps", {
    steps: [
      { tool: "create_sketch", args: { plane: "XY" }, as: "s" },
      { tool: "add_sketch_entity", args: { sketchId: "@s.sketch", type: "rectangle", values: { x: 0, y: 0, width: 60, height: 40 } } },
      { tool: "extrude", args: { sketchId: "@s.sketch", distance: 20 }, as: "block" },
    ],
  }, id);
  assert.equal(out.ok, true, out.error);
  return { id, body: out.steps[2].created.body[0] as string };
}
const rendered = async (id: string) => (await store.view(await store.read(id))).geometry.bodies;

test("textures and display modes on a body, and how assembly components show over them", async () => {
  const part = await plate("Panel");
  // A texture comes with its usual color.
  await run("set_appearance", { objectId: part.body, texture: "carbon-fiber" }, part.id);
  await run("set_display_style", { objectId: part.body, style: "hidden-removed" }, part.id);
  let [b] = await rendered(part.id);
  assert.deepEqual([b.texture, b.color, b.style], ["carbon-fiber", textureInfo("carbon-fiber").color, "hidden-removed"]);
  // A later color tints the texture; "none" removes it.
  await run("set_appearance", { objectId: part.body, color: "#70798C" }, part.id);
  [b] = await rendered(part.id);
  assert.deepEqual([b.texture, b.color], ["carbon-fiber", "#70798C"]);

  const asm = ((await store.create("Stack")) as View).document.id;
  await run("insert_component", { partDocumentId: part.id, name: "One" }, asm);
  await run("insert_component", { partDocumentId: part.id, name: "Two", position: [0, 0, 30] }, asm);
  const components = (await store.read(asm)).components!,
    [one, two] = ["One", "Two"].map((name) => components.find((c) => c.name === name)!.id);
  const instance = async (cid: string) => (await rendered(asm)).find((x) => x.id.startsWith(`${cid}/`))!;
  // Instances show the part's own look until a component sets its own.
  assert.deepEqual([(await instance(one)).texture, (await instance(one)).style], ["carbon-fiber", "hidden-removed"]);
  await run("set_display_style", { objectId: one, style: "wireframe" }, asm);
  assert.equal((await instance(one)).style, "wireframe");
  assert.equal((await instance(two)).style, "hidden-removed", "the other instance keeps the part's mode");
  // A component color replaces the part's look; a component texture brings its own color.
  await run("set_appearance", { objectId: two, color: "#CE8147" }, asm);
  let t = await instance(two);
  assert.deepEqual([t.color, t.texture], ["#CE8147", undefined]);
  await run("set_appearance", { objectId: two, texture: "wood" }, asm);
  t = await instance(two);
  assert.deepEqual([t.color, t.texture], [textureInfo("wood").color, "wood"]);
  // Reset returns to the part's appearance and keeps the display mode.
  await run("set_display_style", { objectId: two, style: "shaded" }, asm);
  await run("set_appearance", { objectId: two, reset: true }, asm);
  t = await instance(two);
  assert.deepEqual([t.color, t.texture, t.style], ["#70798C", "carbon-fiber", "shaded"]);
  await run("set_display_style", { objectId: two, style: "default" }, asm);
  assert.equal((await instance(two)).style, "hidden-removed");
  assert.equal((await store.read(asm)).components!.find((c) => c.id === two)!.display?.style, undefined);
  // Display only: the part's volume is unchanged.
  assert.ok(Math.abs((await rendered(part.id))[0].volume - 60 * 40 * 20) < 1e-6);
  // Bad values are refused by the schema.
  assert.throws(() => tools.find((x) => x.name === "set_display_style")!.schema.parse({ documentId: asm, objectId: one, style: "sketchy" }));
});

test("capture_view draws each display style", async () => {
  const part = await plate("Block");
  // A light color, so faces cannot pass for ink edges.
  await run("set_appearance", { objectId: part.body, color: "#CE8147" }, part.id);
  const shot = async (style: string) =>
    pixels((await run("capture_view", { views: ["iso"], width: 240, height: 180, style }, part.id)).images[0].data);
  // Faces are orange; edges are ink; hidden lines are slate.
  const colored = (px: Buffer) => count(px, (r, _g, b) => r - b > 40),
    slate = (px: Buffer) => count(px, (r, _g, b) => b - r > 6 && b < 240),
    // Ink edges, softened by antialiasing, as gray: faces blend into orange instead.
    ink = (px: Buffer) => count(px, (r, g, b) => r < 200 && Math.abs(r - b) < 12 && Math.abs(r - g) < 12);
  const shadedEdges = await shot("shaded-edges"),
    shaded = await shot("shaded"),
    removed = await shot("hidden-removed"),
    visible = await shot("hidden-visible"),
    wire = await shot("wireframe");
  assert.ok(colored(shadedEdges) > 3000, "shaded faces");
  assert.ok(ink(shadedEdges) > 100 && ink(shaded) < 10, `Shaded draws no edges (${ink(shaded)} vs ${ink(shadedEdges)})`);
  assert.equal(colored(removed), 0, "hidden lines removed: white faces");
  assert.ok(ink(removed) > 100, "with their edges");
  assert.ok(slate(visible) > 40 && slate(removed) < 5, `hidden edges dashed in slate (${slate(visible)} vs ${slate(removed)})`);
  assert.equal(colored(wire), 0, "wireframe: no faces");
  assert.ok(ink(wire) > ink(removed), "and every edge, the back ones too");
  // A body's own display mode wins over the picture's style.
  const [{ id: body }] = await rendered(part.id);
  await run("set_display_style", { objectId: body, style: "wireframe" }, part.id);
  assert.equal(colored(await shot("shaded-edges")), 0);
});
