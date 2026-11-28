import express from 'express';
import {hasOpenDispute} from './disputes.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES={'harvest-combine':'harvester','tillage-tractor':'tractor','drone-spray':'drone'};
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const id=value=>{if(typeof value!=='string'||!UUID.test(value))throw fail(400,'INVALID_ID');return value.toLowerCase();};
function body(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value))throw fail(400,'INVALID_BODY');
  if(Object.keys(value).some(key=>!keys.includes(key)))throw fail(400,'UNKNOWN_FIELD');
  return value;
}
function instant(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))throw fail(400,'VALIDATION_FAILED');
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())||date.toISOString()!==(value.includes('.')?value:value.replace('Z','.000Z')))throw fail(400,'VALIDATION_FAILED');
  return date;
}
async function transaction(pool,work){
  const db=await pool.connect();let broken=false;
  try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
  catch(error){try{await db.query('ROLLBACK');}catch{broken=true;}throw error;}
  finally{db.release(broken);}
}
async function context(db,packageId,actor,lock=false){
  const {rows}=await db.query(`SELECT p.* FROM dispatch.packages p WHERE p.id=$1 AND
    (p.coop_id=$2 OR p.provider_id=$2 OR p.operator_id=$2 OR EXISTS
      (SELECT 1 FROM dispatch.package_bookings pb JOIN dispatch.bookings b ON b.id=pb.booking_id WHERE pb.package_id=p.id AND b.owner_id=$2)) ${lock?'FOR UPDATE OF p':''}`,[packageId,actor.id]);
  const pkg=rows[0];if(!pkg)throw fail(404,'NOT_FOUND');
  const members=await db.query(`SELECT b.id,b.owner_id,b.state FROM dispatch.bookings b JOIN dispatch.package_bookings pb ON pb.booking_id=b.id
    WHERE pb.package_id=$1 ORDER BY b.id ${lock?'FOR UPDATE OF b':''}`,[packageId]);
  const owners=[...new Set(members.rows.map(row=>row.owner_id))].sort();
  let blocked=false;
  for(const member of members.rows)if(await hasOpenDispute(db,member.id)){blocked=true;break;}
  const started=Boolean((await db.query('SELECT 1 FROM dispatch.shifts WHERE package_id=$1',[packageId])).rowCount);
  const conflict=owners.includes(pkg.provider_id);
  const eligible=pkg.status==='CLAIMED'&&!started&&!blocked&&!conflict&&owners.length>0&&members.rows.every(row=>row.state==='ASSIGNED');
  return {pkg,owners,required:[...owners,pkg.provider_id].filter(Boolean).sort(),blocked,started,conflict,eligible};
}
function eligible(ctx){
  if(ctx.started)throw fail(409,'SHIFT_ACTIVE');
  if(ctx.blocked)throw fail(409,'DISPUTE_OPEN');
  if(ctx.conflict)throw fail(409,'PARTY_CONFLICT');
  if(!ctx.eligible)throw fail(409,'PACKAGE_UNAVAILABLE');
}
async function view(db,ctx,actor){
  const {pkg}=ctx;
  const {rows}=await db.query(`SELECT p.*,a.created_at AS applied_at,
    (SELECT count(*)::int FROM dispatch.postponement_consents c WHERE c.package_id=p.package_id AND c.version=p.version) AS consented_count,
    EXISTS (SELECT 1 FROM dispatch.postponement_consents c WHERE c.package_id=p.package_id AND c.version=p.version AND c.actor_id=$2) AS own_consented
    FROM dispatch.postponement_proposals p LEFT JOIN dispatch.postponement_applications a USING(package_id,version)
    WHERE p.package_id=$1 ORDER BY p.version DESC LIMIT 20`,[pkg.id,actor.id]);
  const history=rows.map(row=>({version:row.version,oldStartAt:row.old_start_at.toISOString(),oldEndAt:row.old_end_at.toISOString(),
    startAt:row.start_at.toISOString(),endAt:row.end_at.toISOString(),reason:row.reason,createdAt:row.created_at.toISOString(),
    requiredCount:row.required_actors.length,consentedCount:row.consented_count,ownConsented:row.own_consented,appliedAt:row.applied_at?.toISOString()??null}));
  const latest=history[0]??null;
  const party=ctx.required.includes(actor.id);
  return {package:{id:pkg.id,status:pkg.status,startAt:pkg.window_start_at.toISOString(),endAt:pkg.window_end_at.toISOString()},
    permissions:{canPropose:ctx.eligible&&(party||pkg.coop_id===actor.id),canConsent:ctx.eligible&&party&&Boolean(latest&&!latest.appliedAt&&!latest.ownConsented)},latest,history};
}
async function apply(db,ctx,proposal){
  const {pkg}=ctx;
  if(proposal.provider_id!==pkg.provider_id||proposal.machine_id!==pkg.machine_id||proposal.operator_id!==pkg.operator_id||
    proposal.old_start_at.getTime()!==pkg.window_start_at.getTime()||proposal.old_end_at.getTime()!==pkg.window_end_at.getTime()||
    JSON.stringify(proposal.required_actors)!==JSON.stringify(ctx.required))throw fail(409,'STALE_VERSION');
  const keys=[`machine:${pkg.machine_id}`,`operator:${pkg.operator_id}`].sort();
  for(const key of keys)await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[key]);
  const machine=(await db.query(`SELECT m.machine_type,m.status,s.code FROM dispatch.machines m JOIN dispatch.services s ON s.id=$3
    WHERE m.id=$1 AND m.owner_id=$2 FOR SHARE OF m`,[pkg.machine_id,pkg.provider_id,pkg.service_id])).rows[0];
  if(!machine||machine.status!=='available'||machine.machine_type!==TYPES[machine.code])throw fail(409,'MACHINE_UNAVAILABLE');
  const accepted=await db.query(`SELECT 1 FROM dispatch.offers o JOIN dispatch.jobs j ON j.id=o.job_id
    JOIN account.user_roles r ON r.user_id=o.operator_id AND r.role='operator'
    WHERE o.operator_id=$1 AND o.status='ACCEPTED' AND j.provider_id=$2 AND j.start_at<=$3 AND j.end_at>=$4 LIMIT 1`,
  [pkg.operator_id,pkg.provider_id,proposal.start_at,proposal.end_at]);
  if(!accepted.rowCount)throw fail(409,'OPERATOR_NOT_AUTHORIZED');
  if(!(await db.query("SELECT 1 FROM account.user_roles WHERE user_id=$1 AND role='provider'",[pkg.provider_id])).rowCount)throw fail(409,'PARTY_CONFLICT');
  const collisions=await db.query(`SELECT 1 FROM dispatch.allocations WHERE resource_key=ANY($1::text[]) AND released_at IS NULL
    AND package_id<>$2 AND start_at<$4 AND end_at>$3 LIMIT 1`,[keys,pkg.id,proposal.start_at,proposal.end_at]);
  if(collisions.rowCount)throw fail(409,'SCHEDULE_CONFLICT');
  const updated=await db.query(`UPDATE dispatch.allocations SET start_at=$2,end_at=$3
    WHERE package_id=$1 AND released_at IS NULL AND resource_key=ANY($4::text[])`,[pkg.id,proposal.start_at,proposal.end_at,keys]);
  if(updated.rowCount!==2)throw fail(409,'PACKAGE_UNAVAILABLE');
  await db.query('UPDATE dispatch.packages SET window_start_at=$2,window_end_at=$3 WHERE id=$1',[pkg.id,proposal.start_at,proposal.end_at]);
  await db.query('INSERT INTO dispatch.postponement_applications(package_id,version) VALUES($1,$2)',[pkg.id,proposal.version]);
}
export function createPostponementRouter({pool,authenticate}){
  if(typeof pool?.connect!=='function'||typeof authenticate!=='function')throw new TypeError('Postponement requires pool and authentication');
  const router=express.Router();
  const route=work=>async(req,res,next)=>{
    try{
      if(!req.actor||typeof req.actor.id!=='string'||!UUID.test(req.actor.id)||!Array.isArray(req.actor.roles))throw fail(401,'UNAUTHENTICATED');
      res.set('Cache-Control','no-store');
      const result=await transaction(pool,db=>work(db,req));res.status(result.status??200).json(result.body);
    }catch(error){
      if(error.status)return res.status(error.status).json({error:{code:error.code}});
      if(error.code==='23001')return res.status(409).json({error:{code:'STATE_CHANGED'}});
      if(/^(08|57P01|53300|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)/.test(error.code??''))return res.status(503).json({error:{code:'DB_UNAVAILABLE'}});
      next(error);
    }
  };
  router.get('/api/bookings/:id/postponement',authenticate,route(async(db,req)=>{
    const {rows}=await db.query(`SELECT pb.package_id FROM dispatch.bookings b LEFT JOIN dispatch.package_bookings pb ON pb.booking_id=b.id
      WHERE b.id=$1 AND b.owner_id=$2`,[id(req.params.id),req.actor.id]);
    if(!rows[0])throw fail(404,'NOT_FOUND');return {body:{packageId:rows[0].package_id??null}};
  }));
  router.get('/api/packages/:id/postponement',authenticate,route(async(db,req)=>{
    // One package lock keeps the schedule, latest version and consent counts from mixing concurrent revisions.
    const ctx=await context(db,id(req.params.id),req.actor,true);return {body:await view(db,ctx,req.actor)};
  }));
  router.post('/api/packages/:id/postponement',authenticate,route(async(db,req)=>{
    const input=body(req.body,['startAt','endAt','reason']);
    const start=instant(input.startAt),end=instant(input.endAt);
    if(end<=start||end-start>30*86400000||typeof input.reason!=='string'||!input.reason.trim()||[...input.reason.trim()].length>500)throw fail(400,'VALIDATION_FAILED');
    const ctx=await context(db,id(req.params.id),req.actor,true);eligible(ctx);
    if(!ctx.required.includes(req.actor.id)&&ctx.pkg.coop_id!==req.actor.id)throw fail(403,'FORBIDDEN');
    if(start<=ctx.pkg.window_start_at)throw fail(400,'VALIDATION_FAILED');
    await db.query(`INSERT INTO dispatch.postponement_proposals(package_id,version,old_start_at,old_end_at,start_at,end_at,reason,proposer_id,required_actors,provider_id,machine_id,operator_id)
      SELECT $1,COALESCE(max(version),0)+1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 FROM dispatch.postponement_proposals WHERE package_id=$1`,
    [ctx.pkg.id,ctx.pkg.window_start_at,ctx.pkg.window_end_at,start,end,input.reason.trim(),req.actor.id,ctx.required,ctx.pkg.provider_id,ctx.pkg.machine_id,ctx.pkg.operator_id]);
    return {status:201,body:await view(db,ctx,req.actor)};
  }));
  router.post('/api/packages/:id/postponement/:version/consent',authenticate,route(async(db,req)=>{
    body(req.body,[]);
    if(!/^[1-9]\d{0,9}$/.test(req.params.version)||Number(req.params.version)>2147483647)throw fail(400,'INVALID_VERSION');
    const ctx=await context(db,id(req.params.id),req.actor,true);
    if(!ctx.required.includes(req.actor.id))throw fail(403,'FORBIDDEN');
    const proposal=(await db.query('SELECT * FROM dispatch.postponement_proposals WHERE package_id=$1 ORDER BY version DESC LIMIT 1',[ctx.pkg.id])).rows[0];
    if(!proposal||proposal.version!==Number(req.params.version))throw fail(409,'STALE_VERSION');
    if((await db.query('SELECT 1 FROM dispatch.postponement_applications WHERE package_id=$1 AND version=$2',[ctx.pkg.id,proposal.version])).rowCount)return {body:await view(db,ctx,req.actor)};
    eligible(ctx);
    await db.query('INSERT INTO dispatch.postponement_consents(package_id,version,actor_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ctx.pkg.id,proposal.version,req.actor.id]);
    const total=(await db.query('SELECT count(*)::int n FROM dispatch.postponement_consents WHERE package_id=$1 AND version=$2',[ctx.pkg.id,proposal.version])).rows[0].n;
    if(total===proposal.required_actors.length)await apply(db,ctx,proposal);
    return {body:await view(db,await context(db,ctx.pkg.id,req.actor),req.actor)};
  }));
  return router;
}
