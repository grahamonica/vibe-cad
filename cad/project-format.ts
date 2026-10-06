// The git-friendly project format. A design is a folder `<name>.vibe/` with
// one small JSON file per object (feature, sketch, body, plane, component,
// mate, drawing, variable) plus `document.json`. Files are canonical (sorted
// keys, fixed layout), so the same design always writes the same bytes, and
// plain git merges object by object: edits to different objects merge cleanly,
// on a laptop or in a GitHub pull request. Objects keep their order through an
// `order` key instead of a shared list, so two branches that each add features
// do not touch the same file. Undo history, revisions and timestamps are local
// working state and never enter the repository.
import type { Snapshot } from "./types.ts";

export const FORMAT = "vibe-cad-document/1";
/** Collections stored one object per file: folder name, snapshot field, key field. */
export const collections = [
  ["sketches", "sketches", "id"],
  ["features", "features", "id"],
  ["bodies", "bodies", "id"],
  ["intents", "intents", "id"],
  ["planes", "referencePlanes", "id"],
  ["components", "components", "id"],
  ["mates", "mates", "id"],
  ["component-patterns", "componentPatterns", "id"],
  ["drawings", "drawings", "id"],
  ["variables", "variables", "name"],
] as const;
/** Document-level design values kept in document.json. */
const scalars = ["name", "units", "material", "massOverride", "weightLimit"] as const;
type Design = Pick<Snapshot, (typeof collections)[number][1] | (typeof scalars)[number]>;

/** Canonical JSON: sorted keys, two-space indent, short arrays of numbers on one line. */
export function canonical(value: unknown): string {
  const write = (v: unknown, indent: string): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (v.every((x) => x === null || typeof x !== "object") && v.length <= 16) return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
      const inner = indent + "  ";
      return `[\n${v.map((x) => inner + write(x, inner)).join(",\n")}\n${indent}]`;
    }
    const keys = Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort();
    if (!keys.length) return "{}";
    const inner = indent + "  ";
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${write((v as Record<string, unknown>)[k], inner)}`).join(",\n")}\n${indent}}`;
  };
  return write(value, "") + "\n";
}

/** File names stay simple and portable whatever an object is called. */
export const fileName = (key: string) => `${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;

/**
 * Order keys for a list: keep each object's previous key while the order still
 * holds, and give new or moved objects keys between their neighbors, so an
 * unchanged object's file never changes because others were added around it.
 */
export function orderKeys(ids: string[], previous: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  let last = -Infinity;
  const kept = ids.map((id) => {
    const key = previous.get(id);
    if (key !== undefined && key > last) {
      last = key;
      return key;
    }
    return undefined;
  });
  for (let i = 0; i < ids.length; ) {
    if (kept[i] !== undefined) {
      out.set(ids[i], kept[i]!);
      i++;
      continue;
    }
    // A run of objects without keys, between two kept keys (or the ends).
    let j = i;
    while (j < ids.length && kept[j] === undefined) j++;
    const lo = i > 0 ? out.get(ids[i - 1])! : 0,
      hi = j < ids.length ? kept[j]! : lo + 1024 * (j - i + 1);
    for (let k = i; k < j; k++) out.set(ids[k], lo + ((hi - lo) * (k - i + 1)) / (j - i + 1));
    i = j;
  }
  return out;
}

/** The files of a design (paths relative to its folder), given the order keys already on disk. */
export function designFiles(doc: Design & { id: string }, previousOrder: Map<string, Map<string, number>> = new Map()): Map<string, string> {
  const files = new Map<string, string>();
  const head: Record<string, unknown> = { format: FORMAT, id: doc.id };
  for (const key of scalars) if (doc[key] !== undefined) head[key] = doc[key];
  files.set("document.json", canonical(head));
  for (const [folder, field, key] of collections) {
    const list = ((doc as Record<string, unknown>)[field] as Record<string, unknown>[] | undefined) ?? [];
    const ids = list.map((x) => String(x[key]));
    const keys = orderKeys(ids, previousOrder.get(folder) ?? new Map());
    for (const item of list) files.set(`${folder}/${fileName(String(item[key]))}`, canonical({ ...item, order: keys.get(String(item[key])) }));
  }
  return files;
}

/** Read a design back from its files; unknown files are ignored. */
export function readDesign(files: Map<string, string>): { id: string; design: Design; order: Map<string, Map<string, number>> } {
  const head = JSON.parse(files.get("document.json") ?? "null") as Record<string, unknown> | null;
  if (!head || head.format !== FORMAT || typeof head.id !== "string") throw Error("Not a Vibe CAD document folder (missing document.json)");
  const design: Record<string, unknown> = {};
  for (const key of scalars) if (head[key] !== undefined) design[key] = head[key];
  const order = new Map<string, Map<string, number>>();
  for (const [folder, field, key] of collections) {
    const items: { item: Record<string, unknown>; order: number }[] = [];
    for (const [path, text] of files) {
      if (!path.startsWith(`${folder}/`) || !path.endsWith(".json") || path.slice(folder.length + 1).includes("/")) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw Error(`${path} is not valid JSON${text.includes("<<<<<<<") ? " (it still has merge conflict markers)" : ""}`);
      }
      const { order: rank, ...item } = parsed;
      items.push({ item, order: typeof rank === "number" ? rank : Number.MAX_SAFE_INTEGER });
    }
    items.sort((a, b) => a.order - b.order || String(a.item[key]).localeCompare(String(b.item[key])));
    order.set(folder, new Map(items.map((x) => [String(x.item[key]), x.order])));
    design[field] = items.map((x) => x.item);
  }
  return { id: head.id, design: design as Design, order };
}
