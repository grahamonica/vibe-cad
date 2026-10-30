import test from 'node:test';
import assert from 'node:assert/strict';
import { solveComponents, type SolveReport } from '../cad/assembly.ts';
import { definitionOf } from '../cad/view-summary.ts';
import type { Document, Topology, Vec3, View } from '../cad/types.ts';
import {Quaternion,Vector3} from 'three';
import {prepareMotion} from '../cad/motion-preview.ts';
import {prepareDrag} from '../cad/drag-motion.ts';
import {rigidDragDriver} from '../cad/rigid-motion.ts';
function fixture(rotary=false){
 const ref=(id:string,bodyId:string)=>({id,bodyId,kind:'face' as const});
 const plane=(id:string,bodyId:string,normal:Vec3,axial=false):Topology=>({id,bodyId,kind:'face',geomType:axial?'CYLINDRE':'PLANE',normal,center:[0,0,0],signature:[],label:id,...(axial?{axis:{origin:[0,0,0],direction:normal},radius:2}: {})});
 const topology=[plane('bz','bb',[0,0,1]),plane('cz','cb',[0,0,1]),plane('by','bb',[0,1,0]),plane('cy','cb',[0,1,0]),plane('ba','bb',[0,0,1],true),plane('ca','cb',[0,0,1],true),plane('bx','bb',[1,0,0]),plane('cx','cb',[1,0,0])];
 const mate=(id:string,type:string,a:string,b:string)=>({id,name:id,type,moving:ref(a,'cb'),target:ref(b,'bb'),value:0,aligned:true,suppressed:false});
 const doc={id:'test',sketches:[],bodies:[],components:[{id:'base',name:'base',bodyIds:['bb'],grounded:true,position:[0,0,0],rotation:[0,0,0],explode:[0,0,0]},{id:'car',name:'car',bodyIds:['cb'],grounded:false,position:[0,0,0],rotation:[0,0,0],explode:[0,0,0],motion:{dof:1}}],mates:rotary?[mate('journal','concentric','ca','ba'),mate('seat','distance','cz','bz'),{...mate('travel','limitAngle','ca','ba'),min:-30,max:30}]:[mate('seat','coincident','cy','by'),mate('rail','coincident','cz','bz'),{...mate('travel','limitDistance','cx','bx'),min:-5,max:10}]} as unknown as Document;
 const solve=()=>{const report:SolveReport={mates:{},components:{}};const placements=solveComponents(doc,topology,{report});return {report,placements};};return{doc,topology,solve};
}
function renderView(f:ReturnType<typeof fixture>):View{
 const solved=f.solve().placements,point=(p:Vec3,pose:typeof solved[string])=>new Vector3(...p).applyQuaternion(new Quaternion(...pose.quaternion)).add(new Vector3(...pose.position)).toArray() as Vec3;
 const turn=(p:Vec3,pose:typeof solved[string])=>new Vector3(...p).applyQuaternion(new Quaternion(...pose.quaternion)).toArray() as Vec3;
 return {document:f.doc,geometry:{warnings:[],bodies:f.doc.components!.flatMap(c=>c.bodyIds.map(id=>({id,topology:f.topology.filter(t=>t.bodyId===id).map(t=>({...t,center:point(t.center,solved[c.id]),...(t.normal?{normal:turn(t.normal,solved[c.id])}:{}),...(t.axis?{axis:{origin:point(t.axis.origin,solved[c.id]),direction:turn(t.axis.direction,solved[c.id])}}:{})}))}))),placements:Object.fromEntries(f.doc.components!.flatMap(c=>c.bodyIds.map(id=>[id,solved[c.id]])))}} as unknown as View;
}
test('live playback solves hundreds of cached poses, clamps real travel and leaves the saved document unchanged',()=>{
 const f=fixture(),view=renderView(f),before=JSON.stringify(view);
 const preview=prepareMotion(view,{componentId:'car',kind:'translate',from:-20,to:40,playbackSeconds:5,cycleHours:24});
 for(let i=0;i<=500;i++){const actual=preview.at(i/500).components.car.position;assert.ok(Math.abs(actual[0]-Math.max(-5,Math.min(10,-20+60*i/500)))<1e-6);assert.deepEqual(actual.slice(1),[0,0]);}
 assert.equal(JSON.stringify(view),before);assert.equal(preview.at(0).components.car.position[0],-5);
 const rotary=fixture(true),sweep=prepareMotion(renderView(rotary),{componentId:'car',kind:'rotate',from:-100,to:100,playbackSeconds:5,cycleHours:24});
 for(let i=0;i<=100;i++){const p=sweep.at(i/100).components.car,angle=new Quaternion(...p.quaternion).angleTo(new Quaternion())*180/Math.PI;assert.ok(angle<=30.000001);}
});
test('either gear can be dragged, preserving ratio, phase and opposing axis directions',()=>{
 for(const aligned of [true,false])for(const opposite of [true,false]){
  const f=fixture(true);f.doc.components!.push({id:'follower',name:'follower',bodyIds:['fb'],grounded:false,position:[0,0,0],rotation:[0,0,0],explode:[0,0,0]});
  for(const id of ['ca','cz']){const t=f.topology.find(t=>t.id===id)!;f.topology.push({...t,id:'f'+id,bodyId:'fb',...(opposite?{normal:[0,0,-1] as Vec3,...(t.axis?{axis:{origin:[0,0,0] as Vec3,direction:[0,0,-1] as Vec3}}:{})}:{})});}
  for(const [id,type,moving,target]of [['axis','concentric','fca','ca'],['seat','distance','fcz','cz'],['gear','gear','fca','ca']])f.doc.mates!.push({id:'f'+id,name:id,type:type as any,moving:{id:moving,bodyId:'fb',kind:'face'},target:{id:target,bodyId:'cb',kind:'face'},aligned:type==='gear'?aligned:!opposite,value:type==='gear'?2:0,phase:type==='gear'?40:0,suppressed:false});
  const view=renderView(f),before=JSON.stringify(view),drag=prepareDrag(view,'follower')!;
  const desired=new Quaternion().setFromAxisAngle(new Vector3(0,0,1),40*Math.PI/180).multiply(new Quaternion(...drag.initial.follower.quaternion));
  const result=drag.solve({position:[0,0,0],quaternion:desired.toArray()});
  const angle=(id:string)=>2*Math.atan2(result.components[id].quaternion[2],result.components[id].quaternion[3])*180/Math.PI;
  assert.ok(Math.abs(angle('car')-(aligned?20:-20))<1e-5,`${aligned}/${opposite}: ${angle('car')}`);
  assert.ok(new Quaternion(...result.components.follower.quaternion).angleTo(desired)<1e-6);assert.equal(JSON.stringify(view),before);
 }
});
test('an attached off-axis lens drags its rigid driver through a full day; an independent joint stays independent',()=>{
 const f=fixture(true);f.doc.mates=f.doc.mates!.filter(m=>m.id!=='travel');f.doc.components![1].rotation=[0,0,-35];
 f.doc.components!.push({id:'lens',name:'lens',bodyIds:['lb'],grounded:false,position:[0,0,0],rotation:[0,0,0],explode:[0,0,0]});
 const axis=f.topology.find(t=>t.id==='ca')!,plane=f.topology.find(t=>t.id==='cz')!;
 f.topology.push({...axis,id:'aperture',center:[-75,0,0],axis:{origin:[-75,0,0],direction:[0,0,1]}},{...axis,id:'lens-axis',bodyId:'lb',center:[-75,0,0],axis:{origin:[-75,0,0],direction:[0,0,1]}},{...plane,id:'lens-seat',bodyId:'lb'});
 for(const [id,type,moving,target]of [['lens-journal','concentric','lens-axis','aperture'],['lens-seat','distance','lens-seat','cz'],['lens-rotation','gear','lens-axis','ca']])f.doc.mates!.push({id,name:id,type:type as any,moving:{id:moving,bodyId:'lb',kind:'face'},target:{id:target,bodyId:'cb',kind:'face'},aligned:true,value:type==='gear'?1:0,phase:0,suppressed:false});
 const view=renderView(f),before=JSON.stringify(view);assert.equal(rigidDragDriver(view,'lens')?.id,'car');
 const preview=prepareMotion(view,{componentId:'car',kind:'rotate',from:125,to:-235,playbackSeconds:12,cycleHours:24});
 for(let i=0;i<=144;i++){const poses=preview.at(i/144);assert.ok(new Quaternion(...poses.components.lens.quaternion).angleTo(new Quaternion(...poses.components.car.quaternion))<1e-6);assert.ok(Math.hypot(...poses.components.lens.position)<1e-6);}
 assert.equal(JSON.stringify(view),before);
 f.doc.mates!.find(m=>m.id==='lens-rotation')!.value=2;assert.equal(rigidDragDriver(renderView(f),'lens')?.id,'lens');
 f.doc.mates!.find(m=>m.id==='lens-rotation')!.value=1;f.doc.mates=f.doc.mates!.filter(m=>m.id!=='lens-seat');assert.equal(rigidDragDriver(renderView(f),'lens')?.id,'lens','An axially free joint was incorrectly merged into a rigid group');
});
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
