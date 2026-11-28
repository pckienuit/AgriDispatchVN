import express from 'express';
import {Buffer} from 'node:buffer';
import {createHash,randomUUID} from 'node:crypto';
import {createEvidenceThumbnail,inspectEvidenceImage,isEvidenceThumbnail} from './evidence-image.js';
import {parsePagination} from './catalog.js';
import {isActiveMediatorIndependent} from './disputes.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const identifier=value=>{if(typeof value!=='string'||!UUID.test(value))throw fail(400,'INVALID_ID');return value.toLowerCase();};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const dto=row=>({id:row.id,status:row.status,contentType:row.content_type,byteSize:row.byte_size,width:row.width,height:row.height,createdAt:row.created_at.toISOString()});
// Deliberate bounded buffering: at most 5 MiB per file. No public URLs, file paths or user filenames.
async function transaction(pool,work){
  const db=await pool.connect();let broken=false;
  try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
  catch(error){try{await db.query('ROLLBACK');}catch{broken=true;}throw error;}
  finally{db.release(broken);}
}
async function caseAccess(db,caseId,actor,{write=false,lock=false}={}){
  const {rows}=await db.query(`SELECT d.* FROM dispatch.disputes d WHERE d.id=$1 ${lock?'FOR UPDATE OF d':''}`,[caseId]);
  const row=rows[0];if(!row)throw fail(404,'NOT_FOUND');
  const isParty=[row.claimant_id,row.respondent_id].includes(actor.id);
  if(!isParty&&!(await isActiveMediatorIndependent(db,row,actor.id)))throw fail(404,'NOT_FOUND');
  if(write){
    if(!isParty)throw fail(403,'FORBIDDEN');
    if(row.status!=='OPEN')throw fail(409,'DISPUTE_NOT_OPEN');
  }
  return row;
}
export function createEvidenceRouter({pool,authenticate,store=null}){
  if(typeof pool?.connect!=='function'||typeof authenticate!=='function')throw new TypeError('Evidence requires database and authentication');
  if(store!==null&&(['put','get','remove'].some(key=>typeof store[key]!=='function')||
    (store.inlineThumbnails&&typeof store.putThumbnail!=='function')))throw new TypeError('Invalid evidence storage');
  async function removeStored(key){
    try{await store.remove(key);}catch{/* orphan remains private; no success claim */}
    if(store.inlineThumbnails){
      try{await store.remove(key,{thumbnail:true});}catch{/* best-effort orphan cleanup */}
    }
  }
  const router=express.Router();
  const handle=work=>async(req,res,next)=>{
    try{
      if(!req.actor||typeof req.actor.id!=='string'||!UUID.test(req.actor.id)||!Array.isArray(req.actor.roles))throw fail(401,'UNAUTHENTICATED');
      res.set('Cache-Control','private, no-store');await work(req,res,next);
    }catch(error){
      if(error.status)return res.status(error.status).json({error:{code:error.code}});
      if(error.code==='23001')return res.status(409).json({error:{code:'STATE_CHANGED'}});
      if(error.code==='STORAGE_UNAVAILABLE')return res.status(503).json({error:{code:'STORAGE_UNAVAILABLE'}});
      if(/^(08|57P01|53300|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)/.test(error.code??''))return res.status(503).json({error:{code:'DB_UNAVAILABLE'}});
      next(error);
    }
  };
  const access=handle(async(req,res,next)=>{
    req.evidenceCase=identifier(req.params.id);
    await caseAccess(pool,req.evidenceCase,req.actor,{write:true});
    if(!store)throw fail(503,'STORAGE_UNAVAILABLE');
    const type=req.get('Content-Type');
    if(!['image/jpeg','image/png'].includes(type))throw fail(415,'UNSUPPORTED_MEDIA_TYPE');
    if(req.get('Content-Encoding')&&req.get('Content-Encoding')!=='identity')throw fail(415,'UNSUPPORTED_MEDIA_TYPE');
    req.evidenceType=type;
    next();
  });
  router.post('/api/disputes/:id/evidence',authenticate,access,express.raw({type:()=>true,limit:5242880,inflate:false}),handle(async(req,res)=>{
    const bytes=req.body;
    const dimensions=inspectEvidenceImage(bytes,req.evidenceType),sha=hash(bytes);
    const created=await transaction(pool,async db=>{
      await caseAccess(db,req.evidenceCase,req.actor,{write:true,lock:true});
      const duplicate=(await db.query(`SELECT * FROM dispatch.evidence WHERE dispute_id=$1 AND uploader_id=$2 AND sha256=$3
        AND status IN ('PENDING','UPLOADED')`,[req.evidenceCase,req.actor.id,sha])).rows[0];
      if(duplicate){if(duplicate.status==='PENDING')throw fail(409,'UPLOAD_PENDING');return {row:duplicate,replay:true};}
      // Security/storage cap only, not a survey-derived business rule. Failed attempts retain audit rows.
      const count=(await db.query("SELECT count(*)::int n FROM dispatch.evidence WHERE dispute_id=$1 AND status IN ('PENDING','UPLOADED')",[req.evidenceCase])).rows[0].n;
      if(count>=10)throw fail(409,'EVIDENCE_LIMIT');
      const id=randomUUID(),key=`${req.evidenceCase}/${id}/${sha}`;
      const {rows}=await db.query(`INSERT INTO dispatch.evidence(id,dispute_id,uploader_id,status,content_type,byte_size,width,height,sha256,object_key)
        VALUES($1,$2,$3,'PENDING',$4,$5,$6,$7,$8,$9) RETURNING *`,[id,req.evidenceCase,req.actor.id,req.evidenceType,bytes.length,dimensions.width,dimensions.height,sha,key]);
      return {row:rows[0],replay:false};
    });
    if(created.replay)return res.json({evidence:dto(created.row)});
    const row=created.row;let stored;
    try{
      const thumb=store.inlineThumbnails?await createEvidenceThumbnail(bytes,row.object_key):null;
      stored=await store.put(row.object_key,bytes,row.content_type);
      if(thumb)await store.putThumbnail(row.object_key,thumb);
    }catch(error){
      const failed=await pool.query("UPDATE dispatch.evidence SET status='FAILED' WHERE id=$1 AND status='PENDING'",[row.id]);
      if(failed.rowCount)await removeStored(row.object_key);
      if(error.code==='INVALID_IMAGE')throw error;
      throw fail(503,'STORAGE_UNAVAILABLE');
    }
    // Commit outcome may be unknown; retain private bytes so a retry can inspect the hash-bound row.
    const final=await transaction(pool,async db=>{
        const d=await db.query('SELECT status FROM dispatch.disputes WHERE id=$1 FOR UPDATE',[row.dispute_id]);
        const current=(await db.query('SELECT * FROM dispatch.evidence WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
        if(current.status==='UPLOADED')return {row:current,replay:true};
        if(d.rows[0]?.status!=='OPEN'||current.status!=='PENDING'){
          const failed=await db.query("UPDATE dispatch.evidence SET status='FAILED' WHERE id=$1 AND status='PENDING'",[row.id]);
          return {cleanup:failed.rowCount>0};
        }
        return {row:(await db.query(`UPDATE dispatch.evidence SET status='UPLOADED',etag=$2,blob_version=$3,uploaded_at=clock_timestamp()
          WHERE id=$1 RETURNING *`,[row.id,stored.etag,stored.versionId])).rows[0]};
      });
    if(!final.row){if(final.cleanup)await removeStored(row.object_key);throw fail(409,'DISPUTE_NOT_OPEN');}
    res.status(final.replay?200:201).json({evidence:dto(final.row)});
  }));
  router.get('/api/disputes/:id/evidence',authenticate,handle(async(req,res)=>{
    const caseId=identifier(req.params.id);await caseAccess(pool,caseId,req.actor);
    const {limit,offset}=parsePagination(req.query);
    const {rows}=await pool.query("SELECT * FROM dispatch.evidence WHERE dispute_id=$1 AND status='UPLOADED' ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3",[caseId,limit,offset]);
    const d=await caseAccess(pool,caseId,req.actor);
    res.json({items:rows.map(dto),limit,offset,canUpload:d.status==='OPEN'&&[d.claimant_id,d.respondent_id].includes(req.actor.id),storageAvailable:store!==null});
  }));
  for(const kind of ['content','thumbnail'])router.get(`/api/evidence/:id/${kind}`,authenticate,handle(async(req,res)=>{
    const row=(await pool.query("SELECT * FROM dispatch.evidence WHERE id=$1 AND status='UPLOADED'",[identifier(req.params.id)])).rows[0];
    if(!row)throw fail(404,'NOT_FOUND');await caseAccess(pool,row.dispute_id,req.actor);
    if(!store)throw fail(503,'STORAGE_UNAVAILABLE');
    const thumbnail=kind==='thumbnail';
    const getOriginal=async()=>{
      const original=await store.get(row.object_key,{maxBytes:row.byte_size});
      if(!original)throw fail(404,'CONTENT_UNAVAILABLE');
      if(!Buffer.isBuffer(original.bytes)||original.contentType!==row.content_type||
        original.bytes.length!==row.byte_size||hash(original.bytes)!==row.sha256)throw fail(503,'STORAGE_UNAVAILABLE');
      return original;
    };
    let result=thumbnail?await store.get(row.object_key,{thumbnail:true}):await getOriginal();
    if(thumbnail&&!result&&store.inlineThumbnails){
      const original=await getOriginal();
      let bytes;
      try{bytes=await createEvidenceThumbnail(original.bytes,row.object_key);}
      catch(error){if(error.code==='INVALID_IMAGE')throw fail(503,'STORAGE_UNAVAILABLE');throw error;}
      await caseAccess(pool,row.dispute_id,req.actor);
      await store.putThumbnail(row.object_key,bytes);
      result={bytes,contentType:'image/jpeg'};
    }
    if(!result)throw fail(404,'THUMBNAIL_PENDING');
    if(thumbnail&&(result.contentType!=='image/jpeg'||!isEvidenceThumbnail(result.bytes)))throw fail(503,'STORAGE_UNAVAILABLE');
    await caseAccess(pool,row.dispute_id,req.actor);
    res.set({'Content-Type':thumbnail?'image/jpeg':row.content_type,'X-Content-Type-Options':'nosniff','Content-Disposition':thumbnail?'inline':'attachment',
      'Content-Security-Policy':"default-src 'none'; sandbox"});res.send(result.bytes);
  }));
  return router;
}
