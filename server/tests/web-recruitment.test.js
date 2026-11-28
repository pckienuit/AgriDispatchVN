import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recruitmentRoute, validateJobForm, recruitmentStatus } from '../../web/recruitment.js';

test('recruitment routes preserve UUID boundaries and personal views', () => {
  assert.deepEqual(recruitmentRoute('#jobs'), { name:'jobs' });
  assert.deepEqual(recruitmentRoute('#my-jobs'), { name:'my-jobs' });
  assert.deepEqual(recruitmentRoute('#offers'), { name:'offers' });
  assert.deepEqual(recruitmentRoute('#applications'), { name:'applications' });
  assert.equal(recruitmentRoute('#job/bad'), null);
  assert.deepEqual(recruitmentRoute('#job/10000000-0000-4000-8000-000000000001'), { name:'job',id:'10000000-0000-4000-8000-000000000001' });
});
test('job form checks capacity, strict dates and bounded text', () => {
  const data={title:'Synthetic job',locality:'Demo',capacity:'1',startLocal:'2026-12-01T08:00',endLocal:'2026-12-01T12:00'};
  assert.equal(validateJobForm(data).payload.capacity,1);
  for(const patch of [{capacity:'0'},{capacity:'1.5'},{title:''},{startLocal:'2026-02-30T08:00'},{endLocal:data.startLocal}]) assert.equal(validateJobForm({...data,...patch}).payload,null);
});
test('recruitment states distinguish applying, offering and acceptance', () => {
  assert.equal(recruitmentStatus('APPLIED'),'Đã ứng tuyển');
  assert.equal(recruitmentStatus('OFFERED'),'Đã gửi đề nghị');
  assert.equal(recruitmentStatus('ACCEPTED'),'Đã nhận đề nghị');
});
