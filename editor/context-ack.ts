import type { View } from '../cad/types.ts';

/** Commands are serialized per editor. Advance an older local gesture past our
 * own acknowledgement, but retain its original version across a foreign write. */
export function cameraWriteArgs(current: View | null, args: Record<string, unknown>, clientId: string) {
  const camera = current?.document.viewport;
  return {
    ...args, clientId,
    ...(camera?.writer === clientId ? { expectedViewportVersion: camera.version ?? 0 } : {}),
  };
}

/** Metadata acknowledgements must never replace or relabel cached solid geometry. */
export function applyContextAck(current: View, result: unknown): View {
  const ack = result as {
    kind?: string;
    document?: Pick<View['document'], 'id' | 'revision'> & Partial<Pick<View['document'], 'selection' | 'viewport'>>;
  };
  if (ack?.kind !== 'context' || ack.document?.id !== current.document.id || ack.document.revision !== current.document.revision)
    return current;
  const selection = ack.document.selection ?? current.document.selection;
  const incoming = ack.document.viewport;
  const viewport = incoming && (incoming.version ?? 0) >= (current.document.viewport?.version ?? 0)
    ? incoming : current.document.viewport;
  if (JSON.stringify(selection) === JSON.stringify(current.document.selection) && JSON.stringify(viewport) === JSON.stringify(current.document.viewport))
    return current;
  return { ...current, document: { ...current.document, selection, viewport } };
}
