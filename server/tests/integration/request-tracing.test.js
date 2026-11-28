import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {createApp} from '../../src/app.js';
import {createAccountApp} from '../../src/account-app.js';
import {createPool} from '../../src/db.js';
import {migrate} from '../../scripts/migrate.js';
import {createDisposableDatabase} from '../helpers/test-db.js';

test('gateway and introspection preserve one request ID without logging identity or payload',async t=>{
 const db=await createDisposableDatabase(process.env.TEST_DATABASE_URL),pool=createPool(db.url),servers=[],logs=[];
 t.after(async()=>{for(const server of servers)await new Promise(r=>{server.close(r);server.closeAllConnections();});await pool.end();await db.drop();});
 await migrate(pool);
 const secret='synthetic-internal-tracing-credential-2026',buildSha='abcdef1234567890';
 const listen=async app=>{const server=app.listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
 const account=await listen(createAccountApp({pool,internalServiceToken:secret,buildSha,log:e=>logs.push(e)}));
 const app=await listen(createApp({pool,accountServiceUrl:account,internalServiceToken:secret,buildSha,log:e=>logs.push(e)}));
 const post=(path,body,id)=>fetch(app+path,{method:'POST',headers:{'Content-Type':'application/json','X-Request-ID':id},body:JSON.stringify(body)});
 const credentials={email:'synthetic-tracing@example.com',password:'synthetic-tracing-password-2026',name:'Synthetic tracing'};
 const registered=await post('/api/auth/register',credentials,'trace-register-0001');
 assert.equal(registered.status,201);assert.equal(registered.headers.get('x-request-id'),'trace-register-0001');
 const login=await post('/api/auth/login',{email:credentials.email,password:credentials.password},'trace-login-00001');
 const session=await login.json();assert.equal(login.status,200);
 const fields=await fetch(app+'/api/fields',{headers:{Authorization:'Bearer '+session.token,'X-Request-ID':'trace-business-001'}});
 assert.equal(fields.status,200);assert.equal(fields.headers.get('x-request-id'),'trace-business-001');
 for(const id of ['trace-register-0001','trace-login-00001','trace-business-001'])assert.deepEqual(logs.filter(e=>e.requestId===id).map(e=>e.service).sort(),['account-service','booking-service']);
 for(const origin of [account,app]){
  const health=await fetch(origin+'/health');assert.equal(health.headers.get('x-build-sha'),buildSha);assert.deepEqual(await health.json(),{status:'ok'});
 }
 const invalid=await fetch(app+'/missing',{headers:{'X-Request-ID':'bad'}});assert.match(invalid.headers.get('x-request-id'),/^[0-9a-f-]{36}$/);
 for(const value of [secret,credentials.email,credentials.password,session.token,'/api/fields','authorization'])assert.ok(!JSON.stringify(logs).includes(value),value);
});
