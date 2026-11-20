import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import express from 'express';
import { hashPassword } from '../../src/auth/password.js';
import { createPool } from '../../src/db.js';
import { createWorkforceRouter } from '../../src/workforce.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase, parseRootDatabaseUrl } from '../helpers/catalog-db.js';

parseRootDatabaseUrl(process.env.TEST_DATABASE_URL);
const OP='31000000-0000-4000-8000-000000000001';
const ADMIN='31000000-0000-4000-8000-000000000002';
const ACTORS={'op-test':{id:OP,roles:['operator']},'admin-test':{id:ADMIN,roles:['admin']}};
function auth(req,res,next){const token=(req.get('authorization')||'').replace(/^Bearer /,'');if(!ACTORS[token])return res.status(401).json({error:{code:'UNAUTHENTICATED'}});req.actor=ACTORS[token];next();}
const ctx={};
before(async()=>{
  ctx.db=await createDisposableDatabase(process.env.TEST_DATABASE_URL,{label:'workforce'});
  ctx.pool=createPool(ctx.db.url,{statementTimeout:60000});
  ctx.applied=await migrate(ctx.pool);
  const provider='31000000-0000-4000-8000-000000000004';
  const hash = await hashPassword('synthetic-workforce-test-only');
  await ctx.pool.query('INSERT INTO account.users(id,email,name,password_hash) VALUES($1,$2,$3,$4),($5,$6,$7,$4),($8,$9,$10,$4)',[OP,'operator@example.test','Operator',hash,ADMIN,'admin@example.test','Admin',provider,'provider@example.test','Provider']);
  await ctx.pool.query("INSERT INTO account.user_roles(user_id,role) VALUES($1,'operator'),($2,'admin'),($3,'provider')",[OP,ADMIN,provider]);
  ACTORS['provider-test']={id:provider,roles:['provider']};
  ctx.provider=provider;
  const app=express();app.use(express.json());app.use(createWorkforceRouter({pool:ctx.pool,authenticate:auth}));
  app.use((e,req,res,_next)=>res.status(500).json({error:{code:'INTERNAL_ERROR'}}));
  ctx.server=app.listen(0,'127.0.0.1');await once(ctx.server,'listening');ctx.url=`http://127.0.0.1:${ctx.server.address().port}`;
});
after(async()=>{if(ctx.server)await new Promise((resolve,reject)=>ctx.server.close(e=>e?reject(e):resolve()));if(ctx.pool)await ctx.pool.end();if(ctx.db)await ctx.db.drop();});
async function call(path,{token='op-test',method='GET',body}={}){const r=await fetch(ctx.url+path,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()};}
test('migration 022 stores self-reported operator skills and certification expiry without fabricated verification',async()=>{
  assert.ok(ctx.applied.includes('022_workforce.sql'));
  const saved=await call('/api/workforce/profile',{method:'PUT',body:{skills:['gặt lúa'],certifications:[{name:'Vận hành máy',expiresAt:'2027-06-30'}]}});
  assert.equal(saved.status,200);
  const read=await call('/api/workforce/profile');assert.equal(read.status,200);
  assert.deepEqual(read.body.profile.skills,['gặt lúa']);
  assert.equal(read.body.profile.certifications[0].expiresAt,'2027-06-30');
  assert.equal(read.body.profile.certifications[0].verificationStatus,'UNVERIFIED');
});
test('A-01 review requires admin identity and records separate reviewed metadata',async()=>{
  const cert=await ctx.pool.query('SELECT id FROM dispatch.operator_certifications WHERE operator_id=$1',[OP]);
  const denied=await call('/api/admin/workforce/certifications',{token:'op-test'});assert.equal(denied.status,403);
  const reviewed=await call(`/api/admin/workforce/certifications/${cert.rows[0].id}/review`,{token:'admin-test',method:'POST',body:{status:'VERIFIED'}});
  assert.equal(reviewed.status,200);assert.equal(reviewed.body.certification.verificationStatus,'VERIFIED');
  assert.ok(reviewed.body.certification.reviewedAt);
  const pending = await ctx.pool.query("INSERT INTO dispatch.operator_certifications(operator_id,name,expires_on) VALUES($1,'Second certificate','2028-01-01') RETURNING id", [OP]);
  await assert.rejects(() => ctx.pool.query('UPDATE dispatch.operator_certifications SET verification_status=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$1', [pending.rows[0].id,'VERIFIED',OP]), { code:'23001' });
  await assert.rejects(() => ctx.pool.query('UPDATE dispatch.operator_certifications SET verification_status=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$1', [cert.rows[0].id,'REJECTED',ADMIN]), { code:'23001' });
});

test('wage report API only lets assigned provider report on completed shifts and keeps acknowledgment separate', async () => {
  const operator=OP;
  const provider=ctx.provider;
  await seedCatalog(ctx.pool);
  const {rows:[service]}=await ctx.pool.query("SELECT * FROM dispatch.services WHERE code='harvest-combine'");
  const {rows:[field]}=await ctx.pool.query("INSERT INTO dispatch.fields(owner_id,name,locality,area_m2) VALUES($1,'ruộng','xã',10000) RETURNING id",[OP]);
  const coop='31000000-0000-4000-8000-000000000003';
  await ctx.pool.query("INSERT INTO account.users(id,email,name,password_hash) SELECT $1,'coop@example.test','HTX thử nghiệm',password_hash FROM account.users WHERE id=$2",[coop,ADMIN]);
  await ctx.pool.query("INSERT INTO account.user_roles(user_id,role) VALUES($1,'coop')",[coop]);
  const {rows:[booking]}=await ctx.pool.query(`INSERT INTO dispatch.bookings(owner_id,field_id,service_id,start_at,end_at,field_name,field_area_m2,service_code,service_name,service_data_label,price_per_ha_vnd,total_vnd,state,coordinator_id)
    VALUES($1,$2,$3,now(),now()+interval '1 hour','ruộng',10000,$4,$5,$6,$7,$7,'ASSIGNED',$8) RETURNING id`,[OP,field.id,service.id,service.code,service.name,service.data_label,service.price_per_ha_vnd,coop]);
  const {rows:[machine]}=await ctx.pool.query("INSERT INTO dispatch.machines(owner_id,name,machine_type) VALUES($1,'Máy gặt thử','harvester') RETURNING id",[provider]);
  const {rows:[pkg]}=await ctx.pool.query(`INSERT INTO dispatch.packages(coop_id,service_id,locality,window_start_at,window_end_at,status,provider_id,operator_id,machine_id)
    SELECT $1,service_id,'xã',start_at,end_at,'CLAIMED',$2,$3,$4 FROM dispatch.bookings WHERE id=$5
    RETURNING id`,[coop,provider,operator,machine.id,booking.id]);
  await ctx.pool.query('INSERT INTO dispatch.package_bookings(package_id,booking_id) VALUES($1,$2)',[pkg.id,booking.id]);
  const {rows:[readiness]}=await ctx.pool.query('INSERT INTO dispatch.readiness_events(booking_id,actor_id,drained,mature,intake_ready) VALUES($1,$2,true,true,true) RETURNING sequence',[booking.id,OP]);
  await ctx.pool.query(`INSERT INTO dispatch.field_inspections(booking_id,package_id,reviewer_id,result,readiness_sequence,window_start_at,window_end_at)
    SELECT $1,id,$3,'PASSED',$4,window_start_at,window_end_at FROM dispatch.packages WHERE id=$2`,[booking.id,pkg.id,coop,readiness.sequence]);
  const {rows:[shift]}=await ctx.pool.query("INSERT INTO dispatch.shifts(package_id,status) VALUES($1,'RUNNING') RETURNING id",[pkg.id]);
  const action = `/api/shifts/${shift.id}/wage-report`;
  const reportInput = {method:'POST',body:{amountVnd:'1250000'}};
  const early=await call(action,{...reportInput,token:'provider-test'});
  assert.equal(early.status,409);
  assert.equal(early.body.error.code,'SHIFT_NOT_COMPLETED');
  await ctx.pool.query("UPDATE dispatch.shifts SET status='COMPLETED',completed_at=now(),area_m2=10000 WHERE id=$1",[shift.id]);
  const notParticipant=await call(`/api/shifts/${shift.id}/wage-report`,{token:'op-test',method:'POST',body:{amountVnd:'1250000'}});assert.equal(notParticipant.status,403);
  const report=await call(`/api/shifts/${shift.id}/wage-report`,{token:'admin-test',method:'POST',body:{amountVnd:'1250000'}});assert.equal(report.status,403);
  const recorded=await call(action,{...reportInput,token:'provider-test'});
  assert.equal(recorded.status,200);
  assert.equal(recorded.body.report.acknowledged,false);
  const reportId=recorded.body.report.id;
  await assert.rejects(() => ctx.pool.query('INSERT INTO dispatch.shift_wage_acknowledgments(report_id,actor_id) VALUES($1,$2)',[reportId,provider]), {code:'23001'});
  const ackPath=`/api/wage-reports/${reportId}/acknowledge`;
  assert.equal((await call(ackPath,{token:'provider-test',method:'POST',body:{}})).status,404);
  assert.equal((await call(ackPath,{method:'POST',body:{}})).status,200);
  const listing=await call('/api/workforce/wages',{token:'provider-test'});
  assert.equal(listing.status,200);
  assert.equal(listing.body.items.find((row) => row.id === reportId).acknowledged,true);
});
