import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import { arcGeometry, fitPoints, nearestOnEntity, sketchRegions, splineBeziers, splineSpans } from "../cad/sketch-geometry.ts";
import { trimOps } from "../editor/sketch/trim.ts";
import type { Entity, Sketch, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-sketch-tools-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const store = new Store(join(dir, "docs")),
  tools = toolset(store);
async function sketchDoc() {
  let v = (await store.create("Sketch tools")) as View;
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
  const edit = (operations: any[]) => run("edit_sketch", { sketchId, operations });
  return {
    run,
    edit,
    sketchId,
    get sketch(): Sketch {
      return v.document.sketches.find((s) => s.id === sketchId)!;
    },
    get view() {
      return v;
    },
  };
}
/** A closed rectangle of four connected lines with a size dimension on two sides. */
const rectangle = (w: number, h: number) => [
  { op: "add", ref: "$b", type: "line", values: { x1: 0, y1: 0, x2: w, y2: 0 } },
  { op: "add", ref: "$r", type: "line", values: { x1: w, y1: 0, x2: w, y2: h } },
  { op: "add", ref: "$t", type: "line", values: { x1: w, y1: h, x2: 0, y2: h } },
  { op: "add", ref: "$l", type: "line", values: { x1: 0, y1: h, x2: 0, y2: 0 } },
  { op: "constrain", type: "coincident", entities: ["$b", "$r"], anchors: ["end", "start"] },
  { op: "constrain", type: "coincident", entities: ["$r", "$t"], anchors: ["end", "start"] },
  { op: "constrain", type: "coincident", entities: ["$t", "$l"], anchors: ["end", "start"] },
  { op: "constrain", type: "coincident", entities: ["$l", "$b"], anchors: ["end", "start"] },
  { op: "constrain", type: "horizontal", entities: ["$b"] },
  { op: "constrain", type: "horizontal", entities: ["$t"] },
  { op: "constrain", type: "vertical", entities: ["$r"] },
  { op: "constrain", type: "vertical", entities: ["$l"] },
  { op: "constrain", type: "length", entities: ["$b"], value: w },
  { op: "constrain", type: "length", entities: ["$r"], value: h },
  { op: "add", ref: "$o", type: "point", values: { x: 0, y: 0 } },
  { op: "constrain", type: "fixed", entities: ["$o"] },
  { op: "constrain", type: "coincident", entities: ["$b", "$o"], anchors: ["start", "center"] },
];
const bounds = (es: Entity[]) => {
  const xs = es.flatMap((e) => [e.values.x1, e.values.x2]),
    ys = es.flatMap((e) => [e.values.y1, e.values.y2]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((n) => Math.round(n * 1e6) / 1e6);
};

test("offset: a closed chain offsets outward as one loop, driven by one dimension", async () => {
  const f = await sketchDoc();
  await f.edit(rectangle(100, 60));
  const sources = f.sketch.entities.filter((e) => e.type === "line").map((e) => e.id);
  await f.edit([{ op: "offset", entities: sources, distance: 5, side: "outside" }]);
  const copies = f.sketch.entities.filter((e) => e.type === "line" && !sources.includes(e.id));
  assert.equal(copies.length, 4);
  assert.deepEqual(bounds(copies), [-5, -5, 105, 65], "corners meet at the offset rectangle");
  assert.equal(f.sketch.solver.dof, 0, "the offset copy is fully defined by its source");
  const offset = f.sketch.constraints.find((c) => c.type === "offset")!;
  assert.equal(offset.entityIds.length, 8);
  // One value drives the whole loop; the source still drives the copy.
  await f.edit([{ op: "value", constraintId: offset.id, value: 8 }]);
  assert.deepEqual(bounds(f.sketch.entities.filter((e) => copies.some((c) => c.id === e.id))), [-8, -8, 108, 68]);
  const width = f.sketch.constraints.find((c) => c.type === "length" && c.value === 100)!;
  await f.edit([{ op: "value", constraintId: width.id, value: 120 }]);
  assert.deepEqual(bounds(f.sketch.entities.filter((e) => copies.some((c) => c.id === e.id))), [-8, -8, 128, 68]);
  // Two nested loops make a ring-shaped profile.
  await f.run("extrude", { sketchId: f.sketchId, distance: 4 });
  const body = f.view.geometry.bodies[0];
  assert.ok(Math.abs(body.volume - (136 * 76 - 120 * 60) * 4) < 1e-3, `ring volume ${body.volume}`);
});

test("offset: chains with arcs, circles inside, and the side picked by a point", async () => {
  const f = await sketchDoc();
  // Slot: two lines joined by tangent arcs.
  await f.edit([
    { op: "add", ref: "$a", type: "line", values: { x1: 0, y1: 0, x2: 40, y2: 0 } },
    { op: "add", ref: "$r", type: "arc", values: { x1: 40, y1: 0, xm: 50, ym: 10, x2: 40, y2: 20 } },
    { op: "add", ref: "$b", type: "line", values: { x1: 40, y1: 20, x2: 0, y2: 20 } },
    { op: "add", ref: "$l", type: "arc", values: { x1: 0, y1: 20, xm: -10, ym: 10, x2: 0, y2: 0 } },
    { op: "add", ref: "$c", type: "circle", values: { x: 80, y: 10, radius: 10 } },
  ]);
  const slot = f.sketch.entities.filter((e) => e.type !== "circle").map((e) => e.id);
  await f.edit([{ op: "offset", entities: slot, distance: 3, toward: [20, 10] }]);
  const inner = f.sketch.entities.filter((e) => !slot.includes(e.id) && e.type !== "circle");
  const arcs = inner.filter((e) => e.type === "arc").map((e) => arcGeometry(e)!);
  assert.ok(arcs.every((g) => Math.abs(g.radius - 7) < 1e-6), "inner arcs shrink by the offset");
  const lines = inner.filter((e) => e.type === "line");
  assert.deepEqual(lines.map((l) => l.values.y1).sort((a, b) => a - b), [3, 17]);
  const circle = f.sketch.entities.find((e) => e.type === "circle")!;
  await f.edit([{ op: "offset", entities: [circle.id], distance: 2, side: "inside" }]);
  const ring = f.sketch.entities.filter((e) => e.type === "circle");
  assert.deepEqual(ring.map((c) => c.values.radius).sort(), [10, 8]);
  await assert.rejects(f.edit([{ op: "offset", entities: [circle.id], distance: 12, side: "inside" }]), /larger than/);
});

test("mirror: copies follow their sources through symmetric relations", async () => {
  const f = await sketchDoc();
  await f.edit([
    { op: "add", ref: "$axis", type: "line", values: { x1: 0, y1: -50, x2: 0, y2: 50 }, construction: true },
    { op: "constrain", type: "fixed", entities: ["$axis"] },
    { op: "add", ref: "$l", type: "line", values: { x1: 10, y1: 0, x2: 30, y2: 20 } },
    { op: "add", ref: "$c", type: "circle", values: { x: 20, y: -20, radius: 5 } },
    { op: "add", ref: "$arc", type: "arc", values: { x1: 40, y1: 0, xm: 45, ym: 5, x2: 50, y2: 0 } },
    { op: "mirror", entities: ["$l", "$c", "$arc"], axis: "$axis", ref: "$m" },
  ]);
  const [ml, mc, ma] = f.sketch.entities.slice(-3);
  assert.deepEqual([ml.values.x1, ml.values.y1, ml.values.x2, ml.values.y2], [-10, 0, -30, 20]);
  assert.deepEqual([mc.values.x, mc.values.y, mc.values.radius], [-20, -20, 5]);
  assert.ok(Math.abs(arcGeometry(ma)!.radius - arcGeometry(f.sketch.entities[3])!.radius) < 1e-9);
  // Dragging a source moves its mirror image.
  const circle = f.sketch.entities.find((e) => e.type === "circle" && e.values.x > 0)!;
  await f.edit([{ op: "drag", entityId: circle.id, anchor: "center", target: [25, -10] }]);
  const moved = f.sketch.entities.find((e) => e.id === mc.id)!;
  assert.ok(Math.abs(moved.values.x + 25) < 1e-6 && Math.abs(moved.values.y + 10) < 1e-6);
});

test("fillet and chamfer: corners round or bevel, and dimensions to the corner survive", async () => {
  const f = await sketchDoc();
  await f.edit(rectangle(100, 60));
  const line = (x1: number, y1: number) => f.sketch.entities.find((e) => e.type === "line" && e.values.x1 === x1 && e.values.y1 === y1)!;
  const right = line(100, 0),
    top = line(100, 60),
    bottom = line(0, 0),
    leftLine = line(0, 60);
  await f.edit([
    { op: "fillet", entities: [right.id, top.id], radius: 10 },
    { op: "chamfer", entities: [leftLine.id, bottom.id], distance: 5 },
  ]);
  const arc = f.sketch.entities.find((e) => e.type === "arc")!;
  const g = arcGeometry(arc)!;
  assert.ok(Math.abs(g.radius - 10) < 1e-6 && Math.abs(g.center[0] - 90) < 1e-6 && Math.abs(g.center[1] - 50) < 1e-6);
  const sharps = f.sketch.entities.filter((e) => e.type === "point" && e.construction);
  assert.equal(sharps.length, 2, "a construction point marks each virtual sharp");
  // The 100 x 60 size is still enforced through the sharps.
  const width = f.sketch.constraints.find((c) => c.value === 100)!;
  await f.edit([{ op: "value", constraintId: width.id, value: 110 }]);
  const after = f.sketch.entities.find((e) => e.id === arc.id)!;
  assert.ok(Math.abs(arcGeometry(after)!.center[0] - 100) < 1e-6, "the fillet moves with the corner");
  await f.run("extrude", { sketchId: f.sketchId, distance: 10 });
  const body = f.view.geometry.bodies[0];
  const expected = (110 * 60 - (100 - 25 * Math.PI) - 12.5) * 10;
  assert.ok(Math.abs(body.volume - expected) < 1e-3, `volume ${body.volume} vs ${expected}`);
  await assert.rejects(f.edit([{ op: "fillet", entities: [top.id, leftLine.id], radius: 200 }]), /larger than/);
});

test("convert entities: a face outline follows the model through offsets and features", async () => {
  const f = await sketchDoc();
  await f.edit([{ op: "add", ref: "$r", type: "rectangle", values: { x: 0, y: 0, width: 100, height: 60 } }]);
  await f.run("extrude", { sketchId: f.sketchId, distance: 10 });
  const rect = f.sketch.entities[0];
  const body = f.view.document.bodies[0].id;
  const top = f.view.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await f.run("create_sketch", { support: { id: top.id, bodyId: body, kind: "face" } });
  const pocketSketch = f.view.document.sketches.at(-1)!.id;
  const edit = (operations: any[]) => f.run("edit_sketch", { sketchId: pocketSketch, operations });
  await edit([{ op: "convert", refs: [{ id: top.id, bodyId: body, kind: "face" }], ref: "$edge" }]);
  let s = f.view.document.sketches.find((x) => x.id === pocketSketch)!;
  const converted = s.entities.filter((e) => e.projected);
  assert.equal(converted.length, 4, "the face's four edges");
  assert.equal(s.solver.dof, 0, "converted edges are fully defined by the model");
  await edit([{ op: "offset", entities: converted.map((e) => e.id), distance: 10, side: "inside" }]);
  await f.run("extrude", { sketchId: pocketSketch, bodyId: body, operation: "cut", distance: 4, reverse: true, regions: [[0, 0]] });
  const volume = () => f.view.geometry.bodies[0].volume;
  assert.ok(Math.abs(volume() - (100 * 60 * 10 - 80 * 40 * 4)) < 1e-3, `pocket volume ${volume()}`);
  // Widen the base sketch: the converted outline, its offset and the pocket follow.
  await f.run("set_dimension", { featureId: rect.id, dimension: "width", value: 120 });
  assert.ok(Math.abs(volume() - (120 * 60 * 10 - 100 * 40 * 4)) < 1e-3, `pocket follows the part: ${volume()}`);
  s = f.view.document.sketches.find((x) => x.id === pocketSketch)!;
  const xs = s.entities.filter((e) => e.projected).flatMap((e) => [e.values.x1, e.values.x2]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)].map((x) => Math.round(x * 1e6) / 1e6), [-60, 60], "the saved sketch shows the new outline");
  // Converted entities cannot be dragged off the model, but can be unlinked.
  await assert.rejects(edit([{ op: "set", entityId: converted[0].id, values: { x1: 0 } }]), /follow the model/);
  await edit([{ op: "unlink", entityId: converted[0].id }]);
  s = f.view.document.sketches.find((x) => x.id === pocketSketch)!;
  assert.equal(s.entities.find((e) => e.id === converted[0].id)!.projected, undefined);
});

test("sketch patterns: linear and circular copies follow one spacing or angle dimension", async () => {
  const f = await sketchDoc();
  await f.edit([
    { op: "add", ref: "$plate", type: "rectangle", values: { x: 60, y: 10, width: 140, height: 40 } },
    { op: "add", ref: "$hole", type: "circle", values: { x: 10, y: 10, radius: 3 } },
    { op: "constrain", type: "fixed", entities: ["$plate"] },
    // The first hole is located; the pattern places the rest.
    { op: "constrain", type: "dimension", entities: ["$hole"], dimension: "x", value: 10 },
    { op: "constrain", type: "dimension", entities: ["$hole"], dimension: "y", value: 10 },
    { op: "pattern", entities: ["$hole"], kind: "linear", count: 5, spacing: 20 },
  ]);
  const circles = () => f.sketch.entities.filter((e) => e.type === "circle").map((e) => Math.round(e.values.x * 1e6) / 1e6);
  assert.deepEqual(circles(), [10, 30, 50, 70, 90]);
  const pattern = f.sketch.constraints.find((c) => c.type === "pattern")!;
  await f.edit([{ op: "value", constraintId: pattern.id, value: 25 }]);
  assert.deepEqual(circles(), [10, 35, 60, 85, 110], "one spacing dimension moves every copy");
  const source = f.sketch.entities.find((e) => e.type === "circle" && Math.abs(e.values.x - 10) < 1e-6)!;
  await f.edit([{ op: "set", entityId: source.id, values: { radius: 4 } }]);
  assert.ok(f.sketch.entities.filter((e) => e.type === "circle").every((e) => Math.abs(e.values.radius - 4) < 1e-6), "copies match the source size");
  await f.run("extrude", { sketchId: f.sketchId, distance: 5 });
  const volume = f.view.geometry.bodies[0].volume;
  assert.ok(Math.abs(volume - (140 * 40 - 5 * Math.PI * 16) * 5) < 1e-3, `plate with five holes: ${volume}`);

  const g = await sketchDoc();
  await g.edit([
    { op: "add", ref: "$c", type: "circle", values: { x: 30, y: 0, radius: 4 } },
    { op: "constrain", type: "dimension", entities: ["$c"], dimension: "x", value: 30 },
    { op: "constrain", type: "dimension", entities: ["$c"], dimension: "y", value: 0 },
    { op: "pattern", entities: ["$c"], kind: "circular", count: 6 },
  ]);
  const around = () =>
    g.sketch.entities
      .filter((e) => e.type === "circle")
      .map((e) => Math.round((Math.atan2(e.values.y, e.values.x) * 180) / Math.PI))
      .map((a) => (a + 360) % 360)
      .sort((a, b) => a - b);
  assert.deepEqual(around(), [0, 60, 120, 180, 240, 300]);
  const turn = g.sketch.constraints.find((c) => c.type === "pattern")!;
  await g.edit([{ op: "value", constraintId: turn.id, value: 180 }]);
  assert.deepEqual(around(), [0, 36, 72, 108, 144, 180], "a partial angle spreads instances from first to last");
  assert.ok(g.sketch.entities.some((e) => e.type === "point" && e.construction), "a fixed center point at the origin");
});

/** Area between Bézier spans and the straight segment closing them (Green's theorem, Gauss–Legendre exact for cubics). */
function bezierArea(spans: [number, number][][]) {
  const g = [
    [-Math.sqrt(3 / 5), 5 / 9],
    [0, 8 / 9],
    [Math.sqrt(3 / 5), 5 / 9],
  ];
  let area = 0;
  for (const b of spans)
    for (const [x, w] of g) {
      const t = (x + 1) / 2,
        u = 1 - t;
      const p = [0, 1].map((k) => u * u * u * b[0][k] + 3 * u * u * t * b[1][k] + 3 * u * t * t * b[2][k] + t * t * t * b[3][k]);
      const d = [0, 1].map(
        (k) => 3 * (u * u * (b[1][k] - b[0][k]) + 2 * u * t * (b[2][k] - b[1][k]) + t * t * (b[3][k] - b[2][k])),
      );
      area += (w / 2) * 0.5 * (p[0] * d[1] - p[1] * d[0]);
    }
  // The straight segment from the last end back to the first start.
  const e = spans[spans.length - 1][3],
    s = spans[0][0];
  area += 0.5 * (e[0] * s[1] - e[1] * s[0]);
  return Math.abs(area);
}

test("splines: exact profiles, closed loops, intersections, mirror and fit point relations", async () => {
  const f = await sketchDoc();
  // A spline arch closed by a line extrudes to the exact area under the curve.
  await f.edit([
    { op: "add", ref: "$s", type: "spline", values: { x0: 0, y0: 0, x1: 20, y1: 30, x2: 60, y2: 25, x3: 80, y3: 0 } },
    { op: "add", ref: "$l", type: "line", values: { x1: 80, y1: 0, x2: 0, y2: 0 } },
    { op: "constrain", type: "coincident", entities: ["$s", "$l"], anchors: ["end", "start"] },
    { op: "constrain", type: "coincident", entities: ["$l", "$s"], anchors: ["end", "start"] },
  ]);
  const spline = f.sketch.entities.find((e) => e.type === "spline")!;
  const spans = splineSpans(fitPoints(spline));
  assert.equal(spans.length, 3);
  // Spans pass through every fit point and join with matching tangents.
  for (let i = 0; i + 1 < spans.length; i++) {
    assert.deepEqual(spans[i][3], spans[i + 1][0]);
    const a = [spans[i][3][0] - spans[i][2][0], spans[i][3][1] - spans[i][2][1]],
      b = [spans[i + 1][1][0] - spans[i + 1][0][0], spans[i + 1][1][1] - spans[i + 1][0][1]];
    assert.ok(Math.abs(a[0] * b[1] - a[1] * b[0]) < 1e-9, "tangent continuity");
  }
  const area = bezierArea(spans);
  await f.run("extrude", { sketchId: f.sketchId, distance: 10 });
  let body = f.view.geometry.bodies[0];
  assert.ok(Math.abs(body.volume - area * 10) < 1e-6 * area * 10, `arch volume ${body.volume} vs ${area * 10}`);
  // Moving a fit point keeps the profile closed and rebuilds exactly.
  await f.edit([{ op: "set", entityId: spline.id, values: { y1: 40 } }]);
  const moved = f.sketch.entities.find((e) => e.id === spline.id)!;
  assert.equal(moved.values.y1, 40);
  body = f.view.geometry.bodies[0];
  const movedArea = bezierArea(splineSpans(fitPoints(moved)));
  assert.ok(movedArea > area);
  assert.ok(Math.abs(body.volume - movedArea * 10) < 1e-6 * movedArea * 10, `edited arch ${body.volume}`);

  // A closed spline is smooth at its seam, and a line across it splits it into two regions.
  const g = await sketchDoc();
  const ring = { x0: 0, y0: -30, x1: 30, y1: 0, x2: 0, y2: 30, x3: -30, y3: 0, x4: 0, y4: -30 };
  await g.edit([
    { op: "add", type: "spline", values: ring },
    { op: "add", type: "line", values: { x1: -50, y1: 5, x2: 50, y2: 5 } },
  ]);
  const closed = splineSpans(fitPoints(g.sketch.entities.find((e) => e.type === "spline")!));
  const first = closed[0],
    last = closed[closed.length - 1];
  const t0 = [first[1][0] - first[0][0], first[1][1] - first[0][1]],
    t1 = [last[3][0] - last[2][0], last[3][1] - last[2][1]];
  assert.ok(Math.abs(t0[0] * t1[1] - t0[1] * t1[0]) < 1e-9 && t0[0] * t1[0] + t0[1] * t1[1] > 0, "smooth seam");
  const regions = sketchRegions(g.sketch);
  assert.equal(regions.length, 2);
  const total = bezierArea(closed);
  assert.ok(Math.abs(regions.reduce((sum, r) => sum + r.area, 0) - total) < 0.01 * total, "regions cover the loop");
  await g.run("extrude", { sketchId: g.sketchId, distance: 5 });
  const disc = g.view.geometry.bodies.reduce((sum, b) => sum + b.volume, 0);
  assert.ok(Math.abs(disc - total * 5) < 1e-6 * total * 5, `closed spline volume ${disc} vs ${total * 5}`);

  // Mirror copies each fit point with a symmetric relation; the copy follows the source.
  const h = await sketchDoc();
  await h.edit([
    { op: "add", ref: "$axis", type: "line", values: { x1: 0, y1: -10, x2: 0, y2: 50 }, construction: true },
    { op: "constrain", type: "fixed", entities: ["$axis"] },
    { op: "add", ref: "$s", type: "spline", values: { x0: 10, y0: 0, x1: 25, y1: 20, x2: 15, y2: 40 } },
  ]);
  const src = h.sketch.entities.find((e) => e.type === "spline")!,
    axis = h.sketch.entities.find((e) => e.type === "line")!;
  await h.edit([{ op: "mirror", entities: [src.id], axis: axis.id }]);
  const copy = h.sketch.entities.find((e) => e.type === "spline" && e.id !== src.id)!;
  assert.deepEqual(fitPoints(copy).map((p) => p.map((v) => Math.round(v * 1e6) / 1e6)), [
    [-10, 0],
    [-25, 20],
    [-15, 40],
  ]);
  await h.edit([{ op: "set", entityId: src.id, values: { x1: 35 } }]);
  assert.ok(Math.abs(h.sketch.entities.find((e) => e.id === copy.id)!.values.x1 + 35) < 1e-6);

  // Dragging a fit point moves it and the mirrored copy follows.
  await h.edit([{ op: "drag", entityId: src.id, anchor: "p2", target: [20, 45] }]);
  const dragged = h.sketch.entities.find((e) => e.id === src.id)!;
  assert.ok(Math.hypot(dragged.values.x2 - 20, dragged.values.y2 - 45) < 1e-6, "fit point follows the drag");
  assert.ok(Math.abs(h.sketch.entities.find((e) => e.id === copy.id)!.values.x2 + 20) < 1e-6);

  // Invalid fit point lists are rejected without changing the sketch.
  const before = h.view.document.revision;
  await assert.rejects(h.edit([{ op: "add", type: "spline", values: { x0: 0, y0: 0 } }]));
  await assert.rejects(h.edit([{ op: "add", type: "spline", values: { x0: 0, y0: 0, x2: 1, y2: 1 } }]));
  assert.equal(h.view.document.revision, before);
});

test("splines: power trim keeps the exact curve and closes a profile with a line", async () => {
  const f = await sketchDoc();
  const ring = { x0: 0, y0: -30, x1: 30, y1: 0, x2: 0, y2: 30, x3: -30, y3: 0, x4: 0, y4: -30 };
  await f.edit([
    { op: "add", ref: "$s", type: "spline", values: ring },
    { op: "constrain", type: "coincident", entities: ["$s", "$s"], anchors: ["p0", "p4"] },
    { op: "add", type: "line", values: { x1: -50, y1: 5, x2: 50, y2: 5 } },
  ]);
  const original = structuredClone(f.sketch.entities.find((e) => e.type === "spline")!);
  const trim = async (id: string, at: [number, number]) => {
    const e = f.sketch.entities.find((x) => x.id === id)!;
    const ops = trimOps(f.sketch, e, at);
    assert.ok(ops?.length, `trim at ${at}`);
    await f.edit(ops!);
  };
  // Trim the lower part of the closed spline, then the line ends outside it.
  await trim(original.id, [0, -30]);
  const kept = f.sketch.entities.find((e) => e.id === original.id)!;
  assert.ok("from" in kept.values && kept.values.to > kept.values.from);
  fitPoints(kept).forEach((q, i) => assert.ok(Math.hypot(q[0] - fitPoints(original)[i][0], q[1] - fitPoints(original)[i][1]) < 1e-5, "fit points stay"));
  // Every point of the kept curve lies on the original curve.
  for (const b of splineBeziers(kept))
    for (let i = 0; i <= 20; i++) {
      const t = i / 20,
        u = 1 - t;
      const q: [number, number] = [0, 1].map((k) => u * u * u * b[0][k] + 3 * u * u * t * b[1][k] + 3 * u * t * t * b[2][k] + t * t * t * b[3][k]) as [number, number];
      const n = nearestOnEntity(original, q)!;
      assert.ok(Math.hypot(n[0] - q[0], n[1] - q[1]) < 1e-7, "kept curve is the original");
    }
  // The kept ends lie on the line.
  for (const end of [splineBeziers(kept)[0][0], splineBeziers(kept).at(-1)![3]]) assert.ok(Math.abs(end[1] - 5) < 1e-7);
  const line = f.sketch.entities.find((e) => e.type === "line")!;
  await trim(line.id, [-45, 5]);
  await trim(line.id, [45, 5]);
  const trimmedLine = f.sketch.entities.find((e) => e.id === line.id)!;
  // The line now runs between the spline's ends, held there by relations.
  assert.ok(Math.abs(Math.abs(trimmedLine.values.x2 - trimmedLine.values.x1) - 2 * Math.abs(splineBeziers(kept)[0][0][0])) < 1e-5);
  assert.deepEqual(
    f.sketch.constraints.map((c) => c.type).sort(),
    ["coincident", "coincident", "coincident", "pointOn", "pointOn"],
  );
  await f.run("extrude", { sketchId: f.sketchId, distance: 4 });
  const area = bezierArea(splineBeziers(f.sketch.entities.find((e) => e.id === original.id)!));
  const body = f.view.geometry.bodies[0];
  assert.equal(f.view.geometry.bodies.length, 1);
  assert.ok(Math.abs(body.volume - area * 4) < 1e-6 * area * 4, `trimmed profile ${body.volume} vs ${area * 4}`);
  // Moving a fit point reshapes the kept curve; the trim range keeps its meaning.
  await f.edit([{ op: "set", entityId: original.id, values: { y2: 40 } }]);
  const reshaped = f.sketch.entities.find((e) => e.id === original.id)!;
  assert.equal(reshaped.values.y2, 40);
  assert.ok(f.view.geometry.bodies[0].volume > body.volume);

  // An open spline cut in the middle leaves two exact pieces.
  const g = await sketchDoc();
  await g.edit([
    { op: "add", type: "spline", values: { x0: 0, y0: 0, x1: 20, y1: 30, x2: 60, y2: 25, x3: 80, y3: 0 } },
    { op: "add", type: "line", values: { x1: 25, y1: -10, x2: 25, y2: 50 } },
    { op: "add", type: "line", values: { x1: 55, y1: -10, x2: 55, y2: 50 } },
  ]);
  const open = g.sketch.entities.find((e) => e.type === "spline")!;
  await g.edit(trimOps(g.sketch, open, [40, 30])!);
  const pieces = g.sketch.entities.filter((e) => e.type === "spline");
  assert.equal(pieces.length, 2);
  const ranges = pieces.map((e) => [e.values.from, e.values.to]).sort((a, b) => a[0] - b[0]);
  assert.equal(ranges[0][0], 0);
  assert.equal(ranges[1][1], 3);
  for (const [x, piece] of [[25, pieces.find((e) => e.values.from === 0)!], [55, pieces.find((e) => e.values.to === 3)!]] as const) {
    const end = piece.values.from === 0 ? splineBeziers(piece).at(-1)![3] : splineBeziers(piece)[0][0];
    assert.ok(Math.abs(end[0] - x) < 1e-7, `cut at x=${x}`);
  }
  // Ranges outside the curve are rejected.
  await assert.rejects(g.edit([{ op: "set", entityId: open.id, values: { from: 2, to: 1 } }]));
});
