'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const sharp=require('sharp');
const {Buffer}=require('node:buffer');
const process=require('node:process');
const {createThumbnailHandler}=require('./index.cjs');
const prefix='10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/';
test('Blob trigger writes only derived JPEG output and logs no key or metadata',async()=>{
 const bytes=await sharp({create:{width:500,height:400,channels:3,background:'green'}}).png().toBuffer();
 const key=prefix+createHash('sha256').update(bytes).digest('hex'),writes=[],logs=[];
 const handler=createThumbnailHandler({store:{putThumbnail:async(...args)=>writes.push(args)}});
 await handler({bindingData:{caseId:key.split('/')[0],evidenceId:key.split('/')[1],sha:key.split('/')[2]},log:x=>logs.push(x)},bytes);
 assert.equal(writes.length,1);assert.equal(writes[0][0],key);
 const meta=await sharp(writes[0][1]).metadata();assert.equal(meta.format,'jpeg');assert.equal(meta.width,320);
 assert.ok(!JSON.stringify(logs).includes(key));
 await handler({bindingData:{caseId:'bad',evidenceId:'bad',sha:'bad'},log:x=>logs.push(x)},bytes);
 assert.equal(writes.length,1);
});
test('corrupt input emits no thumbnail and no raw provider error',async()=>{
 let writes=0;const bytes=Buffer.from('synthetic corrupt image'),sha=createHash('sha256').update(bytes).digest('hex');
 const handler=createThumbnailHandler({store:{putThumbnail:async()=>writes++}});
 await handler({bindingData:{caseId:prefix.split('/')[0],evidenceId:prefix.split('/')[1],sha},log:()=>{}},bytes);
 assert.equal(writes,0);
});

test('storage failure throws a safe error for the host without exposing provider details',async()=>{
 const bytes=await sharp({create:{width:4,height:3,channels:3,background:'green'}}).png().toBuffer();
 const sha=createHash('sha256').update(bytes).digest('hex'),logs=[];
 const handler=createThumbnailHandler({store:{putThumbnail:async()=>{throw new Error('synthetic-private-provider-detail');}}});
 await assert.rejects(handler({bindingData:{caseId:prefix.split('/')[0],evidenceId:prefix.split('/')[1],sha},log:x=>logs.push(x)},bytes),error=>{
  assert.equal(error.message,'Thumbnail storage unavailable');
  assert.equal(error.cause,undefined);
  assert.equal(error.stack.includes('synthetic-private-provider-detail'),false);
  return true;
 });
 assert.deepEqual(logs,[]);
});

test('create-only replay logs existing output rather than claiming a new thumbnail',async()=>{
 const bytes=await sharp({create:{width:4,height:3,channels:3,background:'green'}}).png().toBuffer();
 const sha=createHash('sha256').update(bytes).digest('hex'),logs=[];
 let writes=0;
 const handler=createThumbnailHandler({store:{putThumbnail:async()=>{writes++;return {created:false};}}});
 await handler({bindingData:{caseId:prefix.split('/')[0],evidenceId:prefix.split('/')[1],sha},log:x=>logs.push(x)},bytes);
 assert.equal(writes,1);
 assert.deepEqual(logs,[{event:'thumbnail_stored',created:false}]);
});

test('Function entry fails closed without configured storage before processing input',async()=>{
 const {spawnSync}=require('node:child_process');
 const env={...process.env};
 for(const name of ['EVIDENCE_BLOB_ACCOUNT_URL','EVIDENCE_CONTAINER','THUMBNAIL_CONTAINER'])delete env[name];
 const result=spawnSync(process.execPath,['-e',`const assert=require('node:assert/strict');const main=require(${JSON.stringify(require.resolve('./index.cjs'))});main({},Buffer.alloc(0)).then(()=>{process.exitCode=1},error=>{assert.equal(error.message,'Thumbnail storage required');assert.equal(error.name,'TypeError');});`],{env,encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout,'');
});
