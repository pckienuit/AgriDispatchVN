import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRelease } from './preflight.js';
const sha = 'a'.repeat(40), sub = '11111111-1111-1111-1111-111111111111';
const now = Date.now();
const result = { status: 'SUCCESS', sha, publish: true, images: [{ name: 'app', repository: 'agridispatch-vn', tag: sha, digest: 'sha256:'+'b'.repeat(64), ref: 'syntheticacr.azurecr.io/agridispatch-vn@sha256:'+'b'.repeat(64) }, { name: 'function', repository: 'agridispatch-thumbnail', tag: sha, digest: 'sha256:'+'c'.repeat(64), ref: 'syntheticacr.azurecr.io/agridispatch-thumbnail@sha256:'+'c'.repeat(64) }] };
const target = { subscription: sub, resourceGroup: 'rg-agridispatch-bt05', app: 'app-booking-synthetic', stagingProbeUrl: 'https://app-booking-synthetic-staging.azurewebsites.net', productionProbeUrl: 'https://app-booking-synthetic.azurewebsites.net', clusterResourceId: `/subscriptions/${sub}/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.ContainerService/managedClusters/aks-synthetic`, context: 'aks-synthetic', kubeconfig: '/outside/repo/kubeconfig', clientId: sub, migrationClientId: '22222222-2222-2222-2222-222222222222', tenantId: sub, keyVaultName: 'kv-synthetic', functionApp: 'func-synthetic', functionProbeUrl: 'https://func-synthetic.azurewebsites.net', approval: { id: 'approval-test', checkedAt: new Date(now).toISOString(), capUsd: 43.03, estimatedTotalUsd: 35, remainingCreditUsd: 86.06, quotaVerified: true, costComplete: true, spendingLimitOn: true } };
export { result, target, now, sha };

test('release gate requires exact SHA, two unique immutable images and current bounded approval', () => {
  assert.equal(validateRelease(result, target, { sha, budgetApproval: 'approval-test', quotaCheckedAt: target.approval.checkedAt, now }).images.app, result.images[0].ref);
  for (const bad of [{ ...result, sha: 'main' }, { ...result, publish: false }, { ...result, images: [result.images[0], result.images[0]] }]) assert.throws(() => validateRelease(bad,target,{sha,budgetApproval:'approval-test',quotaCheckedAt:target.approval.checkedAt,now}));
  for (const approval of [{...target.approval,estimatedTotalUsd:44},{...target.approval,costComplete:false},{...target.approval,quotaVerified:false},{...target.approval,checkedAt:'2020-01-01T00:00:00Z'},{...target.approval,spendingLimitOn:false}]) assert.throws(() => validateRelease(result,{...target,approval},{sha,budgetApproval:'approval-test',quotaCheckedAt:approval.checkedAt,now}));
});

test('release gate rejects other resource groups, mismatched probe hosts and hidden credential configuration', () => {
  for (const patch of [{ resourceGroup:'rg-is402' }, { productionProbeUrl:'https://attacker.example' }, { stagingProbeUrl:target.productionProbeUrl }, { databaseUrl:'synthetic-secret' }, { kubeconfig:'/home/pckien/.kube/config' }]) assert.throws(() => validateRelease(result,{...target,...patch},{sha,budgetApproval:'approval-test',quotaCheckedAt:target.approval.checkedAt,now}));
});
