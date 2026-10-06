import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
const dir = await mkdtemp(join(tmpdir(), "vibe-mechanical-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
async function fixture(name: string) {
  const store = new Store(dir),
    tools = toolset(store);
  let v = await store.create(name);
  const run = async (name: string, args: any = {}) => {
    const t = tools.find((t) => t.name === name)!;
    const result = await t.handler(
      t.schema.parse({
        documentId: v.document.id,
        ...(t.schema.shape.expectedRevision
          ? { expectedRevision: v.document.revision }
          : {}),
        ...args,
      }),
      "user",
    );
    if (result?.document) v = result;
    return result;
  };
  const plate = async (width: number, height: number, depth: number) => {
    await run("create_sketch", { plane: "XY" });
    const sk = v.document.sketches.at(-1)!;
    await run("add_sketch_entity", {
      sketchId: sk.id,
      type: "rectangle",
      values: { x: 0, y: 0, width, height },
    });
    await run("extrude", { sketchId: sk.id, distance: depth });
    return v.document.bodies.at(-1)!.id;
  };
  return {
    store,
    run,
    plate,
    get view() {
      return v;
    },
  };
}
const ref = (t: any) => ({
  id: t.id,
  bodyId: t.bodyId,
  kind: t.kind,
  geomType: t.geomType,
  signature: t.signature,
});
test("assembly mates place real solids; engineering checks and STEP use assembled positions; over-defining mates are flagged", async () => {
  const f = await fixture("Assembly"),
    a = await f.plate(80, 50, 12),
    b = await f.plate(40, 20, 5);
  await f.run("create_component", {
    name: "Base",
    bodyIds: [a],
    grounded: true,
  });
  await f.run("create_component", {
    name: "Cap",
    bodyIds: [b],
    position: [0, 0, 40],
  });
  const top = f.view.geometry.bodies
    .find((x) => x.id === a)!
    .topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  const bottom = f.view.geometry.bodies
    .find((x) => x.id === b)!
    .topology.find((t) => t.kind === "face" && t.normal?.[2] === -1)!;
  const matePreview = await f.run("preview_feature", {
    command: {
      tool: "add_mate",
      arguments: { type: "coincident", moving: ref(bottom), target: ref(top) },
    },
  });
  assert.equal(f.view.document.mates!.length, 0);
  assert.deepEqual(
    matePreview.preview!.geometry.bodies.find((x: any) => x.id === b)!
      .bounds[0],
    [-20, -10, 12],
  );
  await f.run("apply_preview", { previewId: matePreview.preview!.id });
  const cap = f.view.geometry.bodies.find((x) => x.id === b)!;
  assert.ok(Math.abs(cap.bounds[0][2] - 12) < 1e-5);
  assert.ok(Math.abs(cap.bounds[1][2] - 17) < 1e-5);
  const measure = await f.run("measure", { bodyId: b });
  assert.ok(Math.abs(measure.bounds[0][2] - 12) < 1e-5);
  const check = await f.run("analyze_interference", { bodyA: a, bodyB: b });
  assert.equal(check.interferes, false);
  // An over-defining mate is added and flagged, as SolidWorks does: it is left unsolved and names
  // the mate it conflicts with; the cap stays on the coincident mate.
  const capId = f.view.document.components![1].id;
  assert.equal(f.view.geometry.componentStatus![capId].status, "under");
  assert.equal(f.view.geometry.componentStatus![capId].dof, 3, "a face mate leaves sliding and turning on the face");
  await f.run("add_mate", { type: "distance", moving: ref(bottom), target: ref(top), value: 10 });
  const [coincident, distance] = f.view.document.mates!;
  assert.deepEqual(f.view.geometry.mateStatus![coincident.id], { status: "ok" });
  assert.equal(f.view.geometry.mateStatus![distance.id].status, "over");
  assert.equal(f.view.geometry.mateStatus![distance.id].message, "Distance 1 over-defines Cap: it conflicts with Coincident 1");
  assert.ok(f.view.geometry.warnings.includes("Distance 1 over-defines Cap: it conflicts with Coincident 1"));
  assert.equal(f.view.geometry.componentStatus![capId].status, "over");
  assert.ok(Math.abs(f.view.geometry.bodies.find((x) => x.id === b)!.bounds[0][2] - 12) < 1e-5);
  // Deleting it clears the flag.
  await f.run("delete_mate", { mateId: distance.id });
  assert.equal(f.view.geometry.componentStatus![capId].status, "under");
  assert.ok(!f.view.geometry.warnings.some((w) => w.includes("over-defines")));
  await f.run("set_explode_offset", {
    componentId: f.view.document.components![1].id,
    offset: [0, 0, 60],
  });
  assert.equal(
    f.view.geometry.bodies.find((x) => x.id === b)!.bounds[0][2],
    12,
  );
  const step = await f.run("export_file", { format: "step" });
  assert.match(await readFile(step.path, "utf8"), /ISO-10303-21/);
  const undo = await f.run("undo");
  assert.deepEqual(undo.document.components[1].explode, [0, 0, 0]);
  await f.run("redo");
  assert.deepEqual(f.view.document.components![1].explode, [0, 0, 60]);
  const bom = await f.run("inspect_assembly");
  assert.equal(bom.bom.length, 2);
  assert.ok(Math.abs(bom.bom[1].volume - 4000) < 1e-5);
});
test("mechanical drawing uses kernel hidden lines and associative numeric dimensions, exports vector SVG, updates after edits and rejects stale references", async () => {
  const f = await fixture("Drawing plate"),
    b = await f.plate(80, 50, 12);
  await f.run("create_hole", {
    bodyId: b,
    plane: "XY",
    positions: [[0, 0]],
    diameter: 8,
  });
  await f.run("create_drawing", {
    name: "Manufacturing",
    bodyIds: [b],
    scale: 0.5,
    title: "Plate",
    material: "Aluminium",
  });
  const drawingId = f.view.document.drawings![0].id;
  await f.run("add_drawing_dimension", {
    drawingId,
    view: "front",
    axis: "horizontal",
  });
  const drawing = await f.run("render_drawing", { drawingId });
  assert.equal(drawing.width, 297);
  assert.match(drawing.svg, /data-view="front"/);
  assert.match(drawing.svg, /data-hidden-lines="true"/);
  assert.match(drawing.svg, /data-value="80"/);
  assert.match(drawing.svg, /Plate/);
  assert.match(drawing.svg, /stroke-dasharray/);
  const entity = f.view.document.sketches[0].entities[0];
  await f.run("set_dimension", {
    featureId: entity.id,
    dimension: "width",
    value: 100,
  });
  const updated = await f.run("render_drawing", { drawingId });
  assert.match(updated.svg, /data-value="100"/);
  const exported = await f.run("export_drawing", { drawingId });
  assert.match(await readFile(exported.path, "utf8"), /width="297mm"/);
  const before = f.view.document.revision;
  await assert.rejects(
    () =>
      f.run("add_drawing_dimension", {
        drawingId,
        view: "front",
        axis: "horizontal",
        refs: [
          { bodyId: b, id: "missing", kind: "face" },
          { bodyId: b, id: "missing2", kind: "face" },
        ],
      }),
    /no longer resolves/,
  );
  assert.equal((await f.store.read(f.view.document.id)).revision, before);
});
test("named reference planes drive sketch support and downstream solids through history", async () => {
  const f = await fixture("Reference planes");
  await f.run("create_reference_plane", {
    name: "Raised work plane",
    plane: "XY",
    origin: [0, 0, 10],
  });
  const p = f.view.document.referencePlanes![0];
  await f.run("create_sketch", { referencePlaneId: p.id });
  const sk = f.view.document.sketches[0];
  await f.run("add_sketch_entity", {
    sketchId: sk.id,
    type: "rectangle",
    values: { x: 0, y: 0, width: 20, height: 20 },
  });
  await f.run("extrude", { sketchId: sk.id, distance: 10 });
  assert.equal(f.view.geometry.bodies[0].bounds[0][2], 10);
  await f.run("set_reference_plane", { planeId: p.id, origin: [0, 0, 30] });
  assert.equal(f.view.geometry.bodies[0].bounds[0][2], 30);
  await f.run("undo");
  assert.equal(f.view.geometry.bodies[0].bounds[0][2], 10);
});
test("concentric mates align rotated cylinder axes, planar distance controls axial placement, and suppressed mates preserve solved placement", async () => {
  const f = await fixture("Shaft assembly");
  const cylinder = async (radius: number, depth: number) => {
    await f.run("create_sketch", { plane: "XY" });
    const sk = f.view.document.sketches.at(-1)!;
    await f.run("add_sketch_entity", {
      sketchId: sk.id,
      type: "circle",
      values: { x: 0, y: 0, radius },
    });
    await f.run("extrude", { sketchId: sk.id, distance: depth });
    return f.view.document.bodies.at(-1)!.id;
  };
  const a = await cylinder(15, 10),
    b = await cylinder(5, 20);
  await f.run("create_component", {
    name: "Housing",
    bodyIds: [a],
    grounded: true,
  });
  await f.run("create_component", {
    name: "Shaft",
    bodyIds: [b],
    position: [30, 40, 50],
    rotation: [0, 45, 0],
  });
  const target = f.view.geometry.bodies
    .find((x) => x.id === a)!
    .topology.find((t) => t.radius && Math.abs(t.center[2]) < 1e-6)!;
  const moving = f.view.geometry.bodies
    .find((x) => x.id === b)!
    .topology.find((t) => t.radius)!;
  await f.run("add_mate", {
    type: "concentric",
    moving: ref(moving),
    target: ref(target),
    aligned: true,
  });
  const shaft = f.view.geometry.bodies.find((x) => x.id === b)!;
  assert.ok(
    Math.abs(shaft.centerOfMass[0]) < 1e-5 &&
      Math.abs(shaft.centerOfMass[1]) < 1e-5,
  );
  const top = f.view.geometry.bodies
    .find((x) => x.id === a)!
    .topology.find(
      (t) => t.kind === "face" && t.geomType === "PLANE" && t.normal![2] > 0.99,
    )!;
  const bottom = shaft.topology.find(
    (t) => t.kind === "face" && t.geomType === "PLANE" && t.normal![2] < -0.99,
  )!;
  await f.run("add_mate", {
    type: "distance",
    moving: ref(bottom),
    target: ref(top),
    value: 5,
  });
  assert.ok(
    Math.abs(
      f.view.geometry.bodies.find((x) => x.id === b)!.bounds[0][2] - 15,
    ) < 1e-5,
  );
  const mate = f.view.document.mates!.at(-1)!;
  await f.run("set_mate_suppressed", { mateId: mate.id, suppressed: true });
  assert.ok(
    Math.abs(
      f.view.geometry.bodies.find((x) => x.id === b)!.bounds[0][2] - 15,
    ) < 1e-5,
  );
  await f.run("create_drawing", {
    name: "Shaft drawing",
    bodyIds: [b],
    scale: 0.5,
  });
  const drawingId = f.view.document.drawings!.at(-1)!.id;
  const edge = f.view.geometry.bodies
    .find((x) => x.id === b)!
    .topology.find((t) => t.kind === "edge" && t.radius)!;
  await f.run("add_drawing_callout", {
    drawingId,
    view: "top",
    kind: "diameter",
    reference: ref(edge),
  });
  const drawing = await f.run("render_drawing", { drawingId });
  assert.match(drawing.svg, /Ø10/);
  assert.match(drawing.svg, /data-centerline="true"/);
});

test("undo removes newly added assembly/drawing/plane objects and reload preserves the exact state", async () => {
  const f = await fixture("History objects"),
    b = await f.plate(20, 20, 5);
  await f.run("create_component", { bodyIds: [b], grounded: true });
  assert.equal(f.view.document.components!.length, 1);
  await f.run("undo");
  assert.equal(f.view.document.components!.length, 0);
  await f.run("redo");
  assert.equal(f.view.document.components!.length, 1);
  await f.run("create_drawing", { name: "Sheet", bodyIds: [b] });
  await f.run("undo");
  assert.equal(f.view.document.drawings!.length, 0);
  await f.run("redo");
  assert.equal(f.view.document.drawings!.length, 1);
  await f.run("create_reference_plane", { plane: "XY", origin: [0, 0, 20] });
  await f.run("undo");
  assert.equal(f.view.document.referencePlanes!.length, 0);
  const loaded = await f.store.read(f.view.document.id);
  assert.equal(loaded.components!.length, 1);
  assert.equal(loaded.drawings!.length, 1);
  assert.equal(loaded.referencePlanes!.length, 0);
});
test("native feature previews use actual selected edges, preserve the committed solid until accepted, and cancellation serializes behind in-flight previews", async () => {
  const f = await fixture("Traditional features"),
    b = await f.plate(80, 50, 12);
  const edges = f.view.geometry.bodies[0].topology
    .filter((t) => t.kind === "edge" && Math.abs(t.signature[5]) > 0.99)
    .map(ref);
  const revision = f.view.document.revision,
    volume = f.view.geometry.bodies[0].volume;
  const p = await f.run("preview_feature", {
    command: {
      tool: "fillet_edges",
      arguments: { bodyId: b, edges, radius: 3 },
    },
  });
  assert.equal(p.document.revision, revision);
  assert.equal(p.geometry.bodies[0].volume, volume);
  assert.ok(p.preview.geometry.bodies[0].volume < volume);
  assert.equal((await f.store.read(f.view.document.id)).features.length, 1);
  await f.run("apply_preview", { previewId: p.preview.id });
  assert.equal(f.view.document.features.at(-1)!.type, "fillet");
  assert.ok(f.view.geometry.bodies[0].volume < volume);
  await f.run("undo");
  const tool = toolset(f.store).find((t) => t.name === "preview_feature")!;
  const pending = tool.handler(
    tool.schema.parse({
      documentId: f.view.document.id,
      expectedRevision: f.view.document.revision,
      command: {
        tool: "fillet_edges",
        arguments: { bodyId: b, edges, radius: 2 },
      },
    }),
    "user",
  );
  const cancel = f.store.dismissPreview(f.view.document.id);
  await pending;
  await cancel;
  assert.equal(
    (await f.store.view(await f.store.read(f.view.document.id))).preview,
    undefined,
  );
  await assert.rejects(
    () =>
      f.run("preview_feature", {
        command: { tool: "fillet_edges", arguments: { bodyId: b, radius: 2 } },
      }),
    /actual edges/,
  );
  await f.run("preview_feature", {
    command: {
      tool: "extrude",
      arguments: { sketchId: f.view.document.sketches[0].id, distance: 5 },
    },
  });
  assert.equal(f.view.document.bodies.length, 1);
  assert.equal(f.view.preview!.geometry.bodies.length, 2);
});

test("face and body fillets change exact solids; variable radius laws rebuild, export and reject invalid edits atomically", async () => {
  const f = await fixture("Advanced fillets"),
    bodyId = await f.plate(60, 40, 12);
  const original = f.view.geometry.bodies[0],
    originalVolume = original.volume;
  const face = original.topology.find(
    (t) => t.kind === "face" && t.normal?.[2] === 1,
  )!;
  const edges = original.topology.filter(
    (t) => t.kind === "edge" && Math.abs(t.center[2] - 12) < 1e-5,
  );
  assert.equal(edges.length, 4);
  await f.run("fillet_faces", { bodyId, faces: [ref(face)], radius: 2 });
  const faceVolume = f.view.geometry.bodies[0].volume;
  assert.ok(faceVolume < originalVolume);
  await f.run("undo");
  await f.run("fillet_edges", { bodyId, edges: edges.map(ref), radius: 2 });
  assert.ok(Math.abs(f.view.geometry.bodies[0].volume - faceVolume) < 1e-4);
  await f.run("undo");
  await f.run("fillet_body", { bodyId, radius: 2 });
  assert.ok(f.view.geometry.bodies[0].volume < faceVolume);
  await f.run("undo");
  const edge = ref(edges[0]);
  await f.run("variable_fillet_edges", {
    bodyId,
    profiles: [
      {
        edge,
        points: [
          { position: 0, radius: 1 },
          { position: 1, radius: 3 },
        ],
      },
    ],
  });
  const linearVolume = f.view.geometry.bodies[0].volume;
  assert.ok(linearVolume < originalVolume);
  assert.ok(
    f.view.geometry.bodies[0].topology.some(
      (t) => t.geomType === "BSPLINE_SURFACE",
    ),
  );
  const exported = await f.run("export_file", { format: "step" });
  assert.ok((await readFile(exported.path, "utf8")).includes("ADVANCED_FACE"));
  await f.run("undo");
  await f.run("variable_fillet_edges", {
    bodyId,
    profiles: [
      {
        edge,
        points: [
          { position: 0, radius: 1 },
          { position: 0.5, radius: 4 },
          { position: 1, radius: 3 },
        ],
      },
    ],
  });
  assert.ok(f.view.geometry.bodies[0].volume < linearVolume);
  const curvedVolume = f.view.geometry.bodies[0].volume;
  await f.run("set_variable_fillet_profile", {
    featureId: f.view.document.features.at(-1)!.id,
    edgeId: edge.id,
    points: [
      { position: 0, radius: 1 },
      { position: 0.5, radius: 2 },
      { position: 1, radius: 3 },
    ],
  });
  assert.ok(f.view.geometry.bodies[0].volume > curvedVolume);
  await f.run("undo");
  await f.run("undo");
  const before = f.view.document.revision;
  await assert.rejects(
    f.run("variable_fillet_edges", {
      bodyId,
      profiles: [
        {
          edge,
          points: [
            { position: 0, radius: 200 },
            { position: 1, radius: 300 },
          ],
        },
      ],
    }),
  );
  assert.equal(
    (await f.store.view(await f.store.read(f.view.document.id))).document
      .revision,
    before,
  );
  await assert.rejects(
    f.run("variable_fillet_edges", {
      bodyId,
      profiles: [
        {
          edge,
          points: [
            { position: 0, radius: 1 },
            { position: 0.7, radius: 2 },
            { position: 0.6, radius: 3 },
            { position: 1, radius: 4 },
          ],
        },
      ],
    }),
    /increase/,
  );
});

test("circular hole patterns preserve counterbore and source dependencies, omit the 360 degree duplicate and support skipped instances", async () => {
  const f = await fixture("Circular holes");
  await f.run("create_sketch", { plane: "XY" });
  const sketchId = f.view.document.sketches[0].id;
  await f.run("add_sketch_entity", {
    sketchId,
    type: "circle",
    values: { x: 0, y: 0, radius: 30 },
  });
  await f.run("extrude", { sketchId, distance: 6 });
  const bodyId = f.view.document.bodies[0].id;
  const face = ref(
    f.view.geometry.bodies[0].topology.find(
      (t) => t.kind === "face" && t.geomType === "PLANE" && t.normal?.[2] === 1,
    )!,
  );
  await f.run("create_hole", {
    bodyId,
    face,
    diameter: 4,
    positions: [[15, 0]],
    counterboreDiameter: 8,
    counterboreDepth: 2,
  });
  const featureId = f.view.document.features.at(-1)!.id;
  await f.run("create_circular_pattern", {
    bodyId,
    featureId,
    axis: [0, 0, 1],
    count: 4,
  });
  const expected =
    Math.PI * 30 ** 2 * 6 -
    4 * (Math.PI * 2 ** 2 * 6 + Math.PI * (4 ** 2 - 2 ** 2) * 2);
  assert.ok(Math.abs(f.view.geometry.bodies[0].volume - expected) < 1e-3);
  await f.run("set_dimension", { featureId, dimension: "diameter", value: 5 });
  const resized =
    Math.PI * 30 ** 2 * 6 -
    4 * (Math.PI * 2.5 ** 2 * 6 + Math.PI * (4 ** 2 - 2.5 ** 2) * 2);
  assert.ok(Math.abs(f.view.geometry.bodies[0].volume - resized) < 1e-3);
  await f.run("undo");
  await f.run("undo");
  await f.run("create_circular_pattern", {
    bodyId,
    featureId,
    axis: [0, 0, 1],
    count: 3,
    angle: 180,
    skippedInstances: [2],
  });
  const skipped =
    Math.PI * 30 ** 2 * 6 -
    2 * (Math.PI * 2 ** 2 * 6 + Math.PI * (4 ** 2 - 2 ** 2) * 2);
  assert.ok(Math.abs(f.view.geometry.bodies[0].volume - skipped) < 1e-3);
  const preview = await f.run("preview_feature", {
    command: {
      tool: "create_circular_pattern",
      arguments: { bodyId, axis: [0, 0, 1], axisOrigin: [100, 0, 0], count: 3 },
    },
  });
  assert.ok(preview.preview);
  const bodyPatternVolume = f.view.geometry.bodies[0].volume * 3;
  assert.ok(
    Math.abs(preview.preview.geometry.bodies[0].volume - bodyPatternVolume) <
      0.001,
  );
  await f.run("apply_preview", { previewId: preview.preview.id });
  assert.ok(
    Math.abs(f.view.geometry.bodies[0].volume - bodyPatternVolume) < 0.001,
  );
  await f.run("undo");
});

test("drawing picks use exact source edges and sheet coordinates; projected center spacing and callouts share those references", async () => {
  const f = await fixture("Direct drawing dimensions"),
    body = await f.plate(80, 50, 12);
  await f.run("create_hole", {
    bodyId: body,
    plane: "XY",
    positions: [
      [-20, 0],
      [20, 0],
    ],
    diameter: 8,
  });
  const other = await f.plate(20, 20, 5);
  await f.run("create_hole", {
    bodyId: other,
    plane: "XY",
    positions: [[0, 0]],
    diameter: 6,
  });
  await f.run("create_drawing", {
    name: "Direct sheet",
    bodyIds: [body],
    scale: 0.5,
  });
  const drawingId = f.view.document.drawings!.at(-1)!.id;
  const rendered = await f.run("render_drawing", { drawingId });
  const top = rendered.views.find((v: any) => v.name === "top");
  assert.equal(
    top.circles.length,
    2,
    "coincident top and bottom projected rims are deduplicated",
  );
  for (const circle of top.circles) {
    assert.equal(circle.reference.bodyId, body);
    assert.equal(circle.reference.kind, "edge");
    assert.ok(
      Math.abs(circle.radius - 2) < 1e-8,
      "radius uses the sheet's 1:2 scale",
    );
    const exact = f.view.geometry.bodies
      .find((b) => b.id === body)!
      .topology.find((t) => t.id === circle.reference.id)!;
    assert.ok(Math.abs(exact.radius! - 4) < 1e-8);
    assert.ok(exact.center[2] > 11.99, "frontmost exact top edge is selected");
    assert.ok(
      circle.center[0] >= top.bounds[0] &&
        circle.center[0] <= top.bounds[0] + top.bounds[2],
    );
    assert.ok(
      circle.center[1] >= top.bounds[1] &&
        circle.center[1] <= top.bounds[1] + top.bounds[3],
    );
  }
  assert.ok(
    Math.abs(
      Math.abs(top.circles[0].center[0] - top.circles[1].center[0]) - 20,
    ) < 1e-6,
  );
  await f.run("add_drawing_dimension", {
    drawingId,
    view: "top",
    axis: "horizontal",
    refs: top.circles.map((c: any) => c.reference),
    offset: 10,
  });
  await f.run("add_drawing_callout", {
    drawingId,
    view: "top",
    kind: "diameter",
    reference: top.circles[0].reference,
    offset: 12,
  });
  const propertiesBefore = f.view.document.drawings!.at(-1)!;
  await f.run("update_drawing", { drawingId, title: "Drawing title" });
  assert.deepEqual(f.view.document.drawings!.at(-1)!, {
    ...propertiesBefore,
    title: "Drawing title",
  });
  await f.run("update_drawing", { drawingId, hiddenLines: false });
  assert.equal(f.view.document.drawings!.at(-1)!.hiddenLines, false);
  assert.equal(f.view.document.drawings!.at(-1)!.scale, 0.5);
  const committed = await f.store.read(f.view.document.id);
  await assert.rejects(
    f.run("update_drawing", { drawingId, scale: 10 }),
    /do not fit/,
  );
  assert.deepEqual(await f.store.read(committed.id), committed);
  const annotated = await f.run("render_drawing", { drawingId });
  assert.match(annotated.svg, /data-value="40"/);
  assert.match(annotated.svg, /Ø8/);
  const centerlines = (annotated.svg.match(/data-centerline="true"/g) ?? [])
    .length;
  const before = await f.store.read(f.view.document.id);
  const external = f.view.geometry.bodies
    .find((b) => b.id === other)!
    .topology.find((t) => t.kind === "edge" && t.radius)!;
  await assert.rejects(
    f.run("add_drawing_callout", {
      drawingId,
      view: "top",
      kind: "radius",
      reference: ref(external),
    }),
    /outside the drawing/,
  );
  assert.deepEqual(await f.store.read(before.id), before);
  await f.run("update_drawing", { drawingId, projection: "first" });
  const first = await f.run("render_drawing", { drawingId });
  assert.notDeepEqual(
    first.views.find((v: any) => v.name === "top").bounds,
    top.bounds,
  );
  assert.deepEqual(
    first.views
      .find((v: any) => v.name === "top")
      .circles.map((c: any) => c.reference),
    top.circles.map((c: any) => c.reference),
  );
  assert.equal(
    (first.svg.match(/data-centerline="true"/g) ?? []).length,
    centerlines,
    "dimensions do not duplicate centerlines",
  );
  const exported = await f.run("export_drawing", { drawingId });
  const svg = await readFile(exported.path, "utf8");
  assert.ok(!svg.includes("drawing-overlay") && !svg.includes("#ce8147"));
});
