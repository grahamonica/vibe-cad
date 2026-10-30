import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { KernelWorkerClient } from "../cad/kernel-worker-client.ts";

class FakeWorker extends EventEmitter {
  terminated = false;
  constructor(private respond: (request: any, worker: FakeWorker) => void) { super(); }
  postMessage(request: any) { queueMicrotask(() => this.respond(request, this)); }
  async terminate() { this.terminated = true; this.emit("exit", 0); return 0; }
}

test("binding errors retry once in a fresh worker; late old-worker events are ignored", async () => {
  const workers: FakeWorker[] = [];
  const client = new KernelWorkerClient(() => {
    const first = workers.length === 0;
    const worker = new FakeWorker(({ id }, self) => self.emit("message", first
      ? { id, error: "Extrude 1: Expected null or instance of NCollection_List_TopoDS_Shape, got an instance of TopoDS_Shape" }
      : { id, result: "valid solid" }));
    workers.push(worker);
    return worker;
  });
  assert.equal(await client.call("rebuild", []), "valid solid");
  assert.equal(workers.length, 2);
  assert.ok(workers[0].terminated);
  workers[0].emit("exit", 0);
  assert.equal(await client.call("rebuild", []), "valid solid");
  assert.equal(workers.length, 2);
  await client.close();
});

test("invalid geometry is returned without retry and repeated binding failure is bounded", async () => {
  for (const [message, count] of [["Open sketch profile", 1], ["memory access out of bounds", 2]] as const) {
    let made = 0;
    const client = new KernelWorkerClient(() => {
      made++;
      return new FakeWorker(({ id }, self) => self.emit("message", { id, error: message }));
    });
    await assert.rejects(client.call("rebuild", []), new RegExp(message));
    assert.equal(made, count);
    await client.close();
  }
});

test("a stalled kernel is terminated and the next request can run", async () => {
  let made = 0;
  const workers: FakeWorker[] = [];
  const client = new KernelWorkerClient(() => {
    const first = made++ === 0;
    const worker = new FakeWorker(({ id }, self) => { if (!first) self.emit("message", { id, result: 42 }); });
    workers.push(worker);
    return worker;
  }, 20);
  await assert.rejects(client.call("rebuild", []), /CAD kernel exceeded/);
  assert.ok(workers[0].terminated);
  assert.equal(await client.call("rebuild", []), 42);
  await client.close();
});

test("a WebAssembly function-table trap retries once and remains bounded", async () => {
  for (const recovers of [true, false]) {
    const workers: FakeWorker[] = [];
    const client = new KernelWorkerClient(() => {
      const first = workers.length === 0;
      const worker = new FakeWorker(({ id }, self) => self.emit("message", first || !recovers
        ? { id, error: "null function or function signature mismatch" }
        : { id, result: "recovered solid" }));
      workers.push(worker);
      return worker;
    });
    if (recovers) assert.equal(await client.call("rebuild", []), "recovered solid");
    else await assert.rejects(client.call("rebuild", []), /null function or function signature mismatch/);
    assert.equal(workers.length, 2);
    assert.ok(workers[0].terminated);
    await client.close();
  }
});
