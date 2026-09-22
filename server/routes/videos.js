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
const sharp = require('sharp');

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

// Bundled variable font (official Roboto release, SIL OFL — see
// assets/fonts/Roboto-OFL.txt). Referenced from a server-built SVG via a
// file:// @font-face so Node (sharp) rasterizes the @username text;
// production FFmpeg has no drawtext filter and needs no system fonts.
const WATERMARK_FONT_PATH = path.join(
  __dirname,
  '..',
  'assets',
  'fonts',
  'Roboto.ttf'
);

// file:// URL form for the SVG @font-face (forward slashes, one leading
// slash on POSIX; on Windows the drive form file:///C:/... is accepted by
// libvips/librsvg).
const WATERMARK_FONT_URL =
  'file://' + WATERMARK_FONT_PATH.replace(/\\/g, '/');

// Pixel dimensions of assets/bushrann-watermark.png (1536x1024, 3:2).
// Used to derive the scaled logo height so the text canvas below it can
// be sized before the FFmpeg run.
const WATERMARK_PNG_WIDTH = 1536;
const WATERMARK_PNG_HEIGHT = 1024;

// In-memory job dedupe: simultaneous requests for the same video share
// one FFmpeg job. Cross-instance duplicates are harmless because the
// storage key is deterministic (watermarked/v4/<videoId>.mp4).
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
  return `watermarked/v4/${videoId}.mp4`;
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

async function probeSourceVideo(filePath) {
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

  if (!Number.isFinite(duration) || duration <= 0 || duration >= 86400) {
    throw new Error(
      `Invalid video duration reported by FFprobe: ${duration}`
    );
  }

  const videoStream = (data?.streams ?? []).find(
    stream => stream.codec_type === 'video'
  );

  const width = Number(videoStream?.width);
  const height = Number(videoStream?.height);

  if (!Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(height) || height <= 0) {
    throw new Error('Source video has no valid video stream dimensions');
  }

  return { duration, width, height };
}

// Mandatory pre-upload validation: the watermarked output MUST contain a
// video stream with real dimensions. Prevents audio-only uploads.
async function assertWatermarkedOutputValid(filePath) {
  const { stdout } = await runProcess(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    filePath,
  ]);

  let data;

  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new Error('FFprobe returned invalid JSON');
  }

  const hasValidVideo = (data?.streams ?? []).some(
    stream =>
      stream.codec_type === 'video' &&
      Number(stream.width) > 0 &&
      Number(stream.height) > 0
  );

  if (!hasValidVideo) {
    throw new Error('Watermarked output has no video stream');
  }
}

// TEMPORARY diagnostic helper — logs every stream of the probed file.
async function debugProbeStreams(tag, filePath) {
  try {
    const { stdout } = await runProcess(ffprobePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const data = JSON.parse(stdout);

    const streams = (data?.streams ?? []).map(stream => ({
      codec_type: stream.codec_type,
      codec_name: stream.codec_name,
      width: stream.width ?? null,
      height: stream.height ?? null,
      duration: stream.duration ?? null,
      nb_frames: stream.nb_frames ?? null,
    }));

    let size = null;

    try {
      size = (await fs.promises.stat(filePath)).size;
    } catch (error) {
      // Keep size null when the file is absent.
    }

    console.log('[WATERMARK DEBUG]', tag, {
      filePath,
      size,
      duration: data?.format?.duration ?? null,
      streams,
    });
  } catch (error) {
    console.log('[WATERMARK DEBUG]', tag, {
      filePath,
      probeError: error?.message || String(error),
    });
  }
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

// Four-position movement cycle (20 s): bottom-right, top-left,
// bottom-left, top-right — 2.5% horizontal / 8% vertical safe margins,
// switching instantly every 5 seconds and repeating via mod(t,20).
// Shared by BOTH watermark builders so the layers can never diverge.
// NOTE: commas inside the filter expressions are escaped as "\," — ffmpeg's
// filtergraph parser requires this even when args are passed via spawn
// (no shell involved); unescaped commas break the filter description.
const WATERMARK_POS_X =
  'if(lt(mod(t\\,20)\\,5)\\,W-w-main_w*0.025\\,' +
  'if(lt(mod(t\\,20)\\,10)\\,main_w*0.025\\,' +
  'if(lt(mod(t\\,20)\\,15)\\,main_w*0.025\\,W-w-main_w*0.025)))';

const WATERMARK_POS_Y =
  'if(lt(mod(t\\,20)\\,5)\\,H-h-main_h*0.08\\,' +
  'if(lt(mod(t\\,20)\\,10)\\,main_h*0.08\\,' +
  'if(lt(mod(t\\,20)\\,15)\\,H-h-main_h*0.08\\,main_h*0.08)))';

// Maximum visible length of the "@username" text (including "@").
const USERNAME_MAX_DISPLAY_LENGTH = 30;

// Builds the single grouped watermark filter chain. The Bushrann PNG is
// scaled to 25% of the source width and, when a username image is present,
// padded onto a transparent canvas with the text PNG overlaid centered
// beneath the logo. Logo and text move as ONE unit because there is a
// single overlay of the combined [grp] stream.
function buildGroupWatermarkChain(
  watermarkWidthPx,
  logoHeightPx,
  usernameImage
) {
  if (!usernameImage) {
    return `[1:v]scale=${watermarkWidthPx}:-2[grp]`;
  }

  const gap = usernameImage.gap;
  const canvasWidth = Math.max(
    watermarkWidthPx,
    usernameImage.width + 12
  );
  const canvasHeight =
    logoHeightPx + gap + usernameImage.height;

  return (
    `[1:v]scale=${watermarkWidthPx}:-2,format=rgba,` +
    `pad=${canvasWidth}:${canvasHeight}:0:0:color=black@0[cnv];` +
    `[cnv][2:v]overlay=x=(main_w-w)/2:y=${logoHeightPx}+${gap}[grp]`
  );
}

// Single-overlay grouped watermark: no glow, no pulse, no blur, and no
// drawtext (production FFmpeg lacks it — the @username is pre-rendered to
// a transparent PNG by sharp). The whole group jumps between the four
// corners as one unit and is stationary within each 5-second phase.
function buildWatermarkFilterComplex(
  watermarkWidthPx,
  logoHeightPx,
  usernameImage
) {
  return (
    `${buildGroupWatermarkChain(watermarkWidthPx, logoHeightPx, usernameImage)};` +
    `[0:v][grp]overlay=x=${WATERMARK_POS_X}:y=${WATERMARK_POS_Y}[vout]`
  );
}

// XML-escapes the text node content as defense in depth. The sanitization
// whitelist already strips everything but [A-Za-z0-9._], so this should
// never change anything.
function escapeSvgText(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Renders the "@username" text to a small transparent PNG (white text,
// black stroke, bundled Roboto via a server-derived file:// @font-face).
// Returns { filePath, width, height, gap } or null on any failure, so the
// caller can fall back to a logo-only watermark. The SVG contains a single
// <text> element and no external references; only the font file the server
// itself points at is loaded. The PNG is written into the per-video temp
// directory and removed by the existing recursive cleanup.
async function renderUsernameImage(tempDirectory, username, logoHeightPx) {
  const text = `@${username}`;

  const tier =
    text.length <= 15
      ? 0.2
      : text.length <= 24
        ? 0.15
        : 0.11;

  const fontsize = Math.max(6, Math.round(logoHeightPx * tier));
  const gap = Math.round(fontsize * 0.35);
  const strokeWidth = Math.max(2, Math.round(fontsize * 0.09));

  const svgWidth = Math.ceil(text.length * fontsize * 0.9) + 60;
  const svgHeight = Math.ceil(fontsize * 2);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">` +
    `<defs><style>@font-face { font-family: 'WmFont'; ` +
    `src: url('${WATERMARK_FONT_URL}'); }</style></defs>` +
    `<text x="${svgWidth / 2}" y="${svgHeight / 2}" font-family="WmFont" ` +
    `font-size="${fontsize}" font-weight="bold" fill="white" ` +
    `text-anchor="middle" dominant-baseline="central" stroke="black" ` +
    `stroke-width="${strokeWidth}" paint-order="stroke" ` +
    `stroke-linejoin="round">${escapeSvgText(text)}</text></svg>`;

  try {
    const rendered = await sharp(Buffer.from(svg)).png().toBuffer();
    const trimmed = await sharp(rendered)
      .trim({ threshold: 10 })
      .png()
      .toBuffer();
    const meta = await sharp(trimmed).metadata();

    if (!meta.width || !meta.height) {
      throw new Error('trimmed username image has no dimensions');
    }

    const filePath = path.join(tempDirectory, 'username.png');
    await fs.promises.writeFile(filePath, trimmed);

    return { filePath, width: meta.width, height: meta.height, gap };
  } catch (error) {
    console.warn(
      '[WATERMARK] Username image render failed; using logo-only:',
      error?.message
    );

    return null;
  }
}

// Sanitizes a raw profiles.username for watermark display: strips control
// characters, keeps only [A-Za-z0-9._], caps the visible "@username"
// length, and returns null when nothing usable remains so the caller falls
// back to a logo-only watermark. The result can only contain filter- and
// XML-safe characters, so it can never inject filter syntax or SVG markup.
function sanitizeWatermarkUsername(rawUsername) {
  if (typeof rawUsername !== 'string') {
    return null;
  }

  const cleaned = rawUsername
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[^A-Za-z0-9._]/g, '')
    .slice(0, USERNAME_MAX_DISPLAY_LENGTH - 1);

  return cleaned.length > 0 ? cleaned : null;
}

// Authoritative owner lookup: videos.user_id -> profiles.id -> username.
async function getVideoOwnerUsername(userId) {
  if (typeof userId !== 'string' || userId.length === 0) {
    return null;
  }

  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.warn(
        '[WATERMARK] Owner profile lookup failed; using logo-only:',
        error.message
      );

      return null;
    }

    return sanitizeWatermarkUsername(profile?.username);
  } catch (error) {
    console.warn(
      '[WATERMARK] Owner profile lookup failed; using logo-only:',
      error?.message
    );

    return null;
  }
}

// Burns the Bushrann PNG watermark (plus the owner's @username image when
// available) into the video, moving between four corners every 5 seconds.
// The watermark width is computed in JS from the source video width
// (~25%, aspect preserved); the base video is never resized.
function buildWatermarkArgs(
  inputPath,
  watermarkFilePath,
  outputPath,
  watermarkWidthPx,
  logoHeightPx,
  usernameImage
) {
  const inputArgs = usernameImage
    ? ['-i', inputPath, '-i', watermarkFilePath, '-i', usernameImage.filePath]
    : ['-i', inputPath, '-i', watermarkFilePath];

  return [
    '-y',
    ...inputArgs,
    '-filter_complex',
    buildWatermarkFilterComplex(
      watermarkWidthPx,
      logoHeightPx,
      usernameImage
    ),
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
  duration,
  watermarkWidthPx,
  logoHeightPx,
  usernameImage
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

  const inputArgs = usernameImage
    ? ['-i', inputPath, '-i', watermarkFilePath, '-i', usernameImage.filePath]
    : ['-i', inputPath, '-i', watermarkFilePath];

  return [
    '-y',
    ...inputArgs,
    '-filter_complex',
    buildWatermarkFilterComplex(
      watermarkWidthPx,
      logoHeightPx,
      usernameImage
    ),
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

async function generateWatermarkedVideo(videoId, sourceUrl, username) {
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

    const sourceProbe = await probeSourceVideo(sourcePath);

    const watermarkWidthPx = Math.max(
      2,
      Math.round(sourceProbe.width * 0.25)
    );

    // Scaled logo height (matches FFmpeg scale=W:-2, which rounds the
    // height to the nearest even number).
    const logoHeightPx = Math.max(
      2,
      Math.round(
        Math.round(
          (watermarkWidthPx * WATERMARK_PNG_HEIGHT) / WATERMARK_PNG_WIDTH
        ) / 2
      ) * 2
    );

    console.log(
      '[WATERMARK] Source probe:',
      videoId,
      sourceProbe,
      `watermarkWidth=${watermarkWidthPx}px`,
      `logoHeight=${logoHeightPx}px`,
      `username=${username ? '@' + username : '(logo only)'}`
    );

    // Pre-render the owner's @username to a transparent PNG (bundled
    // Roboto). Any render failure returns null → logo-only watermark, so
    // sharing always works. The PNG lives in the per-video temp directory
    // and is removed by the existing recursive cleanup.
    const usernameImage = username
      ? await renderUsernameImage(tempDirectory, username, logoHeightPx)
      : null;

    if (username && !usernameImage) {
      console.log('[WATERMARK] Falling back to logo-only watermark:', videoId);
    }

    const watermarkArgs = buildWatermarkArgs(
      sourcePath,
      WATERMARK_PATH,
      outputPath,
      watermarkWidthPx,
      logoHeightPx,
      usernameImage
    );

    try {
      const { stdout } = await runProcess(ffmpegPath, ['-version']);

      console.log(
        '[WATERMARK DEBUG] ffmpeg version',
        JSON.stringify(stdout.split('\n').slice(0, 3))
      );
    } catch (error) {
      console.log(
        '[WATERMARK DEBUG] ffmpeg version probe failed:',
        error?.message
      );
    }

    console.log(
      '[WATERMARK DEBUG] first-pass args JSON:',
      JSON.stringify({ videoId, sourcePath, outputPath, args: watermarkArgs })
    );

    await debugProbeStreams('source before watermark', sourcePath);

    await runProcess(ffmpegPath, watermarkArgs);

    await debugProbeStreams('output after first pass', outputPath);

    let stats = await fs.promises.stat(outputPath);

    if (stats.size > MAX_UPLOAD_BYTES) {
      console.log(
        '[WATERMARK] CRF output exceeds Storage limit; compressing:',
        videoId,
        `${(stats.size / 1024 / 1024).toFixed(2)} MB`
      );

      const duration = sourceProbe.duration;

      const compressedPath = path.join(
        tempDirectory,
        'watermarked-compressed.mp4'
      );

      const fallbackArgs = buildBitrateLimitedWatermarkArgs(
        sourcePath,
        WATERMARK_PATH,
        compressedPath,
        duration,
        watermarkWidthPx,
        logoHeightPx,
        usernameImage
      );

      console.log(
        '[WATERMARK DEBUG] bitrate fallback args JSON:',
        JSON.stringify({
          videoId,
          sourcePath,
          compressedPath,
          duration,
          args: fallbackArgs,
        })
      );

      await runProcess(ffmpegPath, fallbackArgs);

      await debugProbeStreams(
        'output after bitrate fallback',
        compressedPath
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

    await debugProbeStreams('final output before upload', outputPath);

    // Mandatory: never upload an output that has no video stream.
    await assertWatermarkedOutputValid(outputPath);

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

async function getOrCreateWatermarkJob(videoId, sourceUrl, username) {
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

    return generateWatermarkedVideo(videoId, sourceUrl, username);
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
// validates it, resolves the owner's username authoritatively
// (videos.user_id -> profiles.id -> profiles.username), burns the
// Bushrann watermark PNG (plus "@username" beneath it) in with FFmpeg,
// and stores the result at the deterministic key watermarked/v4/<id>.mp4.
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
          'user_id',
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

    // Authoritative owner username (never taken from the client).
    // Falls back to a logo-only watermark when missing/invalid.
    const username = await getVideoOwnerUsername(video.user_id);

    const watermarkedUrl = await getOrCreateWatermarkJob(
      videoId,
      sourceUrl,
      username
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
