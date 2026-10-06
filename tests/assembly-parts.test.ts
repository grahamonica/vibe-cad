import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import type { Topology, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-parts-"));
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
    async refresh() {
      v = await store.view(await store.read(v.document.id));
      return v;
    },
  };
}
const axisAt = (t: Topology | undefined) => t?.axis?.origin.slice(0, 2).map((x) => Math.round(x * 1000) / 1000);

test("inserted parts: instances, mates across documents, associative edits, BOM and drawings", async () => {
  // Part: plate with two holes.
  const plate = await open("Plate");
  await plate.run("create_sketch", { plane: "XY" });
  await plate.run("add_sketch_entity", { sketchId: plate.view.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 100, height: 60 } });
  await plate.run("extrude", { sketchId: plate.view.document.sketches[0].id, distance: 10 });
  const top = plate.view.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await plate.run("create_hole", { bodyId: plate.view.document.bodies[0].id, face: ref(top), frame: "origin", positions: [[-40, 0], [40, 0]], diameter: 5 });
  // Material gives mass, and undo clears it again.
  await plate.run("set_material", { name: "aluminum 6061-t6" });
  const plateBody = plate.view.geometry.bodies[0];
  assert.equal(plate.view.document.material?.name, "Aluminum 6061-T6");
  assert.ok(Math.abs(plateBody.mass! - (plateBody.volume * 2.7) / 1000) < 1e-9);
  await assert.rejects(plate.run("set_material", { name: "Unobtainium" }), /density/);
  // Part: pin.
  const pin = await open("Pin");
  await pin.run("create_sketch", { plane: "XY" });
  await pin.run("add_sketch_entity", { sketchId: pin.view.document.sketches[0].id, type: "circle", values: { x: 0, y: 0, radius: 2.5 } });
  await pin.run("extrude", { sketchId: pin.view.document.sketches[0].id, distance: 20 });

  // Assembly: one plate, two pins.
  const asm = await open("Fixture");
  await asm.run("insert_component", { partDocumentId: plate.id });
  await asm.run("insert_component", { partDocumentId: pin.id, position: [0, 80, 0] });
  await asm.run("insert_component", { partDocumentId: pin.id, position: [30, 80, 0] });
  const [base, pin1, pin2] = asm.view.document.components!;
  assert.equal(base.grounded, true, "the first component is fixed");
  assert.equal(pin2.name, "Pin <2>");
  const bodies = asm.view.geometry.bodies;
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every((b) => b.topology.every((t) => t.bodyId === b.id && t.id.startsWith(`${b.id}:`))), "instance topology is prefixed");
  const bodyOf = (c: { id: string }) => asm.view.geometry.bodies.find((b) => b.id.startsWith(`${c.id}/`))!;
  assert.ok(Math.abs(bodyOf(pin2).bounds[0][0] - 27.5) < 1e-6, "instances are placed by their component");

  // Mate each pin into a hole and onto the top face.
  const holes = () => bodyOf(base).topology.filter((t) => t.kind === "face" && t.geomType === "CYLINDRE");
  const plateTop = () => bodyOf(base).topology.find((t) => t.kind === "face" && t.normal?.[2] === 1 && Math.abs(t.center[2] - 10) < 1e-6)!;
  for (const [c, x] of [[pin1, -40], [pin2, 40]] as const) {
    const wall = bodyOf(c).topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
    const bottom = bodyOf(c).topology.find((t) => t.kind === "face" && t.normal?.[2] === -1)!;
    const hole = holes().find((t) => Math.abs(t.axis!.origin[0] - x) < 1e-6)!;
    await asm.run("add_mate", { type: "concentric", moving: ref(wall), target: ref(hole) });
    await asm.run("add_mate", { type: "coincident", moving: ref(bottom), target: ref(plateTop()) });
  }
  const pinAxis = (c: { id: string }) => axisAt(bodyOf(c).topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE"));
  assert.deepEqual(pinAxis(pin1), [-40, 0]);
  assert.deepEqual(pinAxis(pin2), [40, 0]);
  assert.ok(Math.abs(bodyOf(pin1).bounds[0][2] - 10) < 1e-6, "pin sits on the plate");

  // Edit the part: the assembly follows and the mates still resolve.
  const hole = plate.view.document.features.find((f) => f.type === "hole")!;
  await plate.run("set_hole_positions", { featureId: hole.id, positions: [[-45, 5], [45, 5]] });
  await asm.refresh();
  assert.deepEqual(pinAxis(pin1), [-45, 5]);
  assert.deepEqual(pinAxis(pin2), [45, 5]);

  // BOM counts instances of a part.
  const info = await asm.run("inspect_assembly");
  assert.deepEqual(
    info.bom.map((l: any) => [l.name, l.quantity]),
    [["Plate", 1], ["Pin", 2]],
  );

  // An assembly drawing lists the parts with quantities.
  await asm.run("create_drawing", { name: "Fixture", bodyIds: asm.view.geometry.bodies.map((b) => b.id), size: "A3", scale: 0.5, dimensions: false });
  const sheet = asm.view.document.drawings![0];
  await asm.run("add_drawing_annotation", { drawingId: sheet.id, annotation: { type: "bom", position: [250, 40] } });
  const drawing = await asm.run("render_drawing", { drawingId: sheet.id });
  assert.match(drawing.svg, />Pin</);
  assert.match(drawing.svg, />2</);
  assert.match(drawing.svg, />Aluminum 6061-T6</, "each BOM line shows its part's material");

  // Circular inserts are rejected and leave the part untouched.
  const before = await store.read(pin.id);
  await assert.rejects(pin.run("insert_component", { partDocumentId: asm.id }), /contains this assembly|cannot insert itself/);
  assert.equal((await store.read(pin.id)).revision, before.revision);

  // Deleting an instance removes its mates.
  await asm.run("delete_component", { componentId: pin2.id });
  assert.equal(asm.view.document.mates!.length, 2);
  assert.equal(asm.view.geometry.bodies.length, 2);
});

test("inserted parts: sub-assemblies nest, count as one BOM line and follow edits of their parts", async () => {
  const pin = await open("Dowel");
  await pin.run("create_sketch", { plane: "XY" });
  await pin.run("add_sketch_entity", { sketchId: pin.view.document.sketches[0].id, type: "circle", values: { x: 0, y: 0, radius: 3 } });
  await pin.run("extrude", { sketchId: pin.view.document.sketches[0].id, distance: 10 });
  const pair = await open("Dowel pair");
  await pair.run("insert_component", { partDocumentId: pin.id });
  await pair.run("insert_component", { partDocumentId: pin.id, position: [20, 0, 0] });
  const top = await open("Top assembly");
  await top.run("insert_component", { partDocumentId: pair.id });
  await top.run("insert_component", { partDocumentId: pair.id, position: [0, 30, 0] });
  const bodies = top.view.geometry.bodies;
  assert.equal(bodies.length, 4, "two pairs of two dowels");
  assert.ok(bodies.every((b) => b.id.split("/").length === 3), "nested instance ids carry both component levels");
  assert.ok(bodies.every((b) => b.topology.every((t) => t.id.startsWith(`${b.id}:`))));
  const info = await top.run("inspect_assembly");
  assert.deepEqual(info.bom.map((l: any) => [l.name, l.quantity]), [["Dowel pair", 2]]);
  // A change to the part reaches the top assembly through the sub-assembly.
  const extrude = pin.view.document.features[0];
  await pin.run("set_dimension", { featureId: extrude.id, dimension: "distance", value: 25 });
  await top.refresh();
  assert.ok(top.view.geometry.bodies.every((b) => Math.abs(b.bounds[1][2] - b.bounds[0][2] - 25) < 1e-6));
  // A sub-assembly may not insert the assembly that contains it.
  await assert.rejects(pair.run("insert_component", { partDocumentId: top.id }), /contains this assembly/);
});

test("mates: perpendicular faces and a cylinder tangent to a plane", async () => {
  const block = await open("Block");
  await block.run("create_sketch", { plane: "XY" });
  await block.run("add_sketch_entity", { sketchId: block.view.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 80, height: 40 } });
  await block.run("extrude", { sketchId: block.view.document.sketches[0].id, distance: 10 });
  const roller = await open("Roller");
  await roller.run("create_sketch", { plane: "XY" });
  await roller.run("add_sketch_entity", { sketchId: roller.view.document.sketches[0].id, type: "circle", values: { x: 0, y: 0, radius: 6 } });
  await roller.run("extrude", { sketchId: roller.view.document.sketches[0].id, distance: 30 });
  const asm = await open("Rolling");
  await asm.run("insert_component", { partDocumentId: block.id });
  await asm.run("insert_component", { partDocumentId: roller.id, position: [0, 0, 40] });
  const [base, rod] = asm.view.document.components!;
  const bodyOf = (c: { id: string }) => asm.view.geometry.bodies.find((b) => b.id.startsWith(`${c.id}/`))!;
  const face = (c: { id: string }, normal: number[]) =>
    bodyOf(c).topology.find((t) => t.kind === "face" && t.normal && t.normal.every((x, i) => Math.abs(x - normal[i]) < 1e-9))!;
  const wall = bodyOf(rod).topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
  // Lay the roller's axis perpendicular to the block's side, then roll it onto the top face.
  await asm.run("add_mate", { type: "perpendicular", moving: ref(face(rod, [0, 0, 1])), target: ref(face(base, [0, 0, 1])) });
  await asm.run("add_mate", { type: "tangent", moving: ref(wall), target: ref(face(base, [0, 0, 1])) });
  const placed = bodyOf(rod).topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
  assert.ok(Math.abs(placed.axis!.direction[2]) < 1e-6, "axis lies parallel to the top face");
  assert.ok(Math.abs(placed.axis!.origin[2] - 16) < 1e-6, `axis one radius above the top face: ${placed.axis!.origin[2]}`);
});

test("mated parts move only along the motion their mates leave free", async () => {
  const plate = await open("Drag plate");
  await plate.run("create_sketch", { plane: "XY" });
  await plate.run("add_sketch_entity", { sketchId: plate.view.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 60, height: 40 } });
  await plate.run("extrude", { sketchId: plate.view.document.sketches[0].id, distance: 10 });
  const top = plate.view.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await plate.run("create_hole", { bodyId: plate.view.document.bodies[0].id, face: ref(top), frame: "origin", positions: [[0, 0]], diameter: 8 });
  const pin = await open("Drag pin");
  await pin.run("create_sketch", { plane: "XY" });
  await pin.run("add_sketch_entity", { sketchId: pin.view.document.sketches[0].id, type: "circle", values: { x: 0, y: 0, radius: 4 } });
  await pin.run("extrude", { sketchId: pin.view.document.sketches[0].id, distance: 30 });
  const asm = await open("Drag assembly");
  await asm.run("insert_component", { partDocumentId: plate.id });
  await asm.run("insert_component", { partDocumentId: pin.id, position: [40, 0, 0] });
  const [base, peg] = asm.view.document.components!;
  const bodyOf = (c: { id: string }) => asm.view.geometry.bodies.find((b) => b.id.startsWith(`${c.id}/`))!;
  const wall = bodyOf(peg).topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
  const hole = bodyOf(base).topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
  await asm.run("add_mate", { type: "concentric", moving: ref(wall), target: ref(hole) });
  // Dragging sideways and up: the axis stays on the hole, the height follows the drag.
  await asm.run("set_component_transform", { componentId: peg.id, position: [55, 12, 7], rotation: [0, 0, 0] });
  const axis = () => bodyOf(peg).topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!.axis!;
  assert.ok(Math.hypot(axis().origin[0], axis().origin[1]) < 1e-6, "still concentric with the hole");
  assert.ok(Math.abs(bodyOf(peg).bounds[0][2] - 7) < 1e-6, `slid along its free axis to z = ${bodyOf(peg).bounds[0][2]}`);
  // A face mate removes that freedom: the same drag no longer changes the height.
  const bottom = bodyOf(peg).topology.find((t) => t.kind === "face" && t.normal?.[2] === -1)!;
  const plateTop = bodyOf(base).topology.find((t) => t.kind === "face" && t.normal?.[2] === 1 && Math.abs(t.center[2] - 10) < 1e-6)!;
  await asm.run("add_mate", { type: "coincident", moving: ref(bottom), target: ref(plateTop) });
  await asm.run("set_component_transform", { componentId: peg.id, position: [55, 12, 30], rotation: [0, 0, 0] });
  assert.ok(Math.abs(bodyOf(peg).bounds[0][2] - 10) < 1e-6, "sits on the plate");
  // Fixed parts stay put.
  await assert.rejects(asm.run("set_component_transform", { componentId: base.id, position: [5, 0, 0], rotation: [0, 0, 0] }), /Release the fixed component/);
});

test("component patterns: bolt circles and rows of an inserted part follow the source and count in the BOM", async () => {
  const flange = await open("Flange disc");
  await flange.run("create_sketch", { plane: "XY" });
  await flange.run("add_sketch_entity", { sketchId: flange.view.document.sketches[0].id, type: "circle", values: { x: 0, y: 0, radius: 50 } });
  await flange.run("extrude", { sketchId: flange.view.document.sketches[0].id, distance: 10 });
  const bolt = await open("Bolt");
  await bolt.run("create_sketch", { plane: "XY" });
  await bolt.run("add_sketch_entity", { sketchId: bolt.view.document.sketches[0].id, type: "circle", values: { x: 0, y: 0, radius: 3 } });
  await bolt.run("extrude", { sketchId: bolt.view.document.sketches[0].id, distance: 25 });
  const asm = await open("Bolted flange");
  await asm.run("insert_component", { partDocumentId: flange.id });
  await asm.run("insert_component", { partDocumentId: bolt.id, position: [35, 0, 10] });
  const [disc, first] = asm.view.document.components!;
  const rim = asm.view.geometry.bodies.find((b) => b.id.startsWith(`${disc.id}/`))!.topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
  // Six bolts about the disc's own axis.
  await asm.run("pattern_component", { componentId: first.id, kind: "circular", count: 6, axisRef: ref(rim) });
  const centers = () =>
    asm.view.geometry.bodies
      .filter((b) => b.name.startsWith("Bolt"))
      .map((b) => [(b.bounds[0][0] + b.bounds[1][0]) / 2, (b.bounds[0][1] + b.bounds[1][1]) / 2])
      .map(([x, y]) => (Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360)
      .sort((a, b) => a - b);
  assert.deepEqual(centers(), [0, 60, 120, 180, 240, 300]);
  let info = await asm.run("inspect_assembly");
  assert.deepEqual(info.bom.map((l: any) => [l.name, l.quantity]), [["Flange disc", 1], ["Bolt", 6]]);
  // Moving the source moves every instance: a bolt circle of radius 40.
  await asm.run("set_component_transform", { componentId: first.id, position: [40, 0, 10], rotation: [0, 0, 0] });
  const radii = asm.view.geometry.bodies.filter((b) => b.name.startsWith("Bolt")).map((b) => Math.hypot((b.bounds[0][0] + b.bounds[1][0]) / 2, (b.bounds[0][1] + b.bounds[1][1]) / 2));
  assert.ok(radii.every((r) => Math.abs(r - 40) < 1e-6), `radii ${radii}`);
  // Redefine as a row of three along X at 12 mm.
  const pattern = asm.view.document.componentPatterns![0];
  await asm.run("pattern_component", { patternId: pattern.id, componentId: first.id, kind: "linear", count: 3, spacing: 12, direction: [1, 0, 0] });
  const xs = asm.view.geometry.bodies.filter((b) => b.name.startsWith("Bolt")).map((b) => Math.round((b.bounds[0][0] + b.bounds[1][0]) / 2)).sort((a, b) => a - b);
  assert.deepEqual(xs, [40, 52, 64]);
  info = await asm.run("inspect_assembly");
  assert.equal(info.bom.find((l: any) => l.name === "Bolt").quantity, 3);
  // An instance cannot be the moving side of a mate.
  const instanceFace = asm.view.geometry.bodies.find((b) => b.id.startsWith(`${pattern.id}~1/`))!.topology.find((t) => t.kind === "face" && t.normal?.[2] === -1)!;
  const discTop = asm.view.geometry.bodies.find((b) => b.id.startsWith(`${disc.id}/`))!.topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await assert.rejects(asm.run("add_mate", { type: "coincident", moving: ref(instanceFace), target: ref(discTop) }), /follow their source/);
  // Undo removes the pattern's redefinition, then the pattern.
  await asm.run("undo");
  await asm.run("undo");
  await asm.run("undo");
  assert.equal(asm.view.document.componentPatterns!.length, 0);
  assert.equal(asm.view.geometry.bodies.filter((b) => b.name.startsWith("Bolt")).length, 1);
});
