import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import { beltLength } from "../cad/drives.ts";
import type { View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-drives-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const store = new Store(join(dir, "docs")),
  tools = toolset(store);
async function run(documentId: string, name: string, args: any = {}): Promise<any> {
  const t = tools.find((t) => t.name === name)!;
  const latest = await store.read(documentId);
  return t.handler(t.schema.parse({ documentId, ...(t.schema.shape.expectedRevision ? { expectedRevision: latest.revision } : {}), ...args }), "assistant");
}
const near = (a: number, b: number, tol: number, label: string) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);

test("gears: involute spur gears of the right size that mesh without overlap", async () => {
  const id = ((await store.create("Gearbox")) as View).document.id;
  let v: View = await run(id, "create_gear", { module: 2, teeth: 20, width: 10, bore: 8 });
  const gear = v.geometry.bodies[0];
  // Outside diameter m(N + 2) = 44; the teeth fill about half the ring between root and tip.
  near(gear.bounds[1][0] - gear.bounds[0][0], 44, 0.01, "outside diameter");
  const ring = Math.PI * (22 ** 2 - 17.5 ** 2) * 10,
    core = Math.PI * (17.5 ** 2 - 4 ** 2) * 10;
  assert.ok(gear.volume > core + 0.35 * ring && gear.volume < core + 0.65 * ring, `gear volume ${gear.volume}`);
  assert.ok(gear.topology.some((t) => t.kind === "face" && t.geomType === "CYLINDRE" && Math.abs((t.radius ?? 0) - 4) < 1e-6), "bore");
  // A second gear 40 mm away (m(20 + 20) / 2) turned half a tooth meshes; tip to tip, the teeth collide.
  v = await run(id, "create_gear", { module: 2, teeth: 20, width: 10, center: [40, 0], phase: 9 });
  const [a, b] = v.geometry.bodies.map((x) => x.id);
  const meshed = await run(id, "analyze_interference", { bodyA: a, bodyB: b });
  // The default backlash (0.04 × module for the pair) leaves meshing teeth clear of each other.
  assert.equal(v.document.features[1].params.backlash, 0.08);
  assert.ok(meshed.volume < 1e-6, `meshing gears overlap by ${meshed.volume} mm³`);
  await run(id, "create_gear", { featureId: v.document.features[1].id, module: 2, teeth: 20, width: 10, center: [40, 0], phase: 0 });
  const clash = await run(id, "analyze_interference", { bodyA: a, bodyB: b });
  assert.ok(clash.volume > 10, `aligned teeth should clash (${clash.volume} mm³)`);
  await assert.rejects(run(id, "create_gear", { module: 1, teeth: 12, width: 5, bore: 12 }), /bore is too large/);
});

test("pulleys and belts: outside diameter from the belt pitch, belt length and tooth count", async () => {
  const small = ((await store.create("Pulley 20T")) as View).document.id;
  const p20: View = await run(small, "create_pulley", { belt: "HTD 5M", teeth: 20, width: 15, bore: 8, flanges: false });
  const od = (20 * 5) / Math.PI - 2 * 0.5715;
  const vertices = p20.geometry.bodies[0].mesh.vertices;
  let reach = 0;
  for (let i = 0; i < vertices.length; i += 3) reach = Math.max(reach, Math.hypot(vertices[i], vertices[i + 1]));
  near(2 * reach, od, 0.01, "pulley outside diameter");
  const large = ((await store.create("Pulley 40T")) as View).document.id;
  await run(large, "create_pulley", { belt: "HTD 5M", teeth: 40, width: 15, bore: 10 });
  const flanged = (await store.view(await store.read(large))).geometry.bodies[0];
  near(flanged.bounds[1][2] - flanged.bounds[0][2], 17, 1e-6, "flanged width");
  // In an assembly, 120 mm apart on parallel shafts.
  const drive = ((await store.create("Weapon drive")) as View).document.id;
  await run(drive, "insert_component", { partDocumentId: small, position: [0, 0, 0] });
  await run(drive, "insert_component", { partDocumentId: large, position: [120, 0, 0] });
  const [c1, c2] = (await store.read(drive)).components!;
  const info = await run(drive, "belt_length", { pulleys: [c1.id, c2.id] });
  const r1 = (20 * 5) / (2 * Math.PI),
    r2 = (40 * 5) / (2 * Math.PI);
  near(info.centerDistance, 120, 1e-6, "center distance");
  near(info.pitchLength, beltLength(r1, r2, 120), 1e-6, "pitch length");
  assert.equal(info.standardTeeth, Math.round(beltLength(r1, r2, 120) / 5));
  near(beltLength(r1, r2, info.centerForStandard), info.standardTeeth * 5, 1e-6, "center for the standard belt");
  // The belt: generated over the pulleys, its body named for ordering, and the right size.
  let v: View = await run(drive, "create_belt", { pulleys: [c1.id, c2.id], width: 14 });
  const beltComponent = v.document.components!.at(-1)!;
  assert.equal(beltComponent.name, "Belt 1");
  let beltBody = v.geometry.bodies.find((b) => b.id === `${beltComponent.id}/belt`)!;
  assert.equal(beltBody.name, `HTD 5M belt ${info.standardTeeth}T ${info.standardTeeth * 5} mm`);
  const ring = (ri1: number, ri2: number, t: number, c: number) => {
    // Area between two belt loops: the outer loop's area less the inner's.
    const area = (x: number, y: number) => {
      const phi = Math.asin((x - y) / c);
      return (x + y) * c * Math.cos(phi) + x * x * (Math.PI / 2 + phi) + y * y * (Math.PI / 2 - phi);
    };
    return area(ri1 + t, ri2 + t) - area(ri1, ri2);
  };
  near(beltBody.volume, ring(r1 - 0.5715, r2 - 0.5715, 3.8, 120) * 14, 0.01 * beltBody.volume, "belt volume");
  near(beltBody.bounds[1][2] - beltBody.bounds[0][2], 14, 1e-6, "belt width");
  near(beltBody.mass!, (beltBody.volume * 1.25) / 1000, 1e-9, "neoprene belt mass");
  // 120 mm is not a whole-tooth center distance: the assembly says what the belt needs.
  assert.ok(v.geometry.warnings.some((w) => w.includes(`needs ${info.centerForStandard.toFixed(2)} mm`)), v.geometry.warnings.join("; "));
  // Moving the large pulley out to 130 mm stretches the belt to the next size; at the exact distance the warning goes.
  v = await run(drive, "set_component_transform", { componentId: c2.id, position: [130, 0, 0], rotation: [0, 0, 0] });
  beltBody = v.geometry.bodies.find((b) => b.id === `${beltComponent.id}/belt`)!;
  const teeth130 = Math.round(beltLength(r1, r2, 130) / 5);
  assert.equal(beltBody.name, `HTD 5M belt ${teeth130}T ${teeth130 * 5} mm`);
  near(beltBody.volume, ring(r1 - 0.5715, r2 - 0.5715, 3.8, 130) * 14, 0.01 * beltBody.volume, "stretched belt volume");
  const exact = (await run(drive, "belt_length", { pulleys: [c1.id, c2.id] })).centerForStandard;
  v = await run(drive, "set_component_transform", { componentId: c2.id, position: [exact, 0, 0], rotation: [0, 0, 0] });
  assert.ok(!v.geometry.warnings.some((w) => w.includes("Belt 1")), v.geometry.warnings.join("; "));
  // The BOM orders it by size; a pulley it runs on cannot be deleted from under it, nor can the belt be mated.
  const bom = (await run(drive, "inspect_assembly")).bom;
  assert.ok(bom.some((line: any) => line.name === `HTD 5M belt ${teeth130}T ${teeth130 * 5} mm` && line.quantity === 1), JSON.stringify(bom));
  await assert.rejects(run(drive, "delete_component", { componentId: c2.id }), /Belt 1 runs on/);
  const beltFace = (v.geometry.bodies.find((b) => b.id === `${beltComponent.id}/belt`)!.topology.find((t) => t.kind === "face" && t.geomType === "PLANE"))!;
  const pulleyFace = v.geometry.bodies.find((b) => b.id.startsWith(`${c1.id}/`))!.topology.find((t) => t.kind === "face" && t.geomType === "PLANE")!;
  const refOf = (t: any) => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType });
  await assert.rejects(run(drive, "add_mate", { type: "coincident", moving: refOf(beltFace), target: refOf(pulleyFace) }), /follows its pulleys/);
  // Turning a pulley, the belt on it runs with it: it is not a collision.
  const bore = v.geometry.bodies.find((b) => b.id.startsWith(`${c2.id}/`))!.topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE" && Math.abs((t.radius ?? 0) - 5) < 1e-6)!;
  const spin = await run(drive, "check_motion", { componentId: c2.id, axis: { ref: refOf(bore) }, steps: 4 });
  assert.equal(spin.collides, false);
  assert.notEqual(spin.minimumClearance.with, "Belt 1");
  await assert.rejects(run(drive, "belt_length", { pulleys: [c1.id, c1.id] }), /overlap|apart/);
});

test("gear mates: a gear train turns together, keeps its mesh through a full turn, and a clash shows", async () => {
  // A 20-30-20 train of module 2 gears with backlash, 50 mm between centers.
  const part = async (name: string, teeth: number) => {
    const id = ((await store.create(name)) as View).document.id;
    await run(id, "create_gear", { module: 2, teeth, width: 10, bore: 8 });
    return id;
  };
  const [g20, g30] = [await part("Pinion", 20), await part("Idler", 30)];
  const asm = ((await store.create("Gear train")) as View).document.id;
  let v: View = await run(asm, "insert_component", { partDocumentId: g20, grounded: false, name: "Driver" });
  // The idler turned half a tooth (6°) meshes with the driver; the last gear meshes as placed.
  v = await run(asm, "insert_component", { partDocumentId: g30, position: [50, 0, 0], rotation: [0, 0, 6], name: "Idler" });
  v = await run(asm, "insert_component", { partDocumentId: g20, position: [100, 0, 0], name: "Output" });
  const [A, B, C] = v.document.components!;
  const ref = (t: any) => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType });
  const bore = (cid: string) => ref(v.geometry.bodies.flatMap((b) => b.topology).find((t) => t.bodyId.startsWith(`${cid}/`) && t.kind === "face" && t.geomType === "CYLINDRE" && Math.abs((t.radius ?? 0) - 4) < 1e-6)!);
  assert.equal(v.geometry.bodies.find((b) => b.id.startsWith(`${A.id}/`))!.drive?.teeth, 20);
  // The ratio comes from the teeth: the idler turns 20/30 per turn of the driver, the output 30/20 per idler turn.
  v = await run(asm, "add_mate", { type: "gear", moving: bore(B.id), target: bore(A.id) });
  v = await run(asm, "add_mate", { type: "gear", moving: bore(C.id), target: bore(B.id) });
  const [ab, bc] = v.document.mates!;
  near(ab.value, 2 / 3, 1e-12, "idler ratio");
  near(bc.value, 1.5, 1e-12, "output ratio");
  assert.equal(ab.aligned, false);
  const turn = (view: View, cid: string) => {
    const p = view.geometry.placements![view.geometry.bodies.find((b) => b.id.startsWith(`${cid}/`))!.id];
    return (2 * Math.atan2(p.quaternion[2], p.quaternion[3]) * 180) / Math.PI;
  };
  // Adding the mates moved nothing.
  near(turn(v, B.id), 6, 1e-6, "idler stays");
  near(turn(v, C.id), 0, 1e-6, "output stays");
  // Turning the driver 30° turns the idler back 20° and the output forward 30°, about their own axes.
  v = await run(asm, "set_component_transform", { componentId: A.id, position: [0, 0, 0], rotation: [0, 0, 30] });
  near(turn(v, A.id), 30, 1e-6, "driver");
  near(turn(v, B.id), 6 - 20, 1e-6, "idler");
  near(turn(v, C.id), 30, 1e-6, "output");
  const center = (view: View, cid: string) => view.geometry.bodies.flatMap((b) => b.topology).find((t) => t.id === bore(cid).id)!.axis!.origin;
  near(center(v, C.id)[0], 100, 1e-6, "the output stays on its axis");

  // A full turn of the driver: the train turns with it and every mesh clears.
  const motion = await run(asm, "check_motion", { componentId: A.id, axis: { ref: bore(A.id) }, steps: 12 });
  assert.equal(motion.collides, false, JSON.stringify(motion.collisions));
  // Meshing gears always touch and stay out of the clearance; the driver and output, 100 apart, clear by 56.
  near(motion.minimumClearance.value, 100 - 22 - 22, 1e-6, "driver to output");
  assert.equal(motion.minimumClearance.with, "Output");
  // Half a tooth out of phase, the output clashes with the idler at every step.
  await run(asm, "edit_mate", { mateId: bc.id, phase: (bc.phase ?? 0) + 9 });
  const clash = await run(asm, "check_motion", { componentId: A.id, axis: { ref: bore(A.id) }, steps: 12 });
  assert.equal(clash.collisions.length, 13);
  assert.ok(clash.collisions.every((c: any) => c.with.includes("Idler hits Output") && c.volume > 10), JSON.stringify(clash.collisions[5]));

  // A gear mate needs a ratio when the parts are not gears, stays a gear mate, and takes a positive ratio.
  const rod = ((await store.create("Rod")) as View).document.id;
  let r: View = await run(rod, "create_sketch", { plane: "XY" });
  await run(rod, "add_sketch_entity", { sketchId: r.document.sketches[0].id, type: "circle", values: { x: 0, y: 0, radius: 4 } });
  await run(rod, "extrude", { sketchId: r.document.sketches[0].id, distance: 20 });
  v = await run(asm, "insert_component", { partDocumentId: rod, position: [0, 80, 0], name: "Rod" });
  const rodFace = ref(v.geometry.bodies.flatMap((b) => b.topology).find((t) => t.bodyId.startsWith(`${v.document.components!.at(-1)!.id}/`) && t.geomType === "CYLINDRE")!);
  await assert.rejects(run(asm, "add_mate", { type: "gear", moving: rodFace, target: bore(A.id) }), /Give the gear ratio/);
  await assert.rejects(run(asm, "edit_mate", { mateId: ab.id, type: "concentric" }), /stays a gear mate/);
  await assert.rejects(run(asm, "edit_mate", { mateId: ab.id, value: -1 }), /must be positive/);
});
