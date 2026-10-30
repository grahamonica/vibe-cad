// Motion Check PropertyManager: turn a weapon or arm through its travel (or
// slide a part) and see where it hits the rest of the robot and how close it gets.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check as CheckIcon, X } from "lucide-react";
import type { View } from "../../cad/types.ts";
import { allComponents, componentOwns } from "../../cad/types.ts";
import { Icons } from "../cad-icons.tsx";
import { NumberField, Segmented, SelectionBox } from "../ui.tsx";
import { formatLength, unitLabel } from "../units.ts";
import type { Cad } from "../state.ts";
import { pickLabel, type Highlight, type Pick } from "./dialogs.tsx";
import {prepareMotion,type MotionPreview} from '../../cad/motion-preview.ts';

interface MotionResult {
  kind: "rotate" | "translate";
  steps: { value: number; clearance: number | null; closest: string; interference: { with: string; volume: number; by?: string }[] }[];
  collides: boolean;
  collisions: { value: number; with: string[]; volume: number }[];
  minimumClearance: { value: number | null; at: number; with: string };
}
type AxisPick = Extract<Pick, { kind: "face" | "edge" }>;

export function MotionPanel({
  cad,
  view,
  initial,
  registerPicker,
  setHighlight,
  onClose,
  onPreview,
}: {
  cad: Cad;
  view: View;
  initial: Pick[];
  registerPicker: (h: ((p: Pick) => boolean) | null) => void;
  setHighlight: (h: Highlight | null) => void;
  onClose: () => void;
  onPreview:(preview:{spec:MotionPreview;phase:number}|null)=>void;
}) {
  const doc = view.document;
  const ownerOf = (p: Pick) => {
    const bodyId = p.kind === "body" ? p.id : p.kind === "face" || p.kind === "edge" ? p.ref.bodyId : undefined;
    return p.kind === "component" ? allComponents(doc).find((c) => c.id === p.id) : bodyId ? allComponents(doc).find((c) => componentOwns(c, bodyId)) : undefined;
  };
  const [componentId, setComponentId] = useState<string | undefined>(() => initial.map(ownerOf).find(Boolean)?.id??doc.components?.find(c=>(c.motion?.dof??0)>0&&!c.grounded)?.id),
    [axis, setAxis] = useState<AxisPick | null>(null),
    [kind, setKind] = useState<"rotate" | "translate">("rotate"),
    [to, setTo] = useState(360),
    [from,setFrom]=useState(0),
    [duration,setDuration]=useState(12),
    [cycleHours,setCycleHours]=useState(24),
    [phase,setPhase]=useState(0),
    [previewing,setPreviewing]=useState(false),
    [playing,setPlaying]=useState(false),
    [loop,setLoop]=useState(true),
    [steps, setSteps] = useState(36),
    [active, setActive] = useState<"component" | "axis">(componentId ? "axis" : "component"),
    [result, setResult] = useState<MotionResult | null>(null),
    [running, setRunning] = useState(false);
  const state = useRef({ active });
  const previewCallback=useRef(onPreview);previewCallback.current=onPreview;
  state.current = { active };
  const topology = useMemo(()=>view.geometry.bodies.flatMap((b) => b.topology),[view.geometry.bodies]);
  useEffect(() => {
    registerPicker((p) => {
      if (state.current.active === "component") {
        const c = ownerOf(p);
        if (!c) return false;
        setComponentId(c.id);
        setActive("axis");
        return true;
      }
      if (p.kind !== "face" && p.kind !== "edge") return false;
      const t = topology.find((x) => x.id === p.ref.id);
      if (!t?.axis) return false;
      setAxis(p);
      return true;
    });
    return () => registerPicker(null);
  }, [view]);
  const component = allComponents(doc).find((c) => c.id === componentId);
  const spec=useMemo(()=>{
    const t=axis&&topology.find(t=>t.id===axis.ref.id),selectedAxis=t&&(t.axis??(t.normal?{origin:t.center,direction:t.normal}:undefined));
    return {componentId:componentId??'',kind,from,to,playbackSeconds:duration,cycleHours,...(selectedAxis?{axis:selectedAxis}:{})};
  },[componentId,kind,from,to,duration,cycleHours,axis?.ref.id,topology]);
  const previewError=useMemo(()=>{if(!componentId)return '';try{prepareMotion(view,spec);return '';}catch(e){return (e as Error).message;}},[spec,view.document.revision,view.geometry.dependencyKey]);
  useEffect(() => {
    setHighlight(axis ? { refs: [axis.ref], planes: [] } : null);
    return () => setHighlight(null);
  }, [axis?.ref.id]);
  // Clearance booleans are explicit. Playback only solves cached mates/placements.
  const token = useRef(0);
  useEffect(() => {
    token.current++;setResult(null);setRunning(false);setPlaying(false);setPreviewing(false);
  }, [componentId, axis?.ref.id, kind, from, to, steps, doc.revision,view.geometry.dependencyKey]);
  useEffect(()=>{
    previewCallback.current(previewing&&componentId&&!previewError?{spec,phase}:null);
  },[previewing,spec,previewError,phase]);
  useEffect(()=>()=>previewCallback.current(null),[]);
  useEffect(()=>{
    if(!playing)return;
    let frame=0,prior=performance.now(),displayed=prior,cursor=phase;
    const tick=(now:number)=>{
      if(now-displayed>=50){const elapsed=(now-prior)/(Math.max(.5,duration)*1000);prior=now;displayed=now;cursor+=elapsed;if(cursor>=1&&!loop){setPhase(1);setPlaying(false);return;}cursor%=1;setPhase(cursor);}
      frame=requestAnimationFrame(tick);
    };frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[playing,duration,loop]);
  const checkClearance=()=>{
    if (!componentId||running) return;
    const mine = ++token.current;
    setRunning(true);
      const { point: _p, ...ref } = (axis?.ref ?? {}) as AxisPick["ref"] & { point?: unknown };
      void cad
        .execute<MotionResult>("check_motion", { componentId, kind, ...(axis ? { axis: { ref } } : {}), from, to, steps })
        .then((r) => mine === token.current && setResult(r))
        .catch((e) => {
          if (mine !== token.current) return;
          setResult(null);
          cad.setError((e as Error).message);
        })
        .finally(() => mine === token.current && setRunning(false));
  };
  const unit = kind === "rotate" ? "°" : ` ${unitLabel()}`,
    show = (v: number) => (kind === "rotate" ? `${Math.round(v * 10) / 10}°` : `${formatLength(v)}${unit}`);
  // Consecutive colliding steps read as one range.
  const ranges: { from: number; to: number; with: string[] }[] = [];
  for (const c of result?.collisions ?? []) {
    const last = ranges.at(-1),
      step = result!.steps.length > 1 ? Math.abs(result!.steps[1].value - result!.steps[0].value) : 0;
    if (last && Math.abs(c.value - last.to - step) < 1e-6) {
      last.to = c.value;
      last.with = [...new Set([...last.with, ...c.with])];
    } else ranges.push({ from: c.value, to: c.value, with: c.with });
  }
  return (
    <div className="property-manager motion" aria-label="Motion Check PropertyManager">
      <header>
        <Icons.motion size={18} />
        <strong>Motion</strong>
        <span className="pm-actions">
          <button className="pm-accept" aria-label="Close motion check" title="Close (Enter)" onClick={onClose}>
            <CheckIcon size={18} />
          </button>
          <button className="pm-cancel" aria-label="Close motion check" title="Close (Esc)" onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="pm-body">
        <SelectionBox
          label="Moving part"
          placeholder="Select the weapon, arm or part that moves"
          items={component ? [{ key: component.id, label: component.name }] : []}
          active={active === "component"}
          onActivate={() => setActive("component")}
          onRemove={() => setComponentId(undefined)}
        />
        <label>Component<select aria-label="Motion component" value={componentId??''} onChange={e=>setComponentId(e.target.value||undefined)}>
          <option value="">Select a component</option>{(doc.components??[]).filter(c=>!c.grounded&&!c.suppressed&&!c.belt).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <SelectionBox
          label="Axis"
          placeholder="Its concentric mate, or select a shaft face or circular edge"
          items={axis ? [{ key: axis.ref.id, label: pickLabel(view, axis) }] : []}
          active={active === "axis"}
          onActivate={() => setActive("axis")}
          onRemove={() => setAxis(null)}
        />
        <Segmented
          label="Motion"
          value={kind}
          options={[
            { value: "rotate", label: "Rotate" },
            { value: "translate", label: "Slide" },
          ]}
          onChange={(k) => {
            setKind(k);
            setTo(k === "rotate" ? 360 : 50);
          }}
        />
        <NumberField label="From" unit={kind === "rotate" ? "°" : "mm"} value={from} onChange={setFrom} />
        <NumberField label="To" unit={kind === "rotate" ? "°" : "mm"} value={to} onChange={setTo} />
        <NumberField label="Playback" unit="s" min={.5} max={120} value={duration} onChange={setDuration} />
        <NumberField label="Cycle time" unit="hours" min={.01} max={8760} value={cycleHours} onChange={setCycleHours} />
        <div className="motion-playback">
          <button className="primary" disabled={!componentId||component?.grounded||cad.busy||!!previewError} onClick={()=>{if(phase>=1)setPhase(0);setPreviewing(true);setPlaying(!playing);}}>{playing?'Pause':'Play'}</button>
          <button className="text-button" onClick={()=>{setPlaying(false);setPreviewing(false);setPhase(0);}}>Stop</button>
          <label><input type="checkbox" checked={loop} onChange={e=>setLoop(e.target.checked)}/> Loop</label>
          <input aria-label="Motion timeline" type="range" min="0" max="1" step="0.001" value={phase} disabled={!!previewError||!componentId||cad.busy} onChange={e=>{setPlaying(false);setPreviewing(true);setPhase(Number(e.target.value));}}/>
          <output aria-label="Cycle time elapsed">{Math.floor(phase*cycleHours).toString().padStart(2,'0')}:{Math.floor((phase*cycleHours%1)*60).toString().padStart(2,'0')}</output>
          <p className="muted">Preview only. Stop restores the saved position. Mates and travel limits remain active.</p>
          {previewError&&<p className="muted" role="status">{previewError}</p>}
        </div>
        <NumberField label="Steps" unit="" value={steps} min={1} max={360} integer onChange={setSteps} />
        <button className="text-button" disabled={!componentId||running||cad.busy} onClick={checkClearance}>Check clearance</button>
        {result && !running && (
          <section className="motion-result">
            {ranges.length ? (
              ranges.map((r, i) => (
                <div className="info-row error" key={i}>
                  <span>{r.with.map((w) => (w.includes(" hits ") ? w : `Hits ${w}`)).join(", ")}</span>
                  <b>{r.from === r.to ? show(r.from) : `${show(r.from)} – ${show(r.to)}`}</b>
                </div>
              ))
            ) : (
              <div className="info-row">
                <span>Collisions</span>
                <b>None</b>
              </div>
            )}
            {!result.collides && result.minimumClearance.value !== null && (
              <div className="info-row">
                <span>Closest to {result.minimumClearance.with}</span>
                <b>
                  {formatLength(result.minimumClearance.value)} {unitLabel()} at {show(result.minimumClearance.at)}
                </b>
              </div>
            )}
          </section>
        )}
        {running && componentId && <p className="muted">Checking…</p>}
      </div>
    </div>
  );
}
