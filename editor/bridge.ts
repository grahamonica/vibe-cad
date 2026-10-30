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
let completeDocumentId: string | undefined;
export function onTransfer(fn: (state: ViewTransfer) => void) {
  transferListener = fn;
}
const editorSessionId=globalThis.crypto.randomUUID();
let editorDocumentId:string|undefined,editorDirty=false,closed=false,registrySupported=true;
let closeListener:(()=>void)|undefined,editorTimer:ReturnType<typeof setInterval>|undefined;
export function onEditorClosed(fn:()=>void){closeListener=fn;}
export function setEditorDirty(dirty:boolean){const changed=editorDirty!==dirty;editorDirty=dirty;if(changed)void editorRegistry('heartbeat');}
export const editorAlive=()=>!closed;
function retireEditor(){if(closed)return;closed=true;listener=undefined;transferGeneration++;if(editorTimer)clearInterval(editorTimer);closeListener?.();}
async function editorRegistry(action:'register'|'heartbeat'|'close'|'close_others'){
 if(!app||!registrySupported||!editorDocumentId)return;
 try{
  const r=await app.callServerTool({name:'manage_editors',arguments:{action,sessionId:editorSessionId,documentId:editorDocumentId,dirty:editorDirty},_meta:{'vibe-cad/source':'user'}});
  if(r.isError){registrySupported=false;return;}
  const result=r.structuredContent as {closeRequested?:boolean}|undefined;
  if(result?.closeRequested&&!editorDirty){retireEditor();await app.requestTeardown().catch(()=>{});}
 }catch{registrySupported=false;}
}
export function noteEditorDocument(id:string){if(closed||editorDocumentId===id)return;editorDocumentId=id;void editorRegistry('register');}
export async function closeEditor(){if(editorDirty)throw Error('Finish or cancel unsaved edits before closing');await editorRegistry('heartbeat');await editorRegistry('close');if(!closed){retireEditor();await app?.requestTeardown();}}
export async function closeOtherEditors(){await editorRegistry('close_others');}
export async function initialize() {
  if (ready) return ready;
  app = new App(
    { name: "Vibe CAD", version: "1.1.2" },
    { availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: false },
  );
  app.ontoolresult = async (result) => {
    try {
      const id=(result.structuredContent as any)?.document?.id;
      if(id)noteEditorDocument(id);
      const view = await readToolView(result._meta, id);
      if (view) listener?.(view);
    } catch { /* transfer status presents one recoverable error, not an unhandled rejection */ }
  };
  app.onteardown = async () => {
    retireEditor();
    transferGeneration++;
    transferListener?.({ active: false, received: 0, total: 0 });
    return {};
  };
  ready = app.connect();
  await ready;
  editorTimer=setInterval(()=>{if(!closed)void editorRegistry('heartbeat');},1000);
}
async function readToolView(
  meta: Record<string, unknown> | undefined,
  hintDocumentId?: string,
  recover = true,
): Promise<View | undefined> {
  if(closed)return;
  if (meta?.view) {
    transferGeneration++;
    transferListener?.({ active: false, received: 0, total: 0 });
    completeDocumentId=(meta.view as View).document.id;
    return meta.view as View;
  }
  const snapshot = meta?.viewChunks as
    { uriPrefix: string; count: number; encoding: string; documentId?: string } | undefined;
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
  const replacing = completeDocumentId === (snapshot.documentId ?? hintDocumentId);
  let index = 0,
    received = 0,
    total = 0,
    publishedAt = 0;
  transferListener?.({ active: true, received, total });
  const compressed = new ReadableStream<BufferSource>({
    async pull(controller) {
      try {
        if (closed || generation !== transferGeneration)
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
      if (!replacing && (
        count <= 1 ||
        count === bodyCount ||
        performance.now() - publishedAt > 80
      )) {
        publishedAt = performance.now();
        listener?.(partial);
      }
    });
    if (generation !== transferGeneration) return;
    transferListener?.({ active: false, received, total });
    completeDocumentId=view.document.id;
    return view;
  } catch (e) {
    if (generation !== transferGeneration) return;
    const documentId = snapshot.documentId ?? hintDocumentId;
    if (recover && documentId && /snapshot.*unavailable|snapshot.*missing/i.test((e as Error).message)) {
      try {
      const refreshed = await app!.callServerTool({ name: 'inspect_document', arguments: { documentId }, _meta: { 'vibe-cad/source': 'user' } });
      if (generation !== transferGeneration) return;
      if (!refreshed.isError) return readToolView(refreshed._meta, documentId, false);
      } catch { /* report a recoverable transfer error below */ }
    }
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
  return ((await readToolView(result._meta, (result.structuredContent as any)?.document?.id)) ?? result.structuredContent) as T;
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
