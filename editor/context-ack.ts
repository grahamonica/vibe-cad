import type { View } from '../cad/types.ts';

/** Metadata acknowledgements must never replace or relabel cached solid geometry. */
export function applyContextAck(current: View, result: unknown): View {
  const ack = result as {kind?:string;document?:Pick<View['document'],'id'|'revision'|'selection'|'viewport'>};
  if(ack?.kind!=='context'||ack.document?.id!==current.document.id||ack.document.revision!==current.document.revision)return current;
  return {...current,document:{...current.document,selection:ack.document.selection,viewport:ack.document.viewport}};
}
