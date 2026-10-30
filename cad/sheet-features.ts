import type { RenderBody, Vec2, Vec3 } from './types.ts';

export interface SheetFeature {
  kind: 'web' | 'gap';
  width: number;
  edgeIds: string[];
  points: [Vec3, Vec3];
  borderline: boolean;
}
export interface SheetFeatureReport {
  bodyId: string;
  status: 'review' | 'no-narrow-features-detected' | 'unsupported' | 'invalid';
  thickness?: number;
  materialRegions?: number;
  minimumWeb: number;
  minimumGap: number;
  uncertainty: number;
  sampled: number;
  totalFindings: number;
  findings: SheetFeature[];
  notes: string[];
}
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a: number[], b: number[]): Vec3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = (a: number[]) => a.map(v => v / Math.hypot(...a)) as Vec3;
const cross2 = (a: Vec2, b: Vec2) => a[0]*b[1]-a[1]*b[0];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0]-b[0], a[1]-b[1]];
type Segment = { a: Vec2; b: Vec2; edge: string; length: number };

/** Explicit, bounded DFM screening of a uniform planar extrusion's display edges.
 * This does not certify a true global minimum or replace a supplier's DFM check.
 */
export function checkSheetFeatures(body: RenderBody, minimumWeb: number, minimumGap: number, maxFindings=6): SheetFeatureReport {
  const report: SheetFeatureReport = { bodyId: body.id, status: 'unsupported', minimumWeb, minimumGap,
    uncertainty: 0.1, sampled: 0, totalFindings: 0, findings: [], notes: [] };
  const stop = (message: string) => { report.notes.push(message); return report; };
  if (![minimumWeb, minimumGap].every(v => Number.isFinite(v) && v >= 0.05 && v <= 100))
    throw Error('Minimum web and gap must be between 0.05 and 100 mm');
  if(!Number.isInteger(maxFindings)||maxFindings<1||maxFindings>40)throw Error('Return between 1 and 40 findings');
  if (!(body.volume > 1e-8)) { report.status = 'invalid'; return stop('Body has no positive solid volume.'); }
  const caps = body.topology.filter(t => t.kind === 'face' && t.geomType === 'PLANE' && t.normal && t.area)
    .sort((a,b) => b.area! - a.area!);
  if (!caps.length) return stop('A planar sheet face is required.');
  const face = caps[0], n = unit(face.normal!), u = unit(cross(Math.abs(n[2]) < 0.9 ? [0,0,1] : [0,1,0], n)), v = cross(n,u);
  const origin = face.center, level = dot(origin,n);
  const project = (p: Vec3): Vec2 => { const d = p.map((x,i) => x-origin[i]); return [dot(d,u),dot(d,v)]; };
  const world = (p: Vec2): Vec3 => origin.map((x,i) => x + u[i]*p[0] + v[i]*p[1]) as Vec3;
  let low = Infinity, high = -Infinity;
  for (let i=0;i<body.mesh.vertices.length;i+=3) {
    const z = dot(body.mesh.vertices.slice(i,i+3),n); low=Math.min(low,z);high=Math.max(high,z);
  }
  const thickness = high-low;
  if (!(thickness > 1e-6) || Math.min(Math.abs(level-low),Math.abs(level-high)) > 0.001 ||
      Math.abs(body.volume-face.area!*thickness) > Math.max(0.01,body.volume*0.001) ||
      !caps.some(t => dot(unit(t.normal!),n)<-0.999999 && Math.abs(t.area!-face.area!)/face.area!<0.001))
    return stop('Only constant-thickness planar extrusions are supported; use a separate check for bends, chamfers or variable walls.');
  report.thickness = thickness;
  const segments: Segment[] = [], seen = new Set<string>();
  const key = (p: Vec2) => p.map(x => Math.round(x*1e5)).join(',');
  const endpoints = new Map<string, string[]>();
  for (const t of body.topology) if (t.kind==='edge' && t.endpoints)
    endpoints.set(t.id,t.endpoints.map(p=>key(project(p))));
  const boundaryTolerance = Math.max(1e-4,thickness*1e-4);
  for (const group of body.edges.edgeGroups) for (let i=group.start;i+1<group.start+group.count;i+=2) {
    const a3 = body.edges.lines.slice(i*3,i*3+3) as Vec3, b3 = body.edges.lines.slice(i*3+3,i*3+6) as Vec3;
    if (Math.abs(dot(a3,n)-level)>boundaryTolerance || Math.abs(dot(b3,n)-level)>boundaryTolerance) continue;
    const a=project(a3),b=project(b3),length=Math.hypot(...sub(b,a)), id=[key(a),key(b)].sort().join('/');
    if (length<1e-7 || seen.has(id)) continue;
    seen.add(id);segments.push({a,b,length,edge:group.id});
  }
  if (segments.length<3 || segments.length>25000) return stop('Boundary sampling is empty or exceeds the 25,000 segment analysis budget.');
  const links=new Map<string,{index:number;other:string}[]>(),positions=new Map<string,Vec2>();
  segments.forEach((s,index)=>{const a=key(s.a),b=key(s.b);positions.set(a,s.a);positions.set(b,s.b);
    links.set(a,[...(links.get(a)??[]),{index,other:b}]);links.set(b,[...(links.get(b)??[]),{index,other:a}]);});
  if([...links.values()].some(edges=>edges.length!==2))return stop('Sampled sheet boundary is open or non-manifold; no passing result is issued.');
  const loops:Vec2[][]=[],visited=new Set<number>();
  for(let i=0;i<segments.length;i++)if(!visited.has(i)){
    const loop:Vec2[]=[],start=key(segments[i].a);let cursor=start;
    do{loop.push(positions.get(cursor)!);const edge=links.get(cursor)!.find(e=>!visited.has(e.index));if(!edge)return stop('Could not trace a closed sheet boundary.');visited.add(edge.index);cursor=edge.other;}while(cursor!==start);
    loops.push(loop);
  }
  const insideLoop=(p:Vec2,loop:Vec2[])=>{let odd=false;for(let i=0;i<loop.length;i++){const a=loop[i],b=loop[(i+1)%loop.length];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])odd=!odd;}return odd;};
  report.materialRegions=loops.filter((loop,i)=>loops.filter((other,j)=>i!==j&&insideLoop(loop[0],other)).length%2===0).length;
  const inside = (p: Vec2) => {
    let odd=false;
    for (const {a,b} of segments) if ((a[1]>p[1]) !== (b[1]>p[1]) &&
      p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) odd=!odd;
    return odd;
  };
  // A cell index bounds the ray search; no OCCT projection, boolean or kernel
  // allocation is needed after the current model has loaded.
  const reach=Math.max(minimumWeb,minimumGap)+report.uncertainty, cells=new Map<string,Set<number>>();
  let entries=0;
  const cellKey=(x:number,y:number)=>`${x},${y}`;
  for (let i=0;i<segments.length;i++) {
    const s=segments[i],steps=Math.ceil(s.length/reach);
    for(let j=0;j<steps;j++) {
      const a=s.a.map((x,k)=>x+(s.b[k]-x)*j/steps),b=s.a.map((x,k)=>x+(s.b[k]-x)*(j+1)/steps);
      for(let x=Math.floor(Math.min(a[0],b[0])/reach);x<=Math.floor(Math.max(a[0],b[0])/reach);x++)
        for(let y=Math.floor(Math.min(a[1],b[1])/reach);y<=Math.floor(Math.max(a[1],b[1])/reach);y++) {
          const k=cellKey(x,y);let set=cells.get(k);if(!set)cells.set(k,set=new Set());
          if(!set.has(i)){set.add(i);if(++entries>250000)return stop('Spatial index exceeds the analysis budget.');}
        }
    }
  }
  const step=Math.min(minimumWeb,minimumGap)/2, samples=segments.reduce((sum,s)=>sum+Math.ceil(s.length/step),0);
  if(samples>25000)return stop('Boundary sampling exceeds 25,000 samples; check a smaller body or use larger feature limits.');
  const findings=new Map<string,SheetFeature>();
  let comparisons=0;
  for(let index=0;index<segments.length;index++) {
    const s=segments[index], delta=sub(s.b,s.a),normal:Vec2=[-delta[1]/s.length,delta[0]/s.length],count=Math.ceil(s.length/step);
    for(let j=0;j<count;j++) {
      const f=(j+0.5)/count,p:Vec2=[s.a[0]+delta[0]*f,s.a[1]+delta[1]*f];report.sampled++;
      const candidates=new Set<number>();
      const cx=Math.floor(p[0]/reach),cy=Math.floor(p[1]/reach);
      for(let x=cx-1;x<=cx+1;x++)for(let y=cy-1;y<=cy+1;y++)for(const id of cells.get(cellKey(x,y))??[])candidates.add(id);
      for(const sign of [-1,1]) {
        const direction:Vec2=[normal[0]*sign,normal[1]*sign];let best=reach,hit:Segment|undefined;
        for(const id of candidates) {
          if(id===index)continue;
          if(++comparisons>5000000)return stop('Ray analysis reached its work budget; results are incomplete.');
          const t=segments[id],d=sub(t.b,t.a),den=cross2(direction,d);if(Math.abs(den)<1e-10)continue;
          const offset=sub(t.a,p),distance=cross2(offset,d)/den,along=cross2(offset,direction)/den;
          if(distance>1e-5 && distance<best && along>=-1e-7 && along<=1+1e-7){best=distance;hit=t;}
        }
        if(!hit)continue;
        // A short ray into an angled corner is not a wall/slot thickness.
        // Require opposing boundary tangents within 45 degrees, and never
        // look through a nearer corner for a more convenient second hit.
        const hitDirection=sub(hit.b,hit.a);
        if(Math.abs(dot(delta,hitDirection))/(s.length*hit.length)<Math.SQRT1_2)continue;
        // Incident edges converge at ordinary sharp tips: do not report these
        // as zero-width necks or skip past them to a more distant boundary.
        if(s.edge!==hit.edge && endpoints.get(s.edge)?.some(k=>endpoints.get(hit!.edge)?.includes(k)))continue;
        const q:Vec2=[p[0]+direction[0]*best,p[1]+direction[1]*best];
        const kind=inside([(p[0]+q[0])/2,(p[1]+q[1])/2])?'web':'gap',limit=kind==='web'?minimumWeb:minimumGap;
        if(best>=limit+report.uncertainty)continue;
        const edgeIds=[s.edge,hit.edge].sort(),id=kind+edgeIds.join('/'),prior=findings.get(id);
        if(!prior || best<prior.width)findings.set(id,{kind,width:best,edgeIds:[...new Set(edgeIds)],points:[world(p),world(q)],borderline:best>=limit-report.uncertainty});
      }
    }
  }
  report.totalFindings=findings.size;
  report.findings=[...findings.values()].sort((a,b)=>a.width-b.width).slice(0,maxFindings);
  report.status=findings.size||report.materialRegions!==1?'review':'no-narrow-features-detected';
  if(report.materialRegions!==1)report.notes.push(`${report.materialRegions} disconnected material regions detected; review islands or add deliberate bridges before cutting.`);
  report.notes.push('Sampled normal-ray widths from tessellated boundaries; uncertainty about ±0.10 mm. This is not a certified global minimum.',
    'Incident-edge tips and grazing/angled junctions are excluded. Curved cusps, features between samples and imported topology require separate review. Zero-volume native features are rejected by the kernel.',
    'Use the cutting supplier limits for the actual stock, kerf and finish.');
  if(findings.size>maxFindings)report.notes.push(`Showing the narrowest ${maxFindings} of ${findings.size} edge-pair findings.`);
  return report;
}
