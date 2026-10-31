import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRenderBudget, renderPixelRatio, renderMemoryBytes } from '../editor/viewport/render-budget.ts';
import { meshGeometry, boxMapped } from '../editor/viewport/render-buffers.ts';
import type { RenderBody } from '../cad/types.ts';

test('large retina panels keep bounded framebuffers and dimensions', () => {
  for (const [w,h,dpr] of [[900,1400,2],[4000,3000,3],[10000,10000,2],[100,100,0],[100,100,NaN]]) {
    const ratio = renderPixelRatio(w,h,dpr);
    assert.ok(Number.isFinite(ratio) && ratio > 0 && ratio <= 1.5);
    assert.ok(w*h*ratio*ratio <= 2_000_001);
    assert.ok(Math.max(w,h)*ratio <= 4096);
  }
});
test('geometry allocation guard rejects a heavy view before allocating GPU buffers', () => {
  const body = (n:number) => ({mesh:{vertices:{length:n},normals:{length:n},triangles:{length:n}},edges:{lines:{length:n}}}) as unknown as RenderBody;
  assert.doesNotThrow(() => assertRenderBudget([body(10000)]));
  assert.throws(() => assertRenderBudget([body(5_000_000)]), /memory budget/);
});

test('display buffers remain shared and texture seams preserve indexed triangles and selections',()=>{
  const b={mesh:{vertices:new Float32Array([0,0,0,0,2,0,2,0,0,2,2,0,0,0,2]),
    normals:new Float32Array(15).fill(1),triangles:new Uint32Array([0,2,1,2,3,1,0,1,4]),faceGroups:[]},
    edges:{lines:new Float32Array(),edgeGroups:[]},bounds:[[0,0,0],[2,2,2]]} as unknown as RenderBody;
  const original=meshGeometry(b);
  assert.equal(original.getAttribute('position').array,b.mesh.vertices);
  assert.equal(original.getAttribute('normal').array,b.mesh.normals);
  assert.equal(original.index!.array,b.mesh.triangles);
  original.addGroup(0,6,0);original.addGroup(6,3,1);
  const mapped=boxMapped(original,b,2),p=mapped.getAttribute('position'),uv=mapped.getAttribute('uv');
  assert.equal(p.count,7);assert.deepEqual(mapped.groups,[{start:0,count:6,materialIndex:0},{start:6,count:3,materialIndex:1}]);
  const expected=[[0,0],[1,0],[0,1],[1,0],[1,1],[0,1],[0,0],[1,0],[0,1]];
  for(let i=0;i<9;i++){
    const source=b.mesh.triangles[i],target=mapped.index!.getX(i);
    for(let k=0;k<3;k++)assert.equal(p.array[target*3+k],b.mesh.vertices[source*3+k]);
    assert.deepEqual([uv.getX(target),uv.getY(target)],expected[i]);
  }
  // Source buffers + prepared attributes + GPU copies, with shared backing
  // stores and repeated geometry references counted exactly once.
  assert.equal(renderMemoryBytes([b],{geometries:[mapped,mapped],buffers:[]}),676);
  mapped.dispose();
});
