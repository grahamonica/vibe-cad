import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import { flangeSection } from "../cad/kernel.ts";
import type { Topology, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-sheet-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const store = new Store(join(dir, "docs")),
  tools = toolset(store);
const ref = (t: Topology) => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType });
async function sheetPart() {
  let v = (await store.create("Bracket")) as View;
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
  await run("add_sketch_entity", { sketchId: v.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 100, height: 60 } });
  await run("create_base_flange", { sketchId: v.document.sketches[0].id, thickness: 2 });
  return {
    run,
    get view() {
      return v;
    },
    get body() {
      return v.geometry.bodies[0];
    },
  };
}
const near = (a: number, b: number, rel: number, label: string) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${label}: ${a} vs ${b}`);
/** Cross-section area of a flange: the bend sector plus the straight wall. */
const flangeArea = (T: number, R: number, angle: number, length: number) => {
  const s = flangeSection(T, R, angle, length);
  return (s.th / 2) * ((R + T) ** 2 - R ** 2) + T * s.straight;
};

test("sheet metal: edge flanges bend real walls, sized from the outer virtual sharp, up, down or at an angle", async () => {
  const f = await sheetPart();
  assert.ok(Math.abs(f.body.volume - 100 * 60 * 2) < 1e-6);
  const edgeAt = (y: number, z: number) =>
    f.body.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[1] - y) < 1e-6 && Math.abs(t.center[2] - z) < 1e-6 && Math.abs(t.center[0]) < 1e-6)!;
  await f.run("create_edge_flange", { bodyId: f.body.id, edge: ref(edgeAt(30, 2)), length: 20 });
  let expected = 100 * 60 * 2 + 100 * flangeArea(2, 2, 90, 20);
  assert.ok(Math.abs(f.body.volume - expected) < 1e-3, `90° flange: ${f.body.volume} vs ${expected}`);
  assert.ok(Math.abs(f.body.bounds[1][2] - 20) < 1e-6, "20 mm tall from the outer virtual sharp");
  assert.ok(Math.abs(f.body.bounds[1][1] - 34) < 1e-6, "the wall stands outside the base, at y = 30 + R + T");
  // Bend down from the opposite edge, at 45°.
  await f.run("create_edge_flange", { bodyId: f.body.id, edge: ref(edgeAt(-30, 2)), length: 15, angle: 45, flip: true });
  expected += 100 * flangeArea(2, 2, 45, 15);
  assert.ok(Math.abs(f.body.volume - expected) < 1e-3, `45° flange: ${f.body.volume} vs ${expected}`);
  assert.ok(f.body.bounds[0][2] < -5, `bent downward: ${JSON.stringify(f.body.bounds)}`);
  // A flange too short to clear its bend is rejected.
  const end = f.body.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[0] - 50) < 1e-6 && Math.abs(t.center[1]) < 1e-6 && Math.abs(t.center[2] - 2) < 1e-6)!;
  await assert.rejects(f.run("create_edge_flange", { bodyId: f.body.id, edge: ref(end), length: 1 }), /length must be at least/);
  // An edge that already carries a bend is not an outline edge.
  await assert.rejects(f.run("create_edge_flange", { bodyId: f.body.id, edge: ref(edgeAt(30, 2)), length: 10 }), /sheet's outline/);
});

test("sheet metal: the flat pattern unrolls each flange by its bend allowance and exports DXF", async () => {
  const f = await sheetPart();
  const edge = f.body.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[1] - 30) < 1e-6 && Math.abs(t.center[2] - 2) < 1e-6)!;
  await f.run("create_edge_flange", { bodyId: f.body.id, edge: ref(edge), length: 20 });
  const flat = await f.run("flat_pattern", { bodyId: f.body.id });
  // Bend allowance θ(R + K·T) plus the straight wall beyond the bend.
  const ba = (Math.PI / 2) * (2 + 0.44 * 2),
    depth = ba + (20 - 2 - 2);
  assert.ok(Math.abs(flat.width - 100) < 1e-6);
  assert.ok(Math.abs(flat.height - (60 + depth)) < 1e-6, `flat height ${flat.height} vs ${60 + depth}`);
  assert.equal(flat.bends.length, 1);
  assert.equal(flat.bends[0].label, "UP 90° R2");
  const exported = await f.run("flat_pattern", { bodyId: f.body.id, export: true });
  const dxf = await readFile(exported.path, "utf8");
  assert.match(dxf, /\nCUT\n/);
  assert.match(dxf, /\nBEND\n/);
});

test("sheet metal: a drawing shows the flat pattern view with its bend lines next to the formed views", async () => {
  const f = await sheetPart();
  const edge = f.body.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[1] - 30) < 1e-6 && Math.abs(t.center[2] - 2) < 1e-6)!;
  await f.run("create_edge_flange", { bodyId: f.body.id, edge: ref(edge), length: 20 });
  await f.run("create_drawing", { name: "Sheet", bodyIds: [f.body.id], size: "A3", scale: 0.5, dimensions: false });
  const sheetId = f.view.document.drawings![0].id;
  await f.run("add_drawing_view", { drawingId: sheetId, kind: "flat", position: [330, 220] });
  const r = await f.run("render_drawing", { drawingId: sheetId });
  assert.match(r.svg, /FLAT PATTERN/);
  assert.match(r.svg, /UP 90° R2/);
  const flat = r.views.find((v: any) => v.id === f.view.document.drawings![0].views!.at(-1)!.id);
  const depth = (Math.PI / 2) * (2 + 0.44 * 2) + 16;
  assert.ok(Math.abs(flat.bounds[2] - 50) < 0.6 && Math.abs(flat.bounds[3] - (60 + depth) * 0.5) < 0.6, `flat view size ${flat.bounds}`);
  // Only sheet metal bodies unfold.
  await f.run("create_sketch", { plane: "XY" });
  await f.run("add_sketch_entity", { sketchId: f.view.document.sketches.at(-1)!.id, type: "circle", values: { x: 200, y: 0, radius: 5 } });
  await f.run("extrude", { sketchId: f.view.document.sketches.at(-1)!.id, distance: 5 });
  await assert.rejects(
    f.run("add_drawing_view", { drawingId: sheetId, kind: "flat", bodyId: f.view.document.bodies.at(-1)!.id, position: [100, 100] }),
    /sheet metal body/,
  );
});

test("sheet metal: flanges on flange ends and hems, unrolled in a chain", async () => {
  const s = await sheetPart();
  const bodyId = s.view.document.bodies[0].id;
  const edgeAt = (y: number, z: number) => s.body.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[1] - y) < 1e-6 && Math.abs(t.center[2] - z) < 1e-6 && Math.abs(t.center[0]) < 1e-6)!;
  const base = s.body.volume;
  await s.run("create_edge_flange", { bodyId, edge: ref(edgeAt(30, 2)), length: 20 });
  const wall = s.view.document.features.at(-1)!.id;
  near(s.body.volume - base, flangeArea(2, 2, 90, 20) * 100, 1e-6, "first flange");
  // The wall's end: the flat face at its top, T across; fold its outer edge back over the plate.
  const end = s.body.topology.filter((t) => t.kind === "face" && t.featureId === wall && t.geomType === "PLANE" && t.normal?.[2] === 1).sort((a, b) => b.center[2] - a.center[2])[0];
  const lip = s.body.topology.filter((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[2] - end.center[2]) < 1e-6 && Math.abs(t.center[0]) < 1e-6).sort((a, b) => a.center[1] - b.center[1])[0];
  const before = s.body.volume;
  await s.run("create_edge_flange", { bodyId, edge: ref(lip), length: 15 });
  near(s.body.volume - before, flangeArea(2, 2, 90, 15) * 100, 1e-6, "flange on the flange");
  // It folds over at the top of the wall (a lip), not out from the wall's face.
  assert.ok(s.body.bounds[1][2] < 20 + 2 * 2 + 1e-6, `lip stays at the top of the wall: ${s.body.bounds[1][2]}`);
  // A closed hem on the opposite edge.
  const hemBefore = s.body.volume;
  await s.run("create_hem", { bodyId, edge: ref(edgeAt(-30, 2)), length: 10 });
  const R = Math.max(0.01, 0.05 * 2);
  near(s.body.volume - hemBefore, flangeArea(2, R, 180, 10) * 100, 1e-6, "closed hem");
  assert.match(s.view.document.features.at(-1)!.name, /^Hem 1$/);
  // The flat pattern unrolls all three in their chain.
  const flat = await s.run("flat_pattern", { bodyId });
  const depth = (r: number, angle: number, l: number) => ((angle * Math.PI) / 180) * (r + 0.44 * 2) + Math.max(0, flangeSection(2, r, angle, l).straight);
  near(flat.width, 100, 1e-6, "flat width");
  near(flat.height, 60 + depth(2, 90, 20) + depth(2, 90, 15) + depth(R, 180, 10), 1e-6, "flat height");
  assert.equal(flat.bends.length, 3);
  assert.deepEqual(flat.bends.map((b: any) => b.label.split(" ")[1]).sort(), ["180°", "90°", "90°"]);
});

test("sheet metal: a sketched bend folds the plate exactly, and the flat pattern shows the blank and bend line", async () => {
  const s = await sheetPart();
  const bodyId = s.view.document.bodies[0].id;
  // A hole in the flat, then a bend line across the plate at y = 20.
  const top = s.body.topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await s.run("create_hole", { bodyId, face: ref(top), frame: "origin", positions: [[0, -10]], diameter: 8 });
  const flatVolume = s.body.volume;
  await s.run("create_sketch", { plane: "XY" });
  const sketchId = s.view.document.sketches.at(-1)!.id;
  await s.run("add_sketch_entity", { sketchId, type: "line", values: { x1: -60, y1: 20, x2: 60, y2: 20 } });
  await s.run("create_sketched_bend", { bodyId, sketchId, angle: 30 });
  const T = 2,
    R = 2,
    K = 0.44,
    th = Math.PI / 6;
  const BA = th * (R + K * T);
  // The bend allowance strip becomes a shell sector of the same width.
  near(s.body.volume, flatVolume - BA * T * 100 + (th / 2) * ((R + T) ** 2 - R ** 2) * 100, 1e-6, "bent volume");
  // The short side (y from 20 to 30) turned up by 30°: its top surface leaves the bend at
  // T + R − R·cos θ and rises along the remaining 10 − BA/2.
  near(s.body.bounds[1][2], T + R - R * Math.cos(th) + (10 - BA / 2) * Math.sin(th), 1e-6, "raised edge height");
  assert.ok(s.body.bounds[1][1] < 30, "the far edge moved toward the bend");
  // The hole on the fixed side kept its identity.
  assert.ok(s.body.topology.some((t) => t.kind === "face" && t.geomType === "CYLINDRE" && Math.abs((t.radius ?? 0) - 4) < 1e-6));
  // Flat pattern: the original 100 × 60 blank with the bend line where it was drawn.
  const flat = await s.run("flat_pattern", { bodyId });
  near(flat.width, 100, 1e-6, "flat width");
  near(flat.height, 60, 1e-6, "flat height");
  assert.equal(flat.bends.length, 1);
  assert.equal(flat.bends[0].label, "UP 30° R2");
  near(Math.abs(flat.bends[0].a[1] - flat.bends[0].b[1]), 0, 1e-6, "bend line along x");
  await assert.rejects(s.run("create_sketched_bend", { bodyId, sketchId, angle: 0 }));
});

test("sheet metal: closed corners carry the walls of a box across its corners, with a square relief in the flat", async () => {
  const s = await sheetPart();
  const bodyId = s.view.document.bodies[0].id;
  // A 100 × 60 tray: a 20 mm wall on every edge of the 2 mm base.
  const edge = (x: number, y: number) =>
    s.body.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[0] - x) < 1e-6 && Math.abs(t.center[1] - y) < 1e-6 && Math.abs(t.center[2] - 2) < 1e-6)!;
  const walls: string[] = [];
  for (const [x, y] of [[0, 30], [50, 0], [0, -30], [-50, 0]]) {
    await s.run("create_edge_flange", { bodyId, edge: ref(edge(x, y)), length: 20 });
    walls.push(s.view.document.features.at(-1)!.id);
  }
  const open = s.body.volume;
  near(open, 100 * 60 * 2 + 2 * (100 + 60) * flangeArea(2, 2, 90, 20), 1e-9, "open tray");
  // Close each corner in turn round the tray: every wall covers one corner and butts at the other.
  for (let i = 0; i < 4; i++) await s.run("create_closed_corner", { bodyId, flanges: [walls[i], walls[(i + 1) % 4]] });
  // Each corner adds the wall section (2 × 16) across R + T = 4 and R − gap = 1.9; the walls never overlap.
  near(s.body.volume - open, 4 * 2 * 16 * (4 + 1.9), 1e-9, "wall extensions");
  // The top wall now covers the corner out to x = 54; the right wall stops 0.1 short of its inside face.
  near(s.body.bounds[1][0], 54, 1e-9, "box width");
  const corner = s.view.document.features.find((f) => f.type === "corner")!;
  const butt = s.body.topology.find((t) => t.kind === "face" && t.featureId === corner.id && t.normal?.[1] === 1 && t.center[0] > 50)!;
  near(butt.center[1], 31.9, 1e-9, "the right wall ends 0.1 mm short of the top wall's inside face (y = 32)");
  // The flat pattern: each wall runs past its bend, leaving the bend zones' square relief at each corner.
  const flat = await s.run("flat_pattern", { bodyId });
  const ba = (Math.PI / 2) * (2 + 0.44 * 2),
    depth = ba + 16;
  near(flat.width, 100 + 2 * depth, 1e-6, "flat width");
  near(flat.height, 60 + 2 * depth, 1e-6, "flat height");
  assert.equal(flat.bends.length, 4);
  const has = (a: number[], b: number[]) =>
    flat.segments.some((g: number[][]) => [[a, b], [b, a]].some(([p, q]) => Math.hypot(g[0][0] - p[0], g[0][1] - p[1]) < 1e-6 && Math.hypot(g[1][0] - q[0], g[1][1] - q[1]) < 1e-6));
  assert.ok(has([54, 30 + ba], [54, 30 + depth]), "the covering wall's end, past its bend zone");
  assert.ok(has([50 + ba, 31.9], [50 + depth, 31.9]), "the butting wall's end");
  // The relief: the two bend zones' ends meet at the base corner, a square notch one allowance on a side.
  assert.ok(has([50, 30], [50 + ba, 30]) && has([50, 30], [50, 30 + ba]), "the relief notch");
  assert.ok(has([50 + ba, 30], [50 + ba, 31.9]) && has([50, 30 + ba], [54, 30 + ba]), "the walls start past the bends");
  // Only one closed corner per corner, between perpendicular 90° flanges.
  await assert.rejects(s.run("create_closed_corner", { bodyId, flanges: [walls[1], walls[0]] }), /already closed/);
  await assert.rejects(s.run("create_closed_corner", { bodyId, flanges: [walls[0], walls[2]] }), /meet at a corner/);
});
