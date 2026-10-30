import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRenderBudget, renderPixelRatio } from '../editor/viewport/render-budget.ts';
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
  assert.throws(() => assertRenderBudget([body(1_000_000),body(1_000_000)]), /memory budget/);
});
