import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createApiClient} from '../../web/app.js';
const {Blob,Response,Headers,ReadableStream,DOMException}=globalThis;
const path='/api/disputes/10000000-0000-4000-8000-000000000001/evidence';
test('private upload sends raw bytes and binary read keeps credentials out of URL',async()=>{
 const calls=[],file=new Blob(['synthetic'],{type:'image/png'});
 const api=createApiClient({getToken:()=>'synthetic-private-token',fetchImpl:async(url,init)=>{
  calls.push({url,init});return init.method==='POST'?new Response(JSON.stringify({evidence:{id:'synthetic'}}),{status:201}):new Response(file,{headers:{'Content-Type':'image/png'}});
 }});
 assert.equal((await api.upload(path,file)).status,201);
 assert.equal(calls[0].init.body,file);assert.equal(calls[0].init.headers['Content-Type'],'image/png');
 assert.equal(calls[0].init.headers.Authorization,'Bearer synthetic-private-token');assert.equal(calls[0].init.redirect,'error');
 assert.equal((await api.binary('/api/evidence/10000000-0000-4000-8000-000000000002/content')).type,'image/png');
 assert.ok(calls.every(c=>!c.url.includes('token')&&c.init.cache==='no-store'&&c.init.credentials==='omit'));
});
test('private binary operations refuse foreign URLs and missing sessions',async()=>{
 let calls=0,expired=0;const api=createApiClient({getToken:()=>null,onUnauthorized:()=>expired++,fetchImpl:async()=>{calls++;}});
 await assert.rejects(api.upload(path,new Blob(['x'],{type:'image/png'})),e=>e.code==='UNAUTHENTICATED');
 await assert.rejects(api.binary('https://example.com/api/evidence/x/content'),e=>e.code==='BAD_RESPONSE');
 assert.equal(calls,0);assert.equal(expired,1);
});
test('binary full-body timeout stays active and malformed responses do not succeed',async()=>{
 const api=createApiClient({getToken:()=>'synthetic',timeoutMs:20,fetchImpl:async(_url,{signal})=>({ok:true,status:200,headers:new Headers({'Content-Type':'image/jpeg'}),body:new ReadableStream({start(c){signal.addEventListener('abort',()=>c.error(new DOMException('Aborted','AbortError')));}})})});
 await assert.rejects(api.binary('/api/evidence/10000000-0000-4000-8000-000000000002/thumbnail'),e=>e.code==='TIMEOUT');
 const bad=createApiClient({getToken:()=>'synthetic',fetchImpl:async()=>new Response('x',{headers:{'Content-Type':'text/html'}})});
 await assert.rejects(bad.binary('/api/evidence/10000000-0000-4000-8000-000000000002/content'),e=>e.code==='BAD_RESPONSE');
});
