// Mass Properties PropertyManager: the robot's weight against its class,
// center of gravity, each part's share, and a spinning weapon's numbers.
import { useEffect, useState } from "react";
import { Check as CheckIcon, X } from "lucide-react";
import type { Vec3, View } from "../../cad/types.ts";
import { allComponents, componentOwns } from "../../cad/types.ts";
import { Icons } from "../cad-icons.tsx";
import { NumberField, SelectionBox } from "../ui.tsx";
import { formatLength as length, unitLabel } from "../units.ts";
import type { Cad } from "../state.ts";
import { pickLabel, type Highlight, type Pick } from "./dialogs.tsx";

interface MassResult {
  mass: number;
  centerOfMass: Vec3;
  inertia: { tensor: number[]; principal: Vec3 };
  items: { bodyId: string; name: string; mass: number; source: string }[];
  missing: string[];
  weightLimit?: number;
  remaining?: number;
  spin?: { rpm: number; inertia: number; offset: number; radius: number; energy: number; tipSpeed: number; imbalanceForce: number };
}
const LB = 453.59237;
const round = (n: number, digits = 1) => n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

function Row({ label, value, tone }: { label: string; value: string; tone?: "error" }) {
  return (
    <div className={`info-row ${tone ?? ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function MassPanel({
  cad,
  view,
  registerPicker,
  setHighlight,
  onClose,
}: {
  cad: Cad;
  view: View;
  registerPicker: (h: ((p: Pick) => boolean) | null) => void;
  setHighlight: (h: Highlight | null) => void;
  onClose: () => void;
}) {
  const doc = view.document,
    inch = doc.units === "in";
  // Weights read in pounds in an inch document, as combat robot classes are.
  const weight = (g: number) => (inch ? `${round(g / LB, 2)} lb` : `${round(g, g < 100 ? 1 : 0)} g`);
  const [result, setResult] = useState<MassResult | null>(null),
    [weapon, setWeapon] = useState<MassResult | null>(null),
    [axis, setAxis] = useState<Extract<Pick, { kind: "face" | "edge" }> | null>(null),
    [rpm, setRpm] = useState(10000),
    [active, setActive] = useState(false);
  const topology = view.geometry.bodies.flatMap((b) => b.topology);
  useEffect(() => {
    void cad
      .execute<MassResult>("mass_properties", {})
      .then(setResult)
      .catch((e) => cad.setError((e as Error).message));
  }, [doc.revision, doc.id]);
  // The weapon is the component (or body) that carries the picked axis.
  const owner = axis ? allComponents(doc).find((c) => componentOwns(c, axis.ref.bodyId)) : undefined;
  useEffect(() => {
    if (!axis) return setWeapon(null);
    const strip = { id: axis.ref.id, bodyId: axis.ref.bodyId, kind: axis.ref.kind, ...(axis.ref.geomType ? { geomType: axis.ref.geomType } : {}) };
    void cad
      .execute<MassResult>("mass_properties", { ...(owner ? { componentIds: [owner.id] } : { bodyIds: [axis.ref.bodyId] }), spin: { axis: { ref: strip }, rpm } })
      .then(setWeapon)
      .catch((e) => cad.setError((e as Error).message));
  }, [axis?.ref.id, rpm, doc.revision]);
  useEffect(() => {
    registerPicker((p) => {
      if (!active || (p.kind !== "face" && p.kind !== "edge")) return false;
      if (!topology.find((t) => t.id === p.ref.id)?.axis || topology.find((t) => t.id === p.ref.id)?.geomType === "LINE") return false;
      setAxis(p);
      setActive(false);
      return true;
    });
    return () => registerPicker(null);
  }, [active, view]);
  useEffect(() => {
    setHighlight(axis ? { refs: [axis.ref], planes: [] } : null);
    return () => setHighlight(null);
  }, [axis?.ref.id]);
  const part = !doc.components?.some((c) => c.source);
  return (
    <div className="property-manager mass" aria-label="Mass Properties PropertyManager">
      <header>
        <Icons.mass size={18} />
        <strong>Mass Properties</strong>
        <span className="pm-actions">
          <button className="pm-accept" aria-label="Close mass properties" title="Close (Enter)" onClick={onClose}>
            <CheckIcon size={18} />
          </button>
          <button className="pm-cancel" aria-label="Close mass properties" title="Close (Esc)" onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="pm-body">
        {result && (
          <section>
            <Row label="Mass" value={weight(result.mass)} />
            {result.remaining !== undefined && (
              <Row
                label={result.remaining >= 0 ? "Under the limit" : "Over the limit"}
                value={weight(Math.abs(result.remaining))}
                tone={result.remaining < 0 ? "error" : undefined}
              />
            )}
            <NumberField
              label="Weight limit"
              unit={inch ? "lb" : "g"}
              value={doc.weightLimit !== undefined ? (inch ? doc.weightLimit / LB : doc.weightLimit) : 0}
              min={0}
              onChange={(v) => void cad.run("set_mass_properties", { weightLimit: v > 0 ? (inch ? v * LB : v) : null })}
            />
            {part && (
              <NumberField
                label="Part mass"
                unit={inch ? "lb" : "g"}
                value={inch ? result.mass / LB : result.mass}
                min={0}
                onChange={(v) => void cad.run("set_mass_properties", { massOverride: v > 0 ? (inch ? v * LB : v) : null })}
              />
            )}
            {part && doc.massOverride !== undefined && (
              <button className="text-button" onClick={() => void cad.run("set_mass_properties", { massOverride: null })}>
                Use material density
              </button>
            )}
          </section>
        )}
        {result && result.mass > 0 && (
          <section>
            <h3>Center of mass</h3>
            {(["X", "Y", "Z"] as const).map((a, i) => (
              <Row key={a} label={a} value={`${length(result.centerOfMass[i])} ${unitLabel()}`} />
            ))}
          </section>
        )}
        {result && result.items.length > 1 && (
          <section>
            <h3>Mass by body</h3>
            {[...result.items]
              .sort((a, b) => b.mass - a.mass)
              .map((item) => (
                <Row key={item.bodyId} label={item.name} value={`${weight(item.mass)} · ${Math.round((100 * item.mass) / result.mass)}%`} />
              ))}
          </section>
        )}
        {result && result.missing.length > 0 && (
          <p className="pm-error">No material or mass: {result.missing.join(", ")}</p>
        )}
        <section>
          <h3>Spinning weapon</h3>
          <SelectionBox
            label="Spin axis"
            placeholder="Select the weapon's shaft face or a circular edge"
            items={axis ? [{ key: axis.ref.id, label: `${pickLabel(view, axis)}${owner ? ` · ${owner.name}` : ""}` }] : []}
            active={active}
            onActivate={() => setActive(true)}
            onRemove={() => setAxis(null)}
          />
          <NumberField label="Speed" unit="rpm" value={rpm} min={1} step={500} onChange={setRpm} />
          {weapon?.spin && (
            <>
              <Row label="Weapon mass" value={weight(weapon.mass)} />
              <Row label="Inertia" value={`${(weapon.spin.inertia * 1e-9).toExponential(3)} kg·m²`} />
              <Row label="Stored energy" value={`${round(weapon.spin.energy, 0)} J`} />
              <Row label="Tip speed" value={`${round(weapon.spin.tipSpeed, 1)} m/s`} />
              <Row label="Off-center" value={`${length(weapon.spin.offset)} ${unitLabel()}`} />
              <Row label="Imbalance force" value={`${round(weapon.spin.imbalanceForce, 1)} N`} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
