import {componentOf,type ComponentInstance,type View} from './types.ts';
/** Find the driving part of a rigid cluster, without adding or suppressing mates. */
export function rigidDragDriver(view:View,componentId:string):ComponentInstance|undefined{
 const doc=view.document,topology=new Map(view.geometry.bodies.flatMap(b=>b.topology).map(t=>[t.id,t]));
 const mates=(doc.mates??[]).filter(m=>!m.suppressed),seen=new Set<string>();
 let current=doc.components?.find(c=>c.id===componentId);
 while(current&&!seen.has(current.id)){
  seen.add(current.id);const child=current;
  const parentMate=mates.find(m=>{
   if(componentOf(doc,m.moving.bodyId)?.id!==child.id)return false;
   if(m.type==='lock')return true;
   if(m.type!=='gear'||m.value!==1||!m.aligned)return false;
   const parent=componentOf(doc,m.target.bodyId)?.id;
   const paired=mates.filter(n=>componentOf(doc,n.moving.bodyId)?.id===child.id&&componentOf(doc,n.target.bodyId)?.id===parent);
   const joint=paired.find(n=>n.type==='concentric'),axis=joint&&topology.get(joint.moving.id)?.axis?.direction;
   if(!axis)return false;
   return paired.some(n=>{const normal=topology.get(n.moving.id)?.normal;return (n.type==='distance'||n.type==='coincident')&&normal&&Math.abs(axis.reduce((sum,x,i)=>sum+x*normal[i],0))>.999999;});
  });
  if(!parentMate)break;
  const parent=componentOf(doc,parentMate.target.bodyId);if(!parent||seen.has(parent.id))break;current=parent;
 }
 return current;
}
