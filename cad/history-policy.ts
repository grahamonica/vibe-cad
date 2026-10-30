import { snapshot, type Document } from './types.ts';

/** Undo is local working state, not an unbounded archive of deleted imports. */
export function trimHistory(doc: Pick<Document, 'history' | 'historyIndex'>, limit = 24, budget = 4 * 1024 * 1024) {
  let bytes = doc.history.reduce((n, h) => n + JSON.stringify(h).length * 2, 0);
  while (doc.history.length > 1 && (doc.history.length > limit || bytes > budget)) {
    const index = doc.historyIndex > 0 ? 0 : doc.history.length - 1;
    bytes -= JSON.stringify(doc.history[index]).length * 2;
    doc.history.splice(index, 1);
    if (index < doc.historyIndex) doc.historyIndex--;
  }
}

/** A portable current design retains its feature tree, not abandoned revisions. */
export function currentDesign(doc: Document): Document {
  const entry = doc.history[doc.historyIndex];
  return { ...doc, history: [{ ...entry, snapshot: snapshot(doc) }], historyIndex: 0 };
}
