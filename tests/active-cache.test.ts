import test from "node:test";
import assert from "node:assert/strict";
import { trimActiveCache, trimCostedCache } from "../cad/active-cache.ts";

test("assemblies larger than the nominal cache keep their working set", () => {
  const cache = new Map<string, number>(Array.from({length: 48}, (_, i) => [`part${i}`, i]));
  const active = new Set(Array.from({length: 40}, (_, i) => `part${i}`));
  const disposed: number[] = [];
  trimActiveCache(cache, active, 8, value => disposed.push(value));
  assert.equal(cache.size, 40);
  assert.ok([...active].every(key => cache.has(key)));
  assert.deepEqual(disposed, [40, 41, 42, 43, 44, 45, 46, 47]);
});

test("slightly oversized working sets retain costly geometry within the same memory budget",()=>{
 const cache=new Map([['vendor',{bytes:75,buildMs:1000}],['a',{bytes:25,buildMs:1}]]);
 const active=new Set(['vendor','a','b']);
 for(const id of ['b','a','b','a']){
  cache.set(id,{bytes:25,buildMs:1});trimCostedCache(cache,active,100);
  assert.ok(cache.has('vendor'));
  assert.ok([...cache.values()].reduce((n,e)=>n+e.bytes,0)<=100);
 }
 trimCostedCache(cache,new Set(['a']),25);
 assert.deepEqual([...cache.keys()],['a']);
});

test("old revisions are evicted in insertion order once an assembly no longer needs them", () => {
  const cache = new Map([["old-revision", 1], ["unrelated", 2], ["current", 3]]);
  trimActiveCache(cache, new Set(["current"]), 2);
  assert.deepEqual([...cache.keys()], ["unrelated", "current"]);
});
