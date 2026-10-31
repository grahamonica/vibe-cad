import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSheetFeatures } from '../cad/sheet-features.ts';
import type { RenderBody,Vec2,Vec3 } from '../cad/types.ts';

const rectangle=(x:number,y:number,w:number,h:number):Vec2[]=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
function plate(loops:Vec2[][]):RenderBody {
  const area=(p:Vec2[])=>Math.abs(p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-a[1]*b[0];},0))/2;
  const net=area(loops[0])-loops.slice(1).reduce((s,p)=>s+area(p),0),t=1.6;
  const body={id:'sheet',name:'sheet',volume:net*t,mesh:{vertices:[0,0,0,20,10,t]},
    edges:{lines:[],edgeGroups:[]},topology:[
      {id:'top',kind:'face',geomType:'PLANE',center:[0,0,t],normal:[0,0,1],area:net},
      {id:'bottom',kind:'face',geomType:'PLANE',center:[0,0,0],normal:[0,0,-1],area:net},
    ]} as unknown as RenderBody;
  loops.forEach((loop,k)=>loop.forEach((a,i)=>{
    const b=loop[(i+1)%loop.length],id=`loop${k}-edge${i}`,ends:[Vec3,Vec3]=[[...a,t],[...b,t]];
    body.edges.edgeGroups.push({id,edgeId:body.edges.edgeGroups.length,start:body.edges.lines.length/3,count:2});
    body.edges.lines=[...body.edges.lines,...ends[0],...ends[1]];body.topology.push({id,bodyId:body.id,kind:'edge',geomType:'LINE',center:[(a[0]+b[0])/2,(a[1]+b[1])/2,t],signature:[],label:id,endpoints:ends});
  }));return body;
}
test('sheet screening distinguishes narrow material webs from cut gaps and excludes ordinary tips',()=>{
  const web=checkSheetFeatures(plate([rectangle(0,0,20,10),rectangle(1,1,18,8)]),1.6,1.6);
  assert.equal(web.status,'review');assert.ok(web.findings.some(f=>f.kind==='web'&&Math.abs(f.width-1)<1e-8));
  assert.ok(!web.findings.some(f=>f.kind==='gap'));
  const slot=checkSheetFeatures(plate([rectangle(0,0,20,10),rectangle(2,4.7,16,0.6)]),1.6,1.6);
  assert.ok(slot.findings.some(f=>f.kind==='gap'&&Math.abs(f.width-0.6)<1e-8));
  assert.ok(!slot.findings.some(f=>f.kind==='web'));
  assert.equal(checkSheetFeatures(plate([rectangle(0,0,20,10)]),1.6,1.6).status,'no-narrow-features-detected');
  const circle=Array.from({length:32},(_,i):Vec2=>[10+0.5*Math.cos(i*Math.PI/16),5+0.5*Math.sin(i*Math.PI/16)]);
  assert.ok(checkSheetFeatures(plate([rectangle(0,0,20,10),circle]),1.6,1.6).findings.some(f=>f.kind==='gap'&&f.width<1.01));
});
test('unsupported or zero-volume geometry is never reported as passing; screening preserves inputs',()=>{
  const body=plate([rectangle(0,0,20,10)]),before=structuredClone(body);
  checkSheetFeatures(body,1.6,1.6);assert.deepEqual(body,before);
  body.volume=0;assert.equal(checkSheetFeatures(body,1.6,1.6).status,'invalid');
  body.volume=100;assert.equal(checkSheetFeatures(body,1.6,1.6).status,'unsupported');
});
