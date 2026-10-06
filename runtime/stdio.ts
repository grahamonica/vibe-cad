import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcp } from "./mcp.ts";
import { Store } from "../cad/store.ts";
import { closeKernel } from "../cad/geometry.ts";
// Codex owns this local process and its lifetime.
const server = createMcp(new Store());
const transport = new StdioServerTransport();
await server.connect(transport);
const previousClose = transport.onclose;
transport.onclose = () => {
  previousClose?.();
  void closeKernel();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await server.close();
    await closeKernel();
    process.exit(0);
  });
}
