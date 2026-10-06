import test from "node:test";
import assert from "node:assert/strict";
import { createDeflate, deflateSync, constants } from "node:zlib";
import { receiveView } from "../editor/view-stream.ts";
import type { View } from "../cad/types.ts";
const bodies = [
  {
    id: "component-1/body",
    name: "Chassis",
    mesh: {
      vertices: [0, 0, 0, 1.234567891, 0, 0],
      normals: [],
      triangles: [],
      faceGroups: [],
    },
    topology: [{ id: "stable-face-id", kind: "face" }],
  },
  {
    id: "component-2/body",
    name: "Wheel",
    mesh: { vertices: [1, 2, 3], normals: [], triangles: [], faceGroups: [] },
    topology: [],
  },
];
const view = {
  document: { id: "model", revision: 7, name: "Rook 🔧" },
  geometry: { bodies, warnings: [] },
} as unknown as View;
const header =
  JSON.stringify({
    type: "header",
    view: { ...view, geometry: { ...view.geometry, bodies: [] } },
    bodyCount: 2,
  }) + "\n";
const body = (index: number) =>
  JSON.stringify({ type: "body", body: bodies[index] }) + "\n";
const done = JSON.stringify({ type: "complete" }) + "\n";
test("stream displays the first complete part before remaining bytes arrive, preserving CAD identities and precision", async () => {
  let controller!: ReadableStreamDefaultController<BufferSource>;
  const bytes = new ReadableStream<BufferSource>({
    start(c) {
      controller = c;
    },
  });
  const zip = createDeflate();
  zip.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
  zip.on("end", () => controller.close());
  zip.on("error", (e) => controller.error(e));
  const progress: number[] = [];
  let first!: () => void;
  const firstPart = new Promise<void>((resolve) => (first = resolve));
  const result = receiveView(bytes, (_, count) => {
    progress.push(count);
    if (count === 1) first();
  });
  zip.write(header + body(0));
  zip.flush(constants.Z_SYNC_FLUSH);
  const timeout = setTimeout(
    () => controller.error(Error("First part was not streamed")),
    10000,
  );
  try {
    await firstPart;
    assert.deepEqual(progress, [0, 1]);
    zip.end(body(1) + done);
    assert.deepEqual(await result, view);
    assert.deepEqual(progress, [0, 1, 2]);
  } finally {
    clearTimeout(timeout);
    zip.destroy();
  }
});
for (const [name, records] of [
  ["interrupted stream", header + body(0)],
  ["duplicate body", header + body(0) + body(0) + done],
  ["premature completion", header + body(0) + done],
  [
    "extra record after completion",
    header + body(0) + body(1) + done + body(0),
  ],
] as const) {
  test(name + " rejects incomplete or mixed geometry", async () => {
    const data = new Uint8Array(deflateSync(records));
    const bytes = new ReadableStream<BufferSource>({
      start(c) {
        c.enqueue(data);
        c.close();
      },
    });
    await assert.rejects(receiveView(bytes, () => {}));
  });
}
