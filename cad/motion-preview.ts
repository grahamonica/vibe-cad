import { Quaternion, Vector3 } from 'three';
import { prepareDrag } from './drag-motion.ts';
import { componentOwns } from './types.ts';
import type { View,Vec3 } from './types.ts';
export interface MotionPreview {
  componentId:string;
  kind:'rotate'|'translate';
  from:number;
  to:number;
  axis?:{origin:Vec3;direction:Vec3};
  playbackSeconds:number;
  cycleHours:number;
}
/** Preview a rigid mechanism on cached topology. No kernel, document write or meshing. */
export function prepareMotion(view:View,spec:MotionPreview) {
  const drag=prepareDrag(view,spec.componentId);
  if(!drag)throw Error('Choose a movable component');
  if(view.document.components?.some(c=>c.belt)||view.document.sketches.some(s=>s.support||s.entities.some(e=>e.projected)))throw Error('This mechanism has geometry that changes shape. Use the explicit geometry/motion check for those dependencies.');
  if(Object.values(view.geometry.mateStatus??{}).some(m=>m.status==='error'||m.status==='over'))throw Error('Resolve existing mate conflicts before starting playback.');
  const component=view.document.components!.find(c=>c.id===spec.componentId)!;
  const topology=view.geometry.bodies.flatMap(b=>b.topology);
  const mate=view.document.mates?.find(m=>!m.suppressed&&(m.type==='concentric'||m.type==='limitDistance')&&componentOwns(component,m.moving.bodyId));
  const t=mate&&topology.find(t=>t.id===mate.moving.id);
  const axis=spec.axis??(t?.axis?{origin:t.axis.origin,direction:t.axis.direction}:t?.normal?{origin:t.center,direction:t.normal}:{origin:drag.initial[spec.componentId].position,direction:spec.kind==='rotate'?[0,0,1] as Vec3:[1,0,0] as Vec3});
  const direction=new Vector3(...axis.direction).normalize(),origin=new Vector3(...axis.origin),initial=drag.initial[spec.componentId];
  if(direction.lengthSq()<.5)throw Error('Motion axis must be nonzero');
  return {spec,at(phase:number){
    const amount=spec.from+(spec.to-spec.from)*Math.max(0,Math.min(1,phase));
    if(spec.kind==='translate')return drag.solve({position:new Vector3(...initial.position).addScaledVector(direction,amount).toArray() as Vec3,quaternion:initial.quaternion});
    const delta=new Quaternion().setFromAxisAngle(direction,amount*Math.PI/180);
    return drag.solve({position:new Vector3(...initial.position).sub(origin).applyQuaternion(delta).add(origin).toArray() as Vec3,quaternion:delta.multiply(new Quaternion(...initial.quaternion)).toArray()});
  }};
}
