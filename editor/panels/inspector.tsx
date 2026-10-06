// Right panel: properties of the selection, design history and design intent.
import { Fragment, useEffect, useState } from "react";
import { Trash2, X, User } from "lucide-react";
import type { Constraint, Entity, Sketch, View } from "../../cad/types.ts";
import { measureConstraint } from "../../cad/solver.ts";
import { arcGeometry, fitPoints } from "../../cad/sketch-geometry.ts";
import { Icons } from "../cad-icons.tsx";
import { Check, Choice, NumberField, Segmented } from "../ui.tsx";
import { materials, type Material } from "../../cad/standards.ts";
import { formatLength, getUnits, toDisplay, unitLabel } from "../units.ts";
import { availableRelations, entityPolyline, formatMm, type PointRef } from "../sketch/model.ts";
import { pickLabel, planeName, type Pick } from "./dialogs.tsx";
import { featureIcon } from "./tree.tsx";
import { AppearanceFields } from "./appearance.tsx";
import type { Cad } from "../state.ts";
import type { SketchOp } from "../sketch/session.ts";

export const paramLabels: Record<string, Record<string, [string, string]>> = {
  extrude: { distance: ["Depth", "mm"], distance2: ["Depth 2", "mm"], draftAngle: ["Draft", "°"] },
  revolve: { angle: ["Angle", "°"] },
  hole: { depth: ["Depth", "mm"], diameter: ["Diameter", "mm"], counterboreDiameter: ["C'bore Ø", "mm"], counterboreDepth: ["C'bore depth", "mm"], countersinkDiameter: ["C'sink Ø", "mm"] },
  fillet: { radius: ["Radius", "mm"] },
  chamfer: { distance: ["Distance", "mm"], distance2: ["Distance 2", "mm"], angle: ["Angle", "°"] },
  shell: { thickness: ["Thickness", "mm"] },
  draft: { angle: ["Angle", "°"] },
  moveFace: { offset: ["Offset", "mm"] },
  thread: { length: ["Length", "mm"], pitch: ["Pitch", "mm"] },
  gear: { module: ["Module", "mm"], teeth: ["Teeth", ""], width: ["Width", "mm"], bore: ["Bore", "mm"], phase: ["Phase", "°"] },
  pulley: { teeth: ["Teeth", ""], width: ["Width", "mm"], bore: ["Bore", "mm"] },
  weld: { size: ["Leg size", "mm"] },
  bend: { angle: ["Angle", "°"] },
  pattern: { spacing: ["Spacing", "mm"], count: ["Instances", ""], angle: ["Angle", "°"], spacing2: ["Spacing 2", "mm"], count2: ["Instances 2", ""] },
  scale: { factor: ["Factor", "×"] },
  transform: { angle: ["Angle", "°"] },
  rib: { thickness: ["Thickness", "mm"] },
  sheet: { thickness: ["Thickness", "mm"], bendRadius: ["Bend radius", "mm"], kFactor: ["K-factor", ""] },
  flange: { length: ["Length", "mm"], angle: ["Angle", "°"], bendRadius: ["Bend radius", "mm"] },
};
const relationNames: Record<string, string> = {
  horizontal: "Horizontal",
  vertical: "Vertical",
  coincident: "Coincident",
  distance: "Distance",
  length: "Length",
  angle: "Angle",
  equal: "Equal",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  collinear: "Collinear",
  concentric: "Concentric",
  tangent: "Tangent",
  midpoint: "Midpoint",
  pointOn: "On curve",
  symmetric: "Symmetric",
  fixed: "Fixed",
  dimension: "Coordinate",
  radius: "Radius",
  diameter: "Diameter",
};
const relationIcon: Partial<Record<string, keyof typeof Icons>> = {
  horizontal: "horizontal",
  vertical: "vertical",
  coincident: "coincident",
  parallel: "parallel",
  perpendicular: "perpendicular",
  tangent: "tangent",
  equal: "equal",
  concentric: "concentric",
  midpoint: "midpoint",
  collinear: "collinear",
  symmetric: "symmetric",
  fixed: "fix",
  pointOn: "coincident",
};
function Rename({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="rename"
      aria-label="Name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() && draft !== value && onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value);
        e.stopPropagation();
      }}
    />
  );
}
const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="info-row">
    <span>{label}</span>
    <b>{value}</b>
  </div>
);
/** A value with its unit; lengths, areas and volumes in the document's display units. */
const fmt = (n: number, unit = "mm") => {
  const power = unit === "mm" ? 1 : unit === "mm²" ? 2 : unit === "mm³" ? 3 : 0;
  const value = power ? toDisplay(n, power) : n;
  const digits = power && getUnits() === "in" ? 4 : 3;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })}${unit ? ` ${power ? unitLabel(power) : unit}` : ""}`;
};
/** Grams below a kilogram, kilograms above. */
const mass = (grams: number) => (grams < 1000 ? fmt(grams, "g") : fmt(grams / 1000, "kg"));
/** A point or size in display units. */
const vec = (v: number[]) => v.map((n) => formatLength(n)).join(", ");
/** A unit direction. */
const dir = (v: number[]) => v.map((n) => formatMm(n)).join(", ");

export function Inspector({
  cad,
  view,
  selection,
  sketch,
  sketchSelection,
  onSketchOps,
  onRelate,
  onSelect,
  tab,
  onTab,
}: {
  cad: Cad;
  view: View;
  selection: Pick[];
  sketch?: Sketch;
  sketchSelection?: { entities: string[]; constraints: string[]; points: PointRef[] };
  onSketchOps: (ops: SketchOp[], reason: string) => void;
  onRelate: (type: Constraint["type"]) => void;
  onSelect: (p: Pick) => void;
  tab: "properties" | "history" | "intent";
  onTab: (t: "properties" | "history" | "intent") => void;
}) {
  return (
    <div className="inspector">
      <div className="tabs" role="tablist">
        {(
          [
            ["properties", "Properties"],
            ["history", "History"],
            ["intent", "Intent"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""} onClick={() => onTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {tab === "history" ? (
          <HistoryList cad={cad} view={view} />
        ) : tab === "intent" ? (
          <IntentList cad={cad} view={view} />
        ) : sketch && sketchSelection ? (
          <SketchProperties sketch={sketch} selection={sketchSelection} onOps={onSketchOps} onRelate={onRelate} />
        ) : (
          <SelectionProperties cad={cad} view={view} selection={selection} onSelect={onSelect} />
        )}
      </div>
    </div>
  );
}

type LibraryMaterial = Material & { custom?: boolean };
/** Material picker: built-in materials by category, the user's saved ones, and a form for a new one. */
function MaterialField({ cad, view }: { cad: Cad; view: View }) {
  const doc = view.document,
    current = doc.material;
  const [library, setLibrary] = useState<LibraryMaterial[]>(materials),
    [creating, setCreating] = useState(false),
    [draft, setDraft] = useState({ name: "", density: 1, modulus: 0, yield: 0, tensile: 0, printed: false });
  const refresh = () =>
    void cad
      .execute<{ materials: LibraryMaterial[] }>("list_materials", {})
      .then((r) => setLibrary(r.materials))
      .catch(() => {});
  useEffect(refresh, []);
  const groups = [...new Set(library.map((m) => (m.custom ? "Custom" : m.category)))];
  const save = async () => {
    if (!draft.name.trim() || !(draft.density > 0)) return;
    try {
      await cad.execute("save_material", {
        name: draft.name.trim(),
        density: draft.density,
        ...(draft.modulus > 0 ? { modulus: draft.modulus } : {}),
        ...(draft.yield > 0 ? { yield: draft.yield } : {}),
        ...(draft.tensile > 0 ? { tensile: draft.tensile } : {}),
        ...(draft.printed ? { printed: true } : {}),
      });
      refresh();
      setCreating(false);
      await cad.run("set_material", { name: draft.name.trim() });
    } catch (e) {
      cad.setError((e as Error).message);
    }
  };
  return (
    <>
      <label className="field">
        <span>Material</span>
        <select
          aria-label="Material"
          value={creating ? "\u0000new" : (current?.name ?? "")}
          onChange={(e) => {
            const name = e.target.value;
            if (name === "\u0000new") return setCreating(true);
            setCreating(false);
            void cad.run("set_material", name ? { name } : {});
          }}
        >
          <option value="">Not set</option>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {library
                .filter((m) => (m.custom ? "Custom" : m.category) === g)
                .map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
            </optgroup>
          ))}
          {current && !library.some((m) => m.name === current.name) && <option value={current.name}>{current.name}</option>}
          <option value={"\u0000new"}>New material…</option>
        </select>
      </label>
      {creating && (
        <div className="material-form">
          <label className="field">
            <span>Name</span>
            <input aria-label="Material name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          <NumberField label="Density" unit="g/cm³" value={draft.density} min={0.001} step={0.01} onChange={(density) => setDraft({ ...draft, density })} />
          <NumberField label="Modulus" unit="GPa" value={draft.modulus} min={0} onChange={(modulus) => setDraft({ ...draft, modulus })} />
          <NumberField label="Yield" unit="MPa" value={draft.yield} min={0} onChange={(v) => setDraft({ ...draft, yield: v })} />
          <NumberField label="Tensile" unit="MPa" value={draft.tensile} min={0} onChange={(tensile) => setDraft({ ...draft, tensile })} />
          <Check label="3D printing material" value={draft.printed} onChange={(printed) => setDraft({ ...draft, printed })} />
          <div className="props-actions">
            <button className="text-button" disabled={!draft.name.trim()} onClick={() => void save()}>
              Save material
            </button>
            <button className="text-button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {current?.printed && (
        <>
          <NumberField label="Infill" unit="%" value={current.infill ?? 30} min={0} max={100} step={5} onChange={(infill) => void cad.run("set_material", { name: current.name, infill, wall: current.wall })} />
          <NumberField label="Walls" value={current.wall ?? 1.2} min={0} step={0.2} onChange={(wall) => void cad.run("set_material", { name: current.name, infill: current.infill, wall })} />
        </>
      )}
      {current && !creating && (
        <>
          <Row label="Density" value={`${current.density} g/cm³`} />
          {current.modulus !== undefined && <Row label="Modulus" value={`${current.modulus} GPa`} />}
          {current.yield !== undefined && <Row label="Yield strength" value={`${current.yield} MPa`} />}
          {current.tensile !== undefined && <Row label="Tensile strength" value={`${current.tensile} MPa`} />}
        </>
      )}
    </>
  );
}

function SelectionProperties({ cad, view, selection, onSelect }: { cad: Cad; view: View; selection: Pick[]; onSelect: (p: Pick) => void }) {
  const doc = view.document;
  const [measure, setMeasure] = useState<any>(null);
  const refs = selection.flatMap((p) => (p.kind === "face" || p.kind === "edge" ? [p.ref] : []));
  const refKey = JSON.stringify(refs.map((r) => r.id));
  useEffect(() => {
    setMeasure(null);
    if (!refs.length || refs.length > 2) return;
    let live = true;
    void cad
      .execute("measure", { refs: refs.map(({ point: _p, ...r }) => r) })
      .then((m) => live && setMeasure(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refKey, doc.revision]);
  if (!selection.length) {
    const bodies = view.geometry.bodies.filter((b) => !b.hidden);
    return (
      <div className="props">
        <h4>{doc.name}</h4>
        <Choice
          label="Units"
          value={doc.units ?? "mm"}
          options={[
            { value: "mm", label: "Millimeters" },
            { value: "in", label: "Inches" },
          ]}
          onChange={(units) => void cad.run("set_units", { units })}
        />
        <Row label="Bodies" value={String(doc.bodies.length)} />
        <Row label="Features" value={String(doc.features.length)} />
        {bodies.length > 0 && <Row label="Volume" value={fmt(bodies.reduce((s, b) => s + b.volume, 0), "mm³")} />}
        {doc.bodies.length > 0 && <MaterialField cad={cad} view={view} />}
        {bodies.some((b) => b.mass !== undefined) && <Row label="Mass" value={mass(bodies.reduce((s, b) => s + (b.mass ?? 0), 0))} />}
      </div>
    );
  }
  if (selection.length === 1 && selection[0].kind === "feature") {
    const f = doc.features.find((x) => x.id === (selection[0] as any).id);
    if (!f) return null;
    const Icon = Icons[featureIcon(f)];
    const labels = paramLabels[f.type] ?? {};
    return (
      <div className="props">
        <div className="props-title">
          <Icon size={16} />
          <Rename value={f.name} onCommit={(name) => void cad.run("rename_object", { objectId: f.id, name })} />
        </div>
        {Object.entries(labels)
          .filter(([key]) => typeof f.params[key] === "number")
          .map(([key, [label, unit]]) => (
            <NumberField
              key={`${f.id}-${key}`}
              label={label}
              unit={unit}
              integer={key.startsWith("count")}
              value={key === "distance" ? Math.abs(f.params[key]) * (f.params[key] < 0 ? -1 : 1) : f.params[key]}
              onChange={(value) => void cad.run("set_dimension", { featureId: f.id, dimension: key, value })}
              expression={f.expressions?.[key]}
              onExpression={(expression) => void cad.run("set_dimension", { featureId: f.id, dimension: key, expression })}
            />
          ))}
        {f.type === "hole" && f.params.size && <Row label="Size" value={`${f.params.size} ${f.params.holeType ?? ""}`} />}
        <div className="props-actions">
          <button className="text-button" onClick={() => void cad.run("suppress_feature", { featureId: f.id, suppressed: !f.suppressed })}>
            {f.suppressed ? "Unsuppress" : "Suppress"}
          </button>
          <button className="text-button danger" onClick={() => void cad.run("delete_feature", { featureId: f.id })}>
            Delete
          </button>
        </div>
      </div>
    );
  }
  if (selection.length === 1 && selection[0].kind === "sketch") {
    const s = doc.sketches.find((x) => x.id === (selection[0] as any).id);
    if (!s) return null;
    return (
      <div className="props">
        <div className="props-title">
          <Icons.sketch size={16} />
          <Rename value={s.name} onCommit={(name) => void cad.run("rename_object", { objectId: s.id, name })} />
        </div>
        <Row label="Plane" value={s.referencePlaneId ? planeName(view, s.referencePlaneId) : s.support ? "Model face" : planeName(view, s.plane)} />
        <Row label="Entities" value={String(s.entities.length)} />
        <Row label="Relations" value={String(s.constraints.length)} />
        <Row label="Status" value={s.solver.dof === 0 ? "Fully defined" : `Under defined · ${s.solver.dof} DOF`} />
      </div>
    );
  }
  if (selection.length === 1 && selection[0].kind === "body") {
    const b = doc.bodies.find((x) => x.id === (selection[0] as any).id),
      g = view.geometry.bodies.find((x) => x.id === b?.id);
    if (!b) return null;
    return (
      <div className="props">
        <div className="props-title">
          <Icons.component size={16} />
          <Rename value={b.name} onCommit={(name) => void cad.run("rename_object", { objectId: b.id, name })} />
        </div>
        {g && (
          <>
            <Row label="Volume" value={fmt(g.volume, "mm³")} />
            {g.mass !== undefined && <Row label="Mass" value={mass(g.mass)} />}
            {g.inertia && <Row label="Principal moments" value={`${g.inertia.map((m) => m.toLocaleString(undefined, { maximumSignificantDigits: 4 })).join(", ")} g·mm²`} />}
            <Row label="Surface area" value={fmt(g.surfaceArea, "mm²")} />
            <Row label="Center of mass" value={vec(g.centerOfMass)} />
            <Row label="Size" value={vec(g.bounds[1].map((v, i) => v - g.bounds[0][i]))} />
            <Row label="Faces" value={String(g.topology.filter((t) => t.kind === "face").length)} />
          </>
        )}
        <section>
          <h4>Display</h4>
          <AppearanceFields cad={cad} objectId={b.id} color={b.color} opacity={b.opacity} style={b.style} texture={b.texture} />
        </section>
      </div>
    );
  }
  if (selection.length === 1 && selection[0].kind === "plane") {
    const id = (selection[0] as any).id as string;
    const p = doc.referencePlanes?.find((x) => x.id === id);
    const def = p?.definition;
    return (
      <div className="props">
        <div className="props-title">
          <Icons.plane size={16} />
          {p ? <Rename value={p.name} onCommit={(name) => void cad.run("rename_object", { objectId: p.id, name })} /> : <strong>{planeName(view, id)}</strong>}
        </div>
        {p && (!def || def.kind === "offset") && (
          <NumberField
            label="Offset"
            value={def?.kind === "offset" ? def.distance : p.origin[{ XY: 2, XZ: 1, YZ: 0 }[p.plane]] * (p.plane === "XZ" ? -1 : 1)}
            onChange={(distance) => void cad.run("set_reference_plane", { planeId: p.id, distance })}
          />
        )}
        {def?.kind === "angle" && <NumberField label="Angle" unit="°" value={def.angle} onChange={(angle) => void cad.run("set_reference_plane", { planeId: p!.id, angle })} />}
      </div>
    );
  }
  // Faces and edges.
  const topo = view.geometry.bodies.flatMap((b) => b.topology);
  return (
    <div className="props">
      {selection.slice(0, 6).map((p, i) => {
        const t = (p.kind === "face" || p.kind === "edge") && topo.find((x) => x.id === p.ref.id);
        const owner = t && t.featureId ? doc.features.find((f) => f.id === t.featureId) : undefined;
        return (
          <div className="selected-entity" key={i}>
            <strong>{pickLabel(view, p)}</strong>
            {t && t.kind === "face" && <Row label="Area" value={fmt(t.area ?? 0, "mm²")} />}
            {t && t.kind === "edge" && t.geomType !== "CIRCLE" && <Row label="Length" value={fmt(t.length ?? 0)} />}
            {t && t.radius !== undefined && <Row label="Diameter" value={fmt(t.radius * 2)} />}
            {t && t.normal && t.geomType === "PLANE" && <Row label="Normal" value={dir(t.normal)} />}
            {owner && (
              <button className="link-row" onClick={() => onSelect({ kind: "feature", id: owner.id })}>
                <span>Feature</span>
                <b>{owner.name}</b>
              </button>
            )}
          </div>
        );
      })}
      {selection.length > 6 && <p className="muted">{selection.length - 6} more</p>}
      {measure && refs.length === 2 && (
        <div className="measure">
          <h4>Measure</h4>
          {measure.distance !== undefined && <Row label="Distance" value={fmt(measure.distance)} />}
          {measure.angle !== undefined && <Row label="Angle" value={`${formatMm(measure.angle)}°`} />}
          {measure.length !== undefined && <Row label="Length" value={fmt(measure.length)} />}
          {measure.diameter !== undefined && <Row label="Diameter" value={fmt(measure.diameter)} />}
          {measure.area !== undefined && <Row label="Area" value={fmt(measure.area, "mm²")} />}
        </div>
      )}
    </div>
  );
}

function SketchProperties({
  sketch,
  selection,
  onOps,
  onRelate,
}: {
  sketch: Sketch;
  selection: { entities: string[]; constraints: string[]; points: PointRef[] };
  onOps: (ops: SketchOp[], reason: string) => void;
  onRelate: (type: Constraint["type"]) => void;
}) {
  const entities = selection.entities.map((id) => sketch.entities.find((e) => e.id === id)).filter(Boolean) as Entity[];
  const relations = availableRelations(sketch, selection.entities, selection.points);
  // A selected point shows the relations on that point, not every relation of its entity.
  const onPoint = (c: Constraint, id: string, i: number) =>
    selection.points.some((p) => p.entityId === id && (c.anchors?.[i] === p.anchor || (!c.anchors?.[i] && c.type === "fixed")));
  const involved = sketch.constraints.filter(
    (c) => selection.constraints.includes(c.id) || c.entityIds.some((id, i) => selection.entities.includes(id) || onPoint(c, id, i)),
  );
  if (!entities.length && !selection.points.length && !selection.constraints.length)
    return (
      <div className="props">
        <h4>{sketch.name}</h4>
        <Row label="Status" value={sketch.solver.dof === 0 ? "Fully defined" : `Under defined · ${sketch.solver.dof} DOF`} />
        <Row label="Entities" value={String(sketch.entities.length)} />
        <Row label="Relations" value={String(sketch.constraints.length)} />
      </div>
    );
  const set = (e: Entity, key: string, value: number) => onOps([{ op: "set", entityId: e.id, values: { [key]: value } }], "Edited sketch geometry");
  return (
    <div className="props">
      {relations.length > 0 && (
        <section>
          <h4>Add relations</h4>
          <div className="relation-buttons">
            {relations.map((r) => {
              const I = Icons[relationIcon[r] ?? "relation"];
              return (
                <button key={r} className="relation-button" onClick={() => onRelate(r)}>
                  <I size={16} />
                  <span>{relationNames[r]}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {entities.length === 1 &&
        (() => {
          const e = entities[0];
          const v = e.values;
          return (
            <section key={e.id}>
              <h4>{e.construction ? "Construction " : ""}{e.type === "line" ? "Line" : e.type === "circle" ? "Circle" : e.type === "arc" ? "Arc" : e.type === "point" ? "Point" : e.type === "spline" ? "Spline" : "Rectangle"}</h4>
              {e.type === "line" && (
                <>
                  <NumberField label="Start X" value={v.x1} onChange={(n) => set(e, "x1", n)} />
                  <NumberField label="Start Y" value={v.y1} onChange={(n) => set(e, "y1", n)} />
                  <NumberField label="End X" value={v.x2} onChange={(n) => set(e, "x2", n)} />
                  <NumberField label="End Y" value={v.y2} onChange={(n) => set(e, "y2", n)} />
                  <Row label="Length" value={fmt(Math.hypot(v.x2 - v.x1, v.y2 - v.y1))} />
                  <Row label="Angle" value={`${formatMm((Math.atan2(v.y2 - v.y1, v.x2 - v.x1) * 180) / Math.PI)}°`} />
                </>
              )}
              {e.type === "circle" && (
                <>
                  <NumberField label="Center X" value={v.x} onChange={(n) => set(e, "x", n)} />
                  <NumberField label="Center Y" value={v.y} onChange={(n) => set(e, "y", n)} />
                  <NumberField label="Diameter" value={v.radius * 2} min={0.001} onChange={(n) => set(e, "radius", n / 2)} />
                </>
              )}
              {e.type === "point" && (
                <>
                  <NumberField label="X" value={v.x} onChange={(n) => set(e, "x", n)} />
                  <NumberField label="Y" value={v.y} onChange={(n) => set(e, "y", n)} />
                </>
              )}
              {e.type === "spline" && (
                <>
                  {fitPoints(e).map((_, i) => (
                    <Fragment key={i}>
                      <NumberField label={`Point ${i + 1} X`} value={v[`x${i}`]} onChange={(n) => set(e, `x${i}`, n)} />
                      <NumberField label={`Point ${i + 1} Y`} value={v[`y${i}`]} onChange={(n) => set(e, `y${i}`, n)} />
                    </Fragment>
                  ))}
                  <Row
                    label="Length"
                    value={fmt(entityPolyline(e, 400).reduce((sum, p, i, all) => (i ? sum + Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) : 0), 0))}
                  />
                </>
              )}
              {e.type === "arc" &&
                (() => {
                  const g = arcGeometry(e);
                  return g ? (
                    <>
                      <Row label="Radius" value={fmt(g.radius)} />
                      <Row label="Center" value={vec(g.center)} />
                      <Row label="Sweep" value={`${formatMm((g.sweep * 180) / Math.PI)}°`} />
                    </>
                  ) : null;
                })()}
              <Segmented
                label="Geometry type"
                value={e.construction ? "construction" : "normal"}
                onChange={(kind) => onOps([{ op: "construction", entityId: e.id, construction: kind === "construction" }], "Toggled construction")}
                options={[
                  { value: "normal", label: "Normal" },
                  { value: "construction", label: "Construction" },
                ]}
              />
            </section>
          );
        })()}
      {entities.length > 1 && <h4>{entities.length} entities</h4>}
      {involved.length > 0 && (
        <section>
          <h4>Existing relations</h4>
          {involved.map((c) => {
            const measured = measureConstraint(sketch, c);
            return (
              <div className="relation-row" key={c.id}>
                <span>
                  {relationNames[c.type] ?? c.type}
                  {c.value !== undefined && c.type !== "symmetric" ? ` ${formatMm(measured ?? c.value)}${c.type === "angle" ? "°" : ""}` : ""}
                </span>
                <button aria-label="Delete relation" onClick={() => onOps([{ op: "unconstrain", constraintId: c.id }], "Deleted relation")}>
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </section>
      )}
      <button
        className="text-button danger"
        onClick={() =>
          onOps(
            [
              ...selection.constraints.map((id) => ({ op: "unconstrain", constraintId: id })),
              ...selection.entities.map((id) => ({ op: "delete", entityId: id })),
            ].filter((op: any) => op.op !== "unconstrain" || !sketch.constraints.find((c) => c.id === op.constraintId)?.entityIds.some((id) => selection.entities.includes(id))),
            "Deleted sketch items",
          )
        }
      >
        <Trash2 size={13} /> Delete
      </button>
    </div>
  );
}

interface GitStatus {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  merging: boolean;
  changes: { path: string; change: string; document?: string; object?: string }[];
  problems?: string[];
}
interface GitBranches {
  current: string;
  branches: { name: string; current: boolean; upstream?: string; remote: boolean }[];
}
/**
 * Version control for designs in a git project folder: commit, branch, merge,
 * pull and push, with conflicts settled object by object. Hidden otherwise.
 */
function VersionControl({ cad, view }: { cad: Cad; view: View }) {
  const doc = view.document;
  const [status, setStatus] = useState<GitStatus | null>(null),
    [branches, setBranches] = useState<GitBranches | null>(null),
    [message, setMessage] = useState(""),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      const [s, b] = await Promise.all([cad.execute<GitStatus>("git_status", {}), cad.execute<GitBranches>("git_branches", {})]);
      setStatus(s);
      setBranches(b);
    } catch {
      setStatus(null);
    }
  };
  useEffect(() => {
    void refresh();
  }, [doc.id, doc.revision]);
  // Git may have changed the open design (switch, merge, pull): reload it.
  const act = async (tool: string, args: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const s = await cad.execute<GitStatus>(tool, args);
      setStatus(s);
      const docs = await cad.refreshDocuments();
      await cad.open(docs.some((d) => d.id === doc.id) ? doc.id : (docs[0]?.id ?? doc.id));
      setBranches(await cad.execute<GitBranches>("git_branches", {}));
      return s;
    } catch (e) {
      cad.setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!status) return null;
  const conflicts = status.changes.filter((c) => c.change === "conflict"),
    changes = status.changes.filter((c) => c.change !== "conflict");
  const label = (c: GitStatus["changes"][number]) => [c.document, c.object].filter(Boolean).join(" · ") || c.path;
  return (
    <section className="version-control">
      <h4>Version control</h4>
      <div className="info-row">
        <span>Branch</span>
        <b>{status.branch}</b>
      </div>
      {status.upstream && (
        <div className="info-row">
          <span>{status.upstream}</span>
          <b>{status.ahead || status.behind ? `${status.ahead} to push · ${status.behind} to pull` : "Up to date"}</b>
        </div>
      )}
      {status.problems?.map((p) => (
        <p className="pm-error" key={p}>
          {p}
        </p>
      ))}
      {conflicts.length > 0 && (
        <div className="git-list">
          {conflicts.map((c) => (
            <div className="branch-row conflict" key={c.path}>
              <span className="history-text">
                <span>{label(c)}</span>
                <small>Changed on both branches</small>
              </span>
              <button className="text-button" disabled={busy} onClick={() => void act("git_resolve", { path: c.path, take: "ours" })}>
                Keep mine
              </button>
              <button className="text-button" disabled={busy} onClick={() => void act("git_resolve", { path: c.path, take: "theirs" })}>
                Take theirs
              </button>
            </div>
          ))}
        </div>
      )}
      {changes.length > 0 && (
        <div className="git-list">
          {changes.slice(0, 12).map((c) => (
            <div className="info-row" key={c.path}>
              <span>{label(c)}</span>
              <b>{c.change}</b>
            </div>
          ))}
          {changes.length > 12 && <p className="muted">{changes.length - 12} more</p>}
        </div>
      )}
      {(changes.length > 0 || (status.merging && !conflicts.length)) && (
        <div className="branch-new">
          <input aria-label="Commit message" placeholder={status.merging ? "Merge message" : "What changed"} value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button
            className="text-button"
            disabled={busy || !message.trim() || conflicts.length > 0}
            onClick={async () => {
              if (await act("git_commit", { message: message.trim() })) setMessage("");
            }}
          >
            Commit
          </button>
        </div>
      )}
      <div className="props-actions">
        {status.merging ? (
          <button className="text-button" disabled={busy} onClick={() => void act("git_abort_merge")}>
            Abort merge
          </button>
        ) : (
          <>
            <button className="text-button" disabled={busy || !status.upstream} onClick={() => void act("git_pull")}>
              Pull
            </button>
            <button className="text-button" disabled={busy} onClick={() => void act("git_push")}>
              Push
            </button>
          </>
        )}
      </div>
      {branches && !status.merging && (
        <div className="git-list">
          {branches.branches
            .filter((b) => !b.current && !(b.remote && branches.branches.some((x) => !x.remote && b.name.endsWith(`/${x.name}`))))
            .map((b) => (
              <div className="branch-row" key={b.name}>
                <span className="history-text">
                  <span>{b.name}</span>
                </span>
                <button className="text-button" disabled={busy || changes.length > 0} title={changes.length ? "Commit your changes first" : undefined} onClick={() => void act("git_switch", { name: b.name })}>
                  Switch
                </button>
                <button className="text-button" disabled={busy || changes.length > 0} onClick={() => void act("git_merge", { branch: b.name })}>
                  Merge
                </button>
              </div>
            ))}
          <div className="branch-new">
            <input aria-label="New branch name" placeholder="New branch" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && name.trim() && void act("git_create_branch", { name: name.trim() }).then(() => setName("")))} />
            <button className="text-button" disabled={busy || !name.trim()} onClick={() => void act("git_create_branch", { name: name.trim() }).then(() => setName(""))}>
              Branch
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function HistoryList({ cad, view }: { cad: Cad; view: View }) {
  const doc = view.document;
  const entries = doc.history.map((h, i) => ({ ...h, index: i })).reverse();
  return (
    <div className="history">
      <VersionControl cad={cad} view={view} />
      <h4>History</h4>
      {entries.map((h) => {
        const current = h.index === doc.historyIndex,
          future = h.index > doc.historyIndex;
        return (
          <div key={h.id} className={`history-row ${current ? "current" : ""} ${future ? "future" : ""}`}>
            <span className="history-source" title={h.source === "assistant" ? "Assistant" : "You"}>
              {h.source === "assistant" ? <Icons.intent size={14} /> : <User size={14} />}
            </span>
            <span className="history-text">
              <span>{h.description}</span>
              <small>
                Version {h.revision} · {new Date(h.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </small>
            </span>
            {!current && (
              <button className="text-button" onClick={() => void cad.run("restore_history", { historyId: h.id })}>
                Restore
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function IntentList({ cad, view }: { cad: Cad; view: View }) {
  const [text, setText] = useState("");
  return (
    <div className="intent">
      {view.document.intents.map((i) => (
        <div className="intent-row" key={i.id}>
          <span>{i.text}</span>
          {i.kind === "hard" && i.dimension && (
            <small>
              {i.min !== undefined ? `${i.min} ≤ ` : ""}
              {i.dimension}
              {i.max !== undefined ? ` ≤ ${i.max}` : ""}
            </small>
          )}
        </div>
      ))}
      <textarea
        aria-label="New design intent"
        placeholder="Wall thickness at least 2.4 mm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <button
        className="primary"
        disabled={!text.trim()}
        onClick={async () => {
          const r = await cad.run("add_design_intent", { text: text.trim(), kind: "soft" });
          if (r) setText("");
        }}
      >
        Add
      </button>
    </div>
  );
}
