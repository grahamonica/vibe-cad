import { randomUUID } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../cad/store.ts';
import { FILE_LIMITS, type FileDownload } from '../cad/file-wire.ts';

type ExportFile = { path: string; filename: string; mimeType: string };
type Entry = ExportFile & { size: number; modified: number; inode: number; expires: number };
const files = new WeakMap<Store, Map<string, Entry>>();
function cache(store: Store) {
  let entries = files.get(store);
  if (!entries) files.set(store, entries = new Map());
  for (const [token, entry] of entries) if (entry.expires < Date.now()) entries.delete(token);
  return entries;
}

/** Retain file identities, not another full copy of every exported assembly. */
export async function deliverFile(store: Store, file: ExportFile): Promise<FileDownload> {
  const info = await stat(file.path);
  if (!info.isFile()) throw Error('Export is not a file');
  const common = { filename: file.filename, mimeType: file.mimeType };
  if (info.size <= FILE_LIMITS.inlineBytes) return { ...common, base64: (await readFile(file.path)).toString('base64') };
  const entries = cache(store), token = randomUUID();
  while (entries.size >= 8) entries.delete(entries.keys().next().value!);
  entries.set(token, { ...file, size: info.size, modified: info.mtimeMs, inode: info.ino, expires: Date.now() + 15 * 60_000 });
  return { ...common, uriPrefix: `cad-export://${token}/`, byteLength: info.size, chunkBytes: FILE_LIMITS.chunkBytes, count: Math.ceil(info.size / FILE_LIMITS.chunkBytes) };
}

export function registerFileResources(server: McpServer, store: Store) {
  server.registerResource('CAD export file', new ResourceTemplate('cad-export://{token}/{chunk}', { list: undefined }), { mimeType: 'application/octet-stream' }, async (uri, variables) => {
    const entry = cache(store).get(String(variables.token)), index = Number(variables.chunk);
    if (!entry || !Number.isInteger(index) || index < 0 || index >= Math.ceil(entry.size / FILE_LIMITS.chunkBytes)) throw Error('This export download expired or its chunk is invalid. Export again; the saved file is unchanged.');
    const handle = await open(entry.path, 'r');
    try {
      const unchanged = async () => {
        const info = await handle.stat();
        if (info.size !== entry.size || info.mtimeMs !== entry.modified || info.ino !== entry.inode) throw Error('The export file changed during download. Export again to receive one complete version.');
      };
      await unchanged();
      const offset = index * FILE_LIMITS.chunkBytes, length = Math.min(FILE_LIMITS.chunkBytes, entry.size - offset), bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, offset);
      await unchanged();
      if (bytesRead !== length) throw Error('The export file was truncated during download');
      entry.expires = Date.now() + 15 * 60_000;
      return { contents: [{ uri: uri.href, mimeType: 'application/octet-stream', blob: bytes.toString('base64') }] };
    } finally { await handle.close(); }
  });
}
