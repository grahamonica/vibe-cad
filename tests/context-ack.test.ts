import test from 'node:test';
import assert from 'node:assert/strict';
import { applyContextAck } from '../editor/context-ack.ts';
import type { View } from '../cad/types.ts';
test('camera acknowledgement retains geometry identity and never relabels stale geometry',()=>{
  const current={document:{id:'part',revision:10,selection:[]},geometry:{bodies:[{id:'body'}]}} as unknown as View;
  const viewport={position:[1,2,3],target:[0,0,0]};
  const ack={kind:'context',document:{id:'part',revision:10,selection:[],viewport}};
  const result=applyContextAck(current,ack);
  assert.equal(result.geometry,current.geometry);
  assert.equal(result.document.viewport,viewport);
  assert.equal(applyContextAck(current,{...ack,document:{...ack.document,revision:11}}),current);
  assert.equal(applyContextAck(current,{...ack,document:{...ack.document,id:'other'}}),current);
});
