import test from 'node:test';
import assert from 'node:assert/strict';
import { solveComponents, type SolveReport } from '../cad/assembly.ts';
import { definitionOf } from '../cad/view-summary.ts';
import type { Document, Topology, Vec3, View } from '../cad/types.ts';
function fixture(rotary=false){
 const ref=(id:string,bodyId:string)=>({id,bodyId,kind:'face' as const});
 const plane=(id:string,bodyId:string,normal:Vec3,axial=false):Topology=>({id,bodyId,kind:'face',geomType:axial?'CYLINDRE':'PLANE',normal,center:[0,0,0],signature:[],label:id,...(axial?{axis:{origin:[0,0,0],direction:normal},radius:2}: {})});
 const topology=[plane('bz','bb',[0,0,1]),plane('cz','cb',[0,0,1]),plane('by','bb',[0,1,0]),plane('cy','cb',[0,1,0]),plane('ba','bb',[0,0,1],true),plane('ca','cb',[0,0,1],true),plane('bx','bb',[1,0,0]),plane('cx','cb',[1,0,0])];
 const mate=(id:string,type:string,a:string,b:string)=>({id,name:id,type,moving:ref(a,'cb'),target:ref(b,'bb'),value:0,aligned:true,suppressed:false});
 const doc={id:'test',sketches:[],bodies:[],components:[{id:'base',name:'base',bodyIds:['bb'],grounded:true,position:[0,0,0],rotation:[0,0,0],explode:[0,0,0]},{id:'car',name:'car',bodyIds:['cb'],grounded:false,position:[0,0,0],rotation:[0,0,0],explode:[0,0,0],motion:{dof:1}}],mates:rotary?[mate('journal','concentric','ca','ba'),mate('seat','distance','cz','bz'),{...mate('travel','limitAngle','ca','ba'),min:-30,max:30}]:[mate('seat','coincident','cy','by'),mate('rail','coincident','cz','bz'),{...mate('travel','limitDistance','cx','bx'),min:-5,max:10}]} as unknown as Document;
 const solve=()=>{const report:SolveReport={mates:{},components:{}};const placements=solveComponents(doc,topology,{report});return {report,placements};};return{doc,topology,solve};
}
test('prismatic travel stays movable and fully defined at either stop',()=>{
 const f=fixture();for(const [requested,expected]of [[40,10],[-40,-5],[4,4]]){f.doc.components![1].position=[requested,12,7];f.doc.components![1].rotation=[15,0,5];const {report,placements}=f.solve();assert.ok(Math.abs(placements.car.position[0]-expected)<1e-6);assert.ok(Math.hypot(placements.car.position[1],placements.car.position[2])<1e-6);assert.equal(report.components.car.dof,1);assert.equal(report.components.car.status,'full');assert.ok(Object.values(report.mates).every(s=>s.status==='ok'));
 const d=definitionOf({document:f.doc,geometry:{bodies:[],warnings:[],componentStatus:report.components,mateStatus:report.mates}} as View);assert.equal(d.status,'full');}
});
test('revolute limits clamp signed angles without consuming the permitted freedom',()=>{const f=fixture(true);for(const [request,expect]of [[80,30],[-90,-30],[12,12]]){f.doc.components![1].rotation=[0,0,request];const {report,placements}=f.solve();const angle=2*Math.atan2(placements.car.quaternion[2],placements.car.quaternion[3])*180/Math.PI;assert.ok(Math.abs(angle-expect)<1e-6);assert.equal(report.components.car.dof,1);assert.equal(report.components.car.status,'full');}});
test('motion declarations do not hide missing mates or unlock a fixed pose',()=>{const f=fixture();f.doc.mates=[];const r=f.solve().report.components.car;assert.equal(r.dof,6);assert.equal(r.status,'under');assert.match(r.intentMismatch!,/expected 1/);delete f.doc.components![1].motion;assert.equal(f.solve().report.components.car.status,'under');});
test('ordinary undeclared joints keep existing under-defined semantics',()=>{const f=fixture();delete f.doc.components![1].motion;assert.equal(f.solve().report.components.car.status,'under');});

test('drag preview projects linear travel through the same mates without editing the document',async()=>{
 const {prepareDrag}=await import('../cad/drag-motion.ts');const f=fixture();
 const geometry={warnings:[],bodies:['bb','cb'].map(id=>({id,topology:f.topology.filter(t=>t.bodyId===id)})),placements:{bb:{position:[0,0,0],quaternion:[0,0,0,1]},cb:{position:[0,0,0],quaternion:[0,0,0,1]}}};
 const before=JSON.stringify(f.doc);const drag=prepareDrag({document:f.doc,geometry} as unknown as View,'car')!;
 const result=drag.solve({position:[40,7,8],quaternion:[0,0,0,1]});assert.deepEqual(result.components.car.position,[10,0,0]);assert.deepEqual(result.bodies.cb.position,[10,0,0]);assert.equal(JSON.stringify(f.doc),before);
});
test('rotary drag clamps the joint and carries a geared follower',async()=>{
 const {prepareDrag}=await import('../cad/drag-motion.ts');const f=fixture(true);
 f.doc.components!.push({id:'follower',name:'follower',bodyIds:['fb'],grounded:false,position:[0,0,0],rotation:[0,0,0],explode:[0,0,0]});
 for(const id of ['ca','cz']){const source=f.topology.find(t=>t.id===id)!;f.topology.push({...source,id:'f'+id,bodyId:'fb'});}
 for(const [id,type,moving,target]of [['axis','concentric','fca','ca'],['seat','distance','fcz','cz'],['gear','gear','fca','ca']])f.doc.mates!.push({id:'f'+id,name:id,type:type as any,moving:{id:moving,bodyId:'fb',kind:'face'},target:{id:target,bodyId:'cb',kind:'face'},aligned:true,value:type==='gear'?1:0,phase:0,suppressed:false});
 const geometry={warnings:[],bodies:['bb','cb','fb'].map(id=>({id,topology:f.topology.filter(t=>t.bodyId===id)})),placements:Object.fromEntries(['bb','cb','fb'].map(id=>[id,{position:[0,0,0],quaternion:[0,0,0,1]}]))};
 const drag=prepareDrag({document:f.doc,geometry} as unknown as View,'car')!;const r=drag.solve({position:[5,7,0],quaternion:[0,0,Math.sin(Math.PI/4),Math.cos(Math.PI/4)]});
 const angle=(id:string)=>2*Math.atan2(r.components[id].quaternion[2],r.components[id].quaternion[3])*180/Math.PI;
 assert.ok(Math.abs(angle('car')-30)<1e-6);assert.ok(Math.abs(angle('follower')-30)<1e-6);assert.ok(Math.hypot(...r.components.car.position)<1e-6);
});
