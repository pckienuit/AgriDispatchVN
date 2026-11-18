// Local disposable browser fixture. Registers through HTTP; SQL grants synthetic roles only.
/* global process, fetch, console */
// Run in foreground, then browser-smoke --operations in another terminal; SIGTERM cleans up DB.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createPool} from '../../src/db.js';
import {migrate} from '../../scripts/migrate.js';
import {seedCatalog} from '../../scripts/seed-catalog.js';
import {createDisposableDatabase} from './test-db.js';
import {createAccountApp} from '../../src/account-app.js';
import {createApp} from '../../src/app.js';
assert.ok(process.env.SYNTHETIC_LOGIN_FILE, 'SYNTHETIC_LOGIN_FILE output path required');
const db=await createDisposableDatabase(process.env.TEST_DATABASE_URL);
const pool=createPool(db.url);await migrate(pool);await seedCatalog(pool);
const secret=randomBytes(32).toString('base64url'),password=randomBytes(20).toString('base64url');
const account=createAccountApp({pool,internalServiceToken:secret}).listen(33101,'127.0.0.1');
// Explicit synthetic browser-only object store. Never used by runtime server configuration.
const objects=new Map();
const evidenceStore={put:async(key,bytes,contentType)=>{objects.set(key,{bytes,contentType});return {etag:'"synthetic-browser"',versionId:null};},get:async(key,{thumbnail=false}={})=>thumbnail?null:objects.get(key)??null,remove:async key=>objects.delete(key)};
const booking=createApp({pool,accountServiceUrl:'http://127.0.0.1:33101',internalServiceToken:secret,evidenceStore}).listen(33100,'127.0.0.1');
await new Promise(r=>booking.listening?r():booking.once('listening',r));
const post=async(path,body,token,headers={})=>{const res=await fetch('http://127.0.0.1:33100'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token} : {}),...headers},body:JSON.stringify(body)});const data=await res.json();assert.ok(res.ok,`${path} ${res.status} ${JSON.stringify(data)}`);return data;};
const actors={};
for(const role of ['farmer','coop','provider','operator','admin']){
 const email=`synthetic-${role}@example.com`;
 const {user}=await post('/api/auth/register',{email,password,name:`Synthetic ${role}`});
 if(role!=='farmer')await pool.query('INSERT INTO account.user_roles(user_id,role) VALUES($1,$2)',[user.id,role]);
 actors[role]=await post('/api/auth/login',{email,password});
}
const field=(await post('/api/fields',{name:'Thửa mô phỏng',locality:'Địa bàn mô phỏng',areaM2:12000},actors.farmer.token)).field;
const startAt='2026-12-04T08:00:00Z',endAt='2026-12-04T12:00:00Z';
const order=(await post('/api/bookings',{fieldId:field.id,serviceId:'00000000-0000-4000-8000-000000000102',startAt,endAt},actors.farmer.token,{'Idempotency-Key':'synthetic-operations-browser-0001'})).booking;
const dispatchUi=process.argv.includes('--dispatch');
let pkg;
let cancelPackageId;
if(dispatchUi){
 const extra=(await post('/api/bookings',{fieldId:field.id,serviceId:'00000000-0000-4000-8000-000000000102',startAt,endAt},actors.farmer.token,{'Idempotency-Key':'synthetic-cancel-browser-key-0001'})).booking;
 await post(`/api/bookings/${extra.id}/coordinator`,{coordinatorId:actors.coop.user.id},actors.farmer.token);
 cancelPackageId=(await post('/api/packages',{bookingIds:[extra.id]},actors.coop.token)).package.id;
}
if(!dispatchUi){
 await post(`/api/bookings/${order.id}/coordinator`,{coordinatorId:actors.coop.user.id},actors.farmer.token);
 pkg=(await post('/api/packages',{bookingIds:[order.id]},actors.coop.token)).package;
}
const job=(await post('/api/jobs',{title:'Tuyển thợ mô phỏng',locality:'Địa bàn mô phỏng',capacity:1,startAt,endAt},actors.provider.token)).job;
const application=(await post(`/api/jobs/${job.id}/applications`,{},actors.operator.token)).application;
const offer=(await post(`/api/applications/${application.id}/offers`,{},actors.provider.token)).offer;
await post(`/api/offers/${offer.id}/accept`,{},actors.operator.token);
if(!dispatchUi){
 const machine=(await post('/api/machines',{name:'Máy gặt mô phỏng',type:'harvester'},actors.provider.token)).machine;
 await post(`/api/packages/${pkg.id}/claim`,{machineId:machine.id,operatorId:actors.operator.user.id},actors.provider.token);
}

await writeFile(process.env.SYNTHETIC_LOGIN_FILE,JSON.stringify({password,packageId:pkg?.id,bookingId:order.id,coopId:actors.coop.user.id,cancelPackageId}),{mode:0o600});
console.log('OPERATIONS_SMOKE_READY');
process.on('SIGTERM',async()=>{await Promise.all([account,booking].map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));await pool.end();await db.drop();process.exit(0);});
