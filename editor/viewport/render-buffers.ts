// CPU display-buffer preparation. Callers own and dispose returned geometries.
// Keep source buffers shared; none of these functions constructs a renderer.
import * as THREE from 'three';
import type { RenderBody } from '../../cad/types.ts';

export function meshGeometry(body: RenderBody) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(body.mesh.vertices instanceof Float32Array ? body.mesh.vertices : new Float32Array(body.mesh.vertices), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(body.mesh.normals instanceof Float32Array ? body.mesh.normals : new Float32Array(body.mesh.normals), 3));
  geo.setIndex(new THREE.BufferAttribute(body.mesh.triangles instanceof Uint32Array ? body.mesh.triangles : new Uint32Array(body.mesh.triangles), 1));
  return geo;
}

export function boxMapped(indexed: THREE.BufferGeometry, body: RenderBody, tile: number) {
  const p = indexed.getAttribute("position"), n = indexed.getAttribute('normal'), index = indexed.index!;
  const axes = new Uint8Array(index.count/3), masks = new Uint8Array(p.count);
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3();
  for(let i=0;i<index.count;i+=3){
    a.fromBufferAttribute(p,index.getX(i));b.fromBufferAttribute(p,index.getX(i+1));c.fromBufferAttribute(p,index.getX(i+2));
    const normal=b.sub(a).cross(c.sub(a)),ax=Math.abs(normal.x),ay=Math.abs(normal.y),az=Math.abs(normal.z);
    const axis=az>=ax&&az>=ay?0:ay>=ax?1:2; axes[i/3]=axis;
    for(let k=0;k<3;k++)masks[index.getX(i+k)]|=1<<axis;
  }
  let extra=0;
  for(const mask of masks)extra+=Math.max(0,(mask&1)+((mask>>1)&1)+((mask>>2)&1)-1);
  const count=p.count+extra,uv=new Float32Array(count*2),[x0,y0,z0]=body.bounds[0];
  const project=(target:number,source:number,axis:number)=>{
    const x=p.getX(source)-x0,y=p.getY(source)-y0,z=p.getZ(source)-z0;
    uv[target*2]=(axis===2?y:x)/tile;uv[target*2+1]=(axis===0?y:z)/tile;
  };
  if(!extra){
    for(let i=0;i<p.count;i++)project(i,i,masks[i]&1?0:masks[i]&2?1:2);
    indexed.setAttribute('uv',new THREE.BufferAttribute(uv,2));return indexed;
  }
  // Preserve indexing, splitting a vertex only where its projection changes.
  const positions=new Float32Array(count*3),normals=new Float32Array(count*3),triangles=new Uint32Array(index.count);
  positions.set(p.array);normals.set(n.array);
  const slots=new Uint32Array(p.count*3),used=new Uint8Array(p.count);
  let next=p.count;
  for(let i=0;i<index.count;i++){
    const source=index.getX(i),axis=axes[Math.floor(i/3)],slot=source*3+axis;
    let target=slots[slot]-1;
    if(target<0){
      target=used[source]?next++:source;used[source]=1;slots[slot]=target+1;
      if(target!==source)for(let k=0;k<3;k++){positions[target*3+k]=p.array[source*3+k];normals[target*3+k]=n.array[source*3+k];}
      project(target,source,axis);
    }
    triangles[i]=target;
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(positions,3));geo.setAttribute('normal',new THREE.BufferAttribute(normals,3));
  geo.setAttribute('uv',new THREE.BufferAttribute(uv,2));geo.setIndex(new THREE.BufferAttribute(triangles,1));
  for(const group of indexed.groups)geo.addGroup(group.start,group.count,group.materialIndex);
  indexed.dispose();
  return geo;
}

export function outlineCandidates(body: RenderBody): { vertices: Uint32Array; normals: Float32Array } {
  const curved = new Set(body.topology.filter((t) => t.kind === "face" && t.geomType !== "PLANE").map((t) => t.id));
  const v = body.mesh.vertices,
    tri = body.mesh.triangles,
    vertices: number[] = [], normals: number[] = [];
  const key = (i: number) => `${Math.round(v[i * 3] * 1e5)},${Math.round(v[i * 3 + 1] * 1e5)},${Math.round(v[i * 3 + 2] * 1e5)}`;
  for (const g of body.mesh.faceGroups) {
    if (!curved.has(g.id)) continue;
    const weld = new Map<string, number>(),
      id = (i: number) => {
        const k = key(i);
        if (!weld.has(k)) weld.set(k, i);
        return weld.get(k)!;
      };
    const normal = (t: number) => {
      const [a, b, c] = [tri[t], tri[t + 1], tri[t + 2]].map((i) => new THREE.Vector3(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]));
      return b.sub(a).cross(c.sub(a)).normalize();
    };
    const shared = new Map<string, { a: number; b: number; tris: number[] }>();
    for (let t = g.start; t < g.start + g.count; t += 3)
      for (const [p, q] of [
        [tri[t], tri[t + 1]],
        [tri[t + 1], tri[t + 2]],
        [tri[t + 2], tri[t]],
      ]) {
        const a = id(p),
          b = id(q),
          k = a < b ? `${a}|${b}` : `${b}|${a}`;
        const e = shared.get(k) ?? { a: p, b: q, tris: [] };
        e.tris.push(t);
        shared.set(k, e);
      }
    for (const e of shared.values()) {
      if (e.tris.length !== 2) continue;
      const n1 = normal(e.tris[0]),
        n2 = normal(e.tris[1]);
      if (n1.dot(n2) > 0.99999) continue;
      vertices.push(e.a,e.b);
      normals.push(n1.x,n1.y,n1.z,n2.x,n2.y,n2.z);
    }
  }
  return {vertices:new Uint32Array(vertices),normals:new Float32Array(normals)};
}
