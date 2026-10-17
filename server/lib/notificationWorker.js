// Sweeper: delivers follower notifications ('live_started', 'new_video').
//
// Queue model (see migrations 20261025/20261026):
//   notification_jobs        — one row per (kind, actor, ref) event.
//   notification_recipients  — one row per (job, recipient, channel);
//                              the primary idempotency guard and the only
//                              retry-clock source.
//   push_quota               — max 2 pushes per (follower, creator, day)
//                              for new_video pushes; live pushes exempt.
//
// Race-safe claim protocol mirrors rejectedVideoCleanup.js: a job is
// claimed with UPDATE ... WHERE id + status='pending' (PostgREST returns
// the updated rows; zero rows means another worker won). Claiming does
// NOT increment attempts — attempts counts only unexpected processing
// errors (see releaseJob's bumpAttempts), so a job waiting on recipient
// backoffs never ages into 'dead'. Lease recovery only touches
// status='claimed' rows older than the lease; jobs with attempts >=
// MAX_JOB_ATTEMPTS are declared 'dead'. Single-worker deployment: JS-side
// claiming is sufficient.
//
// Per-recipient state machine (both channels):
//   - Rows are created ONCE per (job, recipient, channel) with
//     INSERT ... ON CONFLICT DO NOTHING, in an initial status derived from
//     the recipient decision ('skipped' = terminal no-op, 'pending' = to
//     deliver). Terminal rows ('sent'/'skipped') are NEVER overwritten:
//     every transition is a conditional UPDATE filtered on the prior
//     status with the expected attempts value, verified by row count.
//   - Before any delivery attempt the ledger row is re-read. 'sent' or
//     'skipped' → no-op. 'failed' with run_after in the future → skip this
//     tick. 'failed' with attempts >= RECIPIENT_MAX_ATTEMPTS → terminal.
//   - A channel is claimed (claimed_at, with a claim lease) before work;
//     failures persist attempts+1 and a run_after backoff — retries are
//     driven purely by the sweeper tick reading run_after. There are NO
//     inline sleeps anywhere in the delivery path.
//   - Quota for new_video pushes is claimed per EVENT via claim_push_quota
//     immediately before dispatch: one reservation row per
//     (follower, creator, day, job), capped at 2 distinct events per day.
//     A retry of the same job re-uses its existing reservation (no extra
//     slot). A dispatch that never reaches Expo KEEPS its reservation —
//     quota counts events attempted, not deliveries — so the channel goes
//     to failed+backoff and retries freely within the same reservation.
//     If the RPC errors, the push is NOT sent and the channel becomes
//     retryable (quota is re-claimed at retry time via the reservation).
//     A 'sent' row is terminal, so a successful send never double-claims.
//
// Job completion gate: a job is marked 'done' only when no recipient rows
// remain in a retryable state (pending, failed with attempts < cap — due
// or not —, or stale-claimed). Otherwise the job is released with a short
// delay and re-processed on a later tick. Rows stuck 'failed' at the
// attempt cap are terminal; if any exist the job still completes but the
// situation is logged loudly.
//
// Content revalidation: before any delivery a job re-reads its video
// (status must be 'approved' and is_private false) or live stream (must
// still be is_live). Reverted/unpublished content completes the job with
// zero deliveries.
//
// Delivery semantics: in-app inserts are exactly-once (ledger row plus a
// notifications-table pre-check; 23505 unique violations count as
// delivered). Push is at-least-once: a crash between dispatch and the
// 'sent' transition can re-send once on a later tick (quota caps volume).
//
// Scheduling shape copied from rejectedVideoCleanup.js: globalThis
// double-start guard, delayed first run, unref'd timers, in-progress guard.
// Importing this module starts it.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TAG = '[NOTIFY]';

const SWEEP_INTERVAL_MS = 20 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;
const BATCH_SIZE = 1;
const LEASE_MS = 5 * 60 * 1000;
const MAX_JOB_ATTEMPTS = 8;
const JOB_RETRY_MS = 2 * 60 * 1000;
const JOB_GATE_RETRY_MS = 60 * 1000;
const FOLLOWER_PAGE_SIZE = 25;
const MAX_FOLLOWERS = 20000;
const PUSH_CHUNK_SIZE = 25;
const RECIPIENT_MAX_ATTEMPTS = 5;
const RECIPIENT_LEASE_MS = 5 * 60 * 1000;
const RECIPIENT_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const PUSH_URL = 'https://exp.host/--/api/v2/push/send';

let sweepInProgress = false;

function backoffFor(nextAttempts) {
  if (nextAttempts >= RECIPIENT_MAX_ATTEMPTS) {
    return null;
  }

  return RECIPIENT_BACKOFF_MS[
    Math.min(nextAttempts - 1, RECIPIENT_BACKOFF_MS.length - 1)
  ];
}

// ─────────────────────────────────────────────────────────────
// JOB CLAIM PASS
// ─────────────────────────────────────────────────────────────

async function claimJobs() {
  const now = new Date().toISOString();

  // Lease recovery: ONLY status='claimed' rows are reset — done/dead jobs
  // can never be resurrected here. attempts was already incremented at
  // claim time; jobs that never complete age into 'dead' via
  // MAX_JOB_ATTEMPTS.
  const leaseCutoff = new Date(Date.now() - LEASE_MS).toISOString();

  const { error: leaseError } = await supabase
    .from('notification_jobs')
    .update({
      status: 'pending',
      claimed_at: null,
      lease_heartbeat_at: null,
    })
    .eq('status', 'claimed')
    .lt('lease_heartbeat_at', leaseCutoff);

  if (leaseError) {
    console.error(TAG, 'Lease recovery failed:', leaseError.message);
  }

  // Kill exhausted jobs.
  const { data: deadJobs, error: deadError } = await supabase
    .from('notification_jobs')
    .update({ status: 'dead' })
    .eq('status', 'pending')
    .gte('attempts', MAX_JOB_ATTEMPTS)
    .select('id');

  if (deadError) {
    console.error(TAG, 'Dead-job marking failed:', deadError.message);
  } else if (deadJobs?.length) {
    console.error(
      TAG,
      'Jobs marked dead (attempts exhausted):',
      deadJobs.map(j => j.id).join(', ')
    );
  }

  const { data: candidates, error } = await supabase
    .from('notification_jobs')
    .select('id, kind, actor_id, ref_id, payload, attempts')
    .eq('status', 'pending')
    .lte('run_after', now)
    .order('id', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error(TAG, 'Job selection failed:', error.message);
    return [];
  }

  const claimed = [];

  for (const job of candidates ?? []) {
    const claimedAt = new Date().toISOString();

    const { data: rows, error: claimError } = await supabase
      .from('notification_jobs')
      .update({
        status: 'claimed',
        claimed_at: claimedAt,
        lease_heartbeat_at: claimedAt,
      })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select('id');

    if (claimError) {
      console.error(TAG, 'Claim failed for job', job.id, claimError.message);
      continue;
    }

    if (rows && rows.length > 0) {
      claimed.push({ ...job, claimed_at: claimedAt });
    }
  }

  return claimed;
}

async function renewJobHeartbeat(job) {
  const { data, error } = await supabase
    .from('notification_jobs')
    .update({ lease_heartbeat_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'claimed')
    .eq('claimed_at', job.claimed_at)
    .select('id');

  if (error) {
    throw new Error(`Heartbeat failed for job ${job.id}: ${error.message}`);
  }

  if (!data || data.length !== 1) {
    throw new Error(`Job ${job.id} lost claim ownership`);
  }
}
async function releaseJob(job, delayMs, bumpAttempts = false) {
  const patch = {
    status: 'pending',
    claimed_at: null,
    run_after: new Date(Date.now() + delayMs).toISOString(),
  };

  if (bumpAttempts) {
    patch.attempts = job.attempts + 1;
  }

  const { error } = await supabase
    .from('notification_jobs')
    .update(patch)
    .eq('id', job.id)
    .eq('status', 'claimed')
    .eq('attempts', job.attempts)
    .eq('claimed_at', job.claimed_at);

  if (error) {
    console.error(TAG, 'Job release failed for', job.id, error.message);
  }
}

async function markJobDone(job) {
  const { error } = await supabase
    .from('notification_jobs')
    .update({ status: 'done' })
    .eq('id', job.id)
    .eq('status', 'claimed')
    .eq('claimed_at', job.claimed_at);

  if (error) {
    console.error(TAG, 'Job completion failed for', job.id, error.message);
  }
}

// ─────────────────────────────────────────────────────────────
// RECIPIENT LEDGER — CONDITIONAL STATE TRANSITIONS ONLY
// Terminal 'sent'/'skipped' rows are never overwritten: every write is an
// UPDATE filtered on prior status (and expected attempts), verified by
// returned row count. First creation is INSERT ... ON CONFLICT DO NOTHING.
// ─────────────────────────────────────────────────────────────

function ledgerKey(recipientId, channel) {
  return `${recipientId}:${channel}`;
}

async function fetchLedgerRows(jobId, recipientIds) {
  if (recipientIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from('notification_recipients')
    .select('recipient_id, channel, status, attempts, run_after, claimed_at')
    .eq('job_id', jobId)
    .in('recipient_id', recipientIds);

  if (error) {
    throw new Error(`ledger read failed (job ${jobId}): ${error.message}`);
  }

  const map = new Map();

  for (const row of data ?? []) {
    map.set(ledgerKey(row.recipient_id, row.channel), row);
  }

  return map;
}

async function ensureLedgerRow(jobId, recipientId, channel, status) {
  const { error } = await supabase
    .from('notification_recipients')
    .upsert(
      { job_id: jobId, recipient_id: recipientId, channel, status },
      {
        onConflict: 'job_id,recipient_id,channel',
        ignoreDuplicates: true, // ON CONFLICT DO NOTHING — never overwrite
      }
    );

  if (error) {
    throw new Error(
      `ledger create failed (job ${jobId}, recipient ${recipientId}, ` +
        `${channel}): ${error.message}`
    );
  }
}

// Claim a channel for delivery. Returns the known attempts value on
// success, or null when the row is not claimable right now (terminal,
// backoff not due, attempt cap reached, or another claim is fresh).
// Two conditional UPDATE shapes cover the retryable states:
//   pending (run_after is always NULL for pending rows)
//   failed  (run_after must be due, attempts must be below the cap)
async function claimChannel(jobId, recipientId, channel, row) {
  if (row.status === 'sent' || row.status === 'skipped') {
    return null;
  }

  if (row.attempts >= RECIPIENT_MAX_ATTEMPTS) {
    return null;
  }

  const now = new Date().toISOString();
  const staleBefore = new Date(
    Date.now() - RECIPIENT_LEASE_MS
  ).toISOString();

  if (
    row.claimed_at &&
    Date.parse(row.claimed_at) >= Date.parse(staleBefore)
  ) {
    return null;
  }

  if (row.status === 'failed') {
    if (!row.run_after || row.run_after > now) {
      return null;
    }
  } else if (row.status !== 'pending') {
    return null;
  }

  let query = supabase
    .from('notification_recipients')
    .update({ claimed_at: now })
    .eq('job_id', jobId)
    .eq('recipient_id', recipientId)
    .eq('channel', channel)
    .eq('attempts', row.attempts)
    .lt('attempts', RECIPIENT_MAX_ATTEMPTS)
    .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
    .select('recipient_id');

  if (row.status === 'pending') {
    query = query
      .eq('status', 'pending')
      .is('run_after', null);
  } else {
    query = query
      .eq('status', 'failed')
      .lte('run_after', now);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(
      `ledger claim failed (job ${jobId}, recipient ${recipientId}, ` +
      `${channel}): ${error.message}`
    );
  }

  if (!data || data.length === 0) {
    return null;
  }

  return { attempts: row.attempts, claimedAt: now };
}
async function transitionChannel(
  jobId,
  recipientId,
  channel,
  patch,
  priorStatuses,
  claim
) {
  const { data, error } = await supabase
    .from('notification_recipients')
    .update(patch)
    .eq('job_id', jobId)
    .eq('recipient_id', recipientId)
    .eq('channel', channel)
    .eq('attempts', claim.attempts)
    .eq('claimed_at', claim.claimedAt)
    .in('status', priorStatuses)
    .select('recipient_id');

  if (error) {
    throw new Error(
      `ledger transition failed (job ${jobId}, recipient ${recipientId}, ` +
      `${channel}): ${error.message}`
    );
  }

  return !!data && data.length > 0;
}

async function markChannelSent(jobId, recipientId, channel, claim) {
  return transitionChannel(
    jobId,
    recipientId,
    channel,
    {
      status: 'sent',
      sent_at: new Date().toISOString(),
      claimed_at: null,
      run_after: null,
    },
    ['pending', 'failed'],
    claim
  );
}

async function markChannelSkipped(jobId, recipientId, channel, claim) {
  return transitionChannel(
    jobId,
    recipientId,
    channel,
    {
      status: 'skipped',
      claimed_at: null,
      run_after: null,
    },
    ['pending', 'failed'],
    claim
  );
}

async function markChannelFailed(
  jobId,
  recipientId,
  channel,
  claim,
  reason,
  terminal = false
) {
  const nextAttempts = terminal
    ? RECIPIENT_MAX_ATTEMPTS
    : claim.attempts + 1;

  const backoff = backoffFor(nextAttempts);
  const exhausted = backoff === null;

  const patch = {
    status: 'failed',
    attempts: nextAttempts,
    claimed_at: null,
    run_after: exhausted
      ? null
      : new Date(Date.now() + backoff).toISOString(),
  };

  const applied = await transitionChannel(
    jobId,
    recipientId,
    channel,
    patch,
    ['pending', 'failed'],
    claim
  );

  if (!applied) {
    return;
  }

  if (exhausted) {
    console.error(
      TAG,
      `Channel FAILED permanently (job ${jobId}, recipient ${recipientId}, ` +
        `${channel}): ${reason}`
    );
  } else {
    console.warn(
      TAG,
      `Channel failed (job ${jobId}, recipient ${recipientId}, ${channel}, ` +
        `attempt ${nextAttempts}/${RECIPIENT_MAX_ATTEMPTS}) — retry at ` +
        `${patch.run_after}: ${reason}`
    );
  }
}
// ─────────────────────────────────────────────────────────────
// IN-APP DELIVERY
// ─────────────────────────────────────────────────────────────

// Belt-and-braces duplicate check on the notifications table itself, so
// retries that somehow bypass the ledger never double-insert. A query
// error THROWS (the caller marks the channel retryable / releases the job)
// — it is never silently swallowed.
async function inAppNotificationExists(job, recipientId) {
  let query = supabase
    .from('notifications')
    .select('id')
    .eq('user_id', recipientId)
    .eq('actor_id', job.actor_id)
    .eq('type', job.kind)
    .limit(1);

  query =
    job.kind === 'live_started'
      ? query.eq('live_stream_id', job.ref_id)
      : query.eq('video_id', job.ref_id);

  const { data, error } = await query;

  if (error) {
    throw new Error(
      `in-app duplicate check failed (recipient ${recipientId}): ` +
        error.message
    );
  }

  return !!data && data.length > 0;
}

// Caller must have claimed the in_app channel already (claimChannel) —
// knownAttempts is the attempts value that claim returned.
async function deliverInApp(job, recipientId, claim) {
  try {
    if (await inAppNotificationExists(job, recipientId)) {
      await markChannelSent(job.id, recipientId, 'in_app', claim);
      return;
    }

    const row = {
      user_id: recipientId,
      actor_id: job.actor_id,
      type: job.kind,
    };

    if (job.kind === 'live_started') {
      row.live_stream_id = job.ref_id;
    } else {
      row.video_id = job.ref_id;
    }

    const { error } = await supabase.from('notifications').insert(row);

    if (error) {
      // Unique violation = a concurrent inserter won; treat as delivered.
      if (error.code === '23505') {
        await markChannelSent(job.id, recipientId, 'in_app', claim);
        return;
      }

      throw new Error(`in-app insert failed: ${error.message}`);
    }

    await markChannelSent(job.id, recipientId, 'in_app', claim);
  } catch (error) {
    // Per-recipient failure must not kill the wave — persist retryable
    // state and continue with the other recipients.
    console.error(
      TAG,
      `In-app delivery error (job ${job.id}, recipient ${recipientId}):`,
      error?.message || error
    );

    try {
      await markChannelFailed(
        job.id,
        recipientId,
        'in_app',
        claim,
        error?.message || String(error)
      );
    } catch (ledgerError) {
      console.error(TAG, 'Failed to persist in-app failure state:', ledgerError.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// PUSH DELIVERY
// ─────────────────────────────────────────────────────────────

async function postPushChunk(messages) {
  const response = await fetch(PUSH_URL, {
    signal: AbortSignal.timeout(30 * 1000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });

  if (!response.ok) {
    throw new Error(`Expo push HTTP ${response.status}`);
  }

  let body;

  try {
    body = await response.json();
  } catch (_) {
    throw new Error('Expo push returned invalid JSON');
  }

  if (
    !body ||
    !Array.isArray(body.data) ||
    body.data.length !== messages.length
  ) {
    throw new Error('Expo push returned an invalid or incomplete ticket batch');
  }

  for (const ticket of body.data) {
    if (
      !ticket ||
      typeof ticket !== 'object' ||
      (ticket.status !== 'ok' && ticket.status !== 'error')
    ) {
      throw new Error('Expo push returned an unrecognized ticket');
    }

    if (ticket.status === 'ok' && typeof ticket.id !== 'string') {
      throw new Error('Expo push returned a success ticket without an ID');
    }
  }

  return body.data;
}

// A failed HTTP request or invalid response remains retryable.
// Event-based quota reservations are retained across retries.
async function dispatchPushTickets(tickets) {
  if (tickets.length === 0) {
    return;
  }

  const messages = tickets.map(t => ({
    to: t.token,
    title: t.pushTitle,
    body: t.pushBody,
    data: t.pushData,
    sound: 'default',
    priority: 'high',
  }));

  let results;

  try {
    results = await postPushChunk(messages);
  } catch (error) {
    console.error(
      TAG,
      `Push dispatch failed (job ${tickets[0].job.id}, ${tickets.length} tickets):`,
      error?.message || error
    );

    for (const t of tickets) {


      try {
        await markChannelFailed(
          t.job.id,
          t.recipientId,
          'push',
          t.claim,
          'dispatch error: ' + (error?.message || error)
        );
      } catch (ledgerError) {
        console.error(TAG, 'Failed to persist push failure state:', ledgerError.message);
      }
    }

    return;
  }

  for (let i = 0; i < tickets.length; i += 1) {
    const t = tickets[i];
    const details = results[i];

    if (details && typeof details === 'object' && details.status === 'ok') {
      try {
        await markChannelSent(t.job.id, t.recipientId, 'push', t.claim);
      } catch (ledgerError) {
        // Delivery happened but the ledger write did not: the row stays
        // claimed, ages out of its lease, and may re-send once (at-least-
        // once push semantics; quota caps volume).
        console.error(
          TAG,
          'markChannelSent failed AFTER dispatch (job',
          t.job.id,
          'recipient',
          t.recipientId + '):',
          ledgerError.message
        );
      }

      continue;
    }

    if (details?.details?.error === 'DeviceNotRegistered') {
      // Token is dead — clear it wherever it appears so we stop pushing,
      // then mark the channel failed-terminal (no retry can succeed).
      const { error: clearError } = await supabase
        .from('profiles')
        .update({ push_token: null })
        .eq('push_token', t.token);

      if (clearError) {
        console.error(
          TAG,
          'Failed to clear dead push token:',
          clearError.message
        );
      }

      try {
        await markChannelFailed(
          t.job.id,
          t.recipientId,
          'push',
          t.claim,
          'DeviceNotRegistered',
          true
        );
      } catch (ledgerError) {
        console.error(TAG, 'Failed to persist token-death state:', ledgerError.message);
      }

      continue;
    }

    const reason =
      (details?.details?.error || details?.message || 'unknown');

    try {
      await markChannelFailed(
        t.job.id,
        t.recipientId,
        'push',
        t.claim,
        reason
      );
    } catch (ledgerError) {
      console.error(TAG, 'Failed to persist push failure state:', ledgerError.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// CONTENT REVALIDATION (fix: delayed/retried jobs must not notify for
// content that was reverted, unpublished, or ended)
// ─────────────────────────────────────────────────────────────

// Returns TRUE when the job may deliver, FALSE when it was completed as a
// no-op. Throws on query errors so the job is released retryably.
async function revalidateJobContent(job, finalizeClaim) {
  if (job.kind === 'new_video') {
    const { data, error } = await supabase
      .from('videos')
      .select('status, is_private')
      .eq('id', job.ref_id)
      .maybeSingle();

    if (error) {
      throw new Error(`video revalidation query failed: ${error.message}`);
    }

    if (
      !data ||
      data.status !== 'approved' ||
      data.is_private !== false
    ) {
      console.warn(
        TAG,
        `Job ${job.id}: video ${job.ref_id} is not publicly published ` +
          `(status=${data?.status ?? 'missing'}, is_private=` +
          `${data?.is_private ?? '?'}) — completing with zero deliveries.`
      );

      await finalizeClaim();
      await markJobDone(job);
      return false;
    }

    return true;
  }

  // live_started
  const { data, error } = await supabase
    .from('live_streams')
    .select('id, is_live')
    .eq('id', job.ref_id)
    .maybeSingle();

  if (error) {
    throw new Error(`live stream revalidation query failed: ${error.message}`);
  }

  if (!data || data.is_live !== true) {
    console.warn(
      TAG,
      `Job ${job.id}: live stream ${job.ref_id} is missing or no longer ` +
        'live — completing with zero deliveries.'
    );

    await finalizeClaim();
    await markJobDone(job);
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// JOB COMPLETION GATE
// A job may only be 'done' when no recipient rows remain retryable:
// pending, failed with attempts < cap (due or not), or stale-claimed.
// ─────────────────────────────────────────────────────────────

async function countRows(query) {
  const { count, error } = await query;

  if (error) {
    throw new Error(`completion gate count failed: ${error.message}`);
  }

  return count ?? 0;
}

async function completeJobIfReady(job, finalizeClaim) {
  const staleBefore = new Date(Date.now() - RECIPIENT_LEASE_MS).toISOString();

  const retryable =
    (await countRows(
      supabase
        .from('notification_recipients')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', job.id)
        .eq('status', 'pending')
    )) +
    (await countRows(
      supabase
        .from('notification_recipients')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', job.id)
        .eq('status', 'failed')
        .lt('attempts', RECIPIENT_MAX_ATTEMPTS)
    ));

  if (retryable > 0) {
    console.log(
      TAG,
      `Job ${job.id}: ${retryable} recipient channel(s) still retryable — ` +
        'releasing for a later tick.'
    );

    await finalizeClaim();
    await releaseJob(job, JOB_GATE_RETRY_MS);
    return;
  }

  const exhaustedFailed = await countRows(
    supabase
      .from('notification_recipients')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', job.id)
      .eq('status', 'failed')
  );

  if (exhaustedFailed > 0) {
    console.error(
      TAG,
      `Job ${job.id}: completing with ${exhaustedFailed} permanently ` +
        'failed recipient channel(s) — investigate.'
    );
  }

  await finalizeClaim();
  await markJobDone(job);
}

// ─────────────────────────────────────────────────────────────
// JOB PROCESSING
// ─────────────────────────────────────────────────────────────

async function processJob(job, assertLease, finalizeClaim) {
  // 0. Revalidate the referenced content before ANY delivery.
  if (!(await revalidateJobContent(job, finalizeClaim))) {
    return;
  }

  // 1. Actor profile. A missing profile is permanent (dead); a query error
  //    throws into the per-job catch (release + retry).
  const { data: actor, error: actorError } = await supabase
    .from('profiles')
    .select('id, username, avatar_url')
    .eq('id', job.actor_id)
    .maybeSingle();

  if (actorError) {
    throw new Error(`actor profile query failed: ${actorError.message}`);
  }

  if (!actor) {
    console.error(
      TAG,
      'Actor profile missing for job',
      job.id,
      '— marking dead.'
    );

    await finalizeClaim();
    await supabase
      .from('notification_jobs')
      .update({ status: 'dead' })
      .eq('id', job.id)
      .eq('status', 'claimed')
      .eq('claimed_at', job.claimed_at);

    return;
  }

  const actorName = actor.username || 'Someone';

  // 2. Blocked set (both directions), loaded once per job. Query errors
  //    throw — the job is released retryably.
  const blocked = new Set();

  const { data: blockedByActor, error: blockedByActorError } = await supabase
    .from('blocked_users')
    .select('blocked_id')
    .eq('blocker_id', job.actor_id);

  if (blockedByActorError) {
    throw new Error(
      `blocked_users query failed: ${blockedByActorError.message}`
    );
  }

  for (const row of blockedByActor ?? []) {
    blocked.add(row.blocked_id);
  }

  const { data: blockingActor, error: blockingActorError } = await supabase
    .from('blocked_users')
    .select('blocker_id')
    .eq('blocked_id', job.actor_id);

  if (blockingActorError) {
    throw new Error(
      `blocked_users query failed: ${blockingActorError.message}`
    );
  }

  for (const row of blockingActor ?? []) {
    blocked.add(row.blocker_id);
  }

  // 3. Wave: page through followers, upsert ledger rows for BOTH channels
  //    per recipient decision, then deliver everything claimable.
  const pushTitle =
    job.kind === 'live_started'
      ? `${actorName} is live`
      : `${actorName} posted a new video`;

  const pushBody =
    job.kind === 'live_started'
      ? job.payload?.title ?? 'Started a livestream'
      : job.payload?.caption ?? '';

  const pushData =
    job.kind === 'live_started'
      ? { type: 'live', streamId: job.ref_id }
      : { type: 'video', videoId: job.ref_id };

  const typePrefColumn =
    job.kind === 'live_started' ? 'notif_livestreams' : 'notif_new_videos';

  let page = 0;

  while (page * FOLLOWER_PAGE_SIZE < MAX_FOLLOWERS) {
    await assertLease();
    const from = page * FOLLOWER_PAGE_SIZE;
    const to = from + FOLLOWER_PAGE_SIZE - 1;

    const { data: followers, error: followersError } = await supabase
      .from('follows')
      .select('follower_id')
      .eq('following_id', job.actor_id)
      .order('follower_id', { ascending: true })
      .range(from, to);

    if (followersError) {
      throw new Error(`follower paging failed: ${followersError.message}`);
    }

    const rows = followers ?? [];
    const followerIds = rows.map(r => r.follower_id);

    if (followerIds.length === 0) {
      break;
    }

    const { data: recipientProfiles, error: profilesError } = await supabase
      .from('profiles')
      .select(`id, push_token, notif_all, ${typePrefColumn}`)
      .in('id', followerIds);

    if (profilesError) {
      throw new Error(
        `recipient profile load failed: ${profilesError.message}`
      );
    }

    const profiles = recipientProfiles ?? [];
    const profileById = new Map(profiles.map(p => [p.id, p]));

    // Create missing ledger rows first (both channels per recipient), so
    // the completion gate sees a complete picture. ignoreDuplicates keeps
    // existing rows — including terminal ones — untouched.
    for (const followerId of followerIds) {
      const profile = profileById.get(followerId);

      if (!profile) {
        // Deleted/unreadable profile: both channels skipped (terminal).
        await ensureLedgerRow(job.id, followerId, 'in_app', 'skipped');
        await ensureLedgerRow(job.id, followerId, 'push', 'skipped');
        continue;
      }

      const isBlocked = blocked.has(followerId);
      const typePrefOff = profile[typePrefColumn] === false;

      if (isBlocked || typePrefOff) {
        await ensureLedgerRow(job.id, followerId, 'in_app', 'skipped');
        await ensureLedgerRow(job.id, followerId, 'push', 'skipped');
        continue;
      }

      await ensureLedgerRow(job.id, followerId, 'in_app', 'pending');

      const pushInitiallySkipped =
        profile.notif_all === false || !profile.push_token;

      await ensureLedgerRow(
        job.id,
        followerId,
        'push',
        pushInitiallySkipped ? 'skipped' : 'pending'
      );
    }

    // Re-read the ledger for this page and deliver everything due.
    const ledger = await fetchLedgerRows(job.id, followerIds);
    const pushTickets = [];

    for (const profile of profiles) {
      await assertLease();
      const recipientId = profile.id;

      // ── in_app channel ──
      const inAppRow = ledger.get(ledgerKey(recipientId, 'in_app'));

      if (inAppRow) {
        if (inAppRow.status === 'pending' || inAppRow.status === 'failed') {
          if (inAppRow.attempts < RECIPIENT_MAX_ATTEMPTS) {
            const claim = await claimChannel(
              job.id,
              recipientId,
              'in_app',
              inAppRow
            );

            if (claim !== null) {
              await deliverInApp(job, recipientId, claim);
            }
          }
        }
        // 'sent' / 'skipped' → terminal, never touched.
      }

      // ── push channel ──
      const pushRow = ledger.get(ledgerKey(recipientId, 'push'));

      if (!pushRow) {
        continue;
      }

      if (pushRow.status !== 'pending' && pushRow.status !== 'failed') {
        continue; // terminal
      }

      if (pushRow.attempts >= RECIPIENT_MAX_ATTEMPTS) {
        continue;
      }

      const claim = await claimChannel(
        job.id,
        recipientId,
        'push',
        pushRow
      );

      if (claim === null) {
        continue;
      }

      // Token may have been cleared between ticks — re-check.
      if (!profile.push_token) {
        await markChannelSkipped(job.id, recipientId, 'push', claim);
        continue;
      }

      // Quota: only new_video pushes are limited; live is exempt. Consumed
      // immediately before dispatch; on RPC error the push is NOT sent and
      // the channel becomes retryable (quota re-checked at retry time).
      let quotaConsumed = false;

      if (job.kind === 'new_video') {
        const { data: quotaOk, error: quotaError } = await supabase.rpc(
          'claim_push_quota',
          { p_follower: recipientId, p_creator: job.actor_id, p_job_id: job.id }
        );

        if (quotaError) {
          console.error(
            TAG,
            'Quota RPC error for recipient',
            recipientId,
            '— NOT sending; channel stays retryable.',
            quotaError.message
          );

          await markChannelFailed(
            job.id,
            recipientId,
            'push',
            claim,
            'quota RPC error: ' + quotaError.message
          );

          continue;
        }

        if (quotaOk !== true) {
          // Daily quota exhausted — terminal skip, no push ever for today.
          await markChannelSkipped(job.id, recipientId, 'push', claim);
          continue;
        }

        quotaConsumed = true; // Event reservation is retained on retry.
      }

      pushTickets.push({
        token: profile.push_token,
        recipientId,
        job,
        claim,
        quotaConsumed,
        pushTitle,
        pushBody,
        pushData,
      });
    }

    for (let i = 0; i < pushTickets.length; i += PUSH_CHUNK_SIZE) {
      await assertLease();
      await dispatchPushTickets(pushTickets.slice(i, i + PUSH_CHUNK_SIZE));
    }

    if (rows.length < FOLLOWER_PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  // 4. Completion gate: only 'done' when nothing retryable remains.
  await completeJobIfReady(job, finalizeClaim);
}

// ─────────────────────────────────────────────────────────────
// ONE SWEEP RUN
// ─────────────────────────────────────────────────────────────

async function sweepNotifications() {
  const jobs = await claimJobs();

  if (jobs.length === 0) {
    return;
  }

  console.log(TAG, 'Sweep started. Jobs claimed:', jobs.length);

  for (const job of jobs) {
    let heartbeatError = null;
    let heartbeatPromise = null;
    let heartbeatStopped = false;

    const renewLease = async () => {
      if (heartbeatError) throw heartbeatError;
      if (heartbeatStopped) {
        throw new Error(`Heartbeat stopped for job ${job.id}`);
      }

      if (!heartbeatPromise) {
        heartbeatPromise = renewJobHeartbeat(job)
          .catch(error => {
            heartbeatError = error;
            throw error;
          })
          .finally(() => {
            heartbeatPromise = null;
          });
      }

      return heartbeatPromise;
    };

    const heartbeatTimer = setInterval(() => {
      renewLease().catch(error => {
        console.error(TAG, 'Job heartbeat stopped:', error.message);
      });
    }, 60 * 1000);

    heartbeatTimer.unref?.();

    const stopHeartbeat = async () => {
      clearInterval(heartbeatTimer);
      heartbeatStopped = true;

      if (heartbeatPromise) {
        try {
          await heartbeatPromise;
        } catch (_) {
          // Preserve heartbeatError for the caller.
        }
      }
    };

    const finalizeClaim = async () => {
      await stopHeartbeat();
      if (heartbeatError) throw heartbeatError;
      await renewJobHeartbeat(job);
    };

    try {
      await renewLease();

      const assertLease = async () => {
        if (heartbeatError) throw heartbeatError;
        await renewLease();
      };

      await processJob(job, assertLease, finalizeClaim);
    } catch (error) {
      console.error(
        TAG,
        'Job processing failed:',
        job.id,
        error?.message || error
      );

      await stopHeartbeat();

      // A lost lease must not count as a processing attempt.
      await releaseJob(job, JOB_RETRY_MS, heartbeatError === null);
    } finally {
      await stopHeartbeat();
    }
  }
  console.log(TAG, 'Sweep done. Processed:', jobs.length);
}

// ─────────────────────────────────────────────────────────────
// SCHEDULING (shape copied from rejectedVideoCleanup.js)
// ─────────────────────────────────────────────────────────────

function startNotificationWorker() {
  const globalKey = '__bushrannNotificationWorkerStarted';

  if (globalThis[globalKey]) {
    return;
  }

  globalThis[globalKey] = true;

  const firstRunTimer = setTimeout(() => {
    if (sweepInProgress) {
      console.warn(TAG, 'Sweep already running, skipping initial run');
      return;
    }

    sweepInProgress = true;

    sweepNotifications()
      .catch(error => {
        console.error(TAG, 'Initial sweep failed:', error.message);
      })
      .finally(() => {
        sweepInProgress = false;
      });
  }, FIRST_RUN_DELAY_MS);

  firstRunTimer.unref?.();

  const interval = setInterval(() => {
    if (sweepInProgress) {
      console.warn(TAG, 'Previous sweep still running, skipping this tick');
      return;
    }

    sweepInProgress = true;

    sweepNotifications()
      .catch(error => {
        console.error(TAG, 'Scheduled sweep failed:', error.message);
      })
      .finally(() => {
        sweepInProgress = false;
      });
  }, SWEEP_INTERVAL_MS);

  interval.unref?.();

  console.log(TAG, 'Follower notification worker started');
}

startNotificationWorker();

module.exports = { startNotificationWorker };
