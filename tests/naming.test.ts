import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import { legacyTopologyId } from "../cad/topology-key.ts";
import type { Topology, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-naming-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const ref = (t: Topology) => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType, signature: t.signature });
async function plate(width = 100, height = 60, thickness = 10) {
  const store = new Store(join(dir, "docs")),
    tools = toolset(store);
  let v = (await store.create("Plate")) as View;
  const run = async (name: string, args: any = {}) => {
    const t = tools.find((t) => t.name === name)!;
    const r = await t.handler(
      t.schema.parse({ documentId: v.document.id, ...(t.schema.shape.expectedRevision ? { expectedRevision: v.document.revision } : {}), ...args }),
      "assistant",
    );
    if (r?.document) v = r;
    return r;
  };
  await run("create_sketch", { plane: "XY" });
  const sketchId = v.document.sketches[0].id;
  await run("add_sketch_entity", { sketchId, type: "rectangle", values: { x: 0, y: 0, width, height } });
  await run("extrude", { sketchId, distance: thickness });
  return {
    run,
    sketchId,
    rectangleId: v.document.sketches[0].entities[0].id,
    body: v.document.bodies[0].id,
    get view() {
      return v;
    },
    get topology() {
      return v.geometry.bodies[0].topology;
    },
  };
}
const near = (a: number[], b: number[], tol = 1e-4) => a.every((x, i) => Math.abs(x - b[i]) < tol);

test("names: faces and edges keep their ids through dimension changes", async () => {
  const f = await plate();
  const top = f.topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  const corner = f.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && near(t.center.slice(0, 2), [50, 30]))!;
  await f.run("fillet_edges", { bodyId: f.body, radius: 4, edges: [ref(corner)] });
  const extrude = f.view.document.features[0];
  const round = () => f.topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
  const roundId = round().id;
  // Thicker part: same top face, same round.
  await f.run("set_dimension", { featureId: extrude.id, dimension: "distance", value: 20 });
  assert.ok(f.topology.some((t) => t.id === top.id && t.center[2] === 20), "top face keeps its id at the new height");
  assert.equal(round().id, roundId);
  // Wider sketch: the rounded corner moves with its side and keeps its identity.
  await f.run("set_dimension", { featureId: f.rectangleId, dimension: "width", value: 140 });
  assert.equal(round().id, roundId);
  assert.ok(round().center[0] > 60, "the round follows the corner");
  // Faces report the feature that created them.
  assert.equal(round().featureId, f.view.document.features[1].id);
  assert.equal(f.topology.find((t) => t.id === top.id)!.featureId, extrude.id);
});

test("names: holes keep identity when moved, and removing a center never retargets a reference", async () => {
  const f = await plate();
  const top = f.topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await f.run("create_hole", { bodyId: f.body, face: ref(top), frame: "origin", positions: [[-30, 0], [0, 0], [30, 0]], diameter: 6 });
  const walls = () => f.topology.filter((t) => t.kind === "face" && t.geomType === "CYLINDRE");
  const middle = walls().find((t) => near(t.axis!.origin.slice(0, 2), [0, 0]))!;
  const first = walls().find((t) => near(t.axis!.origin.slice(0, 2), [-30, 0]))!;
  const hole = f.view.document.features.find((x) => x.type === "hole")!;
  // Move every hole: ids follow their hole.
  await f.run("set_hole_positions", { featureId: hole.id, positions: [[-35, 5], [0, 5], [35, 5]] });
  assert.ok(near(walls().find((t) => t.id === middle.id)!.axis!.origin.slice(0, 2), [0, 5]));
  // Remove the first hole: the middle one keeps its id and position, the removed id is gone.
  await f.run("set_hole_positions", { featureId: hole.id, positions: [[0, 5], [35, 5]] });
  assert.ok(near(walls().find((t) => t.id === middle.id)!.axis!.origin.slice(0, 2), [0, 5]));
  assert.ok(!walls().some((t) => t.id === first.id));
  // A new center is a new hole, not a revived old one.
  await f.run("set_hole_positions", { featureId: hole.id, positions: [[0, 5], [35, 5], [-35, 5]] });
  assert.ok(!walls().some((t) => t.id === first.id));
  assert.equal(walls().length, 3);
});

test("names: a face split by a later feature stops resolving instead of picking a piece", async () => {
  const f = await plate();
  const top = f.topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  const bottomEdges = f.topology.filter((t) => t.kind === "edge" && t.center[2] === 0).map((t) => t.id);
  // A shallow slot across the top splits the top face into two.
  await f.run("create_sketch", { support: ref(top) });
  const slot = f.view.document.sketches.at(-1)!.id;
  await f.run("add_sketch_entity", { sketchId: slot, type: "rectangle", values: { x: 0, y: 0, width: 10, height: 80 } });
  await f.run("extrude", { sketchId: slot, bodyId: f.body, operation: "cut", distance: 3, reverse: true });
  const tops = f.topology.filter((t) => t.kind === "face" && t.normal?.[2] === 1 && Math.abs(t.center[2] - 10) < 1e-6);
  assert.equal(tops.length, 2);
  assert.ok(!tops.some((t) => t.id === top.id), "the split top face has new ids");
  assert.equal(new Set(tops.map((t) => t.id)).size, 2);
  // Edges away from the slot are untouched.
  const remaining = f.topology.filter((t) => t.kind === "edge").map((t) => t.id);
  assert.deepEqual(bottomEdges.filter((id) => remaining.includes(id)), bottomEdges);
});

test("names: patterned instances are numbered by grid position, so they keep identity when spacing changes", async () => {
  const f = await plate(160, 60);
  const top = f.topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await f.run("create_hole", { bodyId: f.body, face: ref(top), frame: "origin", positions: [[-60, 0]], diameter: 6 });
  const hole = f.view.document.features.at(-1)!;
  await f.run("create_linear_pattern", { bodyId: f.body, featureIds: [hole.id], direction: [1, 0, 0], spacing: 30, count: 3 });
  const pattern = f.view.document.features.at(-1)!;
  const walls = () => f.topology.filter((t) => t.kind === "face" && t.geomType === "CYLINDRE");
  const third = walls().find((t) => near(t.axis!.origin.slice(0, 2), [0, 0]))!;
  await f.run("set_dimension", { featureId: pattern.id, dimension: "spacing", value: 40 });
  const moved = walls().find((t) => t.id === third.id)!;
  assert.ok(near(moved.axis!.origin.slice(0, 2), [20, 0]), `third instance at x=${moved.axis!.origin[0]}`);
  assert.equal(moved.featureId, pattern.id);
});

test("names: references saved with earlier geometric ids still resolve", async () => {
  const f = await plate();
  const edge = f.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && near(t.center.slice(0, 2), [50, 30]))!;
  const legacy = { ...ref(edge), id: legacyTopologyId(edge) };
  assert.notEqual(legacy.id, edge.id);
  await f.run("fillet_edges", { bodyId: f.body, radius: 3, edges: [legacy] });
  assert.ok(f.topology.some((t) => t.kind === "face" && t.geomType === "CYLINDRE"));
  // Sketches on a face saved with an earlier id resolve too.
  const top = f.topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await f.run("create_sketch", { support: { ...ref(top), id: legacyTopologyId(top) } });
  assert.ok(f.view.geometry.frames?.sketches[f.view.document.sketches.at(-1)!.id]);
});
