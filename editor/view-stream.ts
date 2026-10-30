import type { View } from "../cad/types.ts";

/** Parse one pinned view incrementally; never mix revisions or incomplete bodies. */
export async function receiveView(
  compressed: ReadableStream<BufferSource>,
  partial: (view: View, received: number, total: number) => void,
): Promise<View> {
  const reader = compressed
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    view: View | undefined,
    total = 0,
    complete = false;
  let decodedBytes=0;
  const ids = new Set<string>();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        text += decoder.decode();
        break;
      }
      decodedBytes+=next.value.byteLength;
      if(decodedBytes>64*1024*1024)throw Error('This view exceeds the 64 MiB transfer budget. Open a smaller assembly or hide detailed components before retrying.');
      text += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, end);
        text = text.slice(end + 1);
        if (!line) continue;
        if(line.length>32*1024*1024)throw Error('A CAD body exceeds the per-body transfer budget. Simplify the detailed source component before retrying.');
        const record = JSON.parse(line);
        if (complete)
          throw Error("CAD stream contains records after completion");
        if (record.type === "header") {
          if (
            view ||
            !record.view?.document ||
            !Number.isInteger(record.bodyCount) ||
            record.bodyCount < 0 ||
            record.view.geometry?.bodies?.length !== 0
          )
            throw Error("Invalid CAD stream header");
          view = record.view as View;
          total = record.bodyCount;
          partial(view, 0, total);
        } else if (record.type === "body") {
          if (
            !view ||
            !record.body?.id ||
            ids.has(record.body.id) ||
            ids.size >= total
          )
            throw Error("Invalid CAD stream body");
          ids.add(record.body.id);
          view = {
            ...view,
            geometry: {
              ...view.geometry,
              bodies: [...view.geometry.bodies, record.body],
            },
          };
          partial(view, ids.size, total);
        } else if (record.type === "complete") {
          if (!view || ids.size !== total)
            throw Error("CAD stream ended before all bodies arrived");
          complete = true;
        } else throw Error("Unknown CAD stream record");
      }
      if(text.length>32*1024*1024)throw Error('A CAD stream record exceeds the transfer budget. Your saved document is unchanged.');
    }
    if (!complete || !view || text.trim())
      throw Error("CAD stream was interrupted");
    return view;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
