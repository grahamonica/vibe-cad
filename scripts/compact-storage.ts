// Storage maintenance only: no geometry creation or model editing.
import { readFile } from 'node:fs/promises';
import { Store } from '../cad/store.ts';
const args = process.argv.slice(2);
const root = args[args.indexOf('--root') + 1];
const path = args[args.indexOf('--candidates') + 1];
if (!args.includes('--root') || !args.includes('--candidates') || !root || !path) throw Error('Use --root DOCUMENT_ID --candidates IDS.json [--apply]');
const ids: unknown = JSON.parse(await readFile(path, 'utf8'));
if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw Error('Candidate file must be a JSON array of document IDs');
const store = new Store();
console.log(JSON.stringify(await store.compactStorage([root], ids, !args.includes('--apply')), null, 2));
