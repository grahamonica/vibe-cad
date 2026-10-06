import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { topologyKey } from "../cad/topology-key.ts";
test("browser-portable SHA-256 preserves saved native topology identities", () => {
  for (const value of [
    "",
    "abc",
    '["face","PLANE",[0.5,0.5,1,0,0,1]]',
    '"−X face"',
  ])
    assert.equal(
      topologyKey(value),
      createHash("sha256").update(value).digest("hex").slice(0, 14),
    );
});
