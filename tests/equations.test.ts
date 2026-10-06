import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import { evaluateExpression, resolveVariables } from "../cad/equations.ts";
import type { View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-equations-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const store = new Store(join(dir, "docs")),
  tools = toolset(store);
async function fixture(name: string) {
  let v = (await store.create(name)) as View;
  const run = async (tool: string, args: any = {}) => {
    const t = tools.find((t) => t.name === tool)!;
    const r = await t.handler(
      t.schema.parse({ documentId: v.document.id, ...(t.schema.shape.expectedRevision ? { expectedRevision: v.document.revision } : {}), ...args }),
      "assistant",
    );
    if (r?.document) v = r;
    return r;
  };
  return {
    run,
    get view() {
      return v;
    },
  };
}
const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);

test("expressions: arithmetic, units, functions and safe failures", () => {
  const scope = new Map([["wall", 3], ["width", 100]]);
  near(evaluateExpression("2 * wall + 0.5in", scope), 18.7);
  near(evaluateExpression("(width - 2*wall) / 4", scope), 23.5);
  near(evaluateExpression("-2^2", scope), -4);
  near(evaluateExpression("2^-1", scope), 0.5);
  near(evaluateExpression("2^3^2", scope), 512);
  near(evaluateExpression("sin(30) + cos(60deg)", scope), 1);
  near(evaluateExpression("atan2(1, 1)", scope), 45);
  near(evaluateExpression("max(wall, 4, 1) + min(2, width)", scope), 6);
  near(evaluateExpression("pi * 10", scope), Math.PI * 10);
  near(evaluateExpression("1 rad", scope), 180 / Math.PI);
  near(evaluateExpression("1.5e1 + .5", scope), 15.5);
  near(evaluateExpression("90°", scope), 90);
  for (const bad of ["2 +", "foo + 1", "sin(1, 2)", "width wall", "1 / (wall - 3)", "constructor", "__proto__ + 1", "process.exit()", "in", "3 * mm", "x = 1", "`", "sqrt(-1)"])
    assert.throws(() => evaluateExpression(bad, scope), Error, bad);
  assert.deepEqual(
    [...resolveVariables([
      { name: "c", expression: "a + b", value: 0 },
      { name: "a", expression: "2", value: 0 },
      { name: "b", expression: "a * 3", value: 0 },
    ])],
    [["a", 2], ["b", 6], ["c", 8]],
  );
  assert.throws(() => resolveVariables([{ name: "a", expression: "b + 1", value: 0 }, { name: "b", expression: "a", value: 0 }]), /Circular variable reference: a → b → a/);
});

test("equations drive sketch dimensions and feature parameters through every edit", async () => {
  const f = await fixture("Equation plate");
  await f.run("set_variable", { name: "width", expression: "100" });
  await f.run("set_variable", { name: "wall", expression: "4" });
  await f.run("set_variable", { name: "depth", expression: "width * 0.6" });
  assert.deepEqual(f.view.document.variables!.map((v) => [v.name, v.value]), [["width", 100], ["wall", 4], ["depth", 60]]);
  await f.run("create_sketch", { plane: "XY" });
  const sketchId = f.view.document.sketches[0].id;
  await f.run("edit_sketch", {
    sketchId,
    operations: [
      { op: "add", ref: "$b", type: "line", values: { x1: 0, y1: 0, x2: 90, y2: 0 } },
      { op: "add", ref: "$r", type: "line", values: { x1: 90, y1: 0, x2: 90, y2: 50 } },
      { op: "add", ref: "$t", type: "line", values: { x1: 90, y1: 50, x2: 0, y2: 50 } },
      { op: "add", ref: "$l", type: "line", values: { x1: 0, y1: 50, x2: 0, y2: 0 } },
      { op: "constrain", type: "coincident", entities: ["$b", "$r"], anchors: ["end", "start"] },
      { op: "constrain", type: "coincident", entities: ["$r", "$t"], anchors: ["end", "start"] },
      { op: "constrain", type: "coincident", entities: ["$t", "$l"], anchors: ["end", "start"] },
      { op: "constrain", type: "coincident", entities: ["$l", "$b"], anchors: ["end", "start"] },
      { op: "constrain", type: "horizontal", entities: ["$b"] },
      { op: "constrain", type: "horizontal", entities: ["$t"] },
      { op: "constrain", type: "vertical", entities: ["$r"] },
      { op: "constrain", type: "vertical", entities: ["$l"] },
      { op: "constrain", type: "length", entities: ["$b"], value: 90 },
      { op: "constrain", type: "length", entities: ["$r"], value: 50 },
    ],
  });
  const lengths = () => f.view.document.sketches[0].constraints.filter((c) => c.type === "length");
  const [widthDim, depthDim] = lengths();
  // One dimension through edit_sketch, one through set_dimension.
  await f.run("edit_sketch", { sketchId, operations: [{ op: "value", constraintId: widthDim.id, expression: "width" }] });
  await f.run("set_dimension", { featureId: depthDim.id, dimension: "value", expression: "depth" });
  await f.run("extrude", { sketchId, distance: 5 });
  const extrude = f.view.document.features[0];
  await f.run("set_dimension", { featureId: extrude.id, dimension: "distance", expression: "wall * 2" });
  const volume = () => f.view.geometry.bodies[0].volume;
  near(volume(), 100 * 60 * 8);
  assert.equal(f.view.document.features[0].expressions!.distance, "wall * 2");

  // Changing one variable updates the sketch, the dependent variable and the extrusion.
  await f.run("set_variable", { name: "width", expression: "140" });
  near(volume(), 140 * 84 * 8);
  assert.equal(f.view.document.variables!.find((v) => v.name === "depth")!.value, 84);

  // Renaming rewrites every expression that uses the variable.
  await f.run("set_variable", { name: "wall", newName: "plate_t" });
  assert.equal(f.view.document.features[0].expressions!.distance, "plate_t * 2");
  await f.run("set_variable", { name: "plate_t", expression: "5" });
  near(volume(), 140 * 84 * 10);

  // Redefining the feature with its current value keeps the equation; a new number replaces it.
  await f.run("extrude", { featureId: extrude.id, sketchId, distance: 10 });
  assert.equal(f.view.document.features[0].expressions!.distance, "plate_t * 2");
  await f.run("set_variable", { name: "plate_t", expression: "6" });
  near(volume(), 140 * 84 * 12);

  // Invalid results, cycles and unknown names reject the whole edit.
  const before = f.view.document.revision;
  await assert.rejects(f.run("set_variable", { name: "plate_t", expression: "-1" }), /positive/);
  await assert.rejects(f.run("set_variable", { name: "width", expression: "depth" }), /Circular/);
  await assert.rejects(f.run("set_variable", { name: "sin", expression: "1" }), /not a valid variable name/);
  await assert.rejects(f.run("set_dimension", { featureId: extrude.id, dimension: "distance", expression: "missing + 1" }), /Unknown variable missing/);
  await assert.rejects(f.run("delete_variable", { name: "width" }), /used by variable depth/);
  assert.equal(f.view.document.revision, before);
  near(volume(), 140 * 84 * 12);

  // Typing a number replaces the equation.
  await f.run("set_dimension", { featureId: extrude.id, dimension: "distance", value: 3 });
  assert.equal(f.view.document.features[0].expressions, undefined);
  near(volume(), 140 * 84 * 3);
  await f.run("delete_variable", { name: "plate_t" });
  assert.deepEqual(f.view.document.variables!.map((v) => v.name), ["width", "depth"]);

  // Undo restores the deleted variable; the dimension it no longer drives keeps its value.
  const undone = await store.history(f.view.document.id, f.view.document.revision, "undo");
  assert.ok(undone.document.variables!.some((v) => v.name === "plate_t"));
  near(undone.geometry.bodies[0].volume, 140 * 84 * 3);
  // Restoring an earlier version brings back its variables and equations.
  const entry = undone.document.history.find((h) => h.description === "Set plate_t = 5")!;
  const restored = await store.restore(f.view.document.id, undone.document.revision, entry.id);
  assert.equal(restored.document.variables!.find((v) => v.name === "plate_t")!.value, 5);
  assert.equal(restored.document.features[0].expressions!.distance, "plate_t * 2");
  near(restored.geometry.bodies[0].volume, 140 * 84 * 10);
});
