import test from 'node:test';
import assert from 'node:assert/strict';
import {DocumentStore,type DocumentPersistence} from '../cad/document-store.ts';
import {toolset} from '../cad/tools.ts';
import {rebuild,exportModel,renderDrawing,initKernel} from '../cad/kernel.ts';
import {closeKernel} from '../cad/geometry.ts';
import {exportProject} from '../cad/project-archive.ts';
import {unpackProject} from '../cad/project-file-format.ts';
import type {Document} from '../cad/types.ts';
import * as r from 'replicad';

function memory(documents:Record<string,Document>={},blobs:Record<string,Uint8Array>={}):DocumentPersistence {
 return {directory:'memory:project',list:async()=>Object.values(documents).map(d=>structuredClone(d)),
 read:async id=>{if(!documents[id])throw Error('Missing project part');return structuredClone(documents[id]);},
 commit:async(d,revision)=>{if(revision===null?!!documents[d.id]:documents[d.id]?.revision!==revision)throw Error('Revision conflict');documents[d.id]=structuredClone(d);},
 putBlob:async(hash,bytes)=>{blobs[hash]=new Uint8Array(bytes);},getBlob:async hash=>{if(!blobs[hash])throw Error('Missing source import');return new Uint8Array(blobs[hash]);}};
}
async function reopen(text:string) {
 const saved=unpackProject(text),store=new DocumentStore(memory(saved.documents,saved.blobs),rebuild);
 return store.view(await store.read(saved.root.id));
}
test('a local project reopens parametric parts, imported originals, assembly mates, drawings and history without a service',{timeout:90000},async()=>{
 const store=new DocumentStore(memory(),rebuild),tools=toolset(store);
 const invoke=async(name:string,args:any)=>{const t=tools.find(t=>t.name===name)!;return t.handler(t.schema.parse(args),'user');};
 const edit=async(id:string,name:string,args:any)=>invoke(name,{documentId:id,expectedRevision:(await store.read(id)).revision,...args});
 try {
  const id=(await store.create('Local plate')).document.id;
  const sketch=await edit(id,'create_sketch',{plane:'XY'});
  await edit(id,'add_sketch_entity',{sketchId:sketch.document.sketches[0].id,type:'rectangle',values:{x:0,y:0,width:40,height:30}});
  const extruded=await edit(id,'extrude',{sketchId:sketch.document.sketches[0].id,distance:8});
  await edit(id,'set_appearance',{objectId:extruded.document.bodies[0].id,color:'#B58945',texture:'brushed-metal'});
  const plate=await store.read(id),original=await exportModel(await store.kernelDocument(plate),'step');
  const imported=await invoke('import_part',{data:Buffer.from(original.bytes).toString('base64'),filename:'original.step'});
  const assemblyId=(await store.create('Local assembly')).document.id;
  await edit(assemblyId,'insert_component',{partDocumentId:id,grounded:true});
  const inserted=await edit(assemblyId,'insert_component',{partDocumentId:imported.document.id,position:[60,0,0],grounded:false});
  const top=inserted.geometry.bodies[0].topology.find((t:any)=>t.kind==='face'&&t.normal?.[2]===1)!;
  const bottom=inserted.geometry.bodies[1].topology.find((t:any)=>t.kind==='face'&&t.normal?.[2]===-1)!;
  const ref=(t:any)=>({id:t.id,bodyId:t.bodyId,kind:t.kind,geomType:t.geomType});
  await edit(assemblyId,'add_mate',{type:'coincident',moving:ref(bottom),target:ref(top)});
  const drawing=await edit(assemblyId,'create_drawing',{name:'Assembly drawing',size:'A4',orientation:'landscape',bodyIds:inserted.geometry.bodies.map((b:any)=>b.id)});
  const sheetId=drawing.document.drawings[0].id;
  await edit(assemblyId,'add_drawing_view',{drawingId:sheetId,kind:'base',orientation:'front',position:[90,100],scale:0.5});
  const text=await exportProject(store,assemblyId),saved=unpackProject(text);
  assert.equal(JSON.parse(text).format,'vibe-cad-project/1');
  assert.equal(Object.keys(saved.documents).length,3);
  assert.deepEqual(saved.blobs[imported.document.features[0].params.blob],original.bytes);
  assert.deepEqual(saved.documents[id],JSON.parse(JSON.stringify(plate)));
  const reopened=new DocumentStore(memory(saved.documents,saved.blobs),rebuild),view=await reopened.view(await reopened.read(assemblyId));
  assert.equal(view.geometry.bodies.length,2);
  assert.equal(view.geometry.mateStatus![saved.root.mates![0].id].status,'ok');
  assert.ok(Math.abs(view.geometry.bodies.reduce((sum,b)=>sum+b.volume,0)-19200)<1e-5);
  assert.equal(view.geometry.bodies[0].color,'#B58945');assert.equal(view.geometry.bodies[0].texture,'brushed-metal');
  assert.ok((await renderDrawing(await reopened.kernelDocument(saved.root),sheetId)).svg.includes('<svg'));
  for(const format of ['step','stl'] as const)assert.ok((await exportModel(await reopened.kernelDocument(saved.root),format)).bytes.length>100);
  const undo=toolset(reopened).find(t=>t.name==='undo')!;
  await undo.handler(undo.schema.parse({documentId:id,expectedRevision:plate.revision}),'user');assert.equal((await reopened.read(id)).historyIndex,plate.historyIndex-1);
  const corrupt=JSON.parse(text);corrupt.blobs[Object.keys(corrupt.blobs)[0]]=btoa('corrupted');
  assert.throws(()=>unpackProject(JSON.stringify(corrupt)),/integrity/);
  const invalid=JSON.parse(text);invalid.documents[id].features[0].params.distance=-1e12;
  await assert.rejects(reopen(JSON.stringify(invalid)));
  assert.deepEqual(await store.read(id),plate,'invalid file validation must not change existing work');
  // Color data must come from source styles, not guesses from a manufacturer photograph.
  await initKernel();
  const colored=new Uint8Array(await r.exportSTEP([{shape:r.makeBox([0,0,0],[10,20,30]),color:'#B58945'},{shape:r.makeBox([40,0,0],[45,5,5]),color:'#336699'}]).arrayBuffer());
  const coloredPart=await invoke('import_part',{data:Buffer.from(colored).toString('base64'),filename:'colored-source.step'});
  const colors=new Set(coloredPart.geometry.bodies[0].mesh.faceGroups.map((g:any)=>g.color));assert.equal(colors.size,2);assert.equal(colors.has(undefined),false);
  const coloredText=await exportProject(store,coloredPart.document.id);
  const coloredView=await reopen(coloredText);
  assert.deepEqual(new Set(coloredView.geometry.bodies[0].mesh.faceGroups.map(g=>g.color)),colors);
 }finally{await closeKernel();}
});
