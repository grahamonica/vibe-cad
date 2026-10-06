import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  open,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { rebuild } from "./geometry.ts";
import { DocumentStore, type DocumentPersistence } from "./document-store.ts";
import { ProjectPersistence } from "./project.ts";
import type { Document } from "./types.ts";

class FilePersistence implements DocumentPersistence {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  private blob(hash: string) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw Error("Invalid file hash");
    return join(this.directory, "blobs", hash);
  }
  async putBlob(hash: string, bytes: Uint8Array) {
    const file = this.blob(hash);
    await mkdir(join(this.directory, "blobs"), { recursive: true, mode: 0o700 });
    // Content addressed: an existing file already holds these bytes.
    try {
      await open(file, "r").then((h) => h.close());
      return;
    } catch {}
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, file);
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
    const file = this.library(name);
    await mkdir(join(this.directory, "library"), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, file);
  }
  private file(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error("Invalid document ID");
    return join(this.directory, `${id}.json`);
  }
  async list() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);
    return Promise.all(
      names
        .filter((n) => n.endsWith(".json"))
        .map(
          async (n) =>
            JSON.parse(
              await readFile(join(this.directory, n), "utf8"),
            ) as Document,
        ),
    );
  }
  async read(id: string): Promise<Document> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8"));
    } catch {
      throw Error(`Document ${id} not found`);
    }
  }
  async commit(doc: Document, expectedRevision: number | null) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(doc.id);
    const lockPath = `${file}.lock`,
      deadline = Date.now() + 5000;
    let lock;
    while (!lock) {
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        if (Date.now() >= deadline)
          throw Error(
            "Document save is locked by another editor; retry after it finishes",
          );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      let current: Document | undefined;
      try {
        current = JSON.parse(await readFile(file, "utf8"));
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      if (
        expectedRevision === null
          ? !!current
          : current?.revision !== expectedRevision
      )
        throw Error("Revision conflict; refresh the document");
      await writeFile(temp, JSON.stringify(doc), { mode: 0o600 });
      await rename(temp, file);
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
      await rm(temp, { force: true });
    }
  }
}
export class Store extends DocumentStore {
  constructor(directory?: string) {
    // A workspace (usually a git checkout) stores designs as git-friendly
    // project folders; otherwise documents live in the private data folder.
    const workspace = directory === undefined ? process.env.VIBE_WORKSPACE : undefined;
    super(
      workspace
        ? new ProjectPersistence(workspace)
        : new FilePersistence(directory ?? process.env.VIBE_CAD_DATA_DIR ?? join(homedir(), ".vibe-cad", "documents")),
      rebuild,
      randomUUID,
    );
  }
}
/** Documents in a project folder, for git. */
export class ProjectStore extends DocumentStore {
  constructor(workspace: string) {
    super(new ProjectPersistence(workspace), rebuild, randomUUID);
  }
}
