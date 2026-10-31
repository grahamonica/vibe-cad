import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcp } from "./mcp.ts";
import { Store } from "../cad/store.ts";
import { closeKernel } from "../cad/geometry.ts";
import { CadStdioInput, CAD_MESSAGE_LIMIT } from "./stdio-input.ts";
// Codex owns this local process and its lifetime.
const server = createMcp(new Store());
const input = new CadStdioInput((id) => {
  void transport.send({ jsonrpc: "2.0", ...(id === null ? {} : { id }), error: {
    code: -32600,
    message: "CAD request exceeds 48 MiB. Import a local CAD file with import_part.localPath, or split the batch.",
  } }).catch(() => { /* The host may already have closed stdout during shutdown. */ });
});
const transport = new StdioServerTransport(input, process.stdout, { maxBufferSize: CAD_MESSAGE_LIMIT });
await server.connect(transport);
process.stdin.pipe(input);
const previousClose = transport.onclose;
transport.onclose = () => {
  process.stdin.unpipe(input);
  input.destroy();
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
