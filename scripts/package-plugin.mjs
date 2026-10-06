import { cp, mkdir, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const stage = "dist/local-plugin/vibe-cad";
const { version } = JSON.parse(await readFile("plugin/plugin.json", "utf8"));
await rm("dist/local-plugin", { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const path of ["plugin.json", "mcp.json", "assets", "skills"])
  await cp(`plugin/${path}`, `${stage}/${path}`, { recursive: true });
for (const path of [
  "scripts/launch.sh",
  "README.md",
  "NOTICE.md",
  "LICENSE",
  "docs/STANDALONE_PLUGIN.md",
  "docs/VIBE_CAD.md",
]) {
  await mkdir(`${stage}/${path.split("/").slice(0, -1).join("/")}`, {
    recursive: true,
  });
  await cp(path, `${stage}/${path}`);
}
for (const path of [
  "dist/runtime/stdio.mjs",
  "dist/runtime/geometry-worker.mjs",
  "dist/editor/index.html",
  "dist/kernel.wasm",
]) {
  await mkdir(`${stage}/${path.split("/").slice(0, -1).join("/")}`, {
    recursive: true,
  });
  await cp(path, `${stage}/${path}`, { recursive: true });
}
await writeFile(
  `${stage}/package.json`,
  JSON.stringify(
    {
      name: "vibe-cad",
      version,
      license: "SEE LICENSE IN LICENSE",
      author: "Monica Graham",
      private: true,
      type: "module",
      engines: { node: ">=22.16.0" },
      scripts: {
        start: "sh scripts/launch.sh",
      },
    },
    null,
    2,
  ),
);
const inputs = [
  ...JSON.parse(await readFile("dist/runtime/dependencies.json", "utf8")),
  ...JSON.parse(await readFile("dist/editor/dependencies.json", "utf8")),
  "node_modules/replicad-opencascadejs/package.json",
];
const paths = new Set(inputs.map(path => {
  const segments = path.slice(path.lastIndexOf("node_modules/") + 13).split("/");
  return path.slice(0, path.lastIndexOf("node_modules/") + 13) + segments.slice(0, segments[0].startsWith("@") ? 2 : 1).join("/");
}));
for (const path of paths) {
  let files;
  try {
    files = await readdir(path);
  } catch {
    continue;
  }
  const name = path.split("node_modules/").at(-1).replaceAll("/", "--");
  for (const file of files.filter((f) =>
    /^licen[cs]e|^copying|^notice/i.test(f),
  )) {
    await mkdir(`${stage}/assets/licenses/${name}`, { recursive: true });
    await cp(`${path}/${file}`, `${stage}/assets/licenses/${name}/${file}`, {
      recursive: true,
    });
  }
}
await rm("dist/vibe-cad-local.zip", { force: true });
execFileSync("zip", ["-qr", "../vibe-cad-local.zip", "vibe-cad"], {
  cwd: "dist/local-plugin",
});
console.log(
  "Packaged dist/vibe-cad-local.zip (includes local tools, editor, and geometry kernel; no npm install required).",
);
