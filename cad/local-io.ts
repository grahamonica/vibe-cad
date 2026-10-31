export { randomUUID } from "node:crypto";
export { downloadVendorFile } from "./vendor-file.ts";
import { mkdir, writeFile, open } from "node:fs/promises";
import { join, dirname, isAbsolute, basename } from "node:path";
/** Only an explicitly supplied CAD file; no folders, commands or network URL. */
export async function readLocalCADFile(path: string) {
  if (!isAbsolute(path) || !/\.(step|stp|stl)$/i.test(path))
    throw Error("localPath must be an absolute path to a STEP, STP or STL file");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 16 || info.size > 32 * 1024 * 1024)
      throw Error("Local CAD must be a regular file between 16 bytes and 32 MiB");
    // Bound the read even if another process grows the file after stat().
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw Error("The CAD file changed while it was being read; finish saving it first");
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, length), filename: basename(path) };
  } finally { await file.close(); }
}
export async function saveExport(
  directory: string,
  documentId: string,
  filename: string,
  mimeType: string,
  data: Uint8Array,
) {
  const path = join(dirname(directory), "exports", documentId, filename);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, data, { mode: 0o600 });
  return {
    filename,
    mimeType,
    path,
    bytes: data.length,
  };
}
import { execFile } from "node:child_process";
/**
 * Run git with a fixed argument list in the workspace (never through a shell).
 * Resolves with stdout; rejects with git's own message.
 */
export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      if (error) reject(Error((stderr || stdout || error.message).trim().split("\n").slice(-6).join("\n")));
      else resolve(stdout);
    }),
  );
}
import { readFile as readFileAsync } from "node:fs/promises";
/** A text file in the workspace, or undefined when it is missing. */
export async function readText(root: string, path: string): Promise<string | undefined> {
  return readFileAsync(join(root, path), "utf8").catch(() => undefined);
}
import { deflateSync } from "node:zlib";
/** A zlib stream of the bytes (PNG pictures). */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(deflateSync(data, { level: 6 }));
}
