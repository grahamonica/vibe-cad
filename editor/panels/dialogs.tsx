// PropertyManager dialogs. Each dialog turns its fields and selection boxes
// into one typed tool command; the shell previews it live and commits on ✓.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check as CheckIcon, X, ArrowLeftRight } from "lucide-react";
import type { Geometry, PlaneRef, AxisRef, TopologyRef, Vec2, Vec3, View, Feature } from "../../cad/types.ts";
import { metricSizes } from "../../cad/standards.ts";
import { Icons, type IconName } from "../cad-icons.tsx";
import { NumberField, Segmented, Check, Choice, SelectionBox, type BoxItem } from "../ui.tsx";
import { call } from "../bridge.ts";
import type { Cad } from "../state.ts";
import { belts, centerDistance, type BeltType } from "../../cad/drives.ts";
import { formatLength, unitLabel } from "../units.ts";

/** A read-only value beside the fields. */
const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="info-row">
    <span>{label}</span>
    <b>{value}</b>
  </div>
);

export type Pick =
  | { kind: "face"; ref: TopologyRef }
  | { kind: "edge"; ref: TopologyRef }
  | { kind: "plane"; id: string }
  | { kind: "sketch"; id: string; seed?: Vec2 }
  | { kind: "sketchLine"; sketchId: string; entityId: string }
  | { kind: "feature"; id: string }
  | { kind: "body"; id: string }
  | { kind: "component"; id: string }
  | { kind: "mate"; id: string };
export type PickKind = Pick["kind"];
export interface Highlight {
  refs: TopologyRef[];
  planes: string[];
  /** Sketch whose regions are shown for profile picking, with chosen seeds. */
  profile?: { sketchId: string; seeds: Vec2[] };
}
export interface DialogContext {
  cad: Cad;
  view: View;
  featureId?: string;
  initial: Pick[];
  registerPicker: (handler: ((pick: Pick) => boolean) | null) => void;
  setHighlight: (h: Highlight) => void;
  setPreview: (geometry: Geometry | null) => void;
  close: (result?: View) => void;
}
export type DialogKind =
  | "extrude"
  | "cut"
  | "revolve"
  | "sweep"
  | "loft"
  | "fillet"
  | "chamfer"
  | "shell"
  | "move-face"
  | "thread"
  | "gear"
  | "pulley"
  | "hem"
  | "closed-corner"
  | "member"
  | "weld"
  | "bend"
  | "draft"
  | "rib"
  | "base-flange"
  | "edge-flange"
  | "hole"
  | "linear-pattern"
  | "circular-pattern"
  | "mirror"
  | "combine"
  | "split"
  | "move"
  | "scale"
  | "plane"
  | "sketch";
export const dialogForFeature = (f: Feature): DialogKind | undefined =>
  ((
    {
      extrude: f.params.operation === "cut" ? "cut" : "extrude",
      revolve: "revolve",
      sweep: "sweep",
      loft: "loft",
      fillet: "fillet",
      chamfer: "chamfer",
      shell: "shell",
      draft: "draft",
      moveFace: "move-face",
      thread: "thread",
      gear: "gear",
      pulley: "pulley",
      member: "member",
      weld: "weld",
      bend: "bend",
      corner: "closed-corner",
      rib: "rib",
      sheet: "base-flange",
      flange: f.params.hem ? "hem" : "edge-flange",
      hole: "hole",
      pattern: f.params.kind === "circular" ? "circular-pattern" : "linear-pattern",
      mirror: "mirror",
      boolean: "combine",
      split: "split",
      transform: "move",
      scale: "scale",
    } as Record<string, DialogKind>
  )[f.type]);

// ---------------------------------------------------------------------------
// Labels
export function pickLabel(view: View, p: Pick): string {
  const doc = view.document;
  switch (p.kind) {
    case "face":
    case "edge": {
      const t = view.geometry.bodies.flatMap((b) => b.topology).find((t) => t.id === p.ref.id);
      const body = doc.bodies.find((b) => b.id === p.ref.bodyId)?.name;
      const what =
        p.kind === "edge"
          ? t?.geomType === "CIRCLE"
            ? `Circular edge${t.radius ? ` R${round(t.radius)}` : ""}`
            : t?.geomType === "LINE"
              ? `Edge ${round(t.length ?? 0)} mm`
              : "Edge"
          : t?.geomType === "PLANE"
            ? "Face"
            : t?.geomType?.startsWith("CYL")
              ? `Cylindrical face${t.radius ? ` R${round(t.radius)}` : ""}`
              : "Face";
      const owner = t?.featureId && doc.features.find((f) => f.id === t.featureId)?.name;
      return `${what}${owner ? ` · ${owner}` : body && doc.bodies.length > 1 ? ` · ${body}` : ""}`;
    }
    case "plane":
      return planeName(view, p.id);
    case "sketch":
      return doc.sketches.find((s) => s.id === p.id)?.name ?? "Sketch";
    case "sketchLine":
      return `${doc.sketches.find((s) => s.id === p.sketchId)?.name ?? "Sketch"} line`;
    case "feature":
      return doc.features.find((f) => f.id === p.id)?.name ?? "Feature";
    case "body":
      return doc.bodies.find((b) => b.id === p.id)?.name ?? "Body";
    case "component":
      return doc.components?.find((c) => c.id === p.id)?.name ?? "Component";
    case "mate":
      return doc.mates?.find((m) => m.id === p.id)?.name ?? "Mate";
  }
}
export const principalNames: Record<string, string> = { XY: "Top plane", XZ: "Front plane", YZ: "Right plane" };
export const planeName = (view: View, id: string) =>
  principalNames[id] ?? view.document.referencePlanes?.find((p) => p.id === id)?.name ?? "Plane";
const round = (n: number) => Math.round(n * 100) / 100;
const pickKey = (p: Pick) =>
  p.kind === "face" || p.kind === "edge"
    ? p.ref.id
    : p.kind === "sketchLine"
      ? `${p.sketchId}:${p.entityId}`
      : p.kind === "sketch" && p.seed
        ? `${p.id}@${p.seed.map((v) => v.toFixed(3)).join(",")}`
        : `${p.kind}:${p.id}`;
export const planeRefOf = (view: View, p: Pick | undefined): PlaneRef | undefined => {
  if (!p) return undefined;
  if (p.kind === "plane")
    return ["XY", "XZ", "YZ"].includes(p.id)
      ? { kind: "principal", plane: p.id as "XY" | "XZ" | "YZ" }
      : { kind: "reference", planeId: p.id };
  if (p.kind === "face") {
    const t = view.geometry.bodies.flatMap((b) => b.topology).find((t) => t.id === p.ref.id);
    return t?.geomType === "PLANE" ? { kind: "face", ref: strip(p.ref) } : undefined;
  }
  return undefined;
};
export const axisRefOf = (p: Pick | undefined): AxisRef | undefined => {
  if (!p) return undefined;
  if (p.kind === "edge") return { kind: "edge", ref: strip(p.ref) };
  if (p.kind === "face") return { kind: "face", ref: strip(p.ref) };
  if (p.kind === "sketchLine") return { kind: "sketch", sketchId: p.sketchId, entityId: p.entityId };
  if (p.kind === "plane" && ["X", "Y", "Z"].includes(p.id)) return { kind: "principal", axis: p.id as "X" | "Y" | "Z" };
  return undefined;
};
export const strip = (r: TopologyRef): TopologyRef => ({
  id: r.id,
  bodyId: r.bodyId,
  kind: r.kind,
  ...(r.signature ? { signature: r.signature } : {}),
  ...(r.geomType ? { geomType: r.geomType } : {}),
});

// ---------------------------------------------------------------------------
// Selection boxes
interface BoxSpec {
  label: string;
  accepts: PickKind[];
  placeholder: string;
  max?: number;
  /** Faces/edges limited to these geometry types. */
  geom?: (view: View, p: Pick) => boolean;
}
function useBoxes<S extends Record<string, BoxSpec>>(
  ctx: DialogContext,
  specs: S,
  first: keyof S & string,
  initial: Partial<Record<keyof S & string, Pick[]>> = {},
) {
  type K = keyof S & string;
  const keys = Object.keys(specs) as K[];
  const [items, setItems] = useState<Record<K, Pick[]>>(() => {
    const out = Object.fromEntries(keys.map((k) => [k, initial[k] ?? []])) as Record<K, Pick[]>;
    return out;
  });
  const [active, setActive] = useState<K>(first as K);
  const accepts = (key: K, p: Pick) =>
    specs[key].accepts.includes(p.kind) && (!specs[key].geom || specs[key].geom!(ctx.view, p));
  const state = useRef({ items, active });
  state.current = { items, active };
  useEffect(() => {
    ctx.registerPicker((p) => {
      const { items, active } = state.current;
      let key = accepts(active, p) ? active : undefined;
      if (!key) key = keys.find((k) => accepts(k, p) && !items[k].length) ?? keys.find((k) => accepts(k, p));
      if (!key) return false;
      const list = items[key],
        existing = list.findIndex((x) => pickKey(x) === pickKey(p));
      const max = specs[key].max ?? Infinity;
      const next =
        existing >= 0 ? list.filter((_, i) => i !== existing) : max === 1 ? [p] : [...list, p].slice(-max);
      setItems({ ...items, [key]: next });
      if (key !== active) setActive(key);
      // Single-item boxes advance to the next empty box.
      if (max === 1 && existing < 0) {
        const nextEmpty = keys.find((k) => k !== key && !items[k].length && specs[k].max === 1);
        if (nextEmpty) setActive(nextEmpty);
      }
      return true;
    });
    return () => ctx.registerPicker(null);
  }, []);
  useEffect(() => {
    const all = keys.flatMap((k) => items[k]);
    const sketch = all.find((p) => p.kind === "sketch") as Extract<Pick, { kind: "sketch" }> | undefined;
    ctx.setHighlight({
      refs: all.flatMap((p) => (p.kind === "face" || p.kind === "edge" ? [p.ref] : [])),
      planes: all.flatMap((p) => (p.kind === "plane" ? [p.id] : [])),
      profile: sketch
        ? { sketchId: sketch.id, seeds: all.flatMap((p) => (p.kind === "sketch" && p.id === sketch.id && p.seed ? [p.seed] : [])) }
        : undefined,
    });
  }, [JSON.stringify(items)]);
  const box = (key: K) => (
    <SelectionBox
      key={key}
      label={specs[key].label}
      placeholder={specs[key].placeholder}
      active={active === key}
      onActivate={() => setActive(key)}
      items={items[key].map((p): BoxItem => ({ key: pickKey(p), label: pickLabel(ctx.view, p) }))}
      onRemove={(k) => setItems({ ...items, [key]: items[key].filter((p) => pickKey(p) !== k) })}
    />
  );
  return { items, setItems, active, setActive, box };
}
const initialOf = (ctx: DialogContext, kinds: PickKind[], geom?: (p: Pick) => boolean) =>
  ctx.initial.filter((p) => kinds.includes(p.kind) && (!geom || geom(p)));
const topologyOf = (view: View, p: Pick) =>
  p.kind === "face" || p.kind === "edge" ? view.geometry.bodies.flatMap((b) => b.topology).find((t) => t.id === p.ref.id) : undefined;
const isPlanarFace = (view: View, p: Pick) => p.kind !== "face" || topologyOf(view, p)?.geomType === "PLANE";
const isStraightEdge = (view: View, p: Pick) => p.kind !== "edge" || topologyOf(view, p)?.geomType === "LINE";
const featureOf = (view: View, id?: string) => view.document.features.find((f) => f.id === id);

// ---------------------------------------------------------------------------
// Shell
interface Command {
  tool: string;
  arguments: Record<string, any>;
}
export function DialogShell({
  ctx,
  title,
  icon,
  command,
  ready = !!command,
  children,
  acceptOverride,
  preview = true,
}: {
  ctx: DialogContext;
  title: string;
  icon: IconName;
  command: Command | null;
  ready?: boolean;
  children: ReactNode;
  acceptOverride?: () => Promise<View | undefined>;
  preview?: boolean;
}) {
  const [error, setError] = useState(""),
    [warnings, setWarnings] = useState<string[]>([]),
    [previewId, setPreviewId] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  const key = JSON.stringify(command);
  const token = useRef(0);
  const Icon = Icons[icon];
  const documentId = ctx.view.document.id,
    revision = ctx.view.document.revision;
  useEffect(() => {
    const mine = ++token.current;
    setError("");
    setWarnings([]);
    setPreviewId(null);
    ctx.setPreview(null);
    if (!command || !preview) return;
    setPending(true);
    const timer = setTimeout(() => {
      void call<View>("preview_feature", { documentId, expectedRevision: revision, command })
        .then((v) => {
          if (mine !== token.current) return;
          setPreviewId(v.preview?.id ?? null);
          ctx.setPreview(v.preview?.geometry ?? null);
          // What this command would newly flag, such as a mate that over-defines a part.
          const current = new Set(ctx.view.geometry.warnings);
          setWarnings((v.preview?.geometry.warnings ?? []).filter((w) => !current.has(w)));
        })
        .catch((e) => {
          if (mine === token.current) setError((e as Error).message);
        })
        .finally(() => {
          if (mine === token.current) setPending(false);
        });
    }, 220);
    return () => clearTimeout(timer);
  }, [key, revision]);
  useEffect(
    () => () => {
      token.current++;
      ctx.setPreview(null);
      void call("dismiss_preview", { documentId }).catch(() => {});
    },
    [],
  );
  const accept = async () => {
    setError("");
    try {
      let result: View | undefined;
      if (acceptOverride) result = await acceptOverride();
      else if (previewId) result = await ctx.cad.execute<View>("apply_preview", { previewId });
      else if (command) result = await ctx.cad.execute<View>(command.tool, command.arguments);
      if (result) ctx.close(result);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Enter" && ready && !error) {
        e.preventDefault();
        void accept();
      }
      if (e.key === "Escape") ctx.close();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <div className="property-manager" aria-label={`${title} PropertyManager`}>
      <header>
        <Icon size={18} />
        <strong>{title}</strong>
        <span className="pm-actions">
          <button
            className="pm-accept"
            aria-label={`Accept ${title}`}
            title="Accept (Enter)"
            disabled={!ready || !!error || pending || ctx.cad.busy}
            onClick={() => void accept()}
          >
            <CheckIcon size={18} />
          </button>
          <button className="pm-cancel" aria-label="Cancel" title="Cancel (Esc)" onClick={() => ctx.close()}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="pm-body">
        {children}
        {warnings.map((w) => (
          <p className="pm-error" role="status" key={w}>
            {w}
          </p>
        ))}
        {error && (
          <p className="pm-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
const ReverseButton = ({ value, onChange, label = "Reverse direction" }: { value: boolean; onChange: (v: boolean) => void; label?: string }) => (
  <button type="button" className={`reverse ${value ? "on" : ""}`} aria-pressed={value} title={label} aria-label={label} onClick={() => onChange(!value)}>
    <ArrowLeftRight size={15} />
  </button>
);
const operationOptions = [
  { value: "new", label: "New" },
  { value: "join", label: "Join" },
  { value: "cut", label: "Cut" },
  { value: "intersect", label: "Intersect" },
] as const;
/** The body a sketch sits on, or the only body. */
function defaultBody(view: View, sketchId?: string) {
  const s = view.document.sketches.find((x) => x.id === sketchId);
  if (s?.support) return s.support.bodyId;
  return view.document.bodies.filter((b) => !b.hidden).at(-1)?.id;
}

// ---------------------------------------------------------------------------
// Extrude / cut
function ExtrudeDialog({ ctx, cut }: { ctx: DialogContext; cut: boolean }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const initialSketch: Pick[] = f
    ? (p.regions?.length ? p.regions.map((seed: Vec2) => ({ kind: "sketch", id: p.sketchId, seed })) : [{ kind: "sketch", id: p.sketchId }])
    : initialOf(ctx, ["sketch"]).slice(0, 1);
  if (!initialSketch.length && !f && ctx.view.document.sketches.length) {
    const used = new Set(ctx.view.document.features.flatMap((x) => [x.params.sketchId, x.params.profileSketchId, x.params.pathSketchId, ...(x.params.sketchIds ?? [])]));
    const last = [...ctx.view.document.sketches].reverse().find((s) => !used.has(s.id));
    if (last) initialSketch.push({ kind: "sketch", id: last.id });
  }
  const boxes = useBoxes(
    ctx,
    {
      profile: { label: "Sketch profile", accepts: ["sketch"], placeholder: "Select a sketch or its regions" },
      upTo: { label: "Up to face", accepts: ["face"], placeholder: "Select a planar face", max: 1, geom: isPlanarFace },
    },
    "profile",
    { profile: initialSketch, upTo: p.upTo ? [{ kind: "face", ref: p.upTo }] : [] },
  );
  const [end, setEnd] = useState<string>(p.endType ?? (cut ? "through-all" : "blind")),
    [distance, setDistance] = useState(Math.abs(p.distance ?? (cut ? 10 : 10))),
    [distance2, setDistance2] = useState(p.distance2 ?? 5),
    [reverse, setReverse] = useState(!!p.reverse || (p.distance ?? 1) < 0 || (!f && cut)),
    [draft, setDraft] = useState(!!p.draftAngle),
    [draftAngle, setDraftAngle] = useState(p.draftAngle ?? 3),
    [outward, setOutward] = useState(!!p.draftOutward),
    [operation, setOperation] = useState<string>(p.operation ?? (cut ? "cut" : ctx.view.document.bodies.length ? "join" : "new"));
  const profile = boxes.items.profile as Extract<Pick, { kind: "sketch" }>[];
  const sketchId = profile[0]?.id;
  const seeds = profile.filter((x) => x.seed && x.id === sketchId).map((x) => x.seed!);
  const bodyId = f?.bodyId ?? defaultBody(ctx.view, sketchId);
  const op = !ctx.view.document.bodies.length ? "new" : operation;
  const upTo = boxes.items.upTo[0];
  const command = useMemo((): Command | null => {
    if (!sketchId) return null;
    if (end === "up-to-face" && upTo?.kind !== "face") return null;
    return {
      tool: "extrude",
      arguments: {
        ...(f ? { featureId: f.id } : {}),
        sketchId,
        operation: op,
        ...(op !== "new" ? { bodyId } : {}),
        endType: end,
        distance,
        ...(end === "two-sided" ? { distance2 } : {}),
        reverse,
        ...(end === "up-to-face" && upTo?.kind === "face" ? { upTo: strip(upTo.ref) } : {}),
        ...(draft && draftAngle > 0 ? { draftAngle, draftOutward: outward } : {}),
        ...(seeds.length ? { regions: seeds } : {}),
      },
    };
  }, [sketchId, JSON.stringify(seeds), end, distance, distance2, reverse, draft, draftAngle, outward, op, bodyId, upTo && pickKey(upTo)]);
  return (
    <DialogShell ctx={ctx} title={cut ? "Cut-Extrude" : "Extrude"} icon={cut ? "cut" : "extrude"} command={command}>
      {boxes.box("profile")}
      <section>
        <h3>Direction</h3>
        <div className="row">
          <Choice
            label="End"
            value={end}
            onChange={setEnd}
            options={[
              { value: "blind", label: "Blind" },
              { value: "symmetric", label: "Mid plane" },
              { value: "two-sided", label: "Two directions" },
              { value: "through-all", label: "Through all" },
              { value: "through-all-both", label: "Through all both" },
              { value: "up-to-face", label: "Up to face" },
            ]}
          />
          <ReverseButton value={reverse} onChange={setReverse} />
        </div>
        {["blind", "symmetric", "two-sided"].includes(end) && <NumberField label="Depth" value={distance} min={0.001} onChange={setDistance} autoFocus />}
        {end === "two-sided" && <NumberField label="Depth 2" value={distance2} min={0.001} onChange={setDistance2} />}
        {end === "up-to-face" && boxes.box("upTo")}
        <Check label="Draft" value={draft} onChange={setDraft} />
        {draft && (
          <>
            <NumberField label="Draft angle" value={draftAngle} unit="°" min={0.01} max={45} onChange={setDraftAngle} />
            <Check label="Draft outward" value={outward} onChange={setOutward} />
          </>
        )}
      </section>
      {!cut && ctx.view.document.bodies.length > 0 && (
        <section>
          <h3>Result</h3>
          <Segmented label="Result" value={operation} onChange={setOperation} options={[...operationOptions]} />
        </section>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
function RevolveDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const sketchInit: Pick[] = f ? [{ kind: "sketch", id: p.sketchId }] : initialOf(ctx, ["sketch"]).slice(0, 1);
  const axisInit: Pick[] =
    p.axisRef?.kind === "sketch"
      ? [{ kind: "sketchLine", sketchId: p.axisRef.sketchId, entityId: p.axisRef.entityId }]
      : p.axisRef?.kind === "edge" || p.axisRef?.kind === "face"
        ? [{ kind: p.axisRef.kind, ref: p.axisRef.ref }]
        : initialOf(ctx, ["sketchLine", "edge"]).slice(0, 1);
  const boxes = useBoxes(
    ctx,
    {
      profile: { label: "Sketch profile", accepts: ["sketch"], placeholder: "Select a sketch" },
      axis: { label: "Axis of revolution", accepts: ["sketchLine", "edge", "face"], placeholder: "Select a centerline or edge", max: 1 },
    },
    sketchInit.length ? "axis" : "profile",
    { profile: sketchInit, axis: axisInit },
  );
  const [angle, setAngle] = useState(p.angle ?? 360),
    [symmetric, setSymmetric] = useState(!!p.symmetric),
    [reverse, setReverse] = useState(!!p.reverse),
    [principal, setPrincipal] = useState<string>(p.axisRef?.kind === "principal" ? p.axisRef.axis : "auto"),
    [operation, setOperation] = useState<string>(p.operation ?? (ctx.view.document.bodies.length ? "join" : "new"));
  const sketchId = (boxes.items.profile[0] as any)?.id as string | undefined;
  // Default axis: the sketch's construction line, if exactly one.
  const sketch = ctx.view.document.sketches.find((s) => s.id === sketchId);
  const centerline = sketch?.entities.filter((e) => e.type === "line" && e.construction);
  let axis = axisRefOf(boxes.items.axis[0]);
  if (!axis && principal !== "auto") axis = { kind: "principal", axis: principal as "X" | "Y" | "Z" };
  if (!axis && centerline?.length === 1) axis = { kind: "sketch", sketchId: sketchId!, entityId: centerline[0].id };
  const op = !ctx.view.document.bodies.length ? "new" : operation;
  const seeds = (boxes.items.profile as any[]).filter((x) => x.seed).map((x) => x.seed);
  const command: Command | null =
    sketchId && axis
      ? {
          tool: "revolve",
          arguments: {
            ...(f ? { featureId: f.id } : {}),
            sketchId,
            axisRef: axis,
            angle,
            symmetric,
            reverse,
            operation: op,
            ...(op !== "new" ? { bodyId: f?.bodyId ?? defaultBody(ctx.view, sketchId) } : {}),
            ...(seeds.length ? { regions: seeds } : {}),
          },
        }
      : null;
  return (
    <DialogShell ctx={ctx} title="Revolve" icon="revolve" command={command}>
      {boxes.box("profile")}
      {boxes.box("axis")}
      {!boxes.items.axis.length && (
        <Choice
          label="Axis"
          value={principal}
          onChange={setPrincipal}
          options={[
            { value: "auto", label: centerline?.length === 1 ? "Sketch centerline" : "Select an axis" },
            { value: "X", label: "X axis" },
            { value: "Y", label: "Y axis" },
            { value: "Z", label: "Z axis" },
          ]}
        />
      )}
      <section>
        <h3>Angle</h3>
        <div className="row">
          <NumberField label="Angle" unit="°" value={angle} min={0.01} max={360} onChange={setAngle} />
          <ReverseButton value={reverse} onChange={setReverse} />
        </div>
        <Check label="Mid plane" value={symmetric} onChange={setSymmetric} />
      </section>
      {ctx.view.document.bodies.length > 0 && (
        <section>
          <h3>Result</h3>
          <Segmented label="Result" value={operation} onChange={setOperation} options={[...operationOptions]} />
        </section>
      )}
    </DialogShell>
  );
}

function SweepDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    {
      profile: { label: "Profile", accepts: ["sketch"], placeholder: "Select the profile sketch", max: 1 },
      path: { label: "Path", accepts: ["sketch"], placeholder: "Select the path sketch", max: 1 },
    },
    "profile",
    f ? { profile: [{ kind: "sketch", id: p.profileSketchId }], path: [{ kind: "sketch", id: p.pathSketchId }] } : {},
  );
  const [transition, setTransition] = useState<string>(p.transition ?? "transformed"),
    [reversePath, setReversePath] = useState(!!p.reversePath),
    [operation, setOperation] = useState<string>(p.operation ?? (ctx.view.document.bodies.length ? "join" : "new"));
  const profile = (boxes.items.profile[0] as any)?.id,
    path = (boxes.items.path[0] as any)?.id;
  const op = !ctx.view.document.bodies.length ? "new" : operation;
  const command: Command | null =
    profile && path
      ? {
          tool: "sweep",
          arguments: {
            ...(f ? { featureId: f.id } : {}),
            profileSketchId: profile,
            pathSketchId: path,
            transition,
            reversePath,
            operation: op,
            ...(op !== "new" ? { bodyId: f?.bodyId ?? defaultBody(ctx.view) } : {}),
          },
        }
      : null;
  return (
    <DialogShell ctx={ctx} title="Sweep" icon="sweep" command={command}>
      {boxes.box("profile")}
      {boxes.box("path")}
      <section>
        <h3>Options</h3>
        <Choice label="Corners" value={transition} onChange={setTransition} options={[{ value: "transformed", label: "Transformed" }, { value: "right", label: "Sharp" }, { value: "round", label: "Round" }]} />
        <Check label="Reverse path" value={reversePath} onChange={setReversePath} />
      </section>
      {ctx.view.document.bodies.length > 0 && (
        <section>
          <h3>Result</h3>
          <Segmented label="Result" value={operation} onChange={setOperation} options={[...operationOptions]} />
        </section>
      )}
    </DialogShell>
  );
}

function LoftDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { profiles: { label: "Profiles", accepts: ["sketch"], placeholder: "Select profile sketches in order" } },
    "profiles",
    { profiles: f ? p.sketchIds.map((id: string) => ({ kind: "sketch", id })) : initialOf(ctx, ["sketch"]) },
  );
  const [ruled, setRuled] = useState(!!p.ruled),
    [operation, setOperation] = useState<string>(p.operation ?? (ctx.view.document.bodies.length ? "join" : "new"));
  const ids = [...new Set(boxes.items.profiles.map((x: any) => x.id as string))];
  const op = !ctx.view.document.bodies.length ? "new" : operation;
  const command: Command | null =
    ids.length >= 2
      ? {
          tool: "loft",
          arguments: { ...(f ? { featureId: f.id } : {}), sketchIds: ids, ruled, operation: op, ...(op !== "new" ? { bodyId: f?.bodyId ?? defaultBody(ctx.view) } : {}) },
        }
      : null;
  return (
    <DialogShell ctx={ctx} title="Loft" icon="loft" command={command}>
      {boxes.box("profiles")}
      <section>
        <h3>Options</h3>
        <Check label="Straight sections" value={ruled} onChange={setRuled} />
      </section>
      {ctx.view.document.bodies.length > 0 && (
        <section>
          <h3>Result</h3>
          <Segmented label="Result" value={operation} onChange={setOperation} options={[...operationOptions]} />
        </section>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Fillet / chamfer
function FilletDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const initialItems: Pick[] = f
    ? [...(p.edges ?? []).map((ref: TopologyRef) => ({ kind: "edge", ref })), ...(p.faces ?? []).map((ref: TopologyRef) => ({ kind: "face", ref })), ...(p.profiles ?? []).map((x: any) => ({ kind: "edge", ref: x.edge }))]
    : initialOf(ctx, ["edge", "face", "body"]);
  const boxes = useBoxes(
    ctx,
    { items: { label: "Edges, faces or bodies", accepts: ["edge", "face", "body"], placeholder: "Select edges, faces or a body" } },
    "items",
    { items: initialItems },
  );
  const [mode, setMode] = useState<"constant" | "variable">(p.profiles ? "variable" : "constant"),
    [radius, setRadius] = useState(p.radius ?? 2),
    [laws, setLaws] = useState<Record<string, { position: number; radius: number }[]>>(
      Object.fromEntries((p.profiles ?? []).map((x: any) => [x.edge.id, x.points])),
    ),
    [startRadius, setStartRadius] = useState(p.profiles?.[0]?.points[0]?.radius ?? 1),
    [endRadius, setEndRadius] = useState(p.profiles?.[0]?.points.at(-1)?.radius ?? 3);
  const items = boxes.items.items;
  const edges = items.filter((x) => x.kind === "edge") as Extract<Pick, { kind: "edge" }>[],
    faces = items.filter((x) => x.kind === "face") as Extract<Pick, { kind: "face" }>[],
    body = items.find((x) => x.kind === "body") as Extract<Pick, { kind: "body" }> | undefined;
  const bodyId = f?.bodyId ?? edges[0]?.ref.bodyId ?? faces[0]?.ref.bodyId ?? body?.id;
  let command: Command | null = null;
  if (bodyId) {
    const same = [...edges, ...faces].every((x) => x.ref.bodyId === bodyId);
    if (mode === "variable" && edges.length && same)
      command = {
        tool: "variable_fillet_edges",
        arguments: {
          ...(f ? { featureId: f.id } : {}),
          bodyId,
          profiles: edges.map((e) => ({
            edge: strip(e.ref),
            points: laws[e.ref.id] ?? [
              { position: 0, radius: startRadius },
              { position: 1, radius: endRadius },
            ],
          })),
        },
      };
    else if (mode === "constant" && body && !edges.length && !faces.length)
      command = { tool: "fillet_body", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, radius } };
    else if (mode === "constant" && same && faces.length && !edges.length)
      command = { tool: "fillet_faces", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, faces: faces.map((x) => strip(x.ref)), radius } };
    else if (mode === "constant" && same && edges.length && !faces.length)
      command = { tool: "fillet_edges", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, edges: edges.map((x) => strip(x.ref)), radius } };
  }
  return (
    <DialogShell ctx={ctx} title="Fillet" icon="fillet" command={command}>
      <Segmented
        label="Fillet type"
        value={mode}
        onChange={setMode}
        options={[
          { value: "constant", label: "Constant size" },
          { value: "variable", label: "Variable size" },
        ]}
      />
      {boxes.box("items")}
      {mode === "constant" ? (
        <NumberField label="Radius" value={radius} min={0.001} onChange={setRadius} autoFocus />
      ) : (
        <section>
          <h3>Radii</h3>
          <NumberField label="Start" value={startRadius} min={0.001} onChange={(v) => { setStartRadius(v); setLaws({}); }} />
          <NumberField label="End" value={endRadius} min={0.001} onChange={(v) => { setEndRadius(v); setLaws({}); }} />
          {edges.slice(0, 1).map((e) => {
            const law = laws[e.ref.id] ?? [{ position: 0, radius: startRadius }, { position: 1, radius: endRadius }];
            return (
              <div key={e.ref.id} className="law">
                {law.map((pt, i) => (
                  <NumberField
                    key={i}
                    label={`At ${Math.round(pt.position * 100)}%`}
                    value={pt.radius}
                    min={0.001}
                    onChange={(radius) => setLaws({ ...laws, [e.ref.id]: law.map((x, k) => (k === i ? { ...x, radius } : x)) })}
                  />
                ))}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    const mid = { position: 0.5, radius: (law[0].radius + law.at(-1)!.radius) / 2 };
                    if (!law.some((x) => x.position === 0.5))
                      setLaws({ ...laws, [e.ref.id]: [...law, mid].sort((a, b) => a.position - b.position) });
                  }}
                >
                  Add midpoint radius
                </button>
              </div>
            );
          })}
        </section>
      )}
    </DialogShell>
  );
}
function ChamferDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { edges: { label: "Edges", accepts: ["edge"], placeholder: "Select edges" } },
    "edges",
    { edges: f ? (p.edges ?? []).map((ref: TopologyRef) => ({ kind: "edge", ref })) : initialOf(ctx, ["edge"]) },
  );
  const [type, setType] = useState<string>(p.chamferType ?? "equal"),
    [d1, setD1] = useState(p.distance ?? 1),
    [d2, setD2] = useState(p.distance2 ?? 2),
    [angle, setAngle] = useState(p.angle ?? 45),
    [flip, setFlip] = useState(!!p.flip);
  const edges = boxes.items.edges as Extract<Pick, { kind: "edge" }>[];
  const bodyId = f?.bodyId ?? edges[0]?.ref.bodyId;
  const command: Command | null =
    bodyId && edges.length && edges.every((e) => e.ref.bodyId === bodyId)
      ? {
          tool: "chamfer_edges",
          arguments: {
            ...(f ? { featureId: f.id } : {}),
            bodyId,
            edges: edges.map((e) => strip(e.ref)),
            chamferType: type,
            distance: d1,
            ...(type === "two-distance" ? { distance2: d2 } : {}),
            ...(type === "distance-angle" ? { angle } : {}),
            ...(type !== "equal" && flip ? { flip: true } : {}),
          },
        }
      : null;
  return (
    <DialogShell ctx={ctx} title="Chamfer" icon="chamfer" command={command}>
      <Choice
        label="Type"
        value={type}
        onChange={setType}
        options={[
          { value: "equal", label: "Equal distance" },
          { value: "two-distance", label: "Two distances" },
          { value: "distance-angle", label: "Distance and angle" },
        ]}
      />
      {boxes.box("edges")}
      <section>
        <NumberField label={type === "equal" ? "Distance" : "Distance 1"} value={d1} min={0.001} onChange={setD1} autoFocus />
        {type === "two-distance" && <NumberField label="Distance 2" value={d2} min={0.001} onChange={setD2} />}
        {type === "distance-angle" && <NumberField label="Angle" unit="°" value={angle} min={0.1} max={89.9} onChange={setAngle} />}
        {type !== "equal" && <Check label="Flip direction" value={flip} onChange={setFlip} />}
      </section>
    </DialogShell>
  );
}
function ShellDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { faces: { label: "Faces to remove", accepts: ["face"], placeholder: "Select faces to open" } },
    "faces",
    { faces: f ? p.faces.map((ref: TopologyRef) => ({ kind: "face", ref })) : initialOf(ctx, ["face"]) },
  );
  const [thickness, setThickness] = useState(p.thickness ?? 2);
  const faces = boxes.items.faces as Extract<Pick, { kind: "face" }>[];
  const bodyId = f?.bodyId ?? faces[0]?.ref.bodyId;
  const command: Command | null =
    bodyId && faces.length
      ? { tool: "shell_body", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, faces: faces.map((x) => strip(x.ref)), thickness } }
      : null;
  return (
    <DialogShell ctx={ctx} title="Shell" icon="shell" command={command}>
      <NumberField label="Thickness" value={thickness} min={0.001} onChange={setThickness} autoFocus />
      {boxes.box("faces")}
    </DialogShell>
  );
}
/** The plane a generated part sits on: a principal plane, datum plane or flat face (Top by default). */
function usePlacement(ctx: DialogContext, p: Record<string, any>) {
  const init: Pick[] =
    p.plane?.kind === "principal"
      ? [{ kind: "plane", id: p.plane.plane }]
      : p.plane?.kind === "reference"
        ? [{ kind: "plane", id: p.plane.planeId }]
        : p.plane?.kind === "face"
          ? [{ kind: "face", ref: p.plane.ref }]
          : initialOf(ctx, ["plane", "face"]).filter((x) => isPlanarFace(ctx.view, x)).slice(0, 1);
  const boxes = useBoxes(ctx, { plane: { label: "Plane", accepts: ["plane", "face"], placeholder: "Top plane, or select a plane or flat face", max: 1, geom: isPlanarFace } }, "plane", { plane: init });
  const [center, setCenter] = useState<Vec2>(p.center ?? [0, 0]);
  const plane = planeRefOf(ctx.view, boxes.items.plane[0]) ?? { kind: "principal", plane: "XY" };
  const fields = (
    <>
      {boxes.box("plane")}
      <div className="row">
        <NumberField label="Center X" value={center[0]} onChange={(x) => setCenter([x, center[1]])} />
        <NumberField label="Y" value={center[1]} onChange={(y) => setCenter([center[0], y])} />
      </div>
    </>
  );
  return { plane, center, fields };
}
/** Involute spur gear generator. */
function GearDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const place = usePlacement(ctx, p);
  const [module, setModule] = useState(p.module ?? 1.5),
    [teeth, setTeeth] = useState(p.teeth ?? 24),
    [pressure, setPressure] = useState(p.pressureAngle ?? 20),
    [width, setWidth] = useState(p.width ?? 8),
    [bore, setBore] = useState(p.bore ?? 5),
    [phase, setPhase] = useState(p.phase ?? 0),
    [mate, setMate] = useState(teeth);
  const command: Command = {
    tool: "create_gear",
    arguments: { ...(f ? { featureId: f.id } : {}), module, teeth, pressureAngle: pressure, width, bore, plane: place.plane, center: place.center, phase },
  };
  return (
    <DialogShell ctx={ctx} title="Spur Gear" icon="gear" command={command}>
      <div className="row">
        <NumberField label="Module" value={module} min={0.2} step={0.25} onChange={setModule} autoFocus />
        <NumberField label="Teeth" unit="" value={teeth} min={6} max={300} integer onChange={setTeeth} />
      </div>
      <div className="row">
        <NumberField label="Width" value={width} min={0.1} onChange={setWidth} />
        <NumberField label="Bore" value={bore} min={0} onChange={setBore} />
      </div>
      <NumberField label="Pressure angle" unit="°" value={pressure} min={14.5} max={30} step={0.5} onChange={setPressure} />
      <NumberField label="Phase" unit="°" value={phase} step={1} onChange={setPhase} />
      {place.fields}
      <Row label="Pitch diameter" value={`${formatLength(module * teeth)} ${unitLabel()}`} />
      <Row label="Outside diameter" value={`${formatLength(module * (teeth + 2))} ${unitLabel()}`} />
      <div className="row">
        <NumberField label="Mates with" unit="T" value={mate} min={6} integer onChange={setMate} />
      </div>
      <Row label="Center distance" value={`${formatLength(centerDistance(module, teeth, mate))} ${unitLabel()}`} />
    </DialogShell>
  );
}
/** Timing pulley generator for GT2 and HTD belts. */
function PulleyDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const place = usePlacement(ctx, p);
  const [belt, setBelt] = useState<BeltType>(p.belt ?? "HTD 5M"),
    [teeth, setTeeth] = useState(p.teeth ?? 20),
    [width, setWidth] = useState(p.width ?? 15),
    [bore, setBore] = useState(p.bore ?? 8),
    [flanges, setFlanges] = useState(p.flanges ?? true);
  const spec = belts[belt],
    pitch = (teeth * spec.pitch) / Math.PI;
  const command: Command = {
    tool: "create_pulley",
    arguments: { ...(f ? { featureId: f.id } : {}), belt, teeth, width, bore, flanges, plane: place.plane, center: place.center },
  };
  return (
    <DialogShell ctx={ctx} title="Timing Pulley" icon="pulley" command={command}>
      <Choice label="Belt" value={belt} onChange={(b) => setBelt(b as BeltType)} options={Object.keys(belts).map((b) => ({ value: b, label: b }))} />
      <div className="row">
        <NumberField label="Teeth" unit="" value={teeth} min={10} max={200} integer onChange={setTeeth} autoFocus />
        <NumberField label="Width" value={width} min={0.1} onChange={setWidth} />
      </div>
      <NumberField label="Bore" value={bore} min={0} onChange={setBore} />
      <Check label="Flanges" value={flanges} onChange={setFlanges} />
      {place.fields}
      <Row label="Pitch diameter" value={`${formatLength(pitch)} ${unitLabel()}`} />
      <Row label="Outside diameter" value={`${formatLength(pitch - 2 * spec.pld)} ${unitLabel()}`} />
    </DialogShell>
  );
}
/** Thread a shaft or hole: cosmetic by default, modeled when the form itself is needed. */
function ThreadDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const cylindrical = (x: Pick) => (x.kind === "face" ? ctx.view.geometry.bodies.flatMap((b) => b.topology).find((t) => t.id === x.ref.id)?.geomType === "CYLINDRE" : false);
  const boxes = useBoxes(
    ctx,
    { face: { label: "Cylindrical face", accepts: ["face"], placeholder: "Select a shaft or hole", max: 1 } },
    "face",
    { face: f ? [{ kind: "face", ref: p.face }] : initialOf(ctx, ["face"]).filter(cylindrical).slice(0, 1) },
  );
  const face = boxes.items.face[0] as Extract<Pick, { kind: "face" }> | undefined;
  // The size closest to the picked diameter, as a starting point.
  const radius = face ? ctx.view.geometry.bodies.flatMap((b) => b.topology).find((t) => t.id === face.ref.id)?.radius : undefined;
  const guess = radius ? metricSizes.reduce((best, m) => (Math.min(Math.abs(m.diameter - 2 * radius), Math.abs(m.tapDrill - 2 * radius)) < Math.min(Math.abs(best.diameter - 2 * radius), Math.abs(best.tapDrill - 2 * radius)) ? m : best)).size : "M6";
  const [size, setSize] = useState<string | undefined>(p.label ? metricSizes.find((m) => p.label.startsWith(`${m.size}×`))?.size : undefined),
    [full, setFull] = useState(p.length === undefined),
    [length, setLength] = useState(p.length ?? 10),
    [reverse, setReverse] = useState(!!p.reverse),
    [mode, setMode] = useState<"cosmetic" | "modeled">(p.mode ?? "cosmetic");
  const chosen = size ?? guess;
  const command: Command | null = face
    ? {
        tool: "create_thread",
        arguments: { ...(f ? { featureId: f.id } : {}), bodyId: face.ref.bodyId, face: strip(face.ref), size: chosen, ...(full ? {} : { length }), reverse, mode },
      }
    : null;
  return (
    <DialogShell ctx={ctx} title="Thread" icon="thread" command={command}>
      {boxes.box("face")}
      <Choice label="Size" value={chosen} onChange={setSize} options={metricSizes.map((m) => ({ value: m.size, label: `${m.size}×${m.pitch}` }))} />
      <Check label="Full length" value={full} onChange={setFull} />
      {!full && <NumberField label="Length" value={length} min={0.1} onChange={setLength} />}
      <ReverseButton label="Start from the other end" value={reverse} onChange={setReverse} />
      <Segmented
        label="Representation"
        value={mode}
        onChange={(v) => setMode(v as typeof mode)}
        options={[
          { value: "cosmetic", label: "Cosmetic" },
          { value: "modeled", label: "Modeled" },
        ]}
      />
    </DialogShell>
  );
}
/** Offset planar faces along their normals (Move Face / Press Pull). */
function MoveFaceDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { faces: { label: "Faces to move", accepts: ["face"], placeholder: "Select planar faces" } },
    "faces",
    { faces: f ? p.faces.map((ref: TopologyRef) => ({ kind: "face", ref })) : initialOf(ctx, ["face"]) },
  );
  const [distance, setDistance] = useState(Math.abs(p.offset ?? 5)),
    [reverse, setReverse] = useState((p.offset ?? 1) < 0);
  const faces = boxes.items.faces as Extract<Pick, { kind: "face" }>[];
  const bodyId = f?.bodyId ?? faces[0]?.ref.bodyId;
  const command: Command | null =
    bodyId && faces.length && distance > 0
      ? { tool: "move_face", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, faces: faces.map((x) => strip(x.ref)), offset: reverse ? -distance : distance } }
      : null;
  return (
    <DialogShell ctx={ctx} title="Move Face" icon="moveFace" command={command}>
      {boxes.box("faces")}
      <div className="row">
        <NumberField label="Distance" value={distance} min={0.001} onChange={setDistance} autoFocus />
        <ReverseButton value={reverse} onChange={setReverse} />
      </div>
    </DialogShell>
  );
}
function RibDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { profile: { label: "Rib profile", accepts: ["sketch"], placeholder: "Select an open sketch profile", max: 1 } },
    "profile",
    { profile: f ? [{ kind: "sketch", id: p.sketchId }] : initialOf(ctx, ["sketch"]).slice(0, 1) },
  );
  const [thickness, setThickness] = useState(p.thickness ?? 3),
    [flip, setFlip] = useState<boolean | undefined>(p.flip);
  const sketchId = (boxes.items.profile[0] as Extract<Pick, { kind: "sketch" }> | undefined)?.id;
  const bodyId = f?.bodyId ?? defaultBody(ctx.view, sketchId);
  const command: Command | null =
    sketchId && bodyId
      ? { tool: "create_rib", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, sketchId, thickness, ...(flip !== undefined ? { flip } : {}) } }
      : null;
  return (
    <DialogShell ctx={ctx} title="Rib" icon="rib" command={command}>
      {boxes.box("profile")}
      <div className="row">
        <NumberField label="Thickness" value={thickness} min={0.001} onChange={setThickness} autoFocus />
        <ReverseButton label="Flip material side" value={!!flip} onChange={(v) => setFlip(v)} />
      </div>
    </DialogShell>
  );
}
function BaseFlangeDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { profile: { label: "Sketch profile", accepts: ["sketch"], placeholder: "Select a closed sketch", max: 1 } },
    "profile",
    { profile: f ? [{ kind: "sketch", id: p.sketchId }] : initialOf(ctx, ["sketch"]).slice(0, 1) },
  );
  const [thickness, setThickness] = useState(p.thickness ?? 2),
    [radius, setRadius] = useState(p.bendRadius ?? 2),
    [k, setK] = useState(p.kFactor ?? 0.44),
    [reverse, setReverse] = useState(!!p.reverse);
  const sketchId = (boxes.items.profile[0] as Extract<Pick, { kind: "sketch" }> | undefined)?.id;
  const command: Command | null = sketchId
    ? { tool: "create_base_flange", arguments: { ...(f ? { featureId: f.id } : {}), sketchId, thickness, bendRadius: radius, kFactor: k, reverse } }
    : null;
  return (
    <DialogShell ctx={ctx} title="Base Flange" icon="baseFlange" command={command}>
      {boxes.box("profile")}
      <section>
        <h3>Sheet metal</h3>
        <div className="row">
          <NumberField label="Thickness" value={thickness} min={0.01} onChange={setThickness} autoFocus />
          <ReverseButton value={reverse} onChange={setReverse} />
        </div>
        <NumberField label="Bend radius" value={radius} min={0.001} onChange={setRadius} />
        <NumberField label="K-factor" unit="" step={0.01} min={0} max={1} value={k} onChange={setK} />
      </section>
    </DialogShell>
  );
}
function EdgeFlangeDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { edge: { label: "Edge", accepts: ["edge"], placeholder: "Select a straight outline edge", max: 1, geom: isStraightEdge } },
    "edge",
    { edge: f ? [{ kind: "edge", ref: p.edge }] : initialOf(ctx, ["edge"]).slice(0, 1) },
  );
  const [length, setLength] = useState(p.length ?? 20),
    [angle, setAngle] = useState(p.angle ?? 90),
    [flip, setFlip] = useState(!!p.flip);
  const edge = boxes.items.edge[0] as Extract<Pick, { kind: "edge" }> | undefined;
  const command: Command | null = edge
    ? { tool: "create_edge_flange", arguments: { ...(f ? { featureId: f.id } : {}), bodyId: edge.ref.bodyId, edge: strip(edge.ref), length, angle, flip } }
    : null;
  return (
    <DialogShell ctx={ctx} title="Edge Flange" icon="edgeFlange" command={command}>
      {boxes.box("edge")}
      <section>
        <h3>Flange</h3>
        <div className="row">
          <NumberField label="Length" value={length} min={0.01} onChange={setLength} autoFocus />
          <ReverseButton label="Bend to the other side" value={flip} onChange={setFlip} />
        </div>
        <NumberField label="Angle" unit="°" value={angle} min={0.1} max={180} onChange={setAngle} />
      </section>
    </DialogShell>
  );
}
/** Bend a sheet along a sketch line. */
function BendDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { line: { label: "Bend line", accepts: ["sketchLine", "sketch"], placeholder: "Select the sketch line to bend along", max: 1 } },
    "line",
    { line: f ? [{ kind: "sketchLine", sketchId: p.sketchId, entityId: p.entityId }] : initialOf(ctx, ["sketchLine", "sketch"]).slice(0, 1) },
  );
  const [angle, setAngle] = useState(p.angle ?? 30),
    [flip, setFlip] = useState(!!p.flip),
    [flipSide, setFlipSide] = useState(!!p.flipSide);
  const pick = boxes.items.line[0] as Pick | undefined;
  const sketchId = pick?.kind === "sketchLine" ? pick.sketchId : pick?.kind === "sketch" ? pick.id : undefined,
    entityId = pick?.kind === "sketchLine" ? pick.entityId : undefined;
  const bodyId = f?.bodyId ?? ctx.view.document.features.find((x) => x.type === "sheet")?.bodyId;
  const command: Command | null =
    sketchId && bodyId
      ? { tool: "create_sketched_bend", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, sketchId, ...(entityId ? { entityId } : {}), angle, flip, flipSide } }
      : null;
  return (
    <DialogShell ctx={ctx} title="Sketched Bend" icon="bend" command={command}>
      {boxes.box("line")}
      <div className="row">
        <NumberField label="Angle" unit="°" value={angle} min={0.1} max={179.9} onChange={setAngle} autoFocus />
        <ReverseButton label="Bend down" value={flip} onChange={setFlip} />
      </div>
      <Check label="Move the other side" value={flipSide} onChange={setFlipSide} />
    </DialogShell>
  );
}
/** Weldment members along the lines of a sketch. */
function MemberDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { path: { label: "Frame sketch", accepts: ["sketch"], placeholder: "Select the sketch of the frame's lines", max: 1 } },
    "path",
    { path: f ? [{ kind: "sketch", id: p.sketchId }] : initialOf(ctx, ["sketch"]).slice(0, 1) },
  );
  const [kind, setKind] = useState<string>(p.profile?.kind ?? "square-tube"),
    [width, setWidth] = useState(p.profile?.width ?? 25),
    [height, setHeight] = useState(p.profile?.height ?? 25),
    [thickness, setThickness] = useState(p.profile?.thickness ?? 2),
    [corner, setCorner] = useState<"miter" | "butt">(p.corner ?? "miter");
  const sketchId = (boxes.items.path[0] as Extract<Pick, { kind: "sketch" }> | undefined)?.id;
  const tall = ["rect-tube", "angle", "channel"].includes(kind);
  const profile = { kind, width, ...(tall ? { height } : {}), thickness };
  const command: Command | null = f
    ? { tool: "create_structural_member", arguments: { featureId: f.id, profile, corner } }
    : sketchId
      ? { tool: "create_structural_member", arguments: { sketchId, profile, corner } }
      : null;
  return (
    <DialogShell ctx={ctx} title="Structural Member" icon="member" command={command}>
      {boxes.box("path")}
      <Choice
        label="Profile"
        value={kind}
        onChange={setKind}
        options={[
          { value: "square-tube", label: "Square tube" },
          { value: "rect-tube", label: "Rectangular tube" },
          { value: "round-tube", label: "Round tube" },
          { value: "angle", label: "Angle" },
          { value: "channel", label: "Channel" },
          { value: "flat-bar", label: "Flat bar" },
        ]}
      />
      <div className="row">
        <NumberField label={kind === "round-tube" ? "Diameter" : "Width"} value={width} min={0.1} onChange={setWidth} autoFocus />
        {tall && <NumberField label="Height" value={height} min={0.1} onChange={setHeight} />}
      </div>
      <NumberField label={kind === "flat-bar" ? "Thickness" : "Wall"} value={thickness} min={0.01} onChange={setThickness} />
      <Segmented
        label="Corners"
        value={corner}
        onChange={(c) => setCorner(c as typeof corner)}
        options={[
          { value: "miter", label: "Miter" },
          { value: "butt", label: "Butt" },
        ]}
      />
    </DialogShell>
  );
}
/** Fillet weld beads in inside corners. */
function WeldDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { edges: { label: "Inside corner edges", accepts: ["edge"], placeholder: "Select straight edges where parts meet", geom: isStraightEdge } },
    "edges",
    { edges: f ? p.edges.map((ref: TopologyRef) => ({ kind: "edge", ref })) : initialOf(ctx, ["edge"]) },
  );
  const [size, setSize] = useState(p.size ?? 3);
  const edges = boxes.items.edges as Extract<Pick, { kind: "edge" }>[];
  const bodyId = f?.bodyId ?? edges[0]?.ref.bodyId;
  const command: Command | null =
    bodyId && edges.length ? { tool: "create_weld_bead", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, edges: edges.map((e) => strip(e.ref)), size } } : null;
  return (
    <DialogShell ctx={ctx} title="Weld Bead" icon="weld" command={command}>
      {boxes.box("edges")}
      <NumberField label="Leg size" value={size} min={0.1} onChange={setSize} autoFocus />
    </DialogShell>
  );
}
/** Fold a sheet edge back on itself, closed or with a gap. */
function HemDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    { edge: { label: "Edge", accepts: ["edge"], placeholder: "Select a straight outline edge", max: 1, geom: isStraightEdge } },
    "edge",
    { edge: f ? [{ kind: "edge", ref: p.edge }] : initialOf(ctx, ["edge"]).slice(0, 1) },
  );
  const [length, setLength] = useState(p.length ?? 10),
    [kind, setKind] = useState<"closed" | "open">(p.hem ?? "closed"),
    [gap, setGap] = useState(p.hem === "open" ? 2 * (p.bendRadius ?? 1) : 2),
    [flip, setFlip] = useState(!!p.flip);
  const edge = boxes.items.edge[0] as Extract<Pick, { kind: "edge" }> | undefined;
  const command: Command | null = edge
    ? { tool: "create_hem", arguments: { ...(f ? { featureId: f.id } : {}), bodyId: edge.ref.bodyId, edge: strip(edge.ref), length, kind, ...(kind === "open" ? { gap } : {}), flip } }
    : null;
  return (
    <DialogShell ctx={ctx} title="Hem" icon="hem" command={command}>
      {boxes.box("edge")}
      <Segmented
        label="Hem"
        value={kind}
        onChange={(k) => setKind(k as typeof kind)}
        options={[
          { value: "closed", label: "Closed" },
          { value: "open", label: "Open" },
        ]}
      />
      <div className="row">
        <NumberField label="Length" value={length} min={0.01} onChange={setLength} autoFocus />
        <ReverseButton label="Fold to the other side" value={flip} onChange={setFlip} />
      </div>
      {kind === "open" && <NumberField label="Gap" value={gap} min={0.01} onChange={setGap} />}
    </DialogShell>
  );
}
function ClosedCornerDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const topology = ctx.view.geometry.bodies.flatMap((b) => b.topology);
  // A wall's flange: the edge flange that made the picked face.
  const flangeOf = (pick?: Pick) => {
    if (!pick || pick.kind !== "face") return undefined;
    const owner = topology.find((t) => t.id === pick.ref.id)?.featureId;
    return ctx.view.document.features.find((x) => x.id === owner && x.type === "flange" && !x.params.hem);
  };
  const faceOf = (flangeId: string): Pick[] => {
    const t = topology.find((x) => x.kind === "face" && x.featureId === flangeId);
    return t ? [{ kind: "face", ref: { id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType } }] : [];
  };
  const boxes = useBoxes(
    ctx,
    { walls: { label: "Walls", accepts: ["face"], placeholder: "Select a face on each of the two flanges", max: 2, geom: (_v, pick) => !!flangeOf(pick) } },
    "walls",
    { walls: f ? (p.flanges as string[]).flatMap(faceOf) : initialOf(ctx, ["face"], (pick) => !!flangeOf(pick)).slice(0, 2) },
  );
  const [gap, setGap] = useState(p.gap ?? 0.1),
    [swap, setSwap] = useState(false);
  const flanges = boxes.items.walls.map(flangeOf).filter((x): x is NonNullable<typeof x> => !!x);
  const ready = flanges.length === 2 && flanges[0].id !== flanges[1].id;
  const order = ready ? (swap ? [flanges[1].id, flanges[0].id] : [flanges[0].id, flanges[1].id]) : [];
  const command: Command | null = ready ? { tool: "create_closed_corner", arguments: { ...(f ? { featureId: f.id } : {}), bodyId: flanges[0].bodyId, flanges: order, gap } } : null;
  return (
    <DialogShell ctx={ctx} title="Closed Corner" icon="closedCorner" command={command}>
      {boxes.box("walls")}
      <NumberField label="Gap" value={gap} min={0.01} step={0.05} onChange={setGap} autoFocus />
      <Check label="Second wall covers" value={swap} onChange={setSwap} />
    </DialogShell>
  );
}
function DraftDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const neutralInit: Pick[] =
    p.neutral?.kind === "principal"
      ? [{ kind: "plane", id: p.neutral.plane }]
      : p.neutral?.kind === "reference"
        ? [{ kind: "plane", id: p.neutral.planeId }]
        : p.neutral?.kind === "face"
          ? [{ kind: "face", ref: p.neutral.ref }]
          : [];
  const boxes = useBoxes(
    ctx,
    {
      neutral: { label: "Neutral plane", accepts: ["plane", "face"], placeholder: "Select a plane or planar face", max: 1, geom: isPlanarFace },
      faces: { label: "Faces to draft", accepts: ["face"], placeholder: "Select faces" },
    },
    "neutral",
    { neutral: neutralInit, faces: f ? p.faces.map((ref: TopologyRef) => ({ kind: "face", ref })) : [] },
  );
  const [angle, setAngle] = useState(p.angle ?? 3),
    [reverse, setReverse] = useState(!!p.reverse);
  const faces = boxes.items.faces as Extract<Pick, { kind: "face" }>[];
  const neutral = planeRefOf(ctx.view, boxes.items.neutral[0]);
  const bodyId = f?.bodyId ?? faces[0]?.ref.bodyId;
  const command: Command | null =
    bodyId && faces.length && neutral
      ? { tool: "draft_faces", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, faces: faces.map((x) => strip(x.ref)), neutral, angle, reverse } }
      : null;
  return (
    <DialogShell ctx={ctx} title="Draft" icon="draft" command={command}>
      <div className="row">
        <NumberField label="Angle" unit="°" value={angle} min={0.01} max={45} onChange={setAngle} />
        <ReverseButton value={reverse} onChange={setReverse} label="Reverse pull direction" />
      </div>
      {boxes.box("neutral")}
      {boxes.box("faces")}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Hole wizard
/** Sketch frame of a planar face with the part origin projected onto it (matches the kernel). */
function faceFrame(normal: Vec3, center: Vec3) {
  const n = normalize(normal);
  let x: Vec3, y: Vec3;
  if (Math.abs(n[2]) > 0.9) {
    x = normalize([1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]]);
    y = cross(n, x);
  } else {
    y = normalize([-n[2] * n[0], -n[2] * n[1], 1 - n[2] * n[2]]);
    x = cross(y, n);
  }
  const d = center[0] * n[0] + center[1] * n[1] + center[2] * n[2];
  return { origin: [n[0] * d, n[1] * d, n[2] * d] as Vec3, x, y, n };
}
const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function HoleDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const faceInit = f?.params.face ? [{ kind: "face" as const, ref: f.params.face }] : initialOf(ctx, ["face"], (x) => isPlanarFace(ctx.view, x)).slice(0, 1);
  const [positions, setPositions] = useState<Vec2[]>(f ? p.positions ?? [] : []);
  const boxes = useBoxes(
    ctx,
    { face: { label: "Placement face", accepts: ["face"], placeholder: "Select a planar face", max: 1, geom: isPlanarFace } },
    "face",
    { face: faceInit },
  );
  const face = boxes.items.face[0] as Extract<Pick, { kind: "face" }> | undefined;
  const t = face && topologyOf(ctx.view, face);
  const frameMode: "origin" | "face-center" = f ? (p.frame ?? "face-center") : "origin";
  const toLocal = (point: Vec3): Vec2 => {
    if (!t?.normal) return [0, 0];
    const fr = frameMode === "origin" ? faceFrame(t.normal, t.center) : { ...faceFrame(t.normal, t.center), origin: t.center };
    const d: Vec3 = [point[0] - fr.origin[0], point[1] - fr.origin[1], point[2] - fr.origin[2]];
    const r = (v: number) => Math.round(v * 2) / 2;
    return [r(d[0] * fr.x[0] + d[1] * fr.x[1] + d[2] * fr.x[2]), r(d[0] * fr.y[0] + d[1] * fr.y[1] + d[2] * fr.y[2])];
  };
  // Clicking the chosen face again adds a hole center where it was clicked.
  const lastPoint = useRef<string>("");
  useEffect(() => {
    if (!face?.ref.point) return;
    const key = JSON.stringify(face.ref.point);
    if (key === lastPoint.current) return;
    lastPoint.current = key;
    if (!f || positions.length === 0) setPositions((list) => (list.length && !f ? list : [toLocal(face.ref.point!)]));
  }, [face && JSON.stringify(face.ref.point)]);
  useEffect(() => {
    ctx.registerPicker((pick) => {
      if (pick.kind !== "face") return false;
      const current = boxes.items.face[0] as Extract<Pick, { kind: "face" }> | undefined;
      if (current && pick.ref.id === current.ref.id && pick.ref.point) {
        const xy = toLocal(pick.ref.point);
        setPositions((list) => (list.some((q) => Math.hypot(q[0] - xy[0], q[1] - xy[1]) < 0.01) ? list : [...list, xy]));
        return true;
      }
      if (topologyOf(ctx.view, pick)?.geomType !== "PLANE") return false;
      boxes.setItems({ face: [pick] });
      setPositions(pick.ref.point ? [toLocal(pick.ref.point)] : []);
      return true;
    });
    return () => ctx.registerPicker(null);
  });
  const [type, setType] = useState<string>(p.holeType ?? "simple"),
    [standard, setStandard] = useState<boolean>(f ? !!p.size : true),
    [size, setSize] = useState<string>(p.size ?? "M5"),
    [fit, setFit] = useState<string>(p.fit ?? "normal"),
    [diameter, setDiameter] = useState(p.diameter ?? 5.5),
    [through, setThrough] = useState(p.depth === undefined),
    [depth, setDepth] = useState(p.depth ?? 10),
    [cbD, setCbD] = useState(p.counterboreDiameter ?? 10),
    [cbDepth, setCbDepth] = useState(p.counterboreDepth ?? 5),
    [csD, setCsD] = useState(p.countersinkDiameter ?? 10),
    [csAngle, setCsAngle] = useState(p.countersinkAngle ?? 90);
  const bodyId = f?.bodyId ?? face?.ref.bodyId;
  const useStandard = standard || type === "tapped";
  const command: Command | null =
    bodyId && face && positions.length
      ? {
          tool: "create_hole",
          arguments: {
            ...(f ? { featureId: f.id } : {}),
            bodyId,
            face: strip(face.ref),
            frame: frameMode,
            positions,
            holeType: type,
            ...(useStandard ? { size, ...(type !== "tapped" ? { fit } : {}) } : { diameter }),
            ...(!through ? { depth, tipAngle: 118 } : {}),
            ...(!useStandard && type === "counterbore" ? { counterboreDiameter: cbD, counterboreDepth: cbDepth } : {}),
            ...(!useStandard && type === "countersink" ? { countersinkDiameter: csD, countersinkAngle: csAngle } : {}),
          },
        }
      : null;
  return (
    <DialogShell ctx={ctx} title="Hole" icon="hole" command={command}>
      <Choice
        label="Type"
        value={type}
        onChange={setType}
        options={[
          { value: "simple", label: "Simple" },
          { value: "counterbore", label: "Counterbore" },
          { value: "countersink", label: "Countersink" },
          { value: "tapped", label: "Tapped" },
        ]}
      />
      <section>
        <h3>Specification</h3>
        {type !== "tapped" && <Check label="ISO metric size" value={standard} onChange={setStandard} />}
        {useStandard ? (
          <>
            <Choice label="Size" value={size} onChange={setSize} options={metricSizes.map((m) => ({ value: m.size, label: m.size }))} />
            {type !== "tapped" && (
              <Choice label="Fit" value={fit} onChange={setFit} options={[{ value: "close", label: "Close" }, { value: "normal", label: "Normal" }, { value: "loose", label: "Loose" }]} />
            )}
          </>
        ) : (
          <>
            <NumberField label="Diameter" value={diameter} min={0.01} onChange={setDiameter} />
            {type === "counterbore" && (
              <>
                <NumberField label="C'bore Ø" value={cbD} min={0.01} onChange={setCbD} />
                <NumberField label="C'bore depth" value={cbDepth} min={0.01} onChange={setCbDepth} />
              </>
            )}
            {type === "countersink" && (
              <>
                <NumberField label="C'sink Ø" value={csD} min={0.01} onChange={setCsD} />
                <NumberField label="C'sink angle" value={csAngle} unit="°" min={60} max={120} onChange={setCsAngle} />
              </>
            )}
          </>
        )}
        <Check label="Through all" value={through} onChange={setThrough} />
        {!through && <NumberField label="Depth" value={depth} min={0.01} onChange={setDepth} />}
      </section>
      {boxes.box("face")}
      <section>
        <h3>Positions</h3>
        {positions.map((pos, i) => (
          <div className="row position-row" key={i}>
            <NumberField label="X" value={pos[0]} onChange={(x) => setPositions(positions.map((q, k) => (k === i ? [x, q[1]] : q)))} />
            <NumberField label="Y" value={pos[1]} onChange={(y) => setPositions(positions.map((q, k) => (k === i ? [q[0], y] : q)))} />
            <button type="button" className="icon-button" aria-label="Remove position" onClick={() => setPositions(positions.filter((_, k) => k !== i))}>
              <X size={13} />
            </button>
          </div>
        ))}
        <button type="button" className="text-button" disabled={!face} onClick={() => setPositions([...positions, positions.at(-1) ? [positions.at(-1)![0] + 10, positions.at(-1)![1]] : [0, 0]])}>
          Add position
        </button>
      </section>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Patterns and mirror
const patternableTypes = new Set(["extrude", "revolve", "sweep", "loft", "hole"]);
function featurePicks(ctx: DialogContext, ids?: string[]): Pick[] {
  if (ids) return ids.map((id) => ({ kind: "feature", id }));
  return ctx.initial.flatMap((p): Pick[] => {
    if (p.kind === "feature") return [p];
    if (p.kind === "face") {
      const owner = topologyOf(ctx.view, p)?.featureId;
      return owner ? [{ kind: "feature", id: owner }] : [];
    }
    return [];
  });
}
/** Faces picked while a feature box is active resolve to the feature that made them. */
function useFeatureFromFace(ctx: DialogContext, boxes: { items: Record<string, Pick[]>; setItems: (v: any) => void; active: string }, key: string) {
  useEffect(() => {
    ctx.registerPicker((pick) => {
      if (boxes.active !== key) return false;
      let id: string | undefined;
      if (pick.kind === "feature") id = pick.id;
      if (pick.kind === "face") id = topologyOf(ctx.view, pick)?.featureId;
      if (!id) return false;
      const f = featureOf(ctx.view, id);
      if (!f || !patternableTypes.has(f.type) || (f.type !== "hole" && (f.params.operation ?? "new") === "new")) return true;
      const list = boxes.items[key];
      boxes.setItems({ ...boxes.items, [key]: list.some((x) => x.kind === "feature" && x.id === id) ? list.filter((x) => !(x.kind === "feature" && x.id === id)) : [...list, { kind: "feature", id }] });
      return true;
    });
  });
}
function LinearPatternDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(
    ctx,
    {
      features: { label: "Features to pattern", accepts: ["feature"], placeholder: "Select features (or leave empty for the body)" },
      direction: { label: "Direction", accepts: ["edge", "sketchLine"], placeholder: "Select a straight edge", max: 1, geom: (v, x) => x.kind !== "edge" || topologyOf(v, x)?.geomType === "LINE" },
    },
    "features",
    { features: featurePicks(ctx, p.featureIds ?? (p.featureId ? [p.featureId] : undefined)), direction: p.directionRef?.kind === "edge" ? [{ kind: "edge", ref: p.directionRef.ref }] : [] },
  );
  useFeatureFromFace(ctx, boxes as any, "features");
  const [axis, setAxis] = useState<string>(p.directionRef ? "edge" : p.direction ? (p.direction[0] ? "X" : p.direction[1] ? "Y" : "Z") : "X"),
    [reverse, setReverse] = useState(!!p.reverseDirection || (p.direction && p.direction.some((v: number) => v < 0))),
    [spacing, setSpacing] = useState(p.spacing ?? 20),
    [count, setCount] = useState(p.count ?? 3),
    [second, setSecond] = useState(!!p.count2 && p.count2 > 1),
    [axis2, setAxis2] = useState<string>(p.direction2 ? (p.direction2[0] ? "X" : p.direction2[1] ? "Y" : "Z") : "Y"),
    [spacing2, setSpacing2] = useState(p.spacing2 ?? 20),
    [count2, setCount2] = useState(p.count2 ?? 2);
  const ids = boxes.items.features.map((x: any) => x.id as string);
  const dirEdge = axisRefOf(boxes.items.direction[0]);
  const vector = (a: string, sign = 1): Vec3 => (a === "X" ? [sign, 0, 0] : a === "Y" ? [0, sign, 0] : [0, 0, sign]);
  const bodyId = f?.bodyId ?? featureOf(ctx.view, ids[0])?.bodyId ?? defaultBody(ctx.view);
  const command: Command | null = bodyId
    ? {
        tool: "create_linear_pattern",
        arguments: {
          ...(f ? { featureId: f.id } : {}),
          bodyId,
          ...(ids.length ? { featureIds: ids } : {}),
          direction: vector(axis === "edge" ? "X" : axis, reverse ? -1 : 1),
          ...(dirEdge ? { directionRef: dirEdge, reverseDirection: reverse } : {}),
          spacing,
          count,
          ...(second ? { direction2: vector(axis2), spacing2, count2 } : {}),
        },
      }
    : null;
  return (
    <DialogShell ctx={ctx} title="Linear Pattern" icon="linearPattern" command={command}>
      <section>
        <h3>Direction 1</h3>
        {boxes.box("direction")}
        {!boxes.items.direction.length && (
          <div className="row">
            <Choice label="Axis" value={axis} onChange={setAxis} options={[{ value: "X", label: "X" }, { value: "Y", label: "Y" }, { value: "Z", label: "Z" }]} />
            <ReverseButton value={reverse} onChange={setReverse} />
          </div>
        )}
        {boxes.items.direction.length > 0 && <ReverseButton value={reverse} onChange={setReverse} />}
        <NumberField label="Spacing" value={spacing} min={0.001} onChange={setSpacing} />
        <NumberField label="Instances" unit="" integer value={count} min={2} max={200} onChange={setCount} />
      </section>
      <section>
        <Check label="Direction 2" value={second} onChange={setSecond} />
        {second && (
          <>
            <Choice label="Axis" value={axis2} onChange={setAxis2} options={[{ value: "X", label: "X" }, { value: "Y", label: "Y" }, { value: "Z", label: "Z" }]} />
            <NumberField label="Spacing" value={spacing2} min={0.001} onChange={setSpacing2} />
            <NumberField label="Instances" unit="" integer value={count2} min={1} max={200} onChange={setCount2} />
          </>
        )}
      </section>
      {boxes.box("features")}
    </DialogShell>
  );
}
function CircularPatternDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const axisInit: Pick[] = p.axisRef?.kind === "edge" || p.axisRef?.kind === "face" ? [{ kind: p.axisRef.kind, ref: p.axisRef.ref }] : initialOf(ctx, ["edge"], (x) => topologyOf(ctx.view, x)?.geomType === "CIRCLE").slice(0, 1);
  const boxes = useBoxes(
    ctx,
    {
      features: { label: "Features to pattern", accepts: ["feature"], placeholder: "Select features (or leave empty for the body)" },
      axis: { label: "Axis", accepts: ["edge", "face", "sketchLine"], placeholder: "Select a circular edge, cylinder or line", max: 1 },
    },
    "features",
    { features: featurePicks(ctx, p.featureIds ?? (p.featureId ? [p.featureId] : undefined)), axis: axisInit },
  );
  useFeatureFromFace(ctx, boxes as any, "features");
  const [principal, setPrincipal] = useState<string>(p.axisRef?.kind === "principal" ? p.axisRef.axis : "Z"),
    [count, setCount] = useState(p.count ?? 6),
    [angle, setAngle] = useState(p.angle ?? 360);
  const ids = boxes.items.features.map((x: any) => x.id as string);
  const axisRef: AxisRef = axisRefOf(boxes.items.axis[0]) ?? { kind: "principal", axis: principal as "X" | "Y" | "Z" };
  const bodyId = f?.bodyId ?? featureOf(ctx.view, ids[0])?.bodyId ?? defaultBody(ctx.view);
  const command: Command | null = bodyId
    ? {
        tool: "create_circular_pattern",
        arguments: { ...(f ? { featureId: f.id } : {}), bodyId, ...(ids.length ? { featureIds: ids } : {}), axisRef, count, angle },
      }
    : null;
  return (
    <DialogShell ctx={ctx} title="Circular Pattern" icon="circularPattern" command={command}>
      {boxes.box("axis")}
      {!boxes.items.axis.length && (
        <Choice label="Axis" value={principal} onChange={setPrincipal} options={[{ value: "X", label: "X axis" }, { value: "Y", label: "Y axis" }, { value: "Z", label: "Z axis" }]} />
      )}
      <section>
        <NumberField label="Angle" unit="°" value={angle} min={0.01} max={360} onChange={setAngle} />
        <NumberField label="Instances" unit="" integer value={count} min={2} max={200} onChange={setCount} />
      </section>
      {boxes.box("features")}
    </DialogShell>
  );
}
function MirrorDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const planeInit: Pick[] =
    p.mirrorPlane?.kind === "principal"
      ? [{ kind: "plane", id: p.mirrorPlane.plane }]
      : p.mirrorPlane?.kind === "reference"
        ? [{ kind: "plane", id: p.mirrorPlane.planeId }]
        : p.mirrorPlane?.kind === "face"
          ? [{ kind: "face", ref: p.mirrorPlane.ref }]
          : f && p.plane
            ? [{ kind: "plane", id: p.plane }]
            : initialOf(ctx, ["plane"]).slice(0, 1);
  const boxes = useBoxes(
    ctx,
    {
      plane: { label: "Mirror plane", accepts: ["plane", "face"], placeholder: "Select a plane or planar face", max: 1, geom: isPlanarFace },
      features: { label: "Features to mirror", accepts: ["feature"], placeholder: "Select features (or leave empty for the body)" },
    },
    planeInit.length ? "features" : "plane",
    { plane: planeInit, features: featurePicks(ctx, p.featureIds) },
  );
  useFeatureFromFace(ctx, boxes as any, "features");
  const ids = boxes.items.features.map((x: any) => x.id as string);
  const mirrorPlane = planeRefOf(ctx.view, boxes.items.plane[0]);
  const bodyId = f?.bodyId ?? featureOf(ctx.view, ids[0])?.bodyId ?? defaultBody(ctx.view);
  const command: Command | null =
    bodyId && mirrorPlane ? { tool: "mirror_body", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, mirrorPlane, ...(ids.length ? { featureIds: ids } : {}) } } : null;
  return (
    <DialogShell ctx={ctx} title="Mirror" icon="mirror" command={command}>
      {boxes.box("plane")}
      {boxes.box("features")}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Body operations
const bodyOfPick = (p: Pick | undefined) => (p?.kind === "body" ? p.id : p?.kind === "face" || p?.kind === "edge" ? p.ref.bodyId : undefined);
function CombineDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const bodies = [...new Set(ctx.initial.map(bodyOfPick).filter(Boolean))] as string[];
  const boxes = useBoxes(
    ctx,
    {
      main: { label: "Main body", accepts: ["body", "face"], placeholder: "Select the body to keep", max: 1 },
      tool: { label: "Tool body", accepts: ["body", "face"], placeholder: "Select the tool body", max: 1 },
    },
    "main",
    { main: f ? [{ kind: "body", id: f.bodyId }] : bodies.slice(0, 1).map((id) => ({ kind: "body", id })), tool: f ? [{ kind: "body", id: p.toolBodyId }] : bodies.slice(1, 2).map((id) => ({ kind: "body", id })) },
  );
  const [operation, setOperation] = useState<string>(p.operation ?? "union");
  const main = bodyOfPick(boxes.items.main[0]),
    tool = bodyOfPick(boxes.items.tool[0]);
  const command: Command | null =
    main && tool && main !== tool ? { tool: "boolean_bodies", arguments: { ...(f ? { featureId: f.id } : {}), bodyId: main, toolBodyId: tool, operation } } : null;
  return (
    <DialogShell ctx={ctx} title="Combine" icon="combine" command={command}>
      <Segmented label="Operation" value={operation} onChange={setOperation} options={[{ value: "union", label: "Add" }, { value: "subtract", label: "Subtract" }, { value: "intersect", label: "Common" }]} />
      {boxes.box("main")}
      {boxes.box("tool")}
    </DialogShell>
  );
}
function SplitDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const planeInit: Pick[] = p.plane?.kind === "principal" ? [{ kind: "plane", id: p.plane.plane }] : p.plane?.kind === "reference" ? [{ kind: "plane", id: p.plane.planeId }] : initialOf(ctx, ["plane"]).slice(0, 1);
  const boxes = useBoxes(
    ctx,
    {
      body: { label: "Body", accepts: ["body", "face"], placeholder: "Select the body to split", max: 1 },
      plane: { label: "Splitting plane", accepts: ["plane", "face"], placeholder: "Select a plane or planar face", max: 1, geom: isPlanarFace },
    },
    "body",
    { body: f ? [{ kind: "body", id: f.bodyId }] : initialOf(ctx, ["body"]).slice(0, 1), plane: planeInit },
  );
  const [keep, setKeep] = useState<string>(p.keep ?? "both");
  const bodyId = bodyOfPick(boxes.items.body[0]),
    plane = planeRefOf(ctx.view, boxes.items.plane[0]);
  const command: Command | null = bodyId && plane ? { tool: "split_body", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, plane, keep } } : null;
  return (
    <DialogShell ctx={ctx} title="Split" icon="split" command={command}>
      {boxes.box("body")}
      {boxes.box("plane")}
      <Segmented label="Keep" value={keep} onChange={setKeep} options={[{ value: "both", label: "Both" }, { value: "positive", label: "Above" }, { value: "negative", label: "Below" }]} />
    </DialogShell>
  );
}
function MoveDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(ctx, { body: { label: "Body", accepts: ["body", "face"], placeholder: "Select a body", max: 1 } }, "body", {
    body: f ? [{ kind: "body", id: f.bodyId }] : ctx.initial.map(bodyOfPick).filter(Boolean).slice(0, 1).map((id) => ({ kind: "body" as const, id: id! })),
  });
  const [t, setT] = useState<Vec3>(p.translation ?? [0, 0, 0]),
    [angle, setAngle] = useState(p.angle ?? 0),
    [axis, setAxis] = useState<string>(p.axis ? (p.axis[0] ? "X" : p.axis[1] ? "Y" : "Z") : "Z"),
    [copy, setCopy] = useState(!!p.copy);
  const bodyId = bodyOfPick(boxes.items.body[0]);
  const command: Command | null = bodyId
    ? { tool: "move_body", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, translation: t, angle, axis: axis === "X" ? [1, 0, 0] : axis === "Y" ? [0, 1, 0] : [0, 0, 1], copy } }
    : null;
  return (
    <DialogShell ctx={ctx} title="Move/Copy" icon="move" command={command}>
      {boxes.box("body")}
      <section>
        <h3>Translate</h3>
        {(["X", "Y", "Z"] as const).map((k, i) => (
          <NumberField key={k} label={k} value={t[i]} onChange={(v) => setT(t.map((x, j) => (j === i ? v : x)) as Vec3)} />
        ))}
      </section>
      <section>
        <h3>Rotate</h3>
        <Choice label="About" value={axis} onChange={setAxis} options={[{ value: "X", label: "X axis" }, { value: "Y", label: "Y axis" }, { value: "Z", label: "Z axis" }]} />
        <NumberField label="Angle" unit="°" value={angle} onChange={setAngle} />
      </section>
      {!f && <Check label="Copy" value={copy} onChange={setCopy} />}
    </DialogShell>
  );
}
function ScaleDialog({ ctx }: { ctx: DialogContext }) {
  const f = featureOf(ctx.view, ctx.featureId),
    p = f?.params ?? {};
  const boxes = useBoxes(ctx, { body: { label: "Body", accepts: ["body", "face"], placeholder: "Select a body", max: 1 } }, "body", {
    body: f ? [{ kind: "body", id: f.bodyId }] : ctx.initial.map(bodyOfPick).filter(Boolean).slice(0, 1).map((id) => ({ kind: "body" as const, id: id! })),
  });
  const [factor, setFactor] = useState(p.factor ?? 1);
  const bodyId = bodyOfPick(boxes.items.body[0]);
  const command: Command | null = bodyId && factor !== 1 ? { tool: "scale_body", arguments: { ...(f ? { featureId: f.id } : {}), bodyId, factor } } : null;
  return (
    <DialogShell ctx={ctx} title="Scale" icon="scale" command={command}>
      {boxes.box("body")}
      <NumberField label="Scale factor" unit="×" value={factor} min={0.001} max={1000} step={0.1} onChange={setFactor} />
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Datum plane
function PlaneDialog({ ctx }: { ctx: DialogContext }) {
  const boxes = useBoxes(
    ctx,
    {
      first: { label: "First reference", accepts: ["plane", "face", "edge"], placeholder: "Select a plane, face or edge", max: 1 },
      second: { label: "Second reference", accepts: ["plane", "face", "edge", "sketchLine"], placeholder: "Optional: edge or plane", max: 1 },
    },
    "first",
    { first: initialOf(ctx, ["plane", "face", "edge"]).slice(0, 1), second: initialOf(ctx, ["plane", "face", "edge"]).slice(1, 2) },
  );
  const [distance, setDistance] = useState(10),
    [angle, setAngle] = useState(45),
    [flip, setFlip] = useState(false),
    [position, setPosition] = useState(0);
  const a = boxes.items.first[0],
    b = boxes.items.second[0];
  const aPlane = planeRefOf(ctx.view, a),
    bPlane = planeRefOf(ctx.view, b);
  let definition: any, label = "";
  if (a?.kind === "edge" && !b) {
    definition = { kind: "normal-to-edge", edge: strip(a.ref), position };
    label = "Normal to edge";
  } else if (aPlane && bPlane) {
    definition = { kind: "midplane", a: aPlane, b: bPlane };
    label = "Mid plane";
  } else if (aPlane && b && axisRefOf(b)) {
    definition = { kind: "angle", base: aPlane, axis: axisRefOf(b), angle };
    label = "At angle";
  } else if (aPlane) {
    definition = { kind: "offset", base: aPlane, distance: flip ? -distance : distance };
    label = "Offset";
  }
  const command: Command | null = definition ? { tool: "create_reference_plane", arguments: { definition } } : null;
  return (
    <DialogShell ctx={ctx} title="Plane" icon="plane" command={command} preview={false}>
      {boxes.box("first")}
      {boxes.box("second")}
      {label && (
        <section>
          <h3>{label}</h3>
          {definition.kind === "offset" && (
            <div className="row">
              <NumberField label="Distance" value={distance} onChange={setDistance} autoFocus />
              <ReverseButton value={flip} onChange={setFlip} label="Flip side" />
            </div>
          )}
          {definition.kind === "angle" && <NumberField label="Angle" unit="°" value={angle} onChange={setAngle} />}
          {definition.kind === "normal-to-edge" && <NumberField label="Position" unit="%" value={position * 100} min={0} max={100} onChange={(v) => setPosition(v / 100)} />}
        </section>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
/** Sketch command: pick a plane or planar face; creation happens immediately. */
function SketchDialog({ ctx, onStart }: { ctx: DialogContext; onStart: (target: Pick) => void }) {
  useEffect(() => {
    ctx.registerPicker((pick) => {
      if (pick.kind === "plane" || (pick.kind === "face" && isPlanarFace(ctx.view, pick))) {
        onStart(pick);
        return true;
      }
      return pick.kind === "face";
    });
    return () => ctx.registerPicker(null);
  }, []);
  return (
    <div className="property-manager" aria-label="Sketch PropertyManager">
      <header>
        <Icons.sketch size={18} />
        <strong>Sketch</strong>
        <span className="pm-actions">
          <button className="pm-cancel" aria-label="Cancel" onClick={() => ctx.close()}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="pm-body">
        <SelectionBox label="Sketch plane" items={[]} active placeholder="Select a plane or planar face" onActivate={() => {}} onRemove={() => {}} />
        <div className="plane-shortcuts">
          {(["XZ", "XY", "YZ"] as const).map((id) => (
            <button key={id} type="button" className="text-button" onClick={() => onStart({ kind: "plane", id })}>
              {principalNames[id]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function FeatureDialog({ kind, ctx, onSketchTarget }: { kind: DialogKind; ctx: DialogContext; onSketchTarget: (p: Pick) => void }) {
  switch (kind) {
    case "extrude":
      return <ExtrudeDialog ctx={ctx} cut={false} />;
    case "cut":
      return <ExtrudeDialog ctx={ctx} cut />;
    case "revolve":
      return <RevolveDialog ctx={ctx} />;
    case "sweep":
      return <SweepDialog ctx={ctx} />;
    case "loft":
      return <LoftDialog ctx={ctx} />;
    case "fillet":
      return <FilletDialog ctx={ctx} />;
    case "chamfer":
      return <ChamferDialog ctx={ctx} />;
    case "shell":
      return <ShellDialog ctx={ctx} />;
    case "move-face":
      return <MoveFaceDialog ctx={ctx} />;
    case "thread":
      return <ThreadDialog ctx={ctx} />;
    case "gear":
      return <GearDialog ctx={ctx} />;
    case "hem":
      return <HemDialog ctx={ctx} />;
    case "closed-corner":
      return <ClosedCornerDialog ctx={ctx} />;
    case "member":
      return <MemberDialog ctx={ctx} />;
    case "bend":
      return <BendDialog ctx={ctx} />;
    case "weld":
      return <WeldDialog ctx={ctx} />;
    case "pulley":
      return <PulleyDialog ctx={ctx} />;
    case "rib":
      return <RibDialog ctx={ctx} />;
    case "base-flange":
      return <BaseFlangeDialog ctx={ctx} />;
    case "edge-flange":
      return <EdgeFlangeDialog ctx={ctx} />;
    case "draft":
      return <DraftDialog ctx={ctx} />;
    case "hole":
      return <HoleDialog ctx={ctx} />;
    case "linear-pattern":
      return <LinearPatternDialog ctx={ctx} />;
    case "circular-pattern":
      return <CircularPatternDialog ctx={ctx} />;
    case "mirror":
      return <MirrorDialog ctx={ctx} />;
    case "combine":
      return <CombineDialog ctx={ctx} />;
    case "split":
      return <SplitDialog ctx={ctx} />;
    case "move":
      return <MoveDialog ctx={ctx} />;
    case "scale":
      return <ScaleDialog ctx={ctx} />;
    case "plane":
      return <PlaneDialog ctx={ctx} />;
    case "sketch":
      return <SketchDialog ctx={ctx} onStart={onSketchTarget} />;
  }
}
