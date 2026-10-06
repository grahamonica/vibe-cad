import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import { solveSketch } from "../cad/solver.ts";
import type { View, Sketch } from "../cad/types.ts";
const dir = await mkdtemp(join(tmpdir(), "vibe-cad-test-")),
  store = new Store(join(dir, "documents")),
  tools = toolset(store);
async function call(name: string, args: any, view?: View) {
  const t = tools.find((t) => t.name === name)!;
  return t.handler(
    t.schema.parse({
      ...(view
        ? {
            documentId: view.document.id,
            ...(!t.readOnly &&
            !["export_file", "set_selection", "set_viewport"].includes(name)
              ? { expectedRevision: view.document.revision }
              : {}),
          }
        : {}),
      ...args,
    }),
    "assistant",
  );
}
async function plate(w = 80, h = 50, depth = 12) {
  let v = (await call("create_document", { name: "Test plate" })) as View;
  v = await call("create_sketch", { plane: "XY" }, v);
  const sk = v.document.sketches[0];
  v = await call(
    "add_sketch_entity",
    {
      sketchId: sk.id,
      type: "rectangle",
      values: { x: 0, y: 0, width: w, height: h },
    },
    v,
  );
  v = await call("extrude", { sketchId: sk.id, distance: depth }, v);
  return v;
}
const nearly = (a: number, b: number, tol = 1e-3) =>
  assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
test("precise plate, holes, counterbore, parametric edits, stable selection, export, and persistence", async () => {
  let v = await plate();
  const body = v.document.bodies[0].id,
    rect = v.document.sketches[0].entities[0];
  nearly(v.geometry.bodies[0].volume, 48000);
  const top = v.geometry.bodies[0].topology.find(
    (t) => t.kind === "face" && t.normal?.[2] === 1,
  )!;
  const topRef = { id: top.id, bodyId: body, kind: "face" };
  v = await call("set_selection", { refs: [topRef] }, v);
  const selected = await call("inspect_selection", {}, v);
  assert.equal(selected.selection[0].normal[2], 1);
  v = await call(
    "create_hole",
    {
      bodyId: body,
      diameter: 5.5,
      positions: [
        [-20, 0],
        [20, 0],
      ],
      face: topRef,
      counterboreDiameter: 10,
      counterboreDepth: 4,
    },
    v,
  );
  const expected =
    48000 -
    2 * Math.PI * (5.5 / 2) ** 2 * 12 -
    2 * Math.PI * ((10 / 2) ** 2 - (5.5 / 2) ** 2) * 4;
  nearly(v.geometry.bodies[0].volume, expected, 0.1);
  const hole = v.document.features.at(-1)!;
  v = await call(
    "set_dimension",
    { featureId: rect.id, dimension: "width", value: 100 },
    v,
  );
  nearly(
    v.geometry.bodies[0].bounds[1][0] - v.geometry.bodies[0].bounds[0][0],
    100,
  );
  nearly(v.geometry.bodies[0].volume, expected + 20 * 50 * 12, 0.1);
  assert.equal(v.document.features.at(-1)!.id, hole.id);
  assert.equal(v.document.features.at(-1)!.params.diameter, 5.5);
  v = await call(
    "set_dimension",
    { featureId: hole.id, dimension: "diameter", value: 6.6 },
    v,
  );
  assert.equal(v.document.features.at(-1)!.params.diameter, 6.6);
  const smallerVolume = v.geometry.bodies[0].volume;
  v = await call("undo", {}, v);
  nearly(v.geometry.bodies[0].volume, expected + 12000, 0.1);
  v = await call("redo", {}, v);
  nearly(v.geometry.bodies[0].volume, smallerVolume);
  for (const format of ["step", "stl", "json", "edit"]) {
    const out = await call("export_file", { format }, v),
      bytes = await readFile(out.path);
    assert.ok(bytes.length > 100);
    if (format === "step")
      assert.ok(bytes.toString().startsWith("ISO-10303-21;"));
    if (format === "stl")
      assert.equal(bytes.length, 84 + bytes.readUInt32LE(80) * 50);
    if (format === "json")
      assert.equal(
        JSON.parse(bytes.toString()).features.at(-1).params.diameter,
        6.6,
      );
    if (format === 'edit') {
      const project=JSON.parse(bytes.toString());
      assert.equal(project.format,'vibe-cad-project/1');
      assert.equal(project.documents[project.root].features.at(-1).params.diameter,6.6);
      assert.ok(out.filename.endsWith('.edit'));
    }
  }
  const restored = await new Store(store.directory).view(
    await new Store(store.directory).read(v.document.id),
  );
  nearly(restored.geometry.bodies[0].volume, smallerVolume);
  assert.equal(restored.document.history.length, v.document.history.length);
});
test("fillets/chamfers use kernel and invalid features leave committed document intact", async () => {
  let v = await plate();
  const body = v.document.bodies[0].id;
  v = await call(
    "fillet_edges",
    { bodyId: body, radius: 3, selector: "vertical" },
    v,
  );
  assert.ok(v.geometry.bodies[0].volume < 48000);
  assert.ok(
    v.geometry.bodies[0].topology.some((t) => t.geomType === "CYLINDRE"),
  );
  const revision = v.document.revision,
    volume = v.geometry.bodies[0].volume;
  await assert.rejects(() =>
    call("fillet_edges", { bodyId: body, radius: 500, selector: "all" }, v),
  );
  const unchanged = await store.read(v.document.id);
  assert.equal(unchanged.revision, revision);
  assert.equal(unchanged.features.length, 2);
  nearly((await store.view(unchanged)).geometry.bodies[0].volume, volume);
  let c = await plate();
  c = await call(
    "chamfer_edges",
    { bodyId: c.document.bodies[0].id, distance: 2, selector: "vertical" },
    c,
  );
  nearly(c.geometry.bodies[0].volume, 48000 - ((4 * 2 * 2) / 2) * 12, 0.1);
});
test("closed line and arc profile creates valid solid; open loops are rejected", async () => {
  let v = (await call("create_document", { name: "Arc sketch" })) as View;
  v = await call("create_sketch", {}, v);
  const sketchId = v.document.sketches[0].id;
  v = await call(
    "add_sketch_entity",
    { sketchId, type: "line", values: { x1: -10, y1: 0, x2: 10, y2: 0 } },
    v,
  );
  await assert.rejects(
    () => call("extrude", { sketchId, distance: 5 }, v),
    /Open sketch/,
  );
  v = await call(
    "add_sketch_entity",
    {
      sketchId,
      type: "arc",
      values: { x1: 10, y1: 0, xm: 0, ym: 10, x2: -10, y2: 0 },
    },
    v,
  );
  v = await call("extrude", { sketchId, distance: 5 }, v);
  nearly(v.geometry.bodies[0].volume, ((Math.PI * 100) / 2) * 5, 0.1);
});
test("constraint solver reduces DOF, enforces relationships, rejects conflicts", () => {
  const sk: Sketch = {
    id: "s",
    name: "s",
    plane: "XY",
    origin: [0, 0, 0],
    entities: [
      {
        id: "a",
        type: "line",
        construction: false,
        values: { x1: 0, y1: 0, x2: 10, y2: 3 },
      },
    ],
    constraints: [{ id: "c", type: "horizontal", entityIds: ["a"] }],
    solver: { dof: 0, residual: 0, status: "fully-constrained" },
  };
  solveSketch(sk);
  nearly(sk.entities[0].values.y1, sk.entities[0].values.y2);
  assert.equal(sk.solver.dof, 3);
  sk.constraints.push(
    { id: "d", type: "dimension", entityIds: ["a"], dimension: "x1", value: 0 },
    {
      id: "e",
      type: "dimension",
      entityIds: ["a"],
      dimension: "x2",
      value: 10,
    },
    { id: "f", type: "dimension", entityIds: ["a"], dimension: "y1", value: 0 },
  );
  solveSketch(sk);
  assert.equal(sk.solver.dof, 0);
  sk.constraints.push({
    id: "g",
    type: "dimension",
    entityIds: ["a"],
    dimension: "y2",
    value: 3,
  });
  assert.throws(() => solveSketch(sk), /Conflicting constraints/);
});
test("patterns retain hole diameter dependency; booleans and distance measurement are exact", async () => {
  let v = await plate(100, 50, 10);
  const body = v.document.bodies[0].id;
  v = await call(
    "create_hole",
    { bodyId: body, diameter: 4, positions: [[-20, 0]] },
    v,
  );
  const hole = v.document.features.at(-1)!.id;
  v = await call(
    "create_linear_pattern",
    {
      bodyId: body,
      featureId: hole,
      direction: [1, 0, 0],
      spacing: 20,
      count: 3,
    },
    v,
  );
  nearly(v.geometry.bodies[0].volume, 50000 - 3 * Math.PI * 4 * 10, 0.1);
  v = await call(
    "set_dimension",
    { featureId: hole, dimension: "diameter", value: 6 },
    v,
  );
  nearly(v.geometry.bodies[0].volume, 50000 - 3 * Math.PI * 9 * 10, 0.1);
  const faces = v.geometry.bodies[0].topology.filter(
    (t) => t.kind === "face" && t.normal && Math.abs(t.normal[0]) > 0.999,
  );
  const refs = faces.map((t) => ({ id: t.id, bodyId: body, kind: "face" }));
  const result = await call("measure", { refs: refs.slice(0, 2) }, v);
  nearly(result.distance, 100);
  const sk = await call("create_sketch", { origin: [0, 0, 5] }, v);
  v = await call(
    "add_sketch_entity",
    {
      sketchId: sk.document.sketches.at(-1).id,
      type: "rectangle",
      values: { x: 0, y: 0, width: 20, height: 20 },
    },
    sk,
  );
  v = await call(
    "extrude",
    { sketchId: v.document.sketches.at(-1)!.id, distance: 10 },
    v,
  );
  const other = v.document.bodies.at(-1)!.id;
  const hit = await call(
    "analyze_interference",
    { bodyA: body, bodyB: other },
    v,
  );
  assert.equal(hit.interferes, true);
  nearly(hit.volume, 20 * 20 * 5 - Math.PI * 9 * 5, 0.1);
  v = await call(
    "boolean_bodies",
    { bodyId: body, toolBodyId: other, operation: "union" },
    v,
  );
  assert.ok(v.geometry.bodies[0].volume > 48000);
});
test("revision conflict and hard intent reject without changing the document", async () => {
  let v = await plate();
  const rect = v.document.sketches[0].entities[0].id;
  v = await call(
    "add_design_intent",
    {
      text: "Width must fit the mounting envelope",
      kind: "hard",
      featureId: rect,
      dimension: "width",
      max: 90,
    },
    v,
  );
  await assert.rejects(
    () =>
      call(
        "set_dimension",
        { featureId: rect, dimension: "width", value: 100 },
        v,
      ),
    /Design intent violated/,
  );
  const d = await store.read(v.document.id);
  assert.equal(d.revision, v.document.revision);
  assert.equal(d.sketches[0].entities[0].values.width, 80);
  await assert.rejects(
    () =>
      call(
        "set_dimension",
        { featureId: rect, dimension: "width", value: 85, expectedRevision: 0 },
        v,
      ),
    /Revision conflict/,
  );
  await assert.rejects(
    () =>
      call(
        "set_selection",
        {
          refs: [
            {
              id: "invented-edge",
              kind: "edge",
              bodyId: v.document.bodies[0].id,
            },
          ],
        },
        v,
      ),
    /no longer exists/,
  );
});
test("ghost preview leaves committed geometry unchanged, applies exact candidate, and invalidates on another edit", async () => {
  let v = await plate();
  const id = v.document.sketches[0].entities[0].id,
    rev = v.document.revision;
  v = await call(
    "preview_dimension",
    { expectedRevision: rev, featureId: id, dimension: "width", value: 100 },
    v,
  );
  assert.ok(v.preview);
  nearly(v.geometry.bodies[0].volume, 48000);
  nearly(v.preview!.geometry.bodies[0].volume, 60000);
  assert.equal((await store.read(v.document.id)).revision, rev);
  v = await call("apply_preview", { previewId: v.preview!.id }, v);
  nearly(v.geometry.bodies[0].volume, 60000);
  assert.equal(v.document.revision, rev + 1);
  assert.equal(v.preview, undefined);
  v = await call(
    "preview_dimension",
    {
      expectedRevision: v.document.revision,
      featureId: id,
      dimension: "width",
      value: 120,
    },
    v,
  );
  const previewId = v.preview!.id;
  v = await call(
    "set_dimension",
    { featureId: id, dimension: "width", value: 90 },
    v,
  );
  await assert.rejects(
    () => call("apply_preview", { previewId }, v),
    /Preview is stale/,
  );
  nearly(v.geometry.bodies[0].volume, 54000);
});
test("selected individual edges fillet correctly and principal-plane circle cuts retain precise geometry", async () => {
  let v = await plate();
  const body = v.document.bodies[0].id,
    edge = v.geometry.bodies[0].topology.find(
      (t) => t.kind === "edge" && Math.abs(t.signature[5]) > 0.999,
    )!;
  v = await call(
    "fillet_edges",
    {
      bodyId: body,
      radius: 2,
      edges: [{ id: edge.id, bodyId: body, kind: "edge" }],
    },
    v,
  );
  nearly(v.geometry.bodies[0].volume, 48000 - (4 - Math.PI) * 12, 0.1);
  let sk = await call("create_sketch", { plane: "XY", origin: [0, 0, 12] }, v);
  v = await call(
    "add_sketch_entity",
    {
      sketchId: sk.document.sketches.at(-1).id,
      type: "circle",
      values: { x: 0, y: 0, radius: 5 },
    },
    sk,
  );
  v = await call(
    "extrude",
    {
      sketchId: v.document.sketches.at(-1)!.id,
      bodyId: body,
      distance: -12,
      operation: "cut",
    },
    v,
  );
  nearly(
    v.geometry.bodies[0].volume,
    48000 - (4 - Math.PI) * 12 - Math.PI * 25 * 12,
    0.1,
  );
});
test("revolve, shell, mirror and body transforms produce exact solids", async () => {
  let v = (await call("create_document", { name: "Revolve" })) as View;
  v = await call("create_sketch", {}, v);
  v = await call(
    "add_sketch_entity",
    {
      sketchId: v.document.sketches[0].id,
      type: "rectangle",
      values: { x: 20, y: 0, width: 20, height: 10 },
    },
    v,
  );
  v = await call(
    "revolve",
    { sketchId: v.document.sketches[0].id, axis: [0, 1, 0] },
    v,
  );
  nearly(v.geometry.bodies[0].volume, Math.PI * (30 ** 2 - 10 ** 2) * 10, 0.1);
  let s = await plate();
  const body = s.document.bodies[0].id,
    top = s.geometry.bodies[0].topology.find(
      (t) => t.kind === "face" && t.normal?.[2] === 1,
    )!;
  s = await call(
    "shell_body",
    {
      bodyId: body,
      thickness: 2,
      faces: [{ id: top.id, bodyId: body, kind: "face" }],
    },
    s,
  );
  nearly(s.geometry.bodies[0].volume, 48000 - 76 * 46 * 10, 0.1);
  let m = await plate(10, 10, 10);
  const bid = m.document.bodies[0].id;
  m = await call("move_body", { bodyId: bid, translation: [20, 0, 0] }, m);
  nearly(m.geometry.bodies[0].bounds[0][0], 15);
  m = await call("mirror_body", { bodyId: bid, plane: "YZ" }, m);
  nearly(m.geometry.bodies[0].volume, 2000, 0.1);
});
test("patterns on a selected face retain the source frame and counterbore", async () => {
  let v = await plate(100, 50, 12);
  const body = v.document.bodies[0].id,
    top = v.geometry.bodies[0].topology.find(
      (t) => t.kind === "face" && t.normal?.[2] === 1,
    )!;
  v = await call(
    "create_hole",
    {
      bodyId: body,
      diameter: 4,
      positions: [[-20, 0]],
      face: { id: top.id, bodyId: body, kind: "face" },
      counterboreDiameter: 8,
      counterboreDepth: 3,
    },
    v,
  );
  const fid = v.document.features.at(-1)!.id;
  v = await call(
    "create_linear_pattern",
    {
      bodyId: body,
      featureId: fid,
      direction: [1, 0, 0],
      spacing: 20,
      count: 3,
    },
    v,
  );
  nearly(
    v.geometry.bodies[0].volume,
    60000 - 3 * (Math.PI * 4 * 12 + Math.PI * (16 - 4) * 3),
    0.1,
  );
});
