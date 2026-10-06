// Equations PropertyManager: global variables and the dimensions they drive.
// Every change commits at once through set_variable / delete_variable; an
// equation that cannot be satisfied is rejected and the row keeps its text.
import { useEffect, useState } from "react";
import { Check as CheckIcon, X } from "lucide-react";
import type { View } from "../../cad/types.ts";
import { Icons } from "../cad-icons.tsx";
import { formatMm } from "../sketch/model.ts";
import type { Cad } from "../state.ts";
import { paramLabels } from "./inspector.tsx";

/** A text cell that commits on Enter or blur and resets on Escape. */
function Cell({ value, label, placeholder, onCommit }: { value: string; label: string; placeholder?: string; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const text = draft.trim();
    if (text !== value) onCommit(text);
  };
  return (
    <input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function EquationsPanel({ cad, view, onClose }: { cad: Cad; view: View; onClose: () => void }) {
  const doc = view.document;
  const variables = doc.variables ?? [];
  const [name, setName] = useState(""),
    [expression, setExpression] = useState("");
  const add = async () => {
    if (!name.trim() || !expression.trim()) return;
    const result = await cad.run("set_variable", { name: name.trim(), expression: expression.trim() });
    if (result) {
      setName("");
      setExpression("");
    }
  };
  // Dimensions driven by equations, for review in one place.
  const driven = [
    ...doc.features.flatMap((f) =>
      Object.entries(f.expressions ?? {}).map(([key, expr]) => ({
        id: `${f.id}:${key}`,
        label: `${f.name} ${(paramLabels[f.type]?.[key]?.[0] ?? key).toLowerCase()}`,
        expr,
        value: f.params[key] as number,
      })),
    ),
    ...doc.sketches.flatMap((s) =>
      s.constraints.filter((c) => c.expression).map((c) => ({ id: c.id, label: `${s.name} ${c.type}`, expr: c.expression!, value: c.value ?? 0 })),
    ),
  ];
  return (
    <div className="property-manager equations" aria-label="Equations PropertyManager">
      <header>
        <Icons.equations size={18} />
        <strong>Equations</strong>
        <span className="pm-actions">
          <button className="pm-accept" aria-label="Close equations" title="Close (Enter)" onClick={onClose}>
            <CheckIcon size={18} />
          </button>
          <button className="pm-cancel" aria-label="Close equations" title="Close (Esc)" onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="pm-body">
        <section>
          <h3>Global variables</h3>
          <div className="equation-table" role="table" aria-label="Global variables">
            {variables.map((v) => (
              <div className="equation-row" role="row" key={v.name}>
                <Cell value={v.name} label={`Name of ${v.name}`} onCommit={(newName) => newName && void cad.run("set_variable", { name: v.name, newName })} />
                <span className="equals">=</span>
                <Cell value={v.expression} label={`Equation of ${v.name}`} onCommit={(expr) => expr && void cad.run("set_variable", { name: v.name, expression: expr })} />
                <span className="equation-value">{formatMm(v.value)}</span>
                <button className="equation-delete" aria-label={`Delete ${v.name}`} onClick={() => void cad.run("delete_variable", { name: v.name })}>
                  <X size={13} />
                </button>
              </div>
            ))}
            <div className="equation-row" role="row">
              <input aria-label="New variable name" placeholder="name" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && void add())} />
              <span className="equals">=</span>
              <input
                aria-label="New variable equation"
                placeholder="value or equation"
                value={expression}
                spellCheck={false}
                onChange={(e) => setExpression(e.target.value)}
                onBlur={() => void add()}
                onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && void add())}
              />
              <span className="equation-value" />
              <span />
            </div>
          </div>
        </section>
        {driven.length > 0 && (
          <section>
            <h3>Driven dimensions</h3>
            <div className="equation-table" role="table" aria-label="Driven dimensions">
              {driven.map((d) => (
                <div className="equation-row driven" role="row" key={d.id}>
                  <span className="equation-name">{d.label}</span>
                  <span className="equals">=</span>
                  <span className="equation-expr">{d.expr}</span>
                  <span className="equation-value">{formatMm(d.value)}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
