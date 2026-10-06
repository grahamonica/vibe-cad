export { randomUUID } from "node:crypto";
export { downloadVendorFile } from "./vendor-file.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
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
