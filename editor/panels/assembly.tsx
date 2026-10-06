// Assembly workspace: component tree with mates, mate and component dialogs,
// and the component/BOM inspector.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Component, ComponentInstance, Geometry, TopologyRef, Vec2, Vec3, View } from "../../cad/types.ts";
import { allComponents, componentOf as owner, componentOwns } from "../../cad/types.ts";
import { Icons } from "../cad-icons.tsx";
import { Check, Choice, NumberField, Segmented, SelectionBox } from "../ui.tsx";
import { originFrame } from "../../cad/frame.ts";
import { eulerDegrees } from "../../cad/assembly.ts";
import { metricSizes } from "../../cad/standards.ts";
import { DialogShell, pickLabel, strip, type DialogContext, type Highlight, type Pick } from "./dialogs.tsx";
import { pickId } from "./tree.tsx";
import { AppearanceFields } from "./appearance.tsx";
import type { Cad } from "../state.ts";
import { call } from "../bridge.ts";
import { fileBase64, importAccept, isMesh, meshUnitNames, type MeshUnits } from "../file-data.ts";

export type AssemblyDialogKind = "mate" | "component" | "insert" | "pattern" | "hole-series" | "belt";
const mateTypes = [
  { value: "coincident", label: "Coincident" },
  { value: "distance", label: "Distance" },
  { value: "concentric", label: "Concentric" },
  { value: "parallel", label: "Parallel" },
  { value: "perpendicular", label: "Perpendicular" },
  { value: "tangent", label: "Tangent" },
  { value: "angle", label: "Angle" },
  { value: "lock", label: "Lock" },
] as const;
const componentOf = (view: View, bodyId: string) => owner(view.document, bodyId);
/** Driven by an active mate. */
const isMated = (view: View, c: Component) => !!view.document.mates?.some((m) => !m.suppressed && componentOwns(c, m.moving.bodyId));
/** Bill of materials: instances of one inserted part are one line. */
export function bomLines(view: View, partNames: Record<string, string>) {
  const lines = new Map<string, { name: string; quantity: number; ids: string[] }>();
  for (const c of allComponents(view.document)) {
    const key = c.source ? `part:${c.source.documentId}` : `component:${c.id}`;
    // A belt is ordered by its current size.
    const belt = c.belt && view.geometry.bodies.find((b) => b.id === `${c.id}/belt`)?.name;
    const line = lines.get(key) ?? { name: (c.source && partNames[c.source.documentId]) || belt || c.name, quantity: 0, ids: [] };
    line.quantity++;
    line.ids.push(c.id);
    lines.set(key, line);
  }
  return [...lines.values()];
}

export function AssemblyTree({
  view,
  selected,
  onSelect,
  onMenu,
  onPatternMenu,
}: {
  view: View;
  selected: Set<string>;
  onSelect: (p: Pick, additive: boolean) => void;
  onMenu?: (e: React.MouseEvent, component: Component) => void;
  onPatternMenu?: (e: React.MouseEvent, patternId: string) => void;
}) {
  const doc = view.document;
  const [open, setOpen] = useState<Record<string, boolean>>({ mates: true });
  const free = doc.bodies.filter((b) => !componentOf(view, b.id));
  const mated = (c: Component) => isMated(view, c);
  // SolidWorks' marks: (f) fixed, (-) under-defined, (+) over-defined, none when fully defined.
  const definition = (c: Component) => {
    const state = view.geometry.componentStatus?.[c.id]?.status;
    if (!state) return c.grounded ? "(f) " : mated(c) ? "" : "(-) ";
    return { fixed: "(f) ", under: "(-) ", over: "(+) ", full: "" }[state];
  };
  const flagged = (id: string) => {
    const s = view.geometry.mateStatus?.[id];
    return s && s.status !== "ok" ? s : undefined;
  };
  return (
    <div className="feature-tree" role="tree" aria-label="Assembly tree">
      <div className="tree-row root" role="treeitem" aria-selected={false}>
        <span className="tree-icon">
          <Icons.component size={16} />
        </span>
        <span className="tree-label">{doc.name}</span>
      </div>
      {doc.components?.map((c) => (
        <div
          key={c.id}
          role="treeitem"
          aria-selected={selected.has(c.id)}
          className={`tree-row ${selected.has(c.id) ? "selected" : ""} ${c.suppressed || c.display?.hidden ? "dim" : ""}`}
          onClick={(e) => onSelect({ kind: "component", id: c.id }, e.shiftKey || e.metaKey)}
          onContextMenu={(e) => {
            e.preventDefault();
            onSelect({ kind: "component", id: c.id }, false);
            onMenu?.(e, c);
          }}
          title={c.suppressed ? "Suppressed" : c.display?.hidden ? "Hidden" : c.belt ? "Follows its pulleys" : c.grounded ? "Fixed" : mated(c) ? "Positioned by mates" : "Free to move"}
        >
          <span className="tree-expander" />
          <span className="tree-icon">
            {c.belt ? <Icons.belt size={15} /> : c.source ? <Icons.insert size={15} /> : <Icons.component size={15} />}
          </span>
          <span className="tree-label">
            {c.belt ? "" : definition(c)}
            {c.name}
          </span>
        </div>
      ))}
      {free.map((b) => (
        <div key={b.id} role="treeitem" aria-selected={selected.has(b.id)} className={`tree-row dim ${selected.has(b.id) ? "selected" : ""}`} onClick={(e) => onSelect({ kind: "body", id: b.id }, e.shiftKey || e.metaKey)}>
          <span className="tree-expander" />
          <span className="tree-icon">
            <Icons.component size={15} />
          </span>
          <span className="tree-label">{b.name}</span>
        </div>
      ))}
      {(doc.componentPatterns?.length ?? 0) > 0 &&
        doc.componentPatterns!.map((p) => (
          <div
            key={p.id}
            role="treeitem"
            aria-selected={selected.has(p.id)}
            className={`tree-row ${selected.has(p.id) ? "selected" : ""}`}
            onClick={(e) => onSelect({ kind: "component", id: p.id }, e.shiftKey || e.metaKey)}
            onContextMenu={(e) => {
              e.preventDefault();
              onPatternMenu?.(e, p.id);
            }}
            title={`${p.count} instances of ${doc.components?.find((c) => c.id === p.componentId)?.name ?? "a component"}`}
          >
            <span className="tree-expander" />
            <span className="tree-icon">{p.kind === "linear" ? <Icons.linearPattern size={15} /> : <Icons.circularPattern size={15} />}</span>
            <span className="tree-label">{p.name}</span>
          </div>
        ))}
      {(doc.mates?.length ?? 0) > 0 && (
        <>
          <div
            className={`tree-row ${doc.mates!.some((m) => flagged(m.id)) ? "error" : ""}`}
            role="treeitem"
            aria-selected={false}
            onClick={() => setOpen({ ...open, mates: !open.mates })}
          >
            <span className="tree-expander">{open.mates ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
            <span className="tree-icon">
              <Icons.mate size={15} />
            </span>
            <span className="tree-label">Mates</span>
          </div>
          {open.mates &&
            doc.mates!.map((m) => (
              <div
                key={m.id}
                role="treeitem"
                aria-selected={selected.has(m.id)}
                className={`tree-row ${selected.has(m.id) ? "selected" : ""} ${m.suppressed ? "dim" : ""} ${flagged(m.id) ? "error" : ""}`}
                style={{ paddingLeft: 26 }}
                title={flagged(m.id)?.message}
                onClick={(e) => onSelect({ kind: "mate", id: m.id }, e.shiftKey || e.metaKey)}
              >
                <span className="tree-expander" />
                <span className="tree-icon">
                  <Icons.mate size={14} />
                </span>
                <span className="tree-label">{m.name}</span>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

export function AssemblyDialog({
  kind,
  cad,
  view,
  initial,
  registerPicker,
  setHighlight,
  setPreview,
  close,
}: {
  kind: AssemblyDialogKind;
  cad: Cad;
  view: View;
  initial: Pick[];
  registerPicker: (h: ((p: Pick) => boolean) | null) => void;
  setHighlight: (h: Highlight) => void;
  setPreview: (g: Geometry | null) => void;
  close: (v?: View) => void;
}) {
  const ctx: DialogContext = { cad, view, initial, registerPicker, setHighlight, setPreview, close };
  return kind === "mate" ? (
    <MateDialog ctx={ctx} />
  ) : kind === "insert" ? (
    <InsertDialog ctx={ctx} />
  ) : kind === "pattern" ? (
    <PatternDialog ctx={ctx} />
  ) : kind === "hole-series" ? (
    <HoleSeriesDialog ctx={ctx} />
  ) : kind === "belt" ? (
    <BeltDialog ctx={ctx} />
  ) : (
    <ComponentDialog ctx={ctx} />
  );
}

function MateDialog({ ctx }: { ctx: DialogContext }) {
  const [refs, setRefs] = useState<Pick[]>(ctx.initial.filter((p) => p.kind === "face" || p.kind === "edge").slice(0, 2));
  const [type, setType] = useState<string>("coincident"),
    [value, setValue] = useState(0),
    [flip, setFlip] = useState(false),
    [ratio, setRatio] = useState<number | null>(null),
    [sameWay, setSameWay] = useState(false);
  const state = useRef(refs);
  state.current = refs;
  useEffect(() => {
    ctx.registerPicker((p) => {
      if (p.kind !== "face" && p.kind !== "edge") return false;
      const list = state.current;
      const exists = list.findIndex((x) => pickId(x) === pickId(p));
      setRefs(exists >= 0 ? list.filter((_, i) => i !== exists) : [...list, p].slice(-2));
      return true;
    });
    return () => ctx.registerPicker(null);
  }, []);
  useEffect(() => {
    ctx.setHighlight({ refs: refs.flatMap((p) => (p.kind === "face" || p.kind === "edge" ? [p.ref] : [])), planes: [] });
  }, [JSON.stringify(refs.map(pickId))]);
  // Suggest the mate type from the geometry.
  const topo = (p?: Pick) => (p && (p.kind === "face" || p.kind === "edge") ? ctx.view.geometry.bodies.flatMap((b) => b.topology).find((t) => t.id === p.ref.id) : undefined);
  const isRound = (p: Pick) => {
    const t = topo(p);
    return !!t && (t.geomType === "CIRCLE" || (t.kind === "face" && t.geomType !== "PLANE"));
  };
  const round = refs.length === 2 && refs.every(isRound);
  // A cylinder against a plane suggests tangency.
  const rolling = refs.length === 2 && refs.filter(isRound).length === 1 && refs.some((p) => topo(p)?.geomType === "PLANE");
  useEffect(() => {
    if (round) setType((t) => (t === "gear" ? t : "concentric"));
    else if (rolling) setType("tangent");
    else if (type === "concentric" || type === "tangent" || type === "gear") setType("coincident");
  }, [round, rolling]);
  const [moving, target] = refs as [Pick | undefined, Pick | undefined];
  const ready = moving && target && (moving as any).ref.bodyId !== (target as any).ref.bodyId;
  // Alignment closest to how the parts sit now; Flip reverses it.
  const direction = (p?: Pick) => {
    const t = topo(p);
    return t?.axis && (t.kind === "edge" ? t.geomType === "CIRCLE" : t.geomType !== "PLANE") ? t.axis.direction : t?.normal;
  };
  const da = direction(moving),
    db = direction(target);
  const closest = !!da && !!db && da[0] * db[0] + da[1] * db[1] + da[2] * db[2] > 1e-9;
  // Tangent keeps the side the part is on; Flip moves it across.
  const aligned = type === "tangent" ? flip : flip ? !closest : closest;
  // Gears: the tooth ratio when both parts are gears or pulleys.
  const teeth = (p?: Pick) => (p && (p.kind === "face" || p.kind === "edge") ? ctx.view.geometry.bodies.find((b) => b.id === p.ref.bodyId)?.drive?.teeth : undefined);
  const toothRatio = teeth(moving) && teeth(target) ? teeth(target)! / teeth(moving)! : undefined;
  const gearRatio = ratio ?? toothRatio ?? 1;
  const command = ready
    ? {
        tool: "add_mate",
        arguments: {
          type,
          moving: strip((moving as any).ref as TopologyRef),
          target: strip((target as any).ref as TopologyRef),
          value: type === "distance" || type === "angle" ? value : type === "gear" ? gearRatio : 0,
          aligned: type === "gear" ? sameWay : aligned,
        },
      }
    : null;
  return (
    <DialogShell ctx={ctx} title="Mate" icon="mate" command={command}>
      <SelectionBox
        label="Entities to mate"
        active
        placeholder="Select a face or edge on the moving part, then on the fixed part"
        onActivate={() => {}}
        items={refs.map((p, i) => ({ key: pickId(p), label: `${i === 0 ? "Moving" : "Fixed"} · ${componentOf(ctx.view, (p as any).ref.bodyId)?.name ?? pickLabel(ctx.view, p)}` }))}
        onRemove={(key) => setRefs(refs.filter((p) => pickId(p) !== key))}
      />
      <section>
        <h3>Standard mates</h3>
        <div className="mate-types">
          {mateTypes.map((m) => (
            <button key={m.value} type="button" className={type === m.value ? "on" : ""} aria-pressed={type === m.value} onClick={() => setType(m.value)}>
              {m.label}
            </button>
          ))}
        </div>
        {type === "distance" && <NumberField label="Distance" value={value} onChange={setValue} />}
        {type === "angle" && <NumberField label="Angle" unit="°" value={value} min={0} max={180} onChange={setValue} />}
        {type !== "lock" && type !== "gear" && <Check label="Flip alignment" value={flip} onChange={setFlip} />}
      </section>
      <section>
        <h3>Mechanical mates</h3>
        <div className="mate-types">
          <button type="button" className={type === "gear" ? "on" : ""} aria-pressed={type === "gear"} onClick={() => setType("gear")}>
            Gear
          </button>
        </div>
        {type === "gear" && (
          <>
            <NumberField label="Ratio" unit="" value={gearRatio} min={0.001} step={0.1} onChange={setRatio} />
            <Check label="Same direction" value={sameWay} onChange={setSameWay} />
          </>
        )}
      </section>
    </DialogShell>
  );
}

function InsertDialog({ ctx }: { ctx: DialogContext }) {
  const doc = ctx.view.document;
  const [documents, setDocuments] = useState(ctx.cad.documents);
  const [part, setPart] = useState<string | null>(null),
    [file, setFile] = useState<File | null>(null),
    [units, setUnits] = useState<MeshUnits>(doc.units ?? "mm");
  const browse = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void ctx.cad.refreshDocuments().then(setDocuments).catch(() => {});
  }, []);
  // New instances start beside what is already placed, never inside it.
  const bodies = ctx.view.geometry.bodies.filter((b) => !b.hidden);
  const right = bodies.length ? Math.max(...bodies.map((b) => b.bounds[1][0])) : 0,
    left = bodies.length ? Math.min(...bodies.map((b) => b.bounds[0][0])) : 0;
  const [position, setPosition] = useState<Vec3>(bodies.length ? [Math.round(right - left + 20), 0, 0] : [0, 0, 0]);
  const parts = documents.filter((d) => d.id !== doc.id);
  const command = part ? { tool: "insert_component", arguments: { partDocumentId: part, position } } : null;
  // A file becomes a new part document first, then an instance of it.
  const insertFile = async () => {
    const imported = await call<View>("import_part", { data: await fileBase64(file!), filename: file!.name, units });
    void ctx.cad.refreshDocuments();
    return ctx.cad.execute<View>("insert_component", { partDocumentId: imported.document.id, position });
  };
  return (
    <DialogShell
      ctx={ctx}
      title="Insert Part"
      icon="insert"
      command={file ? null : command}
      ready={!!file || !!command}
      preview={!file}
      acceptOverride={file ? insertFile : undefined}
    >
      <section>
        <h3>Part</h3>
        <div className="choice-list" role="listbox" aria-label="Parts">
          {file && (
            <button type="button" role="option" aria-selected className="on">
              {file.name}
            </button>
          )}
          {parts.map((d) => (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={part === d.id}
              className={part === d.id ? "on" : ""}
              onClick={() => {
                setFile(null);
                setPart(d.id);
              }}
            >
              {d.name}
            </button>
          ))}
        </div>
        <button type="button" className="text-button" onClick={() => browse.current?.click()}>
          Browse…
        </button>
        <input
          ref={browse}
          type="file"
          accept={importAccept}
          hidden
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            e.target.value = "";
            if (!chosen) return;
            setPart(null);
            setFile(chosen);
          }}
        />
      </section>
      {file && isMesh(file.name) && (
        <section>
          <Segmented label="STL units" value={units} onChange={(u) => setUnits(u as MeshUnits)} options={meshUnitNames.map(([value]) => ({ value, label: value }))} />
        </section>
      )}
      <section>
        <h3>Position</h3>
        {(["X", "Y", "Z"] as const).map((axis, i) => (
          <NumberField key={axis} label={axis} value={position[i]} onChange={(v) => setPosition(position.map((x, k) => (k === i ? v : x)) as Vec3)} />
        ))}
      </section>
      {!doc.components?.length && <p className="muted">The first component is fixed in place.</p>}
    </DialogShell>
  );
}

/**
 * Hole Series: click centers on a flat face of the first part; the holes go
 * through every part behind it, each as a hole feature in its own document.
 */
function HoleSeriesDialog({ ctx }: { ctx: DialogContext }) {
  const topology = ctx.view.geometry.bodies.flatMap((b) => b.topology);
  const planar = (p: Pick): p is Extract<Pick, { kind: "face" }> => p.kind === "face" && topology.find((t) => t.id === p.ref.id)?.geomType === "PLANE";
  const onFace = (face: Extract<Pick, { kind: "face" }>, point?: Vec3): Vec2 | undefined => {
    const t = topology.find((x) => x.id === face.ref.id);
    if (!t?.normal || !point) return undefined;
    const f = originFrame(t.center, t.normal),
      d = [0, 1, 2].map((k) => point[k] - f.origin[k]);
    const round = (v: number) => Math.round(v * 100) / 100;
    return [round(d[0] * f.xDir[0] + d[1] * f.xDir[1] + d[2] * f.xDir[2]), round(d[0] * f.yDir[0] + d[1] * f.yDir[1] + d[2] * f.yDir[2])];
  };
  const first = ctx.initial.find(planar);
  const [face, setFace] = useState<Extract<Pick, { kind: "face" }> | undefined>(first),
    [positions, setPositions] = useState<Vec2[]>(() => {
      const p = first && onFace(first, first.ref.point);
      return p ? [p] : [];
    }),
    [size, setSize] = useState("M4"),
    [start, setStart] = useState<"simple" | "counterbore" | "countersink">("simple"),
    [end, setEnd] = useState<"clearance" | "tapped">("clearance");
  const faceRef = useRef(face);
  faceRef.current = face;
  useEffect(() => {
    ctx.registerPicker((p) => {
      if (!planar(p)) return false;
      const current = faceRef.current;
      // A click on the start face adds a center; a click elsewhere starts over on that face.
      if (!current || current.ref.id !== p.ref.id) {
        setFace(p);
        setPositions([]);
      }
      const at = onFace(p, p.ref.point);
      if (at) setPositions((list) => [...list, at]);
      return true;
    });
    return () => ctx.registerPicker(null);
  }, []);
  useEffect(() => {
    ctx.setHighlight({ refs: face ? [face.ref] : [], planes: [] });
  }, [face?.ref.id]);
  const ready = !!face && positions.length > 0;
  return (
    <DialogShell
      ctx={ctx}
      title="Hole Series"
      icon="hole"
      command={null}
      ready={ready}
      preview={false}
      acceptOverride={() => ctx.cad.execute<View>("create_hole_series", { face: strip(face!.ref), positions, size, start, end })}
    >
      <SelectionBox
        label="Start face"
        placeholder="Click hole centers on the top face of the stack"
        items={face ? [{ key: face.ref.id, label: pickLabel(ctx.view, face) }] : []}
        active
        onActivate={() => {}}
        onRemove={() => {
          setFace(undefined);
          setPositions([]);
        }}
      />
      {positions.map((p, i) => (
        <div className="row" key={i}>
          <NumberField label={`X${i + 1}`} value={p[0]} onChange={(x) => setPositions(positions.map((q, k) => (k === i ? [x, q[1]] : q)))} />
          <NumberField label="Y" value={p[1]} onChange={(y) => setPositions(positions.map((q, k) => (k === i ? [q[0], y] : q)))} />
        </div>
      ))}
      <Choice label="Size" value={size} onChange={setSize} options={metricSizes.map((m) => ({ value: m.size, label: m.size }))} />
      <Segmented
        label="Start"
        value={start}
        onChange={(v) => setStart(v as typeof start)}
        options={[
          { value: "simple", label: "Clearance" },
          { value: "counterbore", label: "Counterbore" },
          { value: "countersink", label: "Countersink" },
        ]}
      />
      <Segmented
        label="End"
        value={end}
        onChange={(v) => setEnd(v as typeof end)}
        options={[
          { value: "clearance", label: "Clearance" },
          { value: "tapped", label: "Tapped" },
        ]}
      />
    </DialogShell>
  );
}

/** Timing belt over two pulleys: shows the length and tooth count before it is added. */
function BeltDialog({ ctx }: { ctx: DialogContext }) {
  const doc = ctx.view.document;
  const ownerOf = (p: Pick) => {
    const bodyId = p.kind === "body" ? p.id : p.kind === "face" || p.kind === "edge" ? p.ref.bodyId : undefined;
    return p.kind === "component" ? allComponents(doc).find((c) => c.id === p.id) : bodyId ? allComponents(doc).find((c) => componentOwns(c, bodyId)) : undefined;
  };
  const [pulleys, setPulleys] = useState<string[]>(() => [...new Set(ctx.initial.map(ownerOf).filter(Boolean).map((c) => c!.id))].slice(0, 2)),
    [info, setInfo] = useState<{ pitchLength: number; standardTeeth: number; standardLength: number; centerDistance: number; centerForStandard: number; belt: string } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    ctx.registerPicker((p) => {
      const c = ownerOf(p);
      if (!c?.source) return false;
      setPulleys((list) => (list.includes(c.id) ? list : [...list, c.id].slice(-2)));
      return true;
    });
    return () => ctx.registerPicker(null);
  }, []);
  useEffect(() => {
    setInfo(null);
    setError("");
    if (pulleys.length !== 2) return;
    void call("belt_length", { documentId: doc.id, pulleys })
      .then(setInfo)
      .catch((e) => setError((e as Error).message));
  }, [pulleys.join("|"), doc.revision]);
  const name = (id: string) => allComponents(doc).find((c) => c.id === id)?.name ?? id;
  return (
    <DialogShell
      ctx={ctx}
      title="Belt"
      icon="belt"
      command={null}
      ready={!!info}
      preview={false}
      acceptOverride={() => ctx.cad.execute<View>("create_belt", { pulleys })}
    >
      <SelectionBox
        label="Pulleys"
        placeholder="Select two timing pulleys"
        items={pulleys.map((id) => ({ key: id, label: name(id) }))}
        active
        onActivate={() => {}}
        onRemove={(key) => setPulleys(pulleys.filter((x) => x !== key))}
      />
      {error && <p className="pm-error">{error}</p>}
      {info && (
        <section>
          <div className="info-row">
            <span>Center distance</span>
            <b>{info.centerDistance.toFixed(2)} mm</b>
          </div>
          <div className="info-row">
            <span>Belt</span>
            <b>
              {info.belt} · {info.standardTeeth}T · {Math.round(info.standardLength)} mm
            </b>
          </div>
          <div className="info-row">
            <span>Centers for that belt</span>
            <b>{info.centerForStandard.toFixed(2)} mm</b>
          </div>
        </section>
      )}
    </DialogShell>
  );
}

/** Repeat an inserted part along a direction or about an axis. */
function PatternDialog({ ctx }: { ctx: DialogContext }) {
  const doc = ctx.view.document;
  const inserted = (p?: Pick) => {
    const bodyId = p?.kind === "body" ? p.id : p && (p.kind === "face" || p.kind === "edge") ? p.ref.bodyId : undefined;
    const c = p?.kind === "component" ? doc.components?.find((x) => x.id === p.id) : bodyId ? componentOf(ctx.view, bodyId) : undefined;
    return c?.source && doc.components?.some((x) => x.id === c.id) ? c : undefined;
  };
  const [componentId, setComponentId] = useState<string | undefined>(() => ctx.initial.map(inserted).find(Boolean)?.id);
  const [kind, setKind] = useState<"linear" | "circular">("circular"),
    [count, setCount] = useState(4),
    [spacing, setSpacing] = useState(20),
    [angle, setAngle] = useState(360),
    [axis, setAxis] = useState<"X" | "Y" | "Z">("Z"),
    [reverse, setReverse] = useState(false),
    [reference, setReference] = useState<Extract<Pick, { kind: "face" | "edge" }> | undefined>(undefined),
    [active, setActive] = useState<"component" | "reference">(componentId ? "reference" : "component");
  const state = useRef({ active, kind });
  state.current = { active, kind };
  useEffect(() => {
    ctx.registerPicker((p) => {
      if (state.current.active === "component") {
        const c = inserted(p);
        if (!c) return false;
        setComponentId(c.id);
        setActive("reference");
        return true;
      }
      if (p.kind !== "face" && p.kind !== "edge") return false;
      const t = ctx.view.geometry.bodies.flatMap((b) => b.topology).find((x) => x.id === p.ref.id);
      const fits = state.current.kind === "linear" ? t?.geomType === "LINE" : t?.geomType === "CIRCLE" || (t?.kind === "face" && t.geomType !== "PLANE" && !!t.axis);
      if (!fits) return false;
      setReference(p);
      return true;
    });
    return () => ctx.registerPicker(null);
  }, []);
  useEffect(() => {
    ctx.setHighlight({ refs: reference ? [reference.ref] : [], planes: [] });
  }, [reference?.ref.id]);
  const unitAxis = (a: "X" | "Y" | "Z", flip: boolean): Vec3 => (["X", "Y", "Z"].map((x) => (x === a ? (flip ? -1 : 1) : 0)) as Vec3);
  const command = componentId
    ? {
        tool: "pattern_component",
        arguments:
          kind === "linear"
            ? { componentId, kind, count, spacing, ...(reference ? { directionRef: strip(reference.ref) } : { direction: unitAxis(axis, reverse) }) }
            : { componentId, kind, count, angle, ...(reference ? { axisRef: strip(reference.ref) } : { axis: { origin: [0, 0, 0], direction: unitAxis(axis, reverse) } }) },
      }
    : null;
  const name = componentId ? doc.components?.find((c) => c.id === componentId)?.name : undefined;
  return (
    <DialogShell ctx={ctx} title="Component Pattern" icon="circularPattern" command={command}>
      <SelectionBox
        label="Component"
        active={active === "component"}
        placeholder="Select an inserted part"
        onActivate={() => setActive("component")}
        items={componentId ? [{ key: componentId, label: name ?? "Component" }] : []}
        onRemove={() => setComponentId(undefined)}
      />
      <Segmented
        label="Type"
        value={kind}
        options={[
          { value: "linear", label: "Linear" },
          { value: "circular", label: "Circular" },
        ]}
        onChange={(k) => {
          setKind(k);
          setReference(undefined);
        }}
      />
      <NumberField label="Instances" unit="" integer min={2} max={100} value={count} onChange={setCount} />
      {kind === "linear" ? <NumberField label="Spacing" min={0.001} value={spacing} onChange={setSpacing} /> : <NumberField label="Angle" unit="°" min={0.01} max={360} value={angle} onChange={setAngle} />}
      <SelectionBox
        label={kind === "linear" ? "Direction" : "Axis"}
        active={active === "reference"}
        placeholder={kind === "linear" ? "Select a straight edge, or use an axis below" : "Select a circular edge or cylindrical face, or use an axis below"}
        onActivate={() => setActive("reference")}
        items={reference ? [{ key: reference.ref.id, label: pickLabel(ctx.view, reference) }] : []}
        onRemove={() => setReference(undefined)}
      />
      {!reference && (
        <Segmented
          label={kind === "linear" ? "Along" : "About"}
          value={axis}
          options={[
            { value: "X", label: "X" },
            { value: "Y", label: "Y" },
            { value: "Z", label: "Z" },
          ]}
          onChange={setAxis}
        />
      )}
      {!reference && <Check label="Reverse direction" value={reverse} onChange={setReverse} />}
    </DialogShell>
  );
}

function ComponentDialog({ ctx }: { ctx: DialogContext }) {
  const doc = ctx.view.document;
  const free = doc.bodies.filter((b) => !componentOf(ctx.view, b.id));
  const [bodies, setBodies] = useState<string[]>(() => {
    const picked = ctx.initial.flatMap((p) => (p.kind === "body" ? [p.id] : p.kind === "face" || p.kind === "edge" ? [p.ref.bodyId] : []));
    const list = [...new Set(picked)].filter((id) => free.some((b) => b.id === id));
    return list.length ? list : free.slice(0, 1).map((b) => b.id);
  });
  const [name, setName] = useState("");
  const state = useRef(bodies);
  state.current = bodies;
  useEffect(() => {
    ctx.registerPicker((p) => {
      const id = p.kind === "body" ? p.id : p.kind === "face" || p.kind === "edge" ? p.ref.bodyId : undefined;
      if (!id || componentOf(ctx.view, id)) return false;
      setBodies(state.current.includes(id) ? state.current.filter((x) => x !== id) : [...state.current, id]);
      return true;
    });
    return () => ctx.registerPicker(null);
  }, []);
  const command = bodies.length
    ? {
        tool: "create_component",
        arguments: { bodyIds: bodies, grounded: !doc.components?.length, ...(name.trim() ? { name: name.trim() } : {}) },
      }
    : null;
  return (
    <DialogShell ctx={ctx} title="Component" icon="insert" command={command} preview={false}>
      <SelectionBox
        label="Bodies"
        active
        placeholder="Select solid bodies"
        onActivate={() => {}}
        items={bodies.map((id) => ({ key: id, label: doc.bodies.find((b) => b.id === id)?.name ?? "Body" }))}
        onRemove={(key) => setBodies(bodies.filter((x) => x !== key))}
      />
      <label className="field">
        <span>Name</span>
        <input value={name} placeholder={`Component ${(doc.components?.length ?? 0) + 1}`} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      {!doc.components?.length && <p className="muted">The first component is fixed in place.</p>}
    </DialogShell>
  );
}

export function AssemblyInspector({
  cad,
  view,
  selection,
  explode,
  onExplode,
  onAutoExplode,
}: {
  cad: Cad;
  view: View;
  selection: Pick[];
  explode: number;
  onExplode: (n: number) => void;
  onAutoExplode: () => void;
}) {
  const doc = view.document;
  const target = selection[0];
  const component = useMemo(() => {
    if (!target) return undefined;
    if (target.kind === "component") return doc.components?.find((c) => c.id === target.id);
    const bodyId = target.kind === "body" ? target.id : target.kind === "face" || target.kind === "edge" ? target.ref.bodyId : undefined;
    return bodyId ? componentOf(view, bodyId) : undefined;
  }, [target && pickId(target), doc.revision]);
  const mate = target?.kind === "mate" ? doc.mates?.find((m) => m.id === target.id) : undefined;
  const mated = component && isMated(view, component);
  // Where the mates put the component: shown and edited from there (its mates hold what they fix).
  const pose = useMemo(() => {
    if (!component) return { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 };
    const body = view.geometry.bodies.find((b) => componentOwns(component, b.id)),
      p = body && view.geometry.placements?.[body.id];
    const round = (x: number) => Math.round(x * 1e6) / 1e6;
    return p ? { position: p.position.map(round) as Vec3, rotation: eulerDegrees(p).map(round) as Vec3 } : { position: component.position, rotation: component.rotation };
  }, [component, view]);
  const partNames = Object.fromEntries(cad.documents.map((d) => [d.id, d.name]));
  return (
    <div className="inspector">
      <div className="inspector-body">
        {mate ? (
          <div className="props">
            <div className="props-title">
              <Icons.mate size={16} />
              <strong>{mate.name}</strong>
            </div>
            {view.geometry.mateStatus?.[mate.id]?.status !== "ok" && view.geometry.mateStatus?.[mate.id]?.message && (
              <p className="pm-error" role="status">
                {view.geometry.mateStatus[mate.id].message}
              </p>
            )}
            {mate.type === "gear" ? (
              <>
                <NumberField label="Ratio" unit="" value={mate.value} min={0.001} step={0.1} onChange={(value) => void cad.run("edit_mate", { mateId: mate.id, value })} />
                <NumberField label="Phase" unit="°" value={mate.phase ?? 0} step={1} onChange={(phase) => void cad.run("edit_mate", { mateId: mate.id, phase })} />
                <Check label="Same direction" value={mate.aligned} onChange={(aligned) => void cad.run("edit_mate", { mateId: mate.id, aligned })} />
              </>
            ) : (
              <Choice label="Mate type" value={mate.type} onChange={(type) => void cad.run("edit_mate", { mateId: mate.id, type })} options={[...mateTypes]} />
            )}
            {(mate.type === "distance" || mate.type === "angle") && (
              <NumberField label={mate.type === "angle" ? "Angle" : "Distance"} unit={mate.type === "angle" ? "°" : "mm"} value={mate.value} onChange={(value) => void cad.run("edit_mate", { mateId: mate.id, value })} />
            )}
            {mate.type !== "lock" && mate.type !== "gear" && <Check label="Aligned" value={mate.aligned} onChange={(aligned) => void cad.run("edit_mate", { mateId: mate.id, aligned })} />}
            <div className="props-actions">
              <button className="text-button" onClick={() => void cad.run("set_mate_suppressed", { mateId: mate.id, suppressed: !mate.suppressed })}>
                {mate.suppressed ? "Unsuppress" : "Suppress"}
              </button>
              <button className="text-button danger" onClick={() => void cad.run("delete_mate", { mateId: mate.id })}>
                Delete
              </button>
            </div>
          </div>
        ) : component && (component as ComponentInstance).patternOf ? (
          <div className="props">
            <div className="props-title">
              <Icons.circularPattern size={16} />
              <strong>{component.name}</strong>
            </div>
            <div className="info-row">
              <span>Pattern</span>
              <b>{doc.componentPatterns?.find((p) => p.id === (component as ComponentInstance).patternOf!.patternId)?.name}</b>
            </div>
            <p className="muted">Pattern instances follow their source component.</p>
          </div>
        ) : component ? (
          <div className="props">
            <div className="props-title">
              {component.belt ? <Icons.belt size={16} /> : component.source ? <Icons.insert size={16} /> : <Icons.component size={16} />}
              <strong>{component.name}</strong>
            </div>
            {(() => {
              const state = view.geometry.componentStatus?.[component.id];
              if (!state || state.status === "fixed") return null;
              if (state.status === "over")
                return (doc.mates ?? [])
                  .filter((m) => view.geometry.mateStatus?.[m.id]?.status === "over" && componentOwns(component, m.moving.bodyId))
                  .map((m) => (
                    <p className="pm-error" role="status" key={m.id}>
                      {view.geometry.mateStatus![m.id].message}
                    </p>
                  ));
              return (
                <div className="info-row">
                  <span>Degrees of freedom</span>
                  <b>{state.dof}</b>
                </div>
              );
            })()}
            {component.belt && (
              <>
                <div className="info-row">
                  <span>Belt</span>
                  <b>{view.geometry.bodies.find((b) => b.id === `${component.id}/belt`)?.name}</b>
                </div>
                <div className="info-row">
                  <span>Pulleys</span>
                  <b>{component.belt.pulleys.map((p) => allComponents(doc).find((x) => x.id === p)?.name ?? "?").join(", ")}</b>
                </div>
              </>
            )}
            {component.source && (
              <button className="link-row" title="Open the part document" onClick={() => void cad.open(component.source!.documentId)}>
                <span>Part</span>
                <b>{partNames[component.source.documentId] ?? "Open"}</b>
              </button>
            )}
            {!component.belt && <Check label="Fixed" value={component.grounded} disabled={!!mated} onChange={(grounded) => void cad.run("set_component_grounded", { componentId: component.id, grounded })} />}
            <section>
              <h4>Display</h4>
              <AppearanceFields
                cad={cad}
                objectId={component.id}
                color={component.display?.color ?? view.geometry.bodies.find((b) => componentOwns(component, b.id))?.color ?? "#544841"}
                opacity={component.display?.opacity}
                style={component.display?.style}
                texture={component.display?.texture}
              />
              {(component.display?.color || component.display?.texture) && (
                <button className="text-button" onClick={() => void cad.run("set_appearance", { objectId: component.id, reset: true })}>
                  Remove appearance
                </button>
              )}
              <Check label="Hidden" value={!!component.display?.hidden} onChange={(hidden) => void cad.run("set_visibility", { objectId: component.id, hidden })} />
              <Check label="Suppressed" value={!!component.suppressed} onChange={(suppressed) => void cad.run("set_component_suppressed", { componentId: component.id, suppressed })} />
            </section>
            <section>
              {!component.belt && (
                <>
                  <h4>Position</h4>
                  {(["X", "Y", "Z"] as const).map((axis, i) => (
                    <NumberField
                      key={axis}
                      label={axis}
                      value={pose.position[i]}
                      disabled={component.grounded}
                      onChange={(v) => void cad.run("set_component_transform", { componentId: component.id, position: pose.position.map((x, k) => (k === i ? v : x)), rotation: pose.rotation })}
                    />
                  ))}
                  <h4>Rotation</h4>
                  {(["X", "Y", "Z"] as const).map((axis, i) => (
                    <NumberField
                      key={axis}
                      label={axis}
                      unit="°"
                      value={pose.rotation[i]}
                      disabled={component.grounded}
                      onChange={(v) => void cad.run("set_component_transform", { componentId: component.id, position: pose.position, rotation: pose.rotation.map((x, k) => (k === i ? v : x)) })}
                    />
                  ))}
                </>
              )}
              <h4>Explode offset</h4>
              {(["X", "Y", "Z"] as const).map((axis, i) => (
                <NumberField
                  key={axis}
                  label={axis}
                  value={component.explode[i]}
                  onChange={(v) => void cad.run("set_explode_offset", { componentId: component.id, offset: component.explode.map((x, k) => (k === i ? v : x)) as Vec3 })}
                />
              ))}
            </section>
          </div>
        ) : (
          <div className="props">
            <h4>Bill of materials</h4>
            <table className="bom">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Component</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {bomLines(view, partNames).map((line, i) => (
                  <tr key={line.ids[0]}>
                    <td>{i + 1}</td>
                    <td>{line.name}</td>
                    <td>{line.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(doc.components?.length ?? 0) > 0 && (
              <>
                <h4>Exploded view</h4>
                <input aria-label="Explode" type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => onExplode(Number(e.target.value))} />
                <div className="props-actions">
                  <button className="text-button" onClick={onAutoExplode} title="Recompute offsets from the mates">
                    Auto explode
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
