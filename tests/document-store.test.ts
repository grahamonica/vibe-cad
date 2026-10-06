import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../cad/store.ts";
import { closeKernel } from "../cad/geometry.ts";
after(closeKernel);
import assert from "node:assert/strict";
import {
  DocumentStore,
  type DocumentPersistence,
} from "../cad/document-store.ts";
import type { Document, Geometry } from "../cad/types.ts";

class Persistence implements DocumentPersistence {
  directory = "test-memory";
  documents = new Map<string, Document>();
  failSave = false;
  async list() {
    return structuredClone([...this.documents.values()]);
  }
  async read(id: string) {
    const doc = this.documents.get(id);
    if (!doc) throw Error("Document not found");
    return structuredClone(doc);
  }
  async commit(doc: Document, expectedRevision: number | null) {
    if (this.failSave) throw Error("Storage full");
    const current = this.documents.get(doc.id);
    if (
      expectedRevision === null
        ? !!current
        : current?.revision !== expectedRevision
    )
      throw Error("Revision conflict");
    this.documents.set(doc.id, structuredClone(doc));
  }
}
const rebuild = async (doc: Document): Promise<Geometry> => {
  if (doc.name === "Invalid kernel result")
    throw Error("Kernel rejected geometry");
  return { bodies: [], warnings: [] };
};

test("shared transactions preserve committed document and preview on failed atomic save", async () => {
  const persistence = new Persistence(),
    store = new DocumentStore(persistence, rebuild);
  const original = await store.create("Original");
  const id = original.document.id;
  const preview = await store.preview(id, 0, "Rename", (d) => {
    d.name = "Candidate";
  });
  persistence.failSave = true;
  await assert.rejects(
    store.transact(id, 0, "Fail save", "assistant", (d) => {
      d.name = "Unsaved";
    }),
    /Storage full/,
  );
  assert.deepEqual(await store.read(id), persistence.documents.get(id));
  assert.equal((await store.read(id)).name, "Original");
  assert.equal((await store.state(id)).previewId, preview.preview?.id);
  persistence.failSave = false;
  await assert.rejects(
    store.transact(id, 0, "Fail kernel", "user", (d) => {
      d.name = "Invalid kernel result";
    }),
    /Kernel rejected/,
  );
  assert.equal((await store.read(id)).revision, 0);
});

test("persistence rejects a stale worker after a different worker commits", async () => {
  const persistence = new Persistence(),
    first = new DocumentStore(persistence, rebuild),
    second = new DocumentStore(persistence, rebuild);
  const original = await first.create("Original"),
    id = original.document.id;
  let resume!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const pause = new Promise<void>((r) => {
    resume = r;
  });
  const stale = first.transact(id, 0, "Stale", "user", async (d) => {
    entered();
    await pause;
    d.name = "Stale";
  });
  await started;
  await second.transact(id, 0, "Newer", "assistant", (d) => {
    d.name = "Newer";
  });
  resume();
  await assert.rejects(stale, /Revision conflict/);
  const document = await first.read(id);
  assert.equal(document.name, "Newer");
  assert.equal(document.revision, 1);
  assert.equal(document.history.at(-1)?.source, "assistant");
});

test("shared persisted history survives store recreation and maintains revision monotonicity", async () => {
  const persistence = new Persistence(),
    first = new DocumentStore(persistence, rebuild);
  const original = await first.create("Original"),
    id = original.document.id;
  await first.transact(id, 0, "Rename", "user", (d) => {
    d.name = "Updated";
  });
  const reopened = new DocumentStore(persistence, rebuild);
  assert.equal((await reopened.read(id)).name, "Updated");
  await reopened.history(id, 1, "undo");
  assert.equal((await reopened.read(id)).revision, 2);
  // Name is document metadata, so design history checks a datum plane instead.
  await reopened.transact(id, 2, "Plane", "assistant", (d) => {
    d.referencePlanes!.push({
      id: "datum",
      name: "Datum",
      plane: "XY",
      origin: [0, 0, 12],
    });
  });
  await reopened.history(id, 3, "undo");
  assert.equal((await reopened.read(id)).referencePlanes?.length, 0);
  await reopened.history(id, 4, "redo");
  assert.equal((await reopened.read(id)).referencePlanes?.[0].origin[2], 12);
  assert.equal((await reopened.read(id)).revision, 5);
});

test("disk adapters serialize revision comparison and atomic replacement across store instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibe-store-race-"));
  try {
    const first = new Store(directory),
      second = new Store(directory);
    const original = await first.create("Original"),
      id = original.document.id;
    let resume!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const pause = new Promise<void>((r) => {
      resume = r;
    });
    const stale = first.transact(id, 0, "Stale", "user", async (d) => {
      entered();
      await pause;
      d.name = "Stale";
    });
    await started;
    await second.transact(id, 0, "Newer", "assistant", (d) => {
      d.name = "Newer";
    });
    resume();
    await assert.rejects(stale, /Revision conflict/);
    assert.equal((await first.read(id)).name, "Newer");
    assert.equal((await first.read(id)).revision, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed kernel initialization leaves no new persisted document", async () => {
  const persistence = new Persistence();
  const store = new DocumentStore(persistence, async () => {
    throw Error("Engine failed to initialize");
  });
  await assert.rejects(store.create("Uncommitted"), /failed to initialize/);
  assert.equal((await persistence.list()).length, 0);
});
