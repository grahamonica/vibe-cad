import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Topology } from "./types.ts";
// Same SHA-256 identity in Node and browsers; saved topology IDs stay valid.
export const topologyKey = (value: string) =>
  bytesToHex(sha256(new TextEncoder().encode(value))).slice(0, 14);

/** Geometric identity used before persistent names; references saved then still resolve. */
export const legacyTopologyId = (t: Pick<Topology, "bodyId" | "kind" | "geomType" | "signature">) =>
  `${t.bodyId}:${t.kind}:${topologyKey(JSON.stringify([t.kind, t.geomType, t.signature]))}`;

export interface TopologyLookup {
  get(id: string): Topology | undefined;
  values(): Iterable<Topology>;
}
/**
 * Topology by id. Ids saved before persistent names are matched by their
 * geometric identity, and only when exactly one face or edge has it.
 */
export function topologyIndex(items: Iterable<Topology>): TopologyLookup {
  const byId = new Map<string, Topology>();
  for (const t of items) byId.set(t.id, t);
  let legacy: Map<string, Topology | null> | undefined;
  return {
    get(id) {
      const t = byId.get(id);
      if (t) return t;
      if (!legacy) {
        legacy = new Map();
        for (const t of byId.values()) {
          const key = legacyTopologyId(t);
          legacy.set(key, legacy.has(key) ? null : t);
        }
      }
      return legacy.get(id) ?? undefined;
    },
    values: () => byId.values(),
  };
}
/** The face or edge a saved reference points to, if it still exists. */
export function findTopology(
  items: Iterable<Topology>,
  ref: { id: string; bodyId?: string; kind?: string },
): Topology | undefined {
  const t = topologyIndex(items).get(ref.id);
  return t && (!ref.bodyId || t.bodyId === ref.bodyId) && (!ref.kind || t.kind === ref.kind) ? t : undefined;
}
