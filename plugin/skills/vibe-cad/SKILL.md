---
name: vibe-cad
description: How to build, edit and check parametric CAD in Vibe CAD (parts, assemblies, sheet metal, drawings) with its typed tools. Use when designing or changing a model in Vibe CAD.
---

# Using Vibe CAD

Vibe CAD is parametric CAD. Every tool edits the same saved model the user sees in the editor: sketches, a feature history, assemblies with mates, and drawings.

Use the installed local `vibe-cad` connection (`mcp__vibe_cad__*`). The former **Vibe CAD Development Test** app is retired. Do not call its cached `vibe_cad_development_test` tools or reopen its old viewer cards; they point to a removed service and can report “Session terminated.” Create or open a document through the local connection to display a fresh editor. If the current conversation lacks a required local tool, do not substitute the retired development app.

## The interface

- **Documents.** A part or an assembly is a document. Start with `list_documents` or `create_document`, and read one with `inspect_document`. An assembly inserts parts with `insert_component`, and each instance follows later edits to its part document.
- **Units.** All tools use millimeters and degrees, whatever the editor shows.
- **Revisions.** Edit tools take `documentId` and `expectedRevision`, the latest revision. An edit made from a stale revision is refused. A failed edit leaves the model unchanged.
- **Geometry references.** Faces and edges are ids taken from the model, through `inspect_document`, `inspect_geometry` or `inspect_selection` (what the user has selected). Never invent an id. In `run_steps`, pick geometry by description instead.
- **Large imported parts.** `inspect_geometry` returns 200 references per page. Use `kind`, exact `geomType`, and `minimumArea` filters, or follow `topologyPage.nextOffset` for more. Geometry retains its full detail; a reference page covers only part of it.
- **Results.** Results are compact summaries. Each one carries `warnings` and a `definition` block: `status` is `full`, `under` or `over`, and `notes` lists what is under-defined and any mate conflicts.

## Show the interactive editor in chat

The interactive editor is the primary user interface. Call `open_cad` with the saved document's ID to display it in a host that supports MCP Apps. Use `open_cad` once for the working assembly; `run_steps` saves edits without opening another host panel, and the existing editor follows saved changes. The editor and tools share the saved model, revisions, selection and history.

Use native Vibe CAD tools to display this resource; running an MCP client through a shell does not make the chat host render an app. Do not replace the requested interactive editor with a screenshot or an external browser. If the host has not loaded the plugin or cannot render its resource, report that specific integration gap. Local iframe verification does not prove native Codex rendering.

### Keep the working set small

Call `manage_editors` directly, outside `run_steps`. Editor lifecycle actions are independent of CAD transactions and cannot be rolled back with model edits.

Reuse one assembly editor while building linked parts. Only `open_cad` should open another editor panel; ordinary edits and `run_steps` update the existing editor through its shared document. Aim for at most five open CAD panels, never more than ten. Use `manage_editors` to list panels at least every ten tool calls and before opening another editor; use `close_others` with the working assembly documentId to retire saved, unused panels. The UI also provides Close editor and Close other editors. Drafts are protected, and retired editors dispose their renderer and request host teardown. A close request is not confirmed closure: `closed` requires the host teardown callback. Unresponsive sessions remain listed instead of silently expiring. Request `reload` for a responsive editor only. A dead native renderer cannot receive a plugin command. If a gray sad-face tab appears, immediately instruct the user to close its Open CAD editor tab with ×, then reopen the saved assembly once. If tools also report Transport closed or the replacement crashes, restart Codex and reopen; reinstalling is unnecessary for a view crash. Use `forget` only after the user confirms closing that host tab, with `confirmHostClosed:true`; it removes the stale record and does not close anything. Do not open every part just to inspect it.

Prefer simple fastener solids and single-sketch landscape layers. Avoid detailed threads unless needed for an interface. Never repeatedly launch whole-assembly booleans after the kernel reports a timeout. Use scoped checks, inspected dimensions and explicitly stated validation limits.

Use `control_build` to inspect, pause, resume or stop an active batch. Pause becomes effective at a step boundary; Stop keeps committed steps and cancels the current kernel operation. After manual edits during a pause, inspect the current revision and re-plan; do not replay the old plan over the user's edits. Move part and Rotate part project each drag through the actual mates using cached topology, including linear sliders, rotations, planar movement, coupled followers and limits. No extra hidden joint constrains the model.

Treat incoming user messages as steering of the current design. Use short batches of at most ten operations when the user is actively co-designing, inspect the current revision after steering, and avoid starting a long batch immediately after a correction. The host controls chat delivery: Settings > General > Follow-up behavior > Steer sends messages into the current run; a plugin cannot change Queue into Steer. Pause/Stop in the editor remains available while a kernel operation is running; Pause waits for a step boundary.

Current `.edit` exports retain the feature tree and current linked parts by default; obsolete undo states are omitted. Set `includeHistory` only for an explicitly needed history archive. Undo is bounded to 24 entries and a memory budget. Use `compact_storage` with a specific root assembly and explicit candidate document IDs to preview cleanup, then apply cleanup within the user's authorized scope. Preserve other projects and their references. Do not rewrite Git history or delete unrelated library parts. Generated caches and local history belong outside version control. Preserve the directory referenced by the local marketplace source.path, even when it is under dist; it is the plugin source required for reloads.

View convention: Y is up, Front is XY viewed from +Z, Top is XZ viewed from +Y. Mathematical sketch planes and existing feature geometry are unchanged.

## Fast edits and sculpted artwork

Start with `engine_info` after a plugin update. An installed package does not update an already running stdio process. Reload refreshes the saved model inside the current editor; it does not navigate or replace the host frame. Retired renderers release their live-editor lease, while host closure still requires its own acknowledgement. A gray sad-face panel is a host renderer crash, not a normal CAD validation error. Do not keep opening replacement panels. Check the active runtime, retire unused editors, and verify recovery in the native host; a browser-only test cannot prove a host crash is fixed. Do not treat camera/selection acknowledgements or inspection summaries as geometry updates or advance a cached geometry revision from metadata alone.

Use `inspect_design` for lightweight authoritative JSON: sketches, dimensions, variables, features, placements and mates, without meshes, imported bytes or undo copies. Request current linked designs only when useful. Use `edit_design` to replace an existing sketch or change many numeric parameters/variables/poses atomically with one solve/rebuild. Feature IDs remain stable; invalid edits preserve the previous revision. Use ordinary typed tools to create features and actual geometry selectors to pick topology. Never edit saved CAD files through a shell.

Entity IDs are unique across the entire document, including different sketches. Prefix generated IDs by sketch. Stop dependent work when a batch fails: IDs reported by rolled-back steps are invalid. Return compact result summaries, never full meshes or base64 file contents.

`validate_design` tests JSON without saving. Structure validation checks equations and sketch definition without OCCT; it explicitly does not certify assembly mates. Geometry validation rebuilds actual solids and reports mate conflicts and definition. Do not equate schema-valid JSON with a physically correct assembly or interference-free motion.

Fixed points and fixed entities are available through sketch constraints. Use them sparingly for functional designs: fixing an origin or reference datum is useful, but mating holes, slots, tab dimensions, clearances and mechanical profiles should use driving dimensions, variables and geometric relations. Do not blanket-fix functional components just to silence under-definition.

For decorative illustrations such as the Yosemite silhouettes, set the sketch purpose to artwork and explicitly freeze the outline with edit_design. This keeps organic curves without hundreds of meaningless dimensions. Separate dimensioned mounting/tab/slot geometry from the artwork. Prefer native smooth splines/arcs and a compact set of intentional contours over thousands of traced micro-segments or repeated stock symbols. Fixed artwork supports up to 600 entities; this is a ceiling, not a target. Review feature widths and webs against the chosen sheet stock. Keep each landscape layer as one connected manufactured part.

Use direct assembly dragging for live motion, or Evaluate > Motion for play/pause and scrubbing over an optional 24-hour cycle. Mates and travel limits stay active. Rigid frames use cached topology and GPU matrices, without kernel rebuilding, geometry transfers or saved revisions per frame; releasing a drag commits one validated placement edit. Do not turn interactive motion into repeated `capture_view` calls or a video. Clearance checking is an explicit separate action, not an automatic playback operation. Geometry that actually deforms, such as a changing belt or an in-context sketch, needs a parametric geometry update and is not eligible for rigid playback. Kinematic gear mates do not add a physical gearbox: represent actual reduction hardware in the assembly/BOM and check torque, backlash and the motor drive schedule when required.

## Build with `run_steps`

Before fabricating detailed sheet artwork, run `check_sheet_features` for each cut body with the supplier's minimum web and cut-gap widths. Evaluate > Minimum Features exposes the same explicit check. It uses bounded sampling of cached edges, reports approximate widths, actual edge references, disconnected material regions and uncertainty, and never edits the part. Its no-narrow-features result is a screening result, not a certified global minimum or supplier approval. Review reported slivers, narrow necks and gaps; do not automatically erase meaningful details. Use smooth arcs with bounded fitting error for narrow artwork: unconstrained interpolating splines can overshoot and create fragile slivers or detached islands. Keep dimensioned tabs, slots and mounting geometry separate. Native kernel validation already rejects zero-volume and invalid native feature results; imported or unsupported geometry requires separate review.

Use `run_steps` for any sequence of operations: one request instead of many calls or screenshots.

The model's direct tool list intentionally contains the main document, editor, sketch, build, inspection and export tools. The editor has every typed operation. For specialist operations listed below, request their exact schemas with `get_tool_schema`, then use their names and validated arguments in `run_steps`. An operation absent from the direct list is still usable through the batch. Never fall back to a shell or the retired development app.

- **Steps.** Each step is `{ "tool", "args", "as" }`. Editor lifecycle, build control, storage cleanup, history, preview and git commands run separately.
- **Filled in for you.** Each step gets `documentId` and `expectedRevision` automatically. Give `documentId` (such as `"@bracket.document"`) to work on another document.
- **References.** `"@name.kind"` is an id an earlier step named `name` created. kind is `document`, `sketch`, `feature`, `body`, `component`, `mate`, `drawing`, `plane` or `entity`; add `[n]` for the nth. `"@name.result.path"` reads a value from a read-only step's result.
- **Selectors.** `{"$face": {...}}` or `{"$edge": {...}}` picks one; `{"$faces": {...}}` or `{"$edges": {...}}` picks every match.
  - Filters: `body`, `component`, `feature`, `type` (plane, cylinder, line, circle, …), `normal`, `along`, `radius`, `hole`.
  - Choose one of several with `near`, `extreme` (farthest along a direction) or `largest`.
  - A selector that matches more than one item fails; it never guesses.
- **Rollback.** If a step fails, the documents it changed go back to how they were (`atomic`, on by default).

```json
{"steps": [
  {"tool": "create_sketch", "args": {"plane": "XY"}, "as": "s"},
  {"tool": "add_sketch_entity", "args": {"sketchId": "@s.sketch", "type": "rectangle", "values": {"x": 0, "y": 0, "width": 80, "height": 50}}},
  {"tool": "extrude", "args": {"sketchId": "@s.sketch", "distance": 6}, "as": "plate"},
  {"tool": "create_hole", "args": {"bodyId": "@plate.body", "face": {"$face": {"body": "@plate.body", "normal": [0, 0, 1], "extreme": [0, 0, 1]}}, "frame": "origin", "positions": [[-25, 0], [25, 0]], "diameter": 8}},
  {"tool": "fillet_edges", "args": {"bodyId": "@plate.body", "radius": 5, "edges": {"$edges": {"body": "@plate.body", "type": "line", "along": [0, 0, 1]}}}}
]}
```

## Look at the model with `capture_view`

`capture_view` returns PNG pictures of the model, without screenshots or computer use.

- **Angles:** `views` takes named angles (`iso`, `front`, `back`, `top`, `bottom`, `left`, `right`, `dimetric`, `trimetric`) or `{"direction": [x, y, z]}`, the direction from the model toward the eye. Up to six per call.
- **Framing:** `focus` frames given components or bodies, `only` shows just them, and `transparent` makes some see-through. `style` draws the picture shaded, as hidden lines or as wireframe.
- **Highlighting:** `highlight` colors components, bodies, faces or edges. Highlighting a mate id colors its moving geometry and its target in two colors.
- **Conflicts:** they are marked by default: each flagged mate's faces, and the parts it over-defines.
- **Legend:** the result's `legend` says what each color means.

Use `capture_view` to inspect geometry or provide a static image. Keep the interactive editor available for the user's own inspection and edits.

## Tools by area

- **Sketch:** `create_sketch`, `add_sketch_entity`, `edit_sketch`, `add_sketch_constraint`, `set_dimension`, `set_variable` (equations).
- **Features:** `extrude`, `revolve`, `sweep`, `loft`, `create_hole`, `fillet_edges`, `chamfer_edges`, `shell_body`, `draft_faces`, `create_rib`, `create_linear_pattern`, `create_circular_pattern`, `mirror_body`, `boolean_bodies`, `split_body`, `move_face`, `create_thread`, `create_gear`, `create_pulley`, `create_reference_plane`.
- **Sheet metal:** `create_base_flange`, `create_edge_flange`, `create_hem`, `create_sketched_bend`, `create_closed_corner`, `flat_pattern`.
- **Weldments:** `create_structural_member`, `create_weld_bead`, `cut_list`.
- **Files:** `import_vendor_part` (direct HTTPS STEP/STL URL), `import_part` (supplied base64 bytes as a new part), `import_step`, `import_stl`, `export_file`, `export_face_dxf`.
- **Assembly:**
  - Placing parts: `insert_component`, `add_mate` (including gear mates), `edit_mate`, `set_component_transform`, `set_component_grounded`, `pattern_component`.
  - Generated parts: `create_belt`, `create_hole_series`.
  - Display: `set_appearance` (color, texture and transparency), `set_display_style` (a part's own display mode, such as wireframe), `set_visibility` (hide or show), `set_component_suppressed`.
- **Checks:**
  - Assembly: `check_definition`, `inspect_assembly` (mate states and BOM), `check_interference`, `check_motion` (also sweeps linkages).
  - Part: `mass_properties`, `measure`.
- **Drawings:** `create_drawing`, `add_drawing_view`, `add_drawing_dimension` (including ordinate), `add_drawing_annotation` (including weld symbols), `render_drawing`, `export_drawing`.
- **History:** `undo`, `redo`, `restore_history`; the `git_*` tools when the workspace is a git project.

## Definition and mate conflicts

- **Sketches.** A sketch with degrees of freedom left is under-defined. Add dimensions or relations until `check_definition` reports it fully defined.
- **Assembly parts.** Actual mates determine all motion. Use `set_component_motion` to declare the intended remaining DOF count; this declaration adds no constraint. A mechanism is fully defined when the measured DOF count matches the declared intent, while preserving that motion. Extra or missing freedoms remain a failed definition check. Do not declare arbitrary freedoms to hide incomplete mates.
- **Travel limits.** `limitDistance` bounds signed travel along the target plane normal/axis in mm; `limitAngle` bounds signed relative rotation about cylindrical/circular axes in degrees (-180 to 180). Both require min < max, and limit mates do not consume the permitted DOF at a stop. Use geometry mates to define a slider/hinge first; limits alone do not locate it. Unbounded continuous rotation needs no angle-limit mate.
- **Over-defining mates.** A mate that over-defines a part is flagged `over` and left unsolved, and its message names the mates it conflicts with. Delete or change one of them.
- **Broken mates.** A mate whose geometry is gone is flagged `error`. Re-pick its faces.
- **Understanding a conflict.** `check_definition` describes each flagged mate:
  - its type and value;
  - `residual`, how far it is from being met (mm, or radians for a direction);
  - its `moving` and `target` geometry: which part, what kind of face or edge, where it is, and which way it points or runs.

  `capture_view` shows the same conflict marked in red.

## Recommendation

When an assembly uses off-the-shelf parts (motors, bearings, wheels, fasteners, batteries, electronics), first check whether the manufacturer or a supplier offers an accessible STEP or STL file. Import a direct public HTTPS file URL with `import_vendor_part`, then `insert_component`. The plugin downloads and transfers the original file; do not generate base64 in the conversation or put a URL into a bytes parameter. For an authorized local or prepared STEP/STL file, use `import_part` with `localPath` (absolute path, up to32MiB) and omit `data`; preserve source attribution with `sourceUrl`. Do not encode large CAD files into chat/tool arguments. `import_part` also accepts actual supplied bytes. Design an explicitly labeled dimensional envelope only when no file is readily available; an envelope is not vendor CAD.

Inspect imported shaft/bore diameters, mounting holes and faces before selecting interfaces. Similar outside dimensions do not prove that two vendors' wheel/hub systems fit. Ground a stable chassis reference and use actual geometry with `add_mate` for mechanically related components; fixed placements alone are not a verified mechanical connection. `auto_explode` can separate grounded components visually without changing assembled positions, grounding, mates, measurements or exports.
