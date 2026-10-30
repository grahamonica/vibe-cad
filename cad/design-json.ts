import { z } from 'zod';
import type { Document, Entity, Constraint, Vec3 } from './types.ts';
import { fieldsOf, captureReference, constraintTypes } from './solver.ts';
import { validVariableName } from './equations.ts';
const id=z.string().min(1).max(100),n=z.number().finite().min(-10000).max(10000);
// Homogeneous arrays survive the host's Draft-07 schema conversion; tuples do not.
const vec3=z.array(n).length(3);
const entity=z.object({id:id.optional(),type:z.enum(['line','arc','spline','rectangle','circle','point']),values:z.record(z.string(),n),construction:z.boolean().default(false)}).strict();
const constraint=z.object({id:id.optional(),type:z.enum(constraintTypes),entityIds:z.array(id).min(1).max(100),anchors:z.array(z.string()).max(2).optional(),value:n.optional(),dimension:z.string().optional(),axis:z.enum(['x','y']).optional(),expression:z.string().max(400).optional()}).strict();
export const designChanges=z.object({
 sketches:z.array(z.object({sketchId:id,purpose:z.enum(['artwork','functional']).optional(),entities:z.array(entity).max(600),constraints:z.array(constraint).max(1200).default([]),freeze:z.boolean().default(false)}).strict()).max(100).optional(),
 features:z.array(z.object({featureId:id,parameters:z.record(z.string(),n),expressions:z.record(z.string(),z.string().min(1).max(400)).optional()}).strict()).max(200).optional(),
 variables:z.array(z.object({name:z.string().min(1).max(80),expression:z.string().min(1).max(400)}).strict()).max(200).optional(),
 components:z.array(z.object({componentId:id,position:vec3.optional(),rotation:vec3.optional(),motionDof:z.number().int().min(0).max(6).nullable().optional()}).strict()).max(100).optional(),
}).strict().refine(c=>Object.values(c).some(v=>v?.length),'Provide at least one change');
export type DesignChanges=z.infer<typeof designChanges>;
export function applyDesignChanges(d:Document, input:DesignChanges, uuid:()=>string) {
 const changes=designChanges.parse(input);
 for(const change of changes.sketches??[]){
  const sk=d.sketches.find(s=>s.id===change.sketchId);if(!sk)throw Error('Sketch not found');
  const purpose=change.purpose??sk.purpose??'functional';
  if(change.freeze&&purpose!=='artwork')throw Error('Whole-profile freezing is for artwork; dimension functional interfaces or fix individual anchors explicitly');
  const ids=new Set<string>();
  sk.entities=change.entities.map(raw=>{const e={...raw,id:raw.id??uuid()} as Entity;if(ids.has(e.id))throw Error('Duplicate entity id');ids.add(e.id);
   const fields=fieldsOf(e);if(fields.length!==Object.keys(e.values).length||fields.some(k=>e.values[k]===undefined))throw Error('Invalid entity values');
   if(e.type==='spline'&&(fields.length<4||fields.length>128))throw Error('Spline needs 2 to 64 fit points');
   if((e.type==='circle'&&e.values.radius<=0)||(e.type==='rectangle'&&(e.values.width<=0||e.values.height<=0)))throw Error('Entity dimensions must be positive');return e;});
  sk.purpose=purpose;
  sk.constraints=change.constraints.map(c=>({...c,id:c.id??uuid()} as Constraint));
  const uniqueConstraints=new Set(sk.constraints.map(c=>c.id));if(uniqueConstraints.size!==sk.constraints.length)throw Error('Duplicate constraint id');
  for(const c of sk.constraints)captureReference(sk,c);
  if(change.freeze)for(const e of sk.entities){const c:Constraint={id:uuid(),type:'fixed',entityIds:[e.id]};captureReference(sk,c);sk.constraints.push(c);}
 }
 for(const change of changes.features??[]){
  const f=d.features.find(f=>f.id===change.featureId);if(!f)throw Error('Feature not found');
  if(f.type==='import')throw Error('Imported source blobs cannot be edited through numeric design changes');
  for(const [key,value]of Object.entries(change.parameters)){
   if(!(key in f.params)||typeof f.params[key]!=='number')throw Error(`Unknown numeric feature parameter ${key}`);
   f.params[key]=value;if(f.expressions)delete f.expressions[key];
  }
  for(const[key,expression]of Object.entries(change.expressions??{})){
   if(!(key in f.params)||typeof f.params[key]!=='number')throw Error(`Unknown numeric feature parameter ${key}`);
   (f.expressions??={})[key]=expression;
  }
 }
 for(const change of changes.variables??[]){if(!validVariableName(change.name))throw Error('Invalid variable name');const v=d.variables?.find(v=>v.name===change.name);if(v)v.expression=change.expression;else(d.variables??=[]).push({...change,value:0});}
 for(const change of changes.components??[]){const c=d.components?.find(c=>c.id===change.componentId);if(!c)throw Error('Component not found');if(change.position)c.position=change.position as Vec3;if(change.rotation)c.rotation=change.rotation as Vec3;if(change.motionDof===null)delete c.motion;else if(change.motionDof!==undefined)c.motion={dof:change.motionDof};}
 const identities=[...d.sketches.flatMap(s=>[s.id,...s.entities.map(e=>e.id),...s.constraints.map(c=>c.id)]),...d.features.map(f=>f.id),...d.bodies.map(b=>b.id),...(d.components??[]).map(c=>c.id),...(d.mates??[]).map(m=>m.id),...(d.referencePlanes??[]).map(p=>p.id)];
 if(new Set(identities).size!==identities.length)throw Error('Design object IDs must be unique');

}
/** Saved design only: no meshes, undo copies, imported bytes or transient owner state. */
export function designJSON(d:Document){return {id:d.id,revision:d.revision,name:d.name,units:d.units??'mm',variables:d.variables??[],material:d.material,sketches:d.sketches,features:d.features,bodies:d.bodies,referencePlanes:d.referencePlanes??[],components:d.components??[],mates:d.mates??[],componentPatterns:d.componentPatterns??[],intents:d.intents};}
