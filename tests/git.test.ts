import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ProjectStore } from "../cad/store.ts";
import { toolset } from "../cad/tools.ts";
import { closeKernel } from "../cad/geometry.ts";
import { canonical, orderKeys } from "../cad/project-format.ts";
import type { Topology, View } from "../cad/types.ts";

const dir = await mkdtemp(join(tmpdir(), "vibe-git-"));
after(async () => {
  await closeKernel();
  await rm(dir, { recursive: true, force: true });
});
const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
sh("init", "-q", "-b", "main");
sh("config", "user.name", "Vibe Test");
sh("config", "user.email", "test@example.invalid");
const store = new ProjectStore(dir),
  tools = toolset(store);
const ref = (t: Topology) => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType });
async function run(name: string, args: any = {}, documentId?: string): Promise<any> {
  const t = tools.find((t) => t.name === name)!;
  const latest = documentId ? await store.read(documentId) : undefined;
  return t.handler(
    t.schema.parse({ ...(documentId ? { documentId } : {}), ...(latest && t.schema.shape.expectedRevision ? { expectedRevision: latest.revision } : {}), ...args }),
    "user",
  );
}
const volume = async (id: string) => (await store.view(await store.read(id))).geometry.bodies.reduce((s, b) => s + b.volume, 0);

test("project format: canonical files and order keys that survive edits", () => {
  assert.equal(canonical({ b: 1, a: [1, 2, 3], c: { y: true, x: null } }), '{\n  "a": [1, 2, 3],\n  "b": 1,\n  "c": {\n    "x": null,\n    "y": true\n  }\n}\n');
  const keys = orderKeys(["a", "b", "c"], new Map());
  assert.deepEqual([...keys.values()], [1024, 2048, 3072]);
  // Inserting in the middle keeps the neighbors' keys; moving one changes only it.
  const inserted = orderKeys(["a", "x", "b", "c"], keys);
  assert.deepEqual([inserted.get("a"), inserted.get("b"), inserted.get("c")], [1024, 2048, 3072]);
  assert.ok(inserted.get("x")! > 1024 && inserted.get("x")! < 2048);
  const moved = orderKeys(["b", "c", "a"], keys);
  assert.deepEqual([moved.get("b"), moved.get("c")], [2048, 3072]);
  assert.ok(moved.get("a")! > 3072);
});

test("git: branch, edit, merge object by object, resolve a conflict, pull requests stay plain git", async () => {
  // A plate in a project folder: one small file per object.
  const id = ((await store.create("Chassis")) as View).document.id;
  let v: View = await run("create_sketch", { plane: "XY" }, id);
  await run("add_sketch_entity", { sketchId: v.document.sketches[0].id, type: "rectangle", values: { x: 0, y: 0, width: 100, height: 60 } }, id);
  v = await run("extrude", { sketchId: v.document.sketches[0].id, distance: 10 }, id);
  const extrude = v.document.features[0].id;
  assert.deepEqual((await readdir(join(dir, "chassis.vibe"))).sort(), ["bodies", "document.json", "features", "sketches"]);
  const featureFile = join(dir, "chassis.vibe", "features", `${extrude}.json`);
  assert.match(await readFile(featureFile, "utf8"), /"distance": 10,/);
  // Local working state stays out of the repository.
  assert.equal(await readFile(join(dir, ".vibe", ".gitignore"), "utf8"), "*\n");
  let status = await run("git_status");
  assert.equal(status.branch, "main");
  assert.ok(status.changes.some((c: any) => c.document === "Chassis" && c.object === "feature Extrude 1" && c.change === "added"));
  await run("git_commit", { message: "Base plate" });
  assert.deepEqual((await run("git_status")).changes, []);
  await assert.rejects(run("git_commit", { message: "Nothing" }), /no design changes/);

  // A branch makes the plate thicker.
  await run("git_create_branch", { name: "thicker" });
  await run("set_dimension", { featureId: extrude, dimension: "distance", value: 20 }, id);
  status = await run("git_status");
  assert.deepEqual(status.changes.map((c: any) => [c.change, c.object]), [["modified", "feature Extrude 1"]]);
  await run("git_commit", { message: "Thicker plate" });

  // Back on main the design reloads from disk; add a fillet there.
  status = await run("git_switch", { name: "main" });
  assert.equal(status.branch, "main");
  assert.equal(await volume(id), 100 * 60 * 10);
  const doc = await store.read(id);
  assert.equal(doc.history.at(-1)!.description, "Changed on disk (git)");
  const body = (await store.view(doc)).geometry.bodies[0];
  const corner = body.topology.find((t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.center[0] - 50) < 1e-6 && Math.abs(t.center[1] - 30) < 1e-6)!;
  await run("fillet_edges", { bodyId: body.id, radius: 5, edges: [ref(corner)] }, id);
  await run("git_commit", { message: "Round a corner" });

  // The merge touches different objects: clean, and both changes are in.
  status = await run("git_merge", { branch: "thicker" });
  assert.equal(status.merging, false);
  assert.deepEqual(status.changes, []);
  const merged = await volume(id);
  assert.ok(Math.abs(merged - (100 * 60 * 20 - (25 - (Math.PI * 25) / 4) * 20)) < 1e-6, `merged volume ${merged}`);
  assert.match(sh("log", "--oneline", "-1"), /Merge branch 'thicker'/);

  // Both branches add a feature: separate files with their own order keys, no conflict.
  const top = (await store.view(await store.read(id))).geometry.bodies[0].topology.find((t) => t.kind === "face" && t.normal?.[2] === 1)!;
  await run("git_create_branch", { name: "left-hole" });
  await run("create_hole", { bodyId: body.id, face: ref(top), frame: "origin", positions: [[-30, 0]], diameter: 6 }, id);
  await run("git_commit", { message: "Left hole" });
  await run("git_switch", { name: "main" });
  await run("create_hole", { bodyId: body.id, face: ref(top), frame: "origin", positions: [[30, 0]], diameter: 6 }, id);
  await run("git_commit", { message: "Right hole" });
  status = await run("git_merge", { branch: "left-hole" });
  assert.equal(status.merging, false);
  assert.equal((await store.read(id)).features.filter((f) => f.type === "hole").length, 2);

  // The same object changed on both sides is a real conflict, settled per object.
  await run("git_create_branch", { name: "deep" });
  await run("set_dimension", { featureId: extrude, dimension: "distance", value: 30 }, id);
  await run("git_commit", { message: "Deep" });
  await run("git_switch", { name: "main" });
  await run("set_dimension", { featureId: extrude, dimension: "distance", value: 15 }, id);
  await run("git_commit", { message: "Shallow" });
  status = await run("git_merge", { branch: "deep" });
  assert.equal(status.merging, true);
  const conflict = status.changes.find((c: any) => c.change === "conflict");
  assert.deepEqual([conflict.document, conflict.object], ["Chassis", "feature Extrude 1"]);
  await assert.rejects(run("git_commit", { message: "Too soon" }), /Resolve the merge conflicts/);
  await run("git_resolve", { path: conflict.path, take: "theirs" });
  await run("git_commit", { message: "Take the deep plate" });
  assert.match(await readFile(featureFile, "utf8"), /"distance": 30,/);
  assert.ok((await volume(id)) > 100 * 60 * 25);

  // A merge whose result does not rebuild stays open with the problem listed, and can be aborted.
  await run("git_create_branch", { name: "broken" });
  const sketchId = (await store.read(id)).sketches[0].id;
  await run("delete_feature", { featureId: sketchId }, id).catch(() => undefined);
  const brokenDoc = await store.read(id);
  if (brokenDoc.sketches.some((s) => s.id === sketchId)) {
    // Deleting a used sketch is refused, so break it the way a bad hand edit would.
    await rm(join(dir, "chassis.vibe", "sketches", `${sketchId}.json`));
  }
  await run("git_commit", { message: "Remove the sketch" }).catch(() => undefined);
  await run("git_switch", { name: "main" }).catch(() => undefined);
  sh("checkout", "-q", "main");
  status = await run("git_merge", { branch: "broken" });
  assert.ok(status.problems?.length, "the broken merge is reported");
  assert.equal(status.merging, true);
  await run("git_abort_merge");
  assert.equal((await run("git_status")).merging, false);
  assert.ok((await volume(id)) > 100 * 60 * 25);
});

test("git: push to a remote and pull a collaborator's change, as with GitHub", async () => {
  const remote = join(dir, "..", `${dir.split("/").pop()}-remote.git`),
    other = join(dir, "..", `${dir.split("/").pop()}-other`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  sh("remote", "add", "origin", remote);
  let status = await run("git_push");
  assert.equal(status.upstream, "origin/main");
  assert.equal(status.ahead, 0);
  // A collaborator clones, changes the plate thickness in its feature file, and pushes.
  execFileSync("git", ["clone", "-q", remote, other]);
  const folder = join(other, "chassis.vibe", "features");
  let target = "";
  for (const f of await readdir(folder)) if ((await readFile(join(folder, f), "utf8")).includes('"type": "extrude"')) target = join(folder, f);
  await writeFile(target, (await readFile(target, "utf8")).replace(/"distance": \d+,/, '"distance": 12,'));
  execFileSync("git", ["-c", "user.name=Collaborator", "-c", "user.email=c@example.invalid", "commit", "-qam", "Thinner"], { cwd: other });
  execFileSync("git", ["push", "-q"], { cwd: other });
  // Pulling brings it into the open design.
  const id = (await store.list())[0].id;
  status = await run("git_pull");
  assert.equal(status.behind, 0);
  assert.equal((await store.read(id)).features.find((f) => f.type === "extrude")!.params.distance, 12);
  await rm(remote, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
});
