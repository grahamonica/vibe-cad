// FeatureManager design tree: origin planes, datum planes, features with their
// absorbed sketches, free sketches and bodies.
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import type { Feature, Sketch, View } from "../../cad/types.ts";
import { Icons, type IconName } from "../cad-icons.tsx";
import { principalNames, type Pick } from "./dialogs.tsx";

export const featureIcon = (f: Feature): IconName =>
  (
    ({
      extrude: f.params.operation === "cut" ? "cut" : "extrude",
      revolve: "revolve",
      sweep: "sweep",
      loft: "loft",
      hole: "hole",
      fillet: "fillet",
      chamfer: "chamfer",
      pattern: f.params.kind === "circular" ? "circularPattern" : "linearPattern",
      mirror: "mirror",
      boolean: "combine",
      shell: "shell",
      draft: "draft",
      moveFace: "moveFace",
      thread: "thread",
      gear: "gear",
      pulley: "pulley",
      member: "member",
      bend: "bend",
      corner: "closedCorner",
      weld: "weld",
      split: "split",
      scale: "scale",
      transform: "move",
      import: "insert",
      rib: "rib",
      sheet: "baseFlange",
      flange: f.params.hem ? "hem" : "edgeFlange",
    }) as Record<string, IconName>
  )[f.type] ?? "component";
export const sketchesOf = (f: Feature): string[] =>
  [f.params.sketchId, f.params.profileSketchId, f.params.pathSketchId, ...(f.params.sketchIds ?? [])].filter(Boolean);
/** Absorbed sketches are hidden unless shown explicitly; free sketches are shown unless hidden. */
export const sketchVisible = (s: Sketch, absorbed: boolean) => (s.hidden === undefined ? !absorbed : !s.hidden);
export const pickId = (p: Pick) =>
  p.kind === "face" || p.kind === "edge" ? p.ref.id : p.kind === "sketchLine" ? p.entityId : p.id;

export function FeatureTree({
  view,
  selected,
  hoveredFeature,
  visiblePlanes,
  editingSketch,
  onSelect,
  onOpen,
  onContext,
  onTogglePlane,
  onToggleVisibility,
  onEquations,
}: {
  view: View;
  selected: Set<string>;
  hoveredFeature?: string;
  visiblePlanes: Set<string>;
  editingSketch?: string;
  onSelect: (p: Pick, additive: boolean) => void;
  onOpen: (p: Pick) => void;
  onContext: (p: Pick, x: number, y: number) => void;
  onTogglePlane: (id: string) => void;
  onToggleVisibility: (id: string, hidden: boolean) => void;
  onEquations?: () => void;
}) {
  const doc = view.document;
  const [open, setOpen] = useState<Record<string, boolean>>({ origin: false, bodies: true });
  const consumed = new Map<string, Feature>();
  for (const f of doc.features) for (const id of sketchesOf(f)) if (!consumed.has(id)) consumed.set(id, f);
  const freeSketches = doc.sketches.filter((s) => !consumed.has(s.id));
  const row = (
    pick: Pick,
    icon: ReactNode,
    label: string,
    options: { depth?: number; dim?: boolean; toggle?: ReactNode; expander?: ReactNode; editing?: boolean; title?: string } = {},
  ) => {
    const id = pickId(pick);
    return (
      <div
        key={id}
        role="treeitem"
        aria-selected={selected.has(id)}
        className={`tree-row ${selected.has(id) ? "selected" : ""} ${hoveredFeature === id ? "hovered" : ""} ${options.dim ? "dim" : ""} ${options.editing ? "editing" : ""}`}
        style={{ paddingLeft: 10 + (options.depth ?? 0) * 16 }}
        title={options.title}
        onClick={(e) => onSelect(pick, e.shiftKey || e.metaKey || e.ctrlKey)}
        onDoubleClick={() => onOpen(pick)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContext(pick, e.clientX, e.clientY);
        }}
      >
        <span className="tree-expander">{options.expander}</span>
        <span className="tree-icon">{icon}</span>
        <span className="tree-label">{label}</span>
        {options.toggle}
      </div>
    );
  };
  const eye = (hidden: boolean, toggle: () => void) => (
    <button
      className="tree-eye"
      aria-label={hidden ? "Show" : "Hide"}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
    >
      {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
    </button>
  );
  const expander = (key: string) => (
    <button
      className="tree-toggle"
      aria-label={open[key] ? "Collapse" : "Expand"}
      onClick={(e) => {
        e.stopPropagation();
        setOpen({ ...open, [key]: !open[key] });
      }}
    >
      {open[key] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
    </button>
  );
  const sketchRow = (s: Sketch, depth: number) => {
    const visible = sketchVisible(s, consumed.has(s.id));
    // SolidWorks' mark: (-) before an under-defined sketch.
    return row({ kind: "sketch", id: s.id }, <Icons.sketch size={15} />, `${s.solver.dof > 0 ? "(-) " : ""}${s.name}`, {
      depth,
      editing: editingSketch === s.id,
      title: s.solver.dof === 0 ? "Fully defined" : `Under defined (${s.solver.dof} degrees of freedom)`,
      toggle: <>{eye(!visible, () => onToggleVisibility(s.id, visible))}</>,
    });
  };
  return (
    <div className="feature-tree" role="tree" aria-label="Design tree">
      <div className="tree-row root" role="treeitem" aria-selected={false}>
        <span className="tree-icon">
          <Icons.component size={16} />
        </span>
        <span className="tree-label">{doc.name}</span>
      </div>
      {!!doc.variables?.length && (
        <div className="tree-row" role="treeitem" aria-selected={false} style={{ paddingLeft: 10 }} onDoubleClick={onEquations} onClick={onEquations}>
          <span className="tree-expander" />
          <span className="tree-icon">
            <Icons.equations size={15} />
          </span>
          <span className="tree-label">Equations</span>
          <span className="tree-note">({doc.variables.length})</span>
        </div>
      )}
      {row({ kind: "plane", id: "origin" }, <Icons.axis size={15} />, "Origin", { expander: expander("origin") })}
      {open.origin &&
        (["XZ", "XY", "YZ"] as const).map((id) =>
          row({ kind: "plane", id }, <Icons.plane size={15} />, principalNames[id], {
            depth: 1,
            toggle: eye(!visiblePlanes.has(id), () => onTogglePlane(id)),
          }),
        )}
      {doc.referencePlanes?.map((p) =>
        row({ kind: "plane", id: p.id }, <Icons.plane size={15} />, p.name, {
          toggle: eye(!visiblePlanes.has(p.id), () => onTogglePlane(p.id)),
        }),
      )}
      {doc.features.map((f) => {
        const sketches = sketchesOf(f)
          .map((id) => doc.sketches.find((s) => s.id === id))
          .filter((s): s is Sketch => !!s && consumed.get(s.id) === f);
        const Icon = Icons[featureIcon(f)];
        return (
          <div key={f.id} role="group">
            {row({ kind: "feature", id: f.id }, <Icon size={15} />, f.name, {
              dim: f.suppressed,
              expander: sketches.length ? expander(f.id) : undefined,
              title: f.suppressed ? "Suppressed" : undefined,
            })}
            {open[f.id] && sketches.map((s) => sketchRow(s, 1))}
          </div>
        );
      })}
      {freeSketches.map((s) => sketchRow(s, 0))}
      {doc.bodies.length > 0 && (
        <>
          {row({ kind: "plane", id: "bodies" }, <Icons.component size={15} />, `Solid bodies (${doc.bodies.length})`, { expander: expander("bodies") })}
          {open.bodies &&
            doc.bodies.map((b) =>
              row({ kind: "body", id: b.id }, <Icons.component size={15} />, b.name, {
                depth: 1,
                dim: b.hidden,
                toggle: eye(b.hidden, () => onToggleVisibility(b.id, !b.hidden)),
              }),
            )}
        </>
      )}
    </div>
  );
}
