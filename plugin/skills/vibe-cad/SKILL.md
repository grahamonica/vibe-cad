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
- **Results.** Results are compact summaries. Each one carries `warnings` and a `definition` block: `status` is `full`, `under` or `over`, and `notes` lists what is under-defined and any mate conflicts.

## Show the interactive editor in chat

The interactive editor is the primary user interface. Call `open_cad` with the saved document's ID to display it in a host that supports MCP Apps. `run_steps` also declares the editor resource and delivers its final document to the embedded editor. The editor and tools share the saved model, revisions, selection and history.

Use native Vibe CAD tools to display this resource; running an MCP client through a shell does not make the chat host render an app. Do not replace the requested interactive editor with a screenshot or an external browser. If the host has not loaded the plugin or cannot render its resource, report that specific integration gap. Local iframe verification does not prove native Codex rendering.

## Build with `run_steps`

Use `run_steps` for any sequence of operations: one request instead of many calls or screenshots.

The model's direct tool list intentionally contains the main document, editor, sketch, build, inspection and export tools. The editor has every typed operation. For specialist operations listed below, request their exact schemas with `get_tool_schema`, then use their names and validated arguments in `run_steps`. An operation absent from the direct list is still usable through the batch. Never fall back to a shell or the retired development app.

- **Steps.** Each step is `{ "tool", "args", "as" }`, and any tool except history, preview and git tools can be a step.
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
- **Assembly parts.** Parts are shown as fixed, under-defined (with their degrees of freedom), fully defined or over-defined. A linkage is meant to keep one degree of freedom.
- **Over-defining mates.** A mate that over-defines a part is flagged `over` and left unsolved, and its message names the mates it conflicts with. Delete or change one of them.
- **Broken mates.** A mate whose geometry is gone is flagged `error`. Re-pick its faces.
- **Understanding a conflict.** `check_definition` describes each flagged mate:
  - its type and value;
  - `residual`, how far it is from being met (mm, or radians for a direction);
  - its `moving` and `target` geometry: which part, what kind of face or edge, where it is, and which way it points or runs.

  `capture_view` shows the same conflict marked in red.

## Recommendation

When an assembly uses off-the-shelf parts (motors, bearings, wheels, fasteners, batteries, electronics), first check whether the manufacturer or a supplier offers an accessible STEP or STL file. Import a direct public HTTPS file URL with `import_vendor_part`, then `insert_component`. The plugin downloads and transfers the original file; do not generate base64 in the conversation or put a URL into a bytes parameter. `import_part` remains for actual supplied bytes. Design an explicitly labeled dimensional envelope only when no file is readily available; an envelope is not vendor CAD.

Inspect imported shaft/bore diameters, mounting holes and faces before selecting interfaces. Similar outside dimensions do not prove that two vendors' wheel/hub systems fit. Ground a stable chassis reference and use actual geometry with `add_mate` for mechanically related components; fixed placements alone are not a verified mechanical connection. `auto_explode` can separate grounded components visually without changing assembled positions, grounding, mates, measurements or exports.
