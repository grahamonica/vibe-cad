// Read-only check of the installed plugin and the existing local model store.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { version } = JSON.parse(await readFile("plugin/plugin.json", "utf8"));
const root = resolve(process.argv[2] ?? join(homedir(), `.codex/plugins/cache/vibe-cad-local/vibe-cad/${version}`));
const directory = join(homedir(), ".vibe-cad/documents");
async function snapshot() {
  const entries = (await readdir(directory)).filter(name => name.endsWith(".json")).sort();
  return Promise.all(entries.map(async name => [name, createHash("sha256").update(await readFile(join(directory, name))).digest("hex")]));
}
const before = await snapshot();
const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
assert.equal(manifest.name, "vibe-cad");
const config = JSON.parse(await readFile(join(root, "mcp.json"), "utf8")).mcpServers["vibe-cad"];
const transport = new StdioClientTransport({
  command: config.command,
  args: config.args.map(arg => arg.replaceAll("${PLUGIN_ROOT}", root)),
  cwd: root,
  env: { ...process.env, CODEX_MCP_NODE_PATH: process.execPath },
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
const client = new Client({ name: "Installed Vibe CAD verification", version: "1.0.0" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const modelTools = tools.filter(t => t._meta?.ui?.visibility?.includes("model"));
  for (const name of ["list_documents", "open_cad", "run_steps", "get_tool_schema"])
    assert.ok(modelTools.some(t => t.name === name), `Missing primary model tool: ${name}`);
  const result = await client.callTool({ name: "list_documents", arguments: {} });
  assert.ok(!result.isError);
  const documents = result.structuredContent.documents;
  assert.equal(documents.length, before.length);
  assert.deepEqual(await snapshot(), before, "Read-only check changed saved documents");
  const report = {
    verifiedAt: new Date().toISOString(), plugin: manifest.name,
    installedStdioWorks: true, toolCount: tools.length,
    modelToolCount: modelTools.length,
    mainEditorAndBuildToolsExposed: true,
    savedDocumentCount: documents.length, savedDocumentBytesUnchanged: true,
    nativeEditorTested: false,
  };
  await writeFile("output/playwright/vibe-installed-plugin-verification.json", JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await client.close();
}
