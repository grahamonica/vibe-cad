import { FILE_LIMITS, type FileDownload } from '../cad/file-wire.ts';

type Resource = { contents: ({ blob: string } | { text: string })[] };
export async function receiveFile(file: FileDownload, read: (uri: string) => Promise<Resource>): Promise<Uint8Array> {
  if ('base64' in file) return Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
  if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > FILE_LIMITS.maximumBytes || file.chunkBytes !== FILE_LIMITS.chunkBytes || file.count !== Math.ceil(file.byteLength / file.chunkBytes) || !file.uriPrefix.startsWith('cad-export://')) throw Error('Invalid or oversized export download. The exported file remains saved locally.');
  const bytes = new Uint8Array(file.byteLength);
  for (let index = 0; index < file.count; index++) {
    const resource = await read(file.uriPrefix + index), content = resource.contents[0];
    if (!content || !('blob' in content)) throw Error('An export chunk is missing');
    const block = atob(content.blob), offset = index * file.chunkBytes;
    if (block.length !== Math.min(file.chunkBytes, bytes.length - offset)) throw Error('An export chunk is incomplete');
    for (let i = 0; i < block.length; i++) bytes[offset + i] = block.charCodeAt(i);
  }
  return bytes;
}
