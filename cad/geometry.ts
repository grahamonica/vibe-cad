import { Worker } from "node:worker_threads";
import type {
  Document,
  Geometry,
  TopologyRef,
  DrawingProjection,
} from "./types.ts";
// A local worker isolates the WASM kernel. Serialize requests because OCCT is not reentrant.
let worker: Worker | undefined;
let seq = 0;
let chain: Promise<unknown> = Promise.resolve();
const pending = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL(
      import.meta.url.endsWith(".mjs")
        ? "./geometry-worker.mjs"
        : "./worker-bootstrap.mjs",
      import.meta.url,
    ),
    { execArgv: [] },
  );
  worker.on("message", ({ id, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    error ? p.reject(Error(error)) : p.resolve(result);
  });
  worker.on("error", (e) => {
    for (const p of pending.values())
      p.reject(e instanceof Error ? e : Error(String(e)));
    pending.clear();
    worker = undefined;
  });
  worker.on("exit", () => {
    for (const p of pending.values()) p.reject(Error("CAD kernel stopped"));
    pending.clear();
    worker = undefined;
  });
  return worker;
}
function call<T>(method: string, args: unknown[]): Promise<T> {
  const run = () =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, method, args });
    });
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}
export const rebuild = (doc: Document) => call<Geometry>("rebuild", [doc]);
export const exportModel = (doc: Document, format: string, bodyId?: string) =>
  call<{ bytes: Uint8Array; mime: string }>("exportModel", [
    doc,
    format,
    bodyId,
  ]);
export const measureGeometry = (
  doc: Document,
  refs: TopologyRef[],
  bodyId?: string,
) => call<any>("measureGeometry", [doc, refs, bodyId]);
export const interference = (doc: Document, a: string, b: string) =>
  call<any>("interference", [doc, a, b]);
export const flatPattern = (doc: Document, bodyId: string) =>
  call<{
    width: number;
    height: number;
    bounds: [number, number, number, number];
    segments: [[number, number], [number, number]][];
    bends: { a: [number, number]; b: [number, number]; label: string }[];
    thickness: number;
  }>("flatPattern", [doc, bodyId]);
export const lineCrossings = (doc: Document, lines: { origin: [number, number, number]; direction: [number, number, number] }[]) =>
  call<{ bodyId: string; enter: number; exit: number }[][]>("lineCrossings", [doc, lines]);
export const motionSweep = (
  doc: Document,
  moving: string[],
  motion: { kind: "rotate" | "translate"; origin: [number, number, number]; direction: [number, number, number]; from: number; to: number; steps: number },
  against?: string[],
  followers: { ids: string[]; origin: [number, number, number]; direction: [number, number, number]; factor: number; mesh: number[]; meshTolerance: number; meshPeriod?: number }[] = [],
) => call<any>("motionSweep", [doc, moving, motion, against, followers]);
export const interferences = (doc: Document, only?: string[], excludeHidden = false) =>
  call<{ interferes: boolean; pairs: { a: string; b: string; aName: string; bName: string; volume: number }[]; bodies: number; checked: number }>("interferences", [doc, only, excludeHidden]);
export const mechanismSweep = (
  doc: Document,
  driver: string,
  motion: { kind: "rotate" | "translate"; origin: [number, number, number]; direction: [number, number, number]; from: number; to: number; steps: number },
  against?: string[],
  meshed: { a: string[]; b: string[]; tolerance: number }[] = [],
) => call<any>("mechanismSweep", [doc, driver, motion, against, meshed]);
export const faceOutline = (doc: Document, ref: TopologyRef) =>
  call<{
    entities: (
      | { kind: "line"; a: [number, number]; b: [number, number] }
      | { kind: "circle"; center: [number, number]; radius: number }
      | { kind: "arc"; center: [number, number]; radius: number; start: number; end: number }
      | { kind: "polyline"; points: [number, number][] }
    )[];
    width: number;
    height: number;
    thickness?: number;
  }>("faceOutline", [doc, ref]);
export const projectEdges = (doc: Document, sketchId: string, refs: TopologyRef[]) =>
  call<{ ref: TopologyRef; type: "line" | "circle" | "arc"; values: Record<string, number> }[]>("projectEdges", [doc, sketchId, refs]);
export async function closeKernel() {
  await worker?.terminate();
  worker = undefined;
}

export const renderDrawing = (doc: Document, drawingId: string, format: "svg" | "pdf" | "dxf" = "svg") =>
  call<{
    drawingId: string;
    revision: number;
    svg: string;
    pdf?: Uint8Array;
    dxf?: string;
    projection: string;
    width: number;
    height: number;
    views: DrawingProjection[];
    labels: { id: string; view: string; at: [number, number] }[];
  }>("renderDrawing", [doc, drawingId, format]);
