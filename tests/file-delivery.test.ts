import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcp } from '../runtime/mcp.ts';
import { Store } from '../cad/store.ts';
import { deliverFile } from '../runtime/file-delivery.ts';
import { receiveFile } from '../editor/file-download.ts';
import { FILE_LIMITS } from '../cad/file-wire.ts';

test('large exports use bounded resources and reject mixed file versions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cad-export-')), store = new Store(dir), server = createMcp(store), client = new Client({name:'Export contract',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const bytes = Buffer.alloc(FILE_LIMITS.chunkBytes * 2 + 17, 123), path = join(dir,'part.edit');
    await writeFile(path,bytes);
    const download = await deliverFile(store,{path,filename:'part.edit',mimeType:'application/json'});
    assert.ok(!('base64' in download));
    assert.ok(JSON.stringify(download).length<500,'The tool reply must not contain the entire export');
    assert.equal(download.count,3);
    const received = await receiveFile(download,uri=>client.readResource({uri}));
    assert.deepEqual(Buffer.from(received),bytes);
    await assert.rejects(client.readResource({uri:download.uriPrefix+'3'}),/chunk is invalid/);
    await writeFile(path,Buffer.alloc(bytes.length+1));
    await assert.rejects(receiveFile(download,uri=>client.readResource({uri})),/changed during download/);
  } finally { await client.close(); await server.close(); await rm(dir,{recursive:true,force:true}); }
});
