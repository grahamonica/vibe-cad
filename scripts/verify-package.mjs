import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
const packageVersion = JSON.parse(await readFile(resolve("package.json"), "utf8")).version;
const uiUri = `ui://vibe-cad/editor-${packageVersion}.html`;
const temp = await mkdtemp(join(tmpdir(), "vibe-standalone-"));
const archive = resolve("dist/vibe-cad-local.zip");
const entries = execFileSync("unzip", ["-Z1", archive], {
  encoding: "utf8",
}).split("\n");
assert.ok(
  !entries.some((x) =>
    /(^|\/)(node_modules|documents|output|\.env)(\/|$)/.test(x),
  ),
  "Private files or dependencies in archive",
);
execFileSync("unzip", ["-q", archive, "-d", temp]);
const root = join(temp, "vibe-cad");
assert.equal(existsSync(join(root, "node_modules")), false);
const config = JSON.parse(await readFile(join(root, "mcp.json"), "utf8"))
  .mcpServers["vibe-cad"];
const transport = new StdioClientTransport({
  command: config.command,
  args: config.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", root)),
  cwd: config.cwd.replaceAll("${PLUGIN_ROOT}", root),
  env: {
    ...process.env,
    PATH: "/usr/bin:/bin",
    CODEX_MCP_NODE_PATH: process.env.CODEX_MCP_NODE_PATH ?? process.execPath,
    VIBE_CAD_DATA_DIR: join(temp, "models", "documents"),
    TMPDIR: temp,
  },
  stderr: "pipe",
});
const client = new Client({
  name: "Standalone plugin verification",
  version: "1",
});
transport.stderr?.on("data", () => {});
try {
  await client.connect(transport);
  const engine = await client.callTool({name:"engine_info",arguments:{}});
  assert.equal(engine.structuredContent.version, packageVersion, "Engine must report the bundled package version");
  assert.equal(client.getServerVersion()?.version, packageVersion);
  const catalog = (await client.listTools()).tools;
  assert.ok(catalog.length >= 100);
  const visibleTools = catalog.filter(t => t._meta?.ui?.visibility?.includes("model"));
  assert.ok(visibleTools.length <= 24, "Model catalog must remain compact");
  for (const name of ["create_document", "open_cad", "run_steps"]) {
    const tool = catalog.find((x) => x.name === name);
    assert.ok(visibleTools.some(t => t.name === name), `${name} must reach the model`);
    assert.equal(tool._meta.ui.resourceUri, name === "open_cad" ? uiUri : undefined);
    assert.equal(
      tool._meta["openai/outputTemplate"],
      name === "open_cad" ? uiUri : undefined,
    );
  }
  // Reproduce a plugin update removing an old installation while its stdio
  // process remains alive. First worker startup and UI reads must still work.
  await rm(root, {recursive:true,force:true});
  const r = await client.callTool(
    {
      name: "run_steps",
      arguments: {
        steps: [
          {
            tool: "create_document",
            args: { name: "Standalone plate" },
            as: "plate",
          },
          { tool: "create_sketch", args: { plane: "XY" }, as: "profile" },
          {
            tool: "add_sketch_entity",
            args: {
              sketchId: "@profile.sketch",
              type: "rectangle",
              values: { x: 0, y: 0, width: 80, height: 50 },
            },
          },
          {
            tool: "extrude",
            args: { sketchId: "@profile.sketch", distance: 12 },
          },
        ],
      },
    },
    undefined,
    { timeout: 120000 },
  );
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(r.structuredContent.ok, true);
  assert.equal(r._meta?.view, undefined);
  const opened = await client.callTool({ name: "open_cad", arguments: { documentId: r.structuredContent.document.id } });
  assert.ok(!opened.isError, JSON.stringify(opened));
  const view = opened._meta.view;
  assert.ok(Math.abs(view.geometry.bodies[0].volume - 48000) < 1e-3);
  const d = view.document;
  const screened = await client.callTool({ name: 'run_steps', arguments: { documentId: d.id,
    steps: [{ tool: 'check_sheet_features', args: { bodyId: view.geometry.bodies[0].id } }] } });
  assert.ok(!screened.isError, JSON.stringify(screened));
  assert.equal(screened.structuredContent.steps[0].result.status, 'no-narrow-features-detected');
  assert.equal(screened.structuredContent.steps[0].result.materialRegions, 1);
  const exported = await client.callTool({
    name: "export_file",
    arguments: { documentId: d.id, format: "step" },
  });
  assert.ok(!exported.isError, JSON.stringify(exported));
  assert.ok(
    Buffer.from(exported._meta.download.base64, "base64")
      .toString()
      .startsWith("ISO-10303-21;"),
  );
  const ui = await client.readResource({ uri: uiUri });
  assert.equal(ui.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.ok(ui.contents[0].text.includes("3D CAD viewport"));
  const report = {
    verifiedAt: new Date().toISOString(),
    extractedWithoutNodeModules: true,
    systemNodeNotOnPath: true,
    hostRuntime: process.env.CODEX_MCP_NODE_PATH ?? process.execPath,
    directStdio: true,
    toolCount: catalog.length,
    modelToolCount: visibleTools.length,
    mainEditorAndBuildToolsExposed: true,
    volume: view.geometry.bodies[0].volume,
    stepBytesDeliveredThroughMcp: true,
    uiResourceReadable: true,
    nativeEditorMetadataPresent: true,
    survivesInstallationRemoval: true,
  };
  await writeFile(
    "output/package-verification.json",
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  await client.close();
  const running = join(temp, `vibe-cad-running-${process.getuid?.() ?? 'user'}`);
  assert.deepEqual(await readdir(running), [], 'Exited runtime retained its asset snapshot');
  await rm(temp, { recursive: true, force: true });
}
