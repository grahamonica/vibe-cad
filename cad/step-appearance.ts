import * as r from 'replicad';

/** AP214/AP242 surface styles, resolved to actual imported topology rather than a guessed palette. */
export async function importColoredStep(bytes: Uint8Array) {
  const oc=r.getOC() as any, path=`/vibe-import-${crypto.randomUUID()}.step`;
  const reader=new oc.STEPControl_Reader();
  const entities=new Map<number,{type:string;args:string}>();
  const text=new TextDecoder().decode(bytes).replace(/\/\*[\s\S]*?\*\//g,'');
  for(const record of text.matchAll(/#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(((?:'(?:[^']|'')*'|[^';])*)\)\s*;/g))
    entities.set(Number(record[1]),{type:record[2],args:record[3]});
  const refs=(args:string)=>[...args.replace(/'(?:[^']|'')*'/g,"''").matchAll(/#(\d+)/g)].map(m=>Number(m[1]));
  const color=(id:number,seen=new Set<number>()):string|undefined=>{
    if(seen.has(id)||seen.size>64)return; seen.add(id);
    const entity=entities.get(id); if(!entity)return;
    if(entity.type==='COLOUR_RGB') {
      const values=entity.args.replace(/^'(?:[^']|'')*'\s*,/,'').split(',').map(Number);
      if(values.length===3&&values.every(n=>Number.isFinite(n)&&n>=0&&n<=1))
        return '#'+values.map(n=>Math.round(n*255).toString(16).padStart(2,'0')).join('').toUpperCase();
    }
    if(!/^(PRESENTATION_STYLE_ASSIGNMENT|SURFACE_STYLE_USAGE|SURFACE_SIDE_STYLE|SURFACE_STYLE_FILL_AREA|FILL_AREA_STYLE|FILL_AREA_STYLE_COLOUR|SURFACE_STYLE_RENDERING|SURFACE_STYLE_RENDERING_WITH_PROPERTIES)$/.test(entity.type))return;
    for(const ref of refs(entity.args)){const found=color(ref,seen);if(found)return found;}
  };
  const styles=[...entities].flatMap(([_,e])=>{
    if(e.type!=='STYLED_ITEM')return [];
    const ids=refs(e.args),target=ids.pop();if(target===undefined)return [];
    const c=ids.map(id=>color(id)).find(Boolean);return c?[{target,color:c}]:[];
  }).sort((a,b)=>Number(entities.get(a.target)?.type==='ADVANCED_FACE')-Number(entities.get(b.target)?.type==='ADVANCED_FACE'));
  let shape:r.AnyShape|undefined;
  try {
    oc.FS.writeFile(path,bytes);
    if(reader.ReadFile(path).value!==oc.IFSelect_ReturnStatus.IFSelect_RetDone.value) throw Error('The file could not be read as STEP');
    reader.TransferRoots();shape=r.cast(reader.OneShape());
    const faceColors=new Map<number,string>();
    if(styles.length) {
      const model=reader.Model(),targets=new Set(styles.map(s=>s.target)),indices=new Map<number,number>();
      for(let i=1;i<=model.NbEntities();i++) {
        const entity=model.Entity(i);const id=model.IdentLabel(entity);if(targets.has(id))indices.set(id,i);entity.delete();
      }
      for(const style of styles) {
        const index=indices.get(style.target);if(!index)continue;
        const entity=model.Entity(index);
        try {
          if(!reader.TransferEntity(entity))continue;
          const item=r.cast(reader.Shape(reader.NbShapes()));
          try {for(const face of item instanceof r.Face ? [item] : item.faces)faceColors.set(face.hashCode,style.color);}finally{item.delete();}
        } finally {entity.delete();}
      }
      model.delete();
    }
    return {shape,faceColors};
  } catch(error) {shape?.delete();throw error;}
  finally {reader.delete();try{oc.FS.unlink(path);}catch{}}
}
