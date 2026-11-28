import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlan } from './deploy-aks.js';
const id='11111111-1111-1111-1111-111111111111';
const args={subscription:id,clusterResourceId:`/subscriptions/${id}/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.ContainerService/managedClusters/aks-test`,context:'aks-test',image:'syntheticacr.azurecr.io/app@sha256:'+'a'.repeat(64),buildSha:'a'.repeat(40),clientId:id,migrationClientId:'22222222-2222-2222-2222-222222222222',tenantId:id,keyVaultName:'kv-synthetic'};
test('cloud deploy refuses relative, default or in-repo kubeconfig paths',()=>{
 for(const kubeconfig of ['relative-config','/home/fixture/.kube/config',process.cwd()+'/kubeconfig-prod']) assert.throws(()=>buildPlan(args,{kubeconfig}),/kubeconfig/);
});
