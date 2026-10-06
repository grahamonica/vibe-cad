# Local Codex parametric CAD

Install one Codex plugin. Codex starts its bundled tools and opens the embedded editor. The user and assistant edit the same locally saved parametric document.

## Features

- Constrained 2D sketches with lines, rectangles, circles, arcs and driving dimensions.
- Real boundary-representation solids with extrude, cut, holes, fillets, chamfers, patterns and booleans.
- Interactive orbit, pan, zoom and topology selection.
- Editable feature history, undo/redo and persistent state.
- Typed assistant tools for inspection and every modeling operation.
- STEP, printable STL and native editable `.edit` project export.

The viewport mesh visualizes the model. Parametric features and exact kernel geometry remain authoritative.

## Shared interaction

A user selects a face and asks for two symmetric mounting holes. Codex inspects the saved selection, applies a typed operation with the current document revision, and the editor shows the committed result. A manual dimension change updates that same document for the assistant's next inspection.

The document holds sketches, constraints, dimensions, features, bodies, topology references, assemblies, drawings, design intent and history. Tools report concise structured summaries and expose exact selected geometry. No free-form command executor interprets CAD instructions.

## Correctness

Rebuild geometry before committing an edit. Save atomically. Reject revision conflicts and stale topology references without silently remapping them. Failed geometry or conflicting constraints preserve the previous committed model. Native project archives include linked parts and original imported files.

## Runtime

A local stdio adapter exposes the typed tools to Codex. It requires no external hosting or network listener. Codex owns the runtime lifetime and supplies the Node runtime. The self-contained embedded editor uses the host bridge to call those tools. Private models and exports remain outside the plugin package.

Verify both the extracted package and native editor interaction. Successful shell tool calls alone do not establish embedded rendering.
