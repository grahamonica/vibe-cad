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

test("native faults are reported once, retire their worker, and never replay the operation", async () => {
  for (const message of [
    "Expected null or instance of NCollection_List_TopoDS_Shape, got an instance of TopoDS_Shape",
    "memory access out of bounds",
    "null function or function signature mismatch",
  ]) {
    const workers: FakeWorker[] = [];
    const client = new KernelWorkerClient(() => {
      const first = workers.length === 0;
      const worker = new FakeWorker(({ id }, self) => self.emit("message", first ? { id, error: message } : { id, result: 42 }));
      workers.push(worker); return worker;
    });
    await assert.rejects(client.call("rebuild", []), error => (error as Error).message === message);
    assert.equal(workers.length, 1);
    assert.ok(workers[0].terminated);
    assert.equal(await client.call("rebuild", []), 42);
    workers[0].emit("exit", 0);
    assert.equal(await client.call("rebuild", []), 42);
    assert.equal(workers.length, 2);
    await client.close();
  }
});

test("invalid geometry leaves the healthy worker available", async () => {
  let made = 0;
  const client = new KernelWorkerClient(() => {
    made++;
    return new FakeWorker(({ id }, self) => self.emit("message", { id, error: "Open sketch profile" }));
  });
  await assert.rejects(client.call("rebuild", []), /Open sketch profile/);
  await assert.rejects(client.call("rebuild", []), /Open sketch profile/);
  assert.equal(made, 1);
  await client.close();
});

test("timeout cancels queued work and waits for termination before a later explicit request", async () => {
  const workers: FakeWorker[] = [];
  const client = new KernelWorkerClient(() => {
    const first = workers.length === 0;
    const worker = new FakeWorker(({ id }, self) => { if (!first) self.emit("message", { id, result: 42 }); });
    workers.push(worker); return worker;
  }, 20);
  await Promise.all([
    assert.rejects(client.call("rebuild", []), /CAD kernel exceeded/),
    assert.rejects(client.call("rebuild", []), /cancelled/),
  ]);
  assert.equal(workers.length, 1);
  assert.ok(workers[0].terminated);
  assert.equal(await client.call("rebuild", []), 42);
  await client.close();
});
