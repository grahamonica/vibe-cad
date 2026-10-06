import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import type { Topology, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-drawing-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const ref = (t: Topology) => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType, signature: t.signature });
async function bracket() {
  const store = new Store(join(dir, "docs")),
    tools = toolset(store);
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
  await run("extrude", { sketchId: v.document.sketches[0].id, distance: 10 });
  const body = v.document.bodies[0].id;
  const top = v.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await run("create_hole", { bodyId: body, face: ref(top), frame: "origin", positions: [[-40, -20], [40, -20], [40, 20], [-40, 20]], holeType: "counterbore", size: "M5" });
  return { run, store, body, get view() { return v; } };
}

test("sheets: ISO title block, zone border, standard views and projection-aware relayout", async () => {
  const f = await bracket();
  await f.run("create_drawing", { name: "Shop", bodyIds: [f.body], size: "A3", scale: 0.5, title: "Bracket", drawingNumber: "PC-001", material: "6061-T6", company: "Vibe" });
  const sheet = f.view.document.drawings![0];
  assert.deepEqual(sheet.views!.map((v) => v.id), ["front", "top", "right", "iso"]);
  const r = await f.run("render_drawing", { drawingId: sheet.id });
  assert.equal(r.width, 420);
  assert.equal(r.height, 297);
  for (const text of ["Bracket", "PC-001", "6061-T6", "1 : 2", "A3", "3RD ANGLE"]) assert.ok(r.svg.includes(text), text);
  // Zone letters and numbers, and the projection symbol circles.
  assert.match(r.svg, />8</);
  assert.match(r.svg, />F</);
  const top = sheet.views!.find((v) => v.id === "top")!,
    front = sheet.views!.find((v) => v.id === "front")!;
  assert.ok(top.position[1] < front.position[1], "third angle: top view above front");
  await f.run("update_drawing", { drawingId: sheet.id, projection: "first" });
  const moved = f.view.document.drawings![0].views!;
  assert.ok(moved.find((v) => v.id === "top")!.position[1] > moved.find((v) => v.id === "front")!.position[1], "first angle: top view below front");
  // Scale that cannot fit is rejected atomically.
  const before = await f.store.read(f.view.document.id);
  await assert.rejects(f.run("update_drawing", { drawingId: sheet.id, scale: 5 }), /do not fit/);
  assert.deepEqual(await f.store.read(before.id), before);
});

test("views: projected alignment, section hatching, detail magnification and cascading delete", async () => {
  const f = await bracket();
  await f.run("create_drawing", { name: "Views", bodyIds: [f.body], size: "A3", scale: 0.5 });
  const sheetId = f.view.document.drawings![0].id;
  await f.run("add_drawing_view", { drawingId: sheetId, kind: "projected", parentId: "front", side: "left", position: [60, 999] });
  const left = f.view.document.drawings![0].views!.at(-1)!;
  assert.equal(left.orientation, "left");
  assert.equal(left.position[1], f.view.document.drawings![0].views!.find((v) => v.id === "front")!.position[1], "projected views align with their parent");
  // Horizontal cut through the top view, through the hole row at y = -20.
  await f.run("add_drawing_view", { drawingId: sheetId, kind: "section", parentId: "top", a: [-60, -20], b: [60, -20], position: [210, 150] });
  const section = f.view.document.drawings![0].views!.at(-1)!;
  assert.equal(section.section!.label, "A");
  await f.run("add_drawing_view", { drawingId: sheetId, kind: "detail", parentId: section.id, center: [40, 5], radius: 8, position: [330, 150] });
  const detail = f.view.document.drawings![0].views!.at(-1)!;
  assert.equal(detail.detail!.label, "B");
  assert.equal(detail.scale, 1, "details default to twice the parent scale");
  const r = await f.run("render_drawing", { drawingId: sheetId });
  assert.match(r.svg, /SECTION A-A/);
  assert.match(r.svg, /DETAIL B \(1 : 1\)/);
  assert.match(r.svg, /data-layer="hatch"/);
  assert.match(r.svg, /clip-path=/);
  const sectionView = r.views.find((v: any) => v.id === section.id);
  // Section of the plate along X: as wide as the part (100) at 1:2.
  assert.ok(Math.abs(sectionView.bounds[2] - 50) < 0.6, `section width ${sectionView.bounds[2]}`);
  await f.run("remove_drawing_view", { drawingId: sheetId, viewId: section.id });
  assert.ok(!f.view.document.drawings![0].views!.some((v) => v.id === section.id || v.id === detail.id), "dependent detail view is removed too");
});

test("dimensions: typed linear/radial/angular dimensions, tolerances and hole callouts from the hole wizard", async () => {
  const f = await bracket();
  await f.run("create_drawing", { name: "Dims", bodyIds: [f.body], size: "A3", scale: 0.5, dimensions: false });
  const sheetId = f.view.document.drawings![0].id;
  const r0 = await f.run("render_drawing", { drawingId: sheetId });
  const topView = r0.views.find((v: any) => v.id === "top");
  const holes = topView.circles;
  assert.equal(holes.length, 8, "counterbore and drill rims, nearest to the viewer");
  const drill = holes.find((c: any) => Math.abs(c.radius - 2.75 * 0.5) < 1e-6) ?? holes.find((c: any) => c.radius < 2);
  const bore = holes.find((c: any) => Math.abs(c.radius - 5 * 0.5) < 1e-6);
  assert.ok(drill && bore);
  await f.run("add_drawing_dimension", { drawingId: sheetId, view: "top", type: "diameter", points: [{ ref: drill.reference }], position: [30, -30] });
  await f.run("add_drawing_dimension", { drawingId: sheetId, view: "top", type: "hole", points: [{ ref: bore.reference }], position: [-50, -30] });
  // Center distance between two holes in the same row, with a symmetric tolerance.
  const sameRow = holes.filter((c: any) => Math.abs(c.radius - drill.radius) < 1e-6 && Math.abs(c.center[1] - drill.center[1]) < 1e-6);
  assert.equal(sameRow.length, 2);
  await f.run("add_drawing_dimension", {
    drawingId: sheetId,
    view: "top",
    type: "horizontal",
    points: sameRow.map((c: any) => ({ ref: c.reference, anchor: "center" })),
    tolerance: { kind: "symmetric", upper: 0.05 },
    position: [0, 25],
  });
  // Edge length of the front view's bottom edge.
  const frontEdges = r0.views.find((v: any) => v.id === "front").edges.filter((e: any) => e.visible && e.ref.geomType === "LINE");
  const longest = frontEdges.sort((a: any, b: any) => Math.hypot(b.points.at(-1)[0] - b.points[0][0], b.points.at(-1)[1] - b.points[0][1]) - Math.hypot(a.points.at(-1)[0] - a.points[0][0], a.points.at(-1)[1] - a.points[0][1]))[0];
  await f.run("add_drawing_dimension", { drawingId: sheetId, view: "front", type: "horizontal", points: [{ ref: longest.ref, anchor: "edge" }], decimals: 1, position: [0, 20] });
  const r = await f.run("render_drawing", { drawingId: sheetId });
  assert.match(r.svg, /Ø5\.5/);
  assert.match(r.svg, /4× Ø5\.5 THRU/);
  assert.match(r.svg, /CBORE Ø10 DEEP 5\.4/);
  assert.match(r.svg, /80 ±0\.05/);
  assert.match(r.svg, /data-value="100"/);
  // Labels are reported for interactive placement.
  assert.equal(r.labels.length, 4);
  // Moving the holes updates the associative value.
  const hole = f.view.document.features.find((x) => x.type === "hole")!;
  await f.run("set_hole_positions", { featureId: hole.id, positions: [[-45, -20], [45, -20], [45, 20], [-45, 20]] });
  const after = await f.run("render_drawing", { drawingId: sheetId });
  assert.match(after.svg, /90 ±0\.05/);
});

test("annotations and exports: notes, BOM, balloons, datum and GD&T frames; vector PDF and layered DXF", async () => {
  const f = await bracket();
  await f.run("create_drawing", { name: "Notes", bodyIds: [f.body], size: "A3", scale: 0.5 });
  const sheetId = f.view.document.drawings![0].id;
  const r0 = await f.run("render_drawing", { drawingId: sheetId });
  const edge = r0.views.find((v: any) => v.id === "front").edges.find((e: any) => e.visible)!;
  await f.run("add_drawing_annotation", { drawingId: sheetId, annotation: { type: "note", position: [30, 240], text: "BREAK SHARP EDGES\nANODIZE BLACK" } });
  await f.run("add_drawing_annotation", { drawingId: sheetId, annotation: { type: "bom", position: [240, 30] } });
  await f.run("add_drawing_annotation", { drawingId: sheetId, annotation: { type: "balloon", view: "front", ref: edge.ref, position: [60, 210] } });
  await f.run("add_drawing_annotation", { drawingId: sheetId, annotation: { type: "datum", view: "front", ref: edge.ref, position: [70, 220], label: "A" } });
  await f.run("add_drawing_annotation", { drawingId: sheetId, annotation: { type: "gdt", view: "front", ref: edge.ref, position: [90, 220], characteristic: "flatness", tolerance: 0.05 } });
  const r = await f.run("render_drawing", { drawingId: sheetId });
  for (const text of ["BREAK SHARP EDGES", "ANODIZE BLACK", "ITEM", "QTY", "Body 1", ">A<", "0.05"]) assert.ok(r.svg.includes(text), text);
  assert.equal((r.svg.match(/data-annotation=/g) ?? []).length, 5);
  const note = f.view.document.drawings![0].annotations![0];
  await f.run("update_drawing_annotation", { drawingId: sheetId, annotationId: note.id, text: "DEBURR" });
  assert.match((await f.run("render_drawing", { drawingId: sheetId })).svg, /DEBURR/);
  const pdf = await f.run("export_drawing", { drawingId: sheetId, format: "pdf" });
  const bytes = await readFile(pdf.path);
  assert.equal(bytes.subarray(0, 8).toString("latin1"), "%PDF-1.4");
  assert.ok(bytes.toString("latin1").includes("/MediaBox [0 0 1190.55 841.89]"), "A3 landscape in points");
  assert.ok(bytes.toString("latin1").trimEnd().endsWith("%%EOF"));
  const dxf = await readFile((await f.run("export_drawing", { drawingId: sheetId, format: "dxf" })).path, "utf8");
  assert.match(dxf, /^0\nSECTION\n2\nHEADER/);
  assert.match(dxf, /\nHIDDEN\n/);
  assert.match(dxf, /\nARC\n/);
  assert.match(dxf, /\nTEXT\n/);
  assert.match(dxf, /EOF\n$/);
});

test("units: an inch document dimensions its drawings in decimal inches; geometry stays metric", async () => {
  const f = await bracket();
  const volume = f.view.geometry.bodies[0].volume;
  await f.run("set_units", { units: "in" });
  assert.equal(f.view.document.units, "in");
  assert.equal(f.view.geometry.bodies[0].volume, volume, "display units never change geometry");
  await f.run("create_drawing", { name: "Inch", bodyIds: [f.body], size: "ANSI B", scale: 0.5 });
  const sheetId = f.view.document.drawings![0].id;
  const r0 = await f.run("render_drawing", { drawingId: sheetId });
  const bore = r0.views.find((v: any) => v.id === "top").circles.find((c: any) => Math.abs(c.radius - 2.5) < 1e-6);
  await f.run("add_drawing_dimension", { drawingId: sheetId, view: "top", type: "hole", points: [{ ref: bore.reference }], position: [-50, -30] });
  const r = await f.run("render_drawing", { drawingId: sheetId });
  assert.match(r.svg, />3\.937</, "100 mm overall width in inches");
  assert.match(r.svg, /data-value="100"/, "machine-readable values stay in millimeters");
  assert.match(r.svg, /Ø\.217 THRU/, "hole callout in inches without a leading zero");
  assert.match(r.svg, /CBORE Ø\.394 DEEP \.213/);
  assert.match(r.svg, /\.XXX ±\.005 · in/);
  // Undo returns to millimeters.
  await f.run("undo");
  await f.run("undo");
  await f.run("undo");
  assert.equal(f.view.document.units, undefined);
});

test("ordinate dimensions: distances from a zero on one row, shared values once, jogs when crowded, associative", async () => {
  const f = await bracket();
  await f.run("create_drawing", { name: "Ordinate", bodyIds: [f.body], size: "A3", scale: 0.5, dimensions: false });
  const sheetId = f.view.document.drawings![0].id;
  let r = await f.run("render_drawing", { drawingId: sheetId });
  const top = r.views.find((v: any) => v.id === "top"),
    center = f.view.document.drawings![0].views!.find((v) => v.id === "top")!.position;
  const lines = top.edges.filter((e: any) => e.visible && e.ref.geomType === "LINE");
  const vertical = lines.filter((e: any) => Math.abs(e.points[0][0] - e.points.at(-1)[0]) < 1e-6),
    horizontal = lines.filter((e: any) => Math.abs(e.points[0][1] - e.points.at(-1)[1]) < 1e-6);
  const left = vertical.sort((a: any, b: any) => a.points[0][0] - b.points[0][0])[0],
    bottom = horizontal.sort((a: any, b: any) => b.points[0][1] - a.points[0][1])[0];
  const bores = top.circles.filter((c: any) => Math.abs(c.radius - 2.5) < 1e-6);
  assert.equal(bores.length, 4);
  const holes = bores.map((c: any) => ({ ref: c.reference, anchor: "center" }));
  const [bx, by, bw] = top.bounds;
  await f.run("add_drawing_dimension", { drawingId: sheetId, view: "top", type: "ordinate", axis: "horizontal", points: [{ ref: left.ref, anchor: "mid" }, ...holes], position: [0, by - 10 - center[1]] });
  await f.run("add_drawing_dimension", { drawingId: sheetId, view: "top", type: "ordinate", axis: "vertical", points: [{ ref: bottom.ref, anchor: "mid" }, ...holes], position: [bx + bw + 10 - center[0], 0] });
  const [across, up] = f.view.document.drawings![0].dimensions.map((d) => d.id);
  const group = (svg: string, id: string) => {
    const m = svg.match(new RegExp(`data-dimension="${id}"><g data-values="([^"]+)">(.*?)</g>`))!;
    return {
      values: m[1].split(",").map(Number),
      texts: [...m[2].matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"[^>]*>([^<]+)<\/text>/g)].map((t) => ({ x: Number(t[1]), y: Number(t[2]), text: t[3] })),
      paths: [...m[2].matchAll(/<path d="([^"]+)"/g)].map((p) => p[1].split(/ (?=[ML])/).length),
    };
  };
  r = await f.run("render_drawing", { drawingId: sheetId });
  let a = group(r.svg, across),
    u = group(r.svg, up);
  // From the left edge: 10 and 90, each pair of holes in a column shares one value.
  assert.deepEqual(a.values.slice(1).sort((p, q) => p - q), [10, 10, 90, 90]);
  assert.deepEqual(a.texts.map((t) => t.text), ["0", "10", "90"]);
  assert.ok(a.texts.every((t) => Math.abs(t.y - (by - 11)) < 1e-6), "values sit on the row above the view, reading up");
  assert.match(r.svg, new RegExp(`data-dimension="${across}"><g data-values="[^"]+"><path[^>]*>.*?transform="rotate\\(-90`));
  // From the bottom edge: 10 and 50, written beside the view.
  assert.deepEqual(u.texts.map((t) => t.text).sort(), ["0", "10", "50"]);
  assert.ok(u.texts.every((t) => Math.abs(t.x - (bx + bw + 11)) < 1e-6));
  // A hole 3 mm from its neighbor crowds the row: the values spread and the lines jog.
  await f.run("create_hole", { bodyId: f.body, face: ref(f.view.geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!), frame: "origin", positions: [[-37, 0]], diameter: 3 });
  r = await f.run("render_drawing", { drawingId: sheetId });
  const small = r.views.find((v: any) => v.id === "top").circles.find((c: any) => Math.abs(c.radius - 0.75) < 1e-6);
  const dim = f.view.document.drawings![0].dimensions.find((d) => d.id === across)!;
  await f.run("update_drawing_dimension", { drawingId: sheetId, dimensionId: across, points: [...dim.points!, { ref: small.reference, anchor: "center" }] });
  a = group((await f.run("render_drawing", { drawingId: sheetId })).svg, across);
  assert.deepEqual(a.texts.map((t) => t.text), ["0", "10", "13", "90"]);
  const xs = a.texts.map((t) => t.x);
  assert.ok(xs[2] - xs[1] >= 4.2 - 1e-6, `crowded values spread: ${xs}`);
  assert.ok(a.paths.some((n) => n === 4), "a jogged extension line");
  // Associative: moving the holes moves the values.
  const hole = f.view.document.features.find((x) => x.type === "hole")!;
  await f.run("set_hole_positions", { featureId: hole.id, positions: [[-42, -20], [42, -20], [42, 20], [-42, 20]] });
  a = group((await f.run("render_drawing", { drawingId: sheetId })).svg, across);
  assert.deepEqual(a.texts.map((t) => t.text), ["0", "8", "13", "92"]);
  // A counterbore moved onto the zero edge would split it: refused, nothing changes.
  await assert.rejects(f.run("set_hole_positions", { featureId: hole.id, positions: [[-45, -20], [45, -20], [45, 20], [-45, 20]] }), /no longer resolves/);
  // Only ordinate dimensions take many points or change their points.
  await assert.rejects(f.run("add_drawing_dimension", { drawingId: sheetId, view: "top", type: "horizontal", points: holes.slice(0, 3) }), /Only ordinate/);
  await f.run("add_drawing_dimension", { drawingId: sheetId, view: "top", type: "diameter", points: [holes[0]] });
  const diameter = f.view.document.drawings![0].dimensions.at(-1)!.id;
  await assert.rejects(f.run("update_drawing_dimension", { drawingId: sheetId, dimensionId: diameter, points: [holes[1]] }), /Only an ordinate/);
});
