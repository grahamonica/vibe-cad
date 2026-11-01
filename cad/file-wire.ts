import { VIEW_LIMITS } from './view-wire.ts';

export const FILE_LIMITS = { inlineBytes: VIEW_LIMITS.inlineBytes, chunkBytes: VIEW_LIMITS.chunkBytes, maximumBytes: VIEW_LIMITS.decodedBytes } as const;
export type FileDownload = { filename: string; mimeType: string } & (
  { base64: string } |
  { uriPrefix: string; byteLength: number; chunkBytes: number; count: number }
);
