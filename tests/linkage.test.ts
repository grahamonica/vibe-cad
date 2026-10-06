import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import type { Topology, Vec3, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-linkage-"));
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
const ref = (t: Topology) => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType });
const near = (a: number, b: number, tol: number, label: string) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);

/** A 5 mm bar with Ø6 holes at (0, 0) and (length, 0). */
async function bar(name: string, length: number, width = 12) {
  const id = ((await store.create(name)) as View).document.id;
  let v: View = await run(id, "create_sketch", { plane: "XY" });
  await run(id, "add_sketch_entity", { sketchId: v.document.sketches[0].id, type: "rectangle", values: { x: length / 2, y: 0, width: length + 12, height: width } });
  v = await run(id, "extrude", { sketchId: v.document.sketches[0].id, distance: 5 });
  const top = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await run(id, "create_hole", { bodyId: v.document.bodies[0].id, face: ref(top), frame: "origin", positions: [[0, 0], [length, 0]], diameter: 6 });
  return id;
}
/** A four-bar: ground pivots A (0, 0) and D (100, 0); crank 40, coupler 120, rocker 80. */
export async function fourBar() {
  const [ground, crank, coupler, rocker] = [await bar("Base", 100, 20), await bar("Crank", 40), await bar("Coupler", 120), await bar("Rocker", 80)];
  const asm = ((await store.create("Lifter")) as View).document.id;
  let v: View = await run(asm, "insert_component", { partDocumentId: ground, name: "Base" });
  // Roughly placed: the coupler is 126 mm between the pins it will join, so the loop has to close.
  v = await run(asm, "insert_component", { partDocumentId: crank, position: [0, 0, 5], rotation: [0, 0, 90], name: "Crank" });
  // The rocker runs a layer above the coupler, on a spacer: no link can hit another.
  v = await run(asm, "insert_component", { partDocumentId: rocker, position: [100, 0, 15], rotation: [0, 0, 75], name: "Rocker" });
  v = await run(asm, "insert_component", { partDocumentId: coupler, position: [0, 40, 10], rotation: [0, 0, 17.2], name: "Coupler" });
  const ids = Object.fromEntries(v.document.components!.map((c) => [c.name, c.id]));
  const topo = () => v.geometry.bodies.flatMap((b) => b.topology);
  /** A component's hole nearest a point, and its top and bottom faces. */
  const hole = (name: string, at: [number, number]) =>
    topo()
      .filter((t) => t.bodyId.startsWith(`${ids[name]}/`) && t.kind === "face" && t.geomType === "CYLINDRE" && Math.abs((t.radius ?? 0) - 3) < 1e-6)
      .sort((p, q) => Math.hypot(p.axis!.origin[0] - at[0], p.axis!.origin[1] - at[1]) - Math.hypot(q.axis!.origin[0] - at[0], q.axis!.origin[1] - at[1]))[0];
  const face = (name: string, z: 1 | -1) => topo().find((t) => t.bodyId.startsWith(`${ids[name]}/`) && t.kind === "face" && t.normal?.[2] === z)!;
  const mate = async (type: string, moving: Topology, target: Topology) => {
    v = await run(asm, "add_mate", { type, moving: ref(moving), target: ref(target) });
  };
  await mate("concentric", hole("Crank", [0, 0]), hole("Base", [0, 0]));
  await mate("coincident", face("Crank", -1), face("Base", 1));
  await mate("concentric", hole("Rocker", [100, 0]), hole("Base", [100, 0]));
  v = await run(asm, "add_mate", { type: "distance", moving: ref(face("Rocker", -1)), target: ref(face("Base", 1)), value: 10 });
  await mate("concentric", hole("Coupler", [0, 40]), hole("Crank", [0, 40]));
  await mate("coincident", face("Coupler", -1), face("Crank", 1));
  // The last pin closes the loop.
  await mate("concentric", hole("Coupler", [120, 37]), hole("Rocker", [120.7, 77.3]));
  return { asm, ids, hole, face, rocker, get view() { return v; }, set view(x: View) { v = x; } };
}
/** Where a component's local point lands. */
const placed = (v: View, componentId: string, local: Vec3) => {
  const body = v.geometry.bodies.find((b) => b.id.startsWith(`${componentId}/`))!;
  const p = v.geometry.placements![body.id];
  const [x, y, z, w] = p.quaternion;
  // Rotate by the quaternion, then move.
  const [px, py, pz] = local;
  const ix = w * px + y * pz - z * py,
    iy = w * py + z * px - x * pz,
    iz = w * pz + x * py - y * px,
    iw = -x * px - y * py - z * pz;
  return [ix * w + iw * -x + iy * -z - iz * -y + p.position[0], iy * w + iw * -y + iz * -x - ix * -z + p.position[1], iz * w + iw * -z + ix * -y - iy * -x + p.position[2]] as Vec3;
};
/** The rocker pin for a crank angle: the circles about B (120) and D (80) meet, on the branch above the base. */
const rockerPin = (crank: number): [number, number] => {
  const B: [number, number] = [40 * Math.cos(crank), 40 * Math.sin(crank)],
    D: [number, number] = [100, 0];
  const d = Math.hypot(D[0] - B[0], D[1] - B[1]),
    a = (120 ** 2 - 80 ** 2 + d * d) / (2 * d),
    h = Math.sqrt(120 ** 2 - a * a);
  const ux = (D[0] - B[0]) / d,
    uy = (D[1] - B[1]) / d;
  const options: [number, number][] = [
    [B[0] + a * ux - h * uy, B[1] + a * uy + h * ux],
    [B[0] + a * ux + h * uy, B[1] + a * uy - h * ux],
  ];
  return options.sort((p, q) => q[1] - p[1])[0];
};
const closes = (v: View, ids: Record<string, string>, label: string) => {
  const A = placed(v, ids.Crank, [0, 0, 0]),
    B = placed(v, ids.Crank, [40, 0, 0]),
    B2 = placed(v, ids.Coupler, [0, 0, 0]),
    C = placed(v, ids.Coupler, [120, 0, 0]),
    C2 = placed(v, ids.Rocker, [80, 0, 0]),
    D = placed(v, ids.Rocker, [0, 0, 0]);
  near(Math.hypot(A[0], A[1]), 0, 1e-6, `${label}: crank on its pivot`);
  near(Math.hypot(D[0] - 100, D[1]), 0, 1e-6, `${label}: rocker on its pivot`);
  near(Math.hypot(B[0] - B2[0], B[1] - B2[1]), 0, 1e-6, `${label}: crank pin`);
  near(Math.hypot(C[0] - C2[0], C[1] - C2[1]), 0, 1e-6, `${label}: rocker pin`);
  near(B2[2], 10, 1e-6, `${label}: coupler on the crank`);
  return { B, C };
};

test("linkages: a loop of mates closes, and turning the crank moves the four-bar", async () => {
  const f = await fourBar();
  // Closed: every pin in its hole, nothing pulled apart.
  closes(f.view, f.ids, "closed");
  // Turn the crank to 60°: it stays there, and coupler and rocker follow the four-bar's own geometry.
  for (const angle of [60, 120]) {
    f.view = await run(f.asm, "set_component_transform", { componentId: f.ids.Crank, position: [0, 0, 5], rotation: [0, 0, angle] });
    const { B, C } = closes(f.view, f.ids, `${angle}°`);
    near(B[0], 40 * Math.cos((angle * Math.PI) / 180), 1e-6, `crank pin x at ${angle}°`);
    near(B[1], 40 * Math.sin((angle * Math.PI) / 180), 1e-6, `crank pin y at ${angle}°`);
    const [cx, cy] = rockerPin((angle * Math.PI) / 180);
    near(C[0], cx, 1e-6, `rocker pin x at ${angle}°`);
    near(C[1], cy, 1e-6, `rocker pin y at ${angle}°`);
  }
  // The solved poses are kept: the stored placements are the ones shown.
  const doc = await store.read(f.asm);
  const rocker = doc.components!.find((c) => c.id === f.ids.Rocker)!;
  const [cx, cy] = rockerPin((120 * Math.PI) / 180);
  near(rocker.rotation[2], (Math.atan2(cy, cx - 100) * 180) / Math.PI, 1e-6, "stored rocker angle");
});

test("linkages: a motion check sweeps the mechanism, finds what it hits, and stops where the linkage cannot reach", async () => {
  const f = await fourBar();
  // A stop standing in the coupler's layer beside the crank pivot.
  const stopPart = ((await store.create("Stop")) as View).document.id;
  let s: View = await run(stopPart, "create_sketch", { plane: "XY" });
  await run(stopPart, "add_sketch_entity", { sketchId: s.document.sketches[0].id, type: "rectangle", values: { x: -46, y: 0, width: 8, height: 8 } });
  await run(stopPart, "extrude", { sketchId: s.document.sketches[0].id, distance: 5 });
  f.view = await run(f.asm, "insert_component", { partDocumentId: stopPart, position: [0, 0, 10], grounded: true, name: "Stop" });
  const pivot = f.hole("Crank", [0, 0]);
  const sweep = await run(f.asm, "check_motion", { componentId: f.ids.Crank, axis: { ref: ref(pivot) }, steps: 12 });
  // A full turn of the crank (a crank-rocker: 40 + 120 < 80 + 100): no limit; links pinned together only touch.
  assert.equal(sweep.limit, undefined);
  assert.equal(sweep.steps.length, 13);
  // The crank starts at 90°; its tip reaches the stop at 180°, a quarter turn one way or three the other.
  const reach = pivot.axis!.direction[2] > 0 ? 90 : 270;
  const hits = sweep.collisions.map((c: any) => [c.value, c.with]);
  assert.ok(hits.length > 0 && hits.every(([value, w]: [number, string[]]) => w.join() === "Coupler hits Stop" && Math.abs(value - reach) <= 30), JSON.stringify(hits));
  // Driving the rocker instead: it only rocks, so a full turn stops at the limit of its swing.
  const rockerPivot = f.hole("Rocker", [100, 0]);
  const rocking = await run(f.asm, "check_motion", { componentId: f.ids.Rocker, axis: { ref: ref(rockerPivot) }, steps: 36 });
  assert.ok(rocking.limit, "the rocker cannot turn all the way round");
  assert.match(rocking.limit.reason, /^The mechanism cannot reach/);
  assert.ok(rocking.limit.value > 0 && rocking.limit.value < 360);
  assert.equal(rocking.steps.at(-1).value < rocking.limit.value, true);
});

test("linkages: mate conflicts in a loop are flagged and the rest still solves; broken references are flagged, not remapped", async () => {
  const f = await fourBar();
  let v = f.view;
  assert.equal(v.geometry.componentStatus![f.ids.Crank].status, "under");
  assert.equal(v.geometry.componentStatus![f.ids.Crank].dof, 1, "a four-bar moves one way");
  assert.equal(v.geometry.componentStatus![f.ids.Base].status, "fixed");
  // Holding the rocker parallel to the base over-defines the loop: that mate is flagged, the linkage still closes.
  const side = (name: string) => v.geometry.bodies.flatMap((b) => b.topology).find((t) => t.bodyId.startsWith(`${f.ids[name]}/`) && t.kind === "face" && t.geomType === "PLANE" && Math.abs(t.normal![2]) < 1e-6 && (t.area ?? 0) > 400)!;
  v = await run(f.asm, "add_mate", { type: "parallel", moving: ref(side("Rocker")), target: ref(side("Base")) });
  const parallel = v.document.mates!.at(-1)!;
  assert.equal(v.geometry.mateStatus![parallel.id].status, "over");
  // It names only the mates it fights: the four pins close the loop that sets the rocker's angle.
  assert.equal(v.geometry.mateStatus![parallel.id].message, "Parallel 1 over-defines Rocker: it conflicts with Concentric 1, Concentric 2, Concentric 3, Concentric 4");
  assert.ok(v.document.mates!.filter((m) => m.id !== parallel.id).every((m) => v.geometry.mateStatus![m.id].status === "ok"));
  closes(v, f.ids, "with a flagged mate");
  const assembly = await run(f.asm, "inspect_assembly");
  assert.equal(assembly.mates.find((m: any) => m.id === parallel.id).state, "over");
  assert.ok(assembly.components.some((c: any) => c.definition === "over"));
  // The crank still turns, its flagged mate notwithstanding.
  v = await run(f.asm, "set_component_transform", { componentId: f.ids.Crank, position: [0, 0, 5], rotation: [0, 0, 70] });
  closes(v, f.ids, "turned with a flagged mate");
  await run(f.asm, "delete_mate", { mateId: parallel.id });
  // Removing the rocker's holes in its own part leaves its two pin mates without geometry: flagged, never re-attached elsewhere.
  const rockerPart = await store.read(f.rocker);
  await run(f.rocker, "delete_feature", { featureId: rockerPart.features.find((x) => x.type === "hole")!.id });
  v = await store.view(await store.read(f.asm));
  const broken = v.document.mates!.filter((m) => v.geometry.mateStatus![m.id].status === "error");
  assert.deepEqual(broken.map((m) => m.name).sort(), ["Concentric 2", "Concentric 4"]);
  assert.ok(broken.every((m) => /no longer resolves/.test(v.geometry.mateStatus![m.id].message!)));
});
