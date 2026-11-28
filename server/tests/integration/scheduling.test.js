import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { createSchedulingRouter } from '../../src/scheduling.js';
import { createDispatchRouter } from '../../src/dispatch.js';
import { createPool } from '../../src/db.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const farmer = id(1), coop = id(2), provider = id(3), other = id(4), operator = id(5), operator2 = id(6);
const machine = id(7), machine2 = id(8);
const at = (hour) => `2026-12-01T${String(hour).padStart(2, '0')}:00:00Z`;

test('claims serialize package, machine and operator allocation; cancellation releases schedules without erasing history', async (t) => {
  const db = await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool = createPool(db.url);
  let server;
  t.after(async () => {
    if (server) await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    await pool.end(); await db.drop();
  });
  await migrate(pool); await seedCatalog(pool);
  const hash = `scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;
  for (const [user, role] of [[farmer,'farmer'],[coop,'coop'],[provider,'provider'],[other,'provider'],[operator,'operator'],[operator2,'operator']]) {
    await pool.query('INSERT INTO account.users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [user, user+'@example.com','Synthetic '+role,hash]);
    await pool.query('INSERT INTO account.user_roles(user_id,role) VALUES($1,$2)', [user,role]);
  }
  await pool.query("INSERT INTO dispatch.machines(id,owner_id,name,machine_type) VALUES($1,$3,'Synthetic tractor1','tractor'),($2,$3,'Synthetic tractor2','tractor')", [machine,machine2,provider]);
  const consent = async (who) => {
    const job = (await pool.query("INSERT INTO dispatch.jobs(provider_id,title,locality,capacity,start_at,end_at) VALUES($1,'Synthetic recruitment','Demo',2,$2,$3) RETURNING id",[provider,at(0),at(23)])).rows[0].id;
    const application = (await pool.query("INSERT INTO dispatch.applications(job_id,operator_id,status) VALUES($1,$2,'OFFERED') RETURNING id",[job,who])).rows[0].id;
    await pool.query("INSERT INTO dispatch.offers(application_id,job_id,operator_id,status,responded_at) VALUES($1,$2,$3,'ACCEPTED',now())",[application,job,who]);
  };
  await consent(operator); await consent(operator2);
  const actors = { [provider]:['provider'], [other]:['provider'], [coop]:['coop'], [farmer]:['farmer'] };
  const authenticate = (req,res,next) => {
    const user = req.get('Authorization')?.slice(7);
    if (!actors[user]) return res.status(401).json({error:{code:'UNAUTHENTICATED'}});
    req.actor={id:user,roles:actors[user],name:'Synthetic'}; next();
  };
  const app=express();app.use(express.json());app.use(createSchedulingRouter({pool,authenticate}));app.use(createDispatchRouter({pool,authenticate}));
  app.use((error,req,res,_next)=>res.status(500).json({error:{code:error.code??'INTERNAL_ERROR'}}));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body,actor=provider)=>{
    const r=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${actor}`},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const pkg=async(start=8,end=12)=>{
    const field=(await pool.query("INSERT INTO dispatch.fields(owner_id,name,locality,area_m2) VALUES($1,'Synthetic field','Demo',10000) RETURNING id",[farmer])).rows[0].id;
    const booking=(await pool.query(`INSERT INTO dispatch.bookings(owner_id,field_id,service_id,start_at,end_at,field_name,field_area_m2,service_code,service_name,service_data_label,price_per_ha_vnd,total_vnd,coordinator_id)
      SELECT $1,$2,id,$3,$4,'Synthetic field',10000,code,name,data_label,price_per_ha_vnd,price_per_ha_vnd,$5 FROM dispatch.services WHERE code='tillage-tractor' RETURNING id`,[farmer,field,at(start),at(end),coop])).rows[0].id;
    const result=await post('/api/packages',{bookingIds:[booking]},coop);assert.equal(result.status,201);return result.body.package.id;
  };
  const claim=(packageId,m=machine,o=operator,actor=provider)=>post(`/api/packages/${packageId}/claim`,{machineId:m,operatorId:o},actor);
  const p1=await pkg();
  assert.equal((await claim(p1,machine,operator,farmer)).status,403);
  assert.equal((await claim(p1,machine,operator,other)).status,404);
  assert.equal((await claim(p1,machine,farmer)).body.error.code,'OPERATOR_NOT_AUTHORIZED');
  const race=await Promise.all([claim(p1),claim(p1)]);
  assert.deepEqual(race.map(r=>r.status),[200,200]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM dispatch.allocations WHERE package_id=$1',[p1])).rows[0].n,2);
  assert.equal((await claim(p1,machine2)).status,409);
  const p2=await pkg();
  assert.equal((await claim(p2,machine,operator2)).body.error.code,'SCHEDULE_CONFLICT');
  assert.equal((await claim(p2,machine2,operator)).body.error.code,'SCHEDULE_CONFLICT');
  assert.equal((await pool.query("SELECT status FROM dispatch.packages WHERE id=$1",[p2])).rows[0].status,'OPEN');
  const adjacent=await pkg(12,14);assert.equal((await claim(adjacent)).status,200);
  const cancel=await post(`/api/packages/${p1}/cancel`,{reason:'Synthetic weather delay'},coop);assert.equal(cancel.status,200);
  assert.equal((await post(`/api/packages/${p1}/cancel`,{reason:'Retry'},coop)).status,200);
  assert.equal((await claim(p2)).status,200);
  assert.equal((await pool.query("SELECT count(*)::int n FROM dispatch.allocations WHERE package_id=$1 AND released_at IS NULL",[p1])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM dispatch.booking_events e JOIN dispatch.package_bookings p ON p.booking_id=e.booking_id WHERE p.package_id=$1 AND e.event_type='BOOKING_CANCELLED'",[p1])).rows[0].n,1);
  assert.equal((await post(`/api/packages/${p2}/cancel`,{reason:'Spoof',ownerId:other},provider)).status,400);
  assert.equal((await post(`/api/packages/${p2}/cancel`,{reason:'Foreign'},other)).status,404);
  const detail=await fetch(`${url}/api/packages/${p2}`,{headers:{Authorization:`Bearer ${provider}`}});assert.equal(detail.status,200);
  const a=await pkg(15,17), b=await pkg(15,17);
  const overlap=await Promise.all([claim(a,machine,operator),claim(b,machine,operator2)]);
  assert.deepEqual(overlap.map(r=>r.status).sort(),[200,409]);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM dispatch.allocations a JOIN dispatch.allocations b ON a.resource_key=b.resource_key AND a.id<b.id
    WHERE a.released_at IS NULL AND b.released_at IS NULL AND a.start_at<b.end_at AND a.end_at>b.start_at`)).rows[0].n,0);
  const c=await pkg(18,20), d=await pkg(18,20);
  const operatorRace=await Promise.all([claim(c,machine,operator),claim(d,machine2,operator)]);
  assert.deepEqual(operatorRace.map(r=>r.status).sort(),[200,409]);
  const e=await pkg(21,22);
  const closing=await Promise.all([claim(e),post(`/api/packages/${e}/cancel`,{reason:'Race cancel'},coop)]);
  assert.ok([200,409].includes(closing[0].status));
  assert.equal(closing[1].status,200);
  assert.equal((await pool.query('SELECT count(*)::int n FROM dispatch.allocations WHERE package_id=$1 AND released_at IS NULL',[e])).rows[0].n,0);
  assert.deepEqual(await migrate(pool),[]);
});
