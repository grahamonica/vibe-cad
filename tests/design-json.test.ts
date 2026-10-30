import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{Store}from'../cad/store.ts';import{toolset}from'../cad/tools.ts';import{closeKernel}from'../cad/geometry.ts';import{solveSketch,captureReference}from'../cad/solver.ts';import type{Sketch,Constraint}from'../cad/types.ts';
const dir=await mkdtemp(join(tmpdir(),'vibe-json-'));const store=new Store(dir);const tools=toolset(store);
async function run(name:string,args:Record<string,unknown>){const t=tools.find(t=>t.name===name)!;return t.handler(t.schema.parse(args),'assistant');}
test.after(async()=>{await closeKernel();await rm(dir,{recursive:true,force:true});});
test('bulk design JSON edits keep the editable feature tree and validate without committing',async()=>{
 let v=await run('create_document',{name:'JSON plate'});const id=v.document.id;
 v=await run('create_sketch',{documentId:id,expectedRevision:v.document.revision,plane:'XY'});const sk=v.document.sketches[0].id;
 v=await run('add_sketch_entity',{documentId:id,expectedRevision:v.document.revision,sketchId:sk,type:'rectangle',values:{x:0,y:0,width:80,height:40}});
 v=await run('extrude',{documentId:id,expectedRevision:v.document.revision,sketchId:sk,distance:2});const feat=v.document.features[0].id,revision=v.document.revision;
 const read=await run('inspect_design',{documentId:id});assert.equal(read.design.id,id);assert.equal(read.design.history,undefined);assert.equal(read.design.geometry,undefined);
 const changes={features:[{featureId:feat,parameters:{distance:1.6}}],variables:[{name:'sheet',expression:'1.6'}]};
 const check=await run('validate_design',{documentId:id,expectedRevision:revision,changes,level:'geometry'});assert.equal(check.valid,true);assert.equal((await store.read(id)).revision,revision);assert.equal((await store.read(id)).features[0].params.distance,2);
 v=await run('edit_design',{documentId:id,expectedRevision:revision,changes});assert.equal(v.document.revision,revision+1);assert.equal(v.document.features[0].id,feat);assert.ok(Math.abs(v.geometry.bodies[0].volume-80*40*1.6)<1e-4);
 await assert.rejects(run('edit_design',{documentId:id,expectedRevision:revision,changes}),/Revision conflict/);
 const before=await store.read(id);await assert.rejects(run('edit_design',{documentId:id,expectedRevision:before.revision,changes:{features:[{featureId:feat,parameters:{distance:0}}]}}),/nonzero/);assert.deepEqual(await store.read(id),before);
 const structural=await run('validate_design',{documentId:id,expectedRevision:before.revision,level:'structure'});assert.equal(structural.assembly.status,'not_checked');
});
test('whole-profile freezing is explicit artwork; functional sketches keep dimensions',async()=>{
 let v=await run('create_document',{name:'art'});const id=v.document.id;v=await run('create_sketch',{documentId:id,expectedRevision:v.document.revision,plane:'XY'});const sketchId=v.document.sketches[0].id;
 const change={sketchId,entities:[{id:'r',type:'rectangle',values:{x:0,y:0,width:20,height:10}}],freeze:true};
 await assert.rejects(run('edit_design',{documentId:id,expectedRevision:v.document.revision,changes:{sketches:[change]}}),/artwork/);
 v=await run('edit_design',{documentId:id,expectedRevision:v.document.revision,changes:{sketches:[{...change,purpose:'artwork'}]}});assert.equal(v.document.sketches[0].solver.dof,0);assert.equal(v.document.sketches[0].purpose,'artwork');
});
test('fixed artwork fast path supports dense curves and still rejects conflicting dimensions',()=>{
 const s={id:'dense',name:'dense',plane:'XY',origin:[0,0,0],purpose:'artwork',entities:Array.from({length:450},(_,i)=>({id:'e'+i,type:'line',construction:false,values:{x1:i,y1:0,x2:i+.5,y2:1}})),constraints:[],solver:{dof:0,residual:0,status:'fully-constrained'}} as Sketch;
 for(const e of s.entities){const c:Constraint={id:'fix'+e.id,type:'fixed',entityIds:[e.id]};captureReference(s,c);s.constraints.push(c);}solveSketch(s);assert.equal(s.solver.dof,0);
 s.entities[0].values.x1=20;solveSketch(s);assert.equal(s.entities[0].values.x1,0);
 s.constraints.push({id:'bad',type:'dimension',entityIds:['e0'],dimension:'x1',value:2});assert.throws(()=>solveSketch(s),/Conflicting/);
 s.purpose='functional';assert.throws(()=>solveSketch(s),/budget/);
});
