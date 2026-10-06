import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Store} from "../cad/store.ts";
import {toolset} from "../cad/tools.ts";
import {closeKernel} from "../cad/geometry.ts";

test("a fully fixed assembly explodes around one reference without changing mates, poses or physical geometry",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"vibe-fixed-explode-")),store=new Store(dir),tools=toolset(store);
  const run=async(name:string,args:any)=>{const t=tools.find(t=>t.name===name)!;return t.handler(t.schema.parse(args),"assistant");};
  try {
    const part=(await run("run_steps",{steps:[{tool:"create_document",args:{name:"Part"}},{tool:"create_sketch",args:{plane:"XY"},as:"sketch"},{tool:"add_sketch_entity",args:{sketchId:"@sketch.sketch",type:"rectangle",values:{x:0,y:0,width:30,height:20}}},{tool:"extrude",args:{sketchId:"@sketch.sketch",distance:5}}]})).view;
    const root=await store.create("Fixed robot");let view=root;
    for(const position of [[0,0,0],[0,0,20],[40,0,0]]) view=await run("insert_component",{documentId:root.document.id,expectedRevision:view.document.revision,partDocumentId:part.document.id,grounded:true,position});
    const before=JSON.stringify(view.geometry), components=structuredClone(view.document.components);
    const exploded=await run("auto_explode",{documentId:root.document.id,expectedRevision:view.document.revision});
    assert.deepEqual(exploded.document.components[0].explode,[0,0,0]);
    for(const c of exploded.document.components.slice(1)) assert.ok(Math.hypot(...c.explode)>0,"fixed purchased components must move in the exploded display");
    assert.equal(JSON.stringify(exploded.geometry),before,"explosion is display only");
    assert.deepEqual(exploded.document.components.map(({explode,...c}:any)=>c),components!.map(({explode,...c}:any)=>c));
    const undone=await run("undo",{documentId:root.document.id,expectedRevision:exploded.document.revision});
    assert.ok(undone.document.components.every((c:any)=>c.explode.every((n:number)=>n===0)));
  } finally { await closeKernel(); await rm(dir,{recursive:true,force:true}); }
});
