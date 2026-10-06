import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import type { Topology, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-thread-"));
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

test("threads: lightweight cosmetic threads by default, modeled ISO threads on request", async () => {
  // A Ø10 shaft 30 long on a 30 × 30 × 6 block.
  const id = ((await store.create("Axle")) as View).document.id;
  let v: View = await run(id, "create_sketch", { plane: "XY" });
  await run(id, "add_sketch_entity", { sketchId: v.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 30, height: 30 } });
  v = await run(id, "extrude", { sketchId: v.document.sketches[0].id, distance: 6 });
  const top = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  v = await run(id, "create_sketch", { support: ref(top) });
  await run(id, "add_sketch_entity", { sketchId: v.document.sketches[1].id, type: "circle", values: { x: 0, y: 0, radius: 5 } });
  v = await run(id, "extrude", { sketchId: v.document.sketches[1].id, distance: 30, operation: "join", bodyId: v.document.bodies[0].id });
  const volume = v.geometry.bodies[0].volume;
  const shaft = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
  // Cosmetic: nothing in the solid changes; the body carries the thread for display and drawings.
  v = await run(id, "create_thread", { bodyId: v.document.bodies[0].id, face: ref(shaft), size: "M10", length: 20, reverse: true });
  assert.equal(v.geometry.bodies[0].volume, volume);
  const thread = v.geometry.bodies[0].threads![0];
  assert.deepEqual([thread.label, thread.internal, thread.modeled, thread.pitch, thread.length], ["M10×1.5", false, false, 1.5, 20]);
  assert.ok(Math.abs(thread.radius - 5) < 1e-9);
  // Starts at the free end (z = 36) and runs down toward the block.
  assert.ok(Math.abs(thread.origin[2] - 36) < 1e-9 && thread.direction[2] < -0.999, `thread from ${thread.origin} along ${thread.direction}`);

  // Modeled: a real ISO groove, between the minor and major diameter.
  const feature = (await store.read(id)).features.at(-1)!;
  v = await run(id, "create_thread", { featureId: feature.id, bodyId: v.document.bodies[0].id, face: ref(shaft), size: "M10", length: 20, reverse: true, mode: "modeled" });
  const removed = volume - v.geometry.bodies[0].volume;
  const minor = (10 - 1.226869 * 1.5) / 2;
  assert.ok(removed > 0.15 * (Math.PI * (25 - minor * minor) * 20) && removed < Math.PI * (25 - minor * minor) * 20, `groove volume ${removed}`);
  // A hole thread is internal; modeling it needs the tap drill.
  const hole = ((await store.create("Nut block")) as View).document.id;
  let h: View = await run(hole, "create_sketch", { plane: "XY" });
  await run(hole, "add_sketch_entity", { sketchId: h.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 20, height: 20 } });
  h = await run(hole, "extrude", { sketchId: h.document.sketches[0].id, distance: 10 });
  const face = h.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  h = await run(hole, "create_hole", { bodyId: h.document.bodies[0].id, face: ref(face), frame: "origin", positions: [[0, 0]], diameter: 8.5 });
  const bore = h.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
  h = await run(hole, "create_thread", { bodyId: h.document.bodies[0].id, face: ref(bore), size: "M10" });
  assert.equal(h.geometry.bodies[0].threads![0].internal, true);
  await assert.rejects(run(hole, "create_thread", { bodyId: h.document.bodies[0].id, face: ref(bore), size: "M6", mode: "modeled" }), /tap M6/);
  const flat = h.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.geomType === "PLANE")!;
  await assert.rejects(run(hole, "create_thread", { bodyId: h.document.bodies[0].id, face: ref(flat), size: "M10" }), /cylindrical/);
});

/** Path point lists inside each view's thread marks, by view id. */
function threadMarks(svg: string) {
  const out = new Map<string, { layer: string; dashed: boolean; width: number; points: number[][] }[]>();
  const views = [...svg.matchAll(/data-view="([^"]+)"/g)];
  views.forEach((m, i) => {
    const slice = svg.slice(m.index, views[i + 1]?.index ?? svg.length);
    const paths = [...slice.matchAll(/<g data-thread="[^"]*">(.*?)<\/g>/g)].flatMap((g) =>
      [...g[1].matchAll(/<path d="([^"]+)"[^>]*stroke-width="([\d.]+)"([^>]*)data-layer="(\w+)"/g)].map((p) => ({
        layer: p[4],
        dashed: p[3].includes("dasharray"),
        width: Number(p[2]),
        points: [...p[1].matchAll(/[ML] ([-\d.]+) ([-\d.]+)/g)].map((q) => [Number(q[1]), Number(q[2])]),
      })),
    );
    if (paths.length) out.set(m[1], paths);
  });
  return out;
}
const span = (pts: number[][]) => Math.hypot(pts.at(-1)![0] - pts[0][0], pts.at(-1)![1] - pts[0][1]);
const gap = (a: number[][], b: number[][]) => {
  // Distance between two parallel segments.
  const [p, q] = [a[0], a.at(-1)!],
    l = Math.hypot(q[0] - p[0], q[1] - p[1]);
  return Math.abs((q[0] - p[0]) * (p[1] - b[0][1]) - (p[0] - b[0][0]) * (q[1] - p[1])) / l;
};

test("threads on drawings: simplified representation and callouts", async () => {
  // A Ø10 shaft on a block, threaded M10 for 20 of its 30 mm from the free end.
  const id = ((await store.create("Stud")) as View).document.id;
  let v: View = await run(id, "create_sketch", { plane: "XY" });
  await run(id, "add_sketch_entity", { sketchId: v.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 30, height: 30 } });
  v = await run(id, "extrude", { sketchId: v.document.sketches[0].id, distance: 6 });
  const top = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  v = await run(id, "create_sketch", { support: ref(top) });
  await run(id, "add_sketch_entity", { sketchId: v.document.sketches[1].id, type: "circle", values: { x: 0, y: 0, radius: 5 } });
  v = await run(id, "extrude", { sketchId: v.document.sketches[1].id, distance: 30, operation: "join", bodyId: v.document.bodies[0].id });
  const body = v.document.bodies[0].id;
  const shaft = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.geomType === "CYLINDRE")!;
  v = await run(id, "create_thread", { bodyId: body, face: ref(shaft), size: "M10", length: 20, reverse: true });
  v = await run(id, "create_drawing", { name: "Stud", bodyIds: [body], size: "A3", scale: 1, dimensions: false });
  const sheetId = v.document.drawings![0].id;
  let r = await run(id, "render_drawing", { drawingId: sheetId });
  let marks = threadMarks(r.svg);
  const minor = 10 - 1.226869 * 1.5;
  // Side views: roots as two thin lines 20 long at the minor diameter, a thick limit line across the major.
  for (const view of ["front", "right"]) {
    const m = marks.get(view)!;
    const thin = m.filter((p) => p.layer === "thread"),
      limit = m.filter((p) => p.layer === "visible");
    assert.equal(thin.length, 2, view);
    assert.ok(thin.every((p) => Math.abs(span(p.points) - 20) < 0.01 && !p.dashed), `${view} roots`);
    assert.ok(Math.abs(gap(thin[0].points, thin[1].points) - minor) < 0.01, `${view} minor ${gap(thin[0].points, thin[1].points)}`);
    assert.equal(limit.length, 1);
    assert.ok(Math.abs(span(limit[0].points) - 10) < 0.01 && limit[0].width > thin[0].width, `${view} limit line`);
  }
  // The shaft's seam is not an edge: no visible line runs down its axis in a side view.
  for (const view of ["front", "right"]) {
    const thin = marks.get(view)!.filter((p) => p.layer === "thread"),
      axis = (thin[0].points[0][0] + thin[1].points[0][0]) / 2;
    const views = [...r.svg.matchAll(/data-view="([^"]+)"/g)],
      at = views.findIndex((m: RegExpMatchArray) => m[1] === view),
      slice = r.svg.slice(views[at].index, views[at + 1]?.index ?? r.svg.length);
    // Straight segments of visible paths (edges chain into longer paths).
    const seams = [...slice.matchAll(/<path d="([^"]+)"[^>]*data-layer="visible"/g)].flatMap((m) => {
      const cmds = [...m[1].matchAll(/([MLCAZ])([^MLCAZ]*)/g)].map((c) => [c[1], ...c[2].trim().split(/\s+/).filter(Boolean).map(Number)] as [string, ...number[]]);
      const segments: number[][][] = [];
      for (let i = 1; i < cmds.length; i++) {
        const [k, ...v] = cmds[i],
          prev = cmds[i - 1].slice(-2) as number[];
        if (k === "L") segments.push([prev, v]);
      }
      return segments.filter(([a, b]) => Math.abs(a[0] - axis) < 0.05 && Math.abs(b[0] - axis) < 0.05 && Math.abs(b[1] - a[1]) > 10);
    });
    assert.equal(seams.length, 0, `${view} shows the cylinder seam`);
  }
  // From above, the free end: a thin three-quarter circle at the minor diameter.
  const arc = marks.get("top")!;
  assert.equal(arc.length, 1);
  const c = r.views.find((x: any) => x.id === "top").circles[0].center;
  const radii = arc[0].points.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]));
  assert.ok(radii.every((x) => Math.abs(x - minor / 2) < 0.01), "on the root circle");
  const turned = (Math.atan2(arc[0].points.at(-1)![1] - c[1], arc[0].points.at(-1)![0] - c[0]) - Math.atan2(arc[0].points[0][1] - c[1], arc[0].points[0][0] - c[0]) + 2 * Math.PI) % (2 * Math.PI);
  assert.ok(Math.abs(turned - (260 * Math.PI) / 180) < 0.01, "three quarters, open at the upper right");
  assert.ok(!marks.has("iso"), "pictorial views carry no thread marks");
  // The shaft's diameter dimension reads as the thread; a callout adds its length.
  const rim = r.views.find((x: any) => x.id === "top").circles[0].reference;
  await run(id, "add_drawing_dimension", { drawingId: sheetId, view: "top", type: "diameter", points: [{ ref: rim }], position: [30, -30] });
  await run(id, "add_drawing_dimension", { drawingId: sheetId, view: "top", type: "hole", points: [{ ref: rim }], position: [-40, -30] });
  r = await run(id, "render_drawing", { drawingId: sheetId });
  assert.equal((r.svg.match(/>M10×1\.5</g) ?? []).length, 2);
  assert.match(r.svg, />THREAD LENGTH 20</);
  assert.doesNotMatch(r.svg, />Ø10</);

  // A tapped through hole: hidden in side views, sectioned along its axis, called out with the tap drill.
  const nut = ((await store.create("Tapped block")) as View).document.id;
  let h: View = await run(nut, "create_sketch", { plane: "XY" });
  await run(nut, "add_sketch_entity", { sketchId: h.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 40, height: 20 } });
  h = await run(nut, "extrude", { sketchId: h.document.sketches[0].id, distance: 10 });
  const face = h.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  h = await run(nut, "create_hole", { bodyId: h.document.bodies[0].id, face: ref(face), frame: "origin", positions: [[-10, 0], [10, 0]], diameter: 8.5 });
  const bores = h.geometry.bodies[0].topology.filter((t) => t.kind === "face" && t.geomType === "CYLINDRE");
  for (const bore of bores) h = await run(nut, "create_thread", { bodyId: h.document.bodies[0].id, face: ref(bore), size: "M10", hand: "left" });
  h = await run(nut, "create_drawing", { name: "Block", bodyIds: [h.document.bodies[0].id], size: "A3", scale: 1, dimensions: false });
  const blockSheet = h.document.drawings![0].id;
  await run(nut, "add_drawing_view", { drawingId: blockSheet, kind: "section", parentId: "top", a: [-30, 0], b: [30, 0], position: [300, 200] });
  const section = (await store.read(nut)).drawings![0].views!.at(-1)!.id;
  r = await run(nut, "render_drawing", { drawingId: blockSheet });
  marks = threadMarks(r.svg);
  const front = marks.get("front")!;
  assert.ok(front.length === 4 && front.every((p) => p.dashed && p.layer === "hidden" && Math.abs(span(p.points) - 10) < 0.01), "hidden at the major diameter, no limit line through");
  assert.ok(Math.abs(gap(front[0].points, front[1].points) - 10) < 0.01);
  const cut = marks.get(section)!;
  assert.ok(cut.length === 4 && cut.every((p) => !p.dashed && p.layer === "thread"), "sectioned: thin solid roots");
  // Both ends are thread ends: seen from above as a three-quarter circle at the major diameter.
  assert.equal(marks.get("top")!.length, 2);
  const hole = r.views.find((x: any) => x.id === "top").circles.find((x: any) => Math.abs(x.radius - 4.25) < 1e-6).reference;
  await run(nut, "add_drawing_dimension", { drawingId: blockSheet, view: "top", type: "hole", points: [{ ref: hole }], position: [-40, -30] });
  r = await run(nut, "render_drawing", { drawingId: blockSheet });
  assert.match(r.svg, />2× M10×1\.5 LH THRU</);
  assert.match(r.svg, />TAP DRILL Ø8\.5</);
  // Hidden lines off: the hole's thread disappears from the side views.
  await run(nut, "update_drawing", { drawingId: blockSheet, hiddenLines: false });
  assert.ok(!threadMarks((await run(nut, "render_drawing", { drawingId: blockSheet })).svg).has("front"));
});
