import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { createRemedyRouter } from '../../src/remedies.js';
import { hasOpenDispute } from '../../src/disputes.js';
import { migrate } from '../../scripts/migrate.js';
import { seedCatalog } from '../../scripts/seed-catalog.js';
import { createPool } from '../../src/db.js';
import { createDisposableDatabase } from '../helpers/test-db.js';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner=id(1),provider=id(2),coop=id(3),mediator=id(4),replacement=id(5),foreign=id(6);
const actors = { [owner]:['farmer'],[provider]:['provider'],[coop]:['coop','admin'],[mediator]:['admin'],[replacement]:['admin'],[foreign]:['admin'] };

test('versioned remedies need independent party consent; unresolved closure keeps disputed obligations frozen', async (t) => {
  const db=await createDisposableDatabase(process.env.TEST_DATABASE_URL);
  const pool=createPool(db.url);let server;
  t.after(async()=>{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});await pool.end();await db.drop();});
  await migrate(pool);await seedCatalog(pool);
  const hash=`scrypt:v1:N=16384:r=8:p=1:${'A'.repeat(22)}:${'A'.repeat(86)}`;
  for(const [user,roles] of Object.entries(actors)){
    await pool.query('INSERT INTO account.users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[user,user+'@example.com','Synthetic',hash]);
    for(const role of roles)await pool.query('INSERT INTO account.user_roles(user_id,role) VALUES($1,$2)',[user,role]);
  }
  const fixture=async()=>{
    const field=(await pool.query("INSERT INTO dispatch.fields(owner_id,name,locality,area_m2) VALUES($1,'Synthetic','Demo',10000) RETURNING id",[owner])).rows[0].id;
    const booking=(await pool.query(`INSERT INTO dispatch.bookings(owner_id,field_id,service_id,start_at,end_at,field_name,field_area_m2,service_code,service_name,service_data_label,price_per_ha_vnd,total_vnd,coordinator_id)
      SELECT $1,$2,id,'2026-12-01T08:00Z','2026-12-01T12:00Z','Synthetic',10000,code,name,data_label,price_per_ha_vnd,price_per_ha_vnd,$3 FROM dispatch.services WHERE code='tillage-tractor' RETURNING id`,[owner,field,coop])).rows[0].id;
    const machine=(await pool.query("INSERT INTO dispatch.machines(owner_id,name,machine_type) VALUES($1,'Synthetic tractor','tractor') RETURNING id",[provider])).rows[0].id;
    const pkg=(await pool.query("INSERT INTO dispatch.packages(coop_id,service_id,locality,window_start_at,window_end_at,provider_id,machine_id,operator_id,status) SELECT $1,service_id,'Demo',start_at,end_at,$2,$4,$5,'CLAIMED' FROM dispatch.bookings WHERE id=$3 RETURNING id",[coop,provider,booking,machine,id(7)])).rows[0].id;
    await pool.query('INSERT INTO dispatch.package_bookings(package_id,booking_id) VALUES($1,$2)',[pkg,booking]);
    await pool.query("UPDATE dispatch.bookings SET state='GROUPED' WHERE id=$1",[booking]);
    await pool.query("UPDATE dispatch.bookings SET state='ASSIGNED' WHERE id=$1",[booking]);
    const dispute=(await pool.query("INSERT INTO dispatch.disputes(booking_id,claimant_id,respondent_id,reason,status) VALUES($1,$2,$3,'QUALITY','OPEN') RETURNING id",[booking,owner,provider])).rows[0].id;
    await pool.query('BEGIN');
    await pool.query("INSERT INTO dispatch.dispute_events(dispute_id,event_type,actor_id,data) VALUES($1,'MEDIATION_ESCALATED',$2,$3::jsonb)",[dispute,owner,JSON.stringify({reason:'Synthetic escalation',conflictType:null,previousMediatorId:null})]);
    await pool.query("UPDATE dispatch.disputes SET mediation_level='ADMIN',mediator_id=NULL,escalated_at=clock_timestamp(),escalated_by=$2,escalation_reason='Synthetic escalation' WHERE id=$1",[dispute,owner]);
    await pool.query('UPDATE dispatch.disputes SET mediator_id=$2 WHERE id=$1',[dispute,mediator]);
    await pool.query("INSERT INTO dispatch.dispute_events(dispute_id,event_type,actor_id,data) VALUES($1,'MEDIATOR_ASSIGNED',$2,$3::jsonb)",[dispute,foreign,JSON.stringify({mediatorId:mediator,previousMediatorId:null})]);
    await pool.query('COMMIT');
    return {dispute,booking};
  };
  const app=express();app.use(express.json());
  app.use(createRemedyRouter({pool,authenticate(req,res,next){const user=req.get('Authorization')?.slice(7);if(!actors[user])return res.sendStatus(401);req.actor={id:user,roles:actors[user]};next();}}));
  app.use((error,req,res,_next)=>res.status(500).json({error:{code:error.code??'INTERNAL_ERROR'}}));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(method,path,actor,payload)=>{const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${actor}`,'Content-Type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});return {status:r.status,body:await r.json()};};
  const propose=(d,text='Synthetic remedy',actor=mediator)=>call('POST',`/api/disputes/${d}/proposals`,actor,{text});
  const consent=(d,v,actor)=>call('POST',`/api/disputes/${d}/proposals/${v}/consent`,actor,{});
  const a=await fixture();
  assert.equal((await propose(a.dispute,'Spoof',owner)).status,403);
  assert.equal((await propose(a.dispute,'Foreign',foreign)).status,404);
  assert.equal((await propose(a.dispute)).status,201);
  assert.equal((await consent(a.dispute,1,mediator)).status,403);
  assert.equal((await consent(a.dispute,1,owner)).status,200);
  assert.equal((await propose(a.dispute,'Second version')).status,201);
  assert.equal((await consent(a.dispute,1,provider)).body.error.code,'STALE_VERSION');
  assert.equal((await consent(a.dispute,2,owner)).body.dispute.status,'OPEN');
  assert.equal((await consent(a.dispute,2,provider)).body.dispute.status,'RESOLVED');
  assert.equal((await consent(a.dispute,2,provider)).status,200);
  assert.equal((await propose(a.dispute)).status,409);
  assert.equal(await hasOpenDispute(pool,a.booking),false);
  const history=await call('GET',`/api/disputes/${a.dispute}/proposals`,owner);
  assert.equal(history.body.proposals.length,2);
  assert.equal(history.body.proposals[0].consents.length,1);
  assert.equal((await call('GET',`/api/disputes/${a.dispute}/proposals`,foreign)).status,404);
  const b=await fixture();await propose(b.dispute);
  // Fixture for a legitimate mediator reassignment performed in the same transaction as its audit event.
  const c=await pool.connect();try{await c.query('BEGIN');await c.query('UPDATE dispatch.disputes SET mediator_id=$2 WHERE id=$1',[b.dispute,replacement]);await c.query("INSERT INTO dispatch.dispute_events(dispute_id,event_type,actor_id,data) VALUES($1,'MEDIATOR_ASSIGNED',$2,$3::jsonb)",[b.dispute,foreign,JSON.stringify({mediatorId:replacement,previousMediatorId:mediator})]);await c.query('COMMIT');}finally{c.release();}
  assert.equal((await consent(b.dispute,1,owner)).body.error.code,'MEDIATOR_CHANGED');
  assert.equal((await propose(b.dispute,'New mediator proposal',replacement)).status,201);
  const closed=await call('POST',`/api/disputes/${b.dispute}/close-unresolved`,replacement,{reason:'Synthetic disagreement remains'});
  assert.equal(closed.status,200);assert.equal(closed.body.dispute.status,'CLOSED_UNRESOLVED');
  assert.equal(closed.body.dispute.obligationsDisputed,true);
  assert.equal(await hasOpenDispute(pool,b.booking),true);
  assert.equal((await pool.query('SELECT state FROM dispatch.bookings WHERE id=$1',[b.booking])).rows[0].state,'ASSIGNED');
  assert.equal((await consent(b.dispute,2,owner)).status,409);
  const race=await fixture();await propose(race.dispute);await consent(race.dispute,1,owner);
  const results=await Promise.all([propose(race.dispute,'Racing new version'),consent(race.dispute,1,provider)]);
  const final=(await pool.query('SELECT status FROM dispatch.disputes WHERE id=$1',[race.dispute])).rows[0].status;
  assert.ok(final==='OPEN'||final==='RESOLVED');
  assert.ok(results.some(r=>r.status===409));
  const involved=await fixture();await pool.query('INSERT INTO account.user_roles(user_id,role) VALUES($1,$2) ON CONFLICT DO NOTHING',[mediator,'provider']);
  await pool.query('UPDATE dispatch.packages SET operator_id=$2 WHERE id=(SELECT package_id FROM dispatch.package_bookings WHERE booking_id=$1)',[involved.booking,mediator]);
  assert.equal((await propose(involved.dispute)).body.error.code,'RECUSAL_REQUIRED');
  // Removing the mediator's admin grant makes old assignment insufficient for new decisions.
  await pool.query("DELETE FROM account.user_roles WHERE user_id=$1 AND role='admin'",[mediator]);
  assert.equal((await propose(involved.dispute)).body.error.code,'RECUSAL_REQUIRED');
  await assert.rejects(pool.query("UPDATE dispatch.remedy_proposals SET text='edited' WHERE dispute_id=$1",[a.dispute]),{code:'23001'});
  await assert.rejects(pool.query('DELETE FROM dispatch.remedy_events WHERE dispute_id=$1',[a.dispute]),{code:'23001'});
  assert.deepEqual(await migrate(pool),[]);
});
