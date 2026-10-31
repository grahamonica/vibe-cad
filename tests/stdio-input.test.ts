import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CadStdioInput, CAD_MESSAGE_LIMIT } from "../runtime/stdio-input.ts";

test("stdio accepts supported large imports and rejects oversize without losing the next request", async () => {
  const output = new PassThrough();
  const rejected: unknown[] = [], received: number[] = [];
  const input = new CadStdioInput(id => rejected.push(id), 256);
  const transport = new StdioServerTransport(input, output, { maxBufferSize: 256 });
  transport.onmessage = message => { if ("id" in message && typeof message.id === "number") received.push(message.id); };
  await transport.start();
  const line = (id: number, data = "") => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params: { data } }) + "\n");
  const oversized = line(2, "a".repeat(1024));
  input.write(line(1));
  for (let at = 0; at < oversized.length; at += 97) input.write(oversized.subarray(at, at + 97));
  input.write(line(3));
  // The SDK writes id after params; nested CAD entity ids are unrelated.
  const idLast = Buffer.from(JSON.stringify({ method: "ping", params: { id: "nested", data: "b".repeat(1024) }, jsonrpc: "2.0", id: 5 }) + "\n");
  for (let at = 0; at < idLast.length; at += 97) input.write(idLast.subarray(at, at + 97));
  input.write(line(6));
  assert.deepEqual(rejected, [2, 5]);
  assert.deepEqual(received, [1, 3, 6]);
  await transport.close(); input.destroy(); output.destroy();

  // The real regression: an allowed file could exceed the SDK's 10 MiB default.
  const largeOutput = new PassThrough();
  const largeInput = new CadStdioInput(() => assert.fail("valid supported request rejected"));
  const largeTransport = new StdioServerTransport(largeInput, largeOutput, { maxBufferSize: CAD_MESSAGE_LIMIT });
  let delivered = false;
  largeTransport.onmessage = message => { delivered = "id" in message && message.id === 4; };
  await largeTransport.start();
  largeInput.write(line(4, "a".repeat(11 * 1024 * 1024)));
  assert.equal(delivered, true);
  await largeTransport.close(); largeInput.destroy(); largeOutput.destroy();
});
