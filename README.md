# Vibe CAD

A local Codex plugin for parametric CAD. Codex starts the bundled tools when it connects the plugin. The embedded editor and assistant operate on the same saved document, with real Open CASCADE Technology (OCCT) solids, constrained sketches, feature history and STEP/STL export.

Everything runs locally. The stdio adapter connects Codex to the bundled tools, and startup uses the host's Node runtime.

## Build and package

```sh
npm ci
npm run build
npm test
npm run package:plugin
npm run verify:plugin
```

The package is `dist/vibe-cad-local.zip`. The local marketplace at `.agents/plugins/marketplace.json` points to `dist/local-plugin/vibe-cad`. Install Vibe CAD from that marketplace in Codex, then ask it to open a CAD document.

The source has three parts: `cad/` holds the geometry kernel, typed operations and saved documents; `runtime/` connects those operations to Codex over local stdio; `editor/` is the embedded CAD interface. `scripts/` contains only build, launch, package and verification tasks. The production package contains the compiled tools and editor, the replaceable geometry kernel, one launcher, plugin metadata, documentation and required dependency licenses.

Models live in `~/.vibe-cad/documents` and exports in `~/.vibe-cad/exports`, outside the plugin installation. Set `VIBE_CAD_DATA_DIR` to change the document directory. Upgrading the plugin preserves saved designs.

The package verifier starts an extracted copy without `node_modules` or system Node on PATH. It verifies typed tool discovery, parametric rebuilding, exact solid volume, STEP bytes and the embedded editor resource.

## CAD workflow

Create constrained sketches, build solid features, select faces and edges, edit dimensions, assemble parts, make drawings and export files. Invalid edits preserve the previous committed document. Stale topology references fail explicitly.

Use `run_steps` for a sequence of typed operations and `open_cad` to display the saved model. Direct editor operations call those same tools. See [CAD operations](docs/VIBE_CAD.md) and [local plugin architecture](docs/STANDALONE_PLUGIN.md).

Optional version control works when `VIBE_WORKSPACE` points to a git checkout. Designs use canonical object files; imported parts use content-addressed blobs. Git uses the laptop's existing credentials.

## License

Vibe CAD is released under the [MIT License](LICENSE). The geometry kernel is Open CASCADE Technology, bundled through `replicad-opencascadejs` under LGPL-2.1. It ships as the separate, replaceable `dist/kernel.wasm` so it can be rebuilt or swapped. [NOTICE.md](NOTICE.md) lists third-party licenses and links to the kernel source.
