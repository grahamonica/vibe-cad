import { snapshot } from "./types.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { findTopology } from "./topology-key.ts";
import { validateDocument } from "./validate.ts";
import { applyEquations } from "./equations.ts";
import type { Document, Geometry, View, Preview } from "./types.ts";
import type { Material } from "./standards.ts";

/** Converted sketch edges follow the model: keep the saved sketch in step with the rebuild. */
function applySketchUpdates(doc: Pick<Document, "sketches">, geometry: Geometry) {
  for (const [sketchId, values] of Object.entries(geometry.sketchUpdates ?? {})) {
    const s = doc.sketches.find((x) => x.id === sketchId);
    if (s) for (const e of s.entities) if (values[e.id]) e.values = { ...values[e.id] };
  }
}
// Persistence adapters must commit the entire document atomically and reject a
// revision mismatch. UI and assistant commands share this state machine.
export interface DocumentMetadata { id: string; owner: string; name: string; revision: number; updatedAt: string; bodyCount: number }
export interface DocumentPersistence {
  listMetadata?(): Promise<DocumentMetadata[]>;
  readonly directory: string;
  /** "project" when designs are git-friendly folders in a workspace. */
  readonly kind?: "project";
  list(): Promise<Document[]>;
  read(id: string): Promise<Document>;
  commit(doc: Document, expectedRevision: number | null): Promise<void>;
  /** Imported files, stored once by content hash outside the document and its history. */
  putBlob?(hash: string, bytes: Uint8Array): Promise<void>;
  getBlob?(hash: string): Promise<Uint8Array>;
  /** Small user libraries (such as custom materials) shared by every document. */
  readLibrary?(name: string): Promise<unknown>;
  writeLibrary?(name: string, value: unknown): Promise<void>;
}
export class DocumentStore {
  readonly directory: string;
  private locks = new Map<string, Promise<unknown>>();
  private previews = new Map<string, Preview>();
  private cache = new Map<string, { revision: number; links: string; geometry: Geometry }>();
  constructor(
    private readonly persistence: DocumentPersistence,
    private readonly build: (doc: Document) => Promise<Geometry>,
    private readonly uuid: () => string = () => globalThis.crypto.randomUUID(),
  ) {
    this.directory = persistence.directory;
  }
  /**
   * Documents inserted into `doc` as parts, transitively, keyed by id. Rejects
   * circular inserts and parts that no longer exist.
   */
  /** Whether designs live as project folders in a workspace that git can version. */
  get project() {
    return this.persistence.kind === "project";
  }
  /** Materials the user saved, shared by every document; the built-in library is separate. */
  async customMaterials(): Promise<Material[]> {
    const list = await this.persistence.readLibrary?.("materials");
    return Array.isArray(list) ? (list as Material[]) : [];
  }
  /** Add or replace a custom material by name. */
  async saveMaterial(material: Material) {
    return this.locked("library:materials", async () => {
      if (!this.persistence.writeLibrary) throw Error("This storage cannot save custom materials");
      const list = (await this.customMaterials()).filter((m) => m.name.toLowerCase() !== material.name.toLowerCase());
      if (list.length >= 500) throw Error("Limit of 500 custom materials reached");
      list.push(material);
      list.sort((a, b) => a.name.localeCompare(b.name));
      await this.persistence.writeLibrary("materials", list);
      return list;
    });
  }
  async deleteMaterial(name: string) {
    return this.locked("library:materials", async () => {
      const list = await this.customMaterials(),
        kept = list.filter((m) => m.name.toLowerCase() !== name.toLowerCase());
      if (kept.length === list.length) throw Error(`${name} is not a custom material`);
      await this.persistence.writeLibrary!("materials", kept);
      return kept;
    });
  }
  async linkedDocuments(doc: Document): Promise<Record<string, Document>> {
    const out: Record<string, Document> = {},
      state = new Map<string, "open" | "done">();
    const visit = async (d: Document) => {
      state.set(d.id, "open");
      for (const c of d.components ?? []) {
        const id = c.source?.documentId;
        if (!id) continue;
        if (state.get(id) === "open")
          throw Error(`${c.name} contains this assembly; an assembly cannot insert itself`);
        if (state.get(id) === "done") continue;
        let source: Document;
        try {
          source = await this.read(id, doc.owner);
        } catch {
          throw Error(`The part inserted as ${c.name} no longer exists; delete or replace the component`);
        }
        out[id] = { ...source, history: [] };
        await visit(source);
      }
      state.set(d.id, "done");
    };
    await visit(doc);
    return out;
  }
  /** Store an imported file once; returns its content hash. */
  async putBlob(bytes: Uint8Array): Promise<string> {
    if (!this.persistence.putBlob) throw Error("This storage cannot keep imported files");
    const hash = bytesToHex(sha256(bytes));
    await this.persistence.putBlob(hash, bytes);
    return hash;
  }
  async getBlob(hash: string) {
    if (!/^[0-9a-f]{64}$/.test(hash) || !this.persistence.getBlob) throw Error("Imported CAD file is unavailable");
    return this.persistence.getBlob(hash);
  }
  /** Imported files a document's features use. */
  private async blobsOf(doc: Document): Promise<Record<string, Uint8Array> | undefined> {
    const hashes = doc.features.filter((f) => f.type === "import").map((f) => f.params.blob as string);
    if (!hashes.length) return undefined;
    if (!this.persistence.getBlob) throw Error("This storage cannot read imported files");
    const out: Record<string, Uint8Array> = {};
    for (const hash of hashes)
      try {
        out[hash] = await this.persistence.getBlob(hash);
      } catch {
        throw Error("An imported file of this document is missing from storage; import it again");
      }
    return out;
  }
  /** The document with its inserted parts and imported files attached, as the kernel reads it. */
  async kernelDocument(doc: Document): Promise<Document> {
    const blobs = await this.blobsOf(doc);
    if (!doc.components?.some((c) => c.source)) return blobs ? { ...doc, blobs } : doc;
    const linked = await this.linkedDocuments(doc);
    for (const [id, part] of Object.entries(linked)) {
      const partBlobs = await this.blobsOf(part);
      if (partBlobs) linked[id] = { ...part, blobs: partBlobs };
    }
    return { ...doc, linked, ...(blobs ? { blobs } : {}) };
  }
  /** Geometry of a document and the part revisions it was built from. */
  private async rebuild(doc: Document) {
    const full = await this.kernelDocument(doc);
    const links = Object.values(full.linked ?? {})
      .map((d) => `${d.id}@${d.revision}`)
      .sort()
      .join(",");
    return { geometry: await this.build(full), links };
  }
  async list(owner = "local") {
    if (this.persistence.listMetadata) return (await this.persistence.listMetadata()).filter(d => d.owner === owner).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ owner: _, ...head }) => head);
    return (await this.persistence.list())
      .filter((d) => d.owner === owner)
      .map((d) => ({
        id: d.id,
        name: d.name,
        revision: d.revision,
        updatedAt: d.updatedAt,
        bodyCount: d.bodies.length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async read(id: string, owner = "local") {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error("Invalid document ID");
    const doc = await this.persistence.read(id);
    if (doc.owner !== owner) throw Error("Document not found");
    for (const target of [doc, ...doc.history.map((h) => h.snapshot)])
      if (target)
        for (const key of [
          "referencePlanes",
          "components",
          "mates",
          "drawings",
        ] as const)
          target[key] ??= [];
    return doc;
  }
  /**
   * Create a document and apply a first edit to it, saving nothing unless the
   * edited document validates and rebuilds (used to make a part from a file).
   */
  async createWith(
    name: string,
    description: string,
    source: "user" | "assistant",
    edit: (doc: Document) => void,
    owner = "local",
  ) {
    const empty = this.blank(name, owner, source);
    const doc = structuredClone(empty);
    edit(doc);
    applyEquations(doc);
    validateDocument(doc);
    const { geometry, links } = await this.rebuild(doc);
    doc.revision = 1;
    doc.updatedAt = new Date().toISOString();
    doc.history.push({ id: this.uuid(), revision: 1, at: doc.updatedAt, description, source, snapshot: snapshot(doc) });
    doc.historyIndex = 1;
    await this.persistence.commit(doc, null);
    this.cache.set(doc.id, { revision: doc.revision, links, geometry });
    return this.view(doc);
  }
  async create(
    name: string,
    owner = "local",
    source: "user" | "assistant" = "user",
  ) {
    const doc = this.blank(name, owner, source);
    validateDocument(doc);
    const { geometry, links } = await this.rebuild(doc);
    await this.persistence.commit(doc, null);
    this.cache.set(doc.id, { revision: doc.revision, links, geometry });
    return this.view(doc);
  }
  private blank(name: string, owner: string, source: "user" | "assistant") {
    const now = new Date().toISOString(),
      doc: Document = {
        id: this.uuid(),
        owner,
        name,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        sketches: [],
        features: [],
        bodies: [],
        intents: [],
        referencePlanes: [],
        components: [],
        mates: [],
        drawings: [],
        selection: [],
        history: [],
        historyIndex: 0,
      };
    doc.history.push({
      id: this.uuid(),
      revision: 0,
      at: now,
      description: "Created document",
      source,
      snapshot: snapshot(doc),
    });
    return doc;
  }
  async view(doc: Document): Promise<View> {
    const cached = this.cache.get(doc.id);
    // An assembly is current only while every inserted part is at the revision it was built from.
    const full = await this.kernelDocument(doc);
    const links = Object.values(full.linked ?? {})
      .map((d) => `${d.id}@${d.revision}`)
      .sort()
      .join(",");
    const geometry =
      cached?.revision === doc.revision && cached.links === links
        ? cached.geometry
        : await this.build(full);
    this.cache.set(doc.id, { revision: doc.revision, links, geometry });
    // Show converted edges where the model has them, even before the next save.
    const sketches = geometry.sketchUpdates ? structuredClone(doc.sketches) : doc.sketches;
    if (geometry.sketchUpdates) applySketchUpdates({ sketches }, geometry);
    return {
      document: {
        ...doc,
        sketches,
        history: doc.history.map(
          ({ snapshot: _, ...entry }) => entry,
        ) as Document["history"],
      },
      geometry,
      preview:
        this.previews.get(doc.id)?.baseRevision === doc.revision
          ? (({ snapshot: _, ...preview }) => preview)(
              this.previews.get(doc.id)!,
            )
          : undefined,
    };
  }
  async state(id: string) {
    const doc = await this.read(id),
      preview = this.previews.get(id);
    return {
      documentId: doc.id,
      revision: doc.revision,
      selection: doc.selection,
      viewport: doc.viewport,
      previewId: preview?.baseRevision === doc.revision ? preview.id : null,
    };
  }
  async preview(
    id: string,
    expectedRevision: number,
    description: string,
    edit: (d: Document) => void | Promise<void>,
  ) {
    return this.locked(id, async () => {
      const doc = await this.read(id);
      if (doc.revision !== expectedRevision)
        throw Error("Revision conflict; refresh before previewing");
      this.previews.delete(id);
      const next = structuredClone(doc);
      await edit(next);
      applyEquations(next);
      validateDocument(next);
      const { geometry } = await this.rebuild(next);
      this.previews.set(id, {
        id: this.uuid(),
        description,
        baseRevision: doc.revision,
        geometry,
        snapshot: snapshot(next),
      });
      return this.view(doc);
    });
  }
  async applyPreview(
    id: string,
    expectedRevision: number,
    previewId: string,
    source: "user" | "assistant",
  ) {
    const preview = this.previews.get(id);
    if (
      !preview ||
      preview.id !== previewId ||
      preview.baseRevision !== expectedRevision
    )
      throw Error("Preview is stale or no longer available");
    return this.transact(
      id,
      expectedRevision,
      preview.description,
      source,
      (d) => {
        const {
          sketches,
          features,
          bodies,
          intents,
          referencePlanes,
          components,
          mates,
          componentPatterns,
          drawings,
          material,
          units,
          variables,
          massOverride,
          weightLimit,
        } = structuredClone(preview.snapshot);
        Object.assign(d, {
          sketches,
          features,
          bodies,
          intents,
          referencePlanes,
          components,
          mates,
          componentPatterns,
          drawings,
          material,
          units,
          variables: variables ?? [],
          massOverride,
          weightLimit,
        });
      },
    );
  }
  async dismissPreview(id: string) {
    return this.locked(id, async () => {
      this.previews.delete(id);
      return this.view(await this.read(id));
    });
  }
  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) ?? Promise.resolve(),
      next = prior.then(fn, fn);
    this.locks.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }
  async transact(
    id: string,
    expectedRevision: number,
    description: string,
    source: "user" | "assistant",
    edit: (doc: Document) => void | Promise<void>,
    owner = "local",
  ): Promise<View> {
    return this.locked(id, async () => {
      const doc = await this.read(id, owner);
      if (doc.revision !== expectedRevision)
        throw Error(
          `Revision conflict: expected ${expectedRevision}, current ${doc.revision}. Inspect the document and retry.`,
        );
      const next = structuredClone(doc);
      await edit(next);
      if (next.features.length > 200)
        throw Error("Limit of 200 features reached");
      applyEquations(next);
      validateDocument(next);
      const { geometry, links } = await this.rebuild(next);
      applySketchUpdates(next, geometry);
      for (const sheet of next.drawings ?? [])
        for (const dim of [
          ...sheet.dimensions,
          ...((sheet.annotations ?? []) as any[]).map((a) => ({
            refs: "refs" in a ? a.refs : undefined,
            reference: "ref" in a ? a.ref : a.leader?.ref,
          })),
        ])
          for (const ref of [
            ...(dim.refs ?? []),
            ...(dim.reference ? [dim.reference] : []),
            ...((dim as any).points ?? []).map((p: any) => p.ref),
          ]) {
            if (!findTopology(geometry.bodies.flatMap((b) => b.topology), ref))
              throw Error(
                "Drawing dimension no longer resolves; remove or reselect the dimension",
              );
          }
      next.selection = next.selection.filter((ref) =>
        findTopology(geometry.bodies.flatMap((b) => b.topology), ref),
      );
      for (const intent of next.intents.filter((i) => i.kind === "hard")) {
        if (intent.featureId && intent.dimension) {
          const feature = next.features.find((f) => f.id === intent.featureId),
            entity = next.sketches
              .flatMap((s) => s.entities)
              .find((e) => e.id === intent.featureId);
          const value =
            feature?.params[intent.dimension] ??
            entity?.values[intent.dimension];
          if (value === undefined || typeof value !== "number")
            throw Error(`Design intent target cannot resolve: ${intent.text}`);
          if (
            (intent.min !== undefined && value < intent.min) ||
            (intent.max !== undefined && value > intent.max)
          )
            throw Error(`Design intent violated: ${intent.text}`);
        }
      }
      next.revision++;
      next.updatedAt = new Date().toISOString();
      next.history = next.history.slice(0, next.historyIndex + 1);
      next.history.push({
        id: this.uuid(),
        revision: next.revision,
        at: next.updatedAt,
        description,
        source,
        snapshot: snapshot(next),
      });
      if (next.history.length > 200) next.history.shift();
      next.historyIndex = next.history.length - 1;
      await this.persistence.commit(next, doc.revision);
      this.previews.delete(id);
      this.cache.set(id, { revision: next.revision, links, geometry });
      return this.view(next);
    });
  }
  async setContext(
    id: string,
    selection: Document["selection"],
    viewport?: Document["viewport"],
    owner = "local",
  ) {
    return this.locked(id, async () => {
      const doc = await this.read(id, owner),
        view = await this.view(doc);
      for (const ref of selection)
        if (!findTopology(view.geometry.bodies.flatMap((b) => b.topology), ref))
          throw Error("Selection no longer exists; reselect geometry");
      doc.selection = selection;
      if (viewport) doc.viewport = viewport;
      await this.persistence.commit(doc, doc.revision);
      return this.view(doc);
    });
  }
  async history(
    id: string,
    expectedRevision: number,
    direction: "undo" | "redo",
    owner = "local",
  ) {
    return this.locked(id, async () => {
      const doc = await this.read(id, owner);
      if (doc.revision !== expectedRevision)
        throw Error("Revision conflict; refresh the document");
      const index = doc.historyIndex + (direction === "undo" ? -1 : 1);
      if (index < 0 || index >= doc.history.length)
        throw Error(`Nothing to ${direction}`);
      const next = {
        ...doc,
        ...structuredClone(doc.history[index].snapshot),
        // Absent in snapshots taken before a material or units were set.
        material: structuredClone(doc.history[index].snapshot.material),
        componentPatterns: structuredClone(doc.history[index].snapshot.componentPatterns ?? []),
        units: doc.history[index].snapshot.units,
        massOverride: doc.history[index].snapshot.massOverride,
        weightLimit: doc.history[index].snapshot.weightLimit,
        variables: structuredClone(doc.history[index].snapshot.variables ?? []),
        historyIndex: index,
        revision: doc.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      validateDocument(next);
      const { geometry, links } = await this.rebuild(next);
      applySketchUpdates(next, geometry);
      await this.persistence.commit(next, doc.revision);
      this.previews.delete(id);
      this.cache.set(id, { revision: next.revision, links, geometry });
      return this.view(next);
    });
  }
  async restore(
    id: string,
    expectedRevision: number,
    historyId: string,
    owner = "local",
  ) {
    const doc = await this.read(id, owner),
      entry = doc.history.find((h) => h.id === historyId);
    if (!entry) throw Error("History entry not found");
    return this.transact(
      id,
      expectedRevision,
      `Restored: ${entry.description}`,
      "assistant",
      (d) => {
        Object.assign(d, structuredClone(entry.snapshot));
        if (!entry.snapshot.material) delete d.material;
        if (!entry.snapshot.units) delete d.units;
        if (entry.snapshot.massOverride === undefined) delete d.massOverride;
        if (entry.snapshot.weightLimit === undefined) delete d.weightLimit;
        d.componentPatterns = structuredClone(entry.snapshot.componentPatterns ?? []);
        d.variables = structuredClone(entry.snapshot.variables ?? []);
      },
      owner,
    );
  }
}
