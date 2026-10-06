import type { Document } from "./types.ts";
import { canonical } from "./project-format.ts";
import { validateDocument } from "./validate.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Read previously exported designs without changing their saved contents.
const LEGACY_DESIGN_FORMAT = "vibe-cad-chatgpt/1";
export const PROJECT_FILE_FORMAT = "vibe-cad-project/1";
const maxBytes = 128 * 1024 * 1024;
const hash = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
function clean(document: Document): Document {
  const { linked: _, blobs: __, ...saved } = structuredClone(document);
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(saved.id) ||
    !Number.isSafeInteger(saved.revision) ||
    saved.revision < 0 ||
    typeof saved.owner !== "string" ||
    typeof saved.name !== "string"
  )
    throw Error("Invalid saved CAD document identity");
  for (const key of [
    "sketches",
    "features",
    "bodies",
    "intents",
    "selection",
    "history",
  ] as const)
    if (!Array.isArray(saved[key]))
      throw Error("Invalid saved CAD document state");
  if (
    !Number.isInteger(saved.historyIndex) ||
    saved.historyIndex < 0 ||
    saved.historyIndex >= saved.history.length
  )
    throw Error("Invalid saved CAD history");
  validateDocument(saved);
  return saved;
}
function referenced(document: Document) {
  const states = [document, ...document.history.map((entry) => entry.snapshot)];
  return {
    documents: new Set(
      states.flatMap((state) =>
        (state.components ?? []).flatMap((component) =>
          component.source ? [component.source.documentId] : [],
        ),
      ),
    ),
    blobs: new Set(
      states.flatMap((state) =>
        state.features
          .filter((feature) => feature.type === "import")
          .map((feature) => String(feature.params.blob)),
      ),
    ),
  };
}
export function packProject(
  root: Document,
  related: Document[] = [],
  blobs: Record<string, Uint8Array> = {},
  format = PROJECT_FILE_FORMAT,
) {
  const documents: Record<string, Document> = Object.create(null);
  for (const document of [root, ...related]) {
    if (Object.hasOwn(documents, document.id))
      throw Error("Duplicate CAD document in saved file");
    documents[document.id] = clean(document);
  }
  const encoded: Record<string, string> = Object.create(null);
  for (const document of Object.values(documents)) {
    const references = referenced(document);
    for (const id of references.documents)
      if (!Object.hasOwn(documents, id))
        throw Error("A referenced CAD part is missing from the saved file");
    for (const key of references.blobs) {
      const bytes = blobs[key];
      if (!bytes || hash(bytes) !== key)
        throw Error("An imported CAD file is missing or corrupt");
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 32768),
        );
      encoded[key] = btoa(binary);
    }
  }
  const text = canonical({ format, root: root.id, documents, blobs: encoded });
  if (new TextEncoder().encode(text).length > maxBytes)
    throw Error("CAD design exceeds the 128 MB saved-file limit");
  return text;
}
export function unpackProject(text: string) {
  if (new TextEncoder().encode(text).length > maxBytes)
    throw Error("CAD design exceeds the 128 MB saved-file limit");
  const value = JSON.parse(text);
  if (
    ![LEGACY_DESIGN_FORMAT, PROJECT_FILE_FORMAT].includes(value?.format) ||
    typeof value.root !== "string" ||
    !value.documents ||
    !value.blobs ||
    Array.isArray(value.documents) ||
    Array.isArray(value.blobs)
  )
    throw Error("Not a saved Vibe CAD project");
  const documents: Record<string, Document> = Object.create(null);
  const entries = Object.entries(value.documents);
  if (!entries.length || entries.length > 500)
    throw Error("Invalid saved CAD document count");
  for (const [id, raw] of entries) {
    const document = clean(raw as Document);
    if (document.id !== id)
      throw Error("Saved CAD document ID does not match its key");
    documents[id] = document;
  }
  if (!Object.hasOwn(documents, value.root))
    throw Error("Saved CAD root document is missing");
  const blobs: Record<string, Uint8Array> = Object.create(null);
  for (const [key, raw] of Object.entries(value.blobs)) {
    if (
      !/^[0-9a-f]{64}$/.test(key) ||
      typeof raw !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        raw,
      )
    )
      throw Error("Invalid saved CAD import encoding");
    const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
    if (hash(bytes) !== key)
      throw Error("Saved CAD import integrity check failed");
    blobs[key] = bytes;
  }
  for (const document of Object.values(documents)) {
    const refs = referenced(document);
    for (const id of refs.documents)
      if (!Object.hasOwn(documents, id))
        throw Error("A saved CAD part is missing");
    for (const key of refs.blobs)
      if (!Object.hasOwn(blobs, key))
        throw Error("A saved CAD import is missing");
  }
  return { root: documents[value.root], documents, blobs };
}
