# Vibe CAD

**Vibe CAD** is a local Codex plugin whose embedded editor and typed tools act on the same saved parametric document. The local connection, editor resources, storage and package all use the Vibe CAD name.

This page describes what the current build does and where it stops. Test and native editor evidence is listed in [verification](VERIFICATION.md).

## Interface

The editor follows the layout engineers know from SolidWorks, Onshape and Fusion: Part, Assembly and Drawing workspaces, each with a tabbed command manager. Parts have Sketch, Features, Sheet Metal, Weldments and Evaluate tabs; assemblies have Assembly and Evaluate. Related tools sit side by side in a tab, so the bar fits without scrolling. Close variants share one category dropdown named for the category: Pattern (Linear Pattern, Circular Pattern), Edges (Fillet, Chamfer), Holes (Hole Wizard, Thread), Drives (Spur Gear, Timing Pulley), Body (Combine, Split, Move/Copy, Scale, Move Face, Import), and in sketches Rectangle, Arc and Corners. Around the command manager are a feature tree on the left, Properties, History and Intent on the right; a feature timeline at the bottom; and a view cube anchored to the viewport corner that tracks the camera.

The view controls include a section view: cut the model with the Front, Top or Right plane at any offset. The cut faces are capped so solids read as solid, and the removed half cannot be picked.

Edges drawn in the viewport and on drawings are the part's real edges. A cylinder's wrap-around seam, and the joint between two faces of one surface (an extruded circle's two half-cylinders), are never drawn. A toggle in the view controls hides tangent edges: fillet boundaries and the joints within a gear flank, as SolidWorks' Tangent Edges Removed does. The choice is remembered on this computer.

Bodies show their real edges plus silhouette lines on curved faces, recomputed as the view turns. Seam edges, where a cylinder's surface wraps round, are not drawn.

You can start any operation from the model. Click a face, edge, plane or body and its context menu offers the operations that apply to it (sketch on a face, hole, fillet, chamfer, shell, measure, mate). Feature commands open a PropertyManager on the left with selection boxes, live previews, accept and cancel. The model stays pickable while a command is open. Double-click a feature to edit it.

Design rules: one 3 px corner radius everywhere, and the supplied palette with a fixed meaning per color.

**Logo.** Three equal dots on a falling diagonal, top left to bottom right: the pivots of a matrix in echelon form. The dots are evenly spaced, one diameter apart on each axis, with nothing else in the mark: no letters, frame or gradient.
- **In the app header:** the dots are `#1E1E1E` on the white surface, followed by the words "Vibe CAD".
- **As a favicon or plugin icon:** the dots are `#FFFFFF` on a `#1E1E1E` square with the 3 px corner radius.
- **Not used for the logo:** the accent color, because it means selection and action.

| Color | Used for |
| --- | --- |
| `#FFFFFF` | Surfaces |
| `#1E1E1E` | Text, icons, edges, fully defined sketch geometry |
| `#70798C` | Secondary text, grid, planes, construction and under-defined geometry, exploded-view trails |
| `#CE8147` | Selection, the active tool, primary actions, previews |
| `#544841` | Solid bodies |

Red is used only for errors and destructive actions. Axis colors keep their standard XYZ meaning.

Each document shows millimeters or inches; switch from the unit in the status bar or the document properties. Fields, sketch dimensions, readouts and drawing dimensions follow the choice (drawings use decimal inches without a leading zero, as in ANSI). Geometry, saved values and assistant tools always use millimeters.

## Sketching

Sketches live on a principal plane, a datum plane or a planar face, and are edited in place in the 3D view.

- **Geometry:** line chains, corner and center rectangles, circles, three-point and tangent arcs, polygons, slots, splines through fit points (open or closed), points and construction geometry. Splines are exact cubic curves in profiles and sweep paths, and each fit point can be dragged, dimensioned or related.
- **Tools:** power trim (trimming a spline keeps its exact shape); Convert (click model edges or faces to bring their outline into the sketch); Offset (pick a chain, place it with a live distance readout, then type the value); Mirror (select geometry, then click a centerline, or Shift-click any line); linear and circular sketch Pattern (one spacing or angle dimension drives every copy); sketch Fillet and Chamfer (click a corner).
- **Relations:** horizontal, vertical, coincident, distance, length, angle, equal, parallel, perpendicular, collinear, concentric, tangent, midpoint, point-on (including on a spline), symmetric (about a line), fixed, radius, diameter, offset and pattern. Trimming adds coincident or point-on relations at each cut, so trimmed outlines stay closed when the sketch changes. Smart dimensions are placed with a click and edited inline. Driven (reference) dimensions are supported.
- **Solver:** a numerical least-squares solver reports degrees of freedom, colors under-defined geometry, and rejects conflicting edits as a whole. A value you type holds; the rest of the sketch adapts around it.

Converted edges follow the model: every rebuild re-projects them, re-solves the sketch, and saves the new positions. Unlink a converted entity to edit it freely. Offsets are associative: one offset dimension drives every copy in a chain, and the copies follow their sources. So a pocket made from a converted face outline, offset inward, follows the part when the part changes size. Fillets and chamfers leave a construction point at the virtual sharp corner, so dimensions to the corner keep their meaning.

## Part features

All features build real OpenCascade B-rep solids, and every result passes a B-rep validity check before it is saved.

- **Extrude and cut:** blind, symmetric, two-sided, through all, through all in both directions and up to face, with an optional draft angle.
- **Revolve, sweep and loft:** revolve about a sketch line, edge, face axis or principal axis; sweep along a path; loft between profiles.
- **Hole wizard:** simple, counterbore, countersink and tapped holes with ISO metric sizes M1.6 to M24. Holes can be placed by coordinates or from sketch points.
- **Edges:** constant and variable-radius fillets on edges, faces or whole bodies; chamfers with equal distance, two distances or distance and angle.
- **Body operations:** shell, draft, split, scale, move/copy, combine (union, subtract, intersect), mirror, and linear and circular patterns of features or bodies.
- **Rib:** sketch an open line or arc profile on a plane through the part. The rib fills from the profile to the part's walls and floor, extending the profile ends until they meet the part. It is thickened symmetrically about the sketch plane, and the side is chosen automatically or flipped.
- **Datum planes:** offset, angled about an axis, mid-plane, three-point and normal-to-edge. Datum planes stay associative to their references.
- **Sheet metal:** start from a base flange (a closed sketch at the sheet thickness, with a bend radius and K-factor). Add edge flanges on straight outline edges, or on the end of another flange (lips, boxes, folded armor): real bends at any angle up to 180°, up or down, sized from the outer virtual sharp. Hems fold an edge back on itself, closed or open with a gap. Closed Corner carries the walls of two 90° flanges across the outside corner where they meet, as for a box or tray. One wall covers the other's end; the other runs up to it, less a gap (0.1 mm by default). The bends stop at the base corner, which leaves a square corner relief, and the flat pattern carries each wall past its bend. Sketched bends fold a plate along a sketch line by any angle, up or down, for wedges and folded armor. Holes cut before the bend keep their identity. The flat pattern unrolls each flange (and flanges on flanges, in their chain) by its bend allowance θ(R + K·T). With sketched bends it shows the blank before bending, with each bend line clipped to the blank; holes, cuts and flanges must come before the bends. It keeps holes cut through the base and marks each bend centerline with its direction, angle and radius. It exports as DXF with CUT and BEND layers.
- **Material:** a library of common engineering materials with density, elastic modulus, yield and tensile strength and Poisson's ratio. Only density is used today. The library covers:
  - aluminum 6061, 7075 and 5052;
  - carbon steels 1018, 1045 and 4140, and AR500 armor steel;
  - tool steels S7, D2 and A2 (hardened), and stainless steels 304, 316 and 17-4;
  - wrought, gray and ductile cast iron;
  - bearing and phosphor bronze, brass and copper;
  - titanium grades 2 and 5;
  - UHMW, HDPE, polycarbonate, acetal, nylon and ABS;
  - carbon-fiber sheet and tube, and G10;
  - 3D-printing filaments: PLA, PETG, ABS, TPU 95A, nylon PA12 and PA6, and carbon-fiber nylon.

  Printed parts take an infill percentage and wall thickness. Their mass counts solid walls (surface area × wall thickness) around a partly filled interior. Users save their own materials to a library shared by every document, and each document keeps a full copy of its material.

  Bodies report mass and principal moments of inertia, and drawings use the material in the title block and BOM. A purchased part can carry its known mass instead of a material.
- **Mass properties and weight class:** Evaluate → Mass Properties reports, for a part or a whole robot:
  - the total weight against a weight limit (in pounds in inch documents);
  - the center of gravity and the combined inertia tensor;
  - each body's share, and which bodies have no mass yet.

  For a spinning weapon, pick its shaft face and a speed to get its inertia about that axis, stored energy, tip speed, and the bearing force from any imbalance.
- **Threads:** cosmetic by default, the lightweight way production CAD does it. A thread on a shaft or hole changes nothing in the solid and draws as rings at its pitch. Drawings show it in the simplified ISO 6410 / ASME Y14.6 form: thin root lines, a thick limit line and a three-quarter circle end-on, plus callouts such as `M10×1.5 DEEP 15` with the tap drill. On request, a modeled thread cuts a real ISO 60° helical groove for 3D printing. ISO metric sizes or a custom diameter and pitch, full or partial length, right or left hand.
- **Gears and pulleys:** a spur gear generator builds exact involute teeth from module, tooth count and pressure angle, with face width, bore and tooth phase. Backlash (default 0.04 × module for a pair) turns each flank slightly toward its tooth's middle; a turned involute is still exact. Two gears of one module mesh with that clearance at module × (teeth₁ + teeth₂) / 2. A timing pulley generator makes GT2, HTD 3M and HTD 5M pulleys with flanges and a bore. The outside diameter follows the belt pitch.
- **Gear mates:** a mechanical mate couples two parts' rotation about their own axes (circular edges or cylindrical faces). The ratio defaults to the tooth ratio when both parts are spur gears or pulleys; external gears turn opposite ways, and Same direction suits an internal gear or two pulleys on one belt. The mate keeps the mesh the gears have when it is added, and its phase can be adjusted. Turning one gear turns the whole train. Motion Check turns the train with its driver. Meshing gears are checked against each other over one tooth's worth of travel, since the mesh repeats every tooth; a clash shows at every step.
- **Weldments:** structural members sweep square, rectangular or round tube, angle, channel or flat bar along the lines of a sketch, one body per member. Where lines meet, corners are mitered or butted, and a member ending partway along another stops at its side (a T-joint). Members follow the sketch. Weld beads add fillet welds of a chosen leg size in inside corners, and their mass. The cut list gives each member's cut length and the total of each profile. Drawings take AWS A2.4 fillet weld symbols that read the leg size from the bead: arrow, other or both sides, length, all-around, field weld and a process tail.
- **Plate DXF:** export any flat face's outline at 1:1 for waterjet, laser or router cutting. Holes and arcs stay exact circles and arcs, and the file is in millimeters or inches.
- **STEP and STL import:** bring in vendor parts, geometry from other CAD systems, or 3D-printing meshes as solid bodies (document menu **Import…**, or `import_step` / `import_stl`). An STL mesh must be watertight. Its facets are sewn into a closed solid and coplanar facets merge into single flat faces, so a meshed part comes back with real planar faces and straight edges; curved areas stay faceted. STL has no units, so you pick them on import. Meshes have a 60,000-triangle limit. Imported bodies take sketches on their faces, cuts, holes, fillets, patterns and Move Face. They can be inserted into assemblies, including straight from a file with **Insert Part → Browse…** (`import_part` makes a part document from the file only if it imports). They appear in drawings. Each file is stored once by content hash, outside the document and its undo history.
- **Move Face:** a direct edit that offsets planar faces along their normals, pulling material out or pushing it in, like Move Face or Press Pull. It works on any body, imported or modeled, when the faces around each moved face are square to it, and the moved face keeps its identity so sketches and mates on it follow.
- **Global variables and equations:** named variables (`wall = 3`, `width = 2 * height + wall`) drive sketch dimensions and feature parameters through expressions with + − × ÷ ^, unit suffixes (mm, cm, m, in, ft, deg, rad) and common math functions. Changing a variable updates every dimension that uses it in one edit, and an equation that cannot be satisfied rejects the edit. Circular references are refused. Renaming a variable rewrites every expression that uses it. Typing a number replaces an equation. Expressions are parsed by a small arithmetic parser, never evaluated as code. In the editor, the **Equations** command (and the Equations node in the feature tree) lists the global variables and the dimensions they drive, edited in place. Type `=` followed by an equation in any dimension or feature field to drive it. Equation-driven dimensions show Σ. Assistant tools: `set_variable`, `delete_variable`, and `expression` on `set_dimension` and sketch value edits.

## Persistent topology names

Faces are named after the feature and the input that created them: each extrusion side is named after the sketch curve it came from, each hole wall after its hole instance, and each fillet face after the edge it rounds. Names are carried through later features using the kernel's own history of which faces were kept, modified or generated. Edges are named after their neighboring faces.

As a result, references survive ordinary edits. A drawing dimension stays on its hole when the hole moves. A fillet stays on its edge when the part gets thicker or wider. A mate stays on its face after an upstream change. Hole centers have stable identities: removing one center never moves a reference to a different hole.

When an edit makes a reference ambiguous (for example, a later cut splits a referenced face in two), the reference stops resolving and the edit is rejected with a request to reselect. It is never silently moved to a different face. References saved by earlier builds still resolve through their old geometric identity, as long as exactly one face or edge matches it.

## Assemblies

- **Hole series:** click hole centers on the top plate of a stack. Matching holes go through every part behind it: counterbored or countersunk in the first, clearance holes between, and tapped in the last. Each is a real hole feature in that part's own document, and nothing changes unless every part takes its holes.
- **Belts:** pick two timing pulleys on parallel shafts. Vibe CAD reports the center distance, the belt's pitch length and tooth count, the nearest whole-tooth belt and the center distance it needs. The belt it adds follows its pulleys: it is rebuilt wherever the solved assembly puts them, so moving the motor mount or re-mating a pulley resizes it. Its body is named for ordering (for example "HTD 5M belt 75T 375 mm"), which is how the BOM lists it. It weighs as neoprene (1.25 g/cm³) in Mass Properties and exports with the assembly. When the pulleys are not at a whole-tooth center distance, the assembly warns with the distance the belt needs. A belt cannot be moved or mated on its own, a pulley under a belt cannot be deleted, and Motion Check lets a belt run with the pulley it is on.
- **Motion check:** turn a weapon or arm through its travel about its concentric mate (or slide a part). It reports where it hits the rest of the robot, as angle ranges, and its tightest clearance. A part in a closed loop of mates (a four-bar lifter or flipper), or one other parts are mated to, moves as a mechanism. The assembly is solved again at every step, so the linkage and anything riding on it follow. Parts pinned or mated to each other count only if they overlap. A position the linkage cannot reach ends the sweep, which reports the limit, such as the end of a rocker's swing.

- **Inserted parts:** insert another document as a component, as many times as needed. Instances follow every later edit of the part document; an assembly can contain sub-assemblies. Circular inserts are rejected.
- **Grouped bodies:** bodies of the current document can also be grouped into components.
- **Component patterns:** repeat an inserted part along a direction or about an axis, such as bolts around a bolt circle. The axis or direction can be an edge or cylindrical face, or X, Y or Z. Instances follow the source component as it moves or is re-mated, count in the BOM, and can be mate targets.
- **Mates:** coincident, distance, parallel, perpendicular, angle, concentric (circular edges or cylindrical faces), tangent (a cylindrical face against a plane) and lock. A new mate keeps the alignment the parts are closest to; Flip reverses it.
  - **Solving:** mates are solved in dependency order. Closed loops of mates (linkages) are solved together by damped least squares from where the parts are: each step is the smallest move that meets the mates, so a linkage keeps its branch and its remaining freedom. Moving a part of a linkage (dragging it, or typing a rotation) keeps that part where it was put and solves the rest of the loop around it, so turning a crank moves a four-bar.
  - **Conflicts, as in SolidWorks:** a mate that over-defines a part is added but flagged and left unsolved. It names the mates it conflicts with, the ones without which it could be met, and the rest of the assembly stays exactly mated. A mate whose face or edge no longer exists (after a part edit) is flagged as broken and never re-attached to other geometry. The Mate dialog warns before a conflicting mate is accepted. The tree shows flagged mates in the error color, and parts as (f) fixed, (-) under-defined, (+) over-defined, or unmarked when fully defined. A part's properties give its remaining degrees of freedom (1 for each link of a four-bar). A part's Position and Rotation show where its mates put it and can be edited; its mates hold what they fix.
- **Moving parts:** drag components with a gizmo or position them numerically. A mated part moves only along the motion its mates leave free, such as sliding along or turning about a concentric axis.
- **Exploded views:** Auto explode pulls parts out along their mate axes, or off the faces they are mated to. Dashed trails show where each part assembles, and offsets stay editable. Explode affects display only.
- **Display, as in SolidWorks:**
  - **Appearance:** a color, a texture and a transparency (0–100%) for a part instance, or for a body of a part. The textures are brushed metal, carbon fiber, diamond plate and wood. Each comes with its usual color, and a color chosen afterwards tints it. A part instance's appearance shows over its part's own, and Remove appearance returns to it. A part instance's color without a texture of its own hides the part's texture.
  - **Display style:** the view toolbar sets Shaded With Edges, Shaded, Hidden Lines Removed, Hidden Lines Visible (hidden edges dashed) or Wireframe for the whole view; the choice is remembered on this computer. A part instance or a body can keep its own Display mode over the view's, and Default follows the view again. In Shaded, edges are not drawn but can still be picked. In Wireframe, a part's faces cannot be picked and hide nothing.
  - **Hide and Show:** a hidden part still counts in mass and mates.
  - **Isolate:** shows only the chosen parts until Exit Isolate.
  - **Suppress:** sets a part aside entirely (geometry, its mates, mass, BOM, drawings and checks) until it is restored.
  - **Access:** from a part's properties or its right-click menu.
- **Interference Detection:** every pair of parts that overlap, with the shared volume, largest first. Parts that only touch do not count. Clicking a result isolates the two parts.
- **Definition, as in SolidWorks:** the status bar reads Fully Defined, Under Defined or Over Defined, with the details on hover. Under-defined sketches show (-) in the feature tree, parts show (f), (-) or (+) in the assembly tree, and a part's properties give its remaining degrees of freedom.
- **Analysis:** a BOM in which instances of one part form one line with a quantity.
- **Navigation:** open a part document from its instance in the tree or inspector.

Assembled placements apply to rendering, measurements, interference, STEP/STL export and drawings.

## Mechanical drawings

Drawings are associative sheets with exact hidden-line projections of the B-rep.

- **Sheets:** ISO A4–A0 and ANSI A–D, landscape or portrait, first- or third-angle projection, zone border, and a title block (title, number, material, finish, tolerances, revision, drawn, checked and approved fields).
- **Views:** standard, projected, section (with hatching) and detail views, and flat pattern views of sheet metal bodies with their bend lines and notes. Views can be moved, rescaled, and hidden lines and tangent edges toggled. Assembly views can be shown exploded.
- **Annotations:** horizontal, vertical, aligned, radius, diameter and angle dimensions with tolerances; ordinate dimensions from a zero, with shared values written once and jogged extension lines where values crowd; hole callouts generated from the hole wizard; center marks and centerlines; notes, balloons and BOM tables; surface finish symbols, datums and geometric tolerance frames.
- **Export:** vector PDF, layered DXF and SVG at true sheet size.

## Version control (git and GitHub)

Designs in a project folder (`VIBE_WORKSPACE`, usually a git checkout) are versioned with git, so branches, commits, reviews and merges can all happen in git and on GitHub.
- **Layout:** each design is a folder of canonical JSON files, one per object. Objects keep their order through an order key instead of a shared list, so two branches that each add features never touch the same file. The same design always writes the same bytes, which keeps diffs readable on GitHub.
- **Outside the repository:** undo history, revision numbers and timestamps stay local, in a `.vibe/` folder that ignores itself.
- **In the editor:** the History tab shows the branch and its sync state with GitHub, the changed objects by name ("Wedge · feature Extrude 1"), a commit box, and pull and push. It also offers switching, merging and creating branches, and settling each conflicting object by keeping mine or taking theirs.
- **Merges:** a merge is committed only when every design still rebuilds; otherwise it stays open with the problems listed, to fix or abort.
- **Changes from outside:** when git changes a design on disk (a switch, pull or merge from the command line), Vibe CAD loads it as a new revision. It never writes over it.

## Assistant tools

The catalog has 136 typed tools with input and output schemas.

- **`run_steps`:** builds in one request. Each step is an ordinary typed tool, checked as that tool checks it. Steps can refer to what earlier steps made (`"@plate.body"`), and can pick faces and edges by description (`{"$face": {"body": "@plate.body", "normal": [0,0,1], "extreme": [0,0,1]}}`). An ambiguous pick fails rather than guess. By default a failed step returns every document the batch changed to where it was.
- **`capture_view`:** returns PNG pictures from named angles or any direction, drawn from the model itself, without screenshots. It can focus or isolate parts, make some see-through, and highlight parts, faces or mates. Mate conflicts are marked in red, with a legend.
- **Definition in every result:** every result carries the model's definition status and notes. `check_definition` explains each flagged mate: how far it is from met, and what geometry each side refers to.
- **Model guidance:** the plugin ships a guide for the model (`skills/vibe-cad/SKILL.md`) that documents this interface. It recommends looking for an existing STEP or STL file for off-the-shelf parts before designing them. Every tool shares the editor's revision checks, atomic saves, history and undo. There is no free-form command executor. Geometry-changing tools rebuild and validate before saving; a failed edit leaves the previous committed document unchanged.

## Not yet implemented

- Converting spline or elliptical edges, sketch ellipses, spline offsets, spline tangent handles and curvature control.
- Ribs normal to their sketch plane, wrap, thicken and surface modeling.
- Sheet metal: round and tear-drop corner reliefs, closed corners at angles other than 90° or on flange ends, miter flanges, jogs, lofted bends, sketched bends across holes or slanted edges, and features added after a sketched bend in the flat pattern. The flat pattern covers flanges on the base outline and on flange ends.
- Rack-and-pinion and cam mates, helical and bevel gears, chains and sprockets, and belts over more than two pulleys.
- Curved weldment members, end caps, gussets, and weld symbols other than fillet (groove, plug, spot).
- Dynamics (forces, speeds and torques in a mechanism), cam mates, and mate limits (angle or distance ranges).
- Tolerance stack-up.
- Editing an imported body's original feature history (STEP and STL files import as solids that later features and Move Face edit), Delete Face, moving non-planar faces, IGES import, curved-surface reconstruction from meshes, FEA/CFD, and live multi-user editing (collaboration happens through git branches and pull requests).
