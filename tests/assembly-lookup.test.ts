import test from "node:test";
import assert from "node:assert/strict";
import { solveComponents, type SolveReport } from "../cad/assembly.ts";
import type { Document, Topology } from "../cad/types.ts";

test("detailed assembly solves index topology once and still reject wrong-body references", () => {
  let idReads = 0;
  const face = (id: string, bodyId: string, axial = false): Topology => ({
    get id() { idReads++; return id; },
    bodyId, kind: "face", geomType: axial ? "CYLINDRE" : "PLANE", label: id,
    center: [0, 0, 0], normal: axial || bodyId === "baseBody" ? [0, 0, 1] : [0, 0, -1],
    signature: [0, 0, 0, 0, 0, 1],
    ...(axial ? { radius: 2.5, axis: { origin: [0, 0, 0] as [number, number, number], direction: [0, 0, 1] as [number, number, number] } } : {}),
  });
  const topology = [face("baseAxis", "baseBody", true), face("baseTop", "baseBody"), face("rotorAxis", "rotorBody", true), face("rotorBottom", "rotorBody"),
    ...Array.from({ length: 10000 }, (_, i) => face(`detail${i}`, "detailBody"))];
  const ref = (id: string, bodyId: string) => ({ id, bodyId, kind: "face" as const });
  const doc = {
    components: [
      { id: "base", name: "base", bodyIds: ["baseBody"], grounded: true, position: [0, 0, 0], rotation: [0, 0, 0], explode: [0, 0, 0] },
      { id: "rotor", name: "rotor", bodyIds: ["rotorBody"], grounded: false, position: [4, 3, 2], rotation: [0, 0, 0], explode: [0, 0, 0] },
    ],
    mates: [
      { id: "axis", name: "axis", type: "concentric", moving: ref("rotorAxis", "rotorBody"), target: ref("baseAxis", "baseBody"), value: 0, aligned: true, suppressed: false },
      { id: "seat", name: "seat", type: "distance", moving: ref("rotorBottom", "rotorBody"), target: ref("baseTop", "baseBody"), value: 5, aligned: false, suppressed: false },
    ],
  } as unknown as Document;
  const report: SolveReport = { mates: {}, components: {} };
  const placed = solveComponents(doc, topology, { report });
  assert.deepEqual(placed.rotor.position, [0, 0, 5]);
  assert.equal(report.components.rotor.dof, 1);
  assert.ok(Object.values(report.mates).every(m => m.status === "ok"));
  assert.ok(idReads <= topology.length * 2, `topology was repeatedly scanned (${idReads} id reads)`);

  doc.mates![0].moving.bodyId = "baseBody";
  const invalid: SolveReport = { mates: {}, components: {} };
  solveComponents(doc, topology, { report: invalid });
  assert.equal(invalid.mates.axis.status, "error");
});
