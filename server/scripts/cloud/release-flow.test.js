import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployRelease } from './deploy.js';
import { verifyRelease } from './verify.js';
const sha = 'a'.repeat(40), uuid = '11111111-1111-1111-1111-111111111111';
const release = { sha, budgetGate: 'approved-1', images: { app: 'syntheticacr.azurecr.io/agridispatch-vn@sha256:'+'a'.repeat(64), function:'syntheticacr.azurecr.io/agridispatch-thumbnail@sha256:'+'b'.repeat(64) }, target: { subscription:uuid,resourceGroup:'rg-agridispatch-bt05',clusterResourceId:`/subscriptions/${uuid}/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.ContainerService/managedClusters/aks-synthetic`,context:'aks-synthetic',kubeconfig:'/scratch/kubeconfig',clientId:uuid,migrationClientId:'22222222-2222-2222-2222-222222222222',tenantId:uuid,keyVaultName:'kv-synthetic',app:'app-synthetic',stagingProbeUrl:'https://app-synthetic-staging.azurewebsites.net',productionProbeUrl:'https://app-synthetic.azurewebsites.net',functionApp:'func-synthetic' } };
test('combined release is dry-run unless explicitly executed',async()=>{
 let calls=0;
 const r=await deployRelease(release,{run:async()=>{calls++;throw Error('must not run');}});
 assert.equal(r.mode,'dry-run');assert.equal(calls,0);
});
test('combined release orders migration/account, Function and booking and stops on account failure',async()=>{
 const calls=[];
 const io={run:async argv=>{calls.push(argv[1]);return {code:0,stdout:''};},deployAccount:async()=>{calls.push('account');},deployWeb:async()=>{calls.push('web');}};
 assert.equal((await deployRelease({...release,execute:true},io)).mode,'executed');
 assert.deepEqual(calls,['account','functionapp','functionapp','web']);
 await assert.rejects(deployRelease({...release,execute:true},{...io,deployAccount:async()=>{throw Error('migration failed');}}),/migration failed/);
});
test('revision verification checks actual digest, observed generation and available replica count',async()=>{
 const deployment={metadata:{generation:2},spec:{replicas:2,template:{spec:{containers:[{name:'account',image:release.images.app,env:[{name:'BUILD_SHA',value:sha}]}]}}},status:{observedGeneration:2,updatedReplicas:2,availableReplicas:2}};
 const run=async argv=>({code:0,stdout:argv[0]==='kubectl'?JSON.stringify(deployment):`DOCKER|${argv[1]==='webapp'?release.images.app:release.images.function}`});
 const probe=async()=>({ok:true});
 const r=await verifyRelease(release,{run,probe});assert.equal(r.acceptanceComplete,false);assert.equal(r.status,'REVISION_CHECKS_PASSED');
 deployment.status.availableReplicas=1;
 await assert.rejects(verifyRelease(release,{run,probe}),/revision mismatch/);
 await assert.rejects(verifyRelease(release,{run,probe:async()=>({ok:false})}),/readiness/);
});
