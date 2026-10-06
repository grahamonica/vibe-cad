import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import type { Topology, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-weld-"));
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
const near = (a: number, b: number, tol: number, label: string) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${label}: ${a} vs ${b}`);

test("weldments: a mitered or butted tube frame, its cut list, and weld beads", async () => {
  const id = ((await store.create("Frame")) as View).document.id;
  let v: View = await run(id, "create_sketch", { plane: "XY" });
  const sketchId = v.document.sketches[0].id;
  await run(id, "edit_sketch", {
    sketchId,
    operations: [
      { op: "add", type: "line", values: { x1: 0, y1: 0, x2: 200, y2: 0 } },
      { op: "add", type: "line", values: { x1: 200, y1: 0, x2: 200, y2: 100 } },
      { op: "add", type: "line", values: { x1: 200, y1: 100, x2: 0, y2: 100 } },
      { op: "add", type: "line", values: { x1: 0, y1: 100, x2: 0, y2: 0 } },
    ],
  });
  const profile = { kind: "square-tube", width: 25, thickness: 2 };
  v = await run(id, "create_structural_member", { sketchId, profile });
  const area = 25 * 25 - 21 * 21;
  assert.equal(v.geometry.bodies.length, 4);
  // Mitered members: each one's volume is its section times its centerline.
  const volumes = v.geometry.bodies.map((b) => b.volume).sort((a, b) => a - b);
  near(volumes[0], area * 100, 1e-6, "short member");
  near(volumes[3], area * 200, 1e-6, "long member");
  const [a, b] = v.geometry.bodies.map((x) => x.id);
  assert.ok((await run(id, "analyze_interference", { bodyA: a, bodyB: b })).volume < 1e-6, "mitered members only touch");
  const list = await run(id, "cut_list");
  assert.deepEqual(list.items.map((x: any) => [x.profile, x.count, x.total]), [["Square tube 25×25×2", 4, 600]]);

  // Butt corners: the earlier line runs through, the later stops at its side.
  v = await run(id, "create_structural_member", { featureId: v.document.features[0].id, profile, corner: "butt" });
  const lengths = v.document.features.map((f) => v.geometry.bodies.find((x) => x.id === f.bodyId)!.volume / area);
  lengths.forEach((l, i) => near(l, [225, 100, 200, 75][i], 1e-6, `butt member ${i + 1}`));

  // Back to miters, combined into one frame, with a weld in an inside corner.
  v = await run(id, "create_structural_member", { featureId: v.document.features[0].id, profile, corner: "miter" });
  const ids = v.document.bodies.map((x) => x.id);
  for (const tool of ids.slice(1)) v = await run(id, "boolean_bodies", { bodyId: ids[0], toolBodyId: tool, operation: "union" });
  const frame = v.geometry.bodies.find((x) => x.id === ids[0])!;
  const corner = frame.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[0] - 12.5) < 1e-6 && Math.abs(t.center[1] - 12.5) < 1e-6)!;
  const before = frame.volume;
  v = await run(id, "create_weld_bead", { bodyId: ids[0], edges: [ref(corner)], size: 4 });
  near(v.geometry.bodies.find((x) => x.id === ids[0])!.volume - before, (4 * 4) / 2 * 25, 1e-6, "weld bead volume");
  const outside = v.geometry.bodies.find((x) => x.id === ids[0])!.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[0] + 12.5) < 1e-6 && Math.abs(t.center[1] + 12.5) < 1e-6)!;
  await assert.rejects(run(id, "create_weld_bead", { bodyId: ids[0], edges: [ref(outside)], size: 4 }), /inside corners/);

  // A cross member ending partway along the frame stops at the frame's inner side (a T-joint).
  const tee = ((await store.create("Ladder")) as View).document.id;
  let t: View = await run(tee, "create_sketch", { plane: "XY" });
  await run(tee, "edit_sketch", {
    sketchId: t.document.sketches[0].id,
    operations: [
      { op: "add", type: "line", values: { x1: 0, y1: 0, x2: 300, y2: 0 } },
      { op: "add", type: "line", values: { x1: 150, y1: 0, x2: 150, y2: 100 } },
    ],
  });
  t = await run(tee, "create_structural_member", { sketchId: t.document.sketches[0].id, profile });
  const cross = t.geometry.bodies.find((x) => x.id === t.document.features[1].bodyId)!;
  near(cross.volume, area * (100 - 12.5), 1e-6, "cross member stops at the rail's side");
  assert.ok((await run(tee, "analyze_interference", { bodyA: t.geometry.bodies[0].id, bodyB: cross.id })).volume < 1e-6, "no overlap at the T");
  const cut = await run(tee, "cut_list");
  near(cut.items[0].lengths[1], 87.5, 1e-6, "cut length of the cross member");
});

test("weld symbols on drawings: AWS fillet symbol with the bead's leg, length, sides, field and tail", async () => {
  // An L-bracket: a 60 × 40 × 6 base and a 6 mm upright, welded in the inside corner.
  const id = ((await store.create("Bracket weld")) as View).document.id;
  let v: View = await run(id, "create_sketch", { plane: "XY" });
  await run(id, "add_sketch_entity", { sketchId: v.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 60, height: 40 } });
  v = await run(id, "extrude", { sketchId: v.document.sketches[0].id, distance: 6 });
  const body = v.document.bodies[0].id;
  const top = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  v = await run(id, "create_sketch", { support: ref(top) });
  await run(id, "add_sketch_entity", { sketchId: v.document.sketches[1].id, type: "rectangle", values: { x: -27, y: 0, width: 6, height: 40 } });
  v = await run(id, "extrude", { sketchId: v.document.sketches[1].id, distance: 30, operation: "join", bodyId: body });
  const corner = v.geometry.bodies[0].topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[0] + 24) < 1e-6 && Math.abs(t.center[2] - 6) < 1e-6)!;
  v = await run(id, "create_weld_bead", { bodyId: body, edges: [ref(corner)], size: 5 });
  const weld = v.document.features.at(-1)!;
  const bead = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.featureId === weld.id && t.normal && Math.abs(t.normal[0]) > 0.5 && Math.abs(t.normal[2]) > 0.5)!;
  assert.ok(bead, "the bead's sloped face");
  v = await run(id, "create_drawing", { name: "Weld", bodyIds: [body], size: "A3", scale: 1, dimensions: false });
  const sheetId = v.document.drawings![0].id;
  v = await run(id, "add_drawing_annotation", { drawingId: sheetId, annotation: { type: "weld", view: "front", ref: ref(bead), position: [120, 70] } });
  const annotationId = v.document.drawings![0].annotations!.at(-1)!.id;
  const group = async () => {
    const svg: string = (await run(id, "render_drawing", { drawingId: sheetId })).svg;
    return svg.match(new RegExp(`<g data-annotation="${annotationId}">(.*?)</g>`))![1];
  };
  const triangles = (g: string) =>
    [...g.matchAll(/<path d="M ([-\d.]+) ([-\d.]+) L ([-\d.]+) ([-\d.]+) L ([-\d.]+) ([-\d.]+) Z"/g)].map((m) => [1, 3, 5].map((i) => [Number(m[i]), Number(m[i + 1])]));
  const texts = (g: string) => [...g.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]);

  // Arrow side: one fillet triangle below the reference line, perpendicular leg on the left, the bead's 5 mm leg to its left.
  let g = await group();
  const tri = triangles(g).filter((t) => t.some((p) => Math.abs(p[1] - 70) < 1e-6) && t.every((p) => p[1] >= 70 - 1e-6));
  assert.equal(tri.length, 1, "one fillet symbol, below the line");
  const xs = tri[0].map((p) => p[0]),
    left = Math.min(...xs);
  assert.equal(tri[0].filter((p) => Math.abs(p[0] - left) < 1e-6).length, 2, "the perpendicular leg is on the left");
  assert.deepEqual(texts(g), ["5"]);

  // Both sides, a 30 mm length, all around, field weld and a process tail.
  await run(id, "update_drawing_annotation", { drawingId: sheetId, annotationId, sides: "both", length: 30, allAround: true, field: true, process: "GMAW" });
  g = await group();
  const all = triangles(g).filter((t) => t.some((p) => Math.abs(p[1] - 70) < 1e-6) && Math.max(...t.map((p) => Math.abs(p[1] - 70))) > 2.9);
  assert.equal(all.length, 2, "a fillet symbol on each side");
  assert.deepEqual(texts(g).sort(), ["30", "30", "5", "5", "GMAW"]);
  assert.match(g, /<path d="M 121\.6 70 A 1\.6 1\.6/, "all-around circle at the knee");
  assert.match(g, /fill="#1E1E1E"/, "field weld flag");

  // An explicit leg overrides the bead's; clearing the length returns to the full joint.
  await run(id, "update_drawing_annotation", { drawingId: sheetId, annotationId, leg: 6, length: null, process: null });
  g = await group();
  assert.deepEqual(texts(g).sort(), ["6", "6"]);
  await assert.rejects(run(id, "update_drawing_annotation", { drawingId: sheetId, annotationId, leg: -1 }));
});
