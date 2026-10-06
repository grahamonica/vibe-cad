export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** spline: a smooth curve through fit points x0,y0 … x{n-1},y{n-1}. */
export type EntityType = "rectangle" | "circle" | "line" | "arc" | "point" | "spline";
export interface Entity {
  id: string;
  type: EntityType;
  construction: boolean;
  values: Record<string, number>;
  /** Converted model edge: the entity follows this edge's projection on every rebuild. */
  projected?: TopologyRef;
}
export type ConstraintType =
  | "horizontal"
  | "vertical"
  | "coincident"
  | "distance"
  | "length"
  | "angle"
  | "equal"
  | "parallel"
  | "perpendicular"
  | "collinear"
  | "concentric"
  | "tangent"
  | "midpoint"
  | "pointOn"
  | "symmetric"
  | "fixed"
  | "dimension"
  | "radius"
  | "diameter"
  /** Copies at a distance from their sources: entityIds pair each source with its copy. */
  | "offset"
  /** Copies repeated along a direction or around a center; see Constraint.pattern. */
  | "pattern";
export interface Constraint {
  id: string;
  type: ConstraintType;
  entityIds: string[];
  anchors?: string[];
  value?: number;
  dimension?: string;
  axis?: "x" | "y";
  reference?: number[];
  /** Dimension label position in sketch coordinates. */
  label?: Vec2;
  /** Reference (driven) dimension: displayed, never enforced. */
  driven?: boolean;
  /**
   * Sketch pattern layout. entityIds are [center (circular only), sources…,
   * then each instance's copies in source order]. value is the spacing (linear)
   * or the total angle in degrees (circular).
   */
  pattern?: { kind: "linear" | "circular"; count: number; sources: number; angle?: number };
  /** Equation driving the value, e.g. `width / 2`; the value is recomputed on every edit. */
  expression?: string;
}
export interface Sketch {
  id: string;
  name: string;
  plane: "XY" | "XZ" | "YZ";
  origin: Vec3;
  support?: TopologyRef;
  referencePlaneId?: string;
  /** Face sketches: "origin" projects the part origin onto the face (stable when
   * the face grows); legacy sketches use the face centroid. */
  frameMode?: "origin" | "face-center";
  hidden?: boolean;
  entities: Entity[];
  constraints: Constraint[];
  solver: {
    dof: number;
    residual: number;
    status: "under-constrained" | "fully-constrained";
    redundant?: number;
    /** Entities that can still move (not fully defined). */
    free?: string[];
  };
}
export type FeatureType =
  | "extrude"
  | "revolve"
  | "loft"
  | "sweep"
  | "hole"
  | "fillet"
  | "chamfer"
  | "pattern"
  | "mirror"
  | "boolean"
  | "shell"
  | "draft"
  | "split"
  | "scale"
  | "transform"
  /** A solid imported from a STEP or STL file stored by content hash. */
  | "import"
  /** A rib grown from an open sketch profile to the part, parallel to its sketch plane. */
  | "rib"
  /** Direct edit: planar faces offset along their normals (positive adds material). */
  | "moveFace"
  /** A thread on a cylindrical face: cosmetic (no geometry) or a modeled helical groove. */
  | "thread"
  /** A generated involute spur gear body. */
  | "gear"
  /** A generated timing pulley body (GT2 or HTD). */
  | "pulley"
  /** Sheet metal bent along a sketch line (folded armor, wedges). */
  | "bend"
  /** Sheet metal closed corner: two flanges' walls carried across their corner gap. */
  | "corner"
  /** A weldment structural member: a profile along one sketch line, corners cut against its group. */
  | "member"
  /** Fillet weld beads along inside corner edges. */
  | "weld"
  /** Sheet metal base flange: a closed sketch at the sheet thickness, with bend defaults. */
  | "sheet"
  /** Sheet metal edge flange: a bend and wall along a straight edge of the sheet. */
  | "flange";
export interface TopologyRef {
  bodyId: string;
  id: string;
  kind: "face" | "edge";
  signature?: number[];
  geomType?: string;
  semantic?: string;
  point?: Vec3;
}
export interface Feature {
  id: string;
  name: string;
  type: FeatureType;
  bodyId: string;
  params: Record<string, any>;
  suppressed: boolean;
  intent?: string;
  /** Equations driving numeric parameters, by parameter name. */
  expressions?: Record<string, string>;
}
/** A document variable; dimensions bound to expressions that use it follow its value. */
export interface Variable {
  name: string;
  expression: string;
  /** Last evaluated value (mm or degrees). */
  value: number;
  description?: string;
}
export interface Body {
  /** Use surface colors from the original STEP until appearance is overridden. */
  importAppearance?: boolean;
  id: string;
  name: string;
  color: string;
  hidden: boolean;
  /** 1 is opaque; lower is see-through (SolidWorks' transparency). */
  opacity?: number;
  /** Display mode of this body; the view's display style when absent. */
  style?: DisplayStyle;
  texture?: Texture;
  componentId?: string;
}
/** SolidWorks' display styles: Shaded With Edges, Shaded, Hidden Lines Removed, Hidden Lines Visible, Wireframe. */
export type DisplayStyle = "shaded-edges" | "shaded" | "hidden-removed" | "hidden-visible" | "wireframe";
/** Procedural appearance textures (display only), tinted by the color. */
export type Texture = "brushed-metal" | "carbon-fiber" | "diamond-plate" | "wood";
/** How a component is shown: its own appearance over its parts' colors, transparency, display mode, hidden. */
export interface ComponentDisplay {
  color?: string;
  opacity?: number;
  style?: DisplayStyle;
  texture?: Texture;
  hidden?: boolean;
}
export interface DesignIntent {
  id: string;
  text: string;
  kind: "hard" | "soft";
  featureId?: string;
  dimension?: string;
  min?: number;
  max?: number;
}
/** A planar reference: principal plane (with optional offset), saved datum plane or planar model face. */
export type PlaneRef =
  | { kind: "principal"; plane: "XY" | "XZ" | "YZ"; offset?: number }
  | { kind: "reference"; planeId: string }
  | { kind: "face"; ref: TopologyRef };
/** An axis: principal axis, straight/circular edge, cylindrical face, sketch line or explicit line. */
export type AxisRef =
  | { kind: "principal"; axis: "X" | "Y" | "Z" }
  | { kind: "edge"; ref: TopologyRef }
  | { kind: "face"; ref: TopologyRef }
  | { kind: "sketch"; sketchId: string; entityId: string }
  | { kind: "custom"; origin: Vec3; direction: Vec3 };
export type PlaneDefinition =
  | { kind: "offset"; base: PlaneRef; distance: number; flip?: boolean }
  | { kind: "angle"; base: PlaneRef; axis: AxisRef; angle: number }
  | { kind: "midplane"; a: PlaneRef; b: PlaneRef }
  | { kind: "three-point"; points: [Vec3, Vec3, Vec3] }
  | { kind: "normal-to-edge"; edge: TopologyRef; position: number };
export interface ReferencePlane {
  id: string;
  name: string;
  /** Legacy principal-plane form; also used when no definition is present. */
  plane: "XY" | "XZ" | "YZ";
  origin: Vec3;
  definition?: PlaneDefinition;
  hidden?: boolean;
}
/** Orthonormal placement of a sketch or datum plane in world coordinates. */
export interface Frame {
  origin: Vec3;
  xDir: Vec3;
  yDir: Vec3;
  normal: Vec3;
}
export interface Component {
  id: string;
  name: string;
  /** Bodies of this document that move together. Empty for an inserted part. */
  bodyIds: string[];
  /**
   * Another document inserted as a part instance. Its visible bodies appear in
   * this document as `${component id}/${body id}` and follow the part's edits.
   */
  source?: { documentId: string };
  /**
   * A timing belt generated over two pulley components: built where the
   * solved assembly puts the pulleys, so it follows them. Its body is
   * `${component id}/belt`, named for ordering.
   */
  belt?: { pulleys: [string, string]; width?: number };
  display?: ComponentDisplay;
  /** Suppressed, as in SolidWorks: left out of the model, its mates, mass, BOM and checks until restored. */
  suppressed?: boolean;
  grounded: boolean;
  position: Vec3;
  rotation: Vec3;
  explode: Vec3;
}
/**
 * Repeated instances of an inserted part, placed from the solved source
 * component along a direction or about an axis. Instance k (1 … count−1) is
 * the derived component `${id}~${k}`.
 */
export interface ComponentPattern {
  id: string;
  name: string;
  componentId: string;
  kind: "linear" | "circular";
  count: number;
  /** Linear: direction and step in mm; directionRef (a straight edge or an axis) overrides the vector. */
  direction?: Vec3;
  directionRef?: TopologyRef;
  spacing?: number;
  /** Circular: axis, or axisRef (a circular edge or cylindrical face); total angle in degrees, 360 spreads evenly. */
  axis?: { origin: Vec3; direction: Vec3 };
  axisRef?: TopologyRef;
  angle?: number;
}
export interface Mate {
  id: string;
  name: string;
  type:
    | "coincident"
    | "distance"
    | "parallel"
    | "perpendicular"
    | "concentric"
    | "tangent"
    | "angle"
    | "lock"
    | "gear";
  moving: TopologyRef;
  target: TopologyRef;
  /** Distance (mm), angle (degrees) or, for gear mates, turns of the moving part per turn of the target. */
  value: number;
  /** Gear mates: the parts turn the same way (an internal gear, or pulleys on one belt). */
  aligned: boolean;
  suppressed: boolean;
  /** Gear mates: the moving part's turn when the target is at zero (degrees), so the teeth keep meshing. */
  phase?: number;
}
/** A model point used by drawing dimensions: an edge end/middle/center or a whole edge. */
export interface DrawingPoint {
  ref: TopologyRef;
  anchor?: "start" | "end" | "mid" | "center" | "edge";
}
export interface DrawingTolerance {
  kind: "symmetric" | "bilateral" | "limits";
  upper: number;
  lower?: number;
}
export interface DrawingDimension {
  id: string;
  /** Drawing view id (legacy sheets use front/top/right). */
  view: string;
  /** Legacy axis-aligned dimension fields. */
  axis?: "horizontal" | "vertical";
  offset?: number;
  kind?: "diameter" | "radius";
  reference?: TopologyRef;
  refs?: [TopologyRef, TopologyRef];
  /**
   * Typed dimension (new). An ordinate dimension measures every point after
   * the first from the first (the zero) along `axis`, values on one row.
   */
  type?: "horizontal" | "vertical" | "aligned" | "radius" | "diameter" | "angle" | "hole" | "ordinate";
  points?: DrawingPoint[];
  /** Text position relative to the view center, sheet millimeters. */
  position?: Vec2;
  tolerance?: DrawingTolerance;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Replaces the measured text (still associative for position). */
  text?: string;
}
export type SheetSize = "A4" | "A3" | "A2" | "A1" | "A0" | "ANSI A" | "ANSI B" | "ANSI C" | "ANSI D";
export type ViewOrientation = "front" | "back" | "top" | "bottom" | "left" | "right" | "iso" | "dimetric" | "trimetric";
export interface DrawingView {
  id: string;
  name: string;
  /** flat: the unfolded blank of a sheet metal body, with its bend lines. */
  kind: "base" | "projected" | "section" | "detail" | "flat";
  orientation?: ViewOrientation;
  /** flat views: the sheet metal body to unfold. */
  bodyId?: string;
  parentId?: string;
  /** Sheet position of the view center, millimeters. */
  position: Vec2;
  /** View scale; defaults to the sheet scale (detail views keep their own). */
  scale?: number;
  hiddenLines?: boolean;
  tangentEdges?: boolean;
  showLabel?: boolean;
  /** Section cut line in the parent view's model plane (mm). */
  section?: { a: Vec2; b: Vec2; label: string; flip?: boolean };
  /** Detail circle in the parent view's model plane (mm). */
  detail?: { center: Vec2; radius: number; label: string };
  /** Show the assembly exploded. */
  exploded?: boolean;
}
export type DrawingAnnotation =
  | { id: string; type: "note"; position: Vec2; text: string; size?: number; leader?: { view: string; ref: TopologyRef } }
  | { id: string; type: "balloon"; view: string; ref: TopologyRef; position: Vec2; item?: number }
  | { id: string; type: "bom"; position: Vec2 }
  | { id: string; type: "centermark"; view: string; ref: TopologyRef }
  | { id: string; type: "centerline"; view: string; refs: [TopologyRef, TopologyRef] }
  | { id: string; type: "surface"; view: string; ref: TopologyRef; position: Vec2; roughness: string }
  | { id: string; type: "datum"; view: string; ref: TopologyRef; position: Vec2; label: string }
  | {
      id: string;
      type: "weld";
      view: string;
      /** The joint the arrow points to. */
      ref: TopologyRef;
      /** Where the reference line starts (sheet mm). */
      position: Vec2;
      /** Fillet leg size; read from the weld bead when the arrow points at one. */
      leg?: number;
      /** Weld length; omitted for the joint's full length. */
      length?: number;
      /** Arrow side (below the reference line), other side (above) or both. */
      sides?: "arrow" | "other" | "both";
      allAround?: boolean;
      field?: boolean;
      /** Process or specification in the tail, e.g. GMAW. */
      process?: string;
    }
  | {
      id: string;
      type: "gdt";
      view: string;
      ref: TopologyRef;
      position: Vec2;
      characteristic: "flatness" | "straightness" | "circularity" | "cylindricity" | "parallelism" | "perpendicularity" | "angularity" | "position" | "concentricity" | "symmetry" | "profile" | "runout";
      tolerance: number;
      diametral?: boolean;
      datums?: string[];
    };
export interface DrawingSheet {
  id: string;
  name: string;
  bodyIds: string[];
  size: SheetSize;
  orientation?: "landscape" | "portrait";
  scale: number;
  projection: "first" | "third";
  hiddenLines: boolean;
  title: string;
  author: string;
  material: string;
  drawingNumber: string;
  company?: string;
  revisionLabel?: string;
  checkedBy?: string;
  approvedBy?: string;
  date?: string;
  finish?: string;
  generalTolerance?: string;
  /** Explicit views; legacy sheets without views get front, top, right and isometric. */
  views?: DrawingView[];
  dimensions: DrawingDimension[];
  annotations?: DrawingAnnotation[];
}
export interface DrawingEdge {
  ref: TopologyRef;
  /** Polyline in sheet millimeters. */
  points: Vec2[];
  visible: boolean;
  circle?: { center: Vec2; radius: number };
}
export interface DrawingProjection {
  /** View id (legacy: front/top/right/iso). */
  name: string;
  id?: string;
  label?: string;
  kind?: DrawingView["kind"];
  bounds: [number, number, number, number];
  measureBounds: [number, number, number, number];
  circles: { reference: TopologyRef; center: Vec2; radius: number }[];
  /** Sheet mapping: sheet = origin + scale * (u, -v) for model-plane coords (u, v). */
  scale?: number;
  origin?: Vec2;
  xAxis?: Vec3;
  yAxis?: Vec3;
  direction?: Vec3;
  edges?: DrawingEdge[];
}
export interface Placement {
  position: Vec3;
  quaternion: [number, number, number, number];
}
/**
 * The part's material, copied in full so the document stands alone: density in
 * g/cm³, modulus in GPa, strengths in MPa. Printed parts carry their infill (%)
 * and wall thickness (mm).
 */
export interface PartMaterial {
  name: string;
  density: number;
  category?: string;
  modulus?: number;
  yield?: number;
  tensile?: number;
  poisson?: number;
  printed?: boolean;
  infill?: number;
  wall?: number;
}
export interface Snapshot {
  name: string;
  sketches: Sketch[];
  features: Feature[];
  bodies: Body[];
  intents: DesignIntent[];
  referencePlanes?: ReferencePlane[];
  components?: Component[];
  mates?: Mate[];
  componentPatterns?: ComponentPattern[];
  drawings?: DrawingSheet[];
  /** Part material; density in g/cm³ gives body mass. */
  material?: PartMaterial;
  /** Units the editor and drawings show; geometry and tools always use millimeters. */
  units?: "mm" | "in";
  /** Global variables for equations. */
  variables?: Variable[];
  /** Known mass of the whole part in grams (purchased parts); overrides the material's density. */
  massOverride?: number;
  /** Weight limit in grams (a robot's weight class), checked by mass properties. */
  weightLimit?: number;
  selection: TopologyRef[];
  viewport?: { position: Vec3; target: Vec3 };
}
export interface HistoryEntry {
  id: string;
  revision: number;
  at: string;
  description: string;
  source: "user" | "assistant";
  snapshot: Snapshot;
}
export interface Document extends Snapshot {
  id: string;
  owner: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  history: HistoryEntry[];
  historyIndex: number;
  /** Documents inserted as components, attached for the kernel and never saved. */
  linked?: Record<string, Document>;
  /** Imported files by content hash, attached for the kernel and never saved. */
  blobs?: Record<string, Uint8Array>;
}
export interface Topology {
  id: string;
  bodyId: string;
  kind: "face" | "edge";
  geomType: string;
  signature: number[];
  center: Vec3;
  normal?: Vec3;
  length?: number;
  radius?: number;
  area?: number;
  /** Axis of circular edges, straight edges and cylindrical faces. */
  axis?: { origin: Vec3; direction: Vec3 };
  /** A cylindrical or conical face that faces its axis: a hole's wall. */
  concave?: boolean;
  /** Start and end points of edges. */
  endpoints?: [Vec3, Vec3];
  label: string;
  featureId?: string;
}
export interface RenderBody {
  id: string;
  name: string;
  color: string;
  hidden: boolean;
  /** Below 1 the body is drawn see-through. */
  opacity?: number;
  /** Its own display mode, over the view's display style. */
  style?: DisplayStyle;
  texture?: Texture;
  /** Edges where two faces meet smoothly (topology ids), hidden when tangent edges are turned off. */
  tangentEdges?: string[];
  mesh: {
    vertices: number[];
    normals: number[];
    triangles: number[];
    faceGroups: { start: number; count: number; faceId: number; id: string; color?: string }[];
  };
  edges: {
    lines: number[];
    edgeGroups: { start: number; count: number; edgeId: number; id: string }[];
  };
  topology: Topology[];
  bounds: [Vec3, Vec3];
  volume: number;
  surfaceArea: number;
  centerOfMass: Vec3;
  /** Grams, when the part has a material. */
  mass?: number;
  material?: string;
  /** Principal moments of inertia in g·mm², smallest first, when the part has a material. */
  inertia?: [number, number, number];
  /** Inertia tensor about the center of mass in document axes (xx, yy, zz, xy, yz, xz; g·mm²). */
  inertiaTensor?: [number, number, number, number, number, number];
  /** Threads on this body's cylindrical faces, placed like the body. */
  threads?: ThreadRecord[];
  /** A spur gear or timing pulley body: its teeth for gear mate ratios, and a gear's size for checking its mesh. */
  drive?: { teeth: number; module?: number; width?: number; backlash?: number };
  /** Where the mass comes from: the material's density or a typed-in part mass. */
  massSource?: "material" | "override";
}
/** A thread on a cylinder: from origin along direction for length, at the face radius. */
export interface ThreadRecord {
  bodyId: string;
  featureId: string;
  faceId: string;
  label: string;
  origin: Vec3;
  direction: Vec3;
  /** Radius of the threaded cylinder: the major diameter on a shaft, the tap drill in a hole. */
  radius: number;
  /** Nominal (major) diameter. */
  diameter: number;
  length: number;
  pitch: number;
  internal: boolean;
  modeled: boolean;
  /** The thread runs the whole cylinder, so both ends are thread ends. */
  through: boolean;
  leftHand?: boolean;
}
export interface Geometry {
  bodies: RenderBody[];
  warnings: string[];
  placements?: Record<string, Placement>;
  /** World placement of every sketch and datum plane, for in-place editing. */
  frames?: { sketches: Record<string, Frame>; planes: Record<string, Frame> };
  /** Solved entity values of sketches whose converted edges were re-projected. */
  sketchUpdates?: Record<string, Record<string, Record<string, number>>>;
  /** Each mate's state: met, over-defining (left unsolved) or unusable, as SolidWorks flags them. */
  mateStatus?: Record<string, { status: "ok" | "over" | "error"; message?: string; residual?: number }>;
  /** Each component's definition: (f) fixed, (-) under-defined with its remaining freedom, fully defined, (+) over-defined. */
  componentStatus?: Record<string, { status: "fixed" | "under" | "full" | "over"; dof: number }>;
}
export interface Preview {
  id: string;
  description: string;
  baseRevision: number;
  geometry: Geometry;
  snapshot: Snapshot;
}
export interface View {
  document: Document;
  geometry: Geometry;
  preview?: Omit<Preview, "snapshot">;
}
/** Whether a body belongs to a component: one of its bodies, or a body of its inserted part. */
export const componentOwns = (c: Component, bodyId: string) =>
  c.bodyIds.includes(bodyId) || ((!!c.source || !!c.belt) && bodyId.startsWith(`${c.id}/`));
/** A derived instance of a component pattern. */
export type ComponentInstance = Component & { patternOf?: { patternId: string; k: number } };
/** Every component, with each component pattern's derived instances after the originals. */
export function allComponents(doc: Pick<Document, "components" | "componentPatterns">): ComponentInstance[] {
  const list: ComponentInstance[] = [...(doc.components ?? [])];
  for (const p of doc.componentPatterns ?? []) {
    const c = doc.components?.find((x) => x.id === p.componentId);
    if (!c?.source) continue;
    for (let k = 1; k < p.count; k++)
      list.push({ ...c, id: `${p.id}~${k}`, name: `${c.name} · ${k + 1}`, grounded: false, patternOf: { patternId: p.id, k } });
  }
  return list;
}
/** The component a body belongs to, pattern instances included. */
export const componentOf = (doc: Pick<Document, "components" | "componentPatterns">, bodyId: string) =>
  allComponents(doc).find((c) => componentOwns(c, bodyId));
export function snapshot(doc: Document): Snapshot {
  const {
    name,
    sketches,
    features,
    bodies,
    intents,
    selection,
    viewport,
    referencePlanes,
    components,
    mates,
    componentPatterns,
    drawings,
    material,
    units,
    variables,
    massOverride,
    weightLimit,
  } = doc;
  return structuredClone({
    name,
    sketches,
    features,
    bodies,
    intents,
    selection,
    viewport,
    referencePlanes: referencePlanes ?? [],
    components: components ?? [],
    mates: mates ?? [],
    componentPatterns: componentPatterns ?? [],
    drawings: drawings ?? [],
    ...(material ? { material } : {}),
    ...(units ? { units } : {}),
    ...(variables?.length ? { variables } : {}),
    ...(massOverride !== undefined ? { massOverride } : {}),
    ...(weightLimit !== undefined ? { weightLimit } : {}),
  });
}
