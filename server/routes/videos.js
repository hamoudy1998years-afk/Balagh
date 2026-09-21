const express = require('express');
const router = express.Router();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { spawn } = require('child_process');

const { createClient } = require('@supabase/supabase-js');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const { cleanupVideoStorage } = require('../lib/videoStorageCleanup');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VIDEO_BUCKET = 'videos';

// Supabase Free project limits Storage objects to 50 MB.
// Same safety margin as routes/videoProcessing.js.
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;
const WATERMARK_TARGET_BYTES = 44 * 1024 * 1024;

const WATERMARK_PATH = path.join(
  __dirname,
  '..',
  'assets',
  'bushrann-watermark.png'
);

// In-memory job dedupe: simultaneous requests for the same video share
// one FFmpeg job. Cross-instance duplicates are harmless because the
// storage key is deterministic (watermarked/v1/<videoId>.mp4).
const watermarkJobs = new Map();

// ─────────────────────────────────────────────────────────────
// WATERMARK HELPERS
// ─────────────────────────────────────────────────────────────

function getS3Client() {
  const required = [
    'SUPABASE_S3_KEY_ID',
    'SUPABASE_S3_SECRET',
    'SUPABASE_S3_ENDPOINT',
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing Supabase S3 configuration: ${missing.join(', ')}`
    );
  }

  return new S3Client({
    region: process.env.SUPABASE_S3_REGION || 'us-east-1',
    endpoint: process.env.SUPABASE_S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.SUPABASE_S3_KEY_ID,
      secretAccessKey: process.env.SUPABASE_S3_SECRET,
    },
    forcePathStyle: true,
  });
}

function encodeStorageKey(key) {
  return key
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
}

function getPublicVideoUrl(key) {
  return (
    `${process.env.SUPABASE_URL}` +
    `/storage/v1/object/public/${VIDEO_BUCKET}/` +
    encodeStorageKey(key)
  );
}

function getWatermarkStorageKey(videoId) {
  return `watermarked/v1/${videoId}.mp4`;
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${path.basename(command)} exited with code ${code}: ${stderr.slice(
            -4000
          )}`
        )
      );
    });
  });
}

async function probeVideoDuration(filePath) {
  const { stdout } = await runProcess(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    filePath,
  ]);

  let data;

  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new Error('FFprobe returned invalid JSON');
  }

  const duration = Number(data?.format?.duration);

  if (!Number.isFinite(duration) || duration <= 0 || duration >= 86400) {
    throw new Error(
      `Invalid video duration reported by FFprobe: ${duration}`
    );
  }

  return duration;
}

async function downloadToDisk(url, destinationPath) {
  const allowedPrefix =
    `${process.env.SUPABASE_URL}` +
    `/storage/v1/object/public/${VIDEO_BUCKET}/`;

  if (
    typeof url !== 'string' ||
    !url.startsWith(allowedPrefix)
  ) {
    throw new Error(
      'Video source is not a valid Bushrann Supabase Storage URL'
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 10 * 60 * 1000);

  timeout.unref?.();

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(
        `Video download failed with HTTP ${response.status}`
      );
    }

    if (!response.body) {
      throw new Error('Video download response had no body');
    }

    const nodeStream = Readable.fromWeb(response.body);

    await pipeline(
      nodeStream,
      fs.createWriteStream(destinationPath)
    );

    const stats = await fs.promises.stat(destinationPath);

    if (!stats.isFile() || stats.size < 50 * 1024) {
      throw new Error('Downloaded video file is unexpectedly small');
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Burns the Bushrann PNG watermark into the bottom-right corner.
// The overlay scales relative to the video width (18%) preserving its
// aspect ratio, with proportional padding from the edges.
function buildWatermarkArgs(inputPath, watermarkFilePath, outputPath) {
  return [
    '-y',
    '-i',
    inputPath,
    '-i',
    watermarkFilePath,
    '-filter_complex',
    '[1:v][0:v]scale2ref=w=iw*0.11:h=ow/mdar[wm][base];' +
      '[wm]format=rgba,colorchannelmixer=aa=0.72[wmalpha];' +
      '[base][wmalpha]overlay=W-w-main_w*0.04:H-h-main_h*0.04[vout]',
    '-map',
    '[vout]',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    outputPath,
  ];
}

// Duration-based bitrate re-encode for when the CRF output would exceed
// the Supabase Storage object limit. Mirrors the strategy used by
// routes/videoProcessing.js transcodeVideo.
function buildBitrateLimitedWatermarkArgs(
  inputPath,
  watermarkFilePath,
  outputPath,
  duration
) {
  const safeDuration =
    Number.isFinite(duration) && duration > 0 ? duration : 300;

  const audioBitrateKbps = 96;

  const totalBitrateKbps = Math.floor(
    (WATERMARK_TARGET_BYTES * 8) / safeDuration / 1000
  );

  const videoBitrateKbps = Math.max(
    250,
    totalBitrateKbps - audioBitrateKbps
  );

  return [
    '-y',
    '-i',
    inputPath,
    '-i',
    watermarkFilePath,
    '-filter_complex',
    '[1:v][0:v]scale2ref=w=iw*0.11:h=ow/mdar[wm][base];' +
      '[wm]format=rgba,colorchannelmixer=aa=0.72[wmalpha];' +
      '[base][wmalpha]overlay=W-w-main_w*0.04:H-h-main_h*0.04[vout]',
    '-map',
    '[vout]',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-b:v',
    `${videoBitrateKbps}k`,
    '-maxrate',
    `${videoBitrateKbps}k`,
    '-bufsize',
    `${videoBitrateKbps * 2}k`,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    `${audioBitrateKbps}k`,
    '-movflags',
    '+faststart',
    outputPath,
  ];
}

async function generateWatermarkedVideo(videoId, sourceUrl) {
  let tempDirectory = null;

  try {
    await fs.promises.access(WATERMARK_PATH, fs.constants.R_OK);
  } catch (error) {
    throw new Error('Watermark asset is missing on the server');
  }

  try {
    tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), `bushrann-watermark-${videoId}-`)
    );

    const sourcePath = path.join(tempDirectory, 'source.mp4');
    const outputPath = path.join(tempDirectory, 'watermarked.mp4');

    await downloadToDisk(sourceUrl, sourcePath);

    await runProcess(
      ffmpegPath,
      buildWatermarkArgs(sourcePath, WATERMARK_PATH, outputPath)
    );

    let stats = await fs.promises.stat(outputPath);

    if (stats.size > MAX_UPLOAD_BYTES) {
      console.log(
        '[WATERMARK] CRF output exceeds Storage limit; compressing:',
        videoId,
        `${(stats.size / 1024 / 1024).toFixed(2)} MB`
      );

      const duration = await probeVideoDuration(sourcePath);

      const compressedPath = path.join(
        tempDirectory,
        'watermarked-compressed.mp4'
      );

      await runProcess(
        ffmpegPath,
        buildBitrateLimitedWatermarkArgs(
          sourcePath,
          WATERMARK_PATH,
          compressedPath,
          duration
        )
      );

      const compressedStats = await fs.promises.stat(compressedPath);

      if (compressedStats.size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `Watermarked video is still too large: ${(
            compressedStats.size /
            1024 /
            1024
          ).toFixed(2)} MB`
        );
      }

      await fs.promises.rename(compressedPath, outputPath);

      stats = compressedStats;
    }

    const storageKey = getWatermarkStorageKey(videoId);

    const s3 = getS3Client();

    await s3.send(
      new PutObjectCommand({
        Bucket: VIDEO_BUCKET,
        Key: storageKey,
        Body: fs.createReadStream(outputPath),
        ContentLength: stats.size,
        ContentType: 'video/mp4',
      })
    );

    console.log(
      '[WATERMARK] Uploaded:',
      videoId,
      `${(stats.size / 1024 / 1024).toFixed(2)} MB`
    );

    return getPublicVideoUrl(storageKey);
  } finally {
    if (tempDirectory) {
      try {
        await fs.promises.rm(tempDirectory, {
          recursive: true,
          force: true,
        });
      } catch (cleanupError) {
        console.warn(
          '[WATERMARK] Temp cleanup failed:',
          tempDirectory,
          cleanupError.message
        );
      }
    }
  }
}

async function deleteWatermarkedObject(videoId) {
  try {
    const s3 = getS3Client();

    await s3.send(
      new DeleteObjectCommand({
        Bucket: VIDEO_BUCKET,
        Key: getWatermarkStorageKey(videoId),
      })
    );
  } catch (error) {
    console.warn(
      '[WATERMARK] Failed to remove watermarked object:',
      videoId,
      error.message
    );
  }
}

async function getOrCreateWatermarkJob(videoId, sourceUrl) {
  const existing = watermarkJobs.get(videoId);

  if (existing) {
    return existing;
  }

  const job = (async () => {
    const storageKey = getWatermarkStorageKey(videoId);

    // Reuse an existing deterministic output instead of reprocessing.
    try {
      const s3 = getS3Client();

      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: VIDEO_BUCKET,
          Key: storageKey,
        })
      );

      if (
        head?.ContentLength &&
        head.ContentLength > 0 &&
        head.ContentLength <= MAX_UPLOAD_BYTES
      ) {
        return getPublicVideoUrl(storageKey);
      }
    } catch (error) {
      const statusCode = error?.$metadata?.httpStatusCode;

      const isNotFound =
        error?.name === 'NotFound' ||
        error?.name === 'NoSuchKey' ||
        statusCode === 404;

      // Only a genuine "object does not exist" may proceed to generation.
      // Credentials, S3 config, permission, network, or any other S3
      // error must fail the request instead of triggering FFmpeg.
      if (!isNotFound) {
        throw error;
      }
    }

    return generateWatermarkedVideo(videoId, sourceUrl);
  })();

  watermarkJobs.set(videoId, job);

  try {
    return await job;
  } finally {
    watermarkJobs.delete(videoId);
  }
}

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
// WATERMARK (public share)
//
// POST /api/videos/:videoId/watermark
// Guest-accessible for eligible public videos only. The client sends
// ONLY the video ID; the server loads the row via the service client,
// validates it, burns the Bushrann watermark PNG in with FFmpeg, and
// stores the result at the deterministic key watermarked/v1/<id>.mp4.
// ─────────────────────────────────────────────────────────────

router.post('/:videoId/watermark', async (req, res) => {
  try {
    const { videoId } = req.params;

    if (!videoId || typeof videoId !== 'string') {
      return res.status(400).json({ error: 'Missing videoId' });
    }

    const {
      data: video,
      error: loadError,
    } = await supabase
      .from('videos')
      .select(
        [
          'id',
          'video_url',
          'original_video_url',
          'is_private',
          'status',
          'processing_status',
        ].join(',')
      )
      .eq('id', videoId)
      .maybeSingle();

    if (loadError) {
      console.error(
        '[WATERMARK] Lookup error:',
        videoId,
        loadError.message
      );

      return res.status(500).json({ error: 'Failed to load video' });
    }

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Livestream replays live in the `livestreams` bucket; the trusted
    // source URL validation below (videos bucket only) already rejects them.

    if (video.is_private) {
      return res.status(403).json({
        error: 'Private videos cannot be shared',
      });
    }

    if (video.status !== 'approved') {
      return res.status(403).json({
        error: 'Video is not approved for sharing',
      });
    }

    if (video.processing_status !== 'ready') {
      return res.status(409).json({
        error: 'Video is not ready for sharing yet',
      });
    }

    const sourceUrl =
      video.original_video_url || video.video_url;

    const allowedPrefix =
      `${process.env.SUPABASE_URL}` +
      `/storage/v1/object/public/${VIDEO_BUCKET}/`;

    if (
      typeof sourceUrl !== 'string' ||
      !sourceUrl.startsWith(allowedPrefix)
    ) {
      return res.status(400).json({
        error: 'Video has no valid Bushrann source URL',
      });
    }

    const watermarkedUrl = await getOrCreateWatermarkJob(
      videoId,
      sourceUrl
    );

    return res.status(200).json({
      success: true,
      watermarkedUrl,
    });
  } catch (error) {
    console.error('[WATERMARK] Generation failed:', error.message);

    return res.status(500).json({
      error: 'Failed to prepare watermarked video',
    });
  }
});

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

  // Best-effort removal of the derived watermarked share object (exact
  // deterministic key). Never fails the deletion.
  await deleteWatermarkedObject(videoId);

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
      .not('video_url', 'like', '%/object/public/livestreams/%')
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

      // Best-effort removal of the derived watermarked share object.
      await deleteWatermarkedObject(row.id);

      videosCleaned += 1;
    }
  }

  return res.status(200).json({ success: true, videosCleaned });
});

module.exports = router;
