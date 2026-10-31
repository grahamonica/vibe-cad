import { Quaternion, Vector3 } from 'three';
import { bodyPlacements, eulerDegrees, localTopology, solveComponents, type SolveReport } from './assembly.ts';
import { rotateTensor } from './mass.ts';
import {driveGearMates} from './drag-motion.ts';
import type { Document, Geometry, Placement, RenderBody, Vec3, View } from './types.ts';

const identity:Placement={position:[0,0,0],quaternion:[0,0,0,1]};
export function samePlacement(a:Placement=identity,b:Placement=identity) {
  return a.position.every((x,i)=>Math.abs(x-b.position[i])<1e-10)&&Math.abs(a.quaternion.reduce((sum,x,i)=>sum+x*b.quaternion[i],0))>1-1e-12;
}
/** Rigidly re-place existing vertices and metadata; stationary bodies and index arrays are shared. */
export function placeCachedBody(body:RenderBody,before:Placement=identity,after:Placement=identity):RenderBody {
  if(samePlacement(before,after))return body;
  const rotation=new Quaternion(...after.quaternion).multiply(new Quaternion(...before.quaternion).invert());
  const shift=new Vector3(...after.position).sub(new Vector3(...before.position).applyQuaternion(rotation));
  const turn=(p:Vec3)=>new Vector3(...p).applyQuaternion(rotation).toArray() as Vec3;
  const point=(p:Vec3)=>new Vector3(...p).applyQuaternion(rotation).add(shift).toArray() as Vec3;
  const transform=(values:number[] | Float32Array,normal=false)=>{
    const out=values instanceof Float32Array ? new Float32Array(values.length) : new Array<number>(values.length),fn=normal?turn:point;
    for(let i=0;i<values.length;i+=3){const p=fn([values[i],values[i+1],values[i+2]]);out[i]=p[0];out[i+1]=p[1];out[i+2]=p[2];}return out;
  };
  const vertices=transform(body.mesh.vertices),bounds:[Vec3,Vec3]=[[Infinity,Infinity,Infinity],[-Infinity,-Infinity,-Infinity]];
  for(let i=0;i<vertices.length;i+=3)for(let k=0;k<3;k++){bounds[0][k]=Math.min(bounds[0][k],vertices[i+k]);bounds[1][k]=Math.max(bounds[1][k],vertices[i+k]);}
  return {...body,bounds,centerOfMass:point(body.centerOfMass),mesh:{...body.mesh,vertices,normals:transform(body.mesh.normals,true)},edges:{...body.edges,lines:transform(body.edges.lines)},
    topology:body.topology.map(t=>({...t,center:point(t.center),...(t.normal?{normal:turn(t.normal)}:{}),...(t.axis?{axis:{origin:point(t.axis.origin),direction:turn(t.axis.direction)}}:{}),...(t.endpoints?{endpoints:t.endpoints.map(point) as [Vec3,Vec3]}:{})})),
    ...(body.threads?{threads:body.threads.map(t=>({...t,origin:point(t.origin),direction:turn(t.direction)}))}:{}),
    ...(body.inertiaTensor?{inertiaTensor:rotateTensor(body.inertiaTensor,[turn([1,0,0]),turn([0,1,0]),turn([0,0,1])])}:{}),
  };
}
export function updateCachedPlacements(geometry:Geometry,placements:Record<string,Placement>):Geometry {
  return {...geometry,placements,bodies:geometry.bodies.map(b=>placeCachedBody(b,geometry.placements?.[b.id],placements[b.id]))};
}
/** Solve the same actual mate graph used by solid rebuilds, without creating any solid. */
export function repositionAssembly(doc:Document,geometry:Geometry,anchorId:string) {
  const report:SolveReport={mates:{},components:{}};
  const topology=localTopology(geometry),driven=driveGearMates(doc,geometry,anchorId);
  let solved=solveComponents(driven,topology,{anchor:[anchorId],report});
  const broken=Object.entries(report.mates).find(([id,m])=>(m.status==='error'||m.status==='over')&&!['error','over'].includes(geometry.mateStatus?.[id]?.status??''));
  if(broken)throw Error(`Component cannot go there: ${broken[1].message??'mates cannot be satisfied'}`);
  for(const c of doc.components??[])if(!c.grounded&&solved[c.id]){c.position=solved[c.id].position;c.rotation=eulerDegrees(solved[c.id]);}
  // Definition and intent use the saved graph, independent of which gear was grabbed.
  solved=solveComponents(doc,topology,{initial:solved,anchor:[anchorId],report});
  const invalid=Object.entries(report.mates).find(([id,m])=>(m.status==='error'||m.status==='over')&&!['error','over'].includes(geometry.mateStatus?.[id]?.status??''));
  if(invalid)throw Error(`Component cannot go there: ${invalid[1].message??'mates cannot be satisfied'}`);
  for(const c of doc.components??[])if(!c.grounded&&solved[c.id]){c.position=solved[c.id].position;c.rotation=eulerDegrees(solved[c.id]);}
  const placements=bodyPlacements(doc,solved,geometry.bodies.map(b=>b.id));
  const oldMessages=new Set(Object.values(geometry.mateStatus??{}).map(m=>m.message).filter(Boolean));
  return {...updateCachedPlacements(geometry,placements),placementOnly:true,mateStatus:report.mates,componentStatus:report.components,warnings:[...geometry.warnings.filter(w=>!oldMessages.has(w)),...Object.values(report.mates).flatMap(m=>m.status!=='ok'&&m.message?[m.message]:[])]};
}
export function placementAck(view:View,displayOnly=false) {
  if((!view.geometry.placementOnly&&!displayOnly)||!view.geometry.shapeKey)return undefined;
  return {kind:'placement' as const,shapeKey:view.geometry.shapeKey,dependencyKey:view.geometry.dependencyKey,
    document:view.document,placements:view.geometry.placements??{},mateStatus:view.geometry.mateStatus,componentStatus:view.geometry.componentStatus,warnings:view.geometry.warnings};
}
export function applyPlacementAck(view:View,result:unknown):View|undefined {
  const ack=result as ReturnType<typeof placementAck>;
  if(ack?.kind!=='placement'||ack.document.id!==view.document.id||ack.shapeKey!==view.geometry.shapeKey||ack.dependencyKey!==view.geometry.dependencyKey||ack.document.revision<view.document.revision)return;
  return {...view,document:ack.document,geometry:{...updateCachedPlacements(view.geometry,ack.placements),placementOnly:true,mateStatus:ack.mateStatus,componentStatus:ack.componentStatus,warnings:ack.warnings},preview:undefined};
}
