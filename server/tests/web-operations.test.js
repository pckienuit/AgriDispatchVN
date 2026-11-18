import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationsRoute, shiftActions, completeInput } from '../../web/operations.js';

test('operations routes accept only complete supported paths', () => {
  assert.deepEqual(operationsRoute('#shifts'), {name:'shifts'});
  assert.deepEqual(operationsRoute('#shift/10000000-0000-4000-8000-000000000001'), {name:'shift',id:'10000000-0000-4000-8000-000000000001'});
  for(const hash of ['#shift/bad','#shift/10000000-0000-4000-8000-000000000001/extra','#shifts/extra'])assert.equal(operationsRoute(hash),null);
});
test('shift controls reflect assigned operator and exact lifecycle', () => {
  assert.deepEqual(shiftActions('RUNNING',true),['pause','complete']);
  assert.deepEqual(shiftActions('PAUSED',true),['resume']);
  for(const state of ['COMPLETED','RUNNING','PAUSED'])assert.deepEqual(shiftActions(state,false),[]);
  assert.deepEqual(shiftActions('COMPLETED',true),[]);
});
test('completion validates exact integer square metres and bounded optional note', () => {
  assert.deepEqual(completeInput('12000',''),{areaM2:12000});
  assert.deepEqual(completeInput('1',' Demo '),{areaM2:1,note:'Demo'});
  for(const area of ['0','-1','1.5','1e3','2147483648',''])assert.equal(completeInput(area,''),null);
  assert.equal(completeInput('1','x'.repeat(501)),null);
});
