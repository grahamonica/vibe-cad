import type { View } from "./types.ts";
import { componentOf } from "./types.ts";

/**
 * Whether a model is fully defined, as SolidWorks reports it: sketches with
 * degrees of freedom left are under-defined; in an assembly, components with
 * freedom left are under-defined, and mates that conflict (or lost their
 * geometry) make it over-defined.
 */
export function definitionOf(view: View) {
  const d = view.document,
    mateStatus = view.geometry.mateStatus ?? {},
    componentStatus = view.geometry.componentStatus ?? {};
  const sketches = d.sketches.map((s) => ({ id: s.id, name: s.name, dof: s.solver.dof, status: s.solver.dof > 0 ? ("under" as const) : ("full" as const) }));
  const components = (d.components ?? []).flatMap((c) => {
    const state = componentStatus[c.id];
    return state ? [{ id: c.id, name: c.name, status: state.status, dof: state.dof }] : [];
  });
  // What a flagged mate's references are, where the model now has them: enough to see why it cannot be met.
  const topology = view.geometry.bodies.flatMap((b) => b.topology);
  const round = (v: number[]) => v.map((x) => Math.round(x * 1000) / 1000);
  const kinds: Record<string, string> = { PLANE: "flat face", CYLINDRE: "cylindrical face", CONE: "conical face", SPHERE: "spherical face", TORUS: "toroidal face", LINE: "straight edge", CIRCLE: "circular edge" };
  const describe = (ref: { id: string; bodyId: string }) => {
    const t = topology.find((x) => x.id === ref.id),
      part = componentOf(d, ref.bodyId)?.name ?? d.bodies.find((b) => b.id === ref.bodyId)?.name ?? ref.bodyId;
    if (!t) return { part, missing: true };
    return {
      part,
      geometry: kinds[t.geomType] ?? `${t.kind} (${t.geomType.toLowerCase()})`,
      at: round(t.center),
      ...(t.normal && t.geomType === "PLANE" ? { normal: round(t.normal) } : {}),
      ...(t.axis && t.geomType !== "PLANE" ? { axis: round(t.axis.direction), through: round(t.axis.origin) } : {}),
      ...(t.radius !== undefined ? { radius: Math.round(t.radius * 1000) / 1000 } : {}),
    };
  };
  const mates = (d.mates ?? []).flatMap((m) => {
    const state = mateStatus[m.id];
    return state && state.status !== "ok"
      ? [
          {
            id: m.id,
            name: m.name,
            type: m.type,
            ...(m.type === "distance" || m.type === "angle" ? { value: m.value } : {}),
            status: state.status,
            message: state.message ?? "",
            ...(state.residual !== undefined ? { residual: state.residual } : {}),
            moving: describe(m.moving),
            target: describe(m.target),
          },
        ]
      : [];
  });
  const notes = [
    ...mates.map((m) => m.message),
    ...sketches.filter((s) => s.status === "under").map((s) => `${s.name} is under-defined: ${s.dof} degree${s.dof === 1 ? "" : "s"} of freedom`),
    ...components.filter((c) => c.status === "under").map((c) => `${c.name} is under-defined: ${c.dof} degree${c.dof === 1 ? "" : "s"} of freedom`),
  ];
  const over = mates.length > 0 || components.some((c) => c.status === "over");
  const under = sketches.some((s) => s.status === "under") || components.some((c) => c.status === "under");
  return { status: over ? ("over" as const) : under ? ("under" as const) : ("full" as const), sketches, components, mates, notes };
}

export function summarize(view: View) {
  const d = view.document,
    definition = definitionOf(view);
  return {
    document: {
      id: d.id,
      name: d.name,
      revision: d.revision,
      units: "mm",
      sketches: d.sketches,
      features: d.features,
      bodies: d.bodies,
      intents: d.intents,
      referencePlanes: d.referencePlanes ?? [],
      components: d.components ?? [],
      mates: d.mates ?? [],
      drawings: d.drawings ?? [],
      selection: d.selection,
      viewport: d.viewport,
      history: d.history.map(({ snapshot, ...h }) => h),
      historyIndex: d.historyIndex,
    },
    geometry: view.geometry.bodies.map(({ mesh, edges, topology, tangentEdges: _, ...b }) => ({
      ...b,
      ...(componentOf(d, b.id) ? { componentId: componentOf(d, b.id)!.id } : {}),
      faceCount: topology.filter((t) => t.kind === "face").length,
      edgeCount: topology.filter((t) => t.kind === "edge").length,
    })),
    warnings: view.geometry.warnings,
    // Fully defined or not, and what is under- or over-defined (mate conflicts included).
    definition: { status: definition.status, notes: definition.notes },
    preview: view.preview
      ? {
          id: view.preview.id,
          description: view.preview.description,
          baseRevision: view.preview.baseRevision,
        }
      : undefined,
  };
}
