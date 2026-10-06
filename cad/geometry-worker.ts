import { parentPort } from "node:worker_threads";
import {
  rebuild,
  exportModel,
  measureGeometry,
  interference,
  interferences,
  renderDrawing,
  projectEdges,
  flatPattern,
  faceOutline,
  motionSweep,
  mechanismSweep,
  lineCrossings,
} from "./kernel.ts";
parentPort!.on("message", async ({ id, method, args }) => {
  try {
    const functions = {
      rebuild,
      exportModel,
      measureGeometry,
      interference,
      interferences,
      renderDrawing,
      projectEdges,
      flatPattern,
      faceOutline,
      motionSweep,
      mechanismSweep,
      lineCrossings,
    };
    const result = await (functions[method as keyof typeof functions] as any)(
      ...args,
    );
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
