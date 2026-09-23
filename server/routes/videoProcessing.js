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
} = require('@aws-sdk/client-s3');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

// v8 watermark pre-warm helper (see routes/videos.js). Importing the
// videos router here is safe: routes/videos.js does not require this file,
// so there is no circular dependency.
const { warmWatermarkForVideo } = require('./videos');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VIDEO_BUCKET = 'videos';

// Supabase Free project currently limits Storage objects to 50 MB.
// Keep a small safety margin below the hard limit.
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;
const activeJobs = new Set();

let recoverySweepInProgress = false;

const RECOVERY_INTERVAL_MS = 60 * 1000;
const MAX_RECOVERY_ROWS = 10;
const MAX_WATERMARK_WARM_ROWS = 5;

// ─────────────────────────────────────────────────────────────
// AUTH
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
// S3
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

// ─────────────────────────────────────────────────────────────
// PROCESS HELPERS
// ─────────────────────────────────────────────────────────────

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
    });

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
        resolve({
          stdout,
          stderr,
        });

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

async function probeVideo(filePath) {
  const { stdout } = await runProcess(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  let data;

  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new Error('FFprobe returned invalid JSON');
  }

  const duration = Number(data?.format?.duration);

  const streams = Array.isArray(data?.streams)
    ? data.streams
    : [];

  const videoStream = streams.find(
    stream => stream.codec_type === 'video'
  );

  const audioStream = streams.find(
    stream => stream.codec_type === 'audio'
  );

  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration >= 86400
  ) {
    throw new Error(
      `Invalid video duration reported by FFprobe: ${duration}`
    );
  }

  if (!videoStream) {
    throw new Error('No video stream found');
  }

  return {
    duration,

    videoCodec:
      typeof videoStream.codec_name === 'string'
        ? videoStream.codec_name.toLowerCase()
        : null,

    audioCodec:
      typeof audioStream?.codec_name === 'string'
        ? audioStream.codec_name.toLowerCase()
        : null,

    hasAudio: Boolean(audioStream),

    width: Number(videoStream.width) || null,
    height: Number(videoStream.height) || null,
  };
}

async function remuxVideo(inputPath, outputPath) {
  await runProcess(ffmpegPath, [
    '-y',

    '-i',
    inputPath,

    '-map',
    '0:v:0',

    '-map',
    '0:a?',

    '-c',
    'copy',

    '-movflags',
    '+faststart',

    '-avoid_negative_ts',
    'make_zero',

    outputPath,
  ]);
}

async function transcodeVideo(inputPath, outputPath, duration) {
  const targetBytes = 44 * 1024 * 1024;

  const safeDuration =
    Number.isFinite(duration) && duration > 0
      ? duration
      : 300;

  // Reserve roughly 96 kbps for AAC audio and calculate the
  // remaining bitrate from the desired final file size.
  const audioBitrateKbps = 96;

  const totalBitrateKbps =
    Math.floor(
      (targetBytes * 8) /
      safeDuration /
      1000
    );

  const videoBitrateKbps =
    Math.max(
      250,
      totalBitrateKbps - audioBitrateKbps
    );

  console.log(
    '[VIDEO PROCESS] Compressing:',
    `target≈44MB`,
    `video=${videoBitrateKbps}k`,
    `audio=${audioBitrateKbps}k`
  );

  await runProcess(ffmpegPath, [
    '-y',
    '-i',
    inputPath,

    '-map',
    '0:v:0',
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

    '-avoid_negative_ts',
    'make_zero',

    outputPath,
  ]);
}

function isAndroidFriendlyProbe(probe) {
  if (!probe) {
    return false;
  }

  if (probe.videoCodec !== 'h264') {
    return false;
  }

  if (
    probe.hasAudio &&
    probe.audioCodec !== 'aac'
  ) {
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// DOWNLOAD
// ─────────────────────────────────────────────────────────────

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
    const response = await fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Video download failed with HTTP ${response.status}`
      );
    }

    if (!response.body) {
      throw new Error(
        'Video download response had no body'
      );
    }

    const nodeStream = Readable.fromWeb(
      response.body
    );

    await pipeline(
      nodeStream,
      fs.createWriteStream(destinationPath)
    );

    const stats =
      await fs.promises.stat(destinationPath);

    if (!stats.isFile() || stats.size < 50 * 1024) {
      throw new Error(
        'Downloaded video file is unexpectedly small'
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────
// UPLOAD
// ─────────────────────────────────────────────────────────────

async function uploadProcessedVideo(
  filePath,
  storageKey
) {
  const s3 = getS3Client();

  const stats = await fs.promises.stat(filePath);

  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(
      'Processed video file is missing'
    );
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: VIDEO_BUCKET,

      Key: storageKey,

      Body: fs.createReadStream(filePath),

      ContentLength: stats.size,

      ContentType: 'video/mp4',
    })
  );

  return getPublicVideoUrl(storageKey);
}

async function deleteProcessedObject(storageKey) {
  try {
    const s3 = getS3Client();

    await s3.send(
      new DeleteObjectCommand({
        Bucket: VIDEO_BUCKET,
        Key: storageKey,
      })
    );
  } catch (error) {
    console.warn(
      '[VIDEO PROCESS] Failed to remove orphan processed object:',
      storageKey,
      error.message
    );
  }
}

// ─────────────────────────────────────────────────────────────
// DATABASE HELPERS
// ─────────────────────────────────────────────────────────────

async function markFailed(videoId, message) {
  const { error } = await supabase
    .from('videos')
    .update({
      processing_status: 'failed',
    })
    .eq('id', videoId)
    .eq('processing_status', 'processing');

  if (error) {
    console.error(
      '[VIDEO PROCESS] Failed to mark video failed:',
      videoId,
      error.message
    );
  }

  console.error(
    '[VIDEO PROCESS] Video failed:',
    videoId,
    message
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN PROCESSOR
// ─────────────────────────────────────────────────────────────

async function processVideo(videoId) {
  if (
    !videoId ||
    activeJobs.has(videoId)
  ) {
    return;
  }

  activeJobs.add(videoId);

  let tempDirectory = null;
  let uploadedStorageKey = null;

  try {
    console.log(
      '[VIDEO PROCESS] Starting:',
      videoId
    );

    const {
      data: video,
      error: loadError,
    } = await supabase
      .from('videos')
      .select(
        [
          'id',
          'user_id',
          'video_url',
          'original_video_url',
          'processing_status',
          'processing_attempts',
        ].join(',')
      )
      .eq('id', videoId)
      .maybeSingle();

    if (loadError) {
      throw loadError;
    }

    if (!video) {
      console.warn(
        '[VIDEO PROCESS] Video row no longer exists:',
        videoId
      );

      return;
    }

    if (video.processing_status !== 'processing') {
      console.log(
        '[VIDEO PROCESS] Video is no longer processing:',
        videoId,
        video.processing_status
      );

      return;
    }

    const sourceUrl =
      video.original_video_url ||
      video.video_url;

    if (!sourceUrl) {
      throw new Error(
        'Video has no source URL'
      );
    }

    tempDirectory =
      await fs.promises.mkdtemp(
        path.join(
          os.tmpdir(),
          `bushrann-video-${videoId}-`
        )
      );

    const sourcePath =
      path.join(
        tempDirectory,
        'source.mp4'
      );

    const remuxPath =
      path.join(
        tempDirectory,
        'remuxed.mp4'
      );

    const transcodePath =
      path.join(
        tempDirectory,
        'transcoded.mp4'
      );

    await downloadToDisk(
      sourceUrl,
      sourcePath
    );

    const sourceProbe =
      await probeVideo(sourcePath);

    console.log(
      '[VIDEO PROCESS] Source probe:',
      videoId,
      sourceProbe
    );

    let finalPath = null;
    let finalProbe = null;

    try {
      await remuxVideo(
        sourcePath,
        remuxPath
      );

      const remuxProbe =
        await probeVideo(remuxPath);

      console.log(
        '[VIDEO PROCESS] Remux probe:',
        videoId,
        remuxProbe
      );

      if (
        isAndroidFriendlyProbe(
            remuxProbe
        )
        ) {
        const remuxStats =
            await fs.promises.stat(remuxPath);

        if (remuxStats.size <= MAX_UPLOAD_BYTES) {
            finalPath = remuxPath;
            finalProbe = remuxProbe;

            console.log(
            '[VIDEO PROCESS] Remux fits Storage limit:',
            videoId,
            `${(
                remuxStats.size /
                1024 /
                1024
            ).toFixed(2)} MB`
            );
        } else {
            console.log(
            '[VIDEO PROCESS] Remux exceeds Storage limit; compression required:',
            videoId,
            `${(
                remuxStats.size /
                1024 /
                1024
            ).toFixed(2)} MB`
            );
        }
        }
    } catch (remuxError) {
      console.warn(
        '[VIDEO PROCESS] Remux failed; will transcode:',
        videoId,
        remuxError.message
      );
    }

    if (!finalPath) {
      console.log(
        '[VIDEO PROCESS] Transcoding for Android compatibility:',
        videoId
      );

      await transcodeVideo(
        sourcePath,
        transcodePath,
        sourceProbe.duration
        );

      const transcodeProbe =
        await probeVideo(transcodePath);

        if (
        !isAndroidFriendlyProbe(
            transcodeProbe
        )
        ) {
        throw new Error(
            'Transcoded output is still not Android-compatible'
        );
        }

        const transcodeStats =
        await fs.promises.stat(transcodePath);

        if (transcodeStats.size > MAX_UPLOAD_BYTES) {
        throw new Error(
            `Transcoded video is still too large: ${(
            transcodeStats.size /
            1024 /
            1024
            ).toFixed(2)} MB`
        );
        }

        console.log(
        '[VIDEO PROCESS] Compressed output:',
        videoId,
        `${(
            transcodeStats.size /
            1024 /
            1024
        ).toFixed(2)} MB`
        );

        finalPath = transcodePath;
        finalProbe = transcodeProbe;
    }

    if (!finalProbe) {
      throw new Error(
        'No valid processed video output was produced'
      );
    }

    const storageKey =
      `processed/${video.user_id}/${video.id}_${Date.now()}.mp4`;

    uploadedStorageKey = storageKey;

    const processedUrl =
      await uploadProcessedVideo(
        finalPath,
        storageKey
      );

    console.log(
      '[VIDEO PROCESS] Uploaded processed video:',
      videoId,
      processedUrl
    );

    const canonicalDuration =
      Math.max(
        1,
        Math.round(finalProbe.duration)
      );

    const {
      data: updatedVideo,
      error: updateError,
    } = await supabase
      .from('videos')
      .update({
        video_url: processedUrl,

        original_video_url:
          video.original_video_url ||
          video.video_url,

        duration:
          canonicalDuration,

        processing_status:
          'ready',
      })
      .eq('id', videoId)
      .eq(
        'processing_status',
        'processing'
      )
      .select(
        'id, video_url, duration, processing_status'
      )
      .maybeSingle();

    if (updateError) {
      throw updateError;
    }

    if (!updatedVideo) {
      console.warn(
        '[VIDEO PROCESS] Video state changed before publish:',
        videoId
      );

      await deleteProcessedObject(
        uploadedStorageKey
      );

      uploadedStorageKey = null;

      return;
    }

    uploadedStorageKey = null;

    console.log(
      '[VIDEO PROCESS] Ready:',
      videoId,
      `duration=${canonicalDuration}s`
    );

    // Fire-and-forget: pre-warm the v8 watermark cache so the first
    // Share/Download reuses watermarked/v8/<id>.mp4 instead of waiting
    // on FFmpeg. A warm failure is logged and must never fail the
    // already-ready video; the watermark endpoint regenerates on demand.
    warmWatermarkForVideo(videoId).catch((error) => {
      console.warn(
        '[WATERMARK] Background warm failed:',
        videoId,
        error?.message || error
      );
    });
  } catch (error) {
    if (uploadedStorageKey) {
      await deleteProcessedObject(
        uploadedStorageKey
      );

      uploadedStorageKey = null;
    }

    await markFailed(
      videoId,
      error?.message || String(error)
    );
  } finally {
    activeJobs.delete(videoId);

    if (tempDirectory) {
      try {
        await fs.promises.rm(
          tempDirectory,
          {
            recursive: true,
            force: true,
          }
        );
      } catch (cleanupError) {
        console.warn(
          '[VIDEO PROCESS] Temp cleanup failed:',
          tempDirectory,
          cleanupError.message
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────

router.post(
  '/process',
  requireAuth,
  async (req, res) => {
    try {
      const { videoId } = req.body || {};

      if (
        !videoId ||
        typeof videoId !== 'string'
      ) {
        return res.status(400).json({
          error: 'Missing videoId',
        });
      }

      const {
        data: video,
        error: videoError,
      } = await supabase
        .from('videos')
        .select(
          [
            'id',
            'user_id',
            'video_url',
            'original_video_url',
            'processing_status',
            'processing_attempts',
          ].join(',')
        )
        .eq('id', videoId)
        .maybeSingle();

      if (videoError) {
        console.error(
          '[VIDEO PROCESS] Lookup error:',
          videoError.message
        );

        return res.status(500).json({
          error: 'Failed to load video',
        });
      }

      if (!video) {
        return res.status(404).json({
          error: 'Video not found',
        });
      }

      if (
        video.user_id !==
        req.authUserId
      ) {
        return res.status(403).json({
          error:
            'You do not own this video',
        });
      }

      const originalUrl =
        video.original_video_url ||
        video.video_url;

      if (!originalUrl) {
        return res.status(400).json({
          error:
            'Video has no source URL',
        });
      }

      const attempts =
        Number.isFinite(
          Number(
            video.processing_attempts
          )
        )
          ? Number(
              video.processing_attempts
            ) + 1
          : 1;

      const {
        error: updateError,
      } = await supabase
        .from('videos')
        .update({
          processing_status:
            'processing',

          processing_attempts:
            attempts,

          original_video_url:
            originalUrl,
        })
        .eq('id', videoId)
        .eq(
          'user_id',
          req.authUserId
        );

      if (updateError) {
        console.error(
          '[VIDEO PROCESS] Failed to queue video:',
          updateError.message
        );

        return res.status(500).json({
          error:
            'Failed to queue video processing',
        });
      }

      setImmediate(() => {
        processVideo(videoId).catch(
          error => {
            console.error(
              '[VIDEO PROCESS] Background job crashed:',
              videoId,
              error.message
            );
          }
        );
      });

      return res.status(202).json({
        success: true,
        videoId,
        processingStatus:
          'processing',
      });
    } catch (error) {
      console.error(
        '[VIDEO PROCESS] Queue error:',
        error.message
      );

      return res.status(500).json({
        error:
          'Failed to start video processing',
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// RECOVERY SWEEPER
//
// Railway can restart while FFmpeg is running.
// Videos remain processing in Supabase, so this sweep picks them
// back up after restart instead of leaving them stuck forever.
// ─────────────────────────────────────────────────────────────

async function sweepProcessingVideos() {
  if (recoverySweepInProgress) {
    return;
  }

  recoverySweepInProgress = true;

  try {
    const {
      data: videos,
      error,
    } = await supabase
      .from('videos')
      .select('id')
      .eq(
        'processing_status',
        'processing'
      )
      .order(
        'created_at',
        {
          ascending: true,
        }
      )
      .limit(MAX_RECOVERY_ROWS);

    if (error) {
      console.error(
        '[VIDEO PROCESS] Recovery query failed:',
        error.message
      );

      return;
    }

    for (const video of videos || []) {
      if (
        video?.id &&
        !activeJobs.has(video.id)
      ) {
        processVideo(
          video.id
        ).catch(error => {
          console.error(
            '[VIDEO PROCESS] Recovery job crashed:',
            video.id,
            error.message
          );
        });
      }
    }
  } catch (error) {
    console.error(
      '[VIDEO PROCESS] Recovery sweep failed:',
      error.message
    );
  } finally {
    recoverySweepInProgress = false;
  }
}

async function sweepApprovedWatermarks() {
  try {
    const { data: videos, error } = await supabase
      .from('videos')
      .select('id')
      .eq('status', 'approved')
      .eq('processing_status', 'ready')
      .eq('is_private', false)
      .not('reviewed_at', 'is', null)
      .order('reviewed_at', { ascending: false })
      .limit(MAX_WATERMARK_WARM_ROWS);

    if (error) {
      console.error(
        '[WATERMARK] Approved-video warm query failed:',
        error.message
      );
      return;
    }

    for (const video of videos || []) {
      if (!video?.id) continue;

      warmWatermarkForVideo(video.id).catch(error => {
        console.error(
          '[WATERMARK] Approved-video pre-warm failed:',
          video.id,
          error.message
        );
      });
    }
  } catch (error) {
    console.error(
      '[WATERMARK] Approved-video warm sweep failed:',
      error.message
    );
  }
}

function startRecoverySweeper() {
  const globalKey =
    '__bushrannVideoProcessingSweeperStarted';

  if (globalThis[globalKey]) {
    return;
  }

  globalThis[globalKey] = true;

  const firstRunTimer =
    setTimeout(() => {
      sweepProcessingVideos().catch(
        error => {
          console.error(
            '[VIDEO PROCESS] Initial recovery sweep failed:',
            error.message
          );
        }
      );
    }, 15 * 1000);

  firstRunTimer.unref?.();

  const interval =
    setInterval(() => {
      sweepProcessingVideos().catch(
        error => {
          console.error(
            '[VIDEO PROCESS] Scheduled recovery sweep failed:',
            error.message
          );
        }
      );

      sweepApprovedWatermarks().catch(
        error => {
          console.error(
            '[WATERMARK] Scheduled pre-warm sweep failed:',
            error.message
          );
        }
      );
    }, RECOVERY_INTERVAL_MS);

  interval.unref?.();

  console.log(
    '[VIDEO PROCESS] Recovery sweeper started'
  );
}

startRecoverySweeper();

module.exports = router;