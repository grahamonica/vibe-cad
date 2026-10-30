/** Mate projection using current topology only; pointer movement never rebuilds solids. */
import { localTopology, solveComponents, bodyPlacements, eulerDegrees, type SolveReport } from './assembly.ts';
import type { View, Placement } from './types.ts';
export function prepareDrag(view: View, componentId: string) {
 const component=view.document.components?.find(c=>c.id===componentId);
 if(!component||component.grounded)return;
 const needed=new Set((view.document.mates??[]).filter(m=>!m.suppressed).flatMap(m=>[m.moving.id,m.target.id]));
 for(const p of view.document.componentPatterns??[]){if(p.axisRef)needed.add(p.axisRef.id);if(p.directionRef)needed.add(p.directionRef.id);}
 const topology=localTopology({...view.geometry,bodies:view.geometry.bodies.map(b=>({...b,topology:b.topology.filter(t=>needed.has(t.id))}))});
 const initial=solveComponents(view.document,topology,{skipFreedomReport:true});
 const ids=view.geometry.bodies.map(b=>b.id);
 let previous=initial;
 return {initial, solve(desired:Placement){
   const doc={...view.document,components:view.document.components!.map(c=>c.id===componentId?{...c,position:desired.position,rotation:eulerDegrees(desired)}:c)};
   const report:SolveReport={mates:{},components:{}};
   const placed=solveComponents(doc,topology,{initial:{...initial,[componentId]:desired},anchor:[componentId],report,skipFreedomReport:true});
   if(Object.values(report.mates).every(m=>m.status==='ok'))previous=placed;
   return {components:previous,bodies:bodyPlacements(doc,previous,ids)};
 }};
}
