import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import type { Topology, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-import-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const store = new Store(join(dir, "docs")),
  tools = toolset(store);
const ref = (t: Topology) => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType });
async function open(name: string) {
  let v = (await store.create(name)) as View;
  const run = async (tool: string, args: any = {}) => {
    const t = tools.find((t) => t.name === tool)!;
    const latest = await store.read(v.document.id);
    const r = await t.handler(
      t.schema.parse({ documentId: latest.id, ...(t.schema.shape.expectedRevision ? { expectedRevision: latest.revision } : {}), ...args }),
      "assistant",
    );
    if (r?.document) v = r;
    return r;
  };
  return {
    run,
    get id() {
      return v.document.id;
    },
    get view() {
      return v;
    },
  };
}

test("STEP import: a vendor solid becomes an editable body, insertable into assemblies, stored once outside the history", async () => {
  // A part with a hole, exported to STEP.
  const source = await open("Bracket");
  await source.run("create_sketch", { plane: "XY" });
  await source.run("add_sketch_entity", { sketchId: source.view.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 60, height: 40 } });
  await source.run("extrude", { sketchId: source.view.document.sketches[0].id, distance: 8 });
  const top = source.view.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await source.run("create_hole", { bodyId: source.view.document.bodies[0].id, face: ref(top), frame: "origin", positions: [[0, 0]], diameter: 10 });
  const volume = source.view.geometry.bodies[0].volume;
  const exported = await source.run("export_file", { format: "step" });
  const step = await readFile(exported.path);

  // Import it into another part.
  const part = await open("Imported bracket");
  await assert.rejects(part.run("import_step", { data: Buffer.from("not a step file at all").toString("base64") }), /not a STEP file/);
  await part.run("import_step", { data: step.toString("base64"), filename: "bracket.step" });
  const body = part.view.geometry.bodies[0];
  assert.equal(part.view.document.bodies[0].name, "bracket");
  assert.ok(Math.abs(body.volume - volume) < 1e-6 * volume, `imported volume ${body.volume} vs ${volume}`);
  assert.equal(part.view.document.features[0].type, "import");

  // Edit it like any body: round the hole's top rim.
  const rim = body.topology.find((t) => t.kind === "edge" && t.geomType === "CIRCLE" && Math.abs(t.center[2] - 8) < 1e-6)!;
  await part.run("fillet_edges", { bodyId: body.id, radius: 1, edges: [ref(rim)] });
  assert.ok(part.view.geometry.bodies[0].volume < volume);
  // The imported faces keep their ids when later features change.
  const ids = part.view.geometry.bodies[0].topology.filter((t) => t.kind === "face").map((t) => t.id);
  await part.run("set_dimension", { featureId: part.view.document.features[1].id, dimension: "radius", value: 2 });
  const after = new Set(part.view.geometry.bodies[0].topology.filter((t) => t.kind === "face").map((t) => t.id));
  assert.ok(ids.every((id) => after.has(id)), "face ids survive the radius change");

  // The file lives outside the document and its history.
  const saved = await readFile(join(dir, "docs", `${part.id}.json`), "utf8");
  assert.ok(!saved.includes("ISO-10303-21"), "the STEP text is not in the saved document");
  await part.run("undo");
  await part.run("redo");

  // Insert the imported part into an assembly.
  const asm = await open("Station");
  await asm.run("insert_component", { partDocumentId: part.id });
  await asm.run("insert_component", { partDocumentId: part.id, position: [80, 0, 0] });
  assert.equal(asm.view.geometry.bodies.length, 2);
  assert.ok(Math.abs(asm.view.geometry.bodies[1].bounds[0][0] - 50) < 1e-6);
});

/** ASCII STL of axis-aligned boxes; `inward` flips a box's facets (a cavity written inside-out). */
function boxesSTL(boxes: { min: number[]; max: number[]; drop?: number }[]) {
  const facets: string[] = [];
  for (const { min, max, drop } of boxes) {
    const [x0, y0, z0] = min,
      [x1, y1, z1] = max;
    const v = (x: number, y: number, z: number) => `vertex ${x} ${y} ${z}`;
    const quads = [
      [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
      [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
      [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
      [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
    ];
    let k = 0;
    for (const q of quads)
      for (const tri of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
        if (k++ === drop) continue;
        facets.push(`facet normal 0 0 0\n outer loop\n  ${tri.map((p) => v(p[0], p[1], p[2])).join("\n  ")}\n endloop\nendfacet`);
      }
  }
  return Buffer.from(`solid boxes\n${facets.join("\n")}\nendsolid boxes\n`).toString("base64");
}

test("STL import: watertight meshes become editable solids with merged planar faces, usable in assemblies", async () => {
  // A plate with a hole, exported as a binary STL mesh.
  const source = await open("Mesh source");
  await source.run("create_sketch", { plane: "XY" });
  await source.run("add_sketch_entity", { sketchId: source.view.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 60, height: 40 } });
  await source.run("extrude", { sketchId: source.view.document.sketches[0].id, distance: 8 });
  const top = source.view.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await source.run("create_hole", { bodyId: source.view.document.bodies[0].id, face: ref(top), frame: "origin", positions: [[0, 0]], diameter: 10 });
  const volume = source.view.geometry.bodies[0].volume;
  const exported = await source.run("export_file", { format: "stl" });
  const stl = await readFile(exported.path);

  const part = await open("Printed bracket");
  await assert.rejects(part.run("import_stl", { data: Buffer.from("definitely not a mesh file").toString("base64") }), /not an STL file/);
  await part.run("import_stl", { data: stl.toString("base64"), filename: "bracket.stl" });
  let body = part.view.geometry.bodies[0];
  assert.equal(part.view.document.bodies[0].name, "bracket");
  // The faceted hole holds slightly less than the true cylinder.
  assert.ok(Math.abs(body.volume - volume) < 0.01 * volume, `mesh volume ${body.volume} vs ${volume}`);
  // Coplanar facets merged: one flat top face and one flat bottom face.
  const faces = body.topology.filter((t) => t.kind === "face");
  assert.equal(faces.filter((t) => t.geomType === "PLANE" && t.normal?.[2] === 1).length, 1);
  assert.equal(faces.filter((t) => t.geomType === "PLANE" && t.normal?.[2] === -1).length, 1);

  // Edit the mesh solid like any body: round an outer vertical edge exactly…
  const corner = body.topology.find(
    (t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[0] - 30) < 1e-6 && Math.abs(t.center[1] - 20) < 1e-6,
  )!;
  const before = body.volume;
  await part.run("fillet_edges", { bodyId: body.id, radius: 2, edges: [ref(corner)] });
  body = part.view.geometry.bodies[0];
  assert.ok(Math.abs(before - body.volume - (4 - Math.PI) * 8) < 1e-6, `fillet removed ${before - body.volume}`);
  // …sketch on its flat top and cut a pocket…
  const flat = body.topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await part.run("create_sketch", { support: ref(flat) });
  const sketchId = part.view.document.sketches.at(-1)!.id;
  await part.run("add_sketch_entity", { sketchId, type: "rectangle", values: { x: 18, y: 0, width: 12, height: 20 } });
  const beforeCut = part.view.geometry.bodies[0].volume;
  await part.run("extrude", { sketchId, distance: 3, operation: "cut", bodyId: body.id, reverse: true });
  assert.ok(Math.abs(beforeCut - part.view.geometry.bodies[0].volume - 12 * 20 * 3) < 1e-6, `pocket removed ${beforeCut - part.view.geometry.bodies[0].volume}`);
  // …and drill it.
  const pocketTop = part.view.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1 && Math.abs(t.center[2] - 8) < 1e-6)!;
  const beforeHole = part.view.geometry.bodies[0].volume;
  await part.run("create_hole", { bodyId: body.id, face: ref(pocketTop), frame: "origin", positions: [[-20, 0]], diameter: 4 });
  assert.ok(Math.abs(beforeHole - part.view.geometry.bodies[0].volume - Math.PI * 4 * 8) < 1e-3, "through hole");
  const saved = await readFile(join(dir, "docs", `${part.id}.json`), "utf8");
  assert.ok(saved.length < 200_000 && !saved.includes("vertex"), "the mesh is stored outside the document");
  await part.run("undo");
  await part.run("redo");

  // ASCII STL in inches, a cavity, and an open mesh.
  const ascii = await open("ASCII mesh");
  await ascii.run("import_stl", { data: boxesSTL([{ min: [0, 0, 0], max: [2, 1, 0.5] }]), units: "in", filename: "block.stl" });
  const block = ascii.view.geometry.bodies[0];
  assert.ok(Math.abs(block.volume - 2 * 1 * 0.5 * 25.4 ** 3) < 1e-6 * block.volume, `inch block ${block.volume}`);
  assert.equal(block.topology.filter((t) => t.kind === "face").length, 6);
  await ascii.run("import_stl", { data: boxesSTL([{ min: [0, 0, 0], max: [20, 20, 20] }, { min: [5, 5, 5], max: [15, 15, 15] }]), filename: "hollow.stl" });
  assert.ok(Math.abs(ascii.view.geometry.bodies[1].volume - (8000 - 1000)) < 1e-6, `cavity ${ascii.view.geometry.bodies[1].volume}`);
  const revision = ascii.view.document.revision;
  await assert.rejects(ascii.run("import_stl", { data: boxesSTL([{ min: [0, 0, 0], max: [10, 10, 10], drop: 3 }]) }), /not watertight/);
  assert.equal((await store.read(ascii.id)).revision, revision);

  // Insert the mesh part into an assembly and mate it.
  const asm = await open("Printer bay");
  await asm.run("insert_component", { partDocumentId: source.id });
  await asm.run("insert_component", { partDocumentId: part.id, position: [0, 0, 30] });
  const [base, printed] = asm.view.document.components!;
  const of = (c: { id: string }) => asm.view.geometry.bodies.find((b) => b.id.startsWith(`${c.id}/`))!;
  const baseTop = of(base).topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  const printedBottom = of(printed).topology.find((t) => t.kind === "face" && t.normal?.[2] === -1)!;
  await asm.run("add_mate", { type: "coincident", moving: ref(printedBottom), target: ref(baseTop) });
  assert.ok(Math.abs(of(printed).bounds[0][2] - 8) < 1e-6, "the printed part sits on the base");
  const bom = await asm.run("inspect_assembly");
  assert.deepEqual(bom.bom.map((l: any) => [l.name, l.quantity]).sort(), [["Mesh source", 1], ["Printed bracket", 1]]);

  // import_part makes a part document straight from a file, and only when the file imports.
  const importPart = tools.find((t) => t.name === "import_part")!;
  const count = (await store.list()).length;
  await assert.rejects(importPart.handler(importPart.schema.parse({ data: boxesSTL([{ min: [0, 0, 0], max: [5, 5, 5], drop: 0 }]), filename: "leaky.stl" }), "user"), /not watertight/);
  assert.equal((await store.list()).length, count, "a failed import leaves no document behind");
  const spacer: View = await importPart.handler(importPart.schema.parse({ data: boxesSTL([{ min: [0, 0, 0], max: [10, 10, 4] }]), filename: "spacer.stl" }), "user");
  assert.equal(spacer.document.name, "spacer");
  assert.equal(spacer.document.revision, 1);
  assert.deepEqual(spacer.document.history.map((h) => h.description), ["Created document", "Imported spacer.stl"]);
  const viaStep: View = await importPart.handler(importPart.schema.parse({ data: (await readFile((await source.run("export_file", { format: "step" })).path)).toString("base64"), filename: "plate.step" }), "user");
  assert.ok(Math.abs(viaStep.geometry.bodies[0].volume - volume) < 1e-6 * volume, "STEP detected from its contents");
  await asm.run("insert_component", { partDocumentId: spacer.document.id, position: [100, 0, 0] });
  assert.equal((await asm.run("inspect_assembly")).bom.length, 3);
});

test("Move Face: direct edits of imported solids stay exact and keep face identity", async () => {
  const part = await open("Block to edit");
  await part.run("import_stl", { data: boxesSTL([{ min: [0, 0, 0], max: [40, 20, 10] }]), filename: "block.stl" });
  const body = () => part.view.geometry.bodies[0];
  const face = (n: [number, number, number]) => body().topology.find((t) => t.kind === "face" && t.normal?.every((v, i) => Math.abs(v - n[i]) < 1e-9))!;
  // A sketch on the top face follows the face when it moves.
  await part.run("create_sketch", { support: ref(face([0, 0, 1])) });
  const sketchId = part.view.document.sketches[0].id;
  const top = face([0, 0, 1]);
  await part.run("move_face", { bodyId: body().id, faces: [ref(top)], offset: 6 });
  assert.ok(Math.abs(body().volume - 40 * 20 * 16) < 1e-6, `pulled ${body().volume}`);
  assert.equal(face([0, 0, 1]).id, top.id, "the moved face keeps its id");
  assert.ok(Math.abs(part.view.geometry.frames!.sketches[sketchId].origin[2] - 16) < 1e-9, "the sketch moved with the face");
  // Pushing two end faces in at once, then redefining the offset.
  await part.run("move_face", { bodyId: body().id, faces: [ref(face([1, 0, 0])), ref(face([-1, 0, 0]))], offset: -5 });
  assert.ok(Math.abs(body().volume - 30 * 20 * 16) < 1e-6, `pushed ${body().volume}`);
  await part.run("set_dimension", { featureId: part.view.document.features.at(-1)!.id, dimension: "offset", value: -2 });
  assert.ok(Math.abs(body().volume - 36 * 20 * 16) < 1e-6, `redefined ${body().volume}`);
  // A face next to a chamfer cannot simply slide; the edit is rejected.
  const edge = body().topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[2] - 16) < 1e-6 && Math.abs(t.center[1] - 20) < 1e-6)!;
  await part.run("chamfer_edges", { bodyId: body().id, edges: [ref(edge)], distance: 2 });
  const revision = part.view.document.revision;
  await assert.rejects(part.run("move_face", { bodyId: body().id, faces: [ref(face([0, 0, 1]))], offset: 3 }), /square/);
  assert.equal((await store.read(part.id)).revision, revision);
});
