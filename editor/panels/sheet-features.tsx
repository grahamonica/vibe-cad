import { useEffect, useRef, useState } from 'react';
import { X, Ruler } from 'lucide-react';
import type { View } from '../../cad/types.ts';
import type { SheetFeatureReport } from '../../cad/sheet-features.ts';
import type { Cad } from '../state.ts';
import type { Highlight } from './dialogs.tsx';
import { NumberField } from '../ui.tsx';

export function SheetFeaturesPanel({cad,view,setHighlight,onClose}:{cad:Cad;view:View;setHighlight:(h:Highlight|null)=>void;onClose:()=>void}) {
  const bodies=view.geometry.bodies.filter(b=>!b.hidden);
  const [bodyId,setBodyId]=useState(bodies[0]?.id??''),[web,setWeb]=useState(1.6),[gap,setGap]=useState(1.6),
    [result,setResult]=useState<SheetFeatureReport|null>(null),[busy,setBusy]=useState(false);
  const generation=useRef(0);
  useEffect(()=>{generation.current++;setResult(null);setBusy(false);setHighlight(null);},[bodyId,web,gap,view.document.revision,view.geometry.dependencyKey]);
  useEffect(()=>()=>{generation.current++;setHighlight(null);},[]);
  async function check() {
    const token=++generation.current;setBusy(true);setResult(null);
    try {const r=await cad.execute<SheetFeatureReport>('check_sheet_features',{bodyId,minimumWeb:web,minimumGap:gap,maxFindings:40});if(generation.current===token)setResult(r);}
    catch(e){if(generation.current===token)cad.setError((e as Error).message);}
    finally{if(generation.current===token)setBusy(false);}
  }
  return <div className="property-manager" aria-label="Minimum Features PropertyManager">
    <header><Ruler size={18}/><strong>Minimum Features</strong><span className="pm-actions"><button aria-label="Close minimum features" onClick={onClose}><X size={18}/></button></span></header>
    <div className="pm-body">
      <label className="field-stack">Sheet body<select aria-label="Sheet body" value={bodyId} onChange={e=>setBodyId(e.target.value)}>{bodies.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <NumberField label="Minimum web" unit="mm" value={web} min={0.05} step={0.1} onChange={setWeb}/>
      <NumberField label="Minimum cut gap" unit="mm" value={gap} min={0.05} step={0.1} onChange={setGap}/>
      <button className="primary" disabled={busy||!bodyId} onClick={()=>void check()}>{busy?'Checking…':'Check sheet'}</button>
      <p>Use the supplier limits for the selected sheet and cutting process.</p>
      {result&&<section aria-live="polite">
        {result.thickness!==undefined&&<div className="info-row"><span>Sheet thickness</span><b>{result.thickness.toFixed(3)} mm</b></div>}
        {result.materialRegions!==undefined&&<div className="info-row"><span>Connected pieces</span><b>{result.materialRegions}</b></div>}
        <p>{result.status==='no-narrow-features-detected'?'No narrow features detected in sampled locations.':result.status==='review'?`${result.totalFindings} narrow or borderline edge pairs to review.`:result.status==='invalid'?'Invalid solid.':'This body could not be fully screened.'}</p>
        {result.findings.map((f,i)=><button className="text-button" style={{display:'block',marginBottom:8}} key={i} onClick={()=>setHighlight({planes:[],refs:f.edgeIds.map(id=>({bodyId,id,kind:'edge'}))})}>{f.kind==='web'?'Web':'Cut gap'}: {f.width.toFixed(3)} mm{f.borderline?' (borderline)':''}</button>)}
        {result.notes.map((note,i)=><p key={i}>{note}</p>)}
      </section>}
    </div>
  </div>;
}
