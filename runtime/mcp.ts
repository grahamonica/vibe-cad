import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { toolset, summarize } from "../cad/tools.ts";
import { outputSchemas, viewOutput } from "./output-schemas.ts";
import { Store } from "../cad/store.ts";
import type { View } from "../cad/types.ts";
import { deliverView, registerViewResources } from "./view-delivery.ts";
export const uiUri = "ui://vibe-cad/editor.html";
// Keep the model catalog small enough to survive host catalog budgets. The
// editor still has every typed operation, and run_steps validates those same
// schemas. Specialist schemas can be requested without loading all of them.
export const modelToolNames = new Set([
  "list_documents", "create_document", "open_cad", "inspect_document",
  "inspect_geometry", "inspect_selection", "get_tool_schema", "run_steps",
  "create_sketch", "add_sketch_entity", "add_sketch_constraint", "extrude",
  "set_dimension", "capture_view", "check_definition", "mass_properties",
  "import_vendor_part", "export_file", "undo", "redo", "restore_history",
]);
export function createMcp(store: Store) {
  const server = new McpServer(
    { name: "vibe-cad", version: "1.0.0" },
    {
      instructions:
        "Local parametric CAD. Open with open_cad; build with run_steps. Use get_tool_schema for specialist operations. UI and tools share saved documents and revisions. Units: mm. Never invent topology IDs; failed edits preserve the committed model.",
    },
  );
  registerViewResources(server, store);
  registerAppResource(server, "CAD editor", uiUri, {}, async () => ({
    contents: [
      {
        uri: uiUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readFile(
          process.env.VIBE_CAD_ROOT
            ? `${process.env.VIBE_CAD_ROOT}/dist/editor/index.html`
            : fileURLToPath(new URL("../dist/editor/index.html", import.meta.url)),
          "utf8",
        ),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [] },
          },
          "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
          "openai/widgetDescription":
            "Interactive parametric CAD editor. Edits, geometry selection, and design history are shared with the MCP tools.",
        },
      },
    ],
  }));
  for (const tool of toolset(store)) {
    registerAppTool(
      server,
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        outputSchema: outputSchemas[tool.name] ?? viewOutput,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.readOnly && tool.name !== "preview_dimension",
          openWorldHint: tool.openWorld ?? false,
        },
        _meta: {
          ...(tool.ui ? { "openai/outputTemplate": uiUri } : {}),
          ui: {
            ...(tool.ui ? { resourceUri: uiUri } : {}),
            visibility: modelToolNames.has(tool.name) ? ["model", "app"] : ["app"],
          },
        },
      },
      async (args: any, extra: any) => {
        try {
          const source =
            extra?._meta?.["vibe-cad/source"] === "user" ? "user" : "assistant";
          const result = await tool.handler(tool.schema.parse(args), source);
          // A view goes to the editor whole and to the assistant as a summary; a batch
          // (run_steps) carries its final view the same way beside its report.
          const batch = result?.view?.document && result?.view?.geometry;
          const view = (batch ? result.view : result) as View;
          const shown = !!(view?.document && view?.geometry);
          // Pictures (capture_view) go to the assistant as images; the JSON keeps their names.
          const pictures: { name: string; mimeType: string; data: string }[] =
            Array.isArray(result?.images) ? result.images : [];
          const structuredContent = batch
            ? (({ view: _, ...report }) => report)(result)
            : shown
              ? summarize(view)
              : pictures.length
                ? {
                    ...result,
                    images: pictures.map(({ name, mimeType }) => ({
                      name,
                      mimeType,
                    })),
                  }
                : result;
          const download =
            ["export_file", "export_drawing"].includes(tool.name) &&
            result?.path
              ? {
                  filename: result.filename,
                  mimeType: result.mimeType,
                  base64: (await readFile(result.path)).toString("base64"),
                }
              : undefined;
          return {
            content: [
              { type: "text", text: JSON.stringify(structuredContent) },
              ...pictures.map((p) => ({
                type: "image" as const,
                data: p.data,
                mimeType: p.mimeType,
              })),
            ],
            structuredContent,
            _meta:
              shown || download
                ? {
                    ...(shown && tool.ui
                      ? {
                          "openai/outputTemplate": uiUri,
                          ui: { resourceUri: uiUri },
                        }
                      : {}),
                    ...(shown ? deliverView(store, view) : {}),
                    ...(download ? { download } : {}),
                  }
                : undefined,
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: e instanceof Error ? e.message : "CAD operation failed",
              },
            ],
          };
        }
      },
    );
  }
  return server;
}
