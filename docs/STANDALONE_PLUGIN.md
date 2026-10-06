# Local Codex plugin

Codex launches `scripts/launch.sh` through the plugin's `mcp.json`. The launcher locates the host Node runtime and starts the bundled CAD tools over stdio. Codex owns the process lifetime. There is no network listener or external host.

The package contains two JavaScript bundles (typed tools and geometry worker), a separate OpenCascade WASM kernel, one self-contained editor HTML resource, the plugin manifest and CAD skill. The editor calls local typed operations through Codex's MCP Apps bridge. Both interfaces share the authoritative document store, revisions, selection and history.

Source code lives in `cad/`, `runtime/` and `editor/`. Builds produce `dist/runtime/`, `dist/editor/` and `dist/kernel.wasm`. One shell launcher starts the compiled stdio adapter directly. Packaging includes license texts for dependencies present in those bundles, rather than the SDK's entire installed dependency tree.

The model receives a compact catalog of 21 main tools, including `open_cad`, `run_steps`, sketches, inspection and exports. Specialist tools are app-visible and remain available through validated batch steps; `get_tool_schema` supplies their exact argument schemas on demand. Coordinate arrays keep fixed lengths without Draft-07 tuple schemas that can be rejected by the host's function converter. A running response retains its existing catalog; the next user message loads the refreshed tools.

`open_cad` and `run_steps` declare `ui://vibe-cad/editor.html`. Small model views travel in tool-result metadata. Large views stream compressed records through bounded local resources, pinned to one document revision. Exports are saved locally and carry download bytes through the host bridge.

`npm run verify:plugin` extracts the ZIP into a temporary directory and starts its real launcher with no `node_modules` and no system Node on PATH. It checks the tool catalog, a parametric plate, exact volume, STEP bytes and readable editor HTML. Native panel rendering is a separate verification in Codex. Windows startup has not been verified.
