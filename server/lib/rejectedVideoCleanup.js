// Sweeper: periodically hard-deletes rejected videos older than 30 days.
//
// Race-safe claim protocol. For each candidate row:
//   1. Atomically claim the row: UPDATE rejected -> cleanup, conditioned on
//      id + status='rejected' + reviewed_at older than the 30-day cutoff +
//      non-livestream-bucket video_url, returning the row. Only the
//      successful claimant
//      proceeds; zero returned rows means the video was restored or changed
//      — Storage is NEVER touched in that case.
//   2. Delete its storage objects via the shared, strict cleanupVideoStorage
//      helper. On failure, revert the claim (cleanup -> rejected) so the row
//      is not stranded and a later run retries; reviewed_at is untouched, so
//      eligibility is preserved. The revert is not publicly approved.
//   3. Delete the DB row while it is still status='cleanup'.
//
// approve_appeal (see migration 20260917_rejected_cleanup_claim.sql) only
// restores videos with status='rejected', so a claimed video can never be
// restored into deleted media.
//
// Scheduling mirrors routes/videoProcessing.js startRecoverySweeper():
// double-start guard on globalThis, delayed first run (with the same
// cleanupInProgress guard as interval ticks), unref'd timers, in-progress
// guard against overlap. Importing this module starts it.

const { createClient } = require('@supabase/supabase-js');
const { cleanupVideoStorage } = require('./videoStorageCleanup');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TAG = '[REJECTED-CLEANUP]';

const BATCH_SIZE = 25;
const RETENTION_DAYS = 30;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const FIRST_RUN_DELAY_MS = 60 * 1000;

let cleanupInProgress = false;

// ─────────────────────────────────────────────────────────────
// ONE CLEANUP RUN
// ─────────────────────────────────────────────────────────────

async function sweepRejectedVideos() {
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // One bounded batch per run — no paging. Excludes livestream replays
  // but keeps NULL-type legacy normal videos.
  const { data: rows, error } = await supabase
    .from('videos')
    .select(
      'id, user_id, video_url, original_video_url, thumbnail_url, status, reviewed_at'
    )
    .eq('status', 'rejected')
    .lt('reviewed_at', cutoff)
    .not('video_url', 'like', '%/object/public/livestreams/%')
    .order('reviewed_at', { ascending: true })
    .range(0, BATCH_SIZE - 1);

  if (error) {
    console.error(TAG, 'Eligibility query failed:', error.message);
    return;
  }

  console.log(TAG, 'Sweep started. Eligible rows found:', rows?.length ?? 0);

  let cleaned = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows ?? []) {
    // 1. Claim exclusive cleanup ownership: rejected -> cleanup. The claim
    //    only succeeds when the row STILL satisfies every eligibility
    //    condition at claim time (id, status, age, non-livestream-bucket
    //    video_url). An appeal restore or any other status change makes this match
    //    zero rows — then we skip WITHOUT touching Storage.
    const { data: claimed, error: claimError } = await supabase
      .from('videos')
      .update({ status: 'cleanup' })
      .eq('id', row.id)
      .eq('status', 'rejected')
      .lt('reviewed_at', cutoff)
      .not('video_url', 'like', '%/object/public/livestreams/%')
      .select('id');

    if (claimError) {
      console.error(TAG, 'Claim failed for video:', row.id, claimError.message);
      failed += 1;
      continue;
    }

    if (!claimed || claimed.length === 0) {
      // Restored or changed between the eligibility read and the claim.
      // No Storage object has been touched for this video.
      console.log(TAG, 'Row changed before claim, skipped video:', row.id);
      skipped += 1;
      continue;
    }

    // 2. Storage cleanup. We are the exclusive owner now; approve_appeal
    //    cannot restore this video while it is status='cleanup'. Failure
    //    semantics inherit from the helper: missing objects are success;
    //    unparseable URL or S3 error = !ok.
    const { ok } = await cleanupVideoStorage(row);

    if (!ok) {
      // Revert the claim so the row is not stranded in 'cleanup': back to
      // 'rejected' with the original reviewed_at, so the next run retries.
      // It can never become publicly approved through this path.
      console.warn(TAG, 'Storage cleanup failed for video:', row.id);
      const { error: revertError } = await supabase
        .from('videos')
        .update({ status: 'rejected' })
        .eq('id', row.id)
        .eq('status', 'cleanup');

      if (revertError) {
        console.error(TAG, 'Claim revert failed for video:', row.id, revertError.message);
      }

      failed += 1;
      continue;
    }

    // 3. Delete the claimed row. Re-check status='cleanup' so a row we
    //    cannot own is never deleted. PostgREST returns the deleted rows
    //    when .select is present; an empty array means the row no longer
    //    satisfies the condition — not an error, and not a failure.
    const { data: deleted, error: deleteError } = await supabase
      .from('videos')
      .delete()
      .eq('id', row.id)
      .eq('status', 'cleanup')
      .select('id');

    if (deleteError) {
      console.error(TAG, 'Row delete failed for video:', row.id, deleteError.message);
      failed += 1;
      continue;
    }

    if (!deleted || deleted.length === 0) {
      // Should not happen after a successful claim, but never count it as
      // cleaned unless we actually deleted the row.
      console.log(TAG, 'Claimed row changed before delete, skipped video:', row.id);
      skipped += 1;
      continue;
    }

    cleaned += 1;
  }

  console.log(
    TAG,
    'Sweep done. Cleaned:',
    cleaned,
    'Failed:',
    failed,
    'Skipped:',
    skipped
  );
}

// ─────────────────────────────────────────────────────────────
// SCHEDULING (shape copied from startRecoverySweeper)
// ─────────────────────────────────────────────────────────────

function startRejectedCleanupSweeper() {
  const globalKey = '__bushrannRejectedCleanupSweeperStarted';

  if (globalThis[globalKey]) {
    return;
  }

  globalThis[globalKey] = true;

  // Same in-progress guard as the interval ticks: if an interval tick has
  // somehow already started a sweep, skip the delayed first run.
  const firstRunTimer = setTimeout(() => {
    if (cleanupInProgress) {
      console.warn(TAG, 'Sweep already running, skipping initial run');
      return;
    }

    cleanupInProgress = true;

    sweepRejectedVideos()
      .catch(error => {
        console.error(TAG, 'Initial sweep failed:', error.message);
      })
      .finally(() => {
        cleanupInProgress = false;
      });
  }, FIRST_RUN_DELAY_MS);

  firstRunTimer.unref?.();

  const interval = setInterval(() => {
    if (cleanupInProgress) {
      console.warn(TAG, 'Previous sweep still running, skipping this tick');
      return;
    }

    cleanupInProgress = true;

    sweepRejectedVideos()
      .catch(error => {
        console.error(TAG, 'Scheduled sweep failed:', error.message);
      })
      .finally(() => {
        cleanupInProgress = false;
      });
  }, SWEEP_INTERVAL_MS);

  interval.unref?.();

  console.log(TAG, 'Rejected video cleanup sweeper started');
}

startRejectedCleanupSweeper();

module.exports = { startRejectedCleanupSweeper };
