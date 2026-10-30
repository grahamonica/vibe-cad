import test from "node:test";
import assert from "node:assert/strict";
import { trimActiveCache } from "../cad/active-cache.ts";

test("assemblies larger than the nominal cache keep their working set", () => {
  const cache = new Map<string, number>(Array.from({length: 48}, (_, i) => [`part${i}`, i]));
  const active = new Set(Array.from({length: 40}, (_, i) => `part${i}`));
  const disposed: number[] = [];
  trimActiveCache(cache, active, 8, value => disposed.push(value));
  assert.equal(cache.size, 40);
  assert.ok([...active].every(key => cache.has(key)));
  assert.deepEqual(disposed, [40, 41, 42, 43, 44, 45, 46, 47]);
});

test("old revisions are evicted in insertion order once an assembly no longer needs them", () => {
  const cache = new Map([["old-revision", 1], ["unrelated", 2], ["current", 3]]);
  trimActiveCache(cache, new Set(["current"]), 2);
  assert.deepEqual([...cache.keys()], ["unrelated", "current"]);
});
