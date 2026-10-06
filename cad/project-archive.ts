import { packProject, PROJECT_FILE_FORMAT } from "./project-file-format.ts";
import type { DocumentStore } from "./document-store.ts";
import type { Document } from "./types.ts";

/** One portable project: parametric history, associative drawings, linked parts and exact imports. */
export async function exportProject(store: DocumentStore, documentId: string) {
  const root = await store.read(documentId), related = new Map<string, Document>();
  const blobs: Record<string, Uint8Array> = Object.create(null);
  const visit = async (doc: Document) => {
    for (const state of [doc, ...doc.history.map(h => h.snapshot)]) {
      for (const feature of state.features) if (feature.type === "import") {
        const hash = String(feature.params.blob);
        if (!Object.hasOwn(blobs, hash)) blobs[hash] = await store.getBlob(hash);
      }
      for (const component of state.components ?? []) {
        const id = component.source?.documentId;
        if (!id || id === root.id || related.has(id)) continue;
        if (related.size >= 499) throw Error("Project contains too many linked parts");
        const part = await store.read(id);
        related.set(id, part);
        await visit(part);
      }
    }
  };
  await visit(root);
  return packProject(root, [...related.values()], blobs, PROJECT_FILE_FORMAT);
}
