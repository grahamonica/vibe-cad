import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await rm("dist/runtime", { recursive: true, force: true });
await mkdir("dist/runtime", { recursive: true });
const dependencies = new Set();
for (const entry of ["stdio", "geometry-worker"]) {
  const result = await build({
    entryPoints: [entry === "stdio" ? "runtime/stdio.ts" : "cad/geometry-worker.ts"],
    outfile: `dist/runtime/${entry}.mjs`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    metafile: true,
    banner: {
      js: "import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
  for (const output of Object.values(result.metafile.outputs))
    for (const [path, input] of Object.entries(output.inputs))
      if (input.bytesInOutput > 0 && path.includes("node_modules/")) dependencies.add(path);
}
await writeFile("dist/runtime/dependencies.json", JSON.stringify([...dependencies]));
await copyFile(
  require.resolve("replicad-opencascadejs/wasm"),
  "dist/kernel.wasm",
);
console.log("Built bundled CAD tools and geometry kernel.");
