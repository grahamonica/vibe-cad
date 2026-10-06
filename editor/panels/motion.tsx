// Motion Check PropertyManager: turn a weapon or arm through its travel (or
// slide a part) and see where it hits the rest of the robot and how close it gets.
import { useEffect, useRef, useState } from "react";
import { Check as CheckIcon, X } from "lucide-react";
import type { View } from "../../cad/types.ts";
import { allComponents, componentOwns } from "../../cad/types.ts";
import { Icons } from "../cad-icons.tsx";
import { NumberField, Segmented, SelectionBox } from "../ui.tsx";
import { formatLength, unitLabel } from "../units.ts";
import type { Cad } from "../state.ts";
import { pickLabel, type Highlight, type Pick } from "./dialogs.tsx";

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
}: {
  cad: Cad;
  view: View;
  initial: Pick[];
  registerPicker: (h: ((p: Pick) => boolean) | null) => void;
  setHighlight: (h: Highlight | null) => void;
  onClose: () => void;
}) {
  const doc = view.document;
  const ownerOf = (p: Pick) => {
    const bodyId = p.kind === "body" ? p.id : p.kind === "face" || p.kind === "edge" ? p.ref.bodyId : undefined;
    return p.kind === "component" ? allComponents(doc).find((c) => c.id === p.id) : bodyId ? allComponents(doc).find((c) => componentOwns(c, bodyId)) : undefined;
  };
  const [componentId, setComponentId] = useState<string | undefined>(() => initial.map(ownerOf).find(Boolean)?.id),
    [axis, setAxis] = useState<AxisPick | null>(null),
    [kind, setKind] = useState<"rotate" | "translate">("rotate"),
    [to, setTo] = useState(360),
    [steps, setSteps] = useState(36),
    [active, setActive] = useState<"component" | "axis">(componentId ? "axis" : "component"),
    [result, setResult] = useState<MotionResult | null>(null),
    [running, setRunning] = useState(false);
  const state = useRef({ active });
  state.current = { active };
  const topology = view.geometry.bodies.flatMap((b) => b.topology);
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
  useEffect(() => {
    setHighlight(axis ? { refs: [axis.ref], planes: [] } : null);
    return () => setHighlight(null);
  }, [axis?.ref.id]);
  // Re-check shortly after any change; a newer request replaces an older one.
  const token = useRef(0);
  useEffect(() => {
    if (!componentId) return;
    const mine = ++token.current;
    setRunning(true);
    const timer = setTimeout(() => {
      const { point: _p, ...ref } = (axis?.ref ?? {}) as AxisPick["ref"] & { point?: unknown };
      void cad
        .execute<MotionResult>("check_motion", { componentId, kind, ...(axis ? { axis: { ref } } : {}), from: 0, to, steps })
        .then((r) => mine === token.current && setResult(r))
        .catch((e) => {
          if (mine !== token.current) return;
          setResult(null);
          cad.setError((e as Error).message);
        })
        .finally(() => mine === token.current && setRunning(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [componentId, axis?.ref.id, kind, to, steps, doc.revision]);
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
        <strong>Motion Check</strong>
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
        <NumberField label={kind === "rotate" ? "Through" : "Distance"} unit={kind === "rotate" ? "°" : "mm"} value={to} onChange={setTo} />
        <NumberField label="Steps" unit="" value={steps} min={1} max={360} integer onChange={setSteps} />
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
