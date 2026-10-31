import { EditorSessions } from "./editor-sessions.ts";
import { definitionOf } from "./view-summary.ts";
import { snapshot } from "./types.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { findTopology } from "./topology-key.ts";
import { validateDocument } from "./validate.ts";
import { applyEquations } from "./equations.ts";
import type { Document, Geometry, View, Preview } from "./types.ts";
import type { Material } from "./standards.ts";
import { trimHistory, currentDesign } from './history-policy.ts';
import { BuildControl } from './build-control.ts';
import { repositionAssembly, placementAck } from './placement.ts';

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
  deleteDocument?(id: string, expectedRevision: number): Promise<void>;
  listBlobs?(): Promise<string[]>;
  deleteBlob?(hash: string): Promise<void>;
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
  readonly buildControl = new BuildControl();
  readonly editors = new EditorSessions();
  readonly directory: string;
  private locks = new Map<string, Promise<void>>();
  private previews = new Map<string, Preview>();
  private cache = new Map<string, { revision: number; links: string; geometry: Geometry }>();
  private remember(id: string, entry: { revision: number; links: string; geometry: Geometry }) {
    entry.geometry.shapeKey ??= this.uuid();
    this.cache.delete(id);
    this.cache.set(id, entry);
    const size = (g: Geometry) => g.bodies.reduce((n, b) => n +
      (b.mesh.vertices.length + b.mesh.normals.length + b.mesh.triangles.length + b.edges.lines.length) * 8 + b.topology.length * 256, 0);
    let bytes = [...this.cache.values()].reduce((n, e) => n + size(e.geometry), 0);
    for (const [key, value] of this.cache) {
      if (this.cache.size <= 3 && bytes <= 48 * 1024 * 1024) break;
      if (key === id) continue;
      bytes -= size(value.geometry); this.cache.delete(key); this.previews.delete(key);
    }
  }
  clearCaches() { this.cache.clear(); this.previews.clear(); }
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
    const view = this.viewOf(doc, geometry, links);
    await this.persistence.commit(doc, null);
    this.remember(doc.id, { revision: doc.revision, links, geometry });
    return view;
  }
  async create(
    name: string,
    owner = "local",
    source: "user" | "assistant" = "user",
  ) {
    const doc = this.blank(name, owner, source);
    validateDocument(doc);
    const { geometry, links } = await this.rebuild(doc);
    const view = this.viewOf(doc, geometry, links);
    await this.persistence.commit(doc, null);
    this.remember(doc.id, { revision: doc.revision, links, geometry });
    return view;
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
    // Check cheap dependency revisions before loading imported bytes or invoking OCCT.
    const linked = await this.linkedDocuments(doc);
    const links = Object.values(linked).map(d => `${d.id}@${d.revision}`).sort().join(',');
    const geometry = cached?.revision === doc.revision && cached.links === links
      ? cached.geometry : await this.build(await this.kernelDocument(doc));
    this.remember(doc.id, { revision: doc.revision, links, geometry });
    return this.viewOf(doc, geometry, links);
  }
  /** Build the response before committing; publishing a saved edit must not
   * perform another dependency read or kernel rebuild after the commit. */
  private viewOf(doc: Document, geometry: Geometry, links: string): View {
    geometry.shapeKey ??= this.uuid();
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
      geometry: { ...geometry, dependencyKey: links },
      preview:
        this.previews.get(doc.id)?.baseRevision === doc.revision
          ? (({ snapshot: _, ...preview }) => preview)(
              this.previews.get(doc.id)!,
            )
          : undefined,
    };
  }
  async state(id: string,knownRevision?:number,knownShapeKey?:string) {
    const doc = await this.read(id),
      preview = this.previews.get(id);
    return {
      documentId: doc.id,
      revision: doc.revision,
      selection: doc.selection,
      viewport: doc.viewport,
      previewId: preview?.baseRevision === doc.revision ? preview.id : null,
      dependencyKey: Object.values(await this.linkedDocuments(doc)).map(d => `${d.id}@${d.revision}`).sort().join(','),
      ...(knownRevision!==doc.revision&&this.cache.get(doc.id)?.revision===doc.revision&&(this.cache.get(doc.id)?.geometry.placementOnly||knownShapeKey&&knownShapeKey===this.cache.get(doc.id)?.geometry.shapeKey) ? {placement:placementAck(await this.view(doc),true)}:{}),
    };
  }
  async validateEdit(id: string, expectedRevision: number, edit: (d: Document) => void, level: 'structure' | 'geometry') {
    const current = await this.read(id);
    if (current.revision !== expectedRevision) throw Error('Revision conflict; inspect the design again');
    const draft = structuredClone(current), started = performance.now();
    edit(draft); applyEquations(draft); validateDocument(draft);
    if (level === 'structure') return {valid: true, level, revision: current.revision,
      sketches: draft.sketches.map(s => ({id:s.id,dof:s.solver.dof})),
      assembly: {status: 'not_checked', reason: 'Mate definition requires actual topology; use geometry validation'}, milliseconds: performance.now()-started};
    const {geometry} = await this.rebuild(draft);
    return {valid:true, level, revision:current.revision, definition:definitionOf({document:draft,geometry}), milliseconds:performance.now()-started};
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
    // A queue tail must never retain the completed View/Geometry result.
    const tail = next.then(() => {}, () => {});
    this.locks.set(id, tail);
    void tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
    return next;
  }
  async transact(
    id: string,
    expectedRevision: number,
    description: string,
    source: "user" | "assistant",
    edit: (doc: Document) => void | Promise<void>,
    owner = "local",
    evaluation?:{kind:'placement';componentId:string}|{kind:'display'},
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
      // Pure instance motion reuses validated shape geometry. Geometry-changing belt
      // lengths and converted sketch references still require their parametric update.
      const hasDependentGeometry=(next.components??[]).some(c=>c.belt)||(next.sketches??[]).some(s=>s.support||s.entities.some(e=>e.projected));
      const placementComponentId=evaluation?.kind==='placement'?evaluation.componentId:undefined;
      let geometry:Geometry,links:string;
      if(evaluation?.kind==='display'){
        const shapes=(d:Document)=>JSON.stringify({...snapshot(d),components:(d.components??[]).map(({explode:_,...c})=>c)});
        if(shapes(doc)!==shapes(next))throw Error('A display transaction may change only exploded offsets');
        const previous=await this.view(doc);geometry=previous.geometry;links=geometry.dependencyKey??'';
      }else if(placementComponentId&&!hasDependentGeometry){
        const shapes=(d:Document)=>JSON.stringify({...snapshot(d),components:(d.components??[]).map(({position:_,rotation:__,...c})=>c)});
        if(shapes(doc)!==shapes(next))throw Error('A placement transaction may change only component poses');
        const previous=await this.view(doc);links=previous.geometry.dependencyKey??'';
        geometry=repositionAssembly(next,previous.geometry,placementComponentId);
      }else{
        if(placementComponentId){const previous=await this.view(doc);repositionAssembly(next,previous.geometry,placementComponentId);}
        ({geometry,links}=await this.rebuild(next));
      }
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
      next.historyIndex = next.history.length - 1;
      trimHistory(next);
      const view = this.viewOf(next, geometry, links);
      await this.persistence.commit(next, doc.revision);
      this.previews.delete(id);
      this.remember(id, { revision: next.revision, links, geometry });
      return view;
    });
  }
  async setViewport(id: string, viewport: NonNullable<Document['viewport']>) {
    return this.locked(id, async () => {
      const doc=await this.read(id);
      doc.viewport=viewport;
      await this.persistence.commit(doc,doc.revision);
      return {document:{id:doc.id,revision:doc.revision,selection:doc.selection,viewport:doc.viewport}};
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
      const updated = this.viewOf(doc, view.geometry, view.geometry.dependencyKey ?? "");
      await this.persistence.commit(doc, doc.revision);
      return updated;
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
      const view = this.viewOf(next, geometry, links);
      await this.persistence.commit(next, doc.revision);
      this.previews.delete(id);
      this.remember(id, { revision: next.revision, links, geometry });
      return view;
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
    return this.restoreSnapshot(id, expectedRevision, entry.snapshot, `Restored: ${entry.description}`, owner);
  }
  async restoreSnapshot(id: string, expectedRevision: number, state: ReturnType<typeof snapshot>, reason: string, owner = 'local') {
    return this.transact(
      id,
      expectedRevision,
      reason,
      "assistant",
      (d) => {
        Object.assign(d, structuredClone(state));
        if (!state.material) delete d.material;
        if (!state.units) delete d.units;
        if (state.massOverride === undefined) delete d.massOverride;
        if (state.weightLimit === undefined) delete d.weightLimit;
        d.componentPatterns = structuredClone(state.componentPatterns ?? []);
        d.variables = structuredClone(state.variables ?? []);
      },
      owner,
    );
  }

  /** Explicitly scoped maintenance. Other saved projects and their undo references remain protected. */
  async compactStorage(roots: string[], candidates: string[], dryRun = true) {
    type Refs = { revision: number; components: Document['components']; features: Document['features']; history: { snapshot: { components: Document['components']; features: Document['features'] } }[] };
    const docs = new Map<string, Refs>();
    const heads = this.persistence.listMetadata ? await this.persistence.listMetadata() : await this.persistence.list();
    const refs = (d: Pick<Document, 'components' | 'features'>) => ({ components: d.components, features: d.features.filter(f => f.type === 'import') });
    for (const head of heads) {
      const d = await this.read(head.id);
      docs.set(d.id, { revision: d.revision, ...refs(d), history: d.history.map(h => ({ snapshot: refs(h.snapshot) })) });
    }
    for (const id of roots) if (!docs.has(id)) throw Error(`Root document ${id} not found`);
    const eligible = new Set(candidates), live = new Set<string>();
    const visit = (id: string, history: boolean) => {
      if (live.has(id)) return;
      const d = docs.get(id); if (!d) throw Error(`Referenced document ${id} not found; cleanup refused`);
      live.add(id);
      for (const state of history ? [d, ...d.history.map(h => h.snapshot)] : [d])
        for (const c of state.components ?? []) if (c.source) visit(c.source.documentId, history);
    };
    // Non-candidates may be unrelated user projects; preserve their full dependency graph.
    for (const id of docs.keys()) if (!eligible.has(id) && !roots.includes(id)) visit(id, true);
    const compact = new Set<string>();
    const active = (id: string) => {
      if (compact.has(id)) return;
      const d = docs.get(id); if (!d) throw Error(`Missing active part ${id}; cleanup refused`);
      compact.add(id); live.add(id);
      for (const c of d.components ?? []) if (c.source) active(c.source.documentId);
    };
    roots.forEach(active);
    const removed = [...eligible].filter(id => docs.has(id) && !live.has(id));
    const compacted = [...compact].filter(id => roots.includes(id) || eligible.has(id));
    // Blobs referenced by any retained document/history survive.
    const blobRefs = new Set<string>();
    for (const [id, d] of docs) {
      if (removed.includes(id)) continue;
      const states = compacted.includes(id) ? [d] : [d, ...d.history.map(h => h.snapshot)];
      for (const s of states) for (const f of s.features)
        if (f.type === 'import') blobRefs.add(String(f.params.blob));
    }
    const scopedBlobs = new Set<string>();
    for (const id of new Set([...roots, ...candidates, ...compacted])) {
      const d = docs.get(id); if (!d) continue;
      for (const state of [d, ...d.history.map(h => h.snapshot)])
        for (const f of state.features) if (f.type === 'import') scopedBlobs.add(String(f.params.blob));
    }
    const unusedBlobs = (await this.persistence.listBlobs?.() ?? []).filter(hash => scopedBlobs.has(hash) && !blobRefs.has(hash));
    if (!dryRun) {
      if (removed.length && !this.persistence.deleteDocument) throw Error('Storage cannot delete unused documents');
      for (const id of compacted) await this.locked(id, async () => {
        const latest = await this.read(id);
        if (latest.revision !== docs.get(id)!.revision) throw Error('Design changed during cleanup; retry');
        await this.persistence.commit(currentDesign(latest), latest.revision);
      });
      for (const id of removed) await this.persistence.deleteDocument!(id, docs.get(id)!.revision);
      for (const hash of unusedBlobs) await this.persistence.deleteBlob?.(hash);
      this.clearCaches();
    }
    return { dryRun, compacted, removed, unusedBlobs };
  }
}
