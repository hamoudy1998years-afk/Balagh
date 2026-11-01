'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshNotificationEligibility } = require('../notificationEligibility');
const job = { kind: 'live_started', actor_id: 'creator', ref_id: 'stream' };
const base = () => ({
  profiles: [{ id: 'a', push_token: 'ExpoPushToken[a]', notif_all: true, notif_livestreams: true, notif_new_videos: true }],
  follows: [{ follower_id: 'a', following_id: 'creator' }],
  blocked_users: [],
  live_streams: [{ id: 'stream', is_live: true }],
  videos: [{ id: 'video', status: 'approved', is_private: false }],
});
class FakeQuery {
  constructor(name, rows, errors) { this.name=name; this.rows=rows; this.errors=errors; this.filters=[]; }
  select() { return this; }
  eq(k,v) { this.filters.push(row=>row[k]===v); return this; }
  in(k,vs) { this.filters.push(row=>vs.includes(row[k])); return this; }
  async maybeSingle() { const r=await this; return { ...r, data:r.data?.[0]??null }; }
  then(resolve,reject) {
    const error=this.errors[this.name] ? {message:'injected error'} : null;
    const data=this.rows.filter(row=>this.filters.every(f=>f(row)));
    return Promise.resolve({data,error}).then(resolve,reject);
  }
}
function db(rows,errors={}) { return { from: name => new FakeQuery(name,rows[name],errors) }; }
async function check(rows,caseJob=job){return freshNotificationEligibility(db(rows),caseJob,['a']);}
test('eligible live follower receives in-app and push',async()=>{
  const e=(await check(base())).get('a');assert.equal(e.inAppAllowed,true);assert.equal(e.pushAllowed,true);
  assert.equal(e.pushToken,'ExpoPushToken[a]');
});
test('removed follow blocks both channels',async()=>{ const r=base();r.follows=[];assert.equal((await check(r)).get('a').pushAllowed,false); });
test('recipient blocks creator',async()=>{ const r=base();r.blocked_users=[{blocker_id:'a',blocked_id:'creator'}];assert.equal((await check(r)).get('a').inAppAllowed,false); });
test('creator blocks recipient',async()=>{ const r=base();r.blocked_users=[{blocker_id:'creator',blocked_id:'a'}];assert.equal((await check(r)).get('a').pushAllowed,false); });
test('type preference off suppresses both',async()=>{ const r=base();r.profiles[0].notif_livestreams=false;assert.equal((await check(r)).get('a').inAppAllowed,false); });
test('global notification preference off suppresses push only',async()=>{ const r=base();r.profiles[0].notif_all=false;const e=(await check(r)).get('a');assert.equal(e.inAppAllowed,true);assert.equal(e.pushAllowed,false); });
test('ended livestream suppresses both',async()=>{ const r=base();r.live_streams[0].is_live=false;assert.equal((await check(r)).get('a').inAppAllowed,false); });
test('private video suppresses both',async()=>{ const r=base();r.videos[0].is_private=true;assert.equal((await check(r,{kind:'new_video',actor_id:'creator',ref_id:'video'})).get('a').pushAllowed,false); });
test('unapproved video suppresses both',async()=>{ const r=base();r.videos[0].status='pending';assert.equal((await check(r,{kind:'new_video',actor_id:'creator',ref_id:'video'})).get('a').inAppAllowed,false); });
test('missing profile suppresses both',async()=>{ const r=base();r.profiles=[];assert.equal((await check(r)).get('a').inAppAllowed,false); });
test('reads latest token instead of stale wave token',async()=>{const r=base();r.profiles[0].push_token='ExpoPushToken[updated]';assert.equal((await check(r)).get('a').pushToken,'ExpoPushToken[updated]');});
test('read errors fail closed',async()=>{ const r=base();await assert.rejects(freshNotificationEligibility(db(r,{follows:true}),job,['a']),/follows failed/); });
test('unknown kind fails closed',async()=>{await assert.rejects(check(base(),{kind:'arbitrary',actor_id:'creator',ref_id:'x'}),/invalid input/);});
test('recipient count is bounded',async()=>{await assert.rejects(freshNotificationEligibility(db(base()),job,Array(26).fill('a')),/invalid input/);});
test('no IDs does not query database',async()=>{const result=await freshNotificationEligibility({from(){throw Error('database access');}},job,[]);assert.equal(result.size,0);});
