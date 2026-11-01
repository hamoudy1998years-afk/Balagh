'use strict';

// Read-only revalidation immediately before notification delivery.
// This reduces stale follower/preference/block/content decisions, but it
// cannot eliminate a change racing between these reads and external send.
const KINDS = Object.freeze({
  live_started: { preference: 'notif_livestreams', table: 'live_streams', columns: 'id,is_live' },
  new_video: { preference: 'notif_new_videos', table: 'videos', columns: 'id,status,is_private' },
});

async function requiredRows(promise, label) {
  const { data, error } = await promise;
  if (error || !Array.isArray(data)) {
    throw new Error(`notification eligibility ${label} failed: ${error?.message || 'invalid response'}`);
  }
  return data;
}

async function requiredOne(promise, label) {
  const { data, error } = await promise;
  if (error) {
    throw new Error(`notification eligibility ${label} failed: ${error.message}`);
  }
  return data;
}

async function freshNotificationEligibility(db, job, recipientIds) {
  const shape = KINDS[job?.kind];
  if (!shape || !job.actor_id || !job.ref_id || !Array.isArray(recipientIds) ||
      recipientIds.length > 25 || recipientIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('notification eligibility rejected invalid input');
  }
  if (recipientIds.length === 0) return new Map();
  const ids = [...new Set(recipientIds)];
  const [profiles, follows, actorBlocks, recipientBlocks, content] = await Promise.all([
    requiredRows(db.from('profiles')
      .select(`id,push_token,notif_all,${shape.preference}`).in('id', ids), 'profiles'),
    requiredRows(db.from('follows')
      .select('follower_id').eq('following_id', job.actor_id).in('follower_id', ids), 'follows'),
    requiredRows(db.from('blocked_users')
      .select('blocked_id').eq('blocker_id', job.actor_id).in('blocked_id', ids), 'actor blocks'),
    requiredRows(db.from('blocked_users')
      .select('blocker_id').eq('blocked_id', job.actor_id).in('blocker_id', ids), 'recipient blocks'),
    requiredOne(db.from(shape.table).select(shape.columns).eq('id', job.ref_id).maybeSingle(), 'content'),
  ]);
  const contentAllowed = job.kind === 'live_started'
    ? content?.is_live === true
    : content?.status === 'approved' && content?.is_private === false;
  const byId = new Map(profiles.map(row => [row.id, row]));
  const following = new Set(follows.map(row => row.follower_id));
  const actorBlocked = new Set(actorBlocks.map(row => row.blocked_id));
  const recipientBlocked = new Set(recipientBlocks.map(row => row.blocker_id));
  const result = new Map();
  for (const id of ids) {
    const p = byId.get(id);
    const inAppAllowed = Boolean(contentAllowed && p && following.has(id) &&
      !actorBlocked.has(id) && !recipientBlocked.has(id) && p[shape.preference] !== false);
    const pushAllowed = Boolean(inAppAllowed && p.notif_all !== false &&
      typeof p.push_token === 'string' && p.push_token.length > 0);
    result.set(id, { inAppAllowed, pushAllowed, pushToken: pushAllowed ? p.push_token : null });
  }
  return result;
}

module.exports = { freshNotificationEligibility };
