import type { View } from "../cad/types.ts";
import { App } from "@modelcontextprotocol/ext-apps";
import { receiveView } from "./view-stream.ts";

let app: App | undefined;
let ready: Promise<void> | undefined;
let listener: ((view: View) => void) | undefined;
export function onView(fn: (view: View) => void) {
  listener = fn;
}
export interface ViewTransfer {
  active: boolean;
  received: number;
  total: number;
  error?: string;
}
let transferListener: ((state: ViewTransfer) => void) | undefined;
let transferGeneration = 0;
export function onTransfer(fn: (state: ViewTransfer) => void) {
  transferListener = fn;
}
export async function initialize() {
  if (ready) return ready;
  app = new App(
    { name: "Vibe CAD", version: "1.0.0" },
    { availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: false },
  );
  app.ontoolresult = async (result) => {
    const view = await readToolView(result._meta);
    if (view) listener?.(view);
  };
  app.onteardown = async () => {
    transferGeneration++;
    transferListener?.({ active: false, received: 0, total: 0 });
    return {};
  };
  ready = app.connect();
  await ready;
}
async function readToolView(
  meta: Record<string, unknown> | undefined,
): Promise<View | undefined> {
  if (meta?.view) {
    transferGeneration++;
    transferListener?.({ active: false, received: 0, total: 0 });
    return meta.view as View;
  }
  const snapshot = meta?.viewChunks as
    { uriPrefix: string; count: number; encoding: string } | undefined;
  if (!snapshot) return;
  if (
    !app ||
    snapshot.encoding !== "deflate-ndjson-base64" ||
    !Number.isInteger(snapshot.count) ||
    snapshot.count < 1 ||
    snapshot.count > 128
  )
    throw Error("Invalid CAD editor snapshot");
  const generation = ++transferGeneration;
  let index = 0,
    received = 0,
    total = 0,
    publishedAt = 0;
  transferListener?.({ active: true, received, total });
  const compressed = new ReadableStream<BufferSource>({
    async pull(controller) {
      try {
        if (generation !== transferGeneration)
          throw Error("CAD view was superseded");
        if (index === snapshot.count) {
          controller.close();
          return;
        }
        const resource = await app!.readServerResource({
          uri: `${snapshot.uriPrefix}${index}`,
        });
        const item = resource.contents[0];
        if (!item || !("text" in item))
          throw Error("CAD editor snapshot chunk is missing");
        const chunk = JSON.parse(item.text) as {
          index: number;
          count: number;
          data: string;
        };
        if (chunk.index !== index || chunk.count !== snapshot.count)
          throw Error("CAD editor snapshot chunks do not match");
        index++;
        controller.enqueue(
          Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)),
        );
      } catch (e) {
        controller.error(e);
      }
    },
  });
  try {
    const view = await receiveView(compressed, (partial, count, bodyCount) => {
      if (generation !== transferGeneration) return;
      received = count;
      total = bodyCount;
      transferListener?.({ active: true, received, total });
      if (
        count <= 1 ||
        count === bodyCount ||
        performance.now() - publishedAt > 80
      ) {
        publishedAt = performance.now();
        listener?.(partial);
      }
    });
    if (generation !== transferGeneration) return;
    transferListener?.({ active: false, received, total });
    return view;
  } catch (e) {
    if (generation !== transferGeneration) return;
    transferListener?.({
      active: false,
      received,
      total,
      error: (e as Error).message,
    });
    throw e;
  }
}
export async function call<T = any>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  await ready;
  if (!app) throw Error("Host bridge is not connected");
  const result = await app.callServerTool(
    {
      name,
      arguments: args,
      _meta: { "vibe-cad/source": "user" },
    },
    { timeout: 600_000 },
  );
  if (result.isError)
    throw Error(
      result.content?.find((c) => c.type === "text")?.text ??
        "CAD operation failed",
    );
  const file = result._meta?.download as
    { filename: string; mimeType: string; base64: string } | undefined;
  if (file) {
    const data = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    return {
      ...(result.structuredContent as Record<string, unknown>),
      filename: file.filename,
      mimeType: file.mimeType,
      data,
    } as T;
  }
  return ((await readToolView(result._meta)) ?? result.structuredContent) as T;
}
export async function context(view: View) {
  if (!app) return;
  await app.updateModelContext({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          documentId: view.document.id,
          revision: view.document.revision,
          selection: view.document.selection,
          viewport: view.document.viewport,
        }),
      },
    ],
  });
}
export async function fullscreen() {
  await app?.requestDisplayMode({ mode: "fullscreen" });
}

export async function download(result: {
  filename: string;
  mimeType: string;
  data?: Uint8Array;
}) {
  const url = result.data
    ? URL.createObjectURL(
        new Blob([new Uint8Array(result.data)], { type: result.mimeType }),
      )
    : undefined;
  if (!url) throw Error("Export download is unavailable");
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  if (result.data) setTimeout(() => URL.revokeObjectURL(url), 1000);
}
