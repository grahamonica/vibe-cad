# Third-party notices

Vibe CAD uses RepliCAD (MIT) and the Replicad OpenCascade.js distribution (`replicad-opencascadejs` 1.1.0, LGPL-2.1-only), which embeds Open CASCADE Technology and its WebAssembly build. The geometry module remains a separate replaceable `dist/kernel.wasm` file. Source and build instructions: https://github.com/sgenoud/replicad/tree/main/packages/replicad-opencascadejs and https://dev.opencascade.org/.

The runtime also includes Three.js (MIT), React (MIT), Lucide (ISC), Zod (MIT), @noble/hashes (MIT), the Model Context Protocol TypeScript SDK (MIT), and the MCP Apps SDK (MIT). Bundled dependency license texts are included under `assets/licenses/` in the local package. Build dependencies remain in package-lock.json in the source workspace.

To modify or replace the kernel, build the matching `replicad-opencascadejs` WebAssembly distribution and replace `dist/kernel.wasm`; the bundled JavaScript wrapper and WASM bindings must target the same API. The source workspace includes the version-locked dependency graph and a reproducible bundler script.
