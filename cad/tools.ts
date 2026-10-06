import { z } from "zod";
import { materialProps } from "./material-schema.ts";
import { findTopology } from "./topology-key.ts";
import { allComponents, componentOf, componentOwns } from "./types.ts";
import { autoExplode, eulerDegrees, gearPhase, localTopology, mateLoops, solveComponents, type SolveReport } from "./assembly.ts";
import { Euler, Quaternion, Vector3 } from "three";
import { originFrame } from "./frame.ts";
import { deflate, git, randomUUID, readText, saveExport, downloadVendorFile } from "./local-io.ts";
import { base64, encodePng, renderPicture, type PictureCamera } from "./render-image.ts";
import { displayStyleIds, displayStyles, textureIds, textureInfo, textures } from "./appearance.ts";
import type { DocumentStore as Store } from "./document-store.ts";
import { exportProject } from './project-archive.ts';
import {
  solveSketch,
  fieldsOf,
  captureReference,
  constraintTypes,
} from "./solver.ts";
import { defaultPrintWall, materials, metricSizes, type Material } from "./standards.ts";
import { cornerEntities, mirrorEntities, offsetEntities, patternEntities } from "./sketch-tools.ts";
import { resolveViews, projectedOrientation, sheetDimensions, assertViewsFit, cameraFor } from "./drawing.ts";
import { flatPatternDXF, profileDXF } from "./drawing-export.ts";
import { aboutAxis, combine, principal, spin } from "./mass.ts";
import { beltLength, belts, centerFor, type BeltType } from "./drives.ts";
import { profileArea, profileLabel, profileOutline } from "./weldments.ts";
import { STL_TRIANGLE_LIMIT, stlTriangleCount } from "./stl.ts";
import { evaluateExpression, renameInExpression, resolveVariables, setFeatureDimension, validVariableName, variableUses } from "./equations.ts";
import {
  exportModel,
  measureGeometry,
  interference,
  interferences,
  projectEdges,
  flatPattern,
  faceOutline,
  motionSweep,
  mechanismSweep,
  lineCrossings,
  renderDrawing,
} from "./geometry.ts";
import type {
  ViewOrientation,
  Document,
  Feature,
  Sketch,
  View,
  TopologyRef,
  Constraint,
  Entity,
  Topology,
  Vec2,
  Vec3,
} from "./types.ts";
const id = z.string().min(1).max(240),
  scalar = z.number().finite().min(-10000).max(10000),
  positive = z.number().finite().gt(0).max(10000),
  // Homogeneous fixed-length arrays are understood by Codex's tool catalog.
  // Draft-07 tuple `items: [...]` can make a tool disappear during conversion.
  vec2 = z.array(scalar).length(2),
  vec3 = z.array(scalar).length(3);
const nonzero = vec3.refine(
  (v) => Math.hypot(...v) > 1e-8,
  "Direction must be nonzero",
);
const ref = z
  .object({
    bodyId: id,
    id,
    kind: z.enum(["face", "edge"]),
    signature: z.array(z.number()).optional(),
    geomType: z.string().optional(),
    semantic: z.string().optional(),
    point: vec3.optional(),
  })
  .strict();
const base = { documentId: id },
  write = {
    ...base,
    expectedRevision: z.number().int().min(0),
    reason: z.string().min(1).max(500).optional(),
  },
  named = { name: z.string().min(1).max(100).optional() };
const plane = z.enum(["XY", "XZ", "YZ"]);
const planeRef = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("principal"), plane, offset: scalar.optional() })
    .strict(),
  z.object({ kind: z.literal("reference"), planeId: id }).strict(),
  z.object({ kind: z.literal("face"), ref }).strict(),
]);
const axisRef = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("principal"), axis: z.enum(["X", "Y", "Z"]) })
    .strict(),
  z.object({ kind: z.literal("edge"), ref }).strict(),
  z.object({ kind: z.literal("face"), ref }).strict(),
  z.object({ kind: z.literal("sketch"), sketchId: id, entityId: id }).strict(),
  z.object({ kind: z.literal("custom"), origin: vec3, direction: nonzero }).strict(),
]);
const redefine = {
  featureId: id
    .optional()
    .describe(
      "Redefine this existing feature in place (same type) instead of adding a new one.",
    ),
};
const entityType = z.enum(["line", "rectangle", "circle", "arc", "point", "spline"]);
/** Check that an added entity carries exactly the values its type needs. */
function checkValues(type: Entity["type"], values: Record<string, unknown>) {
  const fields = fieldsOf({ type, values: values as Record<string, number> });
  const points = fields.filter((f) => f[0] === "x").length;
  if (type === "spline" && (points < 2 || points > 64)) throw Error("A spline needs 2 to 64 fit points x0, y0, x1, y1 …");
  if (type === "spline" && "from" in values) {
    // Trimmed splines keep the parameter range of the kept part; fit point i sits at i.
    const from = values.from as number,
      to = values.to as number,
      closed = points > 3 && values.x0 === values[`x${points - 1}`] && values.y0 === values[`y${points - 1}`];
    if (!(from >= 0 && to > from && to <= (closed ? from + points - 1 : points - 1)))
      throw Error(`A spline range needs 0 ≤ from < to ≤ ${closed ? "from + " : ""}${points - 1}`);
  }
  if (
    Object.keys(values).length !== fields.length ||
    fields.some((f) => values[f] === undefined)
  )
    throw Error(
      type === "spline"
        ? "A spline expects fit points x0, y0, x1, y1 … numbered without gaps"
        : `${type} expects exactly: ${fields.join(", ")}`,
    );
}
const constraintType = z.enum(constraintTypes);
const sketch = (doc: Document, id: string) => {
  const s = doc.sketches.find((s) => s.id === id);
  if (!s) throw Error("Sketch not found");
  return s;
};
const feature = (doc: Document, id: string) => {
  const f = doc.features.find((f) => f.id === id);
  if (!f) throw Error("Feature not found");
  return f;
};
const body = (doc: Document, id: string) => {
  const b = doc.bodies.find((b) => b.id === id);
  if (!b) throw Error("Body not found");
  return b;
};
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<any>;
  readOnly: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  ui?: boolean;
  handler: (args: any, source: "user" | "assistant") => Promise<any>;
}
export function toolset(store: Store) {
  const tools: ToolDefinition[] = [];
  const add = (
    name: string,
    title: string,
    description: string,
    shape: Record<string, z.ZodType>,
    readOnly: boolean,
    handler: ToolDefinition["handler"],
    extra: Partial<ToolDefinition> = {},
  ) =>
    tools.push({
      name,
      title,
      description,
      schema: z.object(shape).strict(),
      readOnly,
      handler,
      ...extra,
    });
  const mutate = (
    args: any,
    source: "user" | "assistant",
    message: string,
    edit: (d: Document) => void,
  ) =>
    store.transact(
      args.documentId,
      args.expectedRevision,
      args.reason ?? message,
      source,
      edit,
    );
  const releasePlacement = async (documentId: string, mateId: string) => {
    const d = await store.read(documentId),
      v = await store.view(d),
      mate = d.mates?.find((m) => m.id === mateId),
      c = componentOf(d, mate?.moving.bodyId ?? "");
    const member = c && v.geometry.bodies.find((b) => componentOwns(c, b.id));
    const p = member ? v.geometry.placements?.[member.id] : undefined;
    if (!c || !p) return undefined;
    const e = new Euler().setFromQuaternion(
      new Quaternion(...p.quaternion),
      "XYZ",
    );
    return {
      id: c.id,
      position: p.position,
      rotation: [e.x, e.y, e.z].map((n) => (n * 180) / Math.PI),
    };
  };
  /**
   * Hole centers with stable identities. The same number of centers moves each
   * hole in order; otherwise centers that did not move keep their identity and
   * new centers are new holes, so references never jump to a different hole.
   */
  const setHolePositions = (target: Record<string, any>, before: Record<string, any> | undefined, positions: Vec2[]) => {
    const old: Vec2[] = before?.sketchId ? [] : (before?.positions ?? []);
    const oldIds: string[] = old.map((_, i) => before?.positionIds?.[i] ?? String(i));
    let ids = oldIds;
    if (positions.length !== old.length) {
      const used = new Set<string>();
      let next = old.length;
      ids = positions.map((q) => {
        const i = old.findIndex((o, k) => !used.has(oldIds[k]) && Math.hypot(o[0] - q[0], o[1] - q[1]) < 1e-6);
        if (i >= 0) {
          used.add(oldIds[i]);
          return oldIds[i];
        }
        while (oldIds.includes(String(next))) next++;
        return String(next++);
      });
    }
    target.positions = positions;
    if (ids.some((id, i) => id !== String(i))) target.positionIds = ids;
    else delete target.positionIds;
  };
  const addFeature = (
    d: Document,
    type: Feature["type"],
    bodyId: string,
    params: Record<string, any>,
    name?: string,
    featureId?: string,
  ) => {
    body(d, bodyId);
    if (featureId) {
      // Redefinition keeps identity, tree position and downstream references.
      const existing = feature(d, featureId);
      if (existing.type !== type)
        throw Error(`${existing.name} is a ${existing.type}, not a ${type}`);
      if (type === "hole" && params.positions) setHolePositions(params, existing.params, params.positions);
      // An equation stays while its parameter keeps the value it drives; a new number replaces it.
      for (const key of Object.keys(existing.expressions ?? {}))
        if (params[key] !== existing.params[key]) delete existing.expressions![key];
      if (existing.expressions && !Object.keys(existing.expressions).length) delete existing.expressions;
      existing.params = params;
      existing.bodyId = bodyId;
      if (name) existing.name = name;
      return existing;
    }
    const prefix =
      type === "extrude" && params.operation === "cut"
        ? "Cut"
        : type === "moveFace"
          ? "Move Face"
          : type[0].toUpperCase() + type.slice(1);
    const f: Feature = {
      id: randomUUID(),
      name:
        name ??
        `${prefix} ${d.features.filter((x) => x.name.startsWith(prefix + " ")).length + 1}`,
      type,
      bodyId,
      params,
      suppressed: false,
    };
    d.features.push(f);
    return f;
  };
  add(
    "list_documents",
    "List CAD documents",
    "List the saved CAD documents in this editor. Returns IDs, names, and revisions.",
    {},
    true,
    async () => ({ documents: await store.list() }),
  );
  add(
    "create_document",
    "Create CAD document",
    "Create an empty parametric CAD document, using millimeters. No example geometry is inserted.",
    { name: z.string().min(1).max(100) },
    false,
    async (a, source) => store.create(a.name, "local", source),
    { ui: true },
  );
  add(
    "inspect_document_state",
    "Check CAD document changes",
    "Read only revision, selection, camera, and preview identity. Use this inexpensive state check before requesting full editor geometry when polling for changes.",
    base,
    true,
    async (a) => store.state(a.documentId),
  );
  add(
    "inspect_document",
    "Inspect CAD document",
    "Get features, sketches, dimensions, constraints, current revision, design intent, and history. Call before mutations; use expectedRevision to avoid overwriting another edit.",
    base,
    true,
    async (a) => store.view(await store.read(a.documentId)),
  );
  add(
    "open_cad",
    "Open CAD editor",
    "Open the interactive CAD viewport for an existing document. Tools remain available without the UI.",
    base,
    true,
    async (a) => store.view(await store.read(a.documentId)),
    { ui: true },
  );
  add(
    "inspect_selection",
    "Inspect current selection",
    "Inspect faces and edges the user selected, with geometry type, normals, measurements, body identity, and camera context.",
    base,
    true,
    async (a) => {
      const d = await store.read(a.documentId),
        v = await store.view(d);
      return {
        revision: d.revision,
        selection: d.selection.map((s) =>
          findTopology(v.geometry.bodies.flatMap((b) => b.topology), s),
        ),
        viewport: d.viewport,
      };
    },
  );
  add(
    "inspect_feature",
    "Inspect CAD feature",
    "Get the precise parameters, dependencies, and design intent for a feature or sketch.",
    { ...base, featureId: id },
    true,
    async (a) => {
      const d = await store.read(a.documentId);
      return {
        revision: d.revision,
        feature:
          d.features.find((f) => f.id === a.featureId) ??
          d.sketches.find((s) => s.id === a.featureId) ??
          null,
        intents: d.intents.filter((i) => i.featureId === a.featureId),
      };
    },
  );
  add(
    "inspect_geometry",
    "Inspect CAD topology",
    "Get faces, edges, stable references, bounding boxes, volume, surface area, and center of mass for a body. Do not invent topology IDs.",
    { ...base, bodyId: id },
    true,
    async (a) => {
      const v = await store.view(await store.read(a.documentId)),
        b = v.geometry.bodies.find((b) => b.id === a.bodyId);
      if (!b) throw Error("Body not found");
      const { mesh, edges, ...result } = b;
      return { revision: v.document.revision, ...result };
    },
  );
  add(
    "set_selection",
    "Select CAD geometry",
    "Set exact selected face/edge references, or a semantic group (planar/cylindrical/hole faces, faces facing up or down, all/vertical/horizontal/circular/straight edges), optionally on one body. The selection highlights in the editor and is shared with Codex.",
    {
      ...base,
      refs: z.array(ref).max(300).optional(),
      bodyId: id.optional(),
      selector: z
        .enum([
          "all-faces",
          "planar-faces",
          "cylindrical-faces",
          "hole-faces",
          "downward-faces",
          "upward-faces",
          "all-edges",
          "vertical-edges",
          "horizontal-edges",
          "circular-edges",
          "straight-edges",
        ])
        .optional(),
    },
    false,
    async (a) => {
      const d = await store.read(a.documentId),
        v = await store.view(d);
      let refs = a.refs ?? [];
      if (a.selector) {
        const ts = v.geometry.bodies
          .filter((b) => !a.bodyId || b.id === a.bodyId)
          .filter((b) => !b.hidden)
          .flatMap((b) => b.topology);
        const cylinder = (t: (typeof ts)[number]) =>
          t.kind === "face" && ["CYLINDRE", "CYLINDER"].includes(t.geomType);
        const inward = (t: (typeof ts)[number]) => {
          if (!t.axis || !t.normal) return false;
          const c = t.center.map((x, i) => x - t.axis!.origin[i]),
            k = c.reduce((s, x, i) => s + x * t.axis!.direction[i], 0),
            radial = c.map((x, i) => x - k * t.axis!.direction[i]);
          return radial.reduce((s, x, i) => s + x * t.normal![i], 0) < 0;
        };
        const test: Record<string, (t: (typeof ts)[number]) => boolean> = {
          "all-faces": (t) => t.kind === "face",
          "planar-faces": (t) => t.kind === "face" && t.geomType === "PLANE",
          "cylindrical-faces": cylinder,
          "hole-faces": (t) => cylinder(t) && (t.concave ?? inward(t)),
          "downward-faces": (t) => t.kind === "face" && (t.normal?.[2] ?? 0) < -0.5,
          "upward-faces": (t) => t.kind === "face" && (t.normal?.[2] ?? 0) > 0.5,
          "all-edges": (t) => t.kind === "edge",
          "vertical-edges": (t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.signature[5]) > 0.999,
          "horizontal-edges": (t) => t.kind === "edge" && t.geomType === "LINE" && Math.abs(t.signature[5]) < 0.001,
          "circular-edges": (t) => t.kind === "edge" && t.geomType === "CIRCLE",
          "straight-edges": (t) => t.kind === "edge" && t.geomType === "LINE",
        };
        refs = ts
          .filter(test[a.selector])
          .map((t) => ({
            id: t.id,
            bodyId: t.bodyId,
            kind: t.kind,
            signature: t.signature,
            geomType: t.geomType,
          }));
      }
      return store.setContext(a.documentId, refs);
    },
  );
  add(
    "set_viewport",
    "Set viewport camera",
    "Save camera position and target in the shared document.",
    { ...base, position: vec3, target: vec3 },
    false,
    async (a) => {
      const d = await store.read(a.documentId);
      return store.setContext(a.documentId, d.selection, {
        position: a.position,
        target: a.target,
      });
    },
  );
  add(
    "create_sketch",
    "Create constrained sketch",
    "Create a sketch on the Top (XY), Front (XZ) or Right (YZ) plane, a datum plane, or an inspected planar face. Face sketches project the part origin onto the face, so sketch coordinates stay put when the face grows. Coordinates are plane-local mm.",
    {
      ...write,
      ...named,
      plane: plane.default("XY"),
      origin: vec3.default([0, 0, 0]),
      support: ref.optional(),
      referencePlaneId: id.optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Created sketch", (d) => {
        if (a.support && a.support.kind !== "face")
          throw Error("Sketch support must be a face");
        if (
          a.referencePlaneId &&
          !d.referencePlanes?.some((p) => p.id === a.referencePlaneId)
        )
          throw Error("Reference plane not found");
        const sk: Sketch = {
          id: randomUUID(),
          name: a.name ?? `Sketch ${d.sketches.length + 1}`,
          plane: a.plane,
          origin: a.origin,
          support: a.support,
          ...(a.support ? { frameMode: "origin" as const } : {}),
          referencePlaneId: a.referencePlaneId,
          entities: [],
          constraints: [],
          solver: { dof: 0, residual: 0, status: "fully-constrained" },
        };
        if (a.referencePlaneId) {
          const p = d.referencePlanes!.find(
            (p) => p.id === a.referencePlaneId,
          )!;
          sk.plane = p.plane;
          sk.origin = [...p.origin];
          sk.support = undefined;
        }
        d.sketches.push(sk);
      }),
  );
  add(
    "add_sketch_entity",
    "Draw sketch entity",
    "Add a point (x,y), line (x1,y1,x2,y2), rectangle (x,y,width,height), circle (x,y,radius), three-point arc (x1,y1,xm,ym,x2,y2), or spline through fit points (x0,y0,x1,y1,…; 2 to 64 points; close it by repeating the first point last). Rectangles and circles are centered at x,y. Closed outlines and the regions between intersecting curves can be extruded. Use edit_sketch to draw and constrain several entities atomically.",
    {
      ...write,
      sketchId: id,
      type: entityType,
      values: z.record(z.string(), scalar),
      construction: z.boolean().default(false),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Drew ${a.type}`, (d) => {
        const sk = sketch(d, a.sketchId);
        checkValues(a.type, a.values);
        sk.entities.push({
          id: randomUUID(),
          type: a.type,
          values: a.values,
          construction: a.construction,
        });
        solveSketch(sk);
      }),
  );
  add(
    "add_sketch_constraint",
    "Constrain sketch geometry",
    "Add a geometric relation or driving dimension. Relations: horizontal/vertical (a line, or two points via anchors), coincident, parallel, perpendicular, collinear, equal, concentric, tangent, midpoint (point anchor, line), pointOn (point anchor, line/circle/arc), symmetric (two points about a third line entity, or about axis x/y value), fixed. Dimensions: distance (points via anchors; axis x/y for horizontal/vertical; point-line or line-line perpendicular), length (line), angle (two lines, degrees), radius/diameter (circle/arc), dimension (one value field). Anchors: start/end/mid/center, rectangle corners. Conflicts reject the transaction.",
    {
      ...write,
      sketchId: id,
      type: constraintType,
      entityIds: z.array(id).min(1).max(3),
      anchors: z.array(z.string()).max(2).optional(),
      value: scalar.optional(),
      dimension: z.string().optional(),
      axis: z.enum(["x", "y"]).optional(),
      label: vec2.optional(),
      driven: z.boolean().optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Added ${a.type} constraint`, (d) => {
        const sk = sketch(d, a.sketchId),
          { documentId, expectedRevision, reason, sketchId, ...args } = a;
        const c: Constraint = { ...args, id: randomUUID() };
        if (c.entityIds.some((id) => !sk.entities.some((e) => e.id === id)))
          throw Error("Entity not found");
        captureReference(sk, c);
        sk.constraints.push(c);
        solveSketch(sk);
      }),
  );
  const sketchOperation = z.discriminatedUnion("op", [
    z
      .object({
        op: z.literal("add"),
        ref: z.string().max(40).optional().describe("Temporary name for later operations, e.g. $a"),
        type: entityType,
        values: z.record(z.string(), scalar),
        construction: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        op: z.literal("constrain"),
        type: constraintType,
        entities: z.array(z.string().min(1).max(100)).min(1).max(3),
        anchors: z.array(z.string()).max(2).optional(),
        value: scalar.optional(),
        dimension: z.string().optional(),
        axis: z.enum(["x", "y"]).optional(),
        label: vec2.optional(),
        driven: z.boolean().optional(),
      })
      .strict(),
    z.object({ op: z.literal("delete"), entityId: id }).strict(),
    z.object({ op: z.literal("unconstrain"), constraintId: id }).strict(),
    z
      .object({
        op: z.literal("set"),
        entityId: id,
        values: z.record(z.string(), scalar),
      })
      .strict(),
    z
      .object({
        op: z.literal("drag"),
        entityId: id,
        anchor: z.string().optional(),
        target: vec2,
      })
      .strict(),
    z
      .object({ op: z.literal("construction"), entityId: id, construction: z.boolean() })
      .strict(),
    z
      .object({
        op: z.literal("value"),
        constraintId: id,
        value: scalar.optional(),
        expression: z.string().min(1).max(400).optional().describe("Equation over document variables instead of a number"),
      })
      .strict(),
    z.object({ op: z.literal("label"), constraintId: id, label: vec2 }).strict(),
    z.object({ op: z.literal("driven"), constraintId: id, driven: z.boolean() }).strict(),
    z
      .object({
        op: z.literal("offset"),
        entities: z.array(z.string().min(1).max(100)).min(1).max(100),
        distance: positive,
        toward: vec2.optional().describe("A point on the side to offset toward"),
        side: z.enum(["inside", "outside"]).optional().describe("For closed shapes when no point is given"),
        ref: z.string().max(40).optional().describe("Names the copies $ref.0, $ref.1, … for later operations"),
      })
      .strict(),
    z
      .object({
        op: z.literal("mirror"),
        entities: z.array(z.string().min(1).max(100)).min(1).max(100),
        axis: z.string().min(1).max(100).describe("The line to mirror about"),
        ref: z.string().max(40).optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("fillet"),
        entities: z.array(z.string().min(1).max(100)).length(2).describe("Two lines that share a corner"),
        radius: positive,
        ref: z.string().max(40).optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("convert"),
        refs: z.array(ref).min(1).max(100).describe("Model edges, or faces whose edges to convert"),
        construction: z.boolean().default(false),
        ref: z.string().max(40).optional(),
      })
      .strict(),
    z.object({ op: z.literal("unlink"), entityId: id }).strict(),
    z
      .object({
        op: z.literal("pattern"),
        entities: z.array(z.string().min(1).max(100)).min(1).max(100),
        kind: z.enum(["linear", "circular"]),
        count: z.number().int().min(2).max(100).describe("Instances including the original"),
        spacing: positive.optional().describe("Linear: distance between instances"),
        direction: z.number().finite().min(-360).max(360).default(0).describe("Linear: direction in degrees from the sketch X axis"),
        angle: z.number().finite().gt(0).max(360).default(360).describe("Circular: total angle; 360 spaces instances evenly"),
        center: z.union([z.string().min(1).max(100), vec2]).optional().describe("Circular: a point, circle or arc, or sketch coordinates; default the origin"),
        ref: z.string().max(40).optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("chamfer"),
        entities: z.array(z.string().min(1).max(100)).length(2).describe("Two lines that share a corner"),
        distance: positive,
        distance2: positive.optional().describe("Along the second line; equal distances when omitted"),
        ref: z.string().max(40).optional(),
      })
      .strict(),
  ]);
  add(
    "edit_sketch",
    "Edit sketch geometry",
    "Apply several typed sketch operations atomically, then solve once: add entities (give each a ref like $a to use it in later constrain operations), constrain, delete entities or constraints, set or drag geometry, toggle construction, change dimension values, move dimension labels, or make dimensions driven. Convert model edges (or all edges of faces) into entities that follow the model on every rebuild; unlink one to edit it freely. Sketch tools: linear or circular patterns (one spacing or angle dimension drives every copy), offset lines/arcs/circles/rectangles (connected lines and arcs offset as one chain with one driving offset dimension), mirror about a line (symmetric relations), and fillet or chamfer the corner of two lines (the corner stays as a construction point so dimensions to it survive). Rejected as a whole if the result conflicts.",
    {
      ...write,
      sketchId: id,
      operations: z.array(sketchOperation).min(1).max(200),
    },
    false,
    async (a, s) =>
      mutate(a, s, a.reason ?? "Edited sketch", async (d) => {
        const sk = sketch(d, a.sketchId),
          refs = new Map<string, string>();
        const entityId = (name: string) => {
          const resolved = refs.get(name) ?? name;
          if (!sk.entities.some((e) => e.id === resolved))
            throw Error(`Sketch entity ${name} not found`);
          return resolved;
        };
        const constraint = (id: string) => {
          const c = sk.constraints.find((c) => c.id === id);
          if (!c) throw Error("Constraint not found");
          return c;
        };
        let drag: { entityId: string; anchor?: string; target: [number, number] } | undefined;
        const hold: { entityId: string; keys: string[] }[] = [];
        for (const op of a.operations) {
          switch (op.op) {
            case "add": {
              checkValues(op.type, op.values);
              const e: Entity = {
                id: randomUUID(),
                type: op.type,
                values: { ...op.values },
                construction: op.construction,
              };
              sk.entities.push(e);
              if (op.ref) refs.set(op.ref, e.id);
              break;
            }
            case "constrain": {
              const c: Constraint = {
                id: randomUUID(),
                type: op.type,
                entityIds: op.entities.map(entityId),
                ...(op.anchors ? { anchors: op.anchors } : {}),
                ...(op.value !== undefined ? { value: op.value } : {}),
                ...(op.dimension ? { dimension: op.dimension } : {}),
                ...(op.axis ? { axis: op.axis } : {}),
                ...(op.label ? { label: op.label } : {}),
                ...(op.driven ? { driven: true } : {}),
              };
              captureReference(sk, c);
              sk.constraints.push(c);
              break;
            }
            case "delete": {
              const target = entityId(op.entityId);
              sk.entities = sk.entities.filter((e) => e.id !== target);
              sk.constraints = sk.constraints.filter((c) => !c.entityIds.includes(target));
              break;
            }
            case "unconstrain":
              constraint(op.constraintId);
              sk.constraints = sk.constraints.filter((c) => c.id !== op.constraintId);
              break;
            case "set": {
              const e = sk.entities.find((e) => e.id === entityId(op.entityId))!;
              if (e.projected) throw Error("Converted edges follow the model; unlink the entity to edit it");
              const trims = e.type === "spline" && ("from" in op.values || "to" in op.values);
              for (const [key, value] of Object.entries(op.values)) {
                if (!fieldsOf(e).includes(key) && !(trims && (key === "from" || key === "to")))
                  throw Error(`Unknown ${e.type} value ${key}`);
                e.values[key] = value as number;
              }
              if (trims) checkValues(e.type, e.values);
              hold.push({ entityId: e.id, keys: Object.keys(op.values) });
              break;
            }
            case "drag":
              drag = { entityId: entityId(op.entityId), anchor: op.anchor, target: op.target };
              break;
            case "construction":
              sk.entities.find((e) => e.id === entityId(op.entityId))!.construction =
                op.construction;
              break;
            case "value": {
              const c = constraint(op.constraintId);
              if (c.value === undefined && c.type !== "symmetric")
                throw Error("This relation has no value");
              if ((op.value === undefined) === (op.expression === undefined)) throw Error("Give either a value or an expression");
              if (op.expression !== undefined) {
                c.value = evaluateExpression(op.expression, resolveVariables(d.variables ?? []));
                c.expression = op.expression;
              } else {
                c.value = op.value;
                delete c.expression;
              }
              break;
            }
            case "label":
              constraint(op.constraintId).label = op.label;
              break;
            case "driven": {
              const c = constraint(op.constraintId);
              if (c.value === undefined) throw Error("Only dimensions can be driven");
              c.driven = op.driven;
              break;
            }
            case "convert": {
              const projected = await projectEdges(await store.kernelDocument(d), sk.id, op.refs);
              const made = projected.map((p) => {
                const e: Entity = { id: randomUUID(), type: p.type, values: p.values, construction: op.construction, projected: p.ref };
                sk.entities.push(e);
                return e.id;
              });
              if (op.ref) {
                refs.set(op.ref, made[0]);
                made.forEach((m, i) => refs.set(`${op.ref}.${i}`, m));
              }
              break;
            }
            case "unlink":
              delete sk.entities.find((e) => e.id === entityId(op.entityId))!.projected;
              break;
            case "pattern": {
              const made = patternEntities(
                sk,
                op.entities.map(entityId),
                {
                  kind: op.kind,
                  count: op.count,
                  spacing: op.spacing,
                  direction: op.direction,
                  angle: op.angle,
                  center: typeof op.center === "string" ? entityId(op.center) : op.center,
                },
                randomUUID,
              );
              if (op.ref) {
                refs.set(op.ref, made[0]);
                made.forEach((m, i) => refs.set(`${op.ref}.${i}`, m));
              }
              break;
            }
            case "offset":
            case "mirror":
            case "fillet":
            case "chamfer": {
              const made =
                op.op === "offset"
                  ? offsetEntities(sk, op.entities.map(entityId), { distance: op.distance, toward: op.toward, side: op.side }, randomUUID)
                  : op.op === "mirror"
                    ? mirrorEntities(sk, op.entities.map(entityId), entityId(op.axis), randomUUID)
                    : [
                        cornerEntities(
                          sk,
                          [entityId(op.entities[0]), entityId(op.entities[1])],
                          op.op === "fillet" ? { kind: "fillet", radius: op.radius } : { kind: "chamfer", distance: op.distance, distance2: op.distance2 },
                          randomUUID,
                        ),
                      ];
              if (op.ref) {
                refs.set(op.ref, made[0]);
                made.forEach((m, i) => refs.set(`${op.ref}.${i}`, m));
              }
              break;
            }
          }
        }
        solveSketch(sk, { ...(drag ? { drag } : {}), ...(hold.length ? { hold } : {}) });
      }),
  );
  add(
    "remove_sketch_constraint",
    "Remove sketch constraint",
    "Remove an existing constraint and recalculate remaining degrees of freedom.",
    { ...write, sketchId: id, constraintId: id },
    false,
    async (a, s) =>
      mutate(a, s, "Removed constraint", (d) => {
        const sk = sketch(d, a.sketchId);
        if (!sk.constraints.some((c) => c.id === a.constraintId))
          throw Error("Constraint not found");
        sk.constraints = sk.constraints.filter((c) => c.id !== a.constraintId);
        solveSketch(sk);
      }),
    { destructive: true },
  );
  add(
    "set_dimension",
    "Edit parametric dimension",
    "Change one numeric feature parameter, entity dimension, or driving constraint value and rebuild dependent geometry. Give `value` for a number, or `expression` to drive the dimension by an equation over document variables (see set_variable), such as `width / 2` or `2 * wall + 0.5in`. A typed value replaces an equation. IDs survive edits. No free-form execution is accepted.",
    {
      ...write,
      featureId: id,
      dimension: z.string().min(1).max(80),
      value: scalar.optional(),
      expression: z.string().min(1).max(400).optional().describe("Equation over variables; units mm and degrees, suffixes mm, cm, m, in, ft, deg, rad allowed"),
    },
    false,
    async (a, s) =>
      mutate(a, s, a.expression ? `Set ${a.dimension} = ${a.expression}` : `Set ${a.dimension} to ${a.value} mm`, (d) => {
        if ((a.value === undefined) === (a.expression === undefined)) throw Error("Give either a value or an expression");
        const scope = resolveVariables(d.variables ?? []);
        const value = a.expression !== undefined ? evaluateExpression(a.expression, scope) : a.value!;
        const f = d.features.find((f) => f.id === a.featureId);
        if (f) {
          setFeatureDimension(f, a.dimension, value);
          if (a.expression) f.expressions = { ...f.expressions, [a.dimension]: a.expression };
          else if (f.expressions?.[a.dimension]) {
            delete f.expressions[a.dimension];
            if (!Object.keys(f.expressions).length) delete f.expressions;
          }
          return;
        }
        for (const sk of d.sketches) {
          const e = sk.entities.find((e) => e.id === a.featureId),
            c = sk.constraints.find((c) => c.id === a.featureId);
          if (c) {
            if (c.value === undefined && c.type !== "symmetric")
              throw Error("This constraint has no editable value");
            if (c.driven && a.expression) throw Error("A driven dimension is measured, not set; drive it with an equation after making it driving");
            c.value = value;
            if (a.expression) c.expression = a.expression;
            else delete c.expression;
            solveSketch(sk);
            return;
          }
          if (e) {
            if (a.expression) throw Error("Add a dimension to the sketch, then drive that dimension with an equation");
            if (!fieldsOf(e).includes(a.dimension))
              throw Error("Unknown entity dimension");
            e.values[a.dimension] = value;
            const c = sk.constraints.find(
              (c) =>
                c.type === "dimension" &&
                c.entityIds[0] === e.id &&
                c.dimension === a.dimension,
            );
            if (c) {
              c.value = value;
              delete c.expression;
            }
            solveSketch(sk);
            if (Math.abs(e.values[a.dimension] - value) > 1e-5)
              throw Error("Dimension is controlled by another constraint");
            return;
          }
        }
        throw Error("Dimension target not found");
      }),
  );
  const profileArgs = {
    regions: z
      .array(vec2)
      .max(50)
      .optional()
      .describe(
        "Sketch-plane points inside the regions to use. Omit to use every closed region (nested contours become holes).",
      ),
  };
  const operation = z.enum(["new", "join", "cut", "intersect"]).default("new");
  const solidTarget = (d: Document, a: any) => {
    if (a.featureId) {
      const existing = feature(d, a.featureId);
      const wasNew = existing.params.operation === "new" || !existing.params.operation;
      if (wasNew !== (a.operation === "new"))
        throw Error("Change between a new body and join/cut/intersect by recreating the feature");
      return existing.bodyId;
    }
    if (a.operation === "new") {
      const bid = randomUUID();
      d.bodies.push({
        id: bid,
        name: a.bodyName ?? `Body ${d.bodies.length + 1}`,
        color: "#544841",
        hidden: false,
      });
      return bid;
    }
    if (!a.bodyId) throw Error("Select a target body");
    return a.bodyId;
  };
  add(
    "extrude",
    "Extrude sketch",
    "Extrude closed sketch regions as a new body, or join/cut/intersect an existing body. End conditions: blind, symmetric (mid-plane), two-sided (distance2 opposite), through-all, through-all-both, up-to-face (planar face). Negative distance or reverse flips direction. Optional draft angle tapers side faces.",
    {
      ...write,
      ...named,
      ...redefine,
      sketchId: id,
      bodyId: id.optional(),
      bodyName: z.string().min(1).max(100).optional(),
      operation,
      endType: z
        .enum(["blind", "symmetric", "two-sided", "through-all", "through-all-both", "up-to-face"])
        .default("blind"),
      distance: scalar
        .refine((x) => Math.abs(x) > 1e-5, "Extrusion distance must be nonzero")
        .default(10),
      distance2: positive.optional(),
      reverse: z.boolean().default(false),
      upTo: ref.optional(),
      draftAngle: z.number().finite().min(0).max(45).optional(),
      draftOutward: z.boolean().optional(),
      ...profileArgs,
    },
    false,
    async (a, s) =>
      mutate(a, s, a.operation === "cut" ? "Cut extrude" : "Extruded sketch", (d) => {
        sketch(d, a.sketchId);
        if (a.endType === "up-to-face" && !a.upTo)
          throw Error("Select the face to extrude up to");
        const bid = solidTarget(d, a);
        addFeature(
          d,
          "extrude",
          bid,
          {
            sketchId: a.sketchId,
            operation: a.operation,
            distance: a.distance,
            endType: a.endType,
            ...(a.distance2 ? { distance2: a.distance2 } : {}),
            ...(a.reverse ? { reverse: true } : {}),
            ...(a.upTo ? { upTo: a.upTo } : {}),
            ...(a.draftAngle ? { draftAngle: a.draftAngle, draftOutward: !!a.draftOutward } : {}),
            ...(a.regions?.length ? { regions: a.regions } : {}),
          },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "revolve",
    "Revolve sketch",
    "Revolve closed sketch regions about an axis: a sketch line (usually a construction centerline), a model edge, a cylindrical face axis, a principal axis, or an explicit world axis/axisOrigin. Angle up to 360°; symmetric splits it about the sketch.",
    {
      ...write,
      ...named,
      ...redefine,
      sketchId: id,
      bodyId: id.optional(),
      bodyName: z.string().min(1).max(100).optional(),
      operation,
      angle: positive.max(360).default(360),
      axisRef: axisRef.optional(),
      axis: nonzero.default([0, 1, 0]),
      axisOrigin: vec3.default([0, 0, 0]),
      symmetric: z.boolean().default(false),
      reverse: z.boolean().default(false),
      ...profileArgs,
    },
    false,
    async (a, s) =>
      mutate(a, s, "Revolved sketch", (d) => {
        sketch(d, a.sketchId);
        const bid = solidTarget(d, a);
        addFeature(
          d,
          "revolve",
          bid,
          {
            sketchId: a.sketchId,
            operation: a.operation,
            angle: a.angle,
            ...(a.axisRef ? { axisRef: a.axisRef } : { axis: a.axis, axisOrigin: a.axisOrigin }),
            ...(a.symmetric ? { symmetric: true } : {}),
            ...(a.reverse ? { reverse: true } : {}),
            ...(a.regions?.length ? { regions: a.regions } : {}),
          },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "sweep",
    "Sweep profile along path",
    "Sweep one closed profile sketch along a path sketch (a connected line/arc chain or a closed circle/rectangle). The profile plane must be perpendicular to the path at its start, and the path must start on the profile.",
    {
      ...write,
      ...named,
      ...redefine,
      profileSketchId: id,
      pathSketchId: id,
      bodyId: id.optional(),
      bodyName: z.string().min(1).max(100).optional(),
      operation,
      transition: z.enum(["transformed", "right", "round"]).default("transformed"),
      frenet: z.boolean().default(false),
      reversePath: z.boolean().default(false),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Swept profile", (d) => {
        sketch(d, a.profileSketchId);
        sketch(d, a.pathSketchId);
        if (a.profileSketchId === a.pathSketchId)
          throw Error("Profile and path must be different sketches");
        const bid = solidTarget(d, a);
        addFeature(
          d,
          "sweep",
          bid,
          {
            profileSketchId: a.profileSketchId,
            pathSketchId: a.pathSketchId,
            operation: a.operation,
            transition: a.transition,
            frenet: a.frenet,
            reversePath: a.reversePath,
          },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "loft",
    "Loft between profiles",
    "Loft a solid through two or more closed profile sketches in order (each a single closed outline on its own plane). Ruled lofts use straight sections.",
    {
      ...write,
      ...named,
      ...redefine,
      sketchIds: z.array(id).min(2).max(20),
      bodyId: id.optional(),
      bodyName: z.string().min(1).max(100).optional(),
      operation,
      ruled: z.boolean().default(false),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Lofted profiles", (d) => {
        for (const sid of a.sketchIds) sketch(d, sid);
        if (new Set(a.sketchIds).size !== a.sketchIds.length)
          throw Error("Each loft profile must be a different sketch");
        const bid = solidTarget(d, a);
        addFeature(
          d,
          "loft",
          bid,
          { sketchIds: a.sketchIds, operation: a.operation, ruled: a.ruled },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "create_hole",
    "Hole wizard",
    "Create one hole feature with one or more centers: simple, counterbore, countersink or tapped. Give an ISO metric size (M2–M24) with a clearance fit, or explicit diameters. Place centers by positions on a planar face (relative to the face centroid by default, or to the projected part origin with frame=origin), on a principal plane, or use every point of a sketch (sketchId). Omit depth for through-all; tipAngle adds a drill point to blind holes.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      holeType: z.enum(["simple", "counterbore", "countersink", "tapped"]).optional(),
      size: z.enum(metricSizes.map((m) => m.size) as [string, ...string[]]).optional(),
      fit: z.enum(["close", "normal", "loose"]).optional(),
      diameter: positive.optional(),
      positions: z.array(vec2).min(1).max(100).optional(),
      sketchId: id.optional(),
      plane: plane.default("XY"),
      origin: vec3.default([0, 0, 0]),
      face: ref.optional(),
      frame: z.enum(["face-center", "origin"]).optional(),
      depth: positive.optional(),
      tipAngle: z.number().finite().min(60).max(180).optional(),
      counterboreDiameter: positive.optional(),
      counterboreDepth: positive.optional(),
      countersinkDiameter: positive.optional(),
      countersinkAngle: z.number().finite().min(60).max(120).optional(),
      threadDepth: positive.optional(),
      reverse: z.boolean().optional(),
    },
    false,
    async (a, s) =>
      mutate(
        a,
        s,
        `Added ${a.size ?? `Ø${a.diameter ?? ""}`} ${a.holeType ?? "hole"}`.replace(/\s+/g, " "),
        (d) => {
          if (a.face && (a.face.kind !== "face" || a.face.bodyId !== a.bodyId))
            throw Error("Select a face on the target body");
          if (!a.positions?.length && !a.sketchId)
            throw Error("Give hole positions or a sketch of hole centers");
          if (a.sketchId) sketch(d, a.sketchId);
          if (!a.diameter && !a.size) throw Error("Give a diameter or a standard size");
          if (a.holeType === "tapped" && !a.size)
            throw Error("Tapped holes need a standard thread size");
          if (
            (a.counterboreDiameter || a.counterboreDepth) &&
            !!a.counterboreDiameter !== !!a.counterboreDepth &&
            !a.size
          )
            throw Error("Counterbore needs diameter and depth");
          if (a.counterboreDiameter && a.diameter && a.counterboreDiameter <= a.diameter)
            throw Error("Counterbore diameter must exceed hole diameter");
          const { documentId, expectedRevision, reason, name, bodyId, featureId, ...p } = a;
          if (!p.holeType)
            p.holeType = p.counterboreDiameter
              ? "counterbore"
              : p.countersinkDiameter
                ? "countersink"
                : "simple";
          if (p.holeType === "counterbore" && !p.counterboreDiameter && !p.size)
            throw Error("Counterbore needs a size or diameter and depth");
          addFeature(d, "hole", bodyId, p, name, featureId);
        },
      ),
  );
  /**
   * Two timing pulleys in an assembly, as the belt sees them: each pulley's
   * axis (from its placed body) and pitch radius (from its pulley feature).
   */
  const pulleyPair = async (documentId: string, componentIds: [string, string]) => {
    const asm = await store.read(documentId),
      view = await store.view(asm);
    const pulleys = await Promise.all(
      componentIds.map(async (cid) => {
        const c = allComponents(asm).find((x) => x.id === cid);
        if (!c?.source) throw Error("Pick two inserted pulley parts");
        const part = await store.read(c.source.documentId),
          feature = part.features.find((f) => f.type === "pulley" && !f.suppressed);
        if (!feature) throw Error(`${c.name} is not a timing pulley; make one with create_pulley`);
        const body = view.geometry.bodies.find((b) => b.id === `${c.id}/${feature.bodyId}`);
        if (!body) throw Error(`${c.name} is hidden`);
        // The axis: normal of the largest flat face, through the center of mass.
        const end = body.topology.filter((t) => t.kind === "face" && t.geomType === "PLANE" && t.normal).sort((x, y) => (y.area ?? 0) - (x.area ?? 0))[0];
        const belt = belts[feature.params.belt as BeltType];
        return { component: c, center: body.centerOfMass, axis: end.normal!, belt, type: feature.params.belt as BeltType, teeth: feature.params.teeth as number, width: feature.params.width as number, pitchRadius: (feature.params.teeth * belt.pitch) / (2 * Math.PI) };
      }),
    );
    const [a, b] = pulleys;
    if (a.type !== b.type) throw Error(`The pulleys take different belts (${a.type} and ${b.type})`);
    const dotN = a.axis[0] * b.axis[0] + a.axis[1] * b.axis[1] + a.axis[2] * b.axis[2];
    if (Math.abs(dotN) < 1 - 1e-6) throw Error("The pulley shafts must be parallel");
    const d = [0, 1, 2].map((k) => b.center[k] - a.center[k]) as Vec3,
      offset = d[0] * a.axis[0] + d[1] * a.axis[1] + d[2] * a.axis[2];
    if (Math.abs(offset) > 0.5) throw Error(`The pulleys are ${Math.abs(offset).toFixed(2)} mm out of line; align their mid-planes`);
    const inPlane = [0, 1, 2].map((k) => d[k] - offset * a.axis[k]) as Vec3,
      c = Math.hypot(...inPlane);
    const length = beltLength(a.pitchRadius, b.pitchRadius, c),
      teeth = Math.round(length / a.belt.pitch);
    return { a, b, c, inPlane, length, teeth, exactCenter: centerFor(a.pitchRadius, b.pitchRadius, teeth * a.belt.pitch) };
  };
  const pulleyIds = z.array(id).length(2).describe("The two pulley components");
  add(
    "belt_length",
    "Belt length",
    "For two timing pulleys in an assembly: their center distance, the belt's pitch length and tooth count there, the nearest whole-tooth belt, and the center distance that belt needs.",
    { ...base, pulleys: pulleyIds },
    true,
    async (a) => {
      const pair = await pulleyPair(a.documentId, a.pulleys);
      return { belt: pair.a.type, centerDistance: pair.c, pitchLength: pair.length, teeth: pair.length / pair.a.belt.pitch, standardTeeth: pair.teeth, standardLength: pair.teeth * pair.a.belt.pitch, centerForStandard: pair.exactCenter };
    },
  );
  add(
    "create_belt",
    "Belt",
    "Add a timing belt over two pulleys in an assembly (made with create_pulley, in line and on parallel shafts). The belt follows its pulleys: moved or re-mated pulleys resize it. It is sized to the nearest whole number of teeth, its body named for ordering (for example 'HTD 5M belt 75T 375 mm'), and it counts in the BOM and the mass. When the pulleys are not at that belt's center distance, the assembly warns with the distance it needs.",
    { ...write, ...named, pulleys: pulleyIds, width: positive.optional().describe("Belt width; default 1 mm narrower than the pulleys") },
    false,
    async (a, s) => {
      const pair = await pulleyPair(a.documentId, a.pulleys);
      const spec = `${pair.a.type} belt ${pair.teeth}T ${Math.round(pair.teeth * pair.a.belt.pitch)} mm`;
      return mutate(a, s, `Added ${spec}; centers ${pair.exactCenter.toFixed(2)} mm apart for exactly ${pair.teeth} teeth (now ${pair.c.toFixed(2)})`, (d) => {
        (d.components ??= []).push({
          id: randomUUID(),
          name: a.name ?? `Belt ${d.components.filter((c) => c.belt).length + 1}`,
          bodyIds: [],
          belt: { pulleys: a.pulleys, ...(a.width ? { width: a.width } : {}) },
          grounded: true,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          explode: [0, 0, 0],
        });
      });
    },
  );
  add(
    "create_hole_series",
    "Hole series",
    "In an assembly, drill one set of aligned holes through every inserted part the hole axes pass through, such as bolt holes through stacked chassis plates and standoffs. Start on a planar face of the first part; positions are on that face, relative to the assembly origin projected onto it. Each part gets a real hole feature in its own document: the first part can be counterbored or countersunk, the parts between get clearance holes, and the last part can be tapped. Nothing is changed unless every part takes its holes.",
    {
      ...write,
      face: ref,
      positions: z.array(vec2).min(1).max(50),
      size: z.enum(metricSizes.map((m) => m.size) as [string, ...string[]]).optional(),
      fit: z.enum(["close", "normal", "loose"]).optional(),
      diameter: positive.optional(),
      start: z.enum(["simple", "counterbore", "countersink"]).default("simple"),
      end: z.enum(["clearance", "tapped"]).default("clearance"),
      components: z.array(id).max(50).optional().describe("Only drill these components; default every part the axes cross"),
    },
    false,
    async (a, s) => {
      if (!a.size && !a.diameter) throw Error("Give a standard size or a diameter");
      if ((a.end === "tapped" || a.start !== "simple") && !a.size) throw Error("Counterbores, countersinks and tapped ends need a standard size");
      const asm = await store.read(a.documentId);
      if (asm.revision !== a.expectedRevision) throw Error(`Revision conflict: expected ${a.expectedRevision}, current ${asm.revision}. Inspect the document and retry.`);
      const view = await store.view(asm);
      const start = view.geometry.bodies.flatMap((b) => b.topology).find((t) => t.id === a.face.id);
      if (!start || start.kind !== "face" || start.geomType !== "PLANE" || !start.normal) throw Error("Start on a planar face");
      const frame = originFrame(start.center, start.normal),
        into = frame.normal.map((v) => -v) as Vec3;
      const lines = a.positions.map(([x, y]: Vec2) => ({
        origin: [0, 1, 2].map((k) => frame.origin[k] + x * frame.xDir[k] + y * frame.yDir[k]) as Vec3,
        direction: into,
      }));
      const crossings = await lineCrossings(await store.kernelDocument(asm), lines);
      // The parts each hole passes through, from the start face on.
      type Entry = { component: ReturnType<typeof allComponents>[number]; bodyId: string; first: number; points: { line: number; enter: number }[] };
      const parts = new Map<string, Entry>();
      crossings.forEach((hits, line) => {
        for (const hit of hits) {
          if (hit.exit < 1e-6) continue;
          const c = componentOf(asm, hit.bodyId);
          if (!c?.source || (a.components && !a.components.includes(c.id))) continue;
          const key = `${c.id}|${hit.bodyId}`,
            entry = parts.get(key) ?? { component: c, bodyId: hit.bodyId, first: Infinity, points: [] };
          entry.first = Math.min(entry.first, hit.enter);
          if (!entry.points.some((p) => p.line === line)) entry.points.push({ line, enter: Math.max(0, hit.enter) });
          parts.set(key, entry);
        }
      });
      const ordered = [...parts.values()].sort((x, y) => x.first - y.first);
      if (!ordered.length) throw Error("The hole axes do not pass through any inserted part");
      const placements = view.geometry.placements ?? {};
      const createHole = tools.find((t) => t.name === "create_hole")!;
      const done: string[] = [];
      try {
        for (const [index, part] of ordered.entries()) {
          const partId = part.component.source!.documentId,
            localBody = part.bodyId.slice(part.component.id.length + 1);
          const partView = await store.view(await store.read(partId));
          // Assembly coordinates to the part's own.
          const p = placements[part.bodyId] ?? { position: [0, 0, 0] as Vec3, quaternion: [0, 0, 0, 1] as [number, number, number, number] };
          const inverse = new Quaternion(...p.quaternion).invert();
          const toPart = (v: Vec3, point: boolean) => {
            const w = new Vector3(...(point ? [v[0] - p.position[0], v[1] - p.position[1], v[2] - p.position[2]] : v)).applyQuaternion(inverse);
            return [w.x, w.y, w.z] as Vec3;
          };
          const dir = toPart(into, false);
          const faces = partView.geometry.bodies.find((b) => b.id === localBody)?.topology.filter((t) => t.kind === "face" && t.geomType === "PLANE" && t.normal) ?? [];
          const byFace = new Map<string, { face: Topology; positions: Vec2[] }>();
          for (const point of part.points) {
            const at = toPart(lines[point.line].origin.map((v: number, k: number) => v + into[k] * point.enter) as Vec3, true);
            const face = faces.find(
              (f) =>
                f.normal![0] * dir[0] + f.normal![1] * dir[1] + f.normal![2] * dir[2] < -1 + 1e-6 &&
                Math.abs((at[0] - f.center[0]) * f.normal![0] + (at[1] - f.center[1]) * f.normal![1] + (at[2] - f.center[2]) * f.normal![2]) < 1e-4,
            );
            if (!face) throw Error(`${part.component.name}: the hole does not enter through a flat face square to it`);
            const f = originFrame(face.center, face.normal!),
              d = [0, 1, 2].map((k) => at[k] - f.origin[k]) as Vec3;
            const pos: Vec2 = [d[0] * f.xDir[0] + d[1] * f.xDir[1] + d[2] * f.xDir[2], d[0] * f.yDir[0] + d[1] * f.yDir[1] + d[2] * f.yDir[2]];
            const group = byFace.get(face.id) ?? { face, positions: [] };
            if (!group.positions.some((q) => Math.hypot(q[0] - pos[0], q[1] - pos[1]) < 1e-6)) group.positions.push(pos);
            byFace.set(face.id, group);
          }
          const last = index === ordered.length - 1 && ordered.length > 1;
          const holeType = index === 0 ? a.start : last && a.end === "tapped" ? "tapped" : "simple";
          for (const { face, positions } of byFace.values()) {
            const latest = await store.read(partId);
            await createHole.handler(
              createHole.schema.parse({
                documentId: partId,
                expectedRevision: latest.revision,
                bodyId: localBody,
                face: { id: face.id, bodyId: face.bodyId, kind: "face", geomType: "PLANE" },
                frame: "origin",
                positions,
                holeType,
                ...(a.size ? { size: a.size } : { diameter: a.diameter }),
                ...(a.fit && holeType !== "tapped" ? { fit: a.fit } : {}),
                reason: `Hole series from ${asm.name}`,
              }),
              s,
            );
            done.push(partId);
          }
        }
      } catch (error) {
        // Take back the holes already added, newest first.
        for (const partId of done.reverse()) {
          const latest = await store.read(partId);
          await store.history(partId, latest.revision, "undo").catch(() => undefined);
        }
        throw error;
      }
      // The assembly records the series; its instances already follow their parts.
      return mutate(a, s, `Hole series through ${ordered.map((x) => x.component.name).join(", ")}`, () => {});
    },
  );
  add(
    "set_hole_positions",
    "Move hole centers",
    "Edit the plane-local centers of an existing hole feature, preserving its diameter, counterbore, depth, identity, and history. With the same number of centers, each hole moves in order and references to it follow; when centers are added or removed, centers that did not move keep their identity and new centers are new holes.",
    { ...write, featureId: id, positions: z.array(vec2).min(1).max(50) },
    false,
    async (a, s) =>
      mutate(a, s, "Moved hole centers", (d) => {
        const f = feature(d, a.featureId);
        if (f.type !== "hole") throw Error("Target is not a hole feature");
        if (f.params.sketchId) throw Error("These hole centers come from a sketch; edit the sketch points instead");
        setHolePositions(f.params, f.params, a.positions);
      }),
  );
  add(
    "set_hole_counterbore",
    "Edit hole counterbore",
    "Add, change, or remove a counterbore on an existing hole feature without replacing its identity. Supply diameter and depth together, or omit both to remove the counterbore.",
    {
      ...write,
      featureId: id,
      diameter: positive.optional(),
      depth: positive.optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Changed hole counterbore", (d) => {
        const f = feature(d, a.featureId);
        if (f.type !== "hole") throw Error("Target is not a hole feature");
        if (!!a.diameter !== !!a.depth)
          throw Error("Counterbore requires diameter and depth");
        if (a.diameter) {
          f.params.counterboreDiameter = a.diameter;
          f.params.counterboreDepth = a.depth;
          f.params.holeType = "counterbore";
        } else {
          delete f.params.counterboreDiameter;
          delete f.params.counterboreDepth;
          if (f.params.holeType === "counterbore") f.params.holeType = "simple";
        }
      }),
  );
  add(
    "fillet_edges",
    "Fillet edges",
    "Round inspected edge references, or all/vertical/horizontal edges, with one radius. A stale or ambiguous topology reference rejects the change.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      radius: positive,
      edges: z.array(ref).max(200).optional(),
      selector: z.enum(["all", "vertical", "horizontal"]).default("all"),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Rounded edges", (d) => {
        if (a.edges?.some((e: TopologyRef) => e.kind !== "edge" || e.bodyId !== a.bodyId))
          throw Error("Edges must belong to target body");
        addFeature(
          d,
          "fillet",
          a.bodyId,
          { radius: a.radius, edges: a.edges, selector: a.selector },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "chamfer_edges",
    "Chamfer edges",
    "Bevel edges: equal distance, two distances, or distance and angle. Asymmetric chamfers measure the first distance on one adjacent face; flip swaps the faces. Without edges, equal chamfers apply to all/vertical/horizontal edges.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      chamferType: z.enum(["equal", "two-distance", "distance-angle"]).default("equal"),
      distance: positive,
      distance2: positive.optional(),
      angle: z.number().finite().gt(0).lt(90).optional(),
      flip: z.boolean().optional(),
      edges: z.array(ref).max(200).optional(),
      selector: z.enum(["all", "vertical", "horizontal"]).default("all"),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Chamfered edges", (d) => {
        if (a.edges?.some((e: TopologyRef) => e.kind !== "edge" || e.bodyId !== a.bodyId))
          throw Error("Edges must belong to target body");
        if (a.chamferType !== "equal" && !a.edges?.length)
          throw Error("Select edges for an asymmetric chamfer");
        if (a.chamferType === "two-distance" && !a.distance2)
          throw Error("Two-distance chamfers need distance2");
        addFeature(
          d,
          "chamfer",
          a.bodyId,
          {
            chamferType: a.chamferType,
            distance: a.distance,
            ...(a.distance2 ? { distance2: a.distance2 } : {}),
            ...(a.chamferType === "distance-angle" ? { angle: a.angle ?? 45 } : {}),
            ...(a.flip ? { flip: true } : {}),
            edges: a.edges,
            selector: a.selector,
          },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "fillet_faces",
    "Fillet face edges",
    "Round the boundary edges of selected faces on one body. This is face-driven edge rounding; it is not a face-to-face rolling-ball blend.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      faces: z.array(ref).min(1).max(100),
      radius: positive,
    },
    false,
    async (a, source) =>
      mutate(a, source, "Rounded face boundaries", (d) => {
        if (
          a.faces.some(
            (f: TopologyRef) => f.kind !== "face" || f.bodyId !== a.bodyId,
          )
        )
          throw Error("Faces must belong to the target body");
        addFeature(
          d,
          "fillet",
          a.bodyId,
          { faces: a.faces, radius: a.radius },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "fillet_body",
    "Fillet body edges",
    "Round all eligible sharp edges of the selected solid with one radius. Kernel failures preserve the existing model.",
    { ...write, ...named, ...redefine, bodyId: id, radius: positive },
    false,
    async (a, source) =>
      mutate(a, source, "Rounded body edges", (d) => {
        body(d, a.bodyId);
        addFeature(
          d,
          "fillet",
          a.bodyId,
          { radius: a.radius, selector: "all" },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "variable_fillet_edges",
    "Variable radius fillet",
    "Create an OpenCascade variable-radius fillet. Each selected edge has an ordered radius law: relative positions from 0 to 1 including both endpoints. Intermediate points are interpolated by the kernel along the tangent contour. Positions follow the native edge orientation.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      profiles: z
        .array(
          z
            .object({
              edge: ref,
              points: z
                .array(
                  z
                    .object({
                      position: z.number().finite().min(0).max(1),
                      radius: positive,
                    })
                    .strict(),
                )
                .min(2)
                .max(20),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    },
    false,
    async (a, source) =>
      mutate(a, source, "Created variable fillet", (d) => {
        const seen = new Set();
        for (const profile of a.profiles) {
          if (
            profile.edge.kind !== "edge" ||
            profile.edge.bodyId !== a.bodyId ||
            seen.has(profile.edge.id)
          )
            throw Error("Select distinct edges of the target body");
          seen.add(profile.edge.id);
          if (
            profile.points[0].position !== 0 ||
            profile.points.at(-1).position !== 1 ||
            profile.points.some(
              (p: any, i: number) =>
                i > 0 && p.position <= profile.points[i - 1].position,
            )
          )
            throw Error(
              "Radius points must increase from 0 to 1, including both endpoints",
            );
        }
        addFeature(d, "fillet", a.bodyId, { profiles: a.profiles }, a.name, a.featureId);
      }),
  );
  add(
    "set_variable_fillet_profile",
    "Edit variable fillet radius law",
    "Replace one saved edge radius law on a variable fillet and rebuild downstream features. The edge remains the feature's original semantic reference. Ordered positions must include 0 and 1.",
    {
      ...write,
      featureId: id,
      edgeId: id,
      points: z
        .array(
          z
            .object({
              position: z.number().finite().min(0).max(1),
              radius: positive,
            })
            .strict(),
        )
        .min(2)
        .max(20),
    },
    false,
    async (a, source) =>
      mutate(a, source, "Edited variable fillet radii", (d) => {
        const f = feature(d, a.featureId);
        const profile =
          f.type === "fillet" &&
          f.params.profiles?.find((p: any) => p.edge.id === a.edgeId);
        if (!profile) throw Error("Variable fillet edge profile not found");
        profile.points = a.points;
      }),
  );
  const patternSource = (d: Document, a: any) => {
    const ids: string[] = a.featureIds ?? (a.featureId ? [a.featureId] : []);
    for (const fid of ids) {
      const f = feature(d, fid);
      if (f.bodyId !== a.bodyId)
        throw Error(`${f.name} belongs to a different body`);
      if (!["extrude", "revolve", "sweep", "loft", "hole"].includes(f.type))
        throw Error(`${f.name}: only extrude, revolve, sweep, loft and hole features can be patterned or mirrored`);
      if (f.type !== "hole" && (f.params.operation ?? "new") === "new")
        throw Error(`${f.name} creates its own body; pattern the body instead`);
    }
    return ids;
  };
  const skipped = z.array(z.number().int().min(2).max(2500)).max(2499).default([]);
  add(
    "create_circular_pattern",
    "Circular pattern",
    "Repeat features (extrude/revolve/sweep/loft join or cut, and holes) or the whole body by rotation about an axis: axisRef (edge, cylindrical face, sketch line, principal axis) or explicit axis/axisOrigin. A full 360 degree pattern has no duplicate final instance; partial angles include both ends. Skipped instance numbers run 2..count; the original is instance 1.",
    {
      ...write,
      ...named,
      bodyId: id,
      featureId: id
        .optional()
        .describe("A feature to pattern, or an existing pattern feature to redefine in place"),
      featureIds: z.array(id).max(50).optional(),
      axisRef: axisRef.optional(),
      axis: nonzero.default([0, 0, 1]),
      axisOrigin: vec3.default([0, 0, 0]),
      angle: z.number().finite().gt(0).max(360).default(360),
      count: z.number().int().min(2).max(200),
      skippedInstances: skipped,
    },
    false,
    async (a, source) =>
      mutate(a, source, "Created circular pattern", (d) => {
        // featureId historically named the patterned hole; redefinition uses redefineId.
        const existing = a.featureId && d.features.find((f) => f.id === a.featureId && f.type === "pattern");
        const featureIds = patternSource(d, {
          ...a,
          featureId: existing ? undefined : a.featureId,
        });
        if (
          a.skippedInstances.some((i: number) => i > a.count) ||
          new Set(a.skippedInstances).size !== a.skippedInstances.length
        )
          throw Error("Skipped instances must be distinct and within the pattern count");
        const length = Math.hypot(...a.axis);
        addFeature(
          d,
          "pattern",
          a.bodyId,
          {
            kind: "circular",
            ...(featureIds.length ? { featureIds } : {}),
            ...(a.axisRef
              ? { axisRef: a.axisRef }
              : { axis: a.axis.map((v: number) => v / length), axisOrigin: a.axisOrigin }),
            angle: a.angle,
            count: a.count,
            skippedInstances: a.skippedInstances,
          },
          a.name ?? (existing ? undefined : "Circular Pattern"),
          existing ? a.featureId : undefined,
        );
      }),
  );
  add(
    "create_linear_pattern",
    "Linear pattern",
    "Repeat features (extrude/revolve/sweep/loft join or cut, and holes) or the whole body along a direction (vector, or directionRef edge/axis) at a spacing and count, optionally in a second direction. Skipped instances are numbered row by row starting at 1 for the original.",
    {
      ...write,
      ...named,
      bodyId: id,
      featureId: id
        .optional()
        .describe("A feature to pattern, or an existing pattern feature to redefine in place"),
      featureIds: z.array(id).max(50).optional(),
      direction: nonzero.default([1, 0, 0]),
      directionRef: axisRef.optional(),
      reverseDirection: z.boolean().optional(),
      spacing: positive,
      count: z.number().int().min(2).max(200),
      direction2: nonzero.optional(),
      spacing2: positive.optional(),
      count2: z.number().int().min(1).max(200).optional(),
      skippedInstances: skipped,
    },
    false,
    async (a, s) =>
      mutate(a, s, `Created ${a.count * (a.count2 ?? 1)}-instance pattern`, (d) => {
        const existing = a.featureId && d.features.find((f) => f.id === a.featureId && f.type === "pattern");
        const featureIds = patternSource(d, { ...a, featureId: existing ? undefined : a.featureId });
        if (a.count * (a.count2 ?? 1) > 2500) throw Error("Patterns are limited to 2500 instances");
        const unitVec = (v: number[]) => {
          const n = Math.hypot(...v);
          return v.map((x) => x / n);
        };
        addFeature(
          d,
          "pattern",
          a.bodyId,
          {
            kind: "linear",
            ...(featureIds.length ? { featureIds } : {}),
            direction: unitVec(a.direction),
            ...(a.directionRef ? { directionRef: a.directionRef } : {}),
            ...(a.reverseDirection ? { reverseDirection: true } : {}),
            spacing: a.spacing,
            count: a.count,
            ...(a.direction2 && (a.count2 ?? 1) > 1
              ? { direction2: unitVec(a.direction2), spacing2: a.spacing2 ?? a.spacing, count2: a.count2 }
              : {}),
            skippedInstances: a.skippedInstances,
          },
          a.name ?? (existing ? undefined : "Linear Pattern"),
          existing ? a.featureId : undefined,
        );
      }),
  );
  add(
    "mirror_body",
    "Mirror",
    "Mirror features (extrude/revolve/sweep/loft join or cut, and holes) or the whole body across a plane: mirrorPlane (principal plane with offset, datum plane, or planar face), or a principal plane with an origin. Body mirrors union the copy with the original.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      featureIds: z.array(id).max(50).optional(),
      mirrorPlane: planeRef.optional(),
      plane: plane.default("YZ"),
      origin: vec3.default([0, 0, 0]),
    },
    false,
    async (a, s) =>
      mutate(a, s, a.featureIds?.length ? "Mirrored features" : "Mirrored body", (d) => {
        const featureIds = patternSource(d, { ...a, featureId: undefined });
        addFeature(
          d,
          "mirror",
          a.bodyId,
          {
            ...(featureIds.length ? { featureIds } : {}),
            ...(a.mirrorPlane ? { mirrorPlane: a.mirrorPlane } : { plane: a.plane, origin: a.origin }),
          },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "boolean_bodies",
    "Combine solid bodies",
    "Union, subtract, or intersect two solid bodies. The tool body is retained and hidden; both histories remain editable.",
    {
      ...write,
      ...named,
      bodyId: id,
      toolBodyId: id,
      operation: z.enum(["union", "subtract", "intersect"]),
      ...redefine,
    },
    false,
    async (a, s) =>
      mutate(a, s, `${a.operation} bodies`, (d) => {
        if (a.bodyId === a.toolBodyId) throw Error("Choose different bodies");
        body(d, a.toolBodyId).hidden = true;
        addFeature(
          d,
          "boolean",
          a.bodyId,
          { toolBodyId: a.toolBodyId, operation: a.operation },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "shell_body",
    "Hollow solid",
    "Remove selected planar or curved faces and offset remaining walls inward by thickness.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      thickness: positive,
      faces: z.array(ref).min(1).max(20),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Shelled body", (d) => {
        if (
          a.faces.some(
            (f: TopologyRef) => f.kind !== "face" || f.bodyId !== a.bodyId,
          )
        )
          throw Error("Select faces on the target body");
        addFeature(
          d,
          "shell",
          a.bodyId,
          { faces: a.faces, thickness: a.thickness },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "move_body",
    "Move or copy body",
    "Translate and optionally rotate a body (degrees about axis through rotationOrigin), recorded in the feature tree. With copy, the moved copy becomes a new body and the original stays.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      translation: vec3,
      angle: scalar.default(0),
      axis: nonzero.default([0, 0, 1]),
      rotationOrigin: vec3.default([0, 0, 0]),
      copy: z.boolean().default(false),
    },
    false,
    async (a, s) =>
      mutate(a, s, a.copy ? "Copied body" : "Moved body", (d) => {
        let newBodyId: string | undefined;
        if (a.featureId) newBodyId = feature(d, a.featureId).params.newBodyId;
        else if (a.copy) {
          newBodyId = randomUUID();
          d.bodies.push({
            id: newBodyId,
            name: `${body(d, a.bodyId).name} copy`,
            color: body(d, a.bodyId).color,
            hidden: false,
          });
        }
        addFeature(
          d,
          "transform",
          a.bodyId,
          {
            translation: a.translation,
            angle: a.angle,
            axis: a.axis,
            rotationOrigin: a.rotationOrigin,
            ...(newBodyId ? { copy: true, newBodyId } : {}),
          },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "draft_faces",
    "Draft faces",
    "Tilt selected faces by an angle (degrees) about their intersection with a neutral plane, pulling along the plane normal (reverse flips the pull direction). Used for molded and cast parts.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      faces: z.array(ref).min(1).max(100),
      neutral: planeRef,
      angle: z.number().finite().gt(0).max(45),
      reverse: z.boolean().default(false),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Drafted faces ${a.angle}°`, (d) => {
        if (a.faces.some((f: TopologyRef) => f.kind !== "face" || f.bodyId !== a.bodyId))
          throw Error("Select faces on the target body");
        addFeature(
          d,
          "draft",
          a.bodyId,
          { faces: a.faces, neutral: a.neutral, angle: a.angle, reverse: a.reverse },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "move_face",
    "Move face",
    "Direct edit: offset planar faces along their normals, as in Move Face or Press Pull. A positive offset adds material (pulls the face out), a negative one removes it. Works on any body, including imported STEP and STL solids, when the faces around each moved face are square to it (side walls, hole walls); the moved face keeps its identity, so sketches, mates and drawing dimensions on it follow.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      faces: z.array(ref).min(1).max(50),
      offset: z.number().finite().refine((v) => v !== 0 && Math.abs(v) <= 10000, "Offset must be non-zero and within ±10000 mm"),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Moved ${a.faces.length === 1 ? "face" : `${a.faces.length} faces`} ${a.offset} mm`, (d) => {
        if (a.faces.some((f: TopologyRef) => f.kind !== "face" || f.bodyId !== a.bodyId))
          throw Error("Select faces on the target body");
        addFeature(d, "moveFace", a.bodyId, { faces: a.faces, offset: a.offset }, a.name, a.featureId);
      }),
  );
  /** A new body for a generated part, or the body of the feature being redefined. */
  const generatedBody = (d: Document, featureId: string | undefined, name: string) => {
    if (featureId) return feature(d, featureId).bodyId;
    const bodyId = randomUUID();
    d.bodies.push({ id: bodyId, name, color: "#544841", hidden: false });
    return bodyId;
  };
  add(
    "create_gear",
    "Spur gear",
    "Generate an involute spur gear as a new body: module (mm), number of teeth, pressure angle (20° standard), face width and an optional bore. It sits on a plane with its center at a point in that plane; phase turns the teeth so two gears mesh. Two gears of one module mesh at a center distance of module × (teeth₁ + teeth₂) / 2. Pitch diameter = module × teeth; outside diameter = module × (teeth + 2). Backlash (default 0.04 × module for a pair) thins each tooth by half of it at the pitch circle, so meshing gears do not bind.",
    {
      ...write,
      ...named,
      ...redefine,
      module: z.number().finite().min(0.2).max(20),
      teeth: z.number().int().min(6).max(300),
      pressureAngle: z.number().finite().min(14.5).max(30).default(20),
      width: positive,
      bore: z.number().finite().min(0).max(1000).default(0),
      plane: planeRef.default({ kind: "principal", plane: "XY" }),
      center: vec2.default([0, 0]),
      phase: z.number().finite().default(0).describe("Degrees to turn the teeth"),
      backlash: z.number().finite().min(0).optional().describe("Backlash of a pair in mm; default 0.04 × module"),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Spur gear m${a.module} × ${a.teeth}`, (d) => {
        const backlash = a.backlash ?? Math.round(0.04 * a.module * 1e4) / 1e4;
        if (backlash > 0.25 * a.module) throw Error(`Backlash beyond ${0.25 * a.module} mm (a quarter of the module) leaves the teeth too thin`);
        const bodyId = generatedBody(d, a.featureId, a.name ?? `Gear m${a.module} ${a.teeth}T`);
        addFeature(d, "gear", bodyId, { module: a.module, teeth: a.teeth, pressureAngle: a.pressureAngle, width: a.width, bore: a.bore, plane: a.plane, center: a.center, phase: a.phase, backlash }, a.name ? `${a.name}` : undefined, a.featureId);
      }),
  );
  add(
    "create_pulley",
    "Timing pulley",
    `Generate a timing pulley as a new body for a GT2, HTD 3M or HTD 5M belt: number of teeth, width, optional bore and flanges. Its outside diameter follows the belt's pitch (pitch diameter = teeth × pitch / π, less the pitch-line offset). Pair pulleys with a belt using create_belt in an assembly.`,
    {
      ...write,
      ...named,
      ...redefine,
      belt: z.enum(Object.keys(belts) as [BeltType, ...BeltType[]]),
      teeth: z.number().int().min(10).max(200),
      width: positive,
      bore: z.number().finite().min(0).max(1000).default(0),
      flanges: z.boolean().default(true),
      plane: planeRef.default({ kind: "principal", plane: "XY" }),
      center: vec2.default([0, 0]),
    },
    false,
    async (a, s) =>
      mutate(a, s, `${a.belt} pulley ${a.teeth}T`, (d) => {
        const bodyId = generatedBody(d, a.featureId, a.name ?? `${a.belt} pulley ${a.teeth}T`);
        addFeature(d, "pulley", bodyId, { belt: a.belt, teeth: a.teeth, width: a.width, bore: a.bore, flanges: a.flanges, plane: a.plane, center: a.center }, a.name, a.featureId);
      }),
  );
  const memberProfile = z
    .object({
      kind: z.enum(["square-tube", "rect-tube", "round-tube", "angle", "flat-bar", "channel"]),
      width: positive.describe("Across, or the outside diameter of round tube"),
      height: positive.optional().describe("Up from the sketch; rectangular tube, angle and channel"),
      thickness: positive.describe("Wall or leg thickness"),
    })
    .strict();
  add(
    "create_structural_member",
    "Structural member",
    "Weldment frame: sweep a tube or bar profile along sketch lines, one solid body per line, for welded robot frames. Profiles: square-tube, rect-tube, round-tube, angle, flat-bar, channel (width across, height up from the sketch, wall thickness). Where lines meet, corners are mitered, or butted (the earlier line runs through, the later stops at its side; for square corners). Members follow the sketch. Give featureId of any member to change the whole group's profile or corners.",
    {
      ...write,
      ...redefine,
      sketchId: id.optional(),
      entities: z.array(id).max(200).optional().describe("Sketch lines; default every non-construction line"),
      profile: memberProfile,
      corner: z.enum(["miter", "butt"]).default("miter"),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Structural members: ${profileLabel(a.profile)}`, (d) => {
        profileOutline(a.profile);
        if (a.featureId) {
          const group = feature(d, a.featureId).params.group as string[];
          for (const f of d.features.filter((x) => x.type === "member" && (x.params.group as string[]).join() === group.join()))
            f.params = { ...f.params, profile: a.profile, corner: a.corner };
          return;
        }
        if (!a.sketchId) throw Error("Give the sketch whose lines the members follow");
        const sk = sketch(d, a.sketchId);
        const lines: string[] = a.entities ?? sk.entities.filter((e) => e.type === "line" && !e.construction).map((e) => e.id);
        if (!lines.length) throw Error("The sketch has no lines to follow");
        for (const id of lines) if (sk.entities.find((e) => e.id === id)?.type !== "line") throw Error("Members follow sketch lines");
        lines.forEach((entityId: string, i: number) => {
          const bodyId = randomUUID(),
            label = `${profileLabel(a.profile)} · ${d.features.filter((f) => f.type === "member").length + 1}`;
          d.bodies.push({ id: bodyId, name: label, color: "#544841", hidden: false });
          addFeature(d, "member", bodyId, { sketchId: a.sketchId, entityId, group: lines, profile: a.profile, corner: a.corner }, i === 0 ? `Members (${profileLabel(a.profile)})` : `Member ${i + 1}`);
        });
      }),
  );
  add(
    "create_weld_bead",
    "Weld bead",
    "Add fillet weld beads along inside corner edges of a body (combine frame members into one body first): a right-triangle bead with the given leg size, which adds its mass.",
    { ...write, ...named, ...redefine, bodyId: id, edges: z.array(ref).min(1).max(100), size: positive.describe("Leg size of the weld") },
    false,
    async (a, s) =>
      mutate(a, s, `Weld bead ${a.size} mm`, (d) => {
        if (a.edges.some((e: TopologyRef) => e.kind !== "edge" || e.bodyId !== a.bodyId)) throw Error("Select edges of the target body");
        addFeature(d, "weld", a.bodyId, { edges: a.edges, size: a.size }, a.name, a.featureId);
      }),
  );
  add(
    "cut_list",
    "Weldment cut list",
    "The structural members of a part grouped by profile: how many, each member's cut length (square-cut ends exact, mitered ends along the centerline), and the total length of each profile to buy.",
    { ...base },
    true,
    async (a) => {
      const d = await store.read(a.documentId),
        bodies = (await store.view(d)).geometry.bodies;
      const groups = new Map<string, { profile: string; lengths: number[]; bodies: string[] }>();
      for (const f of d.features.filter((x) => x.type === "member" && !x.suppressed)) {
        const built = bodies.find((b) => b.id === f.bodyId);
        if (!built) continue;
        const label = profileLabel(f.params.profile),
          g = groups.get(label) ?? { profile: label, lengths: [], bodies: [] };
        // A prism's length is its volume over its section.
        g.lengths.push(built.volume / profileArea(f.params.profile));
        g.bodies.push(d.bodies.find((b) => b.id === f.bodyId)?.name ?? f.bodyId);
        groups.set(label, g);
      }
      return { items: [...groups.values()].map((g) => ({ ...g, count: g.lengths.length, total: g.lengths.reduce((x, y) => x + y, 0) })) };
    },
  );
  add(
    "create_thread",
    "Thread",
    "Add a thread to a cylindrical face: a shaft (external) or a hole (internal), told apart automatically. Cosmetic threads (the default) are lightweight: the solid is unchanged, the thread shows as rings at its pitch and is called out on drawings, as in production CAD. Use mode modeled only when the helical form itself is needed (3D printing a threaded part): it cuts a real ISO 60° groove and makes the part heavier to rebuild. The shaft must be the major diameter; a hole should be the tap drill. Give an ISO metric size, or diameter and pitch; length defaults to the whole face, starting from its lower end (reverse starts from the other).",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      face: ref,
      size: z.enum(metricSizes.map((m) => m.size) as [string, ...string[]]).optional(),
      diameter: positive.optional().describe("Major diameter in mm, with pitch, for sizes outside the table"),
      pitch: positive.optional(),
      length: positive.optional(),
      reverse: z.boolean().default(false),
      mode: z.enum(["cosmetic", "modeled"]).default("cosmetic"),
      hand: z.enum(["right", "left"]).default("right"),
    },
    false,
    async (a, s) =>
      mutate(a, s, `${a.mode === "modeled" ? "Modeled" : "Cosmetic"} thread ${a.size ?? `Ø${a.diameter}×${a.pitch}`}`, (d) => {
        if (a.face.kind !== "face" || a.face.bodyId !== a.bodyId) throw Error("Select a cylindrical face of the target body");
        const std = a.size ? metricSizes.find((m) => m.size === a.size)! : undefined;
        const diameter = a.diameter ?? std?.diameter,
          pitch = a.pitch ?? std?.pitch;
        if (!diameter || !pitch) throw Error("Give an ISO size, or a diameter and pitch");
        const label = std && !a.diameter && !a.pitch ? `${std.size}×${std.pitch}` : `M${diameter}×${pitch}`;
        addFeature(
          d,
          "thread",
          a.bodyId,
          { face: a.face, label, diameter, pitch, ...(a.length ? { length: a.length } : {}), reverse: a.reverse, mode: a.mode, hand: a.hand },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "split_body",
    "Split body",
    "Cut a body with a plane. Keep the positive side (along the plane normal), the negative side, or both; both creates a second body from the negative side.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      plane: planeRef,
      keep: z.enum(["positive", "negative", "both"]).default("both"),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Split body", (d) => {
        const target = body(d, a.bodyId);
        let newBodyId: string | undefined = a.featureId
          ? feature(d, a.featureId).params.newBodyId
          : undefined;
        if (a.keep === "both" && !newBodyId) {
          newBodyId = randomUUID();
          d.bodies.push({
            id: newBodyId,
            name: `${target.name} (split)`,
            color: target.color,
            hidden: false,
          });
        }
        addFeature(
          d,
          "split",
          a.bodyId,
          { plane: a.plane, keep: a.keep, ...(a.keep === "both" ? { newBodyId } : {}) },
          a.name,
          a.featureId,
        );
        if (a.keep !== "both")
          d.bodies = d.bodies.filter(
            (b) => b.id !== newBodyId || d.features.some((f) => f.bodyId === b.id),
          );
      }),
  );
  add(
    "scale_body",
    "Scale body",
    "Scale a body uniformly about a center point.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      factor: z.number().finite().gt(0.001).max(1000),
      center: vec3.default([0, 0, 0]),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Scaled body ×${a.factor}`, (d) => {
        addFeature(
          d,
          "scale",
          a.bodyId,
          { factor: a.factor, center: a.center },
          a.name,
          a.featureId,
        );
      }),
  );
  add(
    "create_base_flange",
    "Base flange",
    "Start a sheet metal part: a closed sketch profile at the sheet thickness. The bend radius and K-factor become the defaults for its edge flanges and flat pattern.",
    {
      ...write,
      ...named,
      ...redefine,
      sketchId: id,
      thickness: positive,
      bendRadius: positive.optional().describe("Inside bend radius; defaults to the thickness"),
      kFactor: z.number().finite().min(0).max(1).default(0.44).describe("Neutral axis position for bend allowance"),
      reverse: z.boolean().default(false),
      bodyName: z.string().min(1).max(100).optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Added base flange", (d) => {
        sketch(d, a.sketchId);
        let bodyId = a.featureId ? feature(d, a.featureId).bodyId : undefined;
        if (!bodyId) {
          bodyId = randomUUID();
          d.bodies.push({ id: bodyId, name: a.bodyName ?? `Sheet ${d.bodies.length + 1}`, color: "#544841", hidden: false });
        }
        addFeature(
          d,
          "sheet",
          bodyId,
          { sketchId: a.sketchId, thickness: a.thickness, bendRadius: a.bendRadius ?? a.thickness, kFactor: a.kFactor, reverse: a.reverse },
          a.name ?? (a.featureId ? undefined : "Base Flange"),
          a.featureId,
        );
      }),
  );
  add(
    "create_edge_flange",
    "Edge flange",
    "Bend a wall up from a straight outline edge of a sheet metal part. Length is measured from the outer virtual sharp; the bend uses the part's radius unless given. flip bends toward the other side of the sheet.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      edge: ref,
      length: positive,
      angle: z.number().finite().gt(0).max(180).default(90),
      bendRadius: positive.optional(),
      flip: z.boolean().default(false),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Added edge flange", (d) => {
        if (a.edge.kind !== "edge" || a.edge.bodyId !== a.bodyId) throw Error("Select an edge of the sheet metal body");
        if (!d.features.some((f) => f.type === "sheet" && f.bodyId === a.bodyId)) throw Error("Edge flanges go on sheet metal bodies; start with a base flange");
        addFeature(
          d,
          "flange",
          a.bodyId,
          { edge: a.edge, length: a.length, angle: a.angle, flip: a.flip, ...(a.bendRadius ? { bendRadius: a.bendRadius } : {}) },
          a.name ?? (a.featureId ? undefined : `Edge Flange ${d.features.filter((f) => f.type === "flange").length + 1}`),
          a.featureId,
        );
      }),
  );
  add(
    "create_sketched_bend",
    "Sketched bend",
    "Bend a sheet metal plate along a sketch line, as for a wedge or folded armor: the larger side stays, the other turns up (or down with flip) by the angle about a bend of the sheet's inside radius, using the sheet's K-factor. flipSide moves the other side. The line must cross the sheet square, without holes in the bend. In the flat pattern the line is the bend line. Holes and cuts made before the bend unroll with it.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      sketchId: id,
      entityId: id.optional().describe("The sketch line; default the sketch's only line"),
      angle: z.number().finite().gt(0).lt(180),
      flip: z.boolean().default(false),
      flipSide: z.boolean().default(false),
      bendRadius: positive.optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Sketched bend ${a.angle}°`, (d) => {
        if (!d.features.some((f) => f.type === "sheet" && f.bodyId === a.bodyId)) throw Error("Sketched bends go on sheet metal bodies; start with a base flange");
        const sk = sketch(d, a.sketchId),
          lines = sk.entities.filter((e) => e.type === "line" && !e.construction);
        const entityId = a.entityId ?? (lines.length === 1 ? lines[0].id : undefined);
        if (!entityId || !lines.some((e) => e.id === entityId)) throw Error(lines.length > 1 ? "The sketch has several lines; say which one to bend along" : "Draw the bend line in the sketch");
        addFeature(
          d,
          "bend",
          a.bodyId,
          { sketchId: a.sketchId, entityId, angle: a.angle, flip: a.flip, flipSide: a.flipSide, ...(a.bendRadius ? { bendRadius: a.bendRadius } : {}) },
          a.name ?? (a.featureId ? undefined : `Sketched Bend ${d.features.filter((f) => f.type === "bend").length + 1}`),
          a.featureId,
        );
      }),
  );
  add(
    "create_closed_corner",
    "Closed corner",
    "Close the gap where two 90° edge flanges meet at an outside corner of the base, as for a box: the first flange's wall extends across the corner to cover the second's end, and the second's wall runs up to it, less the gap. Only the walls extend; the bends stop at the base corner, leaving a square corner relief, and the flat pattern carries each wall past its bend.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      flanges: z.array(id).length(2).describe("Edge flange feature ids; the first one's wall covers the corner"),
      gap: z.number().finite().min(0.01).max(10).default(0.1).describe("Between the second wall's end and the first wall, mm"),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Closed corner", (d) => {
        if (a.flanges[0] === a.flanges[1]) throw Error("A closed corner joins two different flanges");
        for (const fid of a.flanges) {
          const fl = d.features.find((f) => f.id === fid);
          if (!fl || fl.type !== "flange" || fl.bodyId !== a.bodyId) throw Error("A closed corner joins two edge flanges of this sheet metal body");
        }
        addFeature(
          d,
          "corner",
          a.bodyId,
          { flanges: a.flanges, gap: a.gap },
          a.name ?? (a.featureId ? undefined : `Closed Corner ${d.features.filter((f) => f.type === "corner").length + 1}`),
          a.featureId,
        );
      }),
  );
  add(
    "create_hem",
    "Hem",
    "Fold a sheet metal edge back on itself (180°) to stiffen it or remove a sharp edge: closed (flat against the sheet) or open (with a gap). Length is the folded-back leg past the bend. flip folds to the other side of the sheet. Unrolls in the flat pattern like any bend.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      edge: ref,
      length: positive,
      kind: z.enum(["closed", "open"]).default("closed"),
      gap: positive.optional().describe("Open hems: the space between the sheet and the leg; default one thickness"),
      flip: z.boolean().default(false),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Added ${a.kind} hem`, (d) => {
        if (a.edge.kind !== "edge" || a.edge.bodyId !== a.bodyId) throw Error("Select an edge of the sheet metal body");
        const sheet = d.features.find((f) => f.type === "sheet" && f.bodyId === a.bodyId);
        if (!sheet) throw Error("Hems go on sheet metal bodies; start with a base flange");
        const T = sheet.params.thickness as number;
        // A closed hem keeps a token inside radius so the bend stays a real solid.
        const bendRadius = a.kind === "open" ? (a.gap ?? T) / 2 : Math.max(0.01, 0.05 * T);
        addFeature(
          d,
          "flange",
          a.bodyId,
          { edge: a.edge, length: a.length, angle: 180, flip: a.flip, bendRadius, hem: a.kind },
          a.name ?? (a.featureId ? undefined : `Hem ${d.features.filter((f) => f.type === "flange" && f.params.hem).length + 1}`),
          a.featureId,
        );
      }),
  );
  add(
    "flat_pattern",
    "Flat pattern",
    "Unfold a sheet metal body: its outline with holes, and each bend's centerline with direction, angle and radius. Bends unroll by their allowance θ(R + K·T). Set export to save a DXF for cutting (outline on layer CUT, bends on BEND).",
    { ...base, bodyId: id, export: z.boolean().default(false) },
    true,
    async (a) => {
      const d = await store.read(a.documentId);
      const flat = await flatPattern(await store.kernelDocument(d), a.bodyId);
      if (!a.export) return flat;
      const body = d.bodies.find((b) => b.id === a.bodyId);
      const filename = `${(body?.name ?? "sheet").replace(/[^A-Za-z0-9_-]+/g, "-")}-flat.dxf`;
      return saveExport(store.directory, d.id, filename, "image/vnd.dxf", new TextEncoder().encode(flatPatternDXF(flat)));
    },
  );
  add(
    "export_face_dxf",
    "Export plate DXF",
    "Save the outline of a planar face as a 1:1 DXF for waterjet, laser or router cutting: outer profile, holes and pockets that go through it, with lines, arcs and circles exact. The file starts at the origin, has one CUT layer, and is in millimeters or inches. Works on any planar face of a part or of a part in an assembly; returns the plate size and its thickness.",
    { ...base, face: ref, units: z.enum(["mm", "in"]).optional().describe("Defaults to the document's units") },
    true,
    async (a) => {
      const d = await store.read(a.documentId);
      if (a.face.kind !== "face") throw Error("Select a planar face");
      const outline = await faceOutline(await store.kernelDocument(d), a.face);
      const units = a.units ?? d.units ?? "mm";
      const body = d.bodies.find((b) => b.id === a.face.bodyId)?.name ?? componentOf(d, a.face.bodyId)?.name ?? "plate";
      const thick = outline.thickness !== undefined ? `-${units === "in" ? `${Math.round((outline.thickness / 25.4) * 1000) / 1000}in` : `${Math.round(outline.thickness * 100) / 100}mm`}` : "";
      const filename = `${body.replace(/[^A-Za-z0-9_-]+/g, "-")}${thick}.dxf`;
      const saved = await saveExport(store.directory, d.id, filename, "image/vnd.dxf", new TextEncoder().encode(profileDXF(outline, units)));
      return { ...saved, width: outline.width, height: outline.height, ...(outline.thickness !== undefined ? { thickness: outline.thickness } : {}), units };
    },
  );
  add(
    "create_rib",
    "Rib",
    "Add a rib from an open line or arc profile sketched on a plane through the part, such as a Front-plane line across the corner of a bracket. The rib fills from the profile to the part's walls and floor, extending the profile ends until they meet the part, and is thickened symmetrically about the sketch plane. Omit flip to pick the side the part closes; set it to choose.",
    {
      ...write,
      ...named,
      ...redefine,
      bodyId: id,
      sketchId: id,
      thickness: positive,
      flip: z.boolean().optional().describe("Fill on the profile's right (true) or left (false) side"),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Added rib", (d) => {
        sketch(d, a.sketchId);
        addFeature(d, "rib", a.bodyId, { sketchId: a.sketchId, thickness: a.thickness, ...(a.flip !== undefined ? { flip: a.flip } : {}) }, a.name, a.featureId);
      }),
  );
  /** Check an imported file, store it once by content hash, and describe its import feature. */
  const importFile = async (data: string, format: "step" | "stl" | undefined, filename?: string, units: "mm" | "cm" | "m" | "in" = "mm") => {
    const binary = atob(data.replace(/\s/g, "")),
      bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const isStep = new TextDecoder().decode(bytes.subarray(0, 80)).includes("ISO-10303-21"),
      triangles = isStep ? 0 : stlTriangleCount(bytes);
    const kind = format ?? (isStep ? "step" : triangles ? "stl" : undefined);
    if (kind === "step" && !isStep) throw Error("This is not a STEP file (no ISO-10303-21 header)");
    if (kind === "stl" && !triangles) throw Error("This is not an STL file (no triangles found)");
    if (!kind) throw Error("The file is neither STEP nor STL");
    if (triangles > STL_TRIANGLE_LIMIT)
      throw Error(`The mesh has ${triangles.toLocaleString("en-US")} triangles; up to ${STL_TRIANGLE_LIMIT.toLocaleString("en-US")} import as a solid`);
    const hash = await store.putBlob(bytes);
    const stem = filename?.replace(/\.(step|stp|stl)$/i, "").trim() || (kind === "stl" ? "Imported mesh" : "Imported body");
    const scale = { mm: 1, cm: 10, m: 1000, in: 25.4 }[units];
    return {
      stem,
      label: filename ?? (kind === "stl" ? "STL file" : "STEP file"),
      params: { blob: hash, filename: filename ?? "", ...(kind === "stl" ? { format: "stl", scale } : {}) },
    };
  };
  const addImport = (d: Document, file: Awaited<ReturnType<typeof importFile>>, name?: string) => {
    const bodyId = randomUUID();
    d.bodies.push({ id: bodyId, name: name ?? file.stem, color: "#544841", hidden: false, importAppearance: true });
    addFeature(d, "import", bodyId, file.params, name ? `Import ${name}` : undefined);
  };
  const fileData = z.string().min(16).max(40 * 1024 * 1024);
  const meshUnits = z.enum(["mm", "cm", "m", "in"]).default("mm").describe("Units the STL coordinates are in (STEP files carry their own units)");
  add(
    "import_step",
    "Import STEP",
    "Import a STEP file as a new solid body: vendor parts or geometry from other CAD systems. Pass the file as base64. The body takes fillets, cuts, holes and patterns like any other, can be inserted into assemblies and appears in drawings. The file is stored once by content hash, outside the document history.",
    {
      ...write,
      ...named,
      data: fileData.describe("STEP file contents, base64"),
      filename: z.string().max(200).optional(),
    },
    false,
    async (a, s) => {
      const file = await importFile(a.data, "step", a.filename);
      return mutate(a, s, `Imported ${file.label}`, (d) => addImport(d, file, a.name));
    },
  );
  add(
    "import_stl",
    "Import STL as solid",
    `Import a watertight STL mesh (binary or ASCII) as a new solid body: 3D-printing models, scans or parts from tools that only export meshes. Facets are sewn into a closed B-rep and coplanar facets merge into single planar faces, so flat faces take sketches, cuts, holes and fillets; curved areas stay faceted. Meshes with open edges are rejected. STL has no units: give the units it was saved in. Up to ${STL_TRIANGLE_LIMIT.toLocaleString("en-US")} triangles. Pass the file as base64. Stored once by content hash, outside the document history.`,
    {
      ...write,
      ...named,
      data: fileData.describe("STL file contents, base64"),
      filename: z.string().max(200).optional(),
      units: meshUnits,
    },
    false,
    async (a, s) => {
      const file = await importFile(a.data, "stl", a.filename, a.units);
      return mutate(a, s, `Imported ${file.label}`, (d) => addImport(d, file, a.name));
    },
  );
  add(
    "import_part",
    "Import file as part",
    "Create a new part document from base64 STEP/STL bytes, ready to insert into assemblies. For internet/vendor CAD use import_vendor_part with the direct HTTPS file URL instead of generating or pasting base64. The part is saved only after valid solid import; editable with sketches, cuts, holes, fillets and patterns.",
    {
      data: fileData.describe("STEP or STL file contents, base64"),
      filename: z.string().max(200).optional(),
      name: z.string().min(1).max(100).optional().describe("Part document name; defaults to the file name"),
      sourceUrl: z.string().url().max(2048).optional().describe("Source attribution for supplied bytes; does not download a file"),
      units: meshUnits,
    },
    false,
    async (a, s) => {
      const file = await importFile(a.data, undefined, a.filename, a.units);
      const view = await store.createWith(a.name ?? file.stem, `Imported ${file.label}`, s, (d) => {
        addImport(d, file);
        if (a.sourceUrl) d.features.at(-1)!.params.sourceUrl = a.sourceUrl;
      });
      return view;
    },
  );
  add(
    "import_vendor_part",
    "Import vendor CAD from URL",
    "Download the actual STEP or STL from a public manufacturer's direct HTTPS CAD file URL, validate real solids, and create a reusable part for insert_component. Provide only the URL and optional name; never fabricate base64 or replace available vendor geometry with boxes. Original bytes, imported colors and topology are preserved by the standard import pipeline. Rejects HTML/login pages and files over 16 MiB without changing existing models. Do not assume different vendors' wheel/hub interfaces are compatible; inspect the imported geometry and verify mating dimensions.",
    { url: z.string().url().max(2048), name: z.string().min(1).max(100).optional(), units: meshUnits },
    false,
    async (a,s) => {
      const file = await downloadVendorFile(a.url);
      return tools.find(t => t.name === "import_part")!.handler({ data: base64(file.bytes), filename: file.filename, name: a.name, units: a.units, sourceUrl: file.url }, s);
    },
    {openWorld:true},
  );
  add(
    "set_variable",
    "Set global variable",
    "Create or change a document variable for equations, such as `wall = 3` or `width = 2 * height + wall`. Expressions use + − × ÷ ^, parentheses, numbers with optional unit suffixes (mm, cm, m, in, ft, deg, rad; results are millimeters and degrees), other variables, pi, and sin cos tan asin acos atan atan2 sqrt abs round floor ceil min max (angles in degrees). Every dimension driven by an expression that uses the variable is updated, and the whole edit is rejected if any result is invalid. Give newName to rename the variable everywhere it is used.",
    {
      ...write,
      name: z.string().min(1).max(40),
      expression: z.string().min(1).max(400).optional(),
      newName: z.string().min(1).max(40).optional(),
      description: z.string().max(200).optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, a.expression ? `Set ${a.newName ?? a.name} = ${a.expression}` : `Renamed ${a.name} to ${a.newName}`, (d) => {
        const vars = (d.variables ??= []);
        let v = vars.find((x) => x.name === a.name);
        if (!v) {
          if (a.expression === undefined) throw Error(`Variable ${a.name} not found; give an expression to create it`);
          if (!validVariableName(a.name)) throw Error(`${a.name} is not a valid variable name; use letters, digits and _ and avoid function and unit names`);
          v = { name: a.name, expression: a.expression, value: 0 };
          vars.push(v);
        } else if (a.expression !== undefined) v.expression = a.expression;
        if (a.description !== undefined) v.description = a.description || undefined;
        if (a.newName && a.newName !== a.name) {
          if (!validVariableName(a.newName)) throw Error(`${a.newName} is not a valid variable name`);
          if (vars.some((x) => x.name === a.newName)) throw Error(`Variable ${a.newName} already exists`);
          const from = a.name,
            to = a.newName;
          for (const x of vars) x.expression = renameInExpression(x.expression, from, to);
          for (const sk of d.sketches) for (const c of sk.constraints) if (c.expression) c.expression = renameInExpression(c.expression, from, to);
          for (const f of d.features) for (const key of Object.keys(f.expressions ?? {})) f.expressions![key] = renameInExpression(f.expressions![key], from, to);
          v.name = to;
        }
        // Values and every driven dimension are recomputed when the edit commits.
      }),
  );
  add(
    "delete_variable",
    "Delete global variable",
    "Remove a document variable that no equation uses.",
    { ...write, name: z.string().min(1).max(40) },
    false,
    async (a, s) =>
      mutate(a, s, `Deleted variable ${a.name}`, (d) => {
        if (!d.variables?.some((v) => v.name === a.name)) throw Error(`Variable ${a.name} not found`);
        const uses = variableUses(d, a.name);
        if (uses.length) throw Error(`${a.name} is used by ${uses.slice(0, 5).join(", ")}${uses.length > 5 ? ` and ${uses.length - 5} more` : ""}`);
        d.variables = d.variables.filter((v) => v.name !== a.name);
        if (!d.variables.length) delete d.variables;
      }),
  );
  add(
    "set_units",
    "Set display units",
    "Show the document in millimeters or inches: editor fields, sketch dimensions and drawing dimensions. Geometry and every tool value stay in millimeters.",
    { ...write, units: z.enum(["mm", "in"]) },
    false,
    async (a, s) =>
      mutate(a, s, a.units === "in" ? "Show inches" : "Show millimeters", (d) => {
        if (a.units === "mm") delete d.units;
        else d.units = a.units;
      }),
  );
  /** Built-in and saved materials by name (saved ones may refine built-in names only under new names). */
  const findMaterial = async (name: string) => {
    const key = name.toLowerCase();
    return materials.find((m) => m.name.toLowerCase() === key) ?? (await store.customMaterials()).find((m) => m.name.toLowerCase() === key);
  };
  add(
    "list_materials",
    "List materials",
    "The material library: built-in engineering metals, plastics, composites and 3D-printing filaments, plus materials the user saved. Each has density (g/cm³) and, where known, elastic modulus (GPa), yield and tensile strength (MPa) and Poisson's ratio. Printed materials take an infill and wall thickness when assigned.",
    {},
    true,
    async () => ({
      materials: [...materials.map((m) => ({ ...m, custom: false })), ...(await store.customMaterials()).map((m) => ({ ...m, custom: true }))],
    }),
  );
  add(
    "save_material",
    "Save custom material",
    "Add a material to the user's library, shared by every document, or update one saved earlier. Built-in materials cannot be replaced; save a variant under a new name (for example a specific alloy temper or a filament brand).",
    { name: z.string().trim().min(1).max(80), ...materialProps },
    false,
    async (a) => {
      if (materials.some((m) => m.name.toLowerCase() === a.name.toLowerCase())) throw Error(`${a.name} is a built-in material; save your variant under another name`);
      const { name, ...props } = a;
      const material = { name, category: props.category ?? (props.printed ? "3D print" : "Custom"), ...Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) };
      return { materials: await store.saveMaterial(material as Material) };
    },
  );
  add(
    "delete_material",
    "Delete custom material",
    "Remove a material from the user's library. Documents that use it keep their copy.",
    { name: z.string().trim().min(1).max(80) },
    false,
    async (a) => ({ materials: await store.deleteMaterial(a.name) }),
  );
  add(
    "set_material",
    "Set part material",
    `Assign the part material used for mass, center of mass, the BOM and drawing title blocks. Built-in library: ${materials.map((m) => m.name).join(", ")}; materials saved with save_material work the same way (list_materials shows all with their properties). For a printed material, give infill (%, default 30) and wall (mm, perimeters and top/bottom skin together, default 1.2): the part's mass counts solid walls around a partly filled interior. Give a density to use a material that is not in the library. Omit name to clear.`,
    {
      ...write,
      name: z.string().min(1).max(80).optional(),
      density: z.number().finite().gt(0).max(30).optional().describe("g/cm³; defaults to the library value"),
      infill: z.number().min(0).max(100).optional().describe("Printed parts: infill percentage"),
      wall: z.number().min(0).max(20).optional().describe("Printed parts: wall thickness in mm"),
    },
    false,
    async (a, s) => {
      const known = a.name ? await findMaterial(a.name) : undefined;
      return mutate(a, s, a.name ? `Set material to ${known?.name ?? a.name}${known?.printed ? ` at ${a.infill ?? 30}% infill` : ""}` : "Cleared material", (d) => {
        if (!a.name) {
          delete d.material;
          return;
        }
        const density = a.density ?? known?.density;
        if (!density) throw Error(`${a.name} is not in the material library; give its density in g/cm³ or save it with save_material`);
        if ((a.infill !== undefined || a.wall !== undefined) && !known?.printed) throw Error("Infill and wall apply to printed materials");
        // The document keeps a full copy, so it never depends on the library.
        const { custom: _custom, ...props } = (known ?? {}) as Material & { custom?: boolean };
        d.material = {
          ...props,
          name: known && !a.density ? known.name : a.name,
          density,
          ...(known?.printed ? { infill: a.infill ?? 30, wall: a.wall ?? defaultPrintWall } : {}),
        };
      });
    },
  );
  add(
    "rename_object",
    "Name CAD object",
    "Give a document, body, sketch, feature, datum plane, component, mate or drawing sheet a semantic name for future conversation and the design tree.",
    { ...write, objectId: id, name: z.string().min(1).max(100) },
    false,
    async (a, s) =>
      mutate(a, s, `Named object “${a.name}”`, (d) => {
        const target =
          d.id === a.objectId
            ? d
            : (d.bodies.find((b) => b.id === a.objectId) ??
              d.features.find((f) => f.id === a.objectId) ??
              d.sketches.find((sk) => sk.id === a.objectId) ??
              d.referencePlanes?.find((p) => p.id === a.objectId) ??
              d.components?.find((c) => c.id === a.objectId) ??
              d.mates?.find((m) => m.id === a.objectId) ??
              d.drawings?.find((x) => x.id === a.objectId));
        if (!target) throw Error("Object not found");
        target.name = a.name;
      }),
  );
  add(
    "set_body_visibility",
    "Show or hide body",
    "Change body visibility without deleting geometry or history.",
    { ...write, bodyId: id, hidden: z.boolean() },
    false,
    async (a, s) =>
      mutate(
        a,
        s,
        a.hidden ? "Hid body" : "Showed body",
        (d) => (body(d, a.bodyId).hidden = a.hidden),
      ),
  );
  add(
    "suppress_feature",
    "Suppress or restore feature",
    "Suppress a feature or restore it and rebuild all dependent features. Rejects if downstream references cannot resolve.",
    { ...write, featureId: id, suppressed: z.boolean() },
    false,
    async (a, s) =>
      mutate(
        a,
        s,
        a.suppressed ? "Suppressed feature" : "Restored feature",
        (d) => (feature(d, a.featureId).suppressed = a.suppressed),
      ),
  );
  add(
    "delete_feature",
    "Delete CAD feature",
    "Delete a feature or sketch. Rejects if dependent operations no longer rebuild. Reversible with undo.",
    { ...write, featureId: id },
    false,
    async (a, s) =>
      mutate(a, s, "Deleted feature", (d) => {
        const f = d.features.find((f) => f.id === a.featureId),
          sk = d.sketches.find((sk) => sk.id === a.featureId);
        if (!f && !sk) throw Error("Feature not found");
        d.features = d.features.filter((f) => f.id !== a.featureId);
        d.sketches = d.sketches.filter((sk) => sk.id !== a.featureId);
        d.bodies = d.bodies.filter((b) =>
          d.features.some((f) => f.bodyId === b.id || f.params.newBodyId === b.id),
        );
      }),
    { destructive: true },
  );
  add(
    "delete_sketch_entity",
    "Delete sketch geometry",
    "Remove one sketch entity and its associated constraints. Dependent features must still rebuild.",
    { ...write, sketchId: id, entityId: id },
    false,
    async (a, s) =>
      mutate(a, s, "Deleted sketch entity", (d) => {
        const sk = sketch(d, a.sketchId);
        if (!sk.entities.some((e) => e.id === a.entityId))
          throw Error("Entity not found");
        sk.entities = sk.entities.filter((e) => e.id !== a.entityId);
        sk.constraints = sk.constraints.filter(
          (c) => !c.entityIds.includes(a.entityId),
        );
        solveSketch(sk);
      }),
    { destructive: true },
  );
  add(
    "add_design_intent",
    "Record design intent",
    "Record a soft natural-language requirement, or enforce a hard numeric min/max on an existing feature/entity dimension. Hard bounds are checked before every committed edit.",
    {
      ...write,
      text: z.string().min(1).max(1000),
      kind: z.enum(["hard", "soft"]).default("soft"),
      featureId: id.optional(),
      dimension: z.string().optional(),
      min: scalar.optional(),
      max: scalar.optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Added design intent: ${a.text}`, (d) => {
        if (
          a.kind === "hard" &&
          (!a.featureId ||
            !a.dimension ||
            (a.min === undefined && a.max === undefined))
        )
          throw Error("Hard intent requires a dimension target and min or max");
        if (a.min !== undefined && a.max !== undefined && a.min > a.max)
          throw Error("Minimum exceeds maximum");
        const { documentId, expectedRevision, reason, ...args } = a;
        d.intents.push({ ...args, id: randomUUID() });
      }),
  );
  add(
    "preview_dimension",
    "Preview dimension change",
    "Build a translucent candidate for a dimension edit without changing committed geometry or history. Call apply_preview only after the user selects the candidate.",
    { ...write, featureId: id, dimension: z.string(), value: scalar },
    true,
    async (a) =>
      store.preview(
        a.documentId,
        a.expectedRevision,
        a.reason ?? `Set ${a.dimension} to ${a.value}`,
        (d) => {
          const f = d.features.find((f) => f.id === a.featureId);
          if (f) {
            if (typeof f.params[a.dimension] !== "number")
              throw Error("Unknown dimension");
            f.params[a.dimension] = a.value;
            return;
          }
          for (const sk of d.sketches) {
            const e = sk.entities.find((e) => e.id === a.featureId);
            if (e) {
              if (!fieldsOf(e).includes(a.dimension))
                throw Error("Unknown dimension");
              e.values[a.dimension] = a.value;
              const c = sk.constraints.find(
                (c) =>
                  c.type === "dimension" &&
                  c.entityIds[0] === e.id &&
                  c.dimension === a.dimension,
              );
              if (c) c.value = a.value;
              solveSketch(sk);
              return;
            }
          }
          throw Error("Dimension target not found");
        },
      ),
  );
  add(
    "apply_preview",
    "Apply CAD preview",
    "Commit the exact preview the user chose, provided its base revision is still current. Do not use without the user choosing that proposal.",
    { ...write, previewId: id },
    false,
    async (a, s) =>
      store.applyPreview(a.documentId, a.expectedRevision, a.previewId, s),
  );
  add(
    "dismiss_preview",
    "Dismiss CAD preview",
    "Discard the uncommitted ghost geometry. The model and history remain unchanged.",
    base,
    false,
    async (a) => store.dismissPreview(a.documentId),
  );
  add(
    "measure",
    "Measure geometry",
    "Measure an edge length, face area, minimum distance between two references, or body volume, surface area and center of mass. Results use mm, mm², and mm³.",
    { ...base, refs: z.array(ref).max(2).default([]), bodyId: id.optional() },
    true,
    async (a) =>
      measureGeometry(await store.kernelDocument(await store.read(a.documentId)), a.refs, a.bodyId),
  );
  add(
    "set_mass_properties",
    "Set part mass or weight limit",
    "Give a part its known mass in grams (purchased parts such as motors, batteries and ESCs, whose models do not carry a correct mass): it overrides the material density for this part and every assembly it is in. Set a weight limit in grams on a robot or assembly to check its weight class. Pass null to clear either.",
    { ...write, massOverride: z.number().positive().max(1e9).nullable().optional(), weightLimit: z.number().positive().max(1e9).nullable().optional() },
    false,
    async (a, s) =>
      mutate(a, s, a.weightLimit !== undefined ? (a.weightLimit === null ? "Cleared weight limit" : `Weight limit ${a.weightLimit} g`) : a.massOverride === null ? "Cleared mass override" : `Mass ${a.massOverride} g`, (d) => {
        if (a.massOverride === undefined && a.weightLimit === undefined) throw Error("Give a massOverride or a weightLimit");
        if (a.massOverride === null) delete d.massOverride;
        else if (a.massOverride !== undefined) d.massOverride = a.massOverride;
        if (a.weightLimit === null) delete d.weightLimit;
        else if (a.weightLimit !== undefined) d.weightLimit = a.weightLimit;
      }),
  );
  add(
    "mass_properties",
    "Mass properties",
    "Total mass (g), center of mass (mm) and inertia (g·mm²) of a part, a robot assembly, or selected components or bodies (such as the weapon), with each body's share and the weight limit's margin. Bodies without a material or mass override are listed as missing. Give spin (an axis from a cylindrical face or circular edge, or an origin and direction, plus rpm) for a spinning weapon: inertia about that axis, stored energy (J), tip speed (m/s) at the largest radius, and the bearing force from the center of mass sitting off the axis (N).",
    {
      ...base,
      componentIds: z.array(id).max(200).optional(),
      bodyIds: z.array(id).max(500).optional(),
      spin: z
        .object({
          axis: z.union([z.object({ ref }).strict(), z.object({ origin: vec3, direction: nonzero }).strict()]),
          rpm: z.number().positive().max(100000),
        })
        .optional(),
    },
    true,
    async (a) => {
      const doc = await store.read(a.documentId),
        view = await store.view(doc);
      // A hidden component still weighs; a hidden body of a part does not.
      let bodies = view.geometry.bodies.filter((b) => !b.hidden || !!componentOf(doc, b.id));
      if (a.componentIds?.length) {
        const parts = a.componentIds.map((cid: string) => {
          const c = allComponents(doc).find((x) => x.id === cid);
          if (!c) throw Error(`Component ${cid} not found`);
          return c;
        });
        bodies = bodies.filter((b) => parts.some((c: ReturnType<typeof allComponents>[number]) => componentOwns(c, b.id)));
      }
      if (a.bodyIds?.length) bodies = bodies.filter((b) => a.bodyIds!.includes(b.id));
      if (!bodies.length) throw Error("No visible bodies selected");
      const weighed = bodies.filter((b) => b.mass !== undefined && b.inertiaTensor);
      const total = combine(weighed.map((b) => ({ mass: b.mass!, center: b.centerOfMass, tensor: b.inertiaTensor! })));
      let spinResult;
      if (a.spin) {
        let origin: Vec3, direction: Vec3;
        if ("ref" in a.spin.axis) {
          const t = view.geometry.bodies.flatMap((b) => b.topology).find((x) => x.id === a.spin!.axis.ref.id);
          if (!t?.axis) throw Error("Pick a cylindrical face or a circular edge for the spin axis");
          ({ origin, direction } = t.axis);
        } else ({ origin, direction } = a.spin.axis as { origin: Vec3; direction: Vec3 });
        const about = aboutAxis(total, origin, direction);
        const len = Math.hypot(...direction),
          n = direction.map((v) => v / len) as Vec3;
        let radius = 0;
        for (const b of weighed)
          for (let i = 0; i < b.mesh.vertices.length; i += 3) {
            const d: Vec3 = [b.mesh.vertices[i] - origin[0], b.mesh.vertices[i + 1] - origin[1], b.mesh.vertices[i + 2] - origin[2]];
            const along = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
            radius = Math.max(radius, Math.sqrt(Math.max(0, d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - along * along)));
          }
        spinResult = { rpm: a.spin.rpm, inertia: about.inertia, offset: about.offset, radius, ...spin(about.inertia, total.mass, about.offset, radius, a.spin.rpm) };
      }
      return {
        mass: total.mass,
        centerOfMass: total.center,
        inertia: { tensor: total.tensor, principal: principal(total.tensor) },
        items: weighed.map((b) => ({ bodyId: b.id, name: b.name, mass: b.mass!, source: b.massSource ?? "material" })),
        missing: bodies.filter((b) => b.mass === undefined).map((b) => b.name),
        ...(doc.weightLimit !== undefined ? { weightLimit: doc.weightLimit, remaining: doc.weightLimit - total.mass } : {}),
        ...(spinResult ? { spin: spinResult } : {}),
      };
    },
  );
  add(
    "check_motion",
    "Check motion clearance",
    "Turn a component through its travel (a spinning weapon, a lifter arm, a flipper) or slide it along an axis, and check it against the rest of the assembly at each step: interference volume and the smallest gap. Gear mates turn the gears it drives (through a whole train), and meshing gears are checked against each other. A part in a closed loop of mates (a four-bar lifter) or one other parts are mated to moves as a mechanism: the assembly is re-solved at every step so the linkage and everything riding on it follow, parts mated to each other count only if they overlap, and a position the mechanism cannot reach ends the sweep with a limit. The axis defaults to the component's concentric mate; or give a cylindrical face or circular edge, or an origin and direction. Rotation in degrees (default a full turn), translation in mm. Display only: nothing moves.",
    {
      ...base,
      componentId: id,
      kind: z.enum(["rotate", "translate"]).default("rotate"),
      axis: z.union([z.object({ ref }).strict(), z.object({ origin: vec3, direction: nonzero }).strict()]).optional(),
      from: z.number().finite().default(0),
      to: z.number().finite().optional(),
      steps: z.number().int().min(1).max(360).default(36),
      against: z.array(id).max(200).optional().describe("Components to check against; default every other part"),
    },
    true,
    async (a) => {
      const doc = await store.read(a.documentId),
        view = await store.view(doc);
      const component = allComponents(doc).find((c) => c.id === a.componentId);
      if (!component) throw Error("Component not found");
      const owned = (cid: string) => {
        const c = allComponents(doc).find((x) => x.id === cid);
        if (!c) throw Error(`Component ${cid} not found`);
        return view.geometry.bodies.filter((b) => !b.hidden && componentOwns(c, b.id)).map((b) => b.id);
      };
      const topology = view.geometry.bodies.flatMap((b) => b.topology);
      let axis: { origin: Vec3; direction: Vec3 } | undefined;
      if (a.axis && "ref" in a.axis) axis = topology.find((t) => t.id === (a.axis as { ref: TopologyRef }).ref.id)?.axis;
      else if (a.axis) axis = a.axis as { origin: Vec3; direction: Vec3 };
      else {
        // The axis the component turns about: its concentric mate.
        const mate = doc.mates?.find(
          (m) => m.type === "concentric" && !m.suppressed && [m.moving, m.target].some((r) => componentOwns(component, r.bodyId)),
        );
        const side = mate && ([mate.moving, mate.target].find((r) => componentOwns(component, r.bodyId)) ?? mate.moving);
        axis = side ? topology.find((t) => t.id === side.id)?.axis : undefined;
        if (!axis) throw Error("Give an axis, or mate the component concentric to its shaft first");
      }
      if (!axis) throw Error("The axis must be a cylindrical face, a circular edge, or an origin and direction");
      const to = a.to ?? (a.kind === "rotate" ? 360 : undefined);
      if (to === undefined) throw Error("Give how far to slide (to, in mm)");
      /** Gears without backlash touch along their teeth, so only overlap beyond a sliver of a tooth counts. */
      const sliverOf = (p: TopologyRef, q: TopologyRef) => {
        const [dp, dq] = [p, q].map((r) => view.geometry.bodies.find((b) => b.id === r.bodyId)?.drive);
        return dp?.module && dq?.module && !(dp.backlash || dq.backlash) ? 0.015 * Math.max(dp.module, dq.module) ** 2 * Math.max(dp.width ?? 0, dq.width ?? 0) : 1e-6;
      };
      const motion = { kind: a.kind, origin: axis.origin, direction: axis.direction, from: a.from, to, steps: a.steps };
      // A part in a closed loop of mates (a linkage), or one other parts are mated to, moves as a mechanism:
      // the assembly is solved again at every step.
      const inLoop = mateLoops(doc).some((g) => g.includes(component.id));
      const carries = (doc.mates ?? []).some((m) => !m.suppressed && m.type !== "gear" && componentOwns(component, m.target.bodyId) && !componentOwns(component, m.moving.bodyId));
      if (!component.patternOf && (inLoop || carries)) {
        const partOf = (r: TopologyRef) => allComponents(doc).find((c) => componentOwns(c, r.bodyId))?.id;
        const meshed = (doc.mates ?? [])
          .filter((m) => !m.suppressed && m.type === "gear")
          .flatMap((m) => {
            const [x, y] = [partOf(m.moving), partOf(m.target)];
            return x && y ? [{ a: owned(x), b: owned(y), tolerance: sliverOf(m.moving, m.target) }] : [];
          });
        return mechanismSweep(await store.kernelDocument(doc), component.id, motion, a.against?.flatMap(owned), meshed);
      }
      // Gear mates carry the turn along the train: each geared part turns about its own axis.
      const followers: { ids: string[]; origin: Vec3; direction: Vec3; factor: number; mesh: number[]; meshTolerance: number; meshPeriod?: number }[] = [];
      if (a.kind === "rotate") {
        const turning = new Map<string, { axis: { origin: Vec3; direction: Vec3 }; factor: number; group: number }>([[component.id, { axis, factor: 1, group: 0 }]]);
        const unitOf = (d: Vec3) => {
          const l = Math.hypot(...d);
          return d.map((x) => x / l) as Vec3;
        };
        const sameLine = (p: { origin: Vec3; direction: Vec3 }, q: { origin: Vec3; direction: Vec3 }) => {
          const [dp, dq] = [unitOf(p.direction), unitOf(q.direction)],
            off = q.origin.map((x, i) => x - p.origin[i]) as Vec3,
            along = off[0] * dp[0] + off[1] * dp[1] + off[2] * dp[2];
          return Math.abs(dp[0] * dq[0] + dp[1] * dq[1] + dp[2] * dq[2]) > 0.9999 && Math.hypot(...off.map((x, i) => x - along * dp[i])) < 1e-3;
        };
        const dot3 = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
        const owner = (r: TopologyRef) => allComponents(doc).find((c) => componentOwns(c, r.bodyId))?.id;
        for (let grew = true; grew; ) {
          grew = false;
          for (const m of doc.mates ?? []) {
            if (m.suppressed || m.type !== "gear") continue;
            const [mc, tc] = [owner(m.moving), owner(m.target)];
            if (!mc || !tc) continue;
            const fromTarget = turning.has(tc) && !turning.has(mc),
              fromMoving = turning.has(mc) && !turning.has(tc);
            if (!fromTarget && !fromMoving) continue;
            const [known, other, knownRef, otherRef] = fromTarget ? [tc, mc, m.target, m.moving] : [mc, tc, m.moving, m.target];
            const k = turning.get(known)!,
              ka = topology.find((t) => t.id === knownRef.id)?.axis,
              oa = topology.find((t) => t.id === otherRef.id)?.axis;
            // Only a part turning about this gear's own axis drives the mesh.
            if (!ka || !oa || !sameLine(k.axis, ka)) continue;
            const turn = k.factor * Math.sign(dot3(unitOf(k.axis.direction), unitOf(ka.direction)));
            const nA = unitOf((fromTarget ? ka : oa).direction),
              nB = unitOf((fromTarget ? oa : ka).direction),
              s = Math.sign(dot3(nA, nB)) || 1,
              way = m.aligned ? 1 : -1;
            // moving (about s·nB) = phase + way · ratio · target (about nA)
            const factor = fromTarget ? s * way * m.value * turn : (s * turn) / (way * m.value);
            const group = followers.length + 1;
            // With backlash any overlap is a clash. The mesh repeats every tooth.
            const dk = view.geometry.bodies.find((b) => b.id === knownRef.bodyId)?.drive,
              sliver = sliverOf(knownRef, otherRef);
            followers.push({
              ids: owned(other),
              origin: oa.origin,
              direction: oa.direction,
              factor,
              mesh: [k.group],
              meshTolerance: sliver,
              ...(dk?.teeth && turn ? { meshPeriod: 360 / (dk.teeth * Math.abs(turn)) } : {}),
            });
            turning.set(other, { axis: oa, factor, group });
            grew = true;
          }
        }
      }
      // A belt on a turning pulley runs with it.
      const turningIds = new Set([component.id, ...followers.flatMap((f) => f.ids.map((b) => allComponents(doc).find((c) => componentOwns(c, b))?.id))]);
      const riding = (doc.components ?? []).filter((c) => c.belt?.pulleys.some((p) => turningIds.has(p))).map((c) => `${c.id}/belt`);
      const against = a.against ? a.against.flatMap(owned) : view.geometry.bodies.filter((b) => !b.hidden && !riding.includes(b.id)).map((b) => b.id);
      return motionSweep(
        await store.kernelDocument(doc),
        owned(component.id),
        motion,
        against,
        followers,
      );
    },
  );
  add(
    "analyze_interference",
    "Check body interference",
    "Compute exact solid intersection volume for two bodies. Static collision check; does not simulate motion or certify structural safety.",
    { ...base, bodyA: id, bodyB: id },
    true,
    async (a) => interference(await store.kernelDocument(await store.read(a.documentId)), a.bodyA, a.bodyB),
  );
  add(
    "analyze_printability",
    "Inspect printing risks",
    "Return a geometric overhang screening using face normals and area. Highlights faces facing downward. This is a screening, not FEA, full wall-thickness analysis, or a guarantee of manufacturability.",
    {
      ...base,
      bodyId: id,
      overhangAngle: z.number().min(0).max(90).default(45),
    },
    true,
    async (a) => {
      const v = await store.view(await store.read(a.documentId)),
        b = v.geometry.bodies.find((b) => b.id === a.bodyId);
      if (!b) throw Error("Body not found");
      return {
        method: "Face-normal overhang screening",
        limitations:
          "Does not resolve support contact, thin walls, material strength, or printer settings.",
        faces: b.topology.filter(
          (t) =>
            t.kind === "face" &&
            t.normal &&
            t.normal[2] < -Math.cos((a.overhangAngle * Math.PI) / 180) &&
            t.center[2] > b.bounds[0][2] + 0.01,
        ),
        units: "mm",
      };
    },
  );
  for (const direction of ["undo", "redo"] as const)
    add(
      direction,
      `${direction === "undo" ? "Undo" : "Redo"} CAD edit`,
      `Move one step through the shared design history.`,
      write,
      false,
      async (a) => store.history(a.documentId, a.expectedRevision, direction),
    );
  add(
    "restore_history",
    "Restore design version",
    "Restore a named history entry while preserving the audit trail, creating a new revision.",
    { ...write, historyId: id },
    false,
    async (a) => store.restore(a.documentId, a.expectedRevision, a.historyId),
  );
  // -------------------------------------------------------------------------
  // Version control: designs in a project folder are versioned with git, so
  // branches, commits, merges and pull requests work in git and on GitHub.
  const repo = async () => {
    if (!store.project) throw Error("Version control needs a project folder: start Vibe CAD with VIBE_WORKSPACE set to a git checkout");
    try {
      await git(["rev-parse", "--show-toplevel"], store.directory);
    } catch {
      throw Error("The project folder is not a git repository; run git init or clone your GitHub repository there");
    }
    return store.directory;
  };
  /** What git versions: design folders, imported files and libraries. */
  const pathspec = [":(glob)*.vibe/**", ":(glob)blobs/**", ":(glob)library/**"];
  const branchName = z
    .string()
    .min(1)
    .max(120)
    .regex(/^(?!-)[A-Za-z0-9._/-]+$/, "Use letters, digits, '.', '_', '-' and '/' in branch names");
  /** A changed file as people think of it: which design and which object. */
  const describe = async (cwd: string, path: string) => {
    const match = /^(?:.*\/)?([^/]+\.vibe)\/(?:([a-z-]+)\/)?([^/]+)\.json$/.exec(path);
    if (!match) return {};
    const [, folder, kind, file] = match;
    // The working copy; the last commit for a deleted object or one with conflict markers.
    const parse = (text?: string) => {
      try {
        return text ? JSON.parse(text) : undefined;
      } catch {
        return undefined;
      }
    };
    const readJson = async (p: string) => parse(await readText(cwd, p)) ?? parse(await git(["show", `HEAD:./${p}`], cwd).catch(() => undefined));
    const documentFile = await readJson(`${path.slice(0, path.indexOf(folder) + folder.length)}/document.json`);
    const object = kind ? await readJson(path) : undefined;
    const singular: Record<string, string> = { sketches: "sketch", features: "feature", bodies: "body", intents: "design intent", planes: "plane", components: "component", mates: "mate", "component-patterns": "component pattern", drawings: "drawing", variables: "variable" };
    return {
      document: documentFile?.name ?? folder.replace(/\.vibe$/, ""),
      ...(kind ? { object: `${singular[kind] ?? kind} ${object?.name ?? file}` } : {}),
    };
  };
  const status = async (problems?: string[]) => {
    const cwd = await repo();
    let branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], cwd).catch(() => "")).trim() || "(detached)";
    let upstream: string | undefined,
      ahead = 0,
      behind = 0;
    try {
      upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd)).trim();
      const [left, right] = (await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd)).trim().split(/\s+/).map(Number);
      ahead = left;
      behind = right;
    } catch {
      /* no upstream yet */
    }
    const merging = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd).then(
      () => true,
      () => false,
    );
    // Paths relative to the workspace, which may sit inside a larger repository.
    const prefix = (await git(["rev-parse", "--show-prefix"], cwd)).trim();
    const lines = (await git(["status", "--porcelain=v1", "--untracked-files=all", "--", ...pathspec], cwd)).split("\n").filter(Boolean);
    const changes = [];
    for (const line of lines) {
      const code = line.slice(0, 2),
        full = line.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""),
        path = full.startsWith(prefix) ? full.slice(prefix.length) : full;
      const change = /U|AA|DD/.test(code) ? "conflict" : code.includes("?") || code.includes("A") ? "added" : code.includes("D") ? "deleted" : code.includes("R") ? "renamed" : "modified";
      changes.push({ path, change, ...(await describe(cwd, path)) });
    }
    if (branch === "HEAD") branch = "(detached)";
    return { branch, ...(upstream ? { upstream } : {}), ahead, behind, merging, changes, ...(problems?.length ? { problems } : {}) };
  };
  /** Every design must still read and rebuild after git changed the files. */
  const check = async () => {
    const problems: string[] = [];
    for (const summary of await store.list().catch((e: Error) => {
      problems.push(e.message);
      return [];
    }))
      try {
        await store.view(await store.read(summary.id));
      } catch (e) {
        problems.push(`${summary.name}: ${(e as Error).message}`);
      }
    return problems;
  };
  add("git_status", "Version control status", "The current git branch, how far it is ahead of or behind its GitHub (upstream) branch, whether a merge is in progress, and each changed design object (added, modified, deleted or in conflict).", {}, true, async () => status());
  add(
    "git_commit",
    "Commit design changes",
    "Record every changed design object in a git commit on the current branch (also finishes a merge once its conflicts are resolved). Only design folders, imported files and libraries are committed.",
    { message: z.string().trim().min(1).max(500) },
    false,
    async (a) => {
      const cwd = await repo();
      const unresolved = (await git(["diff", "--name-only", "--relative", "--diff-filter=U"], cwd)).trim();
      if (unresolved) throw Error(`Resolve the merge conflicts first: ${unresolved.split("\n").join(", ")}`);
      // A group with no files yet (no imported files, say) is simply skipped.
      for (const spec of pathspec) await git(["add", "-A", "--", spec], cwd).catch(() => undefined);
      const staged = (await git(["diff", "--cached", "--name-only"], cwd)).trim();
      const merging = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd).then(() => true, () => false);
      if (!staged && !merging) throw Error("There are no design changes to commit");
      await git(["commit", "-m", a.message], cwd);
      return status();
    },
  );
  add(
    "git_branches",
    "List branches",
    "The project's git branches, local and remote (such as origin/main from GitHub), and which one is checked out.",
    {},
    true,
    async () => {
      const cwd = await repo();
      const parse = (text: string, remote: boolean) =>
        text
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [name, head, upstream] = l.split("|");
            return { name, current: head === "*", ...(upstream ? { upstream } : {}), remote };
          })
          .filter((b) => !b.name.endsWith("/HEAD"));
      const local = parse(await git(["branch", "--format=%(refname:short)|%(HEAD)|%(upstream:short)"], cwd), false),
        remote = parse(await git(["branch", "-r", "--format=%(refname:short)||"], cwd), true);
      return { current: local.find((b) => b.current)?.name ?? (await status()).branch, branches: [...local, ...remote] };
    },
  );
  add(
    "git_create_branch",
    "Create branch",
    "Create a git branch for a design change and switch to it, keeping any uncommitted changes. Push it to GitHub with git_push to open a pull request there.",
    { name: branchName, from: branchName.optional().describe("Branch or commit to start from; default the current one") },
    false,
    async (a) => {
      const cwd = await repo();
      await git(["check-ref-format", "--branch", a.name], cwd);
      await git(["switch", "-c", a.name, ...(a.from ? [a.from] : [])], cwd);
      return status();
    },
  );
  add(
    "git_switch",
    "Switch branch",
    "Check out another branch (a GitHub branch such as origin/feature works too). Open designs reload from it. Git refuses when uncommitted changes would be overwritten: commit them first.",
    { name: branchName },
    false,
    async (a) => {
      const cwd = await repo();
      await git(["switch", a.name.replace(/^origin\//, "")], cwd);
      return status(await check());
    },
  );
  add(
    "git_merge",
    "Merge branch",
    "Merge another branch into the current one, object by object. Objects changed on one side only merge cleanly; the same object changed on both sides is a conflict to resolve with git_resolve (keep ours or theirs) and then git_commit. A clean merge is committed only if every design still rebuilds; otherwise it stays open with the problems listed, to fix or abort.",
    { branch: branchName },
    false,
    async (a) => {
      const cwd = await repo();
      try {
        await git(["merge", "--no-ff", "--no-commit", a.branch], cwd);
      } catch (e) {
        const current = await status();
        if (current.merging) return current;
        throw e;
      }
      const merging = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd).then(() => true, () => false);
      if (!merging) return status();
      const problems = await check();
      if (!problems.length) await git(["commit", "--no-edit"], cwd);
      return status(problems);
    },
  );
  add(
    "git_resolve",
    "Resolve conflict",
    "Settle one conflicting design object from a merge or pull by keeping our version (the current branch) or theirs (the branch being merged).",
    { path: z.string().min(1).max(400), take: z.enum(["ours", "theirs"]) },
    false,
    async (a) => {
      const cwd = await repo();
      const conflicts = (await git(["diff", "--name-only", "--relative", "--diff-filter=U"], cwd)).split("\n").filter(Boolean);
      if (!conflicts.includes(a.path)) throw Error("That file is not in conflict");
      try {
        await git(["checkout", `--${a.take}`, "--", a.path], cwd);
        await git(["add", "--", a.path], cwd);
      } catch {
        // The chosen side deleted the object.
        await git(["rm", "-q", "--", a.path], cwd);
      }
      return status();
    },
  );
  add("git_abort_merge", "Abort merge", "Abandon the merge in progress and return to the design as it was before.", {}, false, async () => {
    await git(["merge", "--abort"], await repo());
    return status();
  });
  add(
    "git_pull",
    "Pull from GitHub",
    "Fetch the current branch's upstream (usually GitHub) and merge it in. Conflicts are resolved like a merge. Uses the git credentials already set up on this computer.",
    {},
    false,
    async () => {
      const cwd = await repo();
      try {
        await git(["pull", "--no-rebase", "--no-edit"], cwd);
      } catch (e) {
        const current = await status();
        if (current.merging) return current;
        throw e;
      }
      return status(await check());
    },
  );
  add(
    "git_push",
    "Push to GitHub",
    "Push the current branch to its remote (origin by default), setting it as upstream, so it can be reviewed and merged in a GitHub pull request. Uses the git credentials already set up on this computer.",
    { remote: z.string().regex(/^[A-Za-z0-9._-]+$/).default("origin") },
    false,
    async (a) => {
      const cwd = await repo();
      await git(["push", "-u", a.remote, "HEAD"], cwd);
      return status();
    },
  );
  add(
    "export_file",
    "Export CAD file",
    "Export real STEP B-rep, binary STL, an editable JSON document, or a self-contained .edit native project preserving features, drawings, assembly parts/mates and original imports. Returns a file name, MIME type and download information for the editor runtime. No file is uploaded.",
    { ...base, format: z.enum(["step", "stl", "json", "edit"]), bodyId: id.optional() },
    false,
    async (a) => {
      const d = await store.read(a.documentId),
        out = a.format === 'edit' ? {mime:'application/json',bytes:new TextEncoder().encode(await exportProject(store,d.id))} : await exportModel(a.format === "json" ? d : await store.kernelDocument(d), a.format, a.bodyId),
        filename = `${d.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}-r${d.revision}.${a.format}`;
      return saveExport(store.directory, d.id, filename, out.mime, out.bytes);
    },
  );
  const planeDefinition = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("offset"),
        base: planeRef,
        distance: scalar,
        flip: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("angle"),
        base: planeRef,
        axis: axisRef,
        angle: z.number().finite().min(-360).max(360),
      })
      .strict(),
    z.object({ kind: z.literal("midplane"), a: planeRef, b: planeRef }).strict(),
    z
      .object({ kind: z.literal("three-point"), points: z.array(vec3).length(3) })
      .strict(),
    z
      .object({
        kind: z.literal("normal-to-edge"),
        edge: ref,
        position: z.number().finite().min(0).max(1).default(0),
      })
      .strict(),
  ]);
  add(
    "create_reference_plane",
    "Create datum plane",
    "Create a named datum plane: offset from a principal plane, datum or planar face; at an angle about an axis; mid-plane between two parallel planes/faces; through three points; or normal to an edge. Datum planes stay associative and can host sketches, mirrors, splits and drafts. The legacy form is a principal plane through origin.",
    {
      ...write,
      ...named,
      plane: plane.default("XY"),
      origin: vec3.default([0, 0, 0]),
      definition: planeDefinition.optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Created datum plane", (d) => {
        const definition = a.definition;
        let base: "XY" | "XZ" | "YZ" = a.plane,
          origin = a.origin;
        if (definition?.kind === "offset" && definition.base.kind === "principal") {
          base = definition.base.plane;
          const offset = (definition.base.offset ?? 0) + definition.distance;
          const normal = { XY: [0, 0, 1], XZ: [0, -1, 0], YZ: [1, 0, 0] }[base]!;
          origin = normal.map((n) => n * offset) as [number, number, number];
        }
        const planeId = randomUUID();
        (d.referencePlanes ??= []).push({
          id: planeId,
          name: a.name ?? `Plane ${d.referencePlanes.length + 1}`,
          plane: base,
          origin,
          ...(definition && !(definition.kind === "offset" && definition.base.kind === "principal" && !definition.flip)
            ? { definition }
            : {}),
        });
      }),
  );
  add(
    "set_reference_plane",
    "Edit datum plane",
    "Change a datum plane: its origin (legacy principal planes), offset distance, rotation angle, or full definition. Attached sketches and features rebuild.",
    {
      ...write,
      planeId: id,
      origin: vec3.optional(),
      distance: scalar.optional(),
      angle: z.number().finite().min(-360).max(360).optional(),
      definition: planeDefinition.optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Edited datum plane", (d) => {
        const p = d.referencePlanes?.find((p) => p.id === a.planeId);
        if (!p) throw Error("Reference plane not found");
        if (a.definition) p.definition = a.definition;
        if (a.distance !== undefined) {
          if (p.definition?.kind === "offset") p.definition.distance = a.distance;
          else if (!p.definition) {
            const normal = { XY: [0, 0, 1], XZ: [0, -1, 0], YZ: [1, 0, 0] }[p.plane]!;
            p.origin = normal.map((n) => n * a.distance!) as [number, number, number];
          } else throw Error("This datum plane has no offset distance");
        }
        if (a.angle !== undefined) {
          if (p.definition?.kind !== "angle") throw Error("This datum plane has no angle");
          p.definition.angle = a.angle;
        }
        if (a.origin) {
          if (p.definition) throw Error("Edit the definition of this datum plane instead");
          p.origin = a.origin;
        }
        for (const sk of d.sketches.filter((sk) => sk.referencePlaneId === p.id)) {
          sk.origin = [...p.origin];
          sk.plane = p.plane;
        }
      }),
  );
  add(
    "set_visibility",
    "Show or hide",
    "Show or hide a body, sketch, datum plane or assembly component in the viewport without changing geometry or history. A hidden component still counts in mass and mates.",
    { ...write, objectId: id, hidden: z.boolean() },
    false,
    async (a, s) =>
      mutate(a, s, a.hidden ? "Hid object" : "Showed object", (d) => {
        const component = d.components?.find((c) => c.id === a.objectId);
        if (component) {
          component.display = { ...component.display, hidden: a.hidden };
          if (!a.hidden) delete component.display.hidden;
          return;
        }
        const target =
          d.bodies.find((b) => b.id === a.objectId) ??
          d.sketches.find((sk) => sk.id === a.objectId) ??
          d.referencePlanes?.find((p) => p.id === a.objectId);
        if (!target) throw Error("Object not found");
        target.hidden = a.hidden;
      }),
  );
  add(
    "set_appearance",
    "Appearance",
    "Color, texture and transparency of a body or an assembly component, as SolidWorks' Appearance and Change Transparency (transparency 0 is opaque, 75 is SolidWorks' usual see-through, 100 is fully clear). A texture comes with its usual color unless a color is given; a later color tints it. A component's appearance shows over its parts' own; reset returns to them. Display only: geometry, mass and exports are unchanged.",
    {
      ...write,
      objectId: id,
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Hex color, such as #CE8147"),
      texture: z.enum([...textureIds, "none"]).optional().describe(textures.map((t) => `${t.id}: ${t.name}`).join("; ")),
      transparency: z.number().min(0).max(100).optional().describe("Percent"),
      reset: z.boolean().optional().describe("Return a component to its parts' own appearance, or clear a body's texture and transparency"),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Changed appearance", (d) => {
        if (a.color === undefined && a.texture === undefined && a.transparency === undefined && !a.reset) throw Error("Give a color, a texture, a transparency or reset");
        const opacity = a.transparency === undefined ? undefined : Math.round((1 - a.transparency / 100) * 1e4) / 1e4;
        const texture = a.texture && a.texture !== "none" ? a.texture : undefined,
          color = a.color ?? (texture ? textureInfo(texture).color : undefined);
        const component = d.components?.find((c) => c.id === a.objectId);
        const target = component
          ? (component.display = { ...(a.reset ? { ...(component.display?.hidden ? { hidden: true } : {}), ...(component.display?.style ? { style: component.display.style } : {}) } : component.display) })
          : body(d, a.objectId);
        if (!component && a.reset) {
          delete target.opacity;
          delete target.texture;
        }
        if (!component && (color || texture || a.reset)) (target as {importAppearance?:boolean}).importAppearance = a.reset ? true : false;
        if (color) target.color = color;
        if (texture) target.texture = texture;
        else if (a.texture === "none") delete target.texture;
        if (opacity !== undefined) target.opacity = opacity;
        if (target.opacity === 1) delete target.opacity;
      }),
  );
  add(
    "set_display_style",
    "Display mode",
    `How a body or an assembly component is drawn, over the view's display style, as SolidWorks' component Display Mode: ${displayStyles.map((x) => `${x.id} (${x.name})`).join(", ")}. "default" follows the view again. Display only: geometry, mass and exports are unchanged.`,
    { ...write, objectId: id, style: z.enum([...displayStyleIds, "default"]) },
    false,
    async (a, s) =>
      mutate(a, s, "Changed display mode", (d) => {
        const component = d.components?.find((c) => c.id === a.objectId);
        const target = component ? (component.display = { ...component.display }) : body(d, a.objectId);
        if (a.style === "default") delete target.style;
        else target.style = a.style;
      }),
  );
  add(
    "set_component_suppressed",
    "Suppress component",
    "Suppress or restore an assembly component, as in SolidWorks: a suppressed component is left out of the model, and its mates, mass, BOM, drawings and checks set aside, until it is restored. Nothing about it is lost.",
    { ...write, componentId: id, suppressed: z.boolean() },
    false,
    async (a, s) =>
      mutate(a, s, a.suppressed ? "Suppressed component" : "Restored component", (d) => {
        const c = d.components?.find((x) => x.id === a.componentId);
        if (!c) throw Error("Component not found");
        if (a.suppressed) c.suppressed = true;
        else delete c.suppressed;
      }),
  );
  add(
    "check_interference",
    "Interference detection",
    "SolidWorks' Interference Detection over the whole assembly (or the given components): every pair of bodies from different components that overlap, with the volume they share, largest first. Bodies that only touch do not count. Static: for parts that move, use check_motion.",
    { ...base, componentIds: z.array(id).max(200).optional(), excludeHidden: z.boolean().default(false) },
    true,
    async (a) => {
      const doc = await store.read(a.documentId);
      const only = a.componentIds?.length
        ? (await store.view(doc)).geometry.bodies.filter((b) => a.componentIds!.some((cid: string) => { const c = allComponents(doc).find((x) => x.id === cid); if (!c) throw Error(`Component ${cid} not found`); return componentOwns(c, b.id); })).map((b) => b.id)
        : undefined;
      return interferences(await store.kernelDocument(doc), only, a.excludeHidden);
    },
  );
  add(
    "check_definition",
    "Check definition",
    "Whether the model is fully defined, as SolidWorks shows it: each sketch's remaining degrees of freedom; in an assembly each component's definition ((f) fixed, (-) under-defined with its degrees of freedom, (+) over-defined, fully defined) and every mate that conflicts or lost its geometry, with what it conflicts with. status is full, under or over.",
    base,
    true,
    async (a) => definitionOf(await store.view(await store.read(a.documentId))),
  );
  const namedViews = ["iso", "front", "back", "top", "bottom", "left", "right", "dimetric", "trimetric"] as const;
  add(
    "capture_view",
    "Capture images",
    "Pictures of the model, as PNG images, from named angles (iso, front, back, top, bottom, left, right, dimetric, trimetric) or any direction (the direction from the model toward the eye), without screenshots or computer use. Drawn in a display style (style: Shaded With Edges unless given; a part's own display mode wins), in each part's color and transparency; textures show as their color. focus frames chosen components or bodies; only shows just them; transparent makes some see-through. highlight colors components, bodies, faces or edges (by id) in the accent color; a mate id colors its moving geometry in the accent and its target in slate. Mate conflicts are marked unless conflicts is false: the faces of each flagged mate and the parts they over-define in red. The legend says what each color means. Use it to check a shape, a fit, or why mates conflict.",
    {
      ...base,
      views: z
        .array(z.union([z.enum(namedViews), z.object({ direction: nonzero, up: vec3.optional(), name: z.string().min(1).max(30).optional() }).strict()]))
        .min(1)
        .max(6)
        .default(["iso"]),
      width: z.number().int().min(160).max(1600).default(640),
      height: z.number().int().min(120).max(1200).default(480),
      focus: z.array(id).max(200).optional(),
      only: z.array(id).max(200).optional(),
      transparent: z.array(id).max(200).optional(),
      highlight: z.array(id).max(200).optional(),
      conflicts: z.boolean().default(true),
      style: z.enum(displayStyleIds).default("shaded-edges"),
    },
    true,
    async (a) => {
      const doc = await store.read(a.documentId),
        view = await store.view(doc);
      const all = view.geometry.bodies;
      const topology = all.flatMap((b) => b.topology);
      /** Bodies an id stands for: a component's, a body itself. */
      const bodiesOf = (x: string) => {
        const c = allComponents(doc).find((y) => y.id === x);
        const found = c ? all.filter((b) => componentOwns(c, b.id)) : all.filter((b) => b.id === x);
        return found.map((b) => b.id);
      };
      const set = (ids?: string[]) => {
        if (!ids?.length) return undefined;
        const out = new Set<string>();
        for (const x of ids) {
          const found = bodiesOf(x);
          if (!found.length) throw Error(`No component or body ${x}`);
          for (const b of found) out.add(b);
        }
        return out;
      };
      // Parts asked for by name are shown even if hidden in the editor.
      const only = set(a.only),
        bodies = all.filter((b) => !only || only.has(b.id)).map((b) => (only?.has(b.id) && b.hidden ? { ...b, hidden: false } : b));
      const tint = new Map<string, string>(),
        faceTint = new Map<string, string>(),
        edgeTint = new Map<string, string>();
      const legend: { color: string; meaning: string }[] = [];
      const accent = "#CE8147",
        slate = "#70798C",
        error = "#B34238";
      const mark = (refId: string, color: string) => {
        const t = topology.find((x) => x.id === refId);
        if (!t) return false;
        (t.kind === "face" ? faceTint : edgeTint).set(t.id, color);
        return true;
      };
      for (const x of a.highlight ?? []) {
        const mate = doc.mates?.find((m) => m.id === x);
        if (mate) {
          mark(mate.moving.id, accent);
          mark(mate.target.id, slate);
          legend.push({ color: accent, meaning: `${mate.name}: the moving part's ${mate.moving.kind}` }, { color: slate, meaning: `${mate.name}: the target ${mate.target.kind}` });
          continue;
        }
        if (mark(x, accent)) {
          legend.push({ color: accent, meaning: `highlighted ${topology.find((t) => t.id === x)!.kind}` });
          continue;
        }
        const found = bodiesOf(x);
        if (!found.length) throw Error(`Nothing to highlight with id ${x}`);
        for (const b of found) tint.set(b, accent);
        legend.push({ color: accent, meaning: `highlighted: ${allComponents(doc).find((c) => c.id === x)?.name ?? doc.bodies.find((b) => b.id === x)?.name ?? x}` });
      }
      if (a.conflicts)
        for (const m of doc.mates ?? []) {
          const state = view.geometry.mateStatus?.[m.id];
          if (!state || state.status === "ok") continue;
          const marked = [mark(m.moving.id, error), mark(m.target.id, error)].some(Boolean);
          legend.push({ color: error, meaning: `${state.message ?? m.name}${marked ? " (its faces)" : ""}` });
          if (state.status === "over") {
            const c = componentOf(doc, m.moving.bodyId);
            if (c) for (const b of bodiesOf(c.id)) if (!tint.has(b)) tint.set(b, "#C9837C");
          }
        }
      if ([...tint.values()].includes("#C9837C")) legend.push({ color: "#C9837C", meaning: "over-defined parts" });
      const ghost = set(a.transparent),
        focus = set(a.focus);
      const images: { name: string; mimeType: string; data: string }[] = [],
        shots: { name: string; width: number; height: number; direction: Vec3 }[] = [];
      for (const v of a.views) {
        let camera: PictureCamera,
          name: string;
        if (typeof v === "string") {
          camera = cameraFor(v as ViewOrientation);
          name = v;
        } else {
          const len = Math.hypot(...v.direction),
            dir = v.direction.map((x: number) => x / len) as Vec3;
          let up: Vec3 = v.up ?? [0, 0, 1];
          if (Math.abs(up[0] * dir[0] + up[1] * dir[1] + up[2] * dir[2]) / Math.hypot(...up) > 0.999) up = [0, 1, 0];
          const cx: Vec3 = [up[1] * dir[2] - up[2] * dir[1], up[2] * dir[0] - up[0] * dir[2], up[0] * dir[1] - up[1] * dir[0]],
            cl = Math.hypot(...cx),
            x = cx.map((c) => c / cl) as Vec3;
          camera = { dir, x, y: [dir[1] * x[2] - dir[2] * x[1], dir[2] * x[0] - dir[0] * x[2], dir[0] * x[1] - dir[1] * x[0]] };
          name = v.name ?? `view ${shots.length + 1}`;
        }
        const pixels = renderPicture(bodies, camera, { width: a.width, height: a.height, focus, tint, faceTint, edgeTint, ghost, style: a.style });
        images.push({ name, mimeType: "image/png", data: base64(await encodePng(a.width, a.height, pixels, deflate)) });
        shots.push({ name, width: a.width, height: a.height, direction: camera.dir });
      }
      return { document: { id: doc.id, name: doc.name, revision: doc.revision }, views: shots, legend, images };
    },
  );
  add(
    "create_component",
    "Create assembly component",
    "Group existing, unassigned solid bodies into a rigid component. Position is in mm and XYZ rotation in degrees. Components retain their parametric part features.",
    {
      ...write,
      ...named,
      bodyIds: z.array(id).min(1).max(50),
      grounded: z.boolean().default(false),
      position: vec3.default([0, 0, 0]),
      rotation: vec3.default([0, 0, 0]),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Created assembly component", (d) => {
        for (const id of a.bodyIds) {
          body(d, id);
          if (d.components?.some((c) => c.bodyIds.includes(id)))
            throw Error("Body already belongs to a component");
        }
        const component = {
          id: randomUUID(),
          name: a.name ?? `Component ${(d.components?.length ?? 0) + 1}`,
          bodyIds: a.bodyIds,
          grounded: a.grounded,
          position: a.position,
          rotation: a.rotation,
          explode: [0, 0, 0] as [number, number, number],
        };
        (d.components ??= []).push(component);
        for (const id of a.bodyIds) body(d, id).componentId = component.id;
      }),
  );
  add(
    "insert_component",
    "Insert part",
    "Insert another document as a component instance. The instance follows every later edit of the part document; insert it again for more instances (the BOM counts them). Its bodies appear as `componentId/bodyId` with face and edge ids prefixed the same way, ready for mates. Position is in mm and XYZ rotation in degrees.",
    {
      ...write,
      ...named,
      partDocumentId: id.describe("The document to insert, from list_documents"),
      grounded: z.boolean().optional().describe("Fix in place; the first component is fixed by default"),
      position: vec3.default([0, 0, 0]),
      rotation: vec3.default([0, 0, 0]),
    },
    false,
    async (a, s) => {
      const part = await store.read(a.partDocumentId);
      return mutate(a, s, `Inserted ${part.name}`, async (d) => {
        if (part.id === d.id) throw Error("An assembly cannot insert itself");
        const instances = (d.components ?? []).filter((c) => c.source?.documentId === part.id).length;
        const component = {
          id: randomUUID(),
          name: a.name ?? (instances ? `${part.name} <${instances + 1}>` : part.name),
          bodyIds: [] as string[],
          source: { documentId: part.id },
          grounded: a.grounded ?? !d.components?.length,
          position: a.position,
          rotation: a.rotation,
          explode: [0, 0, 0] as [number, number, number],
        };
        (d.components ??= []).push(component);
        // Rejects circular inserts and parts without visible solids.
        await store.linkedDocuments(d);
        if (!part.bodies.some((b) => !b.hidden) && !part.components?.some((c) => c.source))
          throw Error(`${part.name} has no visible solid bodies to insert`);
      });
    },
  );
  add(
    "delete_component",
    "Delete component",
    "Remove a component and the mates that reference it. Bodies of a grouped component stay in the document as free bodies; an inserted part instance disappears. Undo restores it.",
    { ...write, componentId: id },
    false,
    async (a, s) =>
      mutate(a, s, "Deleted component", (d) => {
        const c = d.components?.find((c) => c.id === a.componentId);
        if (!c) throw Error("Component not found");
        const riding = d.components!.find((x) => x.belt?.pulleys.includes(c.id));
        if (riding) throw Error(`${riding.name} runs on ${c.name}; delete the belt first`);
        d.components = d.components!.filter((x) => x.id !== c.id);
        d.componentPatterns = (d.componentPatterns ?? []).filter((p) => p.componentId !== c.id);
        d.mates = (d.mates ?? []).filter((m) => !componentOwns(c, m.moving.bodyId) && !componentOwns(c, m.target.bodyId));
        for (const b of d.bodies) if (b.componentId === c.id) delete b.componentId;
        for (const sheet of d.drawings ?? []) {
          sheet.bodyIds = sheet.bodyIds.filter((id) => !((c.source || c.belt) && componentOwns(c, id)));
          if (!sheet.bodyIds.length) throw Error(`Drawing ${sheet.name} shows only this component; delete the drawing first`);
        }
      }),
    { destructive: true },
  );
  add(
    "set_component_transform",
    "Position component",
    "Set a component's placement. A free component goes exactly there; a mated component starts there and its mates pull it back, so only the motion its mates leave free (such as turning a pin about its axis) takes effect. In a closed loop of mates (a linkage), the component keeps its new pose as closely as the loop allows and the rest of the loop moves to meet it, as when turning a crank. Grounded components must be released first.",
    { ...write, componentId: id, position: vec3, rotation: vec3 },
    false,
    async (a, s) => {
      // A linkage moves as a whole: the parts of the loop are re-solved around the moved one and kept there.
      const before = await store.read(a.documentId);
      const loop = mateLoops(before).find((g) => g.includes(a.componentId));
      const shown = loop ? await store.view(before) : undefined;
      const local = shown && localTopology(shown.geometry);
      return mutate(a, s, "Positioned component", (d) => {
        const c = d.components?.find((c) => c.id === a.componentId);
        if (!c) throw Error("Component not found");
        if (c.belt) throw Error("A belt follows its pulleys; move or mate the pulleys instead");
        if (c.grounded) throw Error("Release the fixed component before moving it");
        c.position = a.position;
        c.rotation = a.rotation;
        if (loop && local) {
          const report: SolveReport = { mates: {}, components: {} };
          const solved = solveComponents(d, local, { anchor: [c.id], report });
          // A pose the linkage cannot reach is refused, not kept half-assembled.
          const broken = Object.entries(report.mates).find(([id, m]) => m.status === "over" && shown!.geometry.mateStatus?.[id]?.status !== "over");
          if (broken) throw Error(`${c.name} cannot go there: ${broken[1].message}`);
          for (const id of loop) {
            const member = d.components!.find((x) => x.id === id);
            if (!member || !solved[id]) continue;
            member.position = solved[id].position.map((x) => Math.round(x * 1e9) / 1e9) as Vec3;
            member.rotation = eulerDegrees(solved[id]).map((x) => Math.round(x * 1e9) / 1e9) as Vec3;
          }
        }
      });
    },
  );
  add(
    "set_component_grounded",
    "Ground component",
    "Fix or release a component at its current solved placement. A component driven by active mates cannot be grounded.",
    { ...write, componentId: id, grounded: z.boolean() },
    false,
    async (a, s) => {
      return mutate(a, s, "Changed component grounding", (d) => {
        const c = d.components?.find((c) => c.id === a.componentId);
        if (!c) throw Error("Component not found");
        if (c.belt) throw Error("A belt follows its pulleys; move or mate the pulleys instead");
        if (
          a.grounded &&
          d.mates?.some(
            (m) => !m.suppressed && componentOwns(c, m.moving.bodyId),
          )
        )
          throw Error("Suppress the component's mates before grounding it");
        c.grounded = a.grounded;
      });
    },
  );
  add(
    "add_mate",
    "Add assembly mate",
    "Mate a moving component to a settled target component. Coincident, distance, parallel, perpendicular and angle use planar faces; concentric uses circular edges or cylindrical faces; tangent joins a cylindrical face and a planar face (aligned flips the side). Lock aligns local frames at the references. Gear (a mechanical mate) couples rotation about two axes (circular edges or cylindrical faces): the moving part turns value times per turn of the target, opposite ways unless aligned (an internal gear, or pulleys on one belt); value defaults to the tooth ratio when both are spur gears or pulleys, and the gears keep the mesh they have now. Concentric mates on each shaft still place them. Omit aligned to keep the alignment closest to the parts' current orientation; set it to flip. Parts are solved after their targets; closed loops of mates (linkages) are solved together. Remaining freedom is retained from the component placement. As in SolidWorks, a mate that over-defines a part is added but flagged and left unsolved, naming the mates it conflicts with, and a mate whose geometry no longer exists is flagged, never re-attached; the rest of the assembly still solves (see inspect_assembly for mate states and each part's degrees of freedom).",
    {
      ...write,
      ...named,
      type: z.enum([
        "coincident",
        "distance",
        "parallel",
        "perpendicular",
        "concentric",
        "tangent",
        "angle",
        "lock",
        "gear",
      ]),
      moving: ref,
      target: ref,
      value: scalar.default(0),
      aligned: z.boolean().optional(),
    },
    false,
    async (a, s) => {
      // Default alignment: whichever the parts are closest to now, so a new mate never flips a part.
      let aligned = a.aligned;
      let ratio = a.value,
        phase: number | undefined;
      if (a.type === "gear") {
        // External gears turn opposite ways; the mesh stays as the parts sit now.
        aligned ??= false;
        const v = await store.view(await store.read(a.documentId));
        const bodies = v.geometry.bodies,
          topology = bodies.flatMap((b) => b.topology);
        if (!ratio) {
          const teeth = (r: TopologyRef) => bodies.find((b) => b.id === r.bodyId)?.drive?.teeth;
          const [tm, tt] = [teeth(a.moving), teeth(a.target)];
          if (!tm || !tt) throw Error("Give the gear ratio: turns of the moving part per turn of the target");
          ratio = tt / tm;
        }
        if (!(ratio > 0)) throw Error("The gear ratio must be positive");
        const side = (r: TopologyRef) => {
          const t = findTopology(topology, r),
            placement = v.geometry.placements?.[r.bodyId];
          if (!t?.axis || !placement || (t.kind === "edge" ? t.geomType !== "CIRCLE" : t.geomType === "PLANE")) throw Error("Gear mates join circular edges or cylindrical faces, one on each gear");
          return { axis: t.axis.direction, placement };
        };
        phase = gearPhase(ratio, aligned, side(a.target), side(a.moving));
      }
      // Tangent keeps the side the part is on; Flip moves it to the other side.
      if (aligned === undefined && a.type === "tangent") aligned = false;
      if (aligned === undefined) {
        const v = await store.view(await store.read(a.documentId));
        const topology = v.geometry.bodies.flatMap((b) => b.topology);
        const direction = (r: TopologyRef) => {
          const t = findTopology(topology, r);
          return t?.axis && (t.kind === "edge" ? t.geomType === "CIRCLE" : t.geomType !== "PLANE") ? t.axis.direction : t?.normal;
        };
        const p = direction(a.moving),
          q = direction(a.target);
        aligned = !!p && !!q && p[0] * q[0] + p[1] * q[1] + p[2] * q[2] > 1e-9;
      }
      return mutate(a, s, "Added assembly mate", (d) => {
        const roundRef = (r: TopologyRef) =>
          r.kind === "edge" ? r.geomType === undefined || r.geomType === "CIRCLE" : r.geomType !== "PLANE";
        const planar = (r: TopologyRef) => r.kind === "face" && (r.geomType === undefined || r.geomType === "PLANE");
        const cylinder = (r: TopologyRef) => r.kind === "face" && r.geomType !== "PLANE";
        if ((a.type === "concentric" || a.type === "gear") && !(roundRef(a.moving) && roundRef(a.target)))
          throw Error(`${a.type === "gear" ? "Gear" : "Concentric"} mates require circular edges or cylindrical faces`);
        if (a.type === "tangent" && !((cylinder(a.moving) && planar(a.target)) || (planar(a.moving) && cylinder(a.target))))
          throw Error("Tangent mates join a cylindrical face and a planar face");
        if (
          a.type !== "concentric" &&
          a.type !== "tangent" &&
          a.type !== "gear" &&
          (a.moving.kind !== "face" || a.target.kind !== "face")
        )
          throw Error("Select planar faces for this mate");
        if (a.type === "angle" && (a.value < 0 || a.value > 180))
          throw Error("Mate angle must be between 0 and 180 degrees");
        const movingComponent = componentOf(d, a.moving.bodyId),
          targetComponent = componentOf(d, a.target.bodyId);
        if (!movingComponent || !targetComponent)
          throw Error("Mate references must belong to components; insert parts or group bodies first");
        if ((movingComponent as any).patternOf)
          throw Error("Pattern instances follow their source component; mate the source, or use the instance as the fixed side");
        if (movingComponent.belt || targetComponent.belt) throw Error("A belt follows its pulleys; mate the pulleys instead");
        if (movingComponent === targetComponent) throw Error("A mate must connect different components");
        (d.mates ??= []).push({
          id: randomUUID(),
          name:
            a.name ??
            `${a.type[0].toUpperCase()}${a.type.slice(1)} ${(d.mates ?? []).filter((m) => m.type === a.type).length + 1}`,
          type: a.type,
          moving: a.moving,
          target: a.target,
          value: ratio,
          aligned: aligned!,
          suppressed: false,
          ...(phase !== undefined ? { phase } : {}),
        });
      });
    },
  );
  add(
    "set_mate_suppressed",
    "Suppress assembly mate",
    "Suppress or restore a mate and resolve the assembly atomically.",
    { ...write, mateId: id, suppressed: z.boolean() },
    false,
    async (a, s) => {
      const placement = a.suppressed
        ? await releasePlacement(a.documentId, a.mateId)
        : undefined;
      return mutate(a, s, "Changed assembly mate", (d) => {
        if (placement) {
          const c = d.components!.find((c) => c.id === placement.id)!;
          c.position = placement.position;
          c.rotation = placement.rotation as [number, number, number];
        }
        const m = d.mates?.find((m) => m.id === a.mateId);
        if (!m) throw Error("Mate not found");
        m.suppressed = a.suppressed;
      });
    },
  );
  add(
    "edit_mate",
    "Edit assembly mate",
    "Change a mate's type, distance/angle value or alignment (flip) and re-solve the assembly atomically. For a gear mate: value is the ratio, aligned turns both parts the same way, and phase (degrees) turns the moving gear to adjust the mesh.",
    {
      ...write,
      mateId: id,
      type: z.enum(["coincident", "distance", "parallel", "perpendicular", "concentric", "tangent", "angle", "lock"]).optional(),
      value: scalar.optional(),
      aligned: z.boolean().optional(),
      phase: z.number().finite().min(-360).max(360).optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Edited assembly mate", (d) => {
        const m = d.mates?.find((m) => m.id === a.mateId);
        if (!m) throw Error("Mate not found");
        if (a.type && m.type === "gear") throw Error("A gear mate stays a gear mate; delete it and add another mate");
        if (a.phase !== undefined && m.type !== "gear") throw Error("Only gear mates have a phase");
        if (a.type) m.type = a.type;
        if (a.phase !== undefined) m.phase = a.phase;
        if (m.type === "gear" && a.value !== undefined && !(a.value > 0)) throw Error("The gear ratio must be positive");
        if (a.value !== undefined) m.value = a.value;
        if (a.aligned !== undefined) m.aligned = a.aligned;
        if (m.type === "angle" && (m.value < 0 || m.value > 180))
          throw Error("Mate angle must be between 0 and 180 degrees");
      }),
  );
  add(
    "delete_mate",
    "Delete assembly mate",
    "Remove an assembly mate; undo can restore it.",
    { ...write, mateId: id },
    false,
    async (a, s) => {
      const placement = await releasePlacement(a.documentId, a.mateId);
      return mutate(a, s, "Deleted assembly mate", (d) => {
        if (placement) {
          const c = d.components!.find((c) => c.id === placement.id)!;
          c.position = placement.position;
          c.rotation = placement.rotation as [number, number, number];
        }
        if (!d.mates?.some((m) => m.id === a.mateId))
          throw Error("Mate not found");
        d.mates = d.mates.filter((m) => m.id !== a.mateId);
      });
    },
    { destructive: true },
  );
  add(
    "set_explode_offset",
    "Set exploded view offset",
    "Save a world-space display offset for a component. Explode never changes assembled geometry, mates, measurements or STEP exports.",
    { ...write, componentId: id, offset: vec3 },
    false,
    async (a, s) =>
      mutate(a, s, "Changed exploded view", (d) => {
        const c = d.components?.find((c) => c.id === a.componentId);
        if (!c) throw Error("Component not found");
        c.explode = a.offset;
      }),
  );
  add(
    "auto_explode",
    "Explode assembly automatically",
    "Compute exploded-view offsets for every component except one fixed reference, including grounded parts: parts pull out along the axis of their concentric mate, off the face of their face mate, or away from the assembly center, and parts mated to a moved part travel with it. Offsets are display only (never change mates, measurements or exports) and stay editable with set_explode_offset.",
    { ...write, spacing: z.number().finite().min(0.2).max(5).default(1).describe("Multiplier on the default travel") },
    false,
    async (a, s) => {
      const d0 = await store.read(a.documentId),
        offsets = autoExplode(d0, (await store.view(d0)).geometry, a.spacing);
      return mutate(a, s, "Exploded assembly", (d) => {
        if (!d.components?.length) throw Error("Insert parts or make components first");
        for (const c of d.components) c.explode = offsets[c.id] ?? [0, 0, 0];
      });
    },
  );
  add(
    "pattern_component",
    "Pattern component",
    "Repeat an inserted part along a direction (linear: spacing and a vector, or directionRef = a straight edge) or about an axis (circular: axis, or axisRef = a circular edge or cylindrical face, and the total angle; 360 spreads instances evenly). Instances follow the source component as it moves or is re-mated, count in the BOM, and can be mate targets. Give patternId to redefine one.",
    {
      ...write,
      ...named,
      patternId: id.optional(),
      componentId: id,
      kind: z.enum(["linear", "circular"]),
      count: z.number().int().min(2).max(100),
      spacing: positive.optional(),
      direction: nonzero.optional(),
      directionRef: ref.optional(),
      axis: z.object({ origin: vec3, direction: nonzero }).strict().optional(),
      axisRef: ref.optional(),
      angle: z.number().finite().gt(0).max(360).default(360),
    },
    false,
    async (a, s) =>
      mutate(a, s, a.patternId ? "Edited component pattern" : "Patterned component", (d) => {
        const c = d.components?.find((x) => x.id === a.componentId);
        if (!c) throw Error("Component not found");
        if (!c.source) throw Error("Pattern an inserted part; grouped bodies cannot be repeated");
        if (a.kind === "linear" && !a.spacing) throw Error("Give the spacing between instances");
        if (a.kind === "linear" && !a.direction && !a.directionRef) throw Error("Give a direction or pick a straight edge");
        if (a.kind === "circular" && !a.axis && !a.axisRef) throw Error("Give an axis or pick a circular edge or cylindrical face");
        const pattern = {
          id: a.patternId ?? randomUUID(),
          name: a.name ?? `${a.kind === "linear" ? "Linear" : "Circular"} Pattern ${(d.componentPatterns?.length ?? 0) + 1}`,
          componentId: c.id,
          kind: a.kind,
          count: a.count,
          ...(a.kind === "linear"
            ? { spacing: a.spacing, ...(a.directionRef ? { directionRef: a.directionRef } : { direction: a.direction }) }
            : { angle: a.angle, ...(a.axisRef ? { axisRef: a.axisRef } : { axis: a.axis }) }),
        };
        d.componentPatterns ??= [];
        const i = d.componentPatterns.findIndex((p) => p.id === pattern.id);
        if (a.patternId && i < 0) throw Error("Component pattern not found");
        if (i >= 0) d.componentPatterns[i] = { ...pattern, name: a.name ?? d.componentPatterns[i].name };
        else d.componentPatterns.push(pattern);
      }),
  );
  add(
    "delete_component_pattern",
    "Delete component pattern",
    "Remove a component pattern and its instances; mates that use an instance as their target must be removed first. Undo restores it.",
    { ...write, patternId: id },
    false,
    async (a, s) =>
      mutate(a, s, "Deleted component pattern", (d) => {
        if (!d.componentPatterns?.some((p) => p.id === a.patternId)) throw Error("Component pattern not found");
        if (d.mates?.some((m) => [m.moving.bodyId, m.target.bodyId].some((b) => b.startsWith(`${a.patternId}~`))))
          throw Error("A mate uses one of the pattern's instances; delete that mate first");
        d.componentPatterns = d.componentPatterns.filter((p) => p.id !== a.patternId);
      }),
    { destructive: true },
  );
  add(
    "inspect_assembly",
    "Inspect assembly and BOM",
    "Read components, solved body placements, mates, grounding, remaining mate types and bill of materials. Each mate has a state (ok, over: over-defining and left unsolved, error: missing or unsuitable geometry, suppressed) with a message naming what it conflicts with; each component has its definition (fixed, under with its remaining degrees of freedom, full, over), as SolidWorks shows (f), (-) and (+). Closed loops of mates (linkages) are solved together. This is a rigid positioning solver, not dynamics.",
    base,
    true,
    async (a) => {
      const d = await store.read(a.documentId),
        v = await store.view(d);
      const linked = await store.linkedDocuments(d);
      // Instances of one inserted part are one BOM line.
      const lines = new Map<string, { name: string; quantity: number; componentIds: string[]; bodyIds: string[]; volume: number; partDocumentId?: string }>();
      for (const c of allComponents(d)) {
        if (c.suppressed) continue;
        const key = c.source ? `part:${c.source.documentId}` : `component:${c.id}`;
        const bodies = v.geometry.bodies.filter((b) => componentOwns(c, b.id));
        const line = lines.get(key) ?? {
          name: c.source ? (linked[c.source.documentId]?.name ?? c.name) : c.belt ? (bodies[0]?.name ?? c.name) : c.name,
          quantity: 0,
          componentIds: [],
          bodyIds: [],
          volume: bodies.reduce((s, b) => s + b.volume, 0),
          ...(c.source ? { partDocumentId: c.source.documentId } : {}),
        };
        line.quantity++;
        line.componentIds.push(c.id);
        line.bodyIds.push(...bodies.map((b) => b.id));
        lines.set(key, line);
      }
      const mateState = v.geometry.mateStatus ?? {},
        definition = v.geometry.componentStatus ?? {};
      return {
        revision: d.revision,
        components: (d.components ?? []).map((c) => ({ ...c, ...(definition[c.id] ? { definition: definition[c.id].status, freedom: definition[c.id].dof } : {}) })),
        mates: (d.mates ?? []).map((m) => ({
          ...m,
          state: m.suppressed || componentOf(d, m.moving.bodyId)?.suppressed || componentOf(d, m.target.bodyId)?.suppressed ? "suppressed" : (mateState[m.id]?.status ?? "ok"),
          ...(mateState[m.id]?.message ? { message: mateState[m.id].message } : {}),
        })),
        placements: v.geometry.placements ?? {},
        bom: [...lines.values()].map((line, i) => ({ item: i + 1, ...line })),
      };
    },
  );
  const sheetSize = z.enum(["A4", "A3", "A2", "A1", "A0", "ANSI A", "ANSI B", "ANSI C", "ANSI D"]);
  const titleFields = {
    title: z.string().max(100),
    author: z.string().max(80),
    material: z.string().max(80),
    drawingNumber: z.string().max(60),
    company: z.string().max(80),
    revisionLabel: z.string().max(12),
    checkedBy: z.string().max(80),
    approvedBy: z.string().max(80),
    date: z.string().max(40),
    finish: z.string().max(80),
    generalTolerance: z.string().max(80),
  };
  const drawingFields = {
    name: z.string().min(1).max(100),
    size: sheetSize.default("A4"),
    orientation: z.enum(["landscape", "portrait"]).default("landscape"),
    scale: z.number().finite().gt(0).max(20).default(0.5),
    projection: z.enum(["first", "third"]).default("third"),
    hiddenLines: z.boolean().default(true),
    title: titleFields.title.default(""),
    author: titleFields.author.default(""),
    material: titleFields.material.default(""),
    drawingNumber: titleFields.drawingNumber.default(""),
  };
  const sheetOf = (d: Document, id: string) => {
    const sheet = d.drawings?.find((x) => x.id === id);
    if (!sheet) throw Error("Drawing not found");
    return sheet;
  };
  /** Render after an edit; with `fit`, reject views that leave the border. */
  const checkSheet = async (d: Document, id: string, fit = false) => {
    const out = await renderDrawing(await store.kernelDocument(d), id);
    if (fit) assertViewsFit(sheetOf(d, id), out.views);
    return out;
  };
  add(
    "create_drawing",
    "Create mechanical drawing",
    "Create an associative drawing sheet from solid bodies with front, top, right and isometric views, exact hidden-line projection, ISO title block and zone border. Sizes A4–A0 and ANSI A–D, landscape or portrait; first or third angle projection.",
    {
      ...write,
      ...drawingFields,
      ...Object.fromEntries(Object.entries(titleFields).filter(([k]) => !["title", "author", "material", "drawingNumber"].includes(k)).map(([k, v]) => [k, v.optional()])),
      bodyIds: z.array(id).min(1).max(50),
      dimensions: z.boolean().default(true).describe("Add overall dimensions to the front and top views"),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Created mechanical drawing", async (d) => {
        for (const bid of a.bodyIds) {
          const owner = componentOf(d, bid);
          if (!owner?.source && !owner?.belt) body(d, bid);
        }
        const { documentId, expectedRevision, reason, dimensions, ...sheet } = a;
        const created: any = { ...sheet, id: randomUUID(), dimensions: [], annotations: [] };
        created.views = resolveViews(created);
        if (dimensions)
          created.dimensions = [
            { id: randomUUID(), view: "front", axis: "horizontal", offset: 8 },
            { id: randomUUID(), view: "front", axis: "vertical", offset: 8 },
            { id: randomUUID(), view: "top", axis: "vertical", offset: 8 },
          ];
        (d.drawings ??= []).push(created);
        await checkSheet(d, created.id, true);
      }),
  );
  add(
    "update_drawing",
    "Edit drawing sheet",
    "Change the sheet name, size, orientation, default scale, projection angle (projected views move to the matching side), hidden lines and title block fields. Dimensions remain associative.",
    {
      ...write,
      drawingId: id,
      name: z.string().min(1).max(100).optional(),
      size: sheetSize.optional(),
      orientation: z.enum(["landscape", "portrait"]).optional(),
      scale: z.number().finite().gt(0).max(20).optional(),
      projection: z.enum(["first", "third"]).optional(),
      hiddenLines: z.boolean().optional(),
      ...Object.fromEntries(Object.entries(titleFields).map(([k, v]) => [k, v.optional()])),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Edited drawing sheet", async (d) => {
        const sheet = sheetOf(d, a.drawingId);
        const { documentId, expectedRevision, reason, drawingId, ...fields } = a;
        const before = { projection: sheet.projection, size: sheet.size, orientation: sheet.orientation };
        sheet.views ??= resolveViews(sheet);
        Object.assign(sheet, fields);
        if (fields.projection && fields.projection !== before.projection)
          // Projected views swap sides about their parent.
          for (const v of sheet.views) {
            const parent = sheet.views.find((p) => p.id === v.parentId);
            if (v.kind === "projected" && parent)
              v.position = [2 * parent.position[0] - v.position[0], 2 * parent.position[1] - v.position[1]];
          }
        if ((fields.size && fields.size !== before.size) || (fields.orientation && fields.orientation !== before.orientation)) {
          const old = sheetDimensions(before as any),
            next = sheetDimensions(sheet);
          for (const v of sheet.views) v.position = [(v.position[0] * next.width) / old.width, (v.position[1] * next.height) / old.height];
        }
        await checkSheet(d, sheet.id, fields.scale !== undefined || !!fields.size || !!fields.orientation);
      }),
  );
  add(
    "add_drawing_view",
    "Add drawing view",
    "Add a view to a sheet: base (front/back/top/bottom/left/right/iso/dimetric/trimetric), projected (orthographic neighbor of a parent view on a side), section (cut line a→b in the parent's model plane, mm; the view looks toward the left side of a→b unless flipped), detail (circle center/radius in the parent's model plane, magnified), or flat (the unfolded blank of a sheet metal body, with bend lines; bodyId defaults to the sheet's sheet metal body). Position is the sheet location of the view center in mm.",
    {
      ...write,
      drawingId: id,
      kind: z.enum(["base", "projected", "section", "detail", "flat"]),
      orientation: z.enum(["front", "back", "top", "bottom", "left", "right", "iso", "dimetric", "trimetric"]).optional(),
      parentId: id.optional(),
      bodyId: id.optional().describe("Flat views: the sheet metal body"),
      side: z.enum(["left", "right", "above", "below"]).optional(),
      position: vec2,
      scale: z.number().finite().gt(0).max(50).optional(),
      name: z.string().min(1).max(60).optional(),
      a: vec2.optional(),
      b: vec2.optional(),
      flip: z.boolean().optional(),
      center: vec2.optional(),
      radius: positive.optional(),
      label: z.string().min(1).max(3).optional(),
      hiddenLines: z.boolean().optional(),
      exploded: z.boolean().optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, `Added ${a.kind} view`, async (d) => {
        const sheet = sheetOf(d, a.drawingId);
        sheet.views ??= resolveViews(sheet);
        if (sheet.views.length >= 24) throw Error("A sheet holds at most 24 views");
        const parent = a.parentId ? sheet.views.find((v) => v.id === a.parentId) : undefined;
        if (a.kind !== "base" && a.kind !== "flat" && !parent) throw Error("Select the parent view");
        const used = new Set(sheet.views.flatMap((v) => [v.section?.label, v.detail?.label]).filter(Boolean));
        const nextLabel = () => [..."ABCDEFGHJKLMNPRSTUVWXYZ"].find((l) => !used.has(l)) ?? "Z";
        let view: any;
        if (a.kind === "base") view = { kind: "base", orientation: a.orientation ?? "front", name: a.name ?? `${(a.orientation ?? "front")[0].toUpperCase()}${(a.orientation ?? "front").slice(1)}` };
        else if (a.kind === "flat") {
          const sheetMetal = (bid: string) => d.features.some((f) => f.type === "sheet" && f.bodyId === bid && !f.suppressed);
          const bodyId = a.bodyId ?? sheet.bodyIds.find(sheetMetal);
          if (!bodyId || !sheetMetal(bodyId)) throw Error("Flat pattern views show a sheet metal body; start one with a base flange");
          if (!sheet.bodyIds.includes(bodyId)) sheet.bodyIds.push(bodyId);
          view = { kind: "flat", bodyId, name: a.name ?? "Flat pattern" };
        }
        else if (a.kind === "projected") {
          if (!a.side && !a.orientation) throw Error("Give the side of the parent view or an orientation");
          const orientation = a.orientation ?? projectedOrientation(parent!.orientation ?? "front", a.side!, sheet.projection);
          view = { kind: "projected", orientation, parentId: parent!.id, name: a.name ?? `${orientation[0].toUpperCase()}${orientation.slice(1)}` };
          // Projected views stay aligned with their parent.
          if (a.side === "left" || a.side === "right") a.position = [a.position[0], parent!.position[1]];
          if (a.side === "above" || a.side === "below") a.position = [parent!.position[0], a.position[1]];
        } else if (a.kind === "section") {
          if (!a.a || !a.b) throw Error("Section views need a cut line from a to b");
          if (Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]) < 1e-6) throw Error("The section line has no length");
          const label = a.label ?? nextLabel();
          view = { kind: "section", parentId: parent!.id, name: a.name ?? `Section ${label}-${label}`, section: { a: a.a, b: a.b, label, ...(a.flip ? { flip: true } : {}) } };
        } else {
          if (!a.center || !a.radius) throw Error("Detail views need a circle center and radius");
          const label = a.label ?? nextLabel();
          view = { kind: "detail", parentId: parent!.id, name: a.name ?? `Detail ${label}`, detail: { center: a.center, radius: a.radius, label }, scale: a.scale ?? (parent!.scale ?? sheet.scale) * 2 };
        }
        sheet.views.push({
          id: randomUUID(),
          ...view,
          position: a.position,
          ...(a.scale && a.kind !== "detail" ? { scale: a.scale } : {}),
          ...(a.hiddenLines !== undefined ? { hiddenLines: a.hiddenLines } : {}),
          ...(a.exploded ? { exploded: true } : {}),
        });
        await checkSheet(d, sheet.id);
      }),
  );
  add(
    "update_drawing_view",
    "Edit drawing view",
    "Move a view (projected views stay aligned with their parent; children of a moved view move with it), change its scale, name, orientation (base views), hidden lines, label, exploded state, or its section line / detail circle.",
    {
      ...write,
      drawingId: id,
      viewId: id,
      position: vec2.optional(),
      scale: z.number().finite().gt(0).max(50).optional(),
      name: z.string().min(1).max(60).optional(),
      orientation: z.enum(["front", "back", "top", "bottom", "left", "right", "iso", "dimetric", "trimetric"]).optional(),
      hiddenLines: z.boolean().optional(),
      showLabel: z.boolean().optional(),
      exploded: z.boolean().optional(),
      a: vec2.optional(),
      b: vec2.optional(),
      flip: z.boolean().optional(),
      center: vec2.optional(),
      radius: positive.optional(),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Edited drawing view", async (d) => {
        const sheet = sheetOf(d, a.drawingId);
        sheet.views ??= resolveViews(sheet);
        const v = sheet.views.find((x) => x.id === a.viewId);
        if (!v) throw Error("Drawing view not found");
        if (a.position) {
          let next = a.position;
          const parent = sheet.views.find((p) => p.id === v.parentId);
          if (v.kind === "projected" && parent) {
            const dx = Math.abs(v.position[0] - parent.position[0]),
              dy = Math.abs(v.position[1] - parent.position[1]);
            next = dx > dy ? [next[0], parent.position[1]] : [parent.position[0], next[1]];
          }
          const delta = [next[0] - v.position[0], next[1] - v.position[1]];
          v.position = next;
          for (const child of sheet.views.filter((c) => c.parentId === v.id && c.kind === "projected"))
            child.position = Math.abs(child.position[0] - (v.position[0] - delta[0])) < 1e-6
              ? [child.position[0] + delta[0], child.position[1]]
              : [child.position[0], child.position[1] + delta[1]];
        }
        if (a.scale !== undefined) v.scale = a.scale;
        if (a.name) v.name = a.name;
        if (a.orientation) {
          if (v.kind !== "base") throw Error("Only base views have their own orientation");
          v.orientation = a.orientation;
        }
        for (const key of ["hiddenLines", "showLabel", "exploded"] as const) if (a[key] !== undefined) (v as any)[key] = a[key];
        if (v.section && (a.a || a.b || a.flip !== undefined)) v.section = { ...v.section, ...(a.a ? { a: a.a } : {}), ...(a.b ? { b: a.b } : {}), ...(a.flip !== undefined ? { flip: a.flip } : {}) };
        if (v.detail && (a.center || a.radius)) v.detail = { ...v.detail, ...(a.center ? { center: a.center } : {}), ...(a.radius ? { radius: a.radius } : {}) };
        await checkSheet(d, sheet.id, a.scale !== undefined);
      }),
  );
  add(
    "remove_drawing_view",
    "Delete drawing view",
    "Delete a view together with views derived from it and the dimensions and annotations attached to them.",
    { ...write, drawingId: id, viewId: id },
    false,
    async (a, s) =>
      mutate(a, s, "Deleted drawing view", (d) => {
        const sheet = sheetOf(d, a.drawingId);
        sheet.views ??= resolveViews(sheet);
        if (!sheet.views.some((v) => v.id === a.viewId)) throw Error("Drawing view not found");
        const removed = new Set([a.viewId]);
        for (let changed = true; changed; ) {
          changed = false;
          for (const v of sheet.views)
            if (v.parentId && removed.has(v.parentId) && !removed.has(v.id)) {
              removed.add(v.id);
              changed = true;
            }
        }
        sheet.views = sheet.views.filter((v) => !removed.has(v.id));
        sheet.dimensions = sheet.dimensions.filter((x) => !removed.has(x.view));
        sheet.annotations = (sheet.annotations ?? []).filter((x) => !("view" in x) || !removed.has((x as any).view));
      }),
    { destructive: true },
  );
  const drawingPoint = z
    .object({ ref, anchor: z.enum(["start", "end", "mid", "center", "edge"]).optional() })
    .strict();
  const tolerance = z
    .object({ kind: z.enum(["symmetric", "bilateral", "limits"]), upper: z.number().finite().min(0).max(100), lower: z.number().finite().min(-100).max(100).optional() })
    .strict();
  const dimensionStyle = {
    position: vec2.optional().describe("Text position relative to the view center, sheet mm"),
    tolerance: tolerance.optional(),
    decimals: z.number().int().min(0).max(4).optional(),
    prefix: z.string().max(12).optional(),
    suffix: z.string().max(12).optional(),
    text: z.string().max(60).optional(),
  };
  add(
    "add_drawing_dimension",
    "Dimension drawing",
    "Add an associative dimension to a view. Typed form: type horizontal/vertical/aligned with one straight edge or two points (anchor start/end/center; two edges with anchor edge measure the distance between parallel edges), radius/diameter/hole (circular edge; hole writes the full hole callout), angle (two straight edges), ordinate (the first point is the zero, every later point gets its distance from it along axis horizontal or vertical, values on one row at position; up to 60 points, holes by their centers). Legacy form: axis horizontal/vertical with optional refs. Values update with the model.",
    {
      ...write,
      drawingId: id,
      view: z.string().min(1).max(100),
      type: z.enum(["horizontal", "vertical", "aligned", "radius", "diameter", "angle", "hole", "ordinate"]).optional(),
      points: z.array(drawingPoint).min(1).max(60).optional(),
      axis: z.enum(["horizontal", "vertical"]).optional(),
      offset: z.number().finite().min(2).max(60).default(8),
      refs: z.array(ref).length(2).optional(),
      ...dimensionStyle,
    },
    false,
    async (a, s) =>
      mutate(a, s, "Added drawing dimension", async (d) => {
        const sheet = sheetOf(d, a.drawingId);
        if (sheet.dimensions.length >= 200) throw Error("Limit of 200 sheet dimensions reached");
        if (!a.type && !a.axis) throw Error("Give a dimension type");
        if (a.type !== "ordinate" && (a.points?.length ?? 0) > 2) throw Error("Only ordinate dimensions take more than two points");
        if (a.type === "ordinate" && !a.points?.length) throw Error("An ordinate dimension needs its zero point");
        const { documentId, expectedRevision, reason, drawingId, ...dim } = a;
        if (dim.type === "ordinate") dim.axis ??= "horizontal";
        sheet.dimensions.push({ id: randomUUID(), ...dim });
        await checkSheet(d, sheet.id);
      }),
  );
  add(
    "update_drawing_dimension",
    "Edit drawing dimension",
    "Move a dimension's text, or change its tolerance, decimals, prefix, suffix or override text. For an ordinate dimension, points replaces its zero and measured points (add a feature by sending the list with it appended).",
    { ...write, drawingId: id, dimensionId: id, ...dimensionStyle, clearTolerance: z.boolean().optional(), points: z.array(drawingPoint).min(1).max(60).optional() },
    false,
    async (a, s) =>
      mutate(a, s, "Edited drawing dimension", async (d) => {
        const sheet = sheetOf(d, a.drawingId);
        const dim = sheet.dimensions.find((x) => x.id === a.dimensionId);
        if (!dim) throw Error("Drawing dimension not found");
        const { documentId, expectedRevision, reason, drawingId, dimensionId, clearTolerance, ...fields } = a;
        if (fields.points && dim.type !== "ordinate") throw Error("Only an ordinate dimension's points can change; add a new dimension instead");
        Object.assign(dim, fields);
        if (clearTolerance) delete dim.tolerance;
        await checkSheet(d, sheet.id);
      }),
  );
  add(
    "add_drawing_callout",
    "Add diameter or radius callout",
    "Add an associative diameter or radius leader to an inspected circular edge; numeric values come from exact CAD geometry.",
    {
      ...write,
      drawingId: id,
      view: z.string().min(1).max(100),
      kind: z.enum(["diameter", "radius"]),
      reference: ref,
      offset: z.number().finite().min(2).max(60).default(8),
    },
    false,
    async (a, s) => {
      const v = await store.view(await store.read(a.documentId));
      const t = findTopology(v.geometry.bodies.flatMap((b) => b.topology), a.reference);
      if (!t?.radius || t.kind !== "edge") throw Error("Select a circular edge for a diameter or radius callout");
      return mutate(a, s, "Added drawing callout", async (d) => {
        const sheet = sheetOf(d, a.drawingId);
        if (sheet.dimensions.length >= 200) throw Error("Limit of 200 sheet dimensions reached");
        sheet.dimensions.push({ id: randomUUID(), view: a.view, axis: "horizontal", kind: a.kind, reference: a.reference, offset: a.offset });
        await checkSheet(d, sheet.id);
      });
    },
  );
  add(
    "remove_drawing_dimension",
    "Remove drawing dimension",
    "Delete a sheet dimension; undo can restore it.",
    { ...write, drawingId: id, dimensionId: id },
    false,
    async (a, s) =>
      mutate(a, s, "Removed drawing dimension", (d) => {
        const sheet = sheetOf(d, a.drawingId);
        if (!sheet.dimensions.some((x) => x.id === a.dimensionId)) throw Error("Drawing dimension not found");
        sheet.dimensions = sheet.dimensions.filter((x) => x.id !== a.dimensionId);
      }),
  );
  const annotationInput = z.discriminatedUnion("type", [
    z.object({ type: z.literal("note"), position: vec2, text: z.string().min(1).max(600), size: z.number().min(1.8).max(10).optional(), leader: z.object({ view: z.string().min(1).max(100), ref }).strict().optional() }).strict(),
    z.object({ type: z.literal("balloon"), view: z.string().min(1).max(100), ref, position: vec2, item: z.number().int().min(1).max(999).optional() }).strict(),
    z.object({ type: z.literal("bom"), position: vec2 }).strict(),
    z.object({ type: z.literal("centermark"), view: z.string().min(1).max(100), ref }).strict(),
    z.object({ type: z.literal("centerline"), view: z.string().min(1).max(100), refs: z.array(ref).length(2) }).strict(),
    z.object({ type: z.literal("surface"), view: z.string().min(1).max(100), ref, position: vec2, roughness: z.string().min(1).max(20) }).strict(),
    z.object({ type: z.literal("datum"), view: z.string().min(1).max(100), ref, position: vec2, label: z.string().min(1).max(2) }).strict(),
    z
      .object({
        type: z.literal("weld"),
        view: z.string().min(1).max(100),
        ref,
        position: vec2,
        leg: z.number().finite().gt(0).max(100).optional().describe("Fillet leg size; defaults to the bead's leg when the arrow points at a weld bead"),
        length: z.number().finite().gt(0).max(10000).optional().describe("Weld length; omit for the full joint"),
        sides: z.enum(["arrow", "other", "both"]).optional(),
        allAround: z.boolean().optional(),
        field: z.boolean().optional(),
        process: z.string().min(1).max(40).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("gdt"),
        view: z.string().min(1).max(100),
        ref,
        position: vec2,
        characteristic: z.enum(["flatness", "straightness", "circularity", "cylindricity", "parallelism", "perpendicularity", "angularity", "position", "concentricity", "symmetry", "profile", "runout"]),
        tolerance: z.number().finite().gt(0).max(100),
        diametral: z.boolean().optional(),
        datums: z.array(z.string().min(1).max(2)).max(3).optional(),
      })
      .strict(),
  ]);
  add(
    "add_drawing_annotation",
    "Annotate drawing",
    "Add a note (with optional leader), balloon (item number from the BOM), bill of materials table, center mark, centerline between two edges, surface finish symbol, datum feature symbol, geometric tolerance frame or fillet weld symbol (AWS A2.4: arrow side below the reference line, leg size left of the symbol, length right, process in the tail). Positions are sheet mm.",
    { ...write, drawingId: id, annotation: annotationInput },
    false,
    async (a, s) =>
      mutate(a, s, `Added drawing ${a.annotation.type}`, async (d) => {
        const sheet = sheetOf(d, a.drawingId);
        if ((sheet.annotations?.length ?? 0) >= 200) throw Error("Limit of 200 annotations reached");
        (sheet.annotations ??= []).push({ id: randomUUID(), ...a.annotation });
        await checkSheet(d, sheet.id);
      }),
  );
  add(
    "update_drawing_annotation",
    "Edit drawing annotation",
    "Move an annotation or change its text, size, item number, roughness, label, tolerance, or a weld symbol's leg, length, sides and process.",
    {
      ...write,
      drawingId: id,
      annotationId: id,
      position: vec2.optional(),
      text: z.string().min(1).max(600).optional(),
      size: z.number().min(1.8).max(10).optional(),
      item: z.number().int().min(1).max(999).optional(),
      roughness: z.string().min(1).max(20).optional(),
      label: z.string().min(1).max(2).optional(),
      tolerance: z.number().finite().gt(0).max(100).optional(),
      leg: z.number().finite().gt(0).max(100).optional(),
      length: z.number().finite().gt(0).max(10000).nullable().optional().describe("Weld length; null for the full joint"),
      sides: z.enum(["arrow", "other", "both"]).optional(),
      allAround: z.boolean().optional(),
      field: z.boolean().optional(),
      process: z.string().min(1).max(40).nullable().optional().describe("Tail text; null removes the tail"),
    },
    false,
    async (a, s) =>
      mutate(a, s, "Edited drawing annotation", async (d) => {
        const sheet = sheetOf(d, a.drawingId);
        const note = sheet.annotations?.find((x) => x.id === a.annotationId);
        if (!note) throw Error("Drawing annotation not found");
        const { documentId, expectedRevision, reason, drawingId, annotationId, ...fields } = a;
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) continue;
          // A weld symbol's optional fields can be added later.
          const weldField = note.type === "weld" && ["leg", "length", "sides", "allAround", "field", "process"].includes(k);
          if (k !== "position" && !(k in note) && !weldField) throw Error(`${note.type} annotations have no ${k}`);
          if (v === null) delete (note as any)[k];
          else (note as any)[k] = v;
        }
        await checkSheet(d, sheet.id);
      }),
  );
  add(
    "remove_drawing_annotation",
    "Delete drawing annotation",
    "Delete a note, balloon, table or symbol from the sheet.",
    { ...write, drawingId: id, annotationId: id },
    false,
    async (a, s) =>
      mutate(a, s, "Deleted drawing annotation", (d) => {
        const sheet = sheetOf(d, a.drawingId);
        if (!sheet.annotations?.some((x) => x.id === a.annotationId)) throw Error("Drawing annotation not found");
        sheet.annotations = sheet.annotations.filter((x) => x.id !== a.annotationId);
      }),
    { destructive: true },
  );
  add(
    "delete_drawing",
    "Delete drawing sheet",
    "Delete a drawing sheet; undo can restore it.",
    { ...write, drawingId: id },
    false,
    async (a, s) =>
      mutate(a, s, "Deleted drawing sheet", (d) => {
        sheetOf(d, a.drawingId);
        d.drawings = d.drawings!.filter((x) => x.id !== a.drawingId);
      }),
    { destructive: true },
  );
  add(
    "render_drawing",
    "Render mechanical drawing",
    "Generate the sheet from the current assembled B-rep with hidden-line removal. Returns SVG and, per view, its sheet bounds, model-to-sheet mapping and pickable projected edges with exact references.",
    { ...base, drawingId: id },
    true,
    async (a) => renderDrawing(await store.kernelDocument(await store.read(a.documentId)), a.drawingId),
  );
  add(
    "export_drawing",
    "Export mechanical drawing",
    "Export the sheet as vector PDF (print-ready), DXF (R12, layered) or SVG, regenerated from the current model revision at true millimeter size.",
    { ...base, drawingId: id, format: z.enum(["svg", "pdf", "dxf"]).default("svg") },
    false,
    async (a) => {
      const d = await store.read(a.documentId),
        out = await renderDrawing(await store.kernelDocument(d), a.drawingId, a.format);
      const sheet = sheetOf(d, a.drawingId);
      const filename = `${(sheet.drawingNumber || d.name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50)}_${sheet.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20)}-r${d.revision}.${a.format}`;
      const bytes =
        a.format === "pdf" ? out.pdf! : new TextEncoder().encode(a.format === "dxf" ? out.dxf! : out.svg);
      return saveExport(store.directory, d.id, filename, a.format === "pdf" ? "application/pdf" : a.format === "dxf" ? "image/vnd.dxf" : "image/svg+xml", bytes);
    },
  );
  const previewNames = [
    "add_mate",
    "insert_component",
    "pattern_component",
    "create_rib",
    "create_base_flange",
    "create_edge_flange",
    "create_closed_corner",
    "create_hem",
    "create_sketched_bend",
    "extrude",
    "revolve",
    "sweep",
    "loft",
    "create_hole",
    "fillet_edges",
    "fillet_faces",
    "fillet_body",
    "variable_fillet_edges",
    "create_circular_pattern",
    "chamfer_edges",
    "create_linear_pattern",
    "mirror_body",
    "boolean_bodies",
    "shell_body",
    "move_body",
    "draft_faces",
    "move_face",
    "create_thread",
    "create_gear",
    "create_pulley",
    "create_structural_member",
    "create_weld_bead",
    "split_body",
    "scale_body",
    "create_reference_plane",
    "edit_sketch",
  ] as const;
  const command = z.discriminatedUnion(
    "tool",
    previewNames.map((name) =>
      z
        .object({
          tool: z.literal(name),
          arguments: tools
            .find((t) => t.name === name)!
            .schema.omit({
              documentId: true,
              expectedRevision: true,
              reason: true,
            }),
        })
        .strict(),
    ) as any,
  );
  add(
    "preview_feature",
    "Preview CAD feature",
    "Preview a typed CAD feature without committing it. Uses the same validated edit as the corresponding feature tool. Explicit selections and dimensions remain authoritative. Apply the returned preview ID to accept, or dismiss to cancel.",
    { ...write, command },
    false,
    async (a, source) => {
      const previewStore = Object.create(store) as Store;
      previewStore.transact = ((
        documentId: string,
        expectedRevision: number,
        description: string,
        _source: string,
        edit: (d: Document) => void | Promise<void>,
      ) =>
        store.preview(
          documentId,
          expectedRevision,
          description,
          edit,
        )) as Store["transact"];
      const definition = toolset(previewStore).find(
        (t) => t.name === a.command.tool,
      )!;
      const args: any = definition.schema.parse({
        documentId: a.documentId,
        expectedRevision: a.expectedRevision,
        ...a.command.arguments,
      });
      if (
        (a.command.tool === "fillet_edges" ||
          a.command.tool === "chamfer_edges") &&
        !args.edges?.length
      )
        throw Error("Select actual edges before previewing this feature");
      return definition.handler(args, source);
    },
  );
  // ---------------------------------------------------------------------------
  // run_steps: many typed tool calls in one request, for building fast.
  /** Tools a batch cannot run: itself, history and preview flows, and git. */
  const notInBatch = (name: string) => name === "run_steps" || ["undo", "redo", "restore_history", "preview_feature", "apply_preview", "dismiss_preview"].includes(name) || name.startsWith("git_");
  const kinds = { document: "", sketch: "sketches", feature: "features", body: "bodies", component: "components", mate: "mates", drawing: "drawings", plane: "referencePlanes", entity: "" } as const;
  type Kind = keyof typeof kinds;
  /** What a step made: ids of new objects of each kind, found by comparing the document before and after. */
  const madeBy = (before: Document | undefined, after: Document) => {
    const made: Partial<Record<Kind, string[]>> = {};
    for (const [kind, key] of Object.entries(kinds) as [Kind, string][]) {
      if (!key) continue;
      const old = new Set(((before as any)?.[key] ?? []).map((x: { id: string }) => x.id));
      const fresh = ((after as any)[key] ?? []).map((x: { id: string }) => x.id).filter((x: string) => !old.has(x));
      if (fresh.length) made[kind] = fresh;
    }
    const oldEntities = new Set((before?.sketches ?? []).flatMap((s) => s.entities.map((e) => e.id)));
    const entities = after.sketches.flatMap((s) => s.entities.map((e) => e.id)).filter((x) => !oldEntities.has(x));
    if (entities.length) made.entity = entities;
    return made;
  };
  const geomTypes: Record<string, string[]> = {
    plane: ["PLANE"],
    cylinder: ["CYLINDRE", "CYLINDER"],
    cone: ["CONE"],
    sphere: ["SPHERE"],
    torus: ["TORUS"],
    line: ["LINE"],
    circle: ["CIRCLE"],
    ellipse: ["ELLIPSE"],
    spline: ["BSPLINE_SURFACE", "BEZIER_SURFACE", "BSPLINE_CURVE", "BEZIER_CURVE"],
  };
  const selectorShape = z
    .object({
      body: z.string().optional(),
      component: z.string().optional(),
      feature: z.string().optional(),
      type: z.enum(Object.keys(geomTypes) as [string, ...string[]]).optional(),
      normal: vec3.optional(),
      along: vec3.optional(),
      radius: z.number().positive().optional(),
      hole: z.boolean().optional(),
      near: vec3.optional(),
      extreme: vec3.optional(),
      largest: z.boolean().optional(),
    })
    .strict();
  /** Faces or edges picked by description in the step's document, as the view places them. */
  const pick = (view: View, kind: "face" | "edge", many: boolean, raw: unknown): TopologyRef | TopologyRef[] => {
    const q = selectorShape.parse(raw);
    const unit3 = (p: number[]) => {
      const l = Math.hypot(...p) || 1;
      return p.map((x) => x / l);
    };
    const dot3 = (p: number[], w: number[]) => p[0] * w[0] + p[1] * w[1] + p[2] * w[2];
    const parallel = (p: number[], w: number[]) => Math.abs(dot3(unit3(p), unit3(w))) > Math.cos(Math.PI / 180);
    const component = q.component ? allComponents(view.document).find((c) => c.id === q.component) : undefined;
    if (q.component && !component) throw Error(`No component ${q.component}`);
    const bodies = view.geometry.bodies.filter((b) => !b.hidden && (!q.body || b.id === q.body) && (!component || componentOwns(component, b.id)));
    if (q.body && !bodies.length) throw Error(`No visible body ${q.body}`);
    const inward = (t: Topology) => {
      if (!t.axis || !t.normal) return false;
      const c = t.center.map((x, i) => x - t.axis!.origin[i]),
        k = dot3(c, t.axis.direction),
        radial = c.map((x, i) => x - k * t.axis!.direction[i]);
      return dot3(radial, t.normal) < 0;
    };
    let found = bodies
      .flatMap((b) => b.topology)
      .filter(
        (t) =>
          t.kind === kind &&
          (!q.type || geomTypes[q.type].includes(t.geomType)) &&
          (!q.feature || t.featureId === q.feature) &&
          (!q.normal || (!!t.normal && kind === "face" && dot3(unit3(t.normal), unit3(q.normal)) > Math.cos(Math.PI / 180))) &&
          (!q.along ||
            (t.endpoints && t.geomType === "LINE"
              ? parallel(t.endpoints[1].map((x, i) => x - t.endpoints![0][i]), q.along)
              : t.geomType === "PLANE" && t.normal
                ? Math.abs(dot3(unit3(t.normal), unit3(q.along))) < Math.sin(Math.PI / 180)
                : !!t.axis && parallel(t.axis.direction, q.along))) &&
          (q.radius === undefined || (t.radius !== undefined && Math.abs(t.radius - q.radius) <= Math.max(1e-4, 1e-4 * q.radius))) &&
          (q.hole === undefined || (t.kind === "face" && geomTypes.cylinder.includes(t.geomType) && (t.concave ?? inward(t)) === q.hole)),
      );
    if (!found.length) throw Error(`No ${kind} matches ${JSON.stringify(raw)}`);
    const size = (t: Topology) => t.area ?? t.length ?? 0;
    if (q.near) found = [found.reduce((best, t) => (Math.hypot(...t.center.map((x, i) => x - q.near![i])) < Math.hypot(...best.center.map((x, i) => x - q.near![i])) ? t : best))];
    else if (q.extreme) {
      const top = Math.max(...found.map((t) => dot3(t.center, q.extreme!)));
      found = found.filter((t) => dot3(t.center, q.extreme!) > top - 1e-6);
    }
    if (q.largest) found = [found.reduce((best, t) => (size(t) > size(best) ? t : best))];
    const ref = (t: Topology): TopologyRef => ({ id: t.id, bodyId: t.bodyId, kind: t.kind, geomType: t.geomType });
    if (many) return found.map(ref);
    // Pieces of one surface (the two halves of a cylinder) are interchangeable: take the largest.
    const oneSurface = found.every(
      (t) =>
        t.geomType === found[0].geomType &&
        ((t.axis && found[0].axis && t.radius === found[0].radius && parallel(t.axis.direction, found[0].axis.direction) &&
          Math.hypot(...((o) => o.map((x, i) => x - dot3(o, unit3(found[0].axis!.direction)) * unit3(found[0].axis!.direction)[i]))(t.axis.origin.map((x, i) => x - found[0].axis!.origin[i]))) < 1e-6) ||
          (t.normal && found[0].normal && parallel(t.normal, found[0].normal) && Math.abs(dot3(t.center.map((x, i) => x - found[0].center[i]), unit3(found[0].normal))) < 1e-6)),
    );
    if (found.length > 1 && !oneSurface)
      throw Error(`${found.length} ${kind}s match ${JSON.stringify(raw)}; narrow it with near, extreme, largest, type, normal, radius or feature (or use $${kind}s for all of them)`);
    return ref(found.reduce((best, t) => (size(t) > size(best) ? t : best)));
  };
  const stepSchema = z
    .object({
      tool: z.string().min(1).max(60),
      args: z.record(z.string(), z.unknown()).default({}),
      as: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,30}$/).optional(),
    })
    .strict();
  add(
    "run_steps",
    "Run steps",
    `Run a sequence of typed tool calls in one request: much faster than one call (or one screenshot) per operation. Each step is { tool, args, as? } and is checked exactly as that tool would check it.
- documentId and expectedRevision are filled in for each step (the batch's document, or the document the previous step worked on); give documentId to switch, for example "@bracket.document".
- References: a string "@name.kind" or "@name.kind[n]" is replaced by an id the step named "name" created; kind is document, sketch, feature, body, component, mate, drawing, plane or entity (sketch entities). "@name.result.path" reads a value from a read-only step's result (such as "@belt.result.centerForStandard").
- Selectors pick geometry by description when a step runs: {"$face": {...}}, {"$edge": {...}} for one, {"$faces": {...}}, {"$edges": {...}} for all that match. Fields: body, component, feature (ids or references), type (plane, cylinder, cone, sphere, torus, line, circle, ellipse, spline), normal [x,y,z] (a face's outward normal), along [x,y,z] (a line's direction, an axis, or a flat face running that way), radius, hole (true for a hole's wall), and to choose one: near [x,y,z], extreme [x,y,z] (farthest along that direction), largest. Coordinates are millimeters as the model is placed. An ambiguous single selector fails rather than guess (pieces of one surface, like the halves of a cylinder, count as one).
- atomic (default true): if a step fails, every document the batch changed returns to where it was (new documents it created are kept and listed).
Returns each step's created ids and new warnings, and the final definition status (fully, under or over defined, with mate conflicts).
Example, a plate with a hole and rounded corners: [{"tool":"create_sketch","args":{"plane":"XY"},"as":"s"},{"tool":"add_sketch_entity","args":{"sketchId":"@s.sketch","type":"rectangle","values":{"x":0,"y":0,"width":80,"height":50}}},{"tool":"extrude","args":{"sketchId":"@s.sketch","distance":6},"as":"plate"},{"tool":"create_hole","args":{"bodyId":"@plate.body","face":{"$face":{"body":"@plate.body","normal":[0,0,1],"extreme":[0,0,1]}},"frame":"origin","positions":[[0,0]],"diameter":8}},{"tool":"fillet_edges","args":{"bodyId":"@plate.body","radius":5,"edges":{"$edges":{"body":"@plate.body","type":"line","along":[0,0,1]}}}}]`,
    { documentId: id.optional(), steps: z.array(stepSchema).min(1).max(60), atomic: z.boolean().default(true) },
    false,
    async (a, s) => {
      const named = new Map<string, { document?: string; made: Partial<Record<Kind, string[]>>; result?: unknown }>();
      // Documents changed, with the history entry to go back to; documents the batch created.
      const touched = new Map<string, string>(),
        created: string[] = [];
      const results: Record<string, unknown>[] = [];
      let current: string | undefined = a.documentId;
      const resolve = (value: unknown): unknown => {
        if (typeof value === "string" && value.startsWith("@")) {
          const m = /^@([A-Za-z][A-Za-z0-9_-]{0,30})\.(document|sketch|feature|body|component|mate|drawing|plane|entity|result)(?:\[(\d+)\])?(?:\.(.+))?$/.exec(value);
          if (!m) throw Error(`Cannot read the reference ${value}; write @name.kind, @name.kind[n] or @name.result.path`);
          const step = named.get(m[1]);
          if (!step) throw Error(`No earlier step is named ${m[1]}`);
          if (m[2] === "result") {
            let out: any = step.result;
            for (const part of (m[4] ?? "").split(".").filter(Boolean)) out = out?.[/^\d+$/.test(part) ? Number(part) : part];
            if (out === undefined) throw Error(`${value} is not in that step's result`);
            return out;
          }
          if (m[2] === "document") {
            if (!step.document) throw Error(`Step ${m[1]} worked on no document`);
            return step.document;
          }
          const list = step.made[m[2] as Kind] ?? [];
          const picked = list[Number(m[3] ?? 0)];
          if (!picked) throw Error(`Step ${m[1]} made no ${m[2]}${m[3] ? ` [${m[3]}]` : ""}`);
          return picked;
        }
        if (Array.isArray(value)) return value.map(resolve);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
        return value;
      };
      const select = (value: unknown, view: () => Promise<View>): Promise<unknown> | unknown => {
        if (Array.isArray(value)) return Promise.all(value.map((v) => select(v, view)));
        if (value && typeof value === "object") {
          const keys = Object.keys(value);
          const which = keys.length === 1 ? ({ $face: ["face", false], $edge: ["edge", false], $faces: ["face", true], $edges: ["edge", true] } as Record<string, ["face" | "edge", boolean]>)[keys[0]] : undefined;
          if (which) return view().then((v) => pick(v, which[0], which[1], (value as any)[keys[0]]));
          return Promise.all(Object.entries(value).map(async ([k, v]) => [k, await select(v, view)] as const)).then(Object.fromEntries);
        }
        return value;
      };
      const rollBack = async () => {
        for (const [docId, entry] of touched) {
          const d = await store.read(docId).catch(() => undefined);
          if (d && d.history[d.historyIndex]?.id !== entry) await store.restore(docId, d.revision, entry);
        }
      };
      for (const [index, step] of a.steps.entries()) {
        const tool = tools.find((t) => t.name === step.tool);
        try {
          if (!tool || notInBatch(step.tool)) throw Error(`${step.tool} cannot run in a batch`);
          const args = resolve(step.args) as Record<string, unknown>;
          const takesDocument = "documentId" in tool.schema.shape;
          if (takesDocument && args.documentId === undefined && current) args.documentId = current;
          const docId = takesDocument ? (args.documentId as string | undefined) : undefined;
          let shown: View | undefined;
          const view = async () => (shown ??= await store.view(await store.read(docId!)));
          const ready = (await select(args, view)) as Record<string, unknown>;
          const before = docId ? await store.read(docId) : undefined;
          if (before && "expectedRevision" in tool.schema.shape && ready.expectedRevision === undefined) ready.expectedRevision = before.revision;
          if (before && !tool.readOnly && !touched.has(before.id) && !created.includes(before.id)) touched.set(before.id, before.history[before.historyIndex]?.id ?? "");
          const warnings = new Set(before ? (await view()).geometry.warnings : []);
          const result: any = await tool.handler(tool.schema.parse(ready), s);
          const resultDoc: string | undefined = result?.document?.id ?? docId;
          const after = resultDoc ? await store.read(resultDoc) : undefined;
          const made = after && !tool.readOnly ? madeBy(after.id === before?.id ? before : undefined, after) : {};
          if (after && after.id !== before?.id && !tool.readOnly) {
            made.document = [after.id];
            if (!touched.has(after.id) && !created.includes(after.id)) created.push(after.id);
          }
          if (step.as) named.set(step.as, { document: resultDoc, made, ...(tool.readOnly ? { result } : {}) });
          if (resultDoc && !tool.readOnly) current = resultDoc;
          const fresh = (result?.geometry?.warnings as string[] | undefined)?.filter((w) => !warnings.has(w)) ?? [];
          const compact = tool.readOnly && !(result?.document && result?.geometry) && JSON.stringify(result ?? null).length <= 6000 ? { result } : {};
          results.push({ step: index + 1, tool: step.tool, ...(step.as ? { as: step.as } : {}), ok: true, ...(Object.keys(made).length ? { created: made } : {}), ...(fresh.length ? { warnings: fresh } : {}), ...compact });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          results.push({ step: index + 1, tool: step.tool, ...(step.as ? { as: step.as } : {}), ok: false, error: message });
          if (a.atomic) await rollBack();
          return {
            ok: false,
            failedStep: index + 1,
            error: `Step ${index + 1} (${step.tool}): ${message}`,
            rolledBack: a.atomic,
            steps: results,
            ...(created.length ? { createdDocuments: created } : {}),
          };
        }
      }
      const final = current ? await store.view(await store.read(current)) : undefined;
      return {
        ok: true,
        steps: results,
        ...(created.length ? { createdDocuments: created } : {}),
        ...(final
          ? {
              document: { id: final.document.id, name: final.document.name, revision: final.document.revision },
              definition: definitionOf(final),
              warnings: final.geometry.warnings,
              view: final,
            }
          : {}),
      };
    },
    { ui: true },
  );
  add(
    "get_tool_schema",
    "Inspect typed CAD operations",
    "Get exact input schemas and descriptions for CAD operations before using them in run_steps. All operations remain individually validated; this does not execute code or commands.",
    { names: z.array(z.string().min(1).max(60)).min(1).max(10) },
    true,
    async (a) => ({
      tools: a.names.map((name: string) => {
        const tool = tools.find((t) => t.name === name);
        if (!tool) throw Error(`Unknown CAD operation: ${name}`);
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.schema, { target: "draft-7", io: "input" }),
        };
      }),
    }),
  );
  return tools;
}
export { summarize } from "./view-summary.ts";
import { definitionOf } from "./view-summary.ts";
