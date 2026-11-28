import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readActivity } from '../../web/activity.js';
const id='10000000-0000-4000-8000-000000000001';
test('activity reader accepts only safe known detail links and complete pages',()=>{
 const item={id:'booking:1',type:'booking.BOOKING_REQUESTED',createdAt:'2026-11-18T01:00:00.000Z',href:`#booking/${id}`,text:'Yêu cầu đã gửi'};
 assert.deepEqual(readActivity({items:[item],limit:20,offset:0}),{items:[item],limit:20,offset:0});
 for(const patch of [{href:'javascript:alert(1)'},{href:'#login'},{href:`#booking/${id}/extra`},{text:undefined},{createdAt:'bad'}])assert.equal(readActivity({items:[{...item,...patch}],limit:20,offset:0}),null);
 assert.equal(readActivity({items:[],limit:0,offset:0}),null);
 assert.equal(readActivity({items:[],limit:20,offset:10001}),null);
});
