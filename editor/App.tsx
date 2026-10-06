import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { SidebarResize } from "./SidebarResize.tsx";
import { ChevronDown, Redo2, Undo2, PanelLeft, PanelRight, Maximize2, Plus, FolderOpen, Download, Pencil, Upload, Check as CheckIcon } from "lucide-react";
import type { Component, Constraint, DisplayStyle, Frame, Geometry, Sketch, TopologyRef, Vec3, View } from "../cad/types.ts";
import { displayStyleIds, displayStyles } from "../cad/appearance.ts";
import { componentOf, componentOwns } from "../cad/types.ts";
import { useCad } from "./state.ts";
import { Icons, type IconName } from "./cad-icons.tsx";
import { Menu, type MenuItem } from "./ui.tsx";
import { Viewport, type ViewportHandle } from "./viewport/Viewport.tsx";
import type { SketchOp, SketchTool } from "./sketch/session.ts";
import { FeatureDialog, dialogForFeature, strip, type DialogKind, type Highlight, type Pick, principalNames } from "./panels/dialogs.tsx";
import { AssemblyDialog, AssemblyTree, AssemblyInspector, type AssemblyDialogKind } from "./panels/assembly.tsx";
import { FeatureTree, featureIcon, pickId, sketchesOf, sketchVisible } from "./panels/tree.tsx";
import { Inspector } from "./panels/inspector.tsx";
import { SectionPanel, defaultSection, sectionCut, type SectionState } from "./panels/section.tsx";
import { EquationsPanel } from "./panels/equations.tsx";
import { MassPanel } from "./panels/mass.tsx";
import { MotionPanel } from "./panels/motion.tsx";
import { CutListPanel } from "./panels/cutlist.tsx";
import { InterferencePanel } from "./panels/interference.tsx";
import { definitionOf } from "../cad/view-summary.ts";
import { SketchPatternPanel } from "./panels/sketch-pattern.tsx";
import { DrawingEditor, DrawingProperties, DrawingTree, type DrawingTool, type DrawingSelection } from "./drawing/DrawingEditor.tsx";
import { download, fullscreen } from "./bridge.ts";
import { formatMm } from "./sketch/model.ts";
import { formatLength, fromDisplay, setUnits, useUnits } from "./units.ts";
import { evaluate } from "./ui.tsx";
import { fileBase64, importAccept, isMesh, meshUnitNames } from "./file-data.ts";

type Mode = "part" | "assembly" | "drawing";
type DialogState = { kind: DialogKind | AssemblyDialogKind; featureId?: string; initial: Pick[]; key: number };
const assemblyKinds = new Set(["mate", "component", "insert", "pattern", "hole-series", "belt"]);

function Command({
  icon,
  label,
  onClick,
  disabled,
  active,
  title,
}: {
  icon: IconName;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
}) {
  const I = Icons[icon];
  return (
    <button className={`command ${active ? "on" : ""}`} disabled={disabled} aria-pressed={active} title={title ?? label} onClick={(e) => onClick(e)}>
      <I size={20} />
      <span>{label}</span>
    </button>
  );
}

interface CommandItem {
  key: string;
  icon: IconName;
  label: string;
  title?: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
}
/**
 * A category of related commands: the button carries the category's name and
 * opens a menu of the specific commands, as in CAD command bars.
 */
function DropdownCommand({ label, icon, items, openMenu }: { label: string; icon: IconName; items: CommandItem[]; openMenu: (x: number, y: number, items: MenuItem[]) => void }) {
  const I = Icons[icon],
    on = items.some((i) => i.active);
  return (
    <button
      className={`command dropdown ${on ? "on" : ""}`}
      aria-haspopup="menu"
      disabled={items.every((i) => i.disabled)}
      title={items.map((i) => i.label).join(", ")}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(
          r.left,
          r.bottom + 2,
          items.map((item) => {
            const Icon = Icons[item.icon];
            return { label: item.label, icon: <Icon size={16} />, disabled: item.disabled, shortcut: item.active ? "✓" : "", onSelect: () => item.onClick() };
          }),
        );
      }}
    >
      <I size={20} />
      <span>
        {label}
        <ChevronDown size={10} />
      </span>
    </button>
  );
}

/** View toolbar icons for the display styles. */
const styleIcons: Record<DisplayStyle, (typeof Icons)[IconName]> = {
  "shaded-edges": Icons.shadedEdges,
  shaded: Icons.shaded,
  "hidden-removed": Icons.hiddenRemoved,
  "hidden-visible": Icons.hiddenVisible,
  wireframe: Icons.wireframe,
};

export default function App() {
  const cad = useCad();
  const view = cad.view;
  const doc = view?.document;
  const [mode, setMode] = useState<Mode>("part"),
    [dialog, setDialog] = useState<DialogState | null>(null),
    [selection, setSelection] = useState<Pick[]>([]),
    [dialogHighlight, setDialogHighlight] = useState<Highlight | null>(null),
    [ghost, setGhost] = useState<Geometry | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [sketchTool, setSketchTool] = useState<SketchTool>("select"),
    [, bump] = useReducer((x: number) => x + 1, 0),
    [visiblePlanes, setVisiblePlanes] = useState<Set<string>>(new Set()),
    [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null),
    [valueEditor, setValueEditor] = useState<{ constraintId: string; value: string; length: boolean; x: number; y: number } | null>(null),
    [rightTab, setRightTab] = useState<"properties" | "history" | "intent">("properties"),
    [showLeft, setShowLeft] = useState(window.innerWidth > 640),
    [showRight, setShowRight] = useState(window.innerWidth > 980),
    [leftWidth, setLeftWidth] = useState(264),
    [rightWidth, setRightWidth] = useState(284),
    [hovered, setHovered] = useState<Pick | null>(null),
    [renaming, setRenaming] = useState(false),
    [explode, setExplode] = useState(0),
    [section, setSection] = useState<SectionState | null>(null),
    [sectionPanel, setSectionPanel] = useState(false),
    // The panel shown in place of the tree: equations, mass properties, motion check or cut list.
    [sidePanel, setSidePanel] = useState<"equations" | "mass" | "motion" | "cutlist" | "interference" | null>(null),
    // Isolate: only these components shown; display style and tangent edges (remembered on this computer).
    [isolated, setIsolated] = useState<string[] | null>(null),
    [displayStyle, setDisplayStyle] = useState<DisplayStyle>(() => {
      try {
        const saved = localStorage.getItem("vibe-display-style") as DisplayStyle | null;
        return saved && displayStyleIds.includes(saved) ? saved : "shaded-edges";
      } catch {
        return "shaded-edges";
      }
    }),
    [tangentEdges, setTangentEdges] = useState(() => {
      try {
        return localStorage.getItem("pivot-tangent-edges") !== "off";
      } catch {
        return true;
      }
    }),
    [commandTab, setCommandTab] = useState<Record<string, string>>({ part: "features", assembly: "assembly" }),
    [gitBranch, setGitBranch] = useState<string | null>(null),
    [drawingTool, setDrawingTool] = useState<DrawingTool>(null),
    [drawingSelection, setDrawingSelection] = useState<DrawingSelection>(null),
    [activeSheet, setActiveSheet] = useState<string | null>(null);
  setUnits(doc?.units ?? "mm");
  // The git branch, when designs live in a git project folder.
  useEffect(() => {
    if (!doc) return;
    void cad.execute<{ branch: string }>("git_status", {})
      .then(s => setGitBranch(s.branch))
      .catch(() => setGitBranch(null));
  }, [doc?.id, doc?.revision]);
  const units = useUnits();
  // Sketch labels are drawn by the sketch session, outside React.
  useEffect(() => {
    viewport.current?.session()?.rebuild();
  }, [units]);
  const pendingMode = useRef<Mode | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  /** Import a STEP or STL file as a new body of the open document. STL has no units, so ask for them. */
  const importFile = async (file: File, at?: { x: number; y: number }) => {
    const data = await fileBase64(file);
    if (!isMesh(file.name)) return void cad.run("import_step", { data, filename: file.name });
    const box = document.querySelector(".document-name")?.getBoundingClientRect();
    setMenu({
      x: at?.x ?? box?.left ?? 120,
      y: at?.y ?? (box ? box.bottom + 4 : 48),
      items: meshUnitNames.map(([units, label]) => ({
        label: `${file.name} in ${label.toLowerCase()}`,
        shortcut: units === (doc?.units ?? "mm") ? "✓" : "",
        onSelect: () => void cad.run("import_stl", { data, filename: file.name, units }),
      })),
    });
  };
  const viewport = useRef<ViewportHandle>(null),
    picker = useRef<((p: Pick) => boolean) | null>(null),
    syncedSelection = useRef<string>("[]"),
    cameraTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Per-document defaults: show the origin planes on an empty part; open
  // assemblies of inserted parts in the assembly workspace.
  const assemblyDocument = !!doc?.components?.some((c) => c.source) && !doc.features.length;
  useEffect(() => {
    if (!doc) return;
    setVisiblePlanes(new Set(doc.bodies.length || doc.sketches.length || assemblyDocument ? [] : ["XY", "XZ", "YZ"]));
    setSelection([]);
    setDialog(null);
    setEditing(null);
    setGhost(null);
    setSection(null);
    setSectionPanel(false);
    setActiveSheet(doc.drawings?.[0]?.id ?? null);
    if (pendingMode.current) setMode(pendingMode.current);
    else if (assemblyDocument) setMode("assembly");
    else if (!doc.components?.length) setMode((m) => (m === "assembly" ? "part" : m));
    pendingMode.current = null;
  }, [doc?.id]);
  // Origin planes help start an empty part; hide them once there is a body.
  const hadBodies = useRef(false);
  useEffect(() => {
    const has = !!doc?.bodies.length;
    if (has && !hadBodies.current)
      setVisiblePlanes((set) => new Set([...set].filter((id) => !["XY", "XZ", "YZ"].includes(id))));
    hadBodies.current = has;
  }, [doc?.bodies.length, doc?.id]);
  // Adopt selections made by the assistant (set_selection) and drop stale ones.
  useEffect(() => {
    if (!doc) return;
    const serverKey = JSON.stringify(doc.selection.map((r) => r.id));
    if (serverKey !== syncedSelection.current) {
      syncedSelection.current = serverKey;
      setSelection(doc.selection.map((ref) => ({ kind: ref.kind, ref }) as Pick));
      return;
    }
    const ids = new Set(view!.geometry.bodies.flatMap((b) => b.topology.map((t) => t.id)));
    setSelection((list) =>
      list.filter((p) =>
        p.kind === "face" || p.kind === "edge"
          ? ids.has(p.ref.id)
          : p.kind === "feature"
            ? doc.features.some((f) => f.id === p.id)
            : p.kind === "sketch"
              ? doc.sketches.some((s) => s.id === p.id)
              : p.kind === "body"
                ? doc.bodies.some((b) => b.id === p.id)
                : true,
      ),
    );
  }, [doc?.revision, JSON.stringify(doc?.selection)]);
  // Share the user's face/edge selection with the assistant.
  useEffect(() => {
    if (!doc) return;
    const refs = selection.flatMap((p) => (p.kind === "face" || p.kind === "edge" ? [strip(p.ref)] : []));
    const key = JSON.stringify(refs.map((r) => r.id));
    if (key === syncedSelection.current) return;
    const timer = setTimeout(() => {
      syncedSelection.current = key;
      void cad.execute("set_selection", { refs }).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [JSON.stringify(selection.map(pickId))]);

  const frames = view?.geometry.frames;
  const editingSketch = doc?.sketches.find((s) => s.id === editing);
  const editingFrame = editing ? frames?.sketches[editing] : undefined;
  useEffect(() => {
    if (editing && doc && !editingSketch) setEditing(null);
  }, [doc?.revision]);
  const consumed = useMemo(() => new Set(doc?.features.flatMap(sketchesOf) ?? []), [doc?.revision, doc?.id]);
  const visibleSketches = useMemo(() => {
    if (!doc || !frames) return [];
    const profileId = dialogHighlight?.profile?.sketchId;
    return doc.sketches
      .filter((s) => (sketchVisible(s, consumed.has(s.id)) && mode === "part") || s.id === profileId || selection.some((p) => p.kind === "sketch" && p.id === s.id))
      .filter((s) => frames.sketches[s.id])
      .map((sketch) => ({ sketch, frame: frames.sketches[sketch.id] }));
  }, [doc?.revision, doc?.id, frames, dialogHighlight?.profile?.sketchId, JSON.stringify(selection.map(pickId)), mode]);
  const planes = useMemo(() => {
    if (!doc) return [];
    const list: { id: string; name: string; frame: Frame }[] = [];
    const principal: Record<string, Frame> = {
      XY: { origin: [0, 0, 0], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
      XZ: { origin: [0, 0, 0], xDir: [1, 0, 0], yDir: [0, 0, 1], normal: [0, -1, 0] },
      YZ: { origin: [0, 0, 0], xDir: [0, 1, 0], yDir: [0, 0, 1], normal: [1, 0, 0] },
    };
    const wantPrincipal = dialog?.kind === "sketch" || ["plane", "mirror", "split", "draft"].includes(dialog?.kind ?? "");
    for (const id of ["XZ", "XY", "YZ"])
      if (visiblePlanes.has(id) || wantPrincipal || selection.some((p) => p.kind === "plane" && p.id === id) || dialogHighlight?.planes.includes(id))
        list.push({ id, name: principalNames[id].replace(" plane", ""), frame: principal[id] });
    for (const p of doc.referencePlanes ?? []) {
      const frame = frames?.planes[p.id];
      if (frame && (!p.hidden || visiblePlanes.has(p.id))) list.push({ id: p.id, name: p.name, frame });
    }
    return mode === "part" && !editing ? list : [];
  }, [doc?.revision, doc?.id, frames, visiblePlanes, dialog?.kind, JSON.stringify(selection.map(pickId)), dialogHighlight, mode, editing]);

  // -------------------------------------------------------------------------
  // Commands
  const openPanel = (panel: NonNullable<typeof sidePanel>) => {
    setDialog(null);
    setShowLeft(true);
    setSidePanel(panel);
  };
  const openEquations = () => openPanel("equations"),
    openMass = () => openPanel("mass"),
    openMotion = () => openPanel("motion");
  const equationsPanel = sidePanel === "equations",
    massPanel = sidePanel === "mass",
    motionPanel = sidePanel === "motion";
  const openDialog = (kind: DialogKind | AssemblyDialogKind, featureId?: string, initial: Pick[] = selection) => {
    if (!view) return;
    setSidePanel(null);
    setEditing(null);
    setGhost(null);
    setDialogHighlight(null);
    setShowLeft(true);
    setDialog({ kind, featureId, initial, key: Date.now() });
  };
  const closeDialog = (result?: View) => {
    setDialog(null);
    setGhost(null);
    setDialogHighlight(null);
    picker.current = null;
    if (result) setSelection([]);
  };
  const startSketch = async (target?: Pick) => {
    if (!view) return;
    const t = target ?? selection.find((p) => p.kind === "plane" || (p.kind === "face" && view.geometry.bodies.flatMap((b) => b.topology).find((x) => x.id === p.ref.id)?.geomType === "PLANE"));
    if (!t) {
      openDialog("sketch");
      return;
    }
    const args =
      t.kind === "plane"
        ? ["XY", "XZ", "YZ"].includes(t.id)
          ? { plane: t.id }
          : { referencePlaneId: t.id }
        : t.kind === "face"
          ? { support: strip(t.ref) }
          : null;
    if (!args) return;
    try {
      const v = await cad.execute<View>("create_sketch", args);
      const sketch = v.document.sketches.at(-1)!;
      closeDialog();
      setSelection([]);
      setSketchTool("line");
      setEditing(sketch.id);
    } catch (e) {
      cad.setError((e as Error).message);
    }
  };
  const editSketch = (id: string) => {
    closeDialog();
    setSelection([]);
    setSketchTool("select");
    setEditing(id);
    if (mode !== "part") setMode("part");
  };
  const exitSketch = () => {
    const id = editing;
    setEditing(null);
    setSketchTool("select");
    if (id) setSelection([{ kind: "sketch", id }]);
  };
  const editFeature = (featureId: string) => {
    const f = doc?.features.find((x) => x.id === featureId);
    if (!f) return;
    const kind = dialogForFeature(f);
    if (kind) openDialog(kind, f.id, []);
  };
  const deleteSelection = () => {
    for (const p of selection) {
      if (p.kind === "feature" || p.kind === "sketch") void cad.run("delete_feature", { featureId: p.id });
      if (p.kind === "plane" && doc?.referencePlanes?.some((x) => x.id === p.id))
        cad.setError("Delete datum planes by undoing their creation; sketches may depend on them.");
    }
  };
  const exportAs = async (format: "step" | "stl" | "json" | "edit", bodyId?: string) => {
    try {
      const result = await cad.execute("export_file", { format, ...(bodyId ? { bodyId } : {}) });
      if (!result.data) cad.setError(`Saved ${result.filename} to ${result.path}`);
      else await download(result);
    } catch (e) {
      cad.setError((e as Error).message);
    }
  };

  // -------------------------------------------------------------------------
  // Picking
  const onPick = (pick: Pick | null, additive: boolean) => {
    if ((dialog || massPanel || motionPanel) && pick && picker.current?.(pick)) return;
    if (dialog && !pick) return;
    if (!pick) {
      if (!additive) setSelection([]);
      return;
    }
    setSelection((list) => {
      const id = pickId(pick),
        exists = list.some((p) => pickId(p) === id);
      if (additive) return exists ? list.filter((p) => pickId(p) !== id) : [...list, pick];
      return exists && list.length === 1 ? [] : [pick];
    });
  };
  const ownerOf = (p: Pick | null) =>
    p && (p.kind === "face" || p.kind === "edge") ? view?.geometry.bodies.flatMap((b) => b.topology).find((t) => t.id === p.ref.id)?.featureId : undefined;
  const onDoubleClick = (pick: Pick | null) => {
    if (!pick) {
      viewport.current?.orient("fit");
      return;
    }
    if (pick.kind === "sketch") return editSketch(pick.id);
    if (pick.kind === "sketchLine") return editSketch(pick.sketchId);
    if (pick.kind === "feature") return editFeature(pick.id);
    const owner = ownerOf(pick);
    if (owner) editFeature(owner);
  };
  const contextItems = (pick: Pick | null): MenuItem[] => {
    const items: MenuItem[] = [];
    const add = (label: string, icon: IconName, onSelect: () => void, disabled = false) => {
      const I = Icons[icon];
      items.push({ label, icon: <I size={16} />, onSelect, disabled });
    };
    const sep = () => items.length && !items.at(-1)!.separator && items.push({ label: "", separator: true });
    if (!view || !doc) return items;
    const withSelection = (p: Pick) => {
      const id = pickId(p);
      return selection.some((x) => pickId(x) === id) ? selection : [p];
    };
    if (pick?.kind === "face") {
      const t = view.geometry.bodies.flatMap((b) => b.topology).find((x) => x.id === pick.ref.id);
      const planar = t?.geomType === "PLANE";
      if (planar) add("Sketch", "sketch", () => void startSketch(pick));
      if (planar) add("Hole", "hole", () => openDialog("hole", undefined, [pick]));
      add("Fillet", "fillet", () => openDialog("fillet", undefined, withSelection(pick)));
      add("Shell", "shell", () => openDialog("shell", undefined, withSelection(pick)));
      add("Draft", "draft", () => openDialog("draft", undefined, withSelection(pick)));
      if (planar) add("Move Face", "moveFace", () => openDialog("move-face", undefined, withSelection(pick)));
      if (t?.geomType === "CYLINDRE") add("Thread", "thread", () => openDialog("thread", undefined, [pick]));
      sep();
      if (planar) add("Plane", "plane", () => openDialog("plane", undefined, [pick]));
      if (planar && t?.normal) add("Normal to", "normalTo", () => viewport.current?.lookAlong(t.normal!));
      if (planar) add("Export DXF", "sheet", () => void exportFaceDxf(pick.ref));
      const owner = ownerOf(pick);
      if (owner) {
        sep();
        add(`Edit ${doc.features.find((f) => f.id === owner)?.name}`, featureIcon(doc.features.find((f) => f.id === owner)!), () => editFeature(owner));
      }
    } else if (pick?.kind === "edge") {
      const t = view.geometry.bodies.flatMap((b) => b.topology).find((x) => x.id === pick.ref.id);
      add("Fillet", "fillet", () => openDialog("fillet", undefined, withSelection(pick)));
      add("Chamfer", "chamfer", () => openDialog("chamfer", undefined, withSelection(pick)));
      if (t?.geomType === "CIRCLE") add("Circular pattern", "circularPattern", () => openDialog("circular-pattern", undefined, [pick]));
      add("Plane normal to edge", "plane", () => openDialog("plane", undefined, [pick]));
      const owner = ownerOf(pick);
      if (owner) {
        sep();
        add(`Edit ${doc.features.find((f) => f.id === owner)?.name}`, featureIcon(doc.features.find((f) => f.id === owner)!), () => editFeature(owner));
      }
    } else if (pick?.kind === "plane" && pick.id !== "origin" && pick.id !== "bodies") {
      add("Sketch", "sketch", () => void startSketch(pick));
      add("Offset plane", "plane", () => openDialog("plane", undefined, [pick]));
      add("Mirror", "mirror", () => openDialog("mirror", undefined, [pick]));
      add("Split", "split", () => openDialog("split", undefined, [pick]));
      sep();
      const isDatum = doc.referencePlanes?.find((p) => p.id === pick.id);
      const shown = visiblePlanes.has(pick.id) || (isDatum && !isDatum.hidden);
      add(shown ? "Hide" : "Show", "plane", () => togglePlane(pick.id));
    } else if (pick?.kind === "feature") {
      const f = doc.features.find((x) => x.id === pick.id);
      if (!f) return items;
      add("Edit feature", featureIcon(f), () => editFeature(f.id), !dialogForFeature(f));
      const sk = sketchesOf(f)[0];
      if (sk) add("Edit sketch", "sketch", () => editSketch(sk));
      sep();
      add(f.suppressed ? "Unsuppress" : "Suppress", featureIcon(f), () => void cad.run("suppress_feature", { featureId: f.id, suppressed: !f.suppressed }));
      add("Rename", "note", () => {
        setSelection([pick]);
        setShowRight(true);
        setRightTab("properties");
      });
      items.push({ label: "Delete", danger: true, onSelect: () => void cad.run("delete_feature", { featureId: f.id }) });
    } else if (pick?.kind === "sketch" || pick?.kind === "sketchLine") {
      const id = pick.kind === "sketch" ? pick.id : pick.sketchId;
      const s = doc.sketches.find((x) => x.id === id);
      add("Edit sketch", "sketch", () => editSketch(id));
      add("Extrude", "extrude", () => openDialog("extrude", undefined, [{ kind: "sketch", id }]));
      add("Cut-Extrude", "cut", () => openDialog("cut", undefined, [{ kind: "sketch", id }]), !doc.bodies.length);
      add("Revolve", "revolve", () => openDialog("revolve", undefined, [{ kind: "sketch", id }, ...(pick.kind === "sketchLine" ? [pick] : [])]));
      sep();
      if (s) add(sketchVisible(s, consumed.has(s.id)) ? "Hide" : "Show", "sketch", () => void cad.run("set_visibility", { objectId: s.id, hidden: sketchVisible(s, consumed.has(s.id)) }));
      if (s && !consumed.has(s.id)) items.push({ label: "Delete", danger: true, onSelect: () => void cad.run("delete_feature", { featureId: s.id }) });
    } else if (pick?.kind === "body") {
      const b = doc.bodies.find((x) => x.id === pick.id);
      if (!b) return items;
      add("Fillet all edges", "fillet", () => openDialog("fillet", undefined, [pick]));
      add("Move/Copy", "move", () => openDialog("move", undefined, [pick]));
      add("Linear pattern", "linearPattern", () => openDialog("linear-pattern", undefined, []));
      add("Split", "split", () => openDialog("split", undefined, [pick]));
      sep();
      add(b.hidden ? "Show" : "Hide", "component", () => void cad.run("set_visibility", { objectId: b.id, hidden: !b.hidden }));
      add("Export STEP", "component", () => void exportAs("step", b.id));
      add("Export STL", "component", () => void exportAs("stl", b.id));
    } else {
      add("Front", "normalTo", () => viewport.current?.orient("front"));
      add("Top", "normalTo", () => viewport.current?.orient("top"));
      add("Right", "normalTo", () => viewport.current?.orient("right"));
      add("Isometric", "component", () => viewport.current?.orient("iso"));
      add("Zoom to fit", "detailView", () => viewport.current?.orient("fit"));
      sep();
      const all = ["XY", "XZ", "YZ"].every((id) => visiblePlanes.has(id));
      add(all ? "Hide origin planes" : "Show origin planes", "plane", () => setVisiblePlanes(all ? new Set() : new Set(["XY", "XZ", "YZ"])));
    }
    return items;
  };
  const togglePlane = (id: string) => {
    const datum = doc?.referencePlanes?.find((p) => p.id === id);
    if (datum && !visiblePlanes.has(id)) {
      void cad.run("set_visibility", { objectId: id, hidden: !datum.hidden });
      return;
    }
    setVisiblePlanes((set) => {
      const next = new Set(set);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // -------------------------------------------------------------------------
  // Keyboard
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void cad.run(e.shiftKey ? "redo" : "undo");
        return;
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void cad.run("redo");
        return;
      }
      if (menu) return;
      const session = viewport.current?.session();
      if (editing && session) {
        if (e.key === "Escape" && session.tool === "select" && !session.selection.entities.size && !session.selection.points.length && !session.selection.constraints.size) {
          exitSketch();
          return;
        }
        if (session.keyDown(e)) {
          e.preventDefault();
          setSketchTool(session.tool);
          bump();
          return;
        }
      }
      if (dialog) return;
      if (e.key === "Escape") setSelection([]);
      if (e.key.toLowerCase() === "f" && !meta) viewport.current?.orient("fit");
      if ((e.key === "Delete" || e.key === "Backspace") && !editing) deleteSelection();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  // -------------------------------------------------------------------------
  const session = viewport.current?.session();
  const highlight = dialog || ((massPanel || motionPanel) && dialogHighlight)
    ? { refs: dialogHighlight?.refs ?? [], planes: dialogHighlight?.planes ?? [] }
    : {
        refs: selection.flatMap((p) => (p.kind === "face" || p.kind === "edge" ? [p.ref] : [])),
        planes: selection.flatMap((p) => (p.kind === "plane" ? [p.id] : [])),
      };
  const treeSelected = new Set(
    (dialog ? [] : selection).map(pickId).concat(dialogHighlight?.profile ? [dialogHighlight.profile.sketchId] : []),
  );
  const ctx = dialog && view && !assemblyKinds.has(dialog.kind)
    ? {
        cad,
        view,
        featureId: dialog.featureId,
        initial: dialog.initial,
        registerPicker: (h: ((p: Pick) => boolean) | null) => {
          picker.current = h;
        },
        setHighlight: setDialogHighlight,
        setPreview: setGhost,
        close: closeDialog,
      }
    : null;
  const sketchStatus = !editingSketch?.entities.length
    ? ""
    : editingSketch.solver.dof === 0
      ? "Fully defined"
      : `Under defined · ${editingSketch.solver.dof} DOF`;
  const selectionStatus = selection.length
    ? `${selection.length} ${selection.length === 1 ? selection[0].kind.replace("sketchLine", "line") : "items"} selected`
    : "";
  // Fully, under or over defined, as SolidWorks' status bar says it; the details on hover.
  const definition = useMemo(() => (view ? definitionOf(view) : undefined), [view]);
  const definitionStatus = definition ? { full: "Fully Defined", under: "Under Defined", over: "Over Defined" }[definition.status] : "";
  const components = doc?.components ?? [];
  // Isolate: every body outside the isolated components is left out of the view.
  const isolatedHidden = useMemo(() => {
    if (!isolated || !view) return undefined;
    const keep = components.filter((c) => isolated.includes(c.id));
    return new Set(view.geometry.bodies.filter((b) => !keep.some((c) => componentOwns(c, b.id))).map((b) => b.id));
  }, [isolated, view]);
  /** Bodies of a component as displayed: its own bodies or its part's instances. */
  const bodiesOf = (c: Component) => (view?.geometry.bodies ?? []).filter((b) => componentOwns(c, b.id)).map((b) => b.id);
  const explodeOffsets = useMemo(() => {
    const out: Record<string, Vec3> = {};
    for (const b of view?.geometry.bodies ?? []) {
      const c = doc && componentOf(doc, b.id);
      if (c) out[b.id] = c.explode;
    }
    return out;
  }, [JSON.stringify(components), view?.geometry.bodies.length]);

  const tool = (t: SketchTool, icon: IconName, label: string, title = label): CommandItem => ({
    key: t,
    icon,
    label,
    title: editing ? title : `${title}: start or edit a sketch first`,
    disabled: !editing,
    active: !!editing && sketchTool === t,
    onClick: () => setSketchTool(sketchTool === t ? "select" : t),
  });
  const sketchBar: BarEntry[] = [
    tool("line", "line", "Line", "Line (L)"),
    { group: "Rectangle", icon: "rectangle", items: [tool("rectangle", "rectangle", "Corner Rectangle", "Corner rectangle (R)"), tool("centerRectangle", "centerRectangle", "Center Rectangle")] },
    tool("circle", "circle", "Circle", "Circle (C)"),
    { group: "Arc", icon: "arc", items: [tool("arc", "arc", "3 Point Arc", "3 point arc (A)"), tool("tangentArc", "tangentArc", "Tangent Arc")] },
    tool("polygon", "polygon", "Polygon", "Polygon (G)"),
    tool("slot", "slot", "Slot"),
    tool("spline", "spline", "Spline"),
    tool("point", "point", "Point", "Point (P)"),
  ];
  type BarEntry = null | CommandItem | { group: string; icon: IconName; items: CommandItem[] };
  const feature = (kind: DialogKind, icon: IconName, label: string, disabled?: boolean): CommandItem => ({
    key: kind,
    icon,
    label,
    disabled,
    active: dialog?.kind === kind,
    onClick: () => openDialog(kind),
  });
  const noBodies = !doc?.bodies.length,
    noSketches = !doc?.sketches.length;
  const sketchStart: CommandItem = { key: "sketch", icon: "sketch", label: "Sketch", active: dialog?.kind === "sketch", onClick: () => void startSketch() };
  const sheetBodies = doc?.features.filter((f) => f.type === "sheet" && !f.suppressed) ?? [];
  const selectedFace = selection.find((p): p is Extract<Pick, { kind: "face" }> => p.kind === "face" && view?.geometry.bodies.flatMap((b) => b.topology).find((t) => t.id === p.ref.id)?.geomType === "PLANE");
  const sectionItem: CommandItem = {
    key: "section",
    icon: "section3d",
    label: "Section View",
    active: !!section,
    disabled: !view?.geometry.bodies.length,
    onClick: () => {
      if (section) {
        setSection(null);
        setSectionPanel(false);
      } else if (view) {
        setSection(defaultSection(view.geometry));
        setSectionPanel(true);
        setShowLeft(true);
      }
    },
  };
  // Part commands by tab, as in a CAD command manager: related tools side by side.
  const partTabs: Record<string, BarEntry[]> = {
    features: [
      sketchStart,
      null,
      feature("extrude", "extrude", "Extrude", noSketches),
      feature("cut", "cut", "Cut", noBodies || noSketches),
      feature("revolve", "revolve", "Revolve", noSketches),
      feature("sweep", "sweep", "Sweep", (doc?.sketches.length ?? 0) < 2),
      feature("loft", "loft", "Loft", (doc?.sketches.length ?? 0) < 2),
      null,
      { group: "Edges", icon: "fillet", items: [feature("fillet", "fillet", "Fillet", noBodies), feature("chamfer", "chamfer", "Chamfer", noBodies)] },
      feature("shell", "shell", "Shell", noBodies),
      feature("draft", "draft", "Draft", noBodies),
      feature("rib", "rib", "Rib", noBodies || noSketches),
      { group: "Holes", icon: "hole", items: [feature("hole", "hole", "Hole Wizard", noBodies), feature("thread", "thread", "Thread", noBodies)] },
      { group: "Drives", icon: "gear", items: [feature("gear", "gear", "Spur Gear"), feature("pulley", "pulley", "Timing Pulley")] },
      null,
      {
        group: "Pattern",
        icon: "linearPattern",
        items: [feature("linear-pattern", "linearPattern", "Linear Pattern", noBodies), feature("circular-pattern", "circularPattern", "Circular Pattern", noBodies)],
      },
      feature("mirror", "mirror", "Mirror", noBodies),
      null,
      {
        group: "Body",
        icon: "combine",
        items: [
          feature("combine", "combine", "Combine", (doc?.bodies.length ?? 0) < 2),
          feature("split", "split", "Split", noBodies),
          feature("move", "move", "Move/Copy", noBodies),
          feature("scale", "scale", "Scale", noBodies),
          feature("move-face", "moveFace", "Move Face", noBodies),
          { key: "import", icon: "insert", label: "Import…", title: "Import a STEP or STL file as a body", disabled: !doc, onClick: () => importInput.current?.click() },
        ],
      },
      feature("plane", "plane", "Plane"),
    ],
    sheet: [
      sketchStart,
      null,
      feature("base-flange", "baseFlange", "Base Flange", noSketches),
      feature("edge-flange", "edgeFlange", "Edge Flange", !sheetBodies.length),
      feature("hem", "hem", "Hem", !sheetBodies.length),
      feature("closed-corner", "closedCorner", "Closed Corner", !doc?.features.some((f) => f.type === "flange" && !f.params.hem)),
      feature("bend", "bend", "Sketched Bend", !sheetBodies.length),
      null,
      {
        group: "Export",
        icon: "sheet",
        items: [
          {
            key: "flat-dxf",
            icon: "sheet",
            label: "Flat Pattern DXF",
            disabled: !sheetBodies.length,
            onClick: () =>
              void cad
                .execute("flat_pattern", { bodyId: sheetBodies[0].bodyId, export: true })
                .then(async (result) => (!result.data ? cad.setError(`Saved ${result.filename} to ${result.path}`) : download(result)))
                .catch((e) => cad.setError((e as Error).message)),
          },
          {
            key: "plate-dxf",
            icon: "sheet",
            label: selectedFace ? "Face Outline DXF" : "Face Outline DXF (select a flat face)",
            disabled: !selectedFace,
            onClick: () => selectedFace && void exportFaceDxf(selectedFace.ref),
          },
        ],
      },
    ],
    weldments: [
      sketchStart,
      null,
      feature("member", "member", "Structural Member", noSketches),
      feature("weld", "weld", "Weld Bead", noBodies),
      null,
      { key: "cutlist", icon: "cutList", label: "Cut List", disabled: !doc?.features.some((f) => f.type === "member"), active: sidePanel === "cutlist", onClick: () => openPanel("cutlist") },
    ],
    evaluate: [
      { key: "mass", icon: "mass", label: "Mass Properties", disabled: noBodies, active: massPanel, onClick: () => openMass() },
      { key: "equations", icon: "equations", label: "Equations", active: equationsPanel, onClick: () => openEquations() },
      sectionItem,
    ],
  };
  const assemblyTabs: Record<string, BarEntry[]> = {
    assembly: [
      { key: "insert", icon: "insert", label: "Insert Part", onClick: () => openDialog("insert", undefined, []) },
      {
        key: "component",
        icon: "component",
        label: "New Component",
        title: "Group bodies of this document into a component",
        disabled: !doc?.bodies.some((b) => !components.some((c) => componentOwns(c, b.id))),
        onClick: () => openDialog("component"),
      },
      null,
      { key: "mate", icon: "mate", label: "Mate", disabled: components.length < 2, onClick: () => openDialog("mate") },
      { key: "pattern", icon: "circularPattern", label: "Pattern", title: "Pattern an inserted part", disabled: !components.some((c) => c.source), onClick: () => openDialog("pattern") },
      { key: "belt", icon: "belt", label: "Belt", title: "Timing belt over two pulleys", disabled: components.filter((c) => c.source).length < 2, active: dialog?.kind === "belt", onClick: () => openDialog("belt") },
      { key: "hole-series", icon: "hole", label: "Hole Series", title: "Aligned holes through stacked parts", disabled: !components.some((c) => c.source), active: dialog?.kind === "hole-series", onClick: () => openDialog("hole-series") },
      null,
      { key: "explode", icon: "explode", label: "Explode", active: explode > 0, disabled: !components.length, onClick: () => void toggleExplode() },
      { key: "bom", icon: "bom", label: "BOM", disabled: !components.length, onClick: () => { setShowRight(true); setRightTab("properties"); setSelection([]); } },
    ],
    evaluate: [
      { key: "interference", icon: "interference", label: "Interference", disabled: components.length < 2, active: sidePanel === "interference", onClick: () => openPanel("interference") },
      { key: "motion", icon: "motion", label: "Motion Check", disabled: !components.length, active: motionPanel, onClick: () => openMotion() },
      { key: "mass", icon: "mass", label: "Mass Properties", disabled: !view?.geometry.bodies.length, active: massPanel, onClick: () => openMass() },
      sectionItem,
    ],
  };
  const tabNames: Record<string, string> = { sketch: "Sketch", features: "Features", sheet: "Sheet Metal", weldments: "Weldments", evaluate: "Evaluate", assembly: "Assembly" };
  const tabsFor = mode === "part" ? ["sketch", ...Object.keys(partTabs)] : mode === "assembly" ? Object.keys(assemblyTabs) : [];
  // Editing a sketch always shows the sketch tools.
  const tab = editing ? "sketch" : (commandTab[mode] ?? tabsFor[0]);
  const renderBar = (entries: BarEntry[]): ReactNode =>
    entries.map((e, i) =>
      e === null ? (
        <span className="command-gap" key={`gap${i}`} />
      ) : "group" in e ? (
        <DropdownCommand key={e.group} label={e.group} icon={e.icon} items={e.items} openMenu={(x, y, items) => setMenu({ x, y, items })} />
      ) : (
        <Command key={e.key} icon={e.icon} label={e.label} title={e.title} disabled={e.disabled} active={e.active} onClick={() => e.onClick()} />
      ),
    );
  const commandBar = (): ReactNode => {
    if (!view) return null;
    if (mode === "drawing") {
      const has = !!activeSheet;
      const toolOn = (kind: string) => drawingTool?.kind === kind;
      const set = (t: DrawingTool) => setDrawingTool(drawingTool && t && drawingTool.kind === t.kind ? null : t);
      const menuAt = (e: React.MouseEvent, items: MenuItem[]) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setMenu({ x: r.left, y: r.bottom + 4, items });
      };
      return (
        <>
          <Command icon="sheet" label="New Sheet" disabled={!view.geometry.bodies.length} onClick={() => newSheet()} />
          <span className="command-gap" />
          <Command
            icon="drawingView"
            label="Model View"
            active={toolOn("model")}
            disabled={!has}
            onClick={(e?: any) =>
              menuAt(
                e,
                (["front", "top", "right", "back", "bottom", "left", "iso", "dimetric", "trimetric"] as const).map((o) => ({
                  label: o === "iso" ? "Isometric" : o[0].toUpperCase() + o.slice(1),
                  icon: <Icons.drawingView size={15} />,
                  onSelect: () => setDrawingTool({ kind: "model", orientation: o }),
                })),
              )
            }
          />
          <Command icon="projectedView" label="Projected" active={toolOn("projected")} disabled={!has} onClick={() => set({ kind: "projected" })} />
          <Command
            icon="sectionView"
            label="Section"
            active={toolOn("section")}
            disabled={!has}
            onClick={(e?: any) =>
              menuAt(e, [
                { label: "Horizontal cut", icon: <Icons.sectionView size={15} />, onSelect: () => setDrawingTool({ kind: "section", axis: "horizontal" }) },
                { label: "Vertical cut", icon: <Icons.sectionView size={15} />, onSelect: () => setDrawingTool({ kind: "section", axis: "vertical" }) },
              ])
            }
          />
          <Command icon="detailView" label="Detail" active={toolOn("detail")} disabled={!has} onClick={() => set({ kind: "detail" })} />
          {doc?.features.some((f) => f.type === "sheet" && !f.suppressed) && (
            <Command icon="edgeFlange" label="Flat Pattern" title="Flat pattern view of a sheet metal body" active={toolOn("flat")} disabled={!has} onClick={() => set({ kind: "flat" })} />
          )}
          <span className="command-gap" />
          <Command icon="dimension" label="Dimension" active={toolOn("dimension")} disabled={!has} onClick={() => set({ kind: "dimension" })} />
          <Command icon="ordinate" label="Ordinate" title="Ordinate dimensions from a zero" active={toolOn("ordinate")} disabled={!has} onClick={() => set({ kind: "ordinate" })} />
          <Command icon="holeCallout" label="Hole Callout" active={toolOn("hole")} disabled={!has} onClick={() => set({ kind: "hole" })} />
          <Command icon="centerMark" label="Center Mark" active={toolOn("centermark")} disabled={!has} onClick={() => set({ kind: "centermark" })} />
          <Command icon="centerline" label="Centerline" active={toolOn("centerline")} disabled={!has} onClick={() => set({ kind: "centerline" })} />
          <span className="command-gap" />
          <Command icon="note" label="Note" active={toolOn("note")} disabled={!has} onClick={() => set({ kind: "note" })} />
          <Command icon="balloon" label="Balloon" active={toolOn("balloon")} disabled={!has} onClick={() => set({ kind: "balloon" })} />
          <Command icon="bom" label="BOM" active={toolOn("bom")} disabled={!has} onClick={() => set({ kind: "bom" })} />
          <Command icon="surfaceFinish" label="Surface" active={toolOn("surface")} disabled={!has} onClick={() => set({ kind: "surface" })} />
          <Command icon="datum" label="Datum" active={toolOn("datum")} disabled={!has} onClick={() => set({ kind: "datum" })} />
          <Command icon="gdt" label="Tolerance" title="Geometric tolerance" active={toolOn("gdt")} disabled={!has} onClick={() => set({ kind: "gdt" })} />
          {doc?.features.some((f) => (f.type === "weld" || f.type === "member") && !f.suppressed) && (
            <Command icon="weld" label="Weld" title="Weld symbol" active={toolOn("weld")} disabled={!has} onClick={() => set({ kind: "weld" })} />
          )}
        </>
      );
    }
    if (mode === "assembly") return renderBar(assemblyTabs[tab] ?? assemblyTabs.assembly);
    if (tab === "sketch")
      return (
        <>
          {!editing && renderBar([sketchStart, null])}
          {renderBar([
            ...sketchBar,
            null,
            { key: "construction", icon: "construction", label: "Construction", title: "Construction geometry (X)", disabled: !editing, active: !!editing && !!session?.construction, onClick: () => { session?.toggleConstruction(); bump(); } },
            tool("trim", "trim", "Trim", "Power trim (T)"),
            tool("offset", "offset", "Offset", "Offset entities"),
            tool("convert", "convert", "Convert", "Convert model edges into the sketch"),
            tool("mirror", "sketchMirror", "Mirror", "Mirror entities about a line"),
            tool("pattern", "linearPattern", "Pattern", "Linear or circular sketch pattern"),
            { group: "Corners", icon: "sketchFillet", items: [tool("fillet", "sketchFillet", "Sketch Fillet"), tool("chamfer", "chamfer", "Sketch Chamfer")] },
            tool("dimension", "dimension", "Dimension", "Smart dimension (D)"),
          ])}
          <span className="command-spacer" />
          {editing && (
            <button className="finish-sketch" onClick={exitSketch} title="Exit sketch">
              <CheckIcon size={16} /> Exit Sketch
            </button>
          )}
        </>
      );
    return renderBar(partTabs[tab] ?? partTabs.features);
  };
  const newSheet = () => {
    if (!view) return;
    const bodies = view.geometry.bodies.filter((b) => !b.hidden);
    if (!bodies.length) return;
    const span = Math.max(...bodies.flatMap((b) => b.bounds[1].map((v, i) => v - b.bounds[0][i])));
    // Largest standard scale that keeps the four standard views on an A4/A3 sheet.
    const size = span > 160 ? "A3" : "A4";
    const room = size === "A3" ? 110 : 75;
    const standard = [5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02];
    const scale = standard.find((s) => s * span <= room) ?? 0.01;
    void cad
      .execute<View>("create_drawing", { name: `Sheet ${(doc?.drawings?.length ?? 0) + 1}`, bodyIds: bodies.map((b) => b.id), scale, size, title: doc?.name ?? "" })
      .then((v) => {
        setActiveSheet(v.document.drawings?.at(-1)?.id ?? null);
        setDrawingSelection({ kind: "sheet" });
      })
      .catch((e) => cad.setError(e.message));
  };
  // Exploded view: collapse or explode with a short transition; the first
  // explode computes offsets when none are set.
  const explodeFrame = useRef(0);
  const animateExplode = (to: number) => {
    cancelAnimationFrame(explodeFrame.current);
    const from = explode,
      start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 420);
      setExplode(from + (to - from) * (t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2));
      if (t < 1) explodeFrame.current = requestAnimationFrame(step);
    };
    explodeFrame.current = requestAnimationFrame(step);
  };
  const toggleExplode = async () => {
    if (explode > 0) return animateExplode(0);
    if (components.every((c) => c.explode.every((x) => x === 0)) && !(await cad.run("auto_explode"))) return;
    animateExplode(1);
  };

  // -------------------------------------------------------------------------
  const assemblyGizmo = useMemo(() => {
    if (mode !== "assembly" || dialog) return undefined;
    const sel = selection.find((p) => p.kind === "body" || p.kind === "face" || p.kind === "edge" || p.kind === "component");
    const bodyId = sel?.kind === "body" ? sel.id : sel && (sel.kind === "face" || sel.kind === "edge") ? sel.ref.bodyId : undefined;
    const c = components.find((x) => (bodyId && componentOwns(x, bodyId)) || (sel?.kind === "component" && x.id === sel.id));
    // Mated parts drag too: their mates keep only the free motion.
    if (!c || c.grounded) return undefined;
    const bodyIds = bodiesOf(c);
    const p = bodyIds[0] ? view?.geometry.placements?.[bodyIds[0]] : undefined;
    return { componentId: c.id, bodyIds, position: (p?.position ?? c.position) as Vec3 };
  }, [mode, dialog, JSON.stringify(selection.map(pickId)), JSON.stringify(components), view?.geometry.placements]);

  const documentMenu = (x: number, y: number) => {
    const items: MenuItem[] = [
      {
        label: "New part",
        icon: <Plus size={15} />,
        onSelect: () => {
          pendingMode.current = "part";
          void cad.create("Untitled part");
        },
      },
      {
        label: "New assembly",
        icon: <Plus size={15} />,
        onSelect: () => {
          pendingMode.current = "assembly";
          void cad.create("Untitled assembly");
        },
      },
      { label: "Import…", icon: <Upload size={15} />, disabled: !doc, onSelect: () => importInput.current?.click() },
      { label: "Rename", icon: <Pencil size={15} />, disabled: !doc, onSelect: () => setRenaming(true) },
      { label: "", separator: true },
      ...cad.documents
        .filter((d) => d.id !== doc?.id)
        .slice(0, 12)
        .map((d) => ({ label: d.name, icon: <FolderOpen size={15} />, onSelect: () => void cad.open(d.id) })),
    ];
    void cad.refreshDocuments();
    setMenu({ x, y, items });
  };
  /** A planar face's outline as a 1:1 cutting DXF. */
  const exportFaceDxf = async (ref: TopologyRef) => {
    try {
      const { point: _point, ...face } = ref as TopologyRef & { point?: unknown };
      const result = await cad.execute("export_face_dxf", { face });
      if (!result.data) cad.setError(`Saved ${result.filename} to ${result.path}`);
      else await download(result);
    } catch (e) {
      cad.setError((e as Error).message);
    }
  };
  const exportDrawing = async (drawingId: string, format: "pdf" | "dxf" | "svg") => {
    try {
      const result = await cad.execute("export_drawing", { drawingId, format });
      if (!result.data) cad.setError(`Saved ${result.filename} to ${result.path}`);
      else await download(result);
    } catch (e) {
      cad.setError((e as Error).message);
    }
  };
  const exportMenu = (x: number, y: number) =>
    mode === "drawing" && activeSheet
      ? setMenu({
          x,
          y,
          items: [
            { label: "PDF", icon: <Download size={15} />, onSelect: () => void exportDrawing(activeSheet, "pdf") },
            { label: "DXF", icon: <Download size={15} />, onSelect: () => void exportDrawing(activeSheet, "dxf") },
            { label: "SVG", icon: <Download size={15} />, onSelect: () => void exportDrawing(activeSheet, "svg") },
            { label: ".edit (Vibe CAD Native Editable File Type)", icon: <Download size={15} />, onSelect: () => void exportAs('edit') },
          ],
        })
      : setMenu({
      x,
      y,
      items: [
        { label: "STEP", icon: <Download size={15} />, onSelect: () => void exportAs("step") },
        ...(doc?.features
          .filter((f) => f.type === "sheet" && !f.suppressed)
          .map((f) => ({
            label: `Flat pattern${(doc?.features.filter((x) => x.type === "sheet").length ?? 0) > 1 ? ` · ${doc?.bodies.find((b) => b.id === f.bodyId)?.name ?? ""}` : ""} (DXF)`,
            icon: <Download size={15} />,
            onSelect: () =>
              void cad
                .execute("flat_pattern", { bodyId: f.bodyId, export: true })
                .then(async (result) => (!result.data ? cad.setError(`Saved ${result.filename} to ${result.path}`) : download(result)))
                .catch((e) => cad.setError((e as Error).message)),
          })) ?? []),
        { label: "STL", icon: <Download size={15} />, onSelect: () => void exportAs("stl") },
        { label: ".edit (Vibe CAD Native Editable File Type)", icon: <Download size={15} />, onSelect: () => void exportAs('edit') },
        { label: "Vibe CAD document (JSON)", icon: <Download size={15} />, onSelect: () => void exportAs("json") },
      ],
    });

  return (
    <main className={`app ${cad.busy ? "busy" : ""}`}>
      <header className="topbar">
        <div className="brand">
          {/* Three pivots on a matrix diagonal. */}
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="5" r="3" fill="currentColor" />
            <circle cx="12" cy="12" r="3" fill="currentColor" />
            <circle cx="19" cy="19" r="3" fill="currentColor" />
          </svg>
          <span>Vibe CAD</span>
        </div>
        {renaming && doc ? (
          <input
            className="document-rename"
            autoFocus
            defaultValue={doc.name}
            aria-label="Document name"
            onBlur={(e) => {
              setRenaming(false);
              const name = e.target.value.trim();
              if (name && name !== doc.name) void cad.run("rename_object", { objectId: doc.id, name });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button className="document-name" onClick={(e) => documentMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4)}>
            {doc?.name ?? "No document"}
            {gitBranch && <span className="branch-name">/ {gitBranch}</span>}
            <ChevronDown size={13} />
          </button>
        )}
        <nav className="workspaces" role="tablist" aria-label="Workspace">
          {(
            [
              ["part", "Part"],
              ["assembly", "Assembly"],
              ["drawing", "Drawing"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "on" : ""}
              disabled={!view}
              onClick={() => {
                setMode(m);
                closeDialog();
                setEditing(null);
                setSelection([]);
                setDrawingTool(null);
                setDrawingSelection(null);
                if (m === "drawing" && !activeSheet) setActiveSheet(doc?.drawings?.[0]?.id ?? null);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <button className="icon-button" title="Undo (⌘Z)" aria-label="Undo" disabled={!doc || doc.historyIndex === 0} onClick={() => void cad.run("undo")}>
            <Undo2 size={17} />
          </button>
          <button className="icon-button" title="Redo (⇧⌘Z)" aria-label="Redo" disabled={!doc || doc.historyIndex >= doc.history.length - 1} onClick={() => void cad.run("redo")}>
            <Redo2 size={17} />
          </button>
          <button className="export-button" disabled={!view?.geometry.bodies.length} onClick={(e) => exportMenu(e.currentTarget.getBoundingClientRect().right - 200, e.currentTarget.getBoundingClientRect().bottom + 4)}>
            Export <ChevronDown size={13} />
          </button>
        </div>
      </header>
      <nav className="command-tabs" role="tablist" aria-label="Command groups">
        {tabsFor.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "on" : ""}
            disabled={!!editing && t !== "sketch"}
            onClick={() => setCommandTab({ ...commandTab, [mode]: t })}
          >
            {tabNames[t]}
          </button>
        ))}
      </nav>
      <div
        className={`commandbar ${editing ? "sketching" : ""}`}
        role="toolbar"
        aria-label="Commands"
        onWheel={(e) => {
          // A mouse wheel scrolls commands that do not fit sideways.
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {commandBar()}
      </div>
      <div className={`workspace ${showLeft ? "" : "no-left"} ${showRight ? "" : "no-right"}`} style={{
        "--left-width": `${leftWidth}px`, "--right-width": `${rightWidth}px`,
        "--left-visible-width": showLeft ? "var(--left-panel-size)" : "0px",
        "--right-visible-width": showRight ? "var(--right-panel-size)" : "0px",
      } as CSSProperties}>
        <aside className="left" id="left-sidebar">
          {editing && sketchTool === "pattern" && session ? (
            <SketchPatternPanel key={editing} session={session} revision={doc?.revision ?? 0} onClose={() => setSketchTool("select")} />
          ) : view && motionPanel && !dialog && mode === "assembly" ? (
            <MotionPanel
              cad={cad}
              view={view}
              initial={selection}
              registerPicker={(h) => (picker.current = h)}
              setHighlight={setDialogHighlight}
              onClose={() => {
                picker.current = null;
                setSidePanel(null);
              }}
            />
          ) : view && massPanel && !dialog && mode !== "drawing" ? (
            <MassPanel
              cad={cad}
              view={view}
              registerPicker={(h) => (picker.current = h)}
              setHighlight={setDialogHighlight}
              onClose={() => {
                picker.current = null;
                setSidePanel(null);
              }}
            />
          ) : view && equationsPanel && !dialog && mode === "part" ? (
            <EquationsPanel cad={cad} view={view} onClose={() => setSidePanel(null)} />
          ) : view && sidePanel === "cutlist" && !dialog && mode === "part" ? (
            <CutListPanel cad={cad} view={view} onClose={() => setSidePanel(null)} />
          ) : view && sidePanel === "interference" && !dialog && mode === "assembly" ? (
            <InterferencePanel
              cad={cad}
              view={view}
              onClose={() => setSidePanel(null)}
              onShow={(bodyIds) => setIsolated(components.filter((c) => bodyIds.some((b) => componentOwns(c, b))).map((c) => c.id))}
            />
          ) : view && section && sectionPanel && !dialog && mode !== "drawing" ? (
            <SectionPanel
              value={section}
              geometry={view.geometry}
              onChange={setSection}
              onAccept={() => setSectionPanel(false)}
              onCancel={() => {
                setSection(null);
                setSectionPanel(false);
              }}
            />
          ) : view && mode === "part" && ctx && dialog && !assemblyKinds.has(dialog.kind) ? (
            <FeatureDialog key={dialog.key} kind={dialog.kind as DialogKind} ctx={ctx} onSketchTarget={(p) => void startSketch(p)} />
          ) : view && mode === "assembly" && dialog && assemblyKinds.has(dialog.kind) ? (
            <AssemblyDialog
              key={dialog.key}
              kind={dialog.kind as AssemblyDialogKind}
              cad={cad}
              view={view}
              initial={dialog.initial}
              registerPicker={(h) => (picker.current = h)}
              setHighlight={setDialogHighlight}
              setPreview={setGhost}
              close={closeDialog}
            />
          ) : view && mode === "assembly" ? (
            <AssemblyTree
              view={view}
              selected={treeSelected}
              onSelect={(p, add) => onPick(p, add)}
              onPatternMenu={(e, patternId) =>
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [{ label: "Delete", danger: true, onSelect: () => void cad.run("delete_component_pattern", { patternId }) }],
                })
              }
              onMenu={(e, c) =>
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    ...(c.source ? [{ label: "Open part", icon: <FolderOpen size={15} />, onSelect: () => void cad.open(c.source!.documentId) }] : []),
                    { label: c.display?.hidden ? "Show" : "Hide", onSelect: () => void cad.run("set_visibility", { objectId: c.id, hidden: !c.display?.hidden }) },
                    { label: "Isolate", onSelect: () => setIsolated([c.id]) },
                    { label: "Change Transparency", onSelect: () => void cad.run("set_appearance", { objectId: c.id, transparency: (c.display?.opacity ?? 1) < 1 ? 0 : 75 }) },
                    { label: c.suppressed ? "Unsuppress" : "Suppress", onSelect: () => void cad.run("set_component_suppressed", { componentId: c.id, suppressed: !c.suppressed }) },
                    { label: "Delete", danger: true, onSelect: () => void cad.run("delete_component", { componentId: c.id }) },
                  ],
                })
              }
            />
          ) : view && mode === "drawing" ? (
            <DrawingTree
              view={view}
              sheetId={activeSheet}
              selection={drawingSelection}
              onSheet={setActiveSheet}
              onSelect={setDrawingSelection}
              onContext={(sheet, x, y) =>
                setMenu({
                  x,
                  y,
                  items: [
                    { label: "Export PDF", icon: <Download size={15} />, onSelect: () => void exportDrawing(sheet.id, "pdf") },
                    { label: "Export DXF", icon: <Download size={15} />, onSelect: () => void exportDrawing(sheet.id, "dxf") },
                    { label: "Export SVG", icon: <Download size={15} />, onSelect: () => void exportDrawing(sheet.id, "svg") },
                    { label: "", separator: true },
                    { label: "Delete sheet", danger: true, onSelect: () => void cad.run("delete_drawing", { drawingId: sheet.id }) },
                  ],
                })
              }
            />
          ) : view ? (
            <FeatureTree
              view={view}
              selected={treeSelected}
              hoveredFeature={ownerOf(hovered)}
              visiblePlanes={visiblePlanes}
              editingSketch={editing ?? undefined}
              onSelect={(p, additive) => (p.kind === "plane" && (p.id === "origin" || p.id === "bodies") ? undefined : onPick(p, additive))}
              onOpen={onDoubleClick}
              onContext={(p, x, y) => setMenu({ x, y, items: contextItems(p) })}
              onTogglePlane={togglePlane}
              onToggleVisibility={(id, hidden) => void cad.run("set_visibility", { objectId: id, hidden })}
              onEquations={openEquations}
            />
          ) : null}
        </aside>
        <section className="center">
          {mode === "drawing" && view ? (
            <DrawingEditor cad={cad} view={view} sheetId={activeSheet} tool={drawingTool} onTool={setDrawingTool} selection={drawingSelection} onSelect={setDrawingSelection} />
          ) : (
            <Viewport
              ref={viewport}
              view={view}
              highlight={highlight}
              ghost={ghost ?? (view?.preview && !dialog ? view.preview.geometry : null)}
              solidPreview={!!dialog}
              planes={planes}
              sketches={visibleSketches}
              profile={dialogHighlight?.profile}
              editing={editingSketch && editingFrame ? { sketch: editingSketch, frame: editingFrame } : undefined}
              sketchTool={sketchTool}
              pickFilter={{ faces: true, edges: true, planes: true }}
              explode={mode === "assembly" ? explode : 0}
              explodeOffsets={explodeOffsets}
              gizmo={assemblyGizmo}
              fadeBodies={!!editing}
              hiddenBodies={isolatedHidden}
              tangentEdges={tangentEdges}
              displayStyle={displayStyle}
              section={section && mode !== "drawing" ? sectionCut(section) : null}
              onPick={onPick}
              onHover={setHovered}
              onContextMenu={(pick, x, y) => {
                const items = contextItems(pick);
                if (items.length) setMenu({ x, y, items });
              }}
              onDoubleClick={onDoubleClick}
              onCamera={(position, target) => {
                if (cameraTimer.current) clearTimeout(cameraTimer.current);
                cameraTimer.current = setTimeout(() => {
                  if (cad.latest.current) void cad.execute("set_viewport", { position, target }).catch(() => {});
                }, 900);
              }}
              onSketchCommit={async (ops, reason) => {
                if (!editing) return undefined;
                try {
                  const v = await cad.execute<View>("edit_sketch", { sketchId: editing, operations: ops, reason });
                  return v.document.sketches.find((s) => s.id === editing);
                } catch (e) {
                  cad.setError((e as Error).message);
                  return undefined;
                }
              }}
              onSketchChange={() => {
                const s = viewport.current?.session();
                if (s && s.tool !== sketchTool) setSketchTool(s.tool);
                bump();
              }}
              onEditValue={(constraintId, value, [x, y]) => {
                // Lengths are typed in display units; angles in degrees.
                const c = editingSketch?.constraints.find((x) => x.id === constraintId);
                const length = c?.type !== "angle" && !(c?.type === "pattern" && c.pattern?.kind === "circular");
                // An equation-driven dimension is edited as its equation.
                const shown = c?.expression ? `=${c.expression}` : length ? formatLength(value) : formatMm(value);
                setValueEditor({ constraintId, value: shown, length, x, y });
              }}
              onComponentDrag={(componentId, delta) => {
                const c = components.find((x) => x.id === componentId);
                if (c) void cad.run("set_component_transform", { componentId, position: c.position.map((v, i) => v + delta[i]), rotation: c.rotation });
              }}
            />
          )}
          {!cad.loading && !view && (
            <div className="empty-state">
              <button className="primary" onClick={() => void cad.create("Untitled part")}>
                <Plus size={16} /> New part
              </button>
              {cad.documents.length > 0 && (
                <button className="text-button" onClick={(e) => documentMenu(e.clientX, e.clientY)}>
                  Open document
                </button>
              )}
            </div>
          )}
          <div className="view-controls">
            <button
              className={`icon-button ${section ? "on" : ""}`}
              title="Section view"
              aria-label="Section view"
              aria-pressed={!!section}
              disabled={!view?.geometry.bodies.length}
              onClick={() => {
                if (section) {
                  setSection(null);
                  setSectionPanel(false);
                } else if (view) {
                  setSection(defaultSection(view.geometry));
                  setSectionPanel(true);
                  setShowLeft(true);
                }
              }}
            >
              <Icons.section3d size={16} />
            </button>
            <button
              className="icon-button"
              title={`Display Style: ${displayStyles.find((x) => x.id === displayStyle)!.name}`}
              aria-label="Display Style"
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({
                  x: r.left,
                  y: r.bottom + 4,
                  items: displayStyles.map((x) => {
                    const Icon = styleIcons[x.id];
                    return {
                      label: x.name,
                      icon: <Icon size={16} />,
                      checked: x.id === displayStyle,
                      onSelect: () => {
                        setDisplayStyle(x.id);
                        try {
                          localStorage.setItem("vibe-display-style", x.id);
                        } catch {
                          /* not remembered */
                        }
                      },
                    };
                  }),
                });
              }}
            >
              {(() => {
                const Icon = styleIcons[displayStyle];
                return <Icon size={16} />;
              })()}
            </button>
            <button
              className={`icon-button ${tangentEdges ? "on" : ""}`}
              title={tangentEdges ? "Tangent edges shown" : "Tangent edges hidden"}
              aria-label="Tangent edges"
              aria-pressed={tangentEdges}
              onClick={() => {
                setTangentEdges(!tangentEdges);
                try {
                  localStorage.setItem("pivot-tangent-edges", tangentEdges ? "off" : "on");
                } catch {
                  /* not remembered */
                }
              }}
            >
              <Icons.tangentEdges size={16} />
            </button>
            {isolated && (
              <button className="text-button exit-isolate" onClick={() => setIsolated(null)}>
                Exit Isolate
              </button>
            )}
            <button className="icon-button" title="Feature tree" aria-label="Toggle feature tree" onClick={() => setShowLeft(!showLeft)}>
              <PanelLeft size={16} />
            </button>
            <button className="icon-button" title="Properties" aria-label="Toggle properties" onClick={() => setShowRight(!showRight)}>
              <PanelRight size={16} />
            </button>
            <button className="icon-button" title="Full screen" aria-label="Full screen" onClick={() => void fullscreen()}>
              <Maximize2 size={15} />
            </button>
          </div>
          {view?.preview && !dialog && (
            <div className="proposal">
              <span>{view.preview.description}</span>
              <button className="text-button" onClick={() => void cad.run("dismiss_preview")}>
                Discard
              </button>
              <button className="primary" onClick={() => void cad.run("apply_preview", { previewId: view.preview!.id })}>
                Apply
              </button>
            </div>
          )}
          {cad.error && (
            <div className="error-line" role="alert" onClick={() => cad.setError("")}>
              {cad.error}
            </div>
          )}
          {valueEditor && (
            <input
              className="value-editor"
              style={{ left: valueEditor.x, top: valueEditor.y }}
              autoFocus
              aria-label="Dimension value"
              defaultValue={valueEditor.value}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setValueEditor(null)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setValueEditor(null);
                if (e.key === "Enter") {
                  const text = (e.target as HTMLInputElement).value.trim();
                  if (text.startsWith("=")) {
                    if (text.length > 1) viewport.current?.session()?.setExpression(valueEditor.constraintId, text.slice(1).trim());
                    setValueEditor(null);
                    return;
                  }
                  const typed = evaluate(text.replace(/(mm|in|°|")\s*$/i, ""));
                  const value = typed !== undefined && valueEditor.length ? fromDisplay(typed) : typed;
                  if (value !== undefined && Number.isFinite(value) && value > 0) viewport.current?.session()?.setValue(valueEditor.constraintId, value);
                  setValueEditor(null);
                }
              }}
            />
          )}
        </section>
        <aside className="right" id="right-sidebar">
          {view && mode === "assembly" ? (
            <AssemblyInspector
              cad={cad}
              view={view}
              selection={selection}
              explode={explode}
              onExplode={setExplode}
              onAutoExplode={() => void cad.run("auto_explode").then((v) => v && animateExplode(1))}
            />
          ) : view && mode === "drawing" ? (
            <DrawingProperties cad={cad} view={view} sheetId={activeSheet} selection={drawingSelection} />
          ) : view ? (
            <Inspector
              cad={cad}
              view={view}
              selection={selection}
              sketch={editingSketch}
              sketchSelection={
                editing && session
                  ? { entities: [...session.selection.entities], constraints: [...session.selection.constraints], points: session.selection.points }
                  : undefined
              }
              onSketchOps={(ops: SketchOp[], reason) => void viewport.current?.session()?.enqueue(ops, reason)}
              onRelate={(type: Constraint["type"]) => viewport.current?.session()?.relate(type)}
              onSelect={(p) => setSelection([p])}
              tab={rightTab}
              onTab={setRightTab}
            />
          ) : null}
        </aside>
        <SidebarResize side="left" shown={showLeft} width={leftWidth} onChange={(shown, width) => { setShowLeft(shown); setLeftWidth(width); }} />
        <SidebarResize side="right" shown={showRight} width={rightWidth} onChange={(shown, width) => { setShowRight(shown); setRightWidth(width); }} />
      </div>
      <footer className="statusbar">
        <div className="timeline" aria-label="Feature timeline">
          {doc?.features.map((f) => {
            const I = Icons[featureIcon(f)];
            const selected = selection.some((p) => p.kind === "feature" && p.id === f.id);
            return (
              <button
                key={f.id}
                className={`timeline-item ${selected ? "on" : ""} ${f.suppressed ? "dim" : ""} ${ownerOf(hovered) === f.id ? "hovered" : ""}`}
                title={f.name}
                aria-label={f.name}
                onClick={(e) => onPick({ kind: "feature", id: f.id }, e.shiftKey || e.metaKey)}
                onDoubleClick={() => editFeature(f.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, items: contextItems({ kind: "feature", id: f.id }) });
                }}
              >
                <I size={16} />
              </button>
            );
          })}
        </div>
        <div className="status">
          {editing && session?.hint ? (
            <span>{session.hint}</span>
          ) : editing ? (
            <span className={editingSketch?.solver.dof === 0 ? "defined" : ""}>{sketchStatus}</span>
          ) : selectionStatus ? (
            <span>{selectionStatus}</span>
          ) : (
            <span className={definition?.status === "full" ? "defined" : definition?.status === "over" ? "over" : ""} title={definition?.notes.join("\n") || undefined}>
              {definitionStatus}
            </span>
          )}

          <button
            className="units"
            title="Display units"
            disabled={!doc}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({
                x: r.right - 160,
                y: r.top - 76,
                items: [
                  { label: "Millimeters", shortcut: units === "mm" ? "✓" : "", onSelect: () => void cad.run("set_units", { units: "mm" }) },
                  { label: "Inches", shortcut: units === "in" ? "✓" : "", onSelect: () => void cad.run("set_units", { units: "in" }) },
                ],
              });
            }}
          >
            {units}
          </button>
        </div>
      </footer>
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <input
        ref={importInput}
        type="file"
        accept={importAccept}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />
    </main>
  );
}
export type { TopologyRef, Sketch };
