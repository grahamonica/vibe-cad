/** Evict old entries without evicting the working set of the assembly being built. */
export function trimActiveCache<T>(cache: Map<string, T>, active: Set<string>, limit: number, dispose?: (value: T) => void) {
  for (const [key, value] of cache) {
    if (cache.size <= limit) break;
    if (active.has(key)) continue;
    dispose?.(value);
    cache.delete(key);
  }
}

/** Keep costly render work when an assembly slightly exceeds its byte budget.
 * Plain LRU repeatedly evicts the next part in a sequential assembly traversal.
 */
export function trimCostedCache<T extends {bytes:number; buildMs:number}>(cache:Map<string,T>,active:Set<string>,budget:number) {
  let total=[...cache.values()].reduce((n,e)=>n+e.bytes,0);
  const candidates=[...cache].sort(([a,x],[b,y])=>
    Number(active.has(a))-Number(active.has(b)) || x.buildMs/Math.max(x.bytes,1)-y.buildMs/Math.max(y.bytes,1));
  for(const [id,entry] of candidates){
    if(total<=budget)break;
    cache.delete(id);total-=entry.bytes;
  }
}
