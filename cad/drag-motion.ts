/** Mate projection using current topology only; pointer movement never rebuilds solids. */
import { localTopology, solveComponents, bodyPlacements, eulerDegrees,gearPhase, type SolveReport } from './assembly.ts';
import type { View, Placement } from './types.ts';
import {componentOf,type Document,type Geometry} from './types.ts';
/** Reverse the algebra of gear mates when their follower is dragged. Saved mates are unchanged. */
export function driveGearMates(doc:Document,geometry:Geometry,componentId:string):Document{
 const topology=geometry.bodies.flatMap(b=>b.topology);
 const gears=(doc.mates??[]).filter(m=>!m.suppressed&&m.type==='gear'&&m.value!==0);
 const distance=new Map<string,number>([[componentId,0]]),queue=[componentId];
 for(let n=0;n<queue.length;n++)for(const m of gears){const a=componentOf(doc,m.moving.bodyId),b=componentOf(doc,m.target.bodyId);if(!a||!b)continue;const other=a.id===queue[n]?b:b.id===queue[n]?a:undefined;if(other&&!other.grounded&&!distance.has(other.id)){distance.set(other.id,distance.get(queue[n])!+1);queue.push(other.id);}}
 return {...doc,mates:(doc.mates??[]).map(m=>{
  if(!gears.includes(m))return m;
  const a=componentOf(doc,m.moving.bodyId),b=componentOf(doc,m.target.bodyId);
  if(!a||!b||b.grounded||(distance.get(a.id)??Infinity)>=(distance.get(b.id)??Infinity))return m;
  const ta=topology.find(t=>t.id===m.moving.id),tb=topology.find(t=>t.id===m.target.id),na=ta?.axis?.direction??ta?.normal,nb=tb?.axis?.direction??tb?.normal;
  const pa=geometry.placements?.[m.moving.bodyId],pb=geometry.placements?.[m.target.bodyId];
  if(!na||!nb||!pa||!pb||geometry.mateStatus?.[m.id]?.status&&geometry.mateStatus[m.id].status!=='ok')return m;
  // Calibrate the equivalent inverse equation at the validated pose. This also
  // accounts for the solver's perpendicular reference bases on opposing axes.
  return {...m,moving:m.target,target:m.moving,value:1/m.value,phase:gearPhase(1/m.value,m.aligned,{axis:na,placement:pa},{axis:nb,placement:pb})};
 })};
}
export function prepareDrag(view: View, componentId: string) {
 const component=view.document.components?.find(c=>c.id===componentId);
 if(!component||component.grounded)return;
 const needed=new Set((view.document.mates??[]).filter(m=>!m.suppressed).flatMap(m=>[m.moving.id,m.target.id]));
 for(const p of view.document.componentPatterns??[]){if(p.axisRef)needed.add(p.axisRef.id);if(p.directionRef)needed.add(p.directionRef.id);}
 const topology=localTopology({...view.geometry,bodies:view.geometry.bodies.map(b=>({...b,topology:b.topology.filter(t=>needed.has(t.id))}))});
 const initial=solveComponents(view.document,topology,{skipFreedomReport:true});
 const driven=driveGearMates(view.document,view.geometry,componentId);
 const ids=view.geometry.bodies.map(b=>b.id);
 let previous=initial;
 return {initial, solve(desired:Placement){
   const doc={...driven,components:view.document.components!.map(c=>c.id===componentId?{...c,position:desired.position,rotation:eulerDegrees(desired)}:c)};
   const report:SolveReport={mates:{},components:{}};
   const placed=solveComponents(doc,topology,{initial:{...initial,[componentId]:desired},anchor:[componentId],report,skipFreedomReport:true});
   if(Object.values(report.mates).every(m=>m.status==='ok'))previous=placed;
   return {components:previous,bodies:bodyPlacements(doc,previous,ids)};
 }};
}
