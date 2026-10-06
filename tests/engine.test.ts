import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import { solveSketch } from "../cad/solver.ts";
import { bezierPoint, fitPoints, sketchRegions, splineSpans } from "../cad/sketch-geometry.ts";
import type { View, Sketch, Topology } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-engine-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const near = (a: number, b: number, tol = 1e-3, label = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${label} ${a} ≠ ${b}`);
const ref = (t: Topology) => ({
  id: t.id,
  bodyId: t.bodyId,
  kind: t.kind,
  geomType: t.geomType,
  signature: t.signature,
});

async function fixture(name: string) {
  const store = new Store(dir),
    tools = toolset(store);
  let v = (await store.create(name)) as View;
  const run = async (tool: string, args: any = {}) => {
    const t = tools.find((t) => t.name === tool);
    if (!t) throw Error(`missing tool ${tool}`);
    const result = await t.handler(
      t.schema.parse({
        documentId: v.document.id,
        ...(t.schema.shape.expectedRevision ? { expectedRevision: v.document.revision } : {}),
        ...args,
      }),
      "assistant",
    );
    if (result?.document) v = result;
    return result;
  };
  const sketch = async (args: any = { plane: "XY" }) => {
    await run("create_sketch", args);
    return v.document.sketches.at(-1)!.id;
  };
  /** Rectangle drawn as four constrained lines, like the editor does. */
  const rectangle = async (sketchId: string, w: number, h: number, cx = 0, cy = 0) => {
    const x0 = cx - w / 2,
      y0 = cy - h / 2,
      x1 = cx + w / 2,
      y1 = cy + h / 2;
    await run("edit_sketch", {
      sketchId,
      operations: [
        { op: "add", ref: "$b", type: "line", values: { x1: x0, y1: y0, x2: x1, y2: y0 } },
        { op: "add", ref: "$r", type: "line", values: { x1: x1, y1: y0, x2: x1, y2: y1 } },
        { op: "add", ref: "$t", type: "line", values: { x1: x1, y1: y1, x2: x0, y2: y1 } },
        { op: "add", ref: "$l", type: "line", values: { x1: x0, y1: y1, x2: x0, y2: y0 } },
        { op: "constrain", type: "coincident", entities: ["$b", "$r"], anchors: ["end", "start"] },
        { op: "constrain", type: "coincident", entities: ["$r", "$t"], anchors: ["end", "start"] },
        { op: "constrain", type: "coincident", entities: ["$t", "$l"], anchors: ["end", "start"] },
        { op: "constrain", type: "coincident", entities: ["$l", "$b"], anchors: ["end", "start"] },
        { op: "constrain", type: "horizontal", entities: ["$b"] },
        { op: "constrain", type: "horizontal", entities: ["$t"] },
        { op: "constrain", type: "vertical", entities: ["$r"] },
        { op: "constrain", type: "vertical", entities: ["$l"] },
      ],
    });
  };
  const body = () => v.geometry.bodies.at(-1)!;
  const topFace = (b = body()) =>
    b.topology.filter((t) => t.kind === "face" && t.geomType === "PLANE" && t.normal![2] > 0.999)
      .sort((p, q) => q.center[2] - p.center[2])[0];
  return {
    run,
    sketch,
    rectangle,
    body,
    topFace,
    get view() {
      return v;
    },
  };
}

test("solver: angle, tangent arcs, midpoint, symmetry about a centerline and point-on relations", () => {
  const sk: Sketch = {
    id: "s",
    name: "s",
    plane: "XY",
    origin: [0, 0, 0],
    entities: [
      { id: "a", type: "line", construction: false, values: { x1: 0, y1: 0, x2: 30, y2: 2 } },
      { id: "b", type: "line", construction: false, values: { x1: 0, y1: 0, x2: 10, y2: 20 } },
      { id: "c", type: "line", construction: true, values: { x1: 0, y1: -50, x2: 0.5, y2: 50 } },
      { id: "p", type: "point", construction: false, values: { x: -7, y: 4 } },
      { id: "q", type: "point", construction: false, values: { x: 6, y: 5 } },
      { id: "m", type: "point", construction: false, values: { x: 14, y: 3 } },
    ],
    constraints: [
      { id: "1", type: "horizontal", entityIds: ["a"] },
      { id: "2", type: "coincident", entityIds: ["a", "b"], anchors: ["start", "start"] },
      { id: "3", type: "angle", entityIds: ["a", "b"], value: 60, reference: [1] },
      { id: "4", type: "vertical", entityIds: ["c"] },
      { id: "5", type: "symmetric", entityIds: ["p", "q", "c"] },
      { id: "6", type: "midpoint", entityIds: ["m", "a"], anchors: ["center"] },
      { id: "7", type: "length", entityIds: ["a"], value: 40 },
    ],
    solver: { dof: 0, residual: 0, status: "fully-constrained" },
  };
  solveSketch(sk);
  const [a, b, c, p, q, m] = sk.entities.map((e) => e.values);
  near(a.y1, a.y2, 1e-7);
  near(Math.hypot(a.x2 - a.x1, a.y2 - a.y1), 40, 1e-6);
  const angle = (Math.atan2(b.y2 - b.y1, b.x2 - b.x1) * 180) / Math.PI;
  near(angle, 60, 1e-5, "angle");
  near(c.x1, c.x2, 1e-7);
  near((p.x + q.x) / 2, c.x1, 1e-6, "symmetric x");
  near(p.y, q.y, 1e-6, "symmetric y");
  near(m.x, (a.x1 + a.x2) / 2, 1e-6);
  // Arc tangent to a line keeps G1 continuity; arcs contribute five freedoms.
  const slot: Sketch = {
    id: "t",
    name: "t",
    plane: "XY",
    origin: [0, 0, 0],
    entities: [
      { id: "l", type: "line", construction: false, values: { x1: -10, y1: 5, x2: 10, y2: 5 } },
      { id: "r", type: "arc", construction: false, values: { x1: 10, y1: 5, xm: 16, ym: 0.5, x2: 10, y2: -5 } },
    ],
    constraints: [
      { id: "1", type: "coincident", entityIds: ["l", "r"], anchors: ["end", "start"] },
      { id: "2", type: "tangent", entityIds: ["l", "r"] },
      { id: "3", type: "radius", entityIds: ["r"], value: 5 },
    ],
    solver: { dof: 0, residual: 0, status: "fully-constrained" },
  };
  solveSketch(slot);
  assert.equal(slot.solver.dof, 4 + 5 - 2 - 1 - 1);
  const arc = slot.entities[1].values;
  near(Math.hypot(arc.xm - arc.x1, arc.ym - arc.y1), Math.hypot(arc.xm - arc.x2, arc.ym - arc.y2), 1e-6);
});

test("regions: nested contours become holes, overlapping contours union, lines split faces", () => {
  const s = (entities: any[]): Sketch => ({
    id: "r",
    name: "r",
    plane: "XY",
    origin: [0, 0, 0],
    entities,
    constraints: [],
    solver: { dof: 0, residual: 0, status: "fully-constrained" },
  });
  const plate = sketchRegions(
    s([
      { id: "a", type: "rectangle", construction: false, values: { x: 0, y: 0, width: 80, height: 50 } },
      { id: "b", type: "circle", construction: false, values: { x: 10, y: 0, radius: 5 } },
    ]),
  );
  const material = plate.filter((r) => r.level % 2 === 1);
  assert.equal(material.length, 1);
  near(material[0].area, 4000 - Math.PI * 25, 0.2);
  const split = sketchRegions(
    s([
      { id: "a", type: "rectangle", construction: false, values: { x: 0, y: 0, width: 80, height: 50 } },
      { id: "b", type: "line", construction: false, values: { x1: 10, y1: -60, x2: 10, y2: 60 } },
    ]),
  );
  assert.equal(split.length, 2);
  near(split.reduce((sum, r) => sum + r.area, 0), 4000, 1e-6);
});

test("sketch-to-solid: constrained line rectangles, region selection, extrude end conditions and draft", async () => {
  const f = await fixture("End conditions");
  const sk = await f.sketch();
  await f.rectangle(sk, 60, 40);
  // Fully define with two dimensions and a fixed corner.
  const lines = f.view.document.sketches[0].entities;
  await f.run("edit_sketch", {
    sketchId: sk,
    operations: [
      { op: "constrain", type: "length", entities: [lines[0].id], value: 60 },
      { op: "constrain", type: "length", entities: [lines[1].id], value: 40 },
      { op: "add", ref: "$o", type: "point", values: { x: -30, y: -20 } },
      { op: "constrain", type: "fixed", entities: ["$o"] },
      { op: "constrain", type: "coincident", entities: [lines[0].id, "$o"], anchors: ["start", "center"] },
    ],
  });
  assert.equal(f.view.document.sketches[0].solver.dof, 0);
  await f.run("extrude", { sketchId: sk, distance: 10, endType: "symmetric" });
  near(f.body().volume, 24000, 1e-3);
  near(f.body().bounds[0][2], -5, 1e-6);
  near(f.body().bounds[1][2], 5, 1e-6);
  const extrude = f.view.document.features[0];
  await f.run("extrude", {
    featureId: extrude.id,
    sketchId: sk,
    distance: 10,
    endType: "two-sided",
    distance2: 4,
  });
  assert.equal(f.view.document.features[0].id, extrude.id);
  near(f.body().bounds[0][2], -4, 1e-6);
  near(f.body().volume, 2400 * 14, 1e-3);
  // Draft tapers the side walls; volume shrinks.
  await f.run("extrude", {
    featureId: extrude.id,
    sketchId: sk,
    distance: 10,
    draftAngle: 5,
  });
  assert.ok(f.body().volume < 24000 - 100, `draft volume ${f.body().volume}`);
  await f.run("extrude", { featureId: extrude.id, sketchId: sk, distance: 10 });
  // Cut through all from a sketch on the top face; origin-projected coordinates.
  const top = f.topFace();
  const cut = await f.sketch({ support: ref(top) });
  await f.run("add_sketch_entity", {
    sketchId: cut,
    type: "circle",
    values: { x: 5, y: 0, radius: 4 },
  });
  await f.run("extrude", {
    sketchId: cut,
    operation: "cut",
    bodyId: f.body().id,
    endType: "through-all",
    distance: 1,
    reverse: true,
  });
  near(f.body().volume, 24000 - Math.PI * 16 * 10, 0.05);
  const hole = f.body().topology.find((t) => t.kind === "edge" && t.radius && Math.abs(t.radius - 4) < 1e-6)!;
  near(hole.center[0], 5, 1e-5, "projected origin keeps sketch x");
});

test("overlapping sketch contours extrude as one union; explicit region seeds pick one face", async () => {
  const f = await fixture("Regions");
  const sk = await f.sketch();
  await f.run("add_sketch_entity", { sketchId: sk, type: "rectangle", values: { x: 0, y: 0, width: 40, height: 20 } });
  await f.run("add_sketch_entity", { sketchId: sk, type: "circle", values: { x: 20, y: 0, radius: 10 } });
  await f.run("extrude", { sketchId: sk, distance: 5 });
  near(f.body().volume, (800 + Math.PI * 100 / 2) * 5, 0.05);
  await f.run("extrude", {
    featureId: f.view.document.features[0].id,
    sketchId: sk,
    distance: 5,
    regions: [[25, 0]],
  });
  near(f.body().volume, (Math.PI * 100) / 2 * 5, 0.05);
});

test("revolve about a sketch centerline, sweep along a path and loft between planes", async () => {
  const f = await fixture("Revolve sweep loft");
  const sk = await f.sketch({ plane: "XZ" });
  await f.run("edit_sketch", {
    sketchId: sk,
    operations: [
      { op: "add", ref: "$axis", type: "line", construction: true, values: { x1: 0, y1: -10, x2: 0, y2: 30 } },
      { op: "add", type: "rectangle", values: { x: 15, y: 10, width: 10, height: 20 } },
    ],
  });
  const axis = f.view.document.sketches[0].entities[0].id;
  await f.run("revolve", { sketchId: sk, axisRef: { kind: "sketch", sketchId: sk, entityId: axis } });
  near(f.body().volume, Math.PI * (20 * 20 - 10 * 10) * 20, 0.5);
  // Sweep a circle along an L path.
  const g = await fixture("Sweep");
  const path = await g.sketch({ plane: "XZ" });
  await g.run("edit_sketch", {
    sketchId: path,
    operations: [
      { op: "add", type: "line", values: { x1: 0, y1: 0, x2: 0, y2: 30 } },
      { op: "add", type: "arc", values: { x1: 0, y1: 30, xm: 10 - 10 * Math.SQRT1_2, ym: 30 + 10 * Math.SQRT1_2, x2: 10, y2: 40 } },
    ],
  });
  const profile = await g.sketch({ plane: "XY" });
  await g.run("add_sketch_entity", { sketchId: profile, type: "circle", values: { x: 0, y: 0, radius: 2 } });
  await g.run("sweep", { profileSketchId: profile, pathSketchId: path });
  near(g.body().volume, Math.PI * 4 * (30 + (Math.PI / 2) * 10), 0.5);
  // Sweep along a spline path that leaves the profile square to it.
  const sg = await fixture("Spline sweep");
  const curve = await sg.sketch({ plane: "XZ" });
  const fit = { x0: 0, y0: 0, x1: 0, y1: 15, x2: 8, y2: 30, x3: 20, y3: 40 };
  await sg.run("add_sketch_entity", { sketchId: curve, type: "spline", values: fit });
  const ring = await sg.sketch({ plane: "XY" });
  await sg.run("add_sketch_entity", { sketchId: ring, type: "circle", values: { x: 0, y: 0, radius: 1 } });
  await sg.run("sweep", { profileSketchId: ring, pathSketchId: curve });
  let length = 0;
  for (const b of splineSpans(fitPoints({ type: "spline", values: fit } as any)))
    for (let i = 0; i < 400; i++) {
      const a = bezierPoint(b, i / 400),
        c = bezierPoint(b, (i + 1) / 400);
      length += Math.hypot(c[0] - a[0], c[1] - a[1]);
    }
  near(sg.body().volume, Math.PI * length, 0.01 * Math.PI * length);
  // Loft from a square to a smaller square on a datum plane.
  const h = await fixture("Loft");
  const low = await h.sketch({ plane: "XY" });
  await h.run("add_sketch_entity", { sketchId: low, type: "rectangle", values: { x: 0, y: 0, width: 20, height: 20 } });
  await h.run("create_reference_plane", {
    name: "Top datum",
    definition: { kind: "offset", base: { kind: "principal", plane: "XY" }, distance: 30 },
  });
  const plane = h.view.document.referencePlanes![0];
  near(plane.origin[2], 30, 1e-9);
  const high = await h.sketch({ referencePlaneId: plane.id });
  await h.run("add_sketch_entity", { sketchId: high, type: "rectangle", values: { x: 0, y: 0, width: 10, height: 10 } });
  await h.run("loft", { sketchIds: [low, high], ruled: true });
  // Frustum of a square pyramid.
  near(h.body().volume, (30 / 3) * (400 + 100 + Math.sqrt(400 * 100)), 0.05);
});

test("hole wizard: ISO counterbore, countersink, tapped drill points and sketch-point holes", async () => {
  const f = await fixture("Holes");
  const sk = await f.sketch();
  await f.run("add_sketch_entity", { sketchId: sk, type: "rectangle", values: { x: 0, y: 0, width: 80, height: 50 } });
  await f.run("extrude", { sketchId: sk, distance: 12 });
  const plain = f.body().volume;
  const top = f.topFace();
  await f.run("create_hole", {
    bodyId: f.body().id,
    face: ref(top),
    positions: [[-20, 0]],
    holeType: "counterbore",
    size: "M5",
  });
  const cb = 5.5,
    cbD = 10,
    cbDepth = 5.4;
  near(
    f.body().volume,
    plain - Math.PI * (cb / 2) ** 2 * (12 - cbDepth) - Math.PI * (cbD / 2) ** 2 * cbDepth,
    0.05,
    "counterbore",
  );
  const afterCb = f.body().volume;
  await f.run("create_hole", {
    bodyId: f.body().id,
    face: ref(f.topFace()),
    positions: [[20, 0]],
    holeType: "tapped",
    size: "M6",
    depth: 8,
    tipAngle: 118,
  });
  const tap = 5.0,
    tip = tap / 2 / Math.tan((59 * Math.PI) / 180);
  near(
    f.body().volume,
    afterCb - Math.PI * (tap / 2) ** 2 * 8 - (Math.PI * (tap / 2) ** 2 * tip) / 3,
    0.05,
    "tapped with drill point",
  );
  const tapped = f.view.document.features.at(-1)!;
  assert.equal(tapped.params.size, "M6");
  const afterTap = f.body().volume;
  await f.run("create_hole", {
    bodyId: f.body().id,
    face: ref(f.topFace()),
    positions: [[0, 15]],
    holeType: "countersink",
    size: "M4",
  });
  const cs = 4.5,
    csD = 9.2,
    h = (csD - cs) / 2; // 90° countersink depth
  const cone = (Math.PI * h * ((csD / 2) ** 2 + (csD / 2) * (cs / 2) + (cs / 2) ** 2)) / 3;
  near(f.body().volume, afterTap - cone - Math.PI * (cs / 2) ** 2 * (12 - h), 0.05, "countersink");
  // Hole centers from sketch points on a face sketch.
  const centers = await f.sketch({ support: ref(f.topFace()) });
  await f.run("edit_sketch", {
    sketchId: centers,
    operations: [
      { op: "add", type: "point", values: { x: -30, y: -15 } },
      { op: "add", type: "point", values: { x: 30, y: -15 } },
    ],
  });
  const before = f.body().volume;
  await f.run("create_hole", { bodyId: f.body().id, sketchId: centers, diameter: 3 });
  near(f.body().volume, before - 2 * Math.PI * 1.5 ** 2 * 12, 0.05, "sketch holes");
});

test("feature patterns, mirrors about datum planes, chamfer variants, draft, split and scale", async () => {
  const f = await fixture("Patterns");
  const sk = await f.sketch();
  await f.run("add_sketch_entity", { sketchId: sk, type: "rectangle", values: { x: 0, y: 0, width: 100, height: 40 } });
  await f.run("extrude", { sketchId: sk, distance: 10 });
  const base = f.body().volume;
  const slot = await f.sketch({ support: ref(f.topFace()) });
  await f.run("add_sketch_entity", { sketchId: slot, type: "rectangle", values: { x: -40, y: 0, width: 6, height: 20 } });
  await f.run("extrude", { sketchId: slot, operation: "cut", bodyId: f.body().id, distance: 4, reverse: true });
  const cut = f.view.document.features.at(-1)!;
  near(f.body().volume, base - 6 * 20 * 4, 1e-3);
  await f.run("create_linear_pattern", {
    bodyId: f.body().id,
    featureIds: [cut.id],
    direction: [1, 0, 0],
    spacing: 15,
    count: 4,
    skippedInstances: [3],
  });
  near(f.body().volume, base - 3 * 6 * 20 * 4, 1e-3, "linear feature pattern");
  await f.run("create_reference_plane", {
    name: "Mid",
    definition: { kind: "offset", base: { kind: "principal", plane: "YZ" }, distance: 0 },
  });
  await f.run("mirror_body", {
    bodyId: f.body().id,
    featureIds: [cut.id],
    mirrorPlane: { kind: "principal", plane: "YZ" },
  });
  near(f.body().volume, base - 4 * 6 * 20 * 4, 1e-3, "mirrored cut");
  // Circular pattern of a boss about the Z axis.
  const g = await fixture("Circular");
  const disc = await g.sketch();
  await g.run("add_sketch_entity", { sketchId: disc, type: "circle", values: { x: 0, y: 0, radius: 30 } });
  await g.run("extrude", { sketchId: disc, distance: 5 });
  const bossSketch = await g.sketch({ support: ref(g.topFace()) });
  await g.run("add_sketch_entity", { sketchId: bossSketch, type: "circle", values: { x: 20, y: 0, radius: 3 } });
  await g.run("extrude", { sketchId: bossSketch, operation: "join", bodyId: g.body().id, distance: 6 });
  const boss = g.view.document.features.at(-1)!;
  await g.run("create_circular_pattern", {
    bodyId: g.body().id,
    featureIds: [boss.id],
    axisRef: { kind: "principal", axis: "Z" },
    count: 6,
  });
  near(g.body().volume, Math.PI * 900 * 5 + 6 * Math.PI * 9 * 6, 0.05, "circular boss pattern");
  // Chamfer variants on a block.
  const h = await fixture("Chamfers");
  const block = await h.sketch();
  await h.run("add_sketch_entity", { sketchId: block, type: "rectangle", values: { x: 0, y: 0, width: 40, height: 40 } });
  await h.run("extrude", { sketchId: block, distance: 20 });
  const edge = h
    .body()
    .topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[2] - 20) < 1e-6 && Math.abs(t.center[1] + 20) < 1e-6)!;
  await h.run("chamfer_edges", { bodyId: h.body().id, edges: [ref(edge)], chamferType: "two-distance", distance: 2, distance2: 5 });
  near(h.body().volume, 32000 - 0.5 * 2 * 5 * 40, 1e-3, "two distance");
  await h.run("undo");
  await h.run("chamfer_edges", { bodyId: h.body().id, edges: [ref(edge)], chamferType: "distance-angle", distance: 3, angle: 45 });
  near(h.body().volume, 32000 - 0.5 * 3 * 3 * 40, 1e-3, "distance angle");
  await h.run("undo");
  // Draft two side faces 5° about the bottom plane.
  const sides = h.body().topology.filter((t) => t.kind === "face" && t.geomType === "PLANE" && Math.abs(t.normal![0]) > 0.99);
  await h.run("draft_faces", {
    bodyId: h.body().id,
    faces: sides.map(ref),
    neutral: { kind: "principal", plane: "XY" },
    angle: 5,
  });
  near(h.body().volume, 32000 - 2 * 0.5 * 20 * 20 * Math.tan((5 * Math.PI) / 180) * 40, 0.01, "draft");
  await h.run("undo");
  // Split keeps both halves as bodies.
  await h.run("split_body", { bodyId: h.body().id, plane: { kind: "principal", plane: "XY", offset: 5 } });
  assert.equal(h.view.geometry.bodies.length, 2);
  const volumes = h.view.geometry.bodies.map((b) => b.volume).sort((a, b) => a - b);
  near(volumes[0], 1600 * 5, 1e-3);
  near(volumes[1], 1600 * 15, 1e-3);
  await h.run("undo");
  await h.run("scale_body", { bodyId: h.body().id, factor: 0.5 });
  near(h.body().volume, 32000 / 8, 1e-3, "scale");
});

test("datum planes: angled, mid-plane and face-offset planes host sketches and stay associative", async () => {
  const f = await fixture("Datums");
  const sk = await f.sketch();
  await f.run("add_sketch_entity", { sketchId: sk, type: "rectangle", values: { x: 0, y: 0, width: 50, height: 30 } });
  await f.run("extrude", { sketchId: sk, distance: 20 });
  const top = f.topFace(),
    bottom = f.body().topology.find((t) => t.kind === "face" && t.normal?.[2] === -1)!;
  await f.run("create_reference_plane", {
    name: "Mid",
    definition: { kind: "midplane", a: { kind: "face", ref: ref(bottom) }, b: { kind: "face", ref: ref(top) } },
  });
  const mid = f.view.document.referencePlanes!.at(-1)!;
  near(f.view.geometry.frames!.planes[mid.id].origin[2], 10, 1e-6);
  await f.run("create_reference_plane", {
    name: "Above",
    definition: { kind: "offset", base: { kind: "face", ref: ref(top) }, distance: 15 },
  });
  const above = f.view.document.referencePlanes!.at(-1)!;
  near(f.view.geometry.frames!.planes[above.id].origin[2], 35, 1e-6);
  await f.run("create_reference_plane", {
    name: "Tilted",
    definition: {
      kind: "angle",
      base: { kind: "principal", plane: "XZ" },
      axis: { kind: "principal", axis: "Z" },
      angle: 90,
    },
  });
  const tilted = f.view.geometry.frames!.planes[f.view.document.referencePlanes!.at(-1)!.id];
  near(Math.abs(tilted.normal[0]), 1, 1e-6, "rotated front plane faces X");
  // A boss on the offset plane extruded down to the body.
  const boss = await f.sketch({ referencePlaneId: above.id });
  await f.run("add_sketch_entity", { sketchId: boss, type: "circle", values: { x: 0, y: 0, radius: 5 } });
  await f.run("extrude", {
    sketchId: boss,
    operation: "join",
    bodyId: f.body().id,
    endType: "up-to-face",
    upTo: ref(top),
    reverse: true,
    distance: 1,
  });
  near(f.body().volume, 50 * 30 * 20 + Math.PI * 25 * 15, 0.05, "up to face");
  // Editing the plane offset moves the boss.
  await f.run("set_reference_plane", { planeId: above.id, distance: 25 });
  near(f.body().bounds[1][2], 45, 1e-5);
});

test("rib: an open profile fills to the part's walls, picks its side and follows the profile", async () => {
  const f = await fixture("Rib");
  // L-bracket: a 100 x 40 x 5 base with a 5 mm wall standing at its left end.
  await f.run("create_sketch", { plane: "XY" });
  await f.run("add_sketch_entity", { sketchId: f.view.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 100, height: 40 } });
  await f.run("extrude", { sketchId: f.view.document.sketches[0].id, distance: 5 });
  const body = f.view.document.bodies[0].id;
  await f.run("create_sketch", { plane: "XY" });
  await f.run("add_sketch_entity", { sketchId: f.view.document.sketches[1].id, type: "rectangle", values: { x: -47.5, y: 0, width: 5, height: 40 } });
  await f.run("extrude", { sketchId: f.view.document.sketches[1].id, distance: 50, bodyId: body, operation: "join" });
  const before = f.view.geometry.bodies[0].volume;
  // Front-plane profile across the inside corner: from the wall at z = 35 down to the base at x = -10.
  await f.run("create_sketch", { plane: "XZ" });
  const profile = f.view.document.sketches[2].id;
  const frame = f.view.geometry.frames!.sketches[profile];
  const local = (x: number, z: number) => {
    const p = [x, 0, z];
    const d = p.map((v, i) => v - frame.origin[i]);
    return [d[0] * frame.xDir[0] + d[1] * frame.xDir[1] + d[2] * frame.xDir[2], d[0] * frame.yDir[0] + d[1] * frame.yDir[1] + d[2] * frame.yDir[2]];
  };
  const [x1, y1] = local(-45, 35),
    [x2, y2] = local(-10, 5);
  await f.run("add_sketch_entity", { sketchId: profile, type: "line", values: { x1, y1, x2, y2 } });
  await f.run("create_rib", { bodyId: body, sketchId: profile, thickness: 4 });
  const rib = (35 - 5) * (45 - 10) / 2 * 4;
  assert.ok(Math.abs(f.view.geometry.bodies[0].volume - (before + rib)) < 1e-3, `rib adds ${f.view.geometry.bodies[0].volume - before}, expected ${rib}`);
  // The rib follows its profile.
  const line = f.view.document.sketches[2].entities[0];
  const [, y3] = local(-45, 25);
  await f.run("set_dimension", { featureId: line.id, dimension: "y1", value: y3 });
  const lower = (25 - 5) * (45 - 10) / 2 * 4;
  assert.ok(Math.abs(f.view.geometry.bodies[0].volume - (before + lower)) < 1e-3);
  // A profile that never meets the part on the chosen side is rejected.
  const rejected = await f.run("create_rib", { bodyId: body, sketchId: profile, thickness: 4, flip: true }).catch((e: Error) => e);
  assert.match(String(rejected), /does not reach the part/);
});

test("mass properties: principal moments of inertia from the material density", async () => {
  const f = await fixture("Inertia");
  const s = await f.sketch();
  await f.rectangle(s, 100, 60);
  await f.run("extrude", { sketchId: s, distance: 10 });
  await f.run("set_material", { name: "Steel 1018" });
  const body = f.body();
  const m = (100 * 60 * 10 * 7.87) / 1000;
  const expected = [(m * (60 ** 2 + 10 ** 2)) / 12, (m * (100 ** 2 + 10 ** 2)) / 12, (m * (100 ** 2 + 60 ** 2)) / 12];
  assert.ok(Math.abs(body.mass! - m) < 1e-6);
  body.inertia!.forEach((value, i) => near(value, expected[i], expected[i] * 1e-9, `I${i + 1}`));
  // A rotated part has the same principal moments.
  await f.run("move_body", { bodyId: body.id, translation: [0, 0, 0], angle: 30, axis: [1, 1, 0] });
  f.body().inertia!.forEach((value, i) => near(value, expected[i], expected[i] * 1e-6, `rotated I${i + 1}`));
});
