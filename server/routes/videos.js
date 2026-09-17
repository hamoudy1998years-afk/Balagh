const express = require('express');
const router = express.Router();

const { createClient } = require('@supabase/supabase-js');

const { cleanupVideoStorage } = require('../lib/videoStorageCleanup');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─────────────────────────────────────────────────────────────
// AUTH (same pattern as routes/videoProcessing.js)
// ─────────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';

    const token = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : null;

    if (!token) {
      return res.status(401).json({
        error: 'Missing authentication',
      });
    }

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user?.id) {
      return res.status(401).json({
        error: 'Invalid or expired authentication',
      });
    }

    req.authUserId = user.id;

    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Invalid or expired authentication',
    });
  }
}

// ─────────────────────────────────────────────────────────────
// DELETE VIDEO
// ─────────────────────────────────────────────────────────────

router.delete('/:videoId', requireAuth, async (req, res) => {
  const { videoId } = req.params;

  // 1. Fetch the videos row.
  const { data: row, error: fetchError } = await supabase
    .from('videos')
    .select('id, user_id, video_url, original_video_url, thumbnail_url')
    .eq('id', videoId)
    .maybeSingle();

  if (fetchError) {
    console.warn('[VIDEOS] Failed to fetch video row:', videoId, fetchError.message);
    return res.status(500).json({ error: 'Failed to delete video' });
  }

  // Idempotent-friendly: nothing to delete.
  if (!row) {
    return res.status(200).json({ success: true, deleted: false, alreadyGone: true });
  }

  // 2. Authorization: owner OR admin.
  if (req.authUserId !== row.user_id) {
    const { data: adminRow, error: adminError } = await supabase
      .from('admins')
      .select('user_id')
      .eq('user_id', req.authUserId)
      .maybeSingle();

    if (adminError || !adminRow) {
      return res.status(403).json({ error: 'Not authorized to delete this video' });
    }
  }

  // 3. Delete the row's storage objects.
  const cleanup = await cleanupVideoStorage(row);

  // 4. Delete the videos row ONLY if every recognized storage object was
  //    deleted or already absent, and every non-null URL parsed safely.
  //    Otherwise keep the row so its URLs remain available for retry.
  //    (Missing S3 keys count as already cleaned — delete succeeds.)
  if (!cleanup.ok) {
    return res.status(500).json({
      error: 'Could not remove all video files. Please try again.',
      storageCleaned: cleanup.objectsCleaned,
      storageFailed: cleanup.storageFailed,
    });
  }

  // Child rows (appeals, comments, likes, notifications, reports) cascade
  // via ON DELETE CASCADE — do NOT touch them manually.
  const { error: deleteError } = await supabase
    .from('videos')
    .delete()
    .eq('id', videoId);

  if (deleteError) {
    console.warn('[VIDEOS] Failed to delete videos row:', videoId, deleteError.message);
    return res.status(500).json({ error: 'Failed to delete video' });
  }

  return res.status(200).json({
    success: true,
    deleted: true,
    storageCleaned: cleanup.objectsCleaned,
    storageFailed: [],
  });
});

// ─────────────────────────────────────────────────────────────
// ACCOUNT DELETION: CLEAN UP ALL NORMAL VIDEO FILES
// ─────────────────────────────────────────────────────────────

// Called by the delete-user edge function BEFORE any other DB rows are
// deleted. For each normal video this endpoint cleans that video's exact
// storage objects and then immediately deletes that video's row — so a
// video's DB metadata never outlives a failed storage cleanup, and no row
// ever points at already-deleted media.
// Livestream replay rows (type='livestream', livestreams-bucket URLs) are
// excluded — they are handled by the edge function itself.
router.post('/account/:userId/cleanup-videos', requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (req.authUserId !== userId) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  // Process videos in bounded first-batch batches: fetch the first
  // BATCH_SIZE remaining normal-video rows, clean each one and delete its
  // row immediately, then re-query from the start. Offset pagination would
  // skip rows because the result set shrinks as we delete.
  const BATCH_SIZE = 50;
  let videosCleaned = 0;

  for (;;) {
    const { data: rows, error: fetchError } = await supabase
      .from('videos')
      .select('id, user_id, video_url, original_video_url, thumbnail_url')
      .eq('user_id', userId)
      // Livestream replays live in the livestreams bucket — never touch them.
      .or('type.is.null,type.neq.livestream')
      .range(0, BATCH_SIZE - 1);

    if (fetchError) {
      console.warn('[VIDEOS] Failed to fetch user videos for cleanup:', userId, fetchError.message);
      return res.status(500).json({ error: 'Could not remove all video files. Please try again.' });
    }

    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      // 1. Clean this video's exact storage objects.
      const cleanup = await cleanupVideoStorage(row);

      if (!cleanup.ok) {
        // Keep the row so its URLs remain available for retry.
        console.warn('[VIDEOS] Storage cleanup failed for video:', row.id);
        return res.status(500).json({
          error: 'Could not remove all video files. Please try again.',
        });
      }

      // 2. Only after storage cleanup succeeds, delete THIS row.
      const { error: deleteError } = await supabase
        .from('videos')
        .delete()
        .eq('id', row.id);

      if (deleteError) {
        console.warn('[VIDEOS] Failed to delete videos row:', row.id, deleteError.message);
        return res.status(500).json({ error: 'Failed to delete video' });
      }

      videosCleaned += 1;
    }
  }

  return res.status(200).json({ success: true, videosCleaned });
});

module.exports = router;
