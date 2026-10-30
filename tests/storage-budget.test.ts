import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentStore, type DocumentPersistence } from '../cad/document-store.ts';
import { toolset } from '../cad/tools.ts';
import { exportProject } from '../cad/project-archive.ts';
import { unpackProject } from '../cad/project-file-format.ts';
import type { Document, Geometry } from '../cad/types.ts';
class Memory implements DocumentPersistence {
  directory='memory'; docs=new Map<string,Document>(); blobs=new Map<string,Uint8Array>();
  async list(){return structuredClone([...this.docs.values()]);}
  async read(id:string){ const d=this.docs.get(id);if(!d)throw Error('not found');return structuredClone(d); }
  async commit(d:Document,rev:number|null){ if(rev===null?this.docs.has(d.id):this.docs.get(d.id)?.revision!==rev)throw Error('Revision conflict');this.docs.set(d.id,structuredClone(d)); }
  async deleteDocument(id:string,rev:number){ assert.equal(this.docs.get(id)?.revision,rev);this.docs.delete(id); }
  async listBlobs(){return [...this.blobs.keys()];}
  async deleteBlob(id:string){this.blobs.delete(id);}
}
const geometry=async():Promise<Geometry>=>({bodies:[],warnings:[]});
const component=(id:string)=>({id:'instance',name:'part',bodyIds:[],source:{documentId:id},position:[0,0,0] as [number,number,number],rotation:[0,0,0] as [number,number,number],explode:[0,0,0] as [number,number,number],grounded:true});
test('default project archives omit deleted parts while opt-in archives preserve undo', async()=>{
 const p=new Memory(),s=new DocumentStore(p,geometry),old=await s.create('old'),part=await s.create('current');let root=await s.create('root');
 root=await s.transact(root.document.id,0,'insert','assistant',d=>{d.components=[component(old.document.id)];});
 root=await s.transact(root.document.id,1,'replace','assistant',d=>{d.components=[component(part.document.id)];});
 const packed=unpackProject(await exportProject(s,root.document.id));
 assert.equal(packed.documents[old.document.id],undefined);assert.ok(packed.documents[part.document.id]);assert.equal(packed.documents[root.document.id].history.length,1);
 const all=unpackProject(await exportProject(s,root.document.id,true));assert.ok(all.documents[old.document.id]);
});
test('scoped cleanup protects other projects and their historical references',async()=>{
 const p=new Memory(),s=new DocumentStore(p,geometry),root=await s.create('root'),unused=await s.create('unused'),shared=await s.create('shared'),other=await s.create('other');
 await s.transact(other.document.id,0,'use shared','user',d=>{d.components=[component(shared.document.id)];});
 await s.transact(other.document.id,1,'remove shared','user',d=>{d.components=[];});
 p.blobs.set('a'.repeat(64),new Uint8Array([1]));
 const old=p.docs.get(unused.document.id)!;old.features.push({id:'old-import',name:'old import',type:'import',bodyId:'old-body',params:{blob:'a'.repeat(64),format:'step'},suppressed:false});
 p.blobs.set('b'.repeat(64),new Uint8Array([2])); // An unrelated orphan upload is outside this cleanup's scope.
 const candidates=[unused.document.id,shared.document.id];
 const preview=await s.compactStorage([root.document.id],candidates,true);assert.deepEqual(preview.removed,[unused.document.id]);assert.ok(p.docs.has(unused.document.id));
 await s.compactStorage([root.document.id],candidates,false);assert.ok(!p.docs.has(unused.document.id));assert.ok(p.docs.has(shared.document.id));assert.ok(p.docs.has(other.document.id));assert.equal(p.blobs.size,1);assert.ok(p.blobs.has('b'.repeat(64)));
});
test('batch rollback survives bounded undo history and restores the original design',async()=>{
 const p=new Memory(),s=new DocumentStore(p,geometry),root=await s.create('root');const tool=toolset(s).find(t=>t.name==='run_steps')!;
 const steps=Array.from({length:59},(_,i)=>({tool:'set_variable',args:{name:'x',expression:String(i)}}));steps.push({tool:'no_such_tool',args:{name:'x',expression:'0'}});
 const r=await tool.handler(tool.schema.parse({documentId:root.document.id,steps}),'assistant');
 assert.equal(r.ok,false);assert.equal(r.rolledBack,true);const d=await s.read(root.document.id);assert.deepEqual(d.variables,[]);assert.ok(d.history.length<=24);assert.equal(s.buildControl.status().state,'idle');
});
test('linked-part edits refresh an assembly state without a dummy root edit',async()=>{
 const p=new Memory(),s=new DocumentStore(p,geometry),part=await s.create('part');let root=await s.create('root');
 root=await s.transact(root.document.id,0,'insert','assistant',d=>{d.components=[component(part.document.id)];});
 const before=await s.state(root.document.id);
 await s.transact(part.document.id,0,'edit part','user',d=>{d.variables=[{name:'size',expression:'10',value:10}];});
 const after=await s.state(root.document.id);
 assert.equal(after.revision,before.revision);assert.notEqual(after.dependencyKey,before.dependencyKey);
 assert.equal((await s.view(await s.read(root.document.id))).geometry.dependencyKey,after.dependencyKey);
});
