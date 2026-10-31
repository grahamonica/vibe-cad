import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { freeOrbit } from '../editor/viewport/camera-math.ts';
import { cameraFor } from '../cad/drawing.ts';
import { BuildControl, BuildInterrupted } from '../cad/build-control.ts';

test('camera passes 180 degrees without flipping its up vector or leaving its orbit', () => {
  let pose = { position: [0, 0, 10] as [number,number,number], up: [0,1,0] as [number,number,number] };
  for (let i = 0; i < 270; i++) pose = freeOrbit(pose.position, [0,0,0], pose.up, 0, Math.PI / 180);
  assert.ok(Math.abs(pose.position[1] + 10) < 1e-8);
  assert.ok(Math.abs(pose.up[2] - 1) < 1e-8);
  assert.ok(Math.abs(new Vector3(...pose.position).dot(new Vector3(...pose.up))) < 1e-8);
  for (let i = 0; i < 90; i++) pose = freeOrbit(pose.position, [0,0,0], pose.up, 0, Math.PI / 180);
  assert.ok(new Vector3(...pose.position).distanceTo(new Vector3(0,0,10)) < 1e-8);
});
test('front, top, drawing and viewport use a consistent Y-up convention', () => {
  assert.deepEqual(cameraFor('front'), {dir:[0,0,1],x:[1,0,0],y:[0,1,0]});
  assert.deepEqual(cameraFor('top'), {dir:[0,1,0],x:[1,0,0],y:[0,0,-1]});
});
test('paused batches yield to manual edits and require a new plan without rollback', async () => {
  const build = new BuildControl(); let revision = 2;
  build.start('assembly', 10); build.control('pause');
  const paused = build.boundary(3, 'assembly', async () => ({ assembly: revision }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(build.status().state, 'paused');
  revision++;
  build.control('resume');
  await assert.rejects(paused, BuildInterrupted);
  build.finish(); assert.equal(build.status().state, 'idle');
});
test('stop wakes a paused build promptly and keeps the completed boundary', async () => {
  const build = new BuildControl(); build.start('assembly', 5); build.control('pause');
  const paused = build.boundary(2, 'assembly', async () => ({assembly:1}));
  await new Promise(resolve => setImmediate(resolve));
  build.control('cancel'); await assert.rejects(paused, /completed steps were kept/);
  build.finish(); assert.equal(build.status().state, 'idle');
});
test('stop during a pending pause checkpoint cannot strand a paused request',async()=>{
 const build=new BuildControl();build.start('root',2);build.control('pause');
 let resolve!:(r:Record<string,number>)=>void;
 const pending=build.boundary(1,'root',()=>new Promise(r=>{resolve=r;}));
 build.control('cancel');resolve({root:1});await assert.rejects(pending,BuildInterrupted);build.finish();
});


test('one closed transport stops subsequent background requests without suppressing ordinary errors', async () => {
  const { CadConnection } = await import('../editor/connection.ts');
  let notified = 0, invoked = 0;
  const connection = new CadConnection(() => notified++);
  await assert.rejects(connection.request(async () => { throw Error('Revision conflict'); }), /Revision conflict/);
  assert.ok(connection.active);
  const request = () => connection.request(async () => { invoked++; throw Error('Transport closed'); });
  for(let i=0;i<3;i++)await assert.rejects(request(), /Saved documents remain on disk/);
  assert.equal(invoked, 1);
  assert.equal(notified, 1);
  assert.equal(connection.active, false);
});
