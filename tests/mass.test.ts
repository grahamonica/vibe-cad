import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import type { Topology, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-mass-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const store = new Store(join(dir, "docs")),
  tools = toolset(store);
const ref = (t: Topology) => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType });
async function run(documentId: string, name: string, args: any = {}): Promise<any> {
  const t = tools.find((t) => t.name === name)!;
  const latest = await store.read(documentId);
  return t.handler(t.schema.parse({ documentId, ...(t.schema.shape.expectedRevision ? { expectedRevision: latest.revision } : {}), ...args }), "assistant");
}
const near = (a: number, b: number, rel = 1e-6, label = "") => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${label} ${a} ≠ ${b}`);
async function part(name: string, entity: any, depth: number) {
  const id = ((await store.create(name)) as View).document.id;
  const v: View = await run(id, "create_sketch", { plane: "XY" });
  await run(id, "add_sketch_entity", { sketchId: v.document.sketches[0].id, ...entity });
  await run(id, "extrude", { sketchId: v.document.sketches[0].id, distance: depth });
  return id;
}

test("mass properties: parts, mass overrides and a whole robot against analytic values", async () => {
  // A steel plate: 100 × 60 × 10 mm, centered on the origin in X and Y.
  const plate = await part("Base plate", { type: "rectangle", values: { x: 0, y: 0, width: 100, height: 60 } }, 10);
  await run(plate, "set_material", { name: "Steel 1018" });
  const m = 100 * 60 * 10 * 7.87e-3;
  const p = await run(plate, "mass_properties");
  near(p.mass, m, 1e-9, "plate mass");
  p.centerOfMass.forEach((v: number, k: number) => near(v, [0, 0, 5][k], 1e-9, "plate CG"));
  near(p.inertia.tensor[0], (m * (60 ** 2 + 10 ** 2)) / 12, 1e-6, "Ixx");
  near(p.inertia.tensor[1], (m * (100 ** 2 + 10 ** 2)) / 12, 1e-6, "Iyy");
  near(p.inertia.tensor[2], (m * (100 ** 2 + 60 ** 2)) / 12, 1e-6, "Izz");
  assert.ok(Math.abs(p.inertia.tensor[3]) < 1e-6 * m * 1e4, "no product of inertia");
  assert.deepEqual(p.missing, []);

  // A purchased motor: no material, its catalog mass typed in.
  const motor = await part("Drive motor", { type: "circle", values: { x: 0, y: 0, radius: 14 } }, 30);
  assert.deepEqual((await run(motor, "mass_properties")).missing, ["Body 1"]);
  await run(motor, "set_mass_properties", { massOverride: 95 });
  const mm = await run(motor, "mass_properties");
  near(mm.mass, 95, 1e-9, "override");
  assert.equal(mm.items[0].source, "override");

  // The robot: the plate, and the motor turned on its side and moved.
  const robot = ((await store.create("Beetle")) as View).document.id;
  await run(robot, "insert_component", { partDocumentId: plate });
  await run(robot, "insert_component", { partDocumentId: motor, position: [30, 0, 10], rotation: [0, 90, 0] });
  const r = await run(robot, "mass_properties");
  const total = m + 95;
  near(r.mass, total, 1e-9, "robot mass");
  // The motor's center: its own center (0, 0, 15) turned 90° about Y, then moved.
  const motorCenter = [30 + 15, 0, 10];
  const expected = [0, 1, 2].map((k) => (m * [0, 0, 5][k] + 95 * motorCenter[k]) / total);
  r.centerOfMass.forEach((v: number, k: number) => near(v, expected[k], 1e-6, `CG ${k}`));
  // Iyy of the robot by the parallel-axis theorem: plate and turned motor.
  const motorIyy = (95 * (3 * 14 ** 2 + 30 ** 2)) / 12;
  const iyy =
    (m * (100 ** 2 + 10 ** 2)) / 12 + m * ((0 - expected[0]) ** 2 + (5 - expected[2]) ** 2) + motorIyy + 95 * ((motorCenter[0] - expected[0]) ** 2 + (motorCenter[2] - expected[2]) ** 2);
  near(r.inertia.tensor[1], iyy, 1e-3, "robot Iyy");

  // The weight class: a 1 kg limit leaves this much.
  await run(robot, "set_mass_properties", { weightLimit: 1000 });
  near((await run(robot, "mass_properties")).remaining, 1000 - total, 1e-9, "margin");
  await run(robot, "set_mass_properties", { weightLimit: 500 });
  assert.ok((await run(robot, "mass_properties")).remaining < 0, "over the class");
  // One component on its own.
  const motorComponent = (await store.read(robot)).components!.find((c) => c.name === "Drive motor")!;
  near((await run(robot, "mass_properties", { componentIds: [motorComponent.id] })).mass, 95, 1e-9, "component filter");
});

test("mass properties: a spinning weapon's inertia, energy, tip speed and imbalance", async () => {
  // A steel disc: radius 50, 10 thick.
  const disc = await part("Weapon disc", { type: "circle", values: { x: 0, y: 0, radius: 50 } }, 10);
  await run(disc, "set_material", { name: "Steel 1018" });
  const v = await store.view(await store.read(disc));
  const rim = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
  const m = Math.PI * 50 ** 2 * 10 * 7.87e-3;
  const s = (await run(disc, "mass_properties", { spin: { axis: { ref: ref(rim) }, rpm: 12000 } })).spin;
  const I = 0.5 * m * 50 ** 2,
    w = (12000 * 2 * Math.PI) / 60;
  near(s.inertia, I, 1e-6, "I about the axis");
  near(s.energy, 0.5 * I * 1e-9 * w * w, 1e-6, "energy");
  near(s.radius, 50, 1e-6, "radius");
  near(s.tipSpeed, 0.05 * w, 1e-6, "tip speed");
  assert.ok(s.offset < 1e-9 && s.imbalanceForce < 1e-6, "balanced");

  // A hole off the axis unbalances it: the bearing force follows m·e·ω².
  const face = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await run(disc, "create_hole", { bodyId: v.document.bodies[0].id, face: ref(face), frame: "origin", positions: [[30, 0]], diameter: 10 });
  const holed = await run(disc, "mass_properties", { spin: { axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, rpm: 12000 } });
  const hole = Math.PI * 25 * 10 * 7.87e-3,
    mass = m - hole,
    e = (hole * 30) / mass;
  near(holed.mass, mass, 1e-6, "holed mass");
  near(holed.spin.offset, e, 1e-6, "offset");
  near(holed.spin.imbalanceForce, mass * 1e-3 * e * 1e-3 * w * w, 1e-6, "force");
  near(holed.spin.inertia, I - (0.5 * hole * 25 + hole * 900), 1e-6, "inertia with the hole");
});

test("plate DXF: a 1:1 cutting outline with exact holes and rounded corners", async () => {
  const plate = await part("Side armor", { type: "rectangle", values: { x: 0, y: 0, width: 100, height: 60 } }, 6);
  const v = await store.view(await store.read(plate));
  const body = v.document.bodies[0].id;
  const top = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await run(plate, "create_hole", { bodyId: body, face: ref(top), frame: "origin", positions: [[25, 0], [-25, 0]], diameter: 8 });
  const w = await store.view(await store.read(plate));
  const corner = w.geometry.bodies[0].topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[0] - 50) < 1e-6 && Math.abs(t.center[1] - 30) < 1e-6)!;
  await run(plate, "fillet_edges", { bodyId: body, radius: 5, edges: [ref(corner)] });
  const face = (await store.view(await store.read(plate))).geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  const out = await run(plate, "export_face_dxf", { face: ref(face) });
  near(out.width, 100, 1e-9, "width");
  near(out.height, 60, 1e-9, "height");
  near(out.thickness, 6, 1e-9, "thickness");
  assert.match(out.filename, /Body-1-6mm\.dxf$|6mm\.dxf$/);
  const dxf = await (await import("node:fs/promises")).readFile(out.path, "utf8");
  const codes = dxf.split("\n");
  const entities = (name: string) => codes.reduce((list: Record<string, number>[], c, i) => {
    if (c === name && codes[i - 1] === "0") {
      const e: Record<string, number> = {};
      for (let j = i + 1; j < codes.length - 1 && codes[j] !== "0"; j += 2) e[codes[j]] = Number(codes[j + 1]);
      list.push(e);
    }
    return list;
  }, []);
  const circles = entities("CIRCLE"),
    arcs = entities("ARC"),
    lines = entities("LINE");
  assert.deepEqual(circles.map((c) => [c["10"], c["20"], c["40"]]).sort((a, b) => a[0] - b[0]), [[25, 30, 4], [75, 30, 4]]);
  assert.equal(arcs.length, 1);
  assert.deepEqual([arcs[0]["10"], arcs[0]["20"], arcs[0]["40"], arcs[0]["50"], arcs[0]["51"]], [95, 55, 5, 0, 90]);
  assert.equal(lines.length, 4);
  assert.match(dxf, /\$INSUNITS\n70\n4\n/);
  // The same plate in inches for a US shop.
  const inch = await run(plate, "export_face_dxf", { face: ref(face), units: "in" });
  const text = await (await import("node:fs/promises")).readFile(inch.path, "utf8");
  assert.match(text, /\$INSUNITS\n70\n1\n/);
  assert.ok(text.includes(String(Math.round((100 / 25.4) * 1e6) / 1e6)), "100 mm written as inches");
  await assert.rejects(run(plate, "export_face_dxf", { face: ref(face).kind === "face" ? { ...ref(corner) } : ref(face) }), /planar face/);
});

test("materials: a full library with properties, custom materials for every document, and printed parts", async () => {
  const listing = await tools.find((t) => t.name === "list_materials")!.handler({}, "assistant");
  const names = listing.materials.map((m: any) => m.name);
  for (const name of ["PLA (printed)", "TPU 95A (printed)", "Nylon PA12 (printed)", "Aluminum 6061-T6", "Steel 1018", "Stainless steel 304", "Tool steel S7 (hardened)", "Bronze (SAE 660 bearing)", "Brass C360", "Iron (wrought)", "Cast iron (gray, class 40)", "Titanium grade 5 (Ti-6Al-4V)", "UHMW polyethylene", "Polycarbonate", "Carbon fiber sheet (quasi-isotropic)"])
    assert.ok(names.includes(name), name);
  const al = listing.materials.find((m: any) => m.name === "Aluminum 6061-T6");
  assert.deepEqual([al.density, al.modulus, al.yield, al.tensile], [2.7, 68.9, 276, 310]);

  // A custom material saved once is available to every document, and documents keep a copy.
  const save = tools.find((t) => t.name === "save_material")!;
  await assert.rejects(save.handler(save.schema.parse({ name: "Steel 1018", density: 7.9 }), "user"), /built-in/);
  await save.handler(save.schema.parse({ name: "Hardox 500", density: 7.85, yield: 1400, tensile: 1550 }), "user");
  const plate = await part("Wedge", { type: "rectangle", values: { x: 0, y: 0, width: 100, height: 50 } }, 4);
  await run(plate, "set_material", { name: "hardox 500" });
  const doc = await store.read(plate);
  assert.deepEqual([doc.material!.name, doc.material!.density, doc.material!.yield], ["Hardox 500", 7.85, 1400]);
  near((await run(plate, "mass_properties")).mass, 100 * 50 * 4 * 7.85e-3, 1e-9, "custom mass");
  await tools.find((t) => t.name === "delete_material")!.handler({ name: "Hardox 500" }, "user");
  near((await run(plate, "mass_properties")).mass, 100 * 50 * 4 * 7.85e-3, 1e-9, "still has its copy");

  // A printed block: solid walls around a 25% interior.
  const block = await part("Printed wheel hub", { type: "rectangle", values: { x: 0, y: 0, width: 40, height: 40 } }, 20);
  await run(block, "set_material", { name: "PLA (printed)", infill: 25, wall: 2 });
  const volume = 40 * 40 * 20,
    area = 2 * 40 * 40 + 4 * 40 * 20,
    shell = area * 2;
  const printed = await run(block, "mass_properties");
  near(printed.mass, ((shell + 0.25 * (volume - shell)) * 1.24) / 1000, 1e-9, "printed mass");
  assert.ok(printed.mass < (volume * 1.24) / 1000, "lighter than solid");
  printed.centerOfMass.forEach((v: number, k: number) => near(v, [0, 0, 10][k], 1e-9, "printed CG"));
  await assert.rejects(run(block, "set_material", { name: "Aluminum 6061-T6", infill: 50 }), /printed materials/);
  // 100% infill is the solid mass.
  await run(block, "set_material", { name: "PLA (printed)", infill: 100 });
  near((await run(block, "mass_properties")).mass, (volume * 1.24) / 1000, 1e-9, "solid print");
});

test("motion check: a spinning bar hits a block, and clears it when the block is raised", async () => {
  const bar = await part("Weapon bar", { type: "rectangle", values: { x: 0, y: 0, width: 120, height: 20 } }, 10);
  const barView = await store.view(await store.read(bar));
  const top = barView.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await run(bar, "create_hole", { bodyId: barView.document.bodies[0].id, face: ref(top), frame: "origin", positions: [[0, 0]], diameter: 10 });
  const shaft = await part("Shaft", { type: "circle", values: { x: 0, y: 0, radius: 5 } }, 40);
  const block = await part("Block", { type: "rectangle", values: { x: 0, y: 0, width: 20, height: 20 } }, 10);
  const robot = ((await store.create("Spinner")) as View).document.id;
  await run(robot, "insert_component", { partDocumentId: shaft, position: [0, 0, -15] });
  await run(robot, "insert_component", { partDocumentId: bar });
  await run(robot, "insert_component", { partDocumentId: block, position: [0, 45, 0] });
  let doc = await store.read(robot);
  const [shaftC, barC, blockC] = doc.components!;
  const view = await store.view(doc);
  const face = (c: { id: string }, pred: (t: Topology) => boolean) => view.geometry.bodies.find((b) => b.id.startsWith(`${c.id}/`))!.topology.find(pred)!;
  const bore = face(barC, (t) => t.kind === "face" && t.geomType === "CYLINDRE");
  const pin = face(shaftC, (t) => t.kind === "face" && t.geomType === "CYLINDRE");
  await run(robot, "add_mate", { type: "concentric", moving: ref(bore), target: ref(pin) });
  // The axis comes from the concentric mate; the bar sweeps through the block twice per turn.
  const hit = await run(robot, "check_motion", { componentId: barC.id, against: [blockC.id] });
  assert.equal(hit.steps.length, 37);
  near(hit.steps[0].clearance, 25, 1e-6, "clearance at rest");
  assert.ok(hit.collides);
  const angles = hit.collisions.map((c: any) => Math.round(c.value));
  assert.ok(angles.includes(90) && angles.includes(270) && !angles.includes(0) && !angles.includes(180), `collisions at ${angles}`);
  assert.deepEqual(hit.collisions[0].with, ["Block"]);
  // Raised 20 mm, the block clears the bar by 10 mm all the way round.
  await run(robot, "set_component_transform", { componentId: blockC.id, position: [0, 45, 20], rotation: [0, 0, 0] });
  const clear = await run(robot, "check_motion", { componentId: barC.id, against: [blockC.id] });
  assert.equal(clear.collides, false);
  near(clear.minimumClearance.value, 10, 1e-6, "minimum clearance");
  // Sliding the bar toward the raised block along Y passes under it.
  const slide = await run(robot, "check_motion", { componentId: barC.id, kind: "translate", axis: { origin: [0, 0, 0], direction: [0, 1, 0] }, from: 0, to: 40, steps: 4, against: [blockC.id] });
  assert.equal(slide.collides, false, "passes under the raised block");
  near(slide.minimumClearance.value, 10, 1e-6, "gap under the block");
  // At the end of the slide the bar sits right under the block.
  const lift = await run(robot, "check_motion", { componentId: barC.id, kind: "translate", axis: { origin: [0, 0, 0], direction: [0, 1, 0] }, from: 40, to: 40, steps: 1, against: [blockC.id] });
  near(lift.minimumClearance.value, 10, 1e-6, "under the block");
  await assert.rejects(run(robot, "check_motion", { componentId: blockC.id }), /concentric/);
  doc = await store.read(robot);
});

test("hole series: aligned holes through stacked plates, each a feature in its own part", async () => {
  const top = await part("Top plate", { type: "rectangle", values: { x: 0, y: 0, width: 100, height: 60 } }, 6);
  const standoff = await part("Standoff", { type: "rectangle", values: { x: 0, y: 0, width: 16, height: 16 } }, 20);
  const bottom = await part("Bottom plate", { type: "rectangle", values: { x: 0, y: 0, width: 100, height: 60 } }, 6);
  const robot = ((await store.create("Chassis stack")) as View).document.id;
  await run(robot, "insert_component", { partDocumentId: bottom });
  // The standoff sits at x = 30, y = 15 between the plates; the top plate is turned 180° about Z.
  await run(robot, "insert_component", { partDocumentId: standoff, position: [30, 15, 6] });
  await run(robot, "insert_component", { partDocumentId: top, position: [0, 0, 26], rotation: [0, 0, 180] });
  const view = await store.view(await store.read(robot));
  const topComponent = (await store.read(robot)).components!.find((c) => c.name === "Top plate")!;
  const face = view.geometry.bodies.find((b) => b.id.startsWith(`${topComponent.id}/`))!.topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  const volumes = async () => Object.fromEntries((await store.view(await store.read(robot))).geometry.bodies.map((b) => [b.name, b.volume]));
  const before = await volumes();
  await run(robot, "create_hole_series", { face: ref(face), positions: [[30, 15]], size: "M4", start: "counterbore", end: "tapped" });
  const holes = async (id: string) => (await store.read(id)).features.filter((f) => f.type === "hole");
  assert.equal((await holes(top))[0].params.holeType, "counterbore");
  assert.equal((await holes(standoff))[0].params.holeType, "simple");
  assert.equal((await holes(bottom))[0].params.holeType, "tapped");
  // In each part's own coordinates: the turned top plate gets its hole at (-30, -15); the standoff at its center.
  const at = (f: any) => f.params.positions[0].map((v: number) => Math.round(v * 1e6) / 1e6 + 0);
  assert.deepEqual(at((await holes(top))[0]), [-30, -15]);
  assert.deepEqual(at((await holes(standoff))[0]), [0, 0]);
  assert.deepEqual(at((await holes(bottom))[0]), [30, 15]);
  const after = await volumes();
  for (const name of ["Top plate", "Standoff", "Bottom plate"]) assert.ok(after[name] < before[name], `${name} drilled`);
  assert.match((await store.read(robot)).history.at(-1)!.description, /Hole series through Top plate, Standoff, Bottom plate/);
  // Axes that miss every part are refused, and nothing is drilled.
  const counts = await Promise.all([top, standoff, bottom].map(async (id) => (await holes(id)).length));
  await assert.rejects(run(robot, "create_hole_series", { face: ref(face), positions: [[200, 200]], size: "M4" }), /do not pass through/);
  assert.deepEqual(await Promise.all([top, standoff, bottom].map(async (id) => (await holes(id)).length)), counts);
});
