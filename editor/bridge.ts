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
let resumeState:{documentId:string;sessionId:string}|undefined;
try{if((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)?.type==='reload'){const r=JSON.parse(sessionStorage.getItem('vibe-cad:resume')??'null');if(typeof r?.documentId==='string'&&typeof r?.sessionId==='string')resumeState=r;}sessionStorage.removeItem('vibe-cad:resume');}catch{}
let editorSessionId=resumeState?.sessionId??globalThis.crypto.randomUUID();
function hostSessionId(){const id=app?.getHostContext()?.toolInfo?.id;return id===undefined?undefined:`tool:${String(id)}`;}
export function takeResumeDocument(){const id=resumeState?.documentId;resumeState=undefined;return id;}
let editorDocumentId:string|undefined,registeredDocumentId:string|undefined,editorDirty=false,interactionDirty=false,draftDirty=false,closed=false,registrySupported=true,registryPending=0;
let registryQueue:Promise<unknown>=Promise.resolve();
let closeListener:(()=>void)|undefined,editorTimer:ReturnType<typeof setInterval>|undefined;
export function onEditorClosed(fn:()=>void){closeListener=fn;}
function updateDirty(){const dirty=draftDirty||interactionDirty,changed=editorDirty!==dirty;editorDirty=dirty;if(changed)void editorRegistry('heartbeat').catch(()=>{});}
export function setEditorDirty(dirty:boolean){draftDirty=dirty;updateDirty();}
export function setInteractionDirty(dirty:boolean){interactionDirty=dirty;updateDirty();}
export const editorAlive=()=>!closed;
function retireEditor(){if(closed)return;closed=true;listener=undefined;transferGeneration++;if(editorTimer)clearInterval(editorTimer);closeListener?.();}
async function editorRegistry(action:'register'|'heartbeat'|'close'|'close_others'|'teardown_ack'){
 if(!app||!registrySupported||!editorDocumentId||action==='heartbeat'&&registryPending)return;
 registryPending++;const documentId=editorDocumentId;
 const task=registryQueue.catch(()=>{}).then(async()=>{
  if(closed&&action!=='teardown_ack')return;
  const operation=action==='heartbeat'&&registeredDocumentId!==documentId?'register':action;
  const r=await app!.callServerTool({name:'manage_editors',arguments:{action:operation,sessionId:editorSessionId,documentId,dirty:editorDirty},_meta:{'vibe-cad/source':'user'}},{timeout:5000});
  if(r.isError){const message=r.content?.find(c=>c.type==='text')?.text??'Editor lifecycle request failed';if(/unknown tool|not found|unknown operation/i.test(message))registrySupported=false;throw Error(message);}
  if(operation==='register')registeredDocumentId=documentId;
  const result=r.structuredContent as {closeRequested?:boolean;reloadRequested?:boolean;registerRequired?:boolean}|undefined;
  if(result?.registerRequired)registeredDocumentId=undefined;
  if(action!=='teardown_ack'&&result?.closeRequested&&!editorDirty){retireEditor();await app!.requestTeardown().catch(()=>{});}
  else if(result?.reloadRequested&&!editorDirty)await performReload();
 }).finally(()=>{registryPending--;});
 registryQueue=task;
 return task;
}
export async function noteEditorDocument(id:string){if(closed||editorDocumentId===id&&registeredDocumentId===id)return;editorDocumentId=id;await editorRegistry('register');}
export async function closeEditor(){if(editorDirty)throw Error('Finish or cancel unsaved edits before closing');await editorRegistry('heartbeat');await editorRegistry('close');if(!closed){retireEditor();await app?.requestTeardown();}}
export async function closeOtherEditors(){await editorRegistry('close_others');}
async function performReload(){
 if(closed)return;if(editorDirty)throw Error('Finish or cancel unsaved edits before reloading');
 try{sessionStorage.setItem('vibe-cad:resume',JSON.stringify({documentId:editorDocumentId,sessionId:editorSessionId}));}
 catch{if(!hostSessionId())throw Error('This host provides neither session storage nor a stable panel identity for reload. Close this tab with × and reopen the saved design.');}
 retireEditor();
 await new Promise<void>(resolve=>setTimeout(resolve,50));window.location.reload();
}
export async function reloadEditor(discardUnsaved=false){if(discardUnsaved){draftDirty=false;interactionDirty=false;updateDirty();}await editorRegistry('heartbeat');await performReload();}
export async function initialize() {
  if (ready) return ready;
  app = new App(
    { name: "Vibe CAD", version: "1.1.3" },
    { availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: false },
  );
  app.ontoolresult = async (result) => {
    try {
      await ready;
      const id=(result.structuredContent as any)?.document?.id;
      if(id&&editorDocumentId&&id!==editorDocumentId)return;
      if(id)await noteEditorDocument(id);
      const view = await readToolView(result._meta, id);
      if (view) listener?.(view);
    } catch(error) {transferListener?.({active:false,received:0,total:0,error:error instanceof Error?error.message:'The editor could not load the saved design.'});}
  };
  app.onteardown = async () => {
    retireEditor();
    await editorRegistry('teardown_ack').catch(()=>{});
    transferGeneration++;
    transferListener?.({ active: false, received: 0, total: 0 });
    return {};
  };
  const connected=app.connect();
  ready=(async()=>{
    await connected;
    const identity=hostSessionId();if(identity)editorSessionId=identity;
    if(!resumeState&&identity){
      try{const r=await app!.callServerTool({name:'manage_editors',arguments:{action:'resume',sessionId:editorSessionId},_meta:{'vibe-cad/source':'user'}},{timeout:5000});const id=(r.structuredContent as any)?.resumeDocumentId;if(!r.isError&&typeof id==='string')resumeState={documentId:id,sessionId:editorSessionId};}catch{}
    }
    if(resumeState)editorDocumentId=resumeState.documentId;
    editorTimer=setInterval(()=>{if(!closed)void editorRegistry('heartbeat').catch(()=>{});},5000);
  })();
  await ready;
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
  const documentId=(result.structuredContent as any)?.document?.id;
  if(documentId)await noteEditorDocument(documentId);
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
