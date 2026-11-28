import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

test('configured booking readiness refuses unavailable identity while liveness stays healthy', async t => {
  let peerStatus = 503;
  const peer = createServer((_req,res) => { res.writeHead(peerStatus,{'Content-Type':'application/json'}); res.end(JSON.stringify({status:peerStatus===200?'ready':'unavailable'})); }).listen(0,'127.0.0.1');
  await once(peer,'listening');
  t.after(()=>new Promise(r=>{peer.close(r);peer.closeAllConnections();}));
  const app = createApp({pool:{query:async()=>({rows:[]}),connect:async()=>{}},accountServiceUrl:`http://127.0.0.1:${peer.address().port}`,internalServiceToken:'synthetic-readiness-service-token-32'}).listen(0,'127.0.0.1');
  await once(app,'listening');
  t.after(()=>new Promise(r=>{app.close(r);app.closeAllConnections();}));
  const url=`http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(url+'/health')).status,200);
  const failed=await fetch(url+'/ready');assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{status:'unavailable'});
  peerStatus=200;
  const ready=await fetch(url+'/ready');assert.equal(ready.status,200);assert.deepEqual(await ready.json(),{status:'ready'});
});
