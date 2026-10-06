// Documents stored as a git-friendly project: each design is a `<name>.vibe/`
// folder of canonical JSON files in a workspace (usually a git checkout), with
// imported files in `blobs/` and shared libraries in `library/`. Revisions and
// undo history are local working state under `.vibe/`, which ignores itself,
// so the repository holds only the design. A design changed on disk by git
// (switching branches, pulling, merging) is picked up as a new revision.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, open } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DocumentPersistence } from "./document-store.ts";
import type { Document, HistoryEntry, Snapshot } from "./types.ts";
import { snapshot } from "./types.ts";
import { collections, designFiles, readDesign } from "./project-format.ts";

interface LocalState {
  revision: number;
  createdAt: string;
  updatedAt: string;
  history: HistoryEntry[];
  historyIndex: number;
  designHash: string;
  selection?: Document["selection"];
  viewport?: Document["viewport"];
}
const hashOf = (files: Map<string, string>) =>
  bytesToHex(sha256(new TextEncoder().encode([...files].sort(([a], [b]) => a.localeCompare(b)).map(([p, t]) => `${p}\n${t}`).join("\u0000"))));

async function writeAtomic(path: string, text: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, text);
  await rename(temp, path);
}

export class ProjectPersistence implements DocumentPersistence {
  readonly directory: string;
  readonly kind = "project" as const;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  private local(...parts: string[]) {
    return join(this.directory, ".vibe", ...parts);
  }
  private async ensureLocal() {
    await mkdir(this.local("state"), { recursive: true });
    // Local working state never belongs in the repository.
    const ignore = this.local(".gitignore");
    try {
      await stat(ignore);
    } catch {
      await writeFile(ignore, "*\n");
    }
  }
  /** Design folders in the workspace by document id. */
  private async folders(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await mkdir(this.directory, { recursive: true });
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".vibe")) continue;
      try {
        const head = JSON.parse(await readFile(join(this.directory, entry.name, "document.json"), "utf8"));
        if (typeof head.id === "string" && !out.has(head.id)) out.set(head.id, entry.name);
      } catch {
        /* not a design folder */
      }
    }
    return out;
  }
  private async files(folder: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const root = join(this.directory, folder);
    files.set("document.json", await readFile(join(root, "document.json"), "utf8"));
    for (const [sub] of collections) {
      let names: string[] = [];
      try {
        names = await readdir(join(root, sub));
      } catch {
        continue;
      }
      for (const name of names) if (name.endsWith(".json")) files.set(`${sub}/${name}`, await readFile(join(root, sub, name), "utf8"));
    }
    return files;
  }
  private async state(id: string): Promise<LocalState | undefined> {
    try {
      return JSON.parse(await readFile(this.local("state", `${id}.json`), "utf8"));
    } catch {
      return undefined;
    }
  }
  private async load(id: string, folder: string): Promise<Document> {
    const files = await this.files(folder),
      { design } = readDesign(files),
      hash = hashOf(files);
    const now = new Date().toISOString();
    let state = await this.state(id);
    const doc = (s: LocalState): Document =>
      ({
        // Every collection reads as a list, empty when its folder is absent.
        ...design,
        name: design.name ?? folder.replace(/\.vibe$/, ""),
        id,
        owner: "local",
        revision: s.revision,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        history: s.history,
        historyIndex: s.historyIndex,
        selection: s.selection ?? [],
        ...(s.viewport ? { viewport: s.viewport } : {}),
      }) as Document;
    if (!state || state.designHash !== hash) {
      // First open on this computer, or git changed the design on disk.
      const base: LocalState = state ?? { revision: -1, createdAt: now, updatedAt: now, history: [], historyIndex: -1, designHash: "" };
      const next = { ...base, revision: base.revision + 1, updatedAt: now, designHash: hash, history: base.history.slice(0, base.historyIndex + 1) };
      const entry: HistoryEntry = {
        id: randomUUID(),
        revision: next.revision,
        at: now,
        description: state ? "Changed on disk (git)" : "Opened from project",
        source: "user",
        snapshot: snapshot(doc({ ...next, historyIndex: 0 })) as Snapshot,
      };
      next.history.push(entry);
      if (next.history.length > 200) next.history.shift();
      next.historyIndex = next.history.length - 1;
      await this.ensureLocal();
      await writeAtomic(this.local("state", `${id}.json`), JSON.stringify(next));
      state = next;
    }
    return doc(state);
  }
  async list() {
    const docs: Document[] = [];
    for (const [id, folder] of await this.folders())
      try {
        docs.push(await this.load(id, folder));
      } catch {
        /* a folder that does not read (for example mid-merge) is skipped in the list */
      }
    return docs;
  }
  async read(id: string): Promise<Document> {
    const folder = (await this.folders()).get(id);
    if (!folder) throw Error("Document not found");
    return this.load(id, folder);
  }
  /** A folder name for a new design, from its name. */
  private async newFolder(name: string, taken: Set<string>) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "design";
    for (let i = 1; ; i++) {
      const folder = `${slug}${i > 1 ? `-${i}` : ""}.vibe`;
      if (taken.has(folder)) continue;
      try {
        await stat(join(this.directory, folder));
      } catch {
        return folder;
      }
    }
  }
  async commit(doc: Document, expectedRevision: number | null) {
    const folders = await this.folders();
    let folder = folders.get(doc.id);
    let order = new Map<string, Map<string, number>>();
    if (folder) {
      const current = await this.files(folder),
        state = await this.state(doc.id);
      // Never write over a design that git changed since it was read.
      if (state && state.designHash !== hashOf(current)) throw Error("The design changed on disk (git switch, pull or merge); reopen it and retry");
      if (expectedRevision !== null && state && state.revision !== expectedRevision)
        throw Error(`Revision conflict: expected ${expectedRevision}, current ${state.revision}. Inspect the document and retry.`);
      order = readDesign(current).order;
    } else {
      if (expectedRevision !== null) throw Error("Document not found");
      folder = await this.newFolder(doc.name, new Set(folders.values()));
    }
    const files = designFiles(doc, order),
      root = join(this.directory, folder);
    const existing = folders.has(doc.id) ? await this.files(folder) : new Map<string, string>();
    for (const [path, text] of files) if (existing.get(path) !== text) await writeAtomic(join(root, path), text);
    for (const path of existing.keys()) if (!files.has(path)) await rm(join(root, path), { force: true });
    await this.ensureLocal();
    const state: LocalState = {
      revision: doc.revision,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      history: doc.history,
      historyIndex: doc.historyIndex,
      designHash: hashOf(files),
      selection: doc.selection,
      ...(doc.viewport ? { viewport: doc.viewport } : {}),
    };
    await writeAtomic(this.local("state", `${doc.id}.json`), JSON.stringify(state));
  }
  private blob(hash: string) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw Error("Invalid file hash");
    return join(this.directory, "blobs", hash);
  }
  async putBlob(hash: string, bytes: Uint8Array) {
    const file = this.blob(hash);
    try {
      await open(file, "r").then((h) => h.close());
      return;
    } catch {}
    await writeAtomic(file, bytes);
  }
  async getBlob(hash: string) {
    return new Uint8Array(await readFile(this.blob(hash)));
  }
  private library(name: string) {
    if (!/^[a-z-]{1,40}$/.test(name)) throw Error("Invalid library name");
    return join(this.directory, "library", `${name}.json`);
  }
  async readLibrary(name: string) {
    try {
      return JSON.parse(await readFile(this.library(name), "utf8"));
    } catch {
      return undefined;
    }
  }
  async writeLibrary(name: string, value: unknown) {
    await writeAtomic(this.library(name), JSON.stringify(value, null, 2) + "\n");
  }
}
