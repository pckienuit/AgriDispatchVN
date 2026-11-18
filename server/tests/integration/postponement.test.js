import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import express from 'express';
import {createPostponementRouter} from '../../src/postponement.js';
import {createSchedulingRouter} from '../../src/scheduling.js';
import {createDispatchRouter} from '../../src/dispatch.js';
import {createDisputeRouter} from '../../src/disputes.js';
import {createShiftRouter} from '../../src/shifts.js';
import {createPool} from '../../src/db.js';
import {migrate} from '../../scripts/migrate.js';
import {seedCatalog} from '../../scripts/seed-catalog.js';
import {createDisposableDatabase} from '../helpers/test-db.js';

const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner=id(1),owner2=id(2),coop=id(3),provider=id(4),operator=id(5),other=id(6),machine=id(7),machine2=id(8),operator2=id(9);
const at=h=>`2026-12-01T${String(h).padStart(2,'0')}:00:00.000Z`;
test('postponement consent, history, resource races and privacy on PostgreSQL',async t=>{
 const db=await createDisposableDatabase(process.env.TEST_DATABASE_URL),pool=createPool(db.url);let server;
 t.after(async()=>{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});await pool.end();await db.drop();});
 await migrate(pool);await seedCatalog(pool);
 const roles={[owner]:['farmer'],[owner2]:['coop'],[coop]:['coop'],[provider]:['provider'],[operator]:['operator'],[other]:['admin'],[operator2]:['operator']};
 for(const [user,rs] of Object.entries(roles)){
  await pool.query('INSERT INTO account.users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[user,user+'@example.com','Synthetic '+rs[0],`scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`]);
  await pool.query('INSERT INTO account.user_roles(user_id,role) VALUES($1,$2)',[user,rs[0]]);
 }
 await pool.query("INSERT INTO dispatch.machines(id,owner_id,name,machine_type) VALUES($1,$3,'Synthetic machine','tractor'),($2,$3,'Synthetic machine2','tractor')",[machine,machine2,provider]);
 for(const who of [operator,operator2]){
  const job=(await pool.query("INSERT INTO dispatch.jobs(provider_id,title,locality,capacity,start_at,end_at) VALUES($1,'Synthetic commitment','Demo',2,$2,$3) RETURNING id",[provider,at(0),at(23)])).rows[0].id;
  const app=(await pool.query("INSERT INTO dispatch.applications(job_id,operator_id,status) VALUES($1,$2,'OFFERED') RETURNING id",[job,who])).rows[0].id;
  await pool.query("INSERT INTO dispatch.offers(application_id,job_id,operator_id,status,responded_at) VALUES($1,$2,$3,'ACCEPTED',now())",[app,job,who]);
 }
 const authenticate=(req,res,next)=>{const actor=req.get('Authorization')?.slice(7);if(!roles[actor])return res.status(401).json({error:{code:'UNAUTHENTICATED'}});req.actor={id:actor,roles:roles[actor]};next();};
 const app=express();app.use(express.json());for(const make of [createPostponementRouter,createSchedulingRouter,createDispatchRouter,createDisputeRouter,createShiftRouter])app.use(make({pool,authenticate}));
 app.use((e,req,res,_next)=>res.status(e.status??500).json({error:{code:e.code??'INTERNAL_ERROR'}}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(method,path,body,actor=owner)=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+actor},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
 const post=(path,data,actor)=>call('POST',path,data,actor),get=(path,actor)=>call('GET',path,undefined,actor);
 const pkg=async(start=1,end=2,owners=[owner],m=machine,o=operator)=>{
  const bookings=[];
  for(const who of owners){
   const field=(await pool.query("INSERT INTO dispatch.fields(owner_id,name,locality,area_m2) VALUES($1,'Synthetic field','Demo',10000) RETURNING id",[who])).rows[0].id;
   bookings.push((await pool.query(`INSERT INTO dispatch.bookings(owner_id,field_id,service_id,start_at,end_at,field_name,field_area_m2,service_code,service_name,service_data_label,price_per_ha_vnd,total_vnd,coordinator_id)
    SELECT $1,$2,id,$3,$4,'Synthetic field',10000,code,name,data_label,price_per_ha_vnd,price_per_ha_vnd,$5 FROM dispatch.services WHERE code='tillage-tractor' RETURNING id`,[who,field,at(start),at(end),coop])).rows[0].id);
  }
  const grouped=await post('/api/packages',{bookingIds:bookings},coop);assert.equal(grouped.status,201);
  const p=grouped.data.package.id;assert.equal((await post(`/api/packages/${p}/claim`,{machineId:m,operatorId:o},provider)).status,200);
  return {id:p,path:`/api/packages/${p}/postponement`,bookings};
 };
 const propose=(p,start,end,actor=coop)=>post(p.path,{startAt:at(start),endAt:at(end),reason:'Synthetic rain'},actor);
 const consent=(p,actor=owner,version=1)=>post(p.path+`/${version}/consent`,{},actor);
 const error=(r,status,code)=>{assert.equal(r.status,status,JSON.stringify(r));assert.equal(r.data.error.code,code);};
 const cleanup=async p=>{const result=await post(`/api/packages/${p.id}/cancel`,{reason:'Synthetic cleanup'},coop);assert.equal(result.status,200);};
 await t.test('all distinct owners and provider consent personally; history and original snapshots survive',async()=>{
  const p=await pkg(1,2,[owner,owner2,owner]);
  const r=await propose(p,3,4);assert.equal(r.status,201);assert.equal(r.data.latest.requiredCount,3);assert.equal(r.data.latest.consentedCount,0);
  error(await consent(p,coop),403,'FORBIDDEN');error(await get(p.path,other),404,'NOT_FOUND');
  const privateView=(await get(p.path,owner)).data;assert.ok(!JSON.stringify(privateView).includes(owner2));
  assert.equal((await consent(p)).data.latest.consentedCount,1);assert.equal((await consent(p)).data.latest.consentedCount,1);
  assert.equal((await consent(p,owner2)).data.package.startAt,at(1));
  const race=await Promise.all([consent(p,provider),consent(p,provider)]);assert.deepEqual(race.map(r=>r.status),[200,200]);
  assert.ok(race.every(r=>r.data.latest.appliedAt));assert.equal(race[0].data.package.startAt,at(3));
  assert.equal((await pool.query('SELECT count(*)::int n FROM dispatch.postponement_applications WHERE package_id=$1',[p.id])).rows[0].n,1);
  assert.equal((await pool.query('SELECT start_at FROM dispatch.bookings WHERE id=$1',[p.bookings[0]])).rows[0].start_at.toISOString(),at(1));
  for(const table of ['postponement_proposals','postponement_consents','postponement_applications'])await assert.rejects(pool.query(`DELETE FROM dispatch.${table} WHERE package_id=$1`,[p.id]),e=>e.code==='23001');
  await cleanup(p);
 });
 await t.test('new proposal supersedes old consents and exact version is required',async()=>{
  const p=await pkg();await propose(p,3,4);await consent(p);assert.equal((await propose(p,4,5)).data.latest.version,2);
  error(await consent(p,provider),409,'STALE_VERSION');assert.equal((await get(p.path)).data.latest.consentedCount,0);
  await consent(p,owner,2);assert.equal((await consent(p,provider,2)).data.package.startAt,at(4));await cleanup(p);
 });
 for(const [label,m,o] of [['machine',machine,operator2],['operator',machine2,operator]])await t.test(`${label} conflict rolls back last consent; adjacent interval works`,async()=>{
  const busy=await pkg(8,10,[owner],m,o),p=await pkg(1,2);await propose(p,8,9);await consent(p);
  error(await consent(p,provider),409,'SCHEDULE_CONFLICT');const read=(await get(p.path)).data;assert.equal(read.latest.consentedCount,1);assert.equal(read.package.startAt,at(1));assert.equal(read.latest.appliedAt,null);
  await propose(p,10,11);await consent(p,owner,2);assert.equal((await consent(p,provider,2)).status,200);await cleanup(p);await cleanup(busy);
 });
 await t.test('accepted operator commitment must cover entire new interval',async()=>{
  const p=await pkg();const r=await post(p.path,{startAt:'2026-12-02T08:00:00Z',endAt:'2026-12-02T09:00:00Z',reason:'Synthetic'},coop);assert.equal(r.status,201);
  await consent(p);error(await consent(p,provider),409,'OPERATOR_NOT_AUTHORIZED');assert.equal((await get(p.path)).data.latest.consentedCount,1);await cleanup(p);
 });
 await t.test('invalid input and forged actors leave history untouched',async()=>{
  const p=await pkg();
  for(const value of [null,[],{startAt:at(3),endAt:at(4),reason:'x',actorId:provider},{startAt:'2026-02-30T03:00:00Z',endAt:at(4),reason:'x'},{startAt:at(1),endAt:at(4),reason:'x'},{startAt:at(4),endAt:at(3),reason:'x'},{startAt:at(3),endAt:at(4),reason:'x'.repeat(501)}])assert.equal((await post(p.path,value,coop)).status,400);
  error(await propose(p,3,4,operator),403,'FORBIDDEN');error(await propose(p,3,4,other),404,'NOT_FOUND');
  assert.equal((await get(p.path)).data.latest,null);await cleanup(p);
 });
 await t.test('open dispute blocks application while preserving prior consents',async()=>{
  const p=await pkg();await propose(p,3,4);await consent(p);
  const d=await post(`/api/bookings/${p.bookings[0]}/disputes`,{reason:'NO_SHOW',details:'Synthetic dispute'},owner);assert.equal(d.status,201);
  error(await consent(p,provider),409,'DISPUTE_OPEN');error(await propose(p,5,6),409,'DISPUTE_OPEN');assert.equal((await get(p.path)).data.package.startAt,at(1));await cleanup(p);
 });
 await t.test('machine availability is rechecked when the last party consents',async()=>{
  const p=await pkg();await propose(p,3,4);await consent(p);
  await pool.query("UPDATE dispatch.machines SET status='unavailable' WHERE id=$1",[machine]);
  error(await consent(p,provider),409,'MACHINE_UNAVAILABLE');
  assert.equal((await get(p.path)).data.latest.consentedCount,1);
  await pool.query("UPDATE dispatch.machines SET status='available' WHERE id=$1",[machine]);await cleanup(p);
 });
 await t.test('cancellation races last consent without leaving live allocations',async()=>{
  const p=await pkg();await propose(p,3,4);await consent(p);
  const race=await Promise.all([consent(p,provider),post(`/api/packages/${p.id}/cancel`,{reason:'Synthetic race'},coop)]);
  assert.equal(race[1].status,200);
  if(race[0].status!==200)error(race[0],409,'PACKAGE_UNAVAILABLE');
  assert.equal((await pool.query('SELECT count(*)::int n FROM dispatch.allocations WHERE package_id=$1 AND released_at IS NULL',[p.id])).rows[0].n,0);
 });
 await t.test('simultaneous reschedules cannot claim the same machine window',async()=>{
  const a=await pkg(1,2,[owner],machine,operator),b=await pkg(3,4,[owner],machine,operator2);
  await propose(a,12,13);await propose(b,12,13);await consent(a);await consent(b);
  const race=await Promise.all([consent(a,provider),consent(b,provider)]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  error(race.find(r=>r.status===409),409,'SCHEDULE_CONFLICT');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM dispatch.allocations a JOIN dispatch.allocations b
    ON a.resource_key=b.resource_key AND a.id<b.id WHERE a.released_at IS NULL AND b.released_at IS NULL
    AND a.start_at<b.end_at AND a.end_at>b.start_at`)).rows[0].n,0);
  await cleanup(a);await cleanup(b);
 });
 await t.test('start serializes against postpone and freezes further schedule writes',async()=>{
  const p=await pkg();await propose(p,3,4);await consent(p);
  await post(`/api/bookings/${p.bookings[0]}/readiness`,{drained:true,mature:true,intakeReady:true},owner);
  const race=await Promise.all([consent(p,provider),post(`/api/packages/${p.id}/shifts/start`,{},operator)]);
  assert.equal(race[1].status,201);assert.ok([200,409].includes(race[0].status));
  error(await propose(p,5,6),409,'SHIFT_ACTIVE');
  await assert.rejects(pool.query('UPDATE dispatch.packages SET window_start_at=$2,window_end_at=$3 WHERE id=$1',[p.id,at(5),at(6)]),e=>e.code==='23001');
 });
 assert.deepEqual(await migrate(pool),[]);
});
