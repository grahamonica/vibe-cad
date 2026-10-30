/** Evict old entries without evicting the working set of the assembly being built. */
export function trimActiveCache<T>(cache: Map<string, T>, active: Set<string>, limit: number, dispose?: (value: T) => void) {
  for (const [key, value] of cache) {
    if (cache.size <= limit) break;
    if (active.has(key)) continue;
    dispose?.(value);
    cache.delete(key);
  }
}
