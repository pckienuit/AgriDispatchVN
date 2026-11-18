'use strict';
/* global __dirname, process */
const {makeThumbnail}=require('./processor.cjs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const KEY=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}$/;
function createThumbnailHandler({store}) {
  if(typeof store?.putThumbnail!=='function')throw new TypeError('Thumbnail storage required');
  return async(context,bytes)=>{
    const {caseId,evidenceId,sha}=context.bindingData??{},key=`${caseId}/${evidenceId}/${sha}`;
    if(!KEY.test(key)){context.log({event:'thumbnail_ignored'});return;}
    let output;
    try{output=await makeThumbnail(bytes,key);}
    catch(error){
      if(['INVALID_IMAGE','INVALID_OBJECT_KEY'].includes(error.code)){context.log({event:'thumbnail_rejected',code:error.code});return;}
      // Do not attach image-decoder details to host logs.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Thumbnail processing unavailable');
    }
    try{const result=await store.putThumbnail(key,output.bytes);context.log({event:'thumbnail_stored',created:result?.created!==false});}
    catch{throw new Error('Thumbnail storage unavailable');}
  };
}
let handler;
async function main(context,bytes) {
  if(!handler){
    const {configuredBlobStore}=await import(pathToFileURL(path.join(__dirname,'../../server/src/blob-store.js')).href);
    const store=configuredBlobStore(process.env);handler=createThumbnailHandler({store});
  }
  return handler(context,bytes);
}
module.exports=main;
module.exports.createThumbnailHandler=createThumbnailHandler;
