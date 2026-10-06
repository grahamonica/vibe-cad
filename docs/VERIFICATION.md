# Verification

Run `npm test`, `npm run build`, `npm run package:plugin` and `npm run verify:plugin`.

The build rejects unused local declarations, imports and parameters. Build the editor before running tests in a fresh checkout.

The retained tests cover the geometry kernel, sketch solver, assemblies, drawings, saved projects, atomic transactions, revision conflicts, topology identity, history, typed tool schemas and local editor view delivery.

`output/package-verification.json` records extracted-package verification. `scripts/verify-installed-plugin.mjs` checks the installed plugin without modifying existing saved designs. Native editor screenshots and interaction evidence belong in `output/playwright`.

Tool execution and a readable HTML resource do not prove that Codex rendered the interactive panel. Record native rendering and bidirectional editing separately.
