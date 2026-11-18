import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

test('Blob poison threshold uses Blob extension settings, not Queue retry defaults',async()=>{
 const host=JSON.parse(await readFile(new URL('../../functions/host.json',import.meta.url),'utf8'));
 assert.equal(host.extensions.blobs.poisonBlobThreshold,3);
 assert.equal(host.extensions.blobs.maxDegreeOfParallelism,1);
 assert.equal(host.extensions.queues,undefined);
});
