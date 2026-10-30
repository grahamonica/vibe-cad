import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Plugin managers may delete the installation being used by a live session.
// Give that process one immutable asset set, owned for exactly its lifetime.
// This contains runtime files only; CAD documents stay in their normal store.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const running = join(tmpdir(), `vibe-cad-running-${process.getuid?.() ?? 'user'}`);
await mkdir(running, {recursive:true,mode:0o700});
for (const name of await readdir(running)) {
  const match = /^(\d+)-/.exec(name);
  if (!match) continue;
  try { process.kill(Number(match[1]), 0); }
  catch (error) {
    if (error.code === 'ESRCH') await rm(join(running,name), {recursive:true,force:true});
  }
}
const root = await mkdtemp(join(running, `${process.pid}-`));
const cleanup = () => rmSync(root, {recursive:true,force:true});
process.once('exit', cleanup);
try {
  const assets = ['dist/runtime/stdio.mjs', 'dist/runtime/geometry-worker.mjs', 'dist/editor/index.html', 'dist/kernel.wasm'];
  await Promise.all(assets.map(async asset => {
    const target = join(root,asset);
    await mkdir(dirname(target), {recursive:true});
    await cp(join(source,asset), target);
  }));
  await writeFile(join(root,'package.json'), '{"type":"module"}');
  process.env.VIBE_CAD_ROOT = root;
  // The install directory itself may disappear too, including the inherited cwd.
  process.chdir(root);
  await import(pathToFileURL(join(root,'dist/runtime/stdio.mjs')).href);
} catch (error) {
  cleanup();
  throw error;
}
