import test from 'node:test';
import assert from 'node:assert/strict';
import {BoxGeometry,EdgesGeometry} from 'three';
import {DocumentStore,type DocumentPersistence} from '../cad/document-store.ts';
import {placeGeometry} from '../cad/assembly.ts';
import {applyPlacementAck,placementAck} from '../cad/placement.ts';
import {toolset} from '../cad/tools.ts';
import type {Document,RenderBody,View} from '../cad/types.ts';
class Memory implements DocumentPersistence {
 directory='/tmp/placement-fixture';docs=new Map<string,Document>();fail=false;
 async list(){return [...this.docs.values()].map(d=>structuredClone(d));}
 async read(id:string){const d=this.docs.get(id);if(!d)throw Error('Missing');return structuredClone(d);}
 async commit(d:Document,revision:number|null){if(this.fail)throw Error('Storage full');assert.equal(this.docs.get(d.id)?.revision??null,revision);this.docs.set(d.id,structuredClone(d));}
}
function box(id:string):RenderBody {
 const mesh=new BoxGeometry(2,4,6),edge=new EdgesGeometry(mesh);mesh.computeBoundingBox();
 return {id,name:id,color:'#aaa',hidden:false,volume:48,surfaceArea:88,centerOfMass:[0,0,0],mass:100,inertiaTensor:[10,20,30,0,0,0],bounds:[mesh.boundingBox!.min.toArray(),mesh.boundingBox!.max.toArray()],topology:[],
 mesh:{vertices:Array.from(mesh.attributes.position.array),normals:Array.from(mesh.attributes.normal.array),triangles:Array.from(mesh.index!.array),faceGroups:[]},edges:{lines:Array.from(edge.attributes.position.array),edgeGroups:[]}};
}
test('committed rigid moves reuse shapes, keep mass metadata correct and update clients without meshes',async()=>{
 const p=new Memory();let builds=0;const store=new DocumentStore(p,async d=>{builds++;return placeGeometry(d,{bodies:d.bodies.map(b=>box(b.id)),warnings:[]});});
 let v=await store.createWith('motion','rigid fixture','assistant',d=>{for(const id of ['fixed','moving']){d.bodies.push({id,name:id,color:'#aaa',hidden:false});d.components!.push({id,name:id,bodyIds:[id],grounded:id==='fixed',position:[0,0,0],rotation:[0,0,0],explode:[0,0,0]});}});
 const original=v,stationary=v.geometry.bodies[0],count=builds;
 const move=toolset(store).find(t=>t.name==='set_component_transform')!;
 for(let x=1;x<=20;x++)v=await move.handler(move.schema.parse({documentId:v.document.id,expectedRevision:v.document.revision,componentId:'moving',position:[x,0,0],rotation:[0,0,90]}),'user') as View;
 assert.equal(builds,count,'Rigid motion rebuilt solid features');
 assert.equal(v.geometry.bodies[0],stationary);
 assert.deepEqual(v.geometry.bodies[1].centerOfMass,[20,0,0]);
 assert.ok(Math.abs(v.geometry.bodies[1].inertiaTensor![0]-20)<1e-8);
 assert.ok(Math.abs(v.geometry.bodies[1].inertiaTensor![1]-10)<1e-8);
 assert.equal(v.geometry.bodies[1].mesh.triangles,original.geometry.bodies[1].mesh.triangles);
 const ack=placementAck(v)!;assert.equal(ack.shapeKey,original.geometry.shapeKey);assert.equal((ack as any).geometry,undefined);
 const client=applyPlacementAck(original,ack)!;assert.deepEqual(client.geometry.bodies[1].centerOfMass,[20,0,0]);assert.equal(client.document.revision,v.document.revision);
 assert.deepEqual(client.geometry.bodies[1].bounds,v.geometry.bodies[1].bounds);
 assert.equal(applyPlacementAck(original,{...ack,shapeKey:'different shape'}),undefined);
 assert.equal(applyPlacementAck(original,{...ack,dependencyKey:'changed source part'}),undefined);
 assert.ok((await store.state(v.document.id)).placement);
 assert.equal((await store.state(v.document.id,v.document.revision,v.geometry.shapeKey)).placement,undefined,'Unchanged polling resent placement/document data');
 const geometryBeforeExplode=v.geometry,explode=toolset(store).find(t=>t.name==='set_explode_offset')!;
 v=await explode.handler(explode.schema.parse({documentId:v.document.id,expectedRevision:v.document.revision,componentId:'moving',offset:[100,0,0]}),'user') as View;
 assert.equal(builds,count,'Display offsets rebuilt solid features');assert.equal(v.geometry.bodies,geometryBeforeExplode.bodies);assert.deepEqual(v.geometry,geometryBeforeExplode);
 assert.ok((await store.state(v.document.id,v.document.revision-1,v.geometry.shapeKey)).placement);
 p.fail=true;await assert.rejects(move.handler(move.schema.parse({documentId:v.document.id,expectedRevision:v.document.revision,componentId:'moving',position:[100,0,0],rotation:[0,0,0]}),'user'),/Storage full/);p.fail=false;
 assert.equal((await store.read(v.document.id)).revision,v.document.revision);assert.equal((await store.view(await store.read(v.document.id))).geometry.bodies[1],v.geometry.bodies[1]);
 store.clearCaches();const rebuilt=await store.view(await store.read(v.document.id));
 assert.equal(builds,count+1);assert.deepEqual(rebuilt.geometry.bodies[1].bounds,v.geometry.bodies[1].bounds);
 assert.equal(applyPlacementAck(rebuilt,ack),undefined,'Rebuilt shapes accepted a stale placement acknowledgement');
});
