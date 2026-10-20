const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const {
  EgressClient,
  RoomServiceClient,
  EncodedFileType,
} = require('livekit-server-sdk');

const {
  ImageFileSuffix,
  ImageCodec,
} = require('@livekit/protocol');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── AUTHENTICATION ──────────────────────────────────────────────
// Every protected endpoint requires:
//   Authorization: Bearer <Supabase access token>
// The token is verified against the Supabase Auth server. The
// authenticated user ID comes ONLY from the verified token —
// request.body.userId is never used for identity or ownership, and
// request.body.isHost is never used as authorization.

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing authentication' });
    }

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user || !user.id) {
      return res
        .status(401)
        .json({ error: 'Invalid or expired authentication' });
    }

    req.authUserId = user.id;
    next();
  } catch (e) {
    return res
      .status(401)
      .json({ error: 'Invalid or expired authentication' });
  }
}

// Latest live_streams row for a room. Channel names are timestamped and
// unique per stream, but limit(1) guards against duplicates anyway.
async function findStreamByRoom(roomName) {
  const { data: rows, error } = await supabase
    .from('live_streams')
    .select('id, user_id, title, thumbnail_url, is_live, stream_notified_at, egress_started_at, public_activated_at, egress_media_started_at')
    .eq('channel_name', roomName)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw error;

  return rows && rows.length > 0 ? rows[0] : null;
}

function getEgressClient() {
  return new EgressClient(
    process.env.LIVEKIT_URL,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET
  );
}

function getRoomServiceClient() {
  return new RoomServiceClient(
    process.env.LIVEKIT_URL,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET
  );
}

// A room-composite egress that has run to completion (or was aborted /
// failed / limit-reached) can never be stopped again: LiveKit answers
// stopEgress on such an egress with HTTP 412 (Twirp failed_precondition).
// Callers must treat these statuses as "already stopped" instead of an
// error.
//
// The status VALUES are referenced NUMERICALLY on purpose. The installed
// livekit-server-sdk (v1.2.7) exposes EgressStatus only as a lazily
// initialized namespace getter, which can be undefined at require() time —
// observed on Railway as "Cannot read properties of undefined (reading
// 'EGRESS_COMPLETE')". Values below are the SDK's own proto enum:
//   3 = EGRESS_COMPLETE  4 = EGRESS_FAILED
//   5 = EGRESS_ABORTED   6 = EGRESS_LIMIT_REACHED
const EGRESS_STATUS_COMPLETE = 3;

const EGRESS_STATUS_TERMINAL = new Set([
  EGRESS_STATUS_COMPLETE,
  4, // EGRESS_FAILED
  5, // EGRESS_ABORTED
  6, // EGRESS_LIMIT_REACHED
]);

function isEgressTerminal(status) {
  return (
    typeof status === 'number' &&
    EGRESS_STATUS_TERMINAL.has(status)
  );
}

// LiveKit reports "already ended" via Twirp/axios as HTTP 412
// failed_precondition. Match on the HTTP status (and the Twirp code as a
// fallback for SDK transport changes) without swallowing unrelated errors.
function isAlreadyEndedStopError(error) {
  if (!error) return false;

  if (error.response && error.response.status === 412) {
    return true;
  }

  const message = String(error.message || '');

  return (
    message.includes('status code 412') ||
    message.includes('failed_precondition')
  );
}

// Trusted Storage locator from LiveKit's own egress record.
function egressFilenameOf(egressInfo) {
  const recording =
    egressInfo?.request?.case === 'roomComposite'
      ? egressInfo.request.value
      : egressInfo?.roomComposite;

  const requestedFilename =
    recording?.fileOutputs?.[0]?.filepath ||
    recording?.file?.filepath ||
    null;

  return (
    egressInfo?.file?.filename ||
    egressInfo?.fileResults?.find(
      result => result.filename
    )?.filename ||
    requestedFilename
  );
}

// ─── REPLAY-SYNC: SHADOW-MODE REPLAY CORRECTION ──────────────────
// The recording clock starts at LiveKit egress creation; the host timer
// clock starts only after /egress/activate resolves on the client. The
// replay therefore leads the timer by a measured per-stream head and runs
// past it by a stop tail. This block measures that head/tail per stream
// (never a fixed offset), produces a corrected CANDIDATE MP4 under a
// deterministic key, verifies it, and records it in
// livestreams.corrected_video_url with correction_status 'candidate'.
//
// SHADOW MODE IS FORCED: this code NEVER re-points livestreams.video_url
// or videos.video_url, NEVER deletes or overwrites the original
// recording, and contains no automatic promotion path.

const REPLAY_TRIM_GUARD_PRE_MS = 1000;
const REPLAY_TRIM_GUARD_POST_MS = 500;
const REPLAY_TRIM_MAX_HEAD_MS = 30000;
// A claim is stale only after 60 minutes: comfortably above the worst-case
// job budget (capped download + silencedetect 2 min + up to two 20-minute
// ffmpeg passes + probes + upload + margin). Ownership is additionally
// RENEWED at every gate (assertCorrectionOwned refreshes claimed_at), so a
// live worker never goes stale mid-job.
const CORRECTION_STALE_MS = 60 * 60 * 1000;
const CORRECTION_MAX_ATTEMPTS = 3;
const CORRECTION_JOB_TIMEOUT_MS = 20 * 60 * 1000;
// Hard total deadline for the pre-upload phase of one correction job; a
// job exceeding it aborts BEFORE upload. Worst case then completes at
// deadline + upload timeout = 55 minutes, strictly inside the 60-minute
// stale window above, so a still-running worker can never be reclaimed.
const CORRECTION_JOB_DEADLINE_MS = 45 * 60 * 1000;
// Bounded transfer windows: without these, a slow download or upload
// could carry a job past the deadline check and into the stale window.
const CORRECTION_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const CORRECTION_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Shadow correction never blocks replay publication or the recovery
// sweep: jobs run detached with bounded in-process concurrency (the
// row-lock RPC keeps cross-replica concurrency safe).
const CORRECTION_MAX_CONCURRENT = 1;
const CORRECTION_MAX_SOURCE_BYTES =
  Number(process.env.CORRECTION_MAX_SOURCE_BYTES) ||
  2 * 1024 * 1024 * 1024;
const CORRECTION_WORKER =
  `railway-${process.env.RAILWAY_REPLICA_ID || 'local'}-${process.pid}`;

// Measured per-stream trim plan. egress_media_started_at (MP4 t=0 anchor)
// and public_activated_at (timer t=0) are both written on Railway's clock,
// and clientElapsedMs is a pure client-side duration, so no clock skew
// enters the math. Returns { headMs, endMs } in MP4 time, or null when
// the data is missing or implausible (correction then stays idle).
function computeReplayTrim(streamRow, clientElapsedMs) {
  if (
    !streamRow ||
    !streamRow.egress_media_started_at ||
    !streamRow.public_activated_at ||
    typeof clientElapsedMs !== 'number' ||
    !Number.isFinite(clientElapsedMs) ||
    clientElapsedMs <= 0
  ) {
    return null;
  }

  const mediaStartMs = Date.parse(streamRow.egress_media_started_at);
  const activatedMs = Date.parse(streamRow.public_activated_at);

  if (!Number.isFinite(mediaStartMs) || !Number.isFinite(activatedMs)) {
    return null;
  }

  // Head: MP4 t=0 -> timer t=0, minus a pre-guard so speech uttered AT
  // timer 00:00 is never cut. Capped to reject implausible plans.
  const headMs = activatedMs - mediaStartMs - REPLAY_TRIM_GUARD_PRE_MS;

  // End: MP4 t=0 -> timer end, plus a post-guard so the last syllable
  // survives encode and polling jitter.
  const endMs =
    activatedMs +
    clientElapsedMs +
    REPLAY_TRIM_GUARD_POST_MS -
    mediaStartMs;

  if (
    !Number.isFinite(headMs) ||
    !Number.isFinite(endMs) ||
    headMs <= 0 ||
    headMs > REPLAY_TRIM_MAX_HEAD_MS ||
    endMs <= headMs
  ) {
    return null;
  }

  return { headMs: Math.round(headMs), endMs: Math.round(endMs) };
}

// Deterministic candidate key: retries and duplicate workers converge on
// ONE object (upsert), never one orphan per attempt.
function correctionCandidateKey(replayId) {
  return `recordings/trimmed_${replayId}.mp4`;
}

// Spawn with a hard timeout and tail-bounded output capture. Resolves
// { code, timedOut, stdout, stderr }; rejects only on spawn failure.
// On timeout the child is SIGKILLed and resolves with code null, so
// callers treat it as failure without hanging the event loop.
function runProcessBounded(cmd, args, timeoutMs) {
  const { spawn } = require('child_process');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }

    const MAX_TAIL = 64 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch (killErr) {
        // Already dead.
      }
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk.toString('utf8')).slice(-MAX_TAIL);
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_TAIL);
    });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut: false, stdout, stderr });
    });
  });
}

// ffprobe JSON: container duration plus per-stream codec/duration/start.
async function probeMediaJson(filePath) {
  const result = await runProcessBounded(
    require('ffprobe-static').path,
    [
      '-v', 'error',
      '-show_entries',
      'format=duration:stream=codec_type,duration,start_time',
      '-of', 'json',
      filePath,
    ],
    60000
  );
  if (result.timedOut || result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (parseErr) {
    return null;
  }
}

// True when the first video packet is a keyframe. A stream-copy cut can
// land off-keyframe; such a candidate renders garbled until the next
// keyframe and must fall back to re-encode.
async function firstVideoPacketIsKeyframe(filePath) {
  const result = await runProcessBounded(
    require('ffprobe-static').path,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-read_intervals', '%+#1',
      '-show_entries', 'packet=flags',
      '-of', 'json',
      filePath,
    ],
    60000
  );
  if (result.timedOut || result.code !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout);
    const flags = parsed?.packets?.[0]?.flags || '';
    return flags.startsWith('K');
  } catch (parseErr) {
    return false;
  }
}

// SUPPORTING SIGNAL ONLY: first non-silence onset within windowSec.
// Background noise can trigger early and quiet syllables can fall below
// the threshold, so the result may ONLY bias the cut EARLIER (retaining
// more head), never later. Returns ms, 0 when no silence region is
// detected (sound from the very start), or null on detection failure.
async function firstSoundMs(sourcePath, windowSec) {
  const result = await runProcessBounded(
    require('ffmpeg-static'),
    [
      '-v', 'info',
      '-t', String(windowSec),
      '-i', sourcePath,
      '-af', 'silencedetect=noise=-40dB:d=0.15',
      '-f', 'null', '-',
    ],
    120000
  );
  if (result.timedOut || result.code !== 0) return null;

  const match = /silence_end:\s*([0-9.]+)/.exec(result.stderr);
  if (!match) return 0;

  const sec = Number(match[1]);
  return Number.isFinite(sec) && sec >= 0
    ? Math.round(sec * 1000)
    : null;
}

// Verification battery. Fail-open contract: { ok: false } means the
// caller keeps the ORIGINAL replay as the only playback source.
// needsReencode permits exactly one re-encode retry.
async function verifyCorrectionCandidate(
  outPath,
  sourceDurationSec,
  targetDurationSec
) {
  const probed = await probeMediaJson(outPath);
  if (!probed || !probed.format) {
    return { ok: false, needsReencode: false };
  }

  const durationSec = Number(probed.format.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, needsReencode: false };
  }

  // Container duration must land within tolerance of the planned target.
  if (
    Number.isFinite(targetDurationSec) &&
    Math.abs(durationSec - targetDurationSec) > 1.5
  ) {
    return { ok: false, needsReencode: true };
  }

  // A "correction" that is not shorter than the source is no correction.
  if (
    Number.isFinite(sourceDurationSec) &&
    durationSec >= sourceDurationSec - 0.2
  ) {
    return { ok: false, needsReencode: false };
  }

  const streams = Array.isArray(probed.streams) ? probed.streams : [];
  const video = streams.find(s => s.codec_type === 'video');
  const audio = streams.find(s => s.codec_type === 'audio');

  // Both streams are mandatory: a muted "correction" of a talk replay is
  // a defect; keep the original instead.
  if (!video || !audio) {
    return { ok: false, needsReencode: false };
  }

  const vDur = Number(video.duration);
  const aDur = Number(audio.duration);
  if (
    Number.isFinite(vDur) &&
    Number.isFinite(aDur) &&
    Math.abs(vDur - aDur) > 0.25
  ) {
    return { ok: false, needsReencode: true };
  }

  const vStart = Number(video.start_time);
  const aStart = Number(audio.start_time);
  if (
    (Number.isFinite(vStart) && Math.abs(vStart) > 0.1) ||
    (Number.isFinite(aStart) && Math.abs(aStart) > 0.1)
  ) {
    return { ok: false, needsReencode: true };
  }

  if (!(await firstVideoPacketIsKeyframe(outPath))) {
    return { ok: false, needsReencode: true };
  }

  return { ok: true, needsReencode: false };
}

// Produce the corrected candidate: measured head/end trim, stream-copy
// first (fast, lossless), exactly one re-encode fallback when the
// verification battery demands it. Returns true on success, false on any
// failure -- the caller keeps the original replay (fail-open).
async function trimReplayFile(
  sourcePath,
  headMs,
  endMs,
  outPath,
  sourceDurationSec
) {
  const ffmpegPath = require('ffmpeg-static');

  // Silence bias: EARLIER only. When sound is detected before the planned
  // cut, the cut moves earlier (retaining more head). It NEVER moves
  // later, so a false silence reading cannot cut speech.
  const soundMs = await firstSoundMs(
    sourcePath,
    Math.ceil(headMs / 1000) + 10
  );
  let cutHeadMs = headMs;
  if (
    typeof soundMs === 'number' &&
    soundMs > 0 &&
    soundMs < cutHeadMs
  ) {
    cutHeadMs = Math.max(0, soundMs - REPLAY_TRIM_GUARD_PRE_MS);
    console.log('[REPLAY-SYNC] Silence bias moved cut earlier:', {
      plannedHeadMs: headMs,
      biasedHeadMs: cutHeadMs,
    });
  }

  const durationSec = (endMs - cutHeadMs) / 1000;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return false;

  const copyResult = await runProcessBounded(
    ffmpegPath,
    [
      '-v', 'error',
      '-ss', (cutHeadMs / 1000).toFixed(3),
      '-i', sourcePath,
      '-t', durationSec.toFixed(3),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', outPath,
    ],
    CORRECTION_JOB_TIMEOUT_MS
  );

  if (!copyResult.timedOut && copyResult.code === 0) {
    const verification = await verifyCorrectionCandidate(
      outPath,
      sourceDurationSec,
      durationSec
    );
    if (verification.ok) return true;
    if (!verification.needsReencode) return false;
    console.warn(
      '[REPLAY-SYNC] Copy-trim failed verification; one re-encode retry'
    );
  } else {
    console.warn(
      '[REPLAY-SYNC] Copy-trim ffmpeg failed:',
      copyResult.stderr.slice(-500)
    );
  }

  // Exactly one re-encode fallback.
  const reencodeResult = await runProcessBounded(
    ffmpegPath,
    [
      '-v', 'error',
      '-ss', (cutHeadMs / 1000).toFixed(3),
      '-i', sourcePath,
      '-t', durationSec.toFixed(3),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      '-y', outPath,
    ],
    CORRECTION_JOB_TIMEOUT_MS
  );

  if (reencodeResult.timedOut || reencodeResult.code !== 0) {
    console.warn(
      '[REPLAY-SYNC] Re-encode ffmpeg failed:',
      reencodeResult.stderr.slice(-500)
    );
    return false;
  }

  const verification = await verifyCorrectionCandidate(
    outPath,
    sourceDurationSec,
    durationSec
  );
  return verification.ok;
}

// Atomically claim correction rights for one replay via the hardened RPC
// (single UPDATE ... WHERE with attempts increment; row-lock atomic
// across Railway replicas). Returns { claimed, token? }.
async function claimReplayCorrection(recordId) {
  const token = require('node:crypto').randomUUID();

  const { data, error } = await supabase.rpc(
    'claim_replay_correction',
    {
      p_replay_id: recordId,
      p_token: token,
      p_worker: CORRECTION_WORKER,
      p_stale_ms: CORRECTION_STALE_MS,
      p_max_attempts: CORRECTION_MAX_ATTEMPTS,
    }
  );

  if (error) {
    console.warn(
      '[REPLAY-SYNC] Claim RPC failed:',
      error.message || error
    );
    return { claimed: false };
  }

  // The RPC returns TABLE rows: one row = claim won, zero rows = already
  // claimed, exhausted, or not eligible.
  const claimedRow = Array.isArray(data) && data.length > 0 ? data[0] : null;
  return claimedRow ? { claimed: true, token } : { claimed: false };
}

// Ownership gate between dangerous steps. Two duties in one:
//   1. RENEW the lease: token-conditional UPDATE of correction_claimed_at,
//      so a live worker's claim never crosses the stale window mid-job.
//   2. VERIFY ownership: zero rows updated means we no longer own the row.
// Throws Error with .code:
//   'ROW_GONE'       -- canonical replay deleted; caller removes exactly
//                       its own deterministic candidate and stops.
//   'LOST_OWNERSHIP' -- another worker reclaimed the lease; caller
//                       touches nothing (the new owner may have uploaded
//                       a fresh candidate under the same key).
async function assertCorrectionOwned(recordId, token) {
  const { data: renewed, error: renewError } = await supabase
    .from('livestreams')
    .update({ correction_claimed_at: new Date().toISOString() })
    .eq('id', recordId)
    .eq('correction_token', token)
    .select('id');

  if (renewError) throw renewError;

  if (Array.isArray(renewed) && renewed.length > 0) {
    return; // Ownership verified and lease renewed.
  }

  // Zero rows updated: distinguish a deleted replay from a lost lease so
  // the caller cleans up ONLY what it may safely clean up.
  const { data: row, error: lookupError } = await supabase
    .from('livestreams')
    .select('id')
    .eq('id', recordId)
    .maybeSingle();

  if (lookupError) throw lookupError;

  if (!row) {
    const err = new Error('Replay row deleted during correction');
    err.code = 'ROW_GONE';
    throw err;
  }

  const err = new Error('Correction ownership lost');
  err.code = 'LOST_OWNERSHIP';
  throw err;
}

// Best-effort removal of OUR deterministic candidate object. Only called
// on ROW_GONE (the replay id can never be re-owned afterwards).
async function removeCorrectionCandidate(replayId) {
  try {
    const { error } = await supabase.storage
      .from('livestreams')
      .remove([correctionCandidateKey(replayId)]);
    if (error) {
      console.warn(
        '[REPLAY-SYNC] Candidate removal failed:',
        error.message || error
      );
    }
  } catch (removeErr) {
    console.warn(
      '[REPLAY-SYNC] Candidate removal threw:',
      removeErr?.message || removeErr
    );
  }
}

// S3 client for the correction upload path. Same env configuration as
// videos.js getS3Client() — the watermark feature already requires these
// variables in production, and @aws-sdk/client-s3 is an existing project
// dependency (no new packages).
function getCorrectionS3Client() {
  const { S3Client } = require('@aws-sdk/client-s3');

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

// GENUINELY CANCELLABLE candidate upload: aborting the AbortController
// destroys the in-flight S3 request (unlike a Promise.race, which lets
// the request finish). We do NOT rely on abort guaranteeing server-side
// non-commit — protection comes from ordering (upload abort fires at
// <= deadline + upload timeout = 55 min, while a stale reclaim needs
// 60 min), the deterministic key with unconditional PutObject overwrite,
// and the ownership gates before pointer publication. Explicit
// ContentLength keeps the request on a fixed-length body (no chunked
// transfer encoding), which S3-compatible endpoints handle
// deterministically. The timer is always cleared on completion.
async function uploadCorrectionCandidate(key, filePath, timeoutMs) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const fs = require('fs');

  // Guarded: an unreadable or empty candidate fails here (retryable)
  // instead of uploading a bad or lengthless object.
  const stats = fs.statSync(filePath);
  if (!Number.isSafeInteger(stats.size) || stats.size <= 0) {
    throw new Error('Candidate file size unavailable');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await getCorrectionS3Client().send(
      new PutObjectCommand({
        Bucket: 'livestreams',
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentType: 'video/mp4',
        ContentLength: stats.size,
      }),
      { abortSignal: controller.signal }
    );
  } finally {
    clearTimeout(timer);
  }
}

// Token-conditional status write: only the current owner can transition
// correction_status, so a stale worker can never resurrect or downgrade
// a row it no longer owns. Returns true ONLY when exactly the owned row
// was updated; false means the write failed or ownership was already
// lost -- callers must not report success on false.
async function finishCorrection(recordId, token, fields) {
  const { data, error } = await supabase
    .from('livestreams')
    .update({
      ...fields,
      correction_claimed_at: null,
      correction_worker: null,
    })
    .eq('id', recordId)
    .eq('correction_token', token)
    .select('id');

  if (error) {
    console.warn(
      '[REPLAY-SYNC] Finish update failed:',
      error.message || error
    );
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}

// The shadow-mode correction pipeline for one published replay.
// Fail-open at every step: any failure leaves the ORIGINAL replay as the
// only playback source. Never touches livestreams.video_url,
// videos.video_url, or the original recording object.
async function maybeGenerateCorrectedReplay(recordId) {
  const { data: replay, error: loadErr } = await supabase
    .from('livestreams')
    .select(
      'id, video_url, trim_head_ms, trim_end_ms, correction_attempts'
    )
    .eq('id', recordId)
    .maybeSingle();

  if (loadErr || !replay) return;

  if (
    typeof replay.trim_head_ms !== 'number' ||
    typeof replay.trim_end_ms !== 'number' ||
    replay.trim_head_ms <= 0 ||
    replay.trim_end_ms <= replay.trim_head_ms ||
    !replay.video_url ||
    replay.video_url === 'processing' ||
    replay.video_url === 'failed'
  ) {
    return; // No usable plan or no playable source: correction stays idle.
  }

  const claim = await claimReplayCorrection(recordId);
  if (!claim.claimed) return;
  const token = claim.token;

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Readable } = require('stream');

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `bushrann-correct-${recordId}-`)
  );

  const jobStartedAt = Date.now();

  try {
    const sourcePath = path.join(tempDir, 'source.mp4');
    const outPath = path.join(tempDir, 'candidate.mp4');

    // Streaming, size-capped download of the ORIGINAL recording. The
    // source object is never modified.
    const response = await fetch(replay.video_url, {
      // Bounds the whole body stream, not just the handshake: aborting
      // mid-body destroys the stream and rejects the pipe below.
      signal: AbortSignal.timeout(CORRECTION_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `Source download failed with HTTP ${response.status}`
      );
    }

    let downloaded = 0;
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(sourcePath);
      const reader = Readable.fromWeb(response.body);
      reader.on('data', chunk => {
        downloaded += chunk.length;
        if (downloaded > CORRECTION_MAX_SOURCE_BYTES) {
          reader.destroy(
            new Error('Source exceeds CORRECTION_MAX_SOURCE_BYTES')
          );
          writeStream.destroy();
        }
      });
      reader.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      reader.pipe(writeStream);
    });

    // Probe the actual source duration so the verification battery can
    // reject any "correction" that is not genuinely shorter than the
    // original recording.
    const sourceProbe = await probeMediaJson(sourcePath);
    const sourceDurationSec = sourceProbe
      ? Number(sourceProbe?.format?.duration)
      : NaN;
    if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) {
      throw new Error('Source duration unprobeable');
    }

    const trimmed = await trimReplayFile(
      sourcePath,
      replay.trim_head_ms,
      replay.trim_end_ms,
      outPath,
      sourceDurationSec
    );
    if (!trimmed) {
      throw new Error('Trim/verification failed');
    }

    // Total job deadline: a slow-but-alive worker must never approach the
    // stale window. Exceeding the deadline aborts BEFORE upload (fail-open).
    if (Date.now() - jobStartedAt > CORRECTION_JOB_DEADLINE_MS) {
      throw new Error('Correction job deadline exceeded');
    }

    // Ownership gate 1: after the expensive work, before uploading.
    // Also renews the lease (see assertCorrectionOwned).
    await assertCorrectionOwned(recordId, token);

    // Upload the verified candidate to its deterministic key via a
    // GENUINELY CANCELLABLE S3 PutObject: on timeout the in-flight request
    // is destroyed and never commits, so an expired worker can never
    // overwrite a newer worker's candidate. PutObject overwrite gives the
    // same deterministic-key convergence as upsert.
    await uploadCorrectionCandidate(
      correctionCandidateKey(recordId),
      outPath,
      CORRECTION_UPLOAD_TIMEOUT_MS
    );

    // HEAD-verify the object actually landed before recording it.
    const { data: urlData } = supabase.storage
      .from('livestreams')
      .getPublicUrl(correctionCandidateKey(recordId));
    const candidateUrl = urlData.publicUrl;

    const head = await fetch(candidateUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(60000),
    });
    if (!head.ok) {
      throw new Error(
        `Candidate HEAD verify failed with HTTP ${head.status}`
      );
    }

    // Ownership gate 2: after upload, before recording the pointer.
    await assertCorrectionOwned(recordId, token);

    // SHADOW MODE: record the candidate pointer ONLY. video_url stays on
    // the original recording; no promotion path exists in this build.
    const recorded = await finishCorrection(recordId, token, {
      correction_status: 'candidate',
      corrected_video_url: candidateUrl,
    });

    if (recorded) {
      console.log(
        '[REPLAY-SYNC] Corrected candidate recorded (shadow):',
        recordId
      );
    } else {
      // Ownership was lost between the last gate and the finish write, or
      // the write failed. The candidate object stays at its deterministic
      // key; the current owner (or the cleanup worker) owns its fate.
      console.warn(
        '[REPLAY-SYNC] Candidate NOT recorded (ownership lost or write failed):',
        recordId
      );
    }
  } catch (correctionErr) {
    if (correctionErr?.code === 'ROW_GONE') {
      // Canonical replay deleted mid-flight: remove exactly our own
      // deterministic candidate and stop.
      await removeCorrectionCandidate(recordId);
    } else if (correctionErr?.code === 'LOST_OWNERSHIP') {
      // Another worker owns the row now: touch nothing.
      console.warn(
        '[REPLAY-SYNC] Lost ownership mid-correction:',
        recordId
      );
    } else {
      console.warn(
        '[REPLAY-SYNC] Correction failed:',
        recordId,
        correctionErr?.message || correctionErr
      );
      try {
        const { data: fresh } = await supabase
          .from('livestreams')
          .select('correction_attempts')
          .eq('id', recordId)
          .maybeSingle();

        const exhausted =
          typeof fresh?.correction_attempts === 'number' &&
          fresh.correction_attempts >= CORRECTION_MAX_ATTEMPTS;

        await finishCorrection(recordId, token, {
          correction_status: exhausted ? 'failed' : null,
        });
      } catch (finishErr) {
        console.warn(
          '[REPLAY-SYNC] Failure-path finish threw:',
          finishErr?.message || finishErr
        );
      }
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (rmErr) {
      console.warn(
        '[REPLAY-SYNC] Tempdir cleanup failed:',
        rmErr?.message || rmErr
      );
    }
  }
}

// Detached, bounded-concurrency scheduler for correction jobs. Replay
// publication and the recovery sweep must NEVER block on a correction
// (capped download + up to two 20-minute ffmpeg passes). A replay whose
// slot is unavailable simply keeps its current correction_status and is
// retried by the next sweep; per-replay duplicates are dropped; every
// job's errors are handled independently inside
// maybeGenerateCorrectedReplay, and cross-replica safety comes from the
// row-lock claim RPC.
const correctionInFlight = new Set();

function scheduleReplayCorrection(recordId) {
  if (!recordId) return;
  if (correctionInFlight.has(recordId)) return;
  if (correctionInFlight.size >= CORRECTION_MAX_CONCURRENT) return;

  correctionInFlight.add(recordId);
  maybeGenerateCorrectedReplay(recordId)
    .catch(scheduleErr => {
      // Defense in depth: maybeGenerateCorrectedReplay is designed not to
      // throw; if it ever does, never let it reach the caller's flow.
      console.warn(
        '[REPLAY-SYNC] Detached correction threw:',
        recordId,
        scheduleErr?.message || scheduleErr
      );
    })
    .finally(() => {
      correctionInFlight.delete(recordId);
    });
}

// Identify only Bushrann's MP4 livestream recordings.
// Never adopt a thumbnail or another egress job as a recording.
function isLivestreamRecordingEgress(info, streamId) {
  const recording =
    info?.request?.case === 'roomComposite'
      ? info.request.value
      : info?.roomComposite;

  if (!recording) return false;

  const outputs = [
    ...(recording.fileOutputs || []),
    ...(recording.file ? [recording.file] : []),
  ];

  return outputs.some(output => {
    const filename = output.filepath || output.filename || '';

    return (
      filename.startsWith(`recordings/${streamId}_`) &&
      filename.endsWith('.mp4')
    );
  });
}

// Identify only Bushrann's participant thumbnail egress jobs.
function isLivestreamThumbnailEgress(info, streamId) {
  if (info?.request?.case !== 'participant') return false;

  const outputs = info.request.value?.imageOutputs || [];

  return outputs.some(output => {
    const prefix = output.filenamePrefix || '';

    return prefix.startsWith(`thumbnails/${streamId}_`);
  });
}

// Start a room-composite MP4 recording for a verified live_streams row.
// The filename is unique per attempt (stream id + timestamp), so a recovered
// recording started after a reconnect NEVER overwrites an earlier segment.
async function startCompositeRecording(roomName, streamRow, requestedOrientation) {
  const requiredStorageEnv = [
    'SUPABASE_S3_KEY_ID',
    'SUPABASE_S3_SECRET',
    'SUPABASE_S3_ENDPOINT',
  ];

  const missingEnv = requiredStorageEnv.filter(
    key => !process.env[key]
  );

  if (missingEnv.length > 0) {
    throw new Error(
      'Missing Supabase S3 configuration: ' +
        missingEnv.join(', ')
    );
  }

  const diagnosticStartMs = Date.now();
  const egressClient = getEgressClient();

  const filename =
    `recordings/${streamRow.id}_${Date.now()}.mp4`;

  const fileOutput = {
    fileType: EncodedFileType.MP4,
    filepath: filename,

    output: {
      case: 's3',
      value: {
        accessKey: process.env.SUPABASE_S3_KEY_ID,
        secret: process.env.SUPABASE_S3_SECRET,
        region: process.env.SUPABASE_S3_REGION || 'us-east-1',
        endpoint: process.env.SUPABASE_S3_ENDPOINT,
        bucket: 'livestreams',
        forcePathStyle: true,
      },
    },
  };

  const replayTemplateUrl =
    process.env.BUSHRANN_REPLAY_TEMPLATE_URL?.trim();

  const recordingOrientation =
    requestedOrientation === 'landscape' ? 'landscape' : 'portrait';

  // Keep the original recorder for other hosts until rollout is enabled.
  const replayAllHostsEnabled =
    process.env.BUSHRANN_REPLAY_ALL_HOSTS_ENABLED === 'true';
  const replayTestUserId =
    process.env.BUSHRANN_REPLAY_TEST_USER_ID?.trim();
  const useReplayOrientationTemplate = Boolean(
    replayTemplateUrl &&
    /^https:\/\//i.test(replayTemplateUrl) &&
    (replayAllHostsEnabled ||
      (replayTestUserId &&
        String(streamRow.user_id) === replayTestUserId))
  );
  // Preserve the original recorder when the template or camera
  // orientation cannot be determined.
  let recordingOptions = {
    encodingOptions: {
      width: 1920,
      height: 1080,
      framerate: 30,
      videoBitrate: 4500,
    },
  };

  if (useReplayOrientationTemplate) {
    try {
      let camera = null;
      let width = 0;
      let height = 0;
      let validDimensions = false;

      for (let attempt = 0; attempt < 3; attempt++) {
        const participants = await getRoomServiceClient()
          .listParticipants(roomName);

        const host = (participants || []).find(
          p => String(p.identity) === String(streamRow.user_id)
        );

        camera = (host?.tracks || []).find(
          t => t.type === 1 && t.source === 1 && !t.muted
        );

        width = Number(camera?.width);
        height = Number(camera?.height);

        validDimensions =
          Number.isFinite(width) &&
          Number.isFinite(height) &&
          width > 0 &&
          height > 0 &&
          width !== height;

        if (validDimensions) break;
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      }

      if (camera) {
        // Use the actual host camera aspect ratio when available.
        // Fall back to existing orientation if dimensions are invalid.
        const actualOrientation =
          (requestedOrientation === 'portrait' || requestedOrientation === 'landscape')
            ? requestedOrientation
            : (validDimensions
                ? (height > width ? 'portrait' : 'landscape')
                : recordingOrientation);
        const portrait = actualOrientation === 'portrait';

        recordingOptions = {
          customBaseUrl: replayTemplateUrl,
          layout: `host:${streamRow.user_id}`,
          encodingOptions: {
            width: portrait ? 1080 : 1920,
            height: portrait ? 1920 : 1080,
            framerate: 30,
            videoBitrate: 4500,
          },
        };

        console.log(
          '[EGRESS] Host camera:',
          `${width}x${height}`,
          'RECORDING:', actualOrientation.toUpperCase()
        );
      } else {
        console.warn(
          '[EGRESS] Host camera unavailable; using original recorder'
        );
      }
    } catch (error) {
      console.warn(
        '[EGRESS] Orientation lookup failed; using original recorder:',
        error?.message || error
      );
    }
  }
  const egressRequestMs = Date.now();
  console.log('[EGRESS-TIMING] Pre-start preparation:', egressRequestMs - diagnosticStartMs, 'ms');

  const info = await egressClient.startRoomCompositeEgress(
    roomName,
    fileOutput,
    recordingOptions
  );

  console.log('[EGRESS-TIMING] LiveKit start request:', Date.now() - egressRequestMs, 'ms');
  console.log('[EGRESS-TIMING] Initial status:', info?.status,
    'startedAt:', info?.startedAt?.toString?.() ?? 'unavailable');

  if (!info?.egressId) {
    throw new Error('LiveKit returned no egressId');
  }

  console.log(
    '[EGRESS] Recording started:',
    info.egressId,
    filename
  );


  // Diagnostic only: observe LiveKit startup without blocking the stream.
  void (async () => {
    const observedAtMs = Date.now();
    const delays = [0, 1000, 2000, 3000, 5000, 8000];

    for (let i = 0; i < delays.length; i++) {
      if (i > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, delays[i] - delays[i - 1])
        );
      }

      try {
        const records = await egressClient.listEgress({
          egressId: info.egressId,
        });

        const current = records?.find(
          item => item.egressId === info.egressId
        );

        console.log('[EGRESS-STARTUP]', {
          egressId: info.egressId,
          elapsedMs: Date.now() - observedAtMs,
          status: current?.status ?? 'unavailable',
          startedAt: current?.startedAt?.toString?.() ?? 'unavailable',
        });

        if (current && current.status !== 0) break;
      } catch (error) {
        console.warn(
          '[EGRESS-STARTUP] Status lookup failed:',
          error.message
        );
      }
    }
  })().catch(error => {
    console.warn('[EGRESS-STARTUP] Diagnostic failed:', error.message);
  });

  return { egressId: info.egressId, filename };
}

// ─── STALE LIVESTREAM / ORPHANED EGRESS SWEEPER ─────────────────
//
// The host writes last_ping every 5 seconds.
//
// If the app process is killed completely, React cleanup cannot run.
// The server therefore performs a conservative independent cleanup.
//
// A stream is not considered abandoned until its heartbeat has been
// stale for three minutes. Before stopping a recording, the server
// also checks LiveKit directly to ensure the scholar is no longer
// connected.
//
// Any uncertainty fails CLOSED: the stream is preserved and retried
// later rather than risking termination of a legitimate broadcast.

const STALE_STREAM_MS = 3 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// If LiveKit never creates a queued recording object, eventually discard only
// the cleanup instruction so permanently missing files cannot block newer jobs.
const RECORDING_CLEANUP_MISSING_EXPIRY_MS =
  24 * 60 * 60 * 1000;

let staleSweepInProgress = false;

let recordingCleanupSweepInProgress = false;

async function queueRecordingCleanup(filename) {
  if (!filename || typeof filename !== 'string') {
    return false;
  }

  const { error } = await supabase
    .from('livestream_recording_cleanup')
    .upsert(
      {
        filename,
      },
      {
        onConflict: 'filename',
      }
    );

  if (error) {
    console.error(
      '[EGRESS CLEANUP] Failed to persist recording cleanup:',
      filename,
      error.message
    );

    return false;
  }

  console.log(
    '[EGRESS CLEANUP] Recording queued for persistent cleanup:',
    filename
  );

  return true;
}

async function sweepRecordingCleanupQueue() {
  if (recordingCleanupSweepInProgress) {
    return;
  }

  recordingCleanupSweepInProgress = true;

  try {
    const { data: queuedFiles, error: queueError } = await supabase
      .from('livestream_recording_cleanup')
      .select('filename, created_at')
      .order('created_at', { ascending: true })
      .limit(50);

    if (queueError) {
      console.error(
        '[EGRESS CLEANUP] Failed to load persistent cleanup queue:',
        queueError.message
      );

      return;
    }

    for (const item of queuedFiles || []) {
      const filename = item?.filename;

      if (!filename || typeof filename !== 'string') {
        continue;
      }

      const publicUrl =
        `${process.env.SUPABASE_URL}` +
        `/storage/v1/object/public/livestreams/${filename}`;

      let fileExists = false;
      let definitelyMissing = false;

      try {
        const response = await fetch(publicUrl, {
          method: 'HEAD',
        });

        fileExists = response.ok;
        definitelyMissing = response.status === 404;
      } catch (error) {
        console.warn(
          '[EGRESS CLEANUP] Storage check failed; keeping queued cleanup:',
          filename,
          error.message
        );

        continue;
      }

      // LiveKit may still be finalizing the object after stopEgress().
      // Keep the durable queue entry initially. If Storage still explicitly
      // reports 404 after 24 hours, discard only the cleanup instruction so a
      // permanently missing filename cannot occupy the oldest-50 queue forever.
      if (!fileExists) {
        const createdAtMs = Date.parse(item?.created_at);

        const isExpired =
          Number.isFinite(createdAtMs) &&
          Date.now() - createdAtMs >
            RECORDING_CLEANUP_MISSING_EXPIRY_MS;

        if (definitelyMissing && isExpired) {
          const { error: expiredDeleteError } =
            await supabase
              .from('livestream_recording_cleanup')
              .delete()
              .eq('filename', filename);

          if (expiredDeleteError) {
            console.error(
              '[EGRESS CLEANUP] Failed to remove expired missing cleanup row:',
              filename,
              expiredDeleteError.message
            );
          } else {
            console.warn(
              '[EGRESS CLEANUP] Removed expired cleanup entry for recording that never appeared:',
              filename
            );
          }
        }

        continue;
      }

      // Never delete a recording referenced by a replay.
        const { data: replayReferences, error: referenceError } =
          await supabase
            .from('livestreams')
            .select('id')
            .eq('recording_filename', filename)
            .limit(1);

        if (referenceError) {
          console.error(
            '[EGRESS CLEANUP] Replay ownership check failed; preserving recording:',
            filename,
            referenceError.message
          );
          continue;
        }

        if (replayReferences?.length > 0) {
          console.warn(
            '[EGRESS CLEANUP] Recording belongs to a replay; preserving:',
            filename
          );
          continue;
        }
      // Stage 2I: disable destructive cleanup until recovery is durable.
      // Preserve both the recording and its queued cleanup entry.
      console.warn(
        '[EGRESS CLEANUP] Recording deletion suspended for recovery safety:',
        filename
      );
      continue;

      const { error: removeError } = await supabase.storage
        .from('livestreams')
        .remove([filename]);

      if (removeError) {
        console.error(
          '[EGRESS CLEANUP] Failed to remove queued recording:',
          filename,
          removeError.message
        );

        continue;
      }

      const { error: queueDeleteError } = await supabase
        .from('livestream_recording_cleanup')
        .delete()
        .eq('filename', filename);

      if (queueDeleteError) {
        console.error(
          '[EGRESS CLEANUP] Recording removed but queue row cleanup failed:',
          filename,
          queueDeleteError.message
        );

        // Keep going. The next sweep may safely retry the exact filename.
        continue;
      }

      console.log(
        '[EGRESS CLEANUP] Removed queued orphan recording:',
        filename
      );
    }
  } catch (error) {
    console.error(
      '[EGRESS CLEANUP] Persistent cleanup sweep failed:',
      error.message
    );
  } finally {
    recordingCleanupSweepInProgress = false;
  }
}

function streamLooksStale(stream, now = Date.now()) {
  const referenceTime = stream?.last_ping || stream?.created_at;

  if (!referenceTime) {
    return false;
  }

  const timestamp = Date.parse(referenceTime);

  return (
    Number.isFinite(timestamp) &&
    now - timestamp > STALE_STREAM_MS
  );
}

async function isHostConnected(roomClient, roomName, userId) {
  if (!roomName || !userId) {
    return false;
  }

  // listRooms lets us distinguish an absent/closed room without
  // relying on listParticipants throwing for that condition.
  const rooms = await roomClient.listRooms([roomName]);

  if (!rooms || rooms.length === 0) {
    return false;
  }

  const participants = await roomClient.listParticipants(roomName);

  return (participants || []).some(
    participant => participant.identity === userId
  );
}

async function sweepStaleLivestreams() {
  // setInterval does not await async callbacks. Never allow two
  // sweeps to operate on the same stale streams concurrently.
  if (staleSweepInProgress) {
    return;
  }

  staleSweepInProgress = true;

  try {
    const staleBefore = new Date(
      Date.now() - STALE_STREAM_MS
    ).toISOString();

    // Query only rows already old enough to be candidates. created_at
    // remains a defensive fallback below if last_ping is unexpectedly null.
    const { data: candidates, error: candidateError } = await supabase
      .from('live_streams')
      .select(
        'id, user_id, channel_name, last_ping, created_at, is_live, stream_status'
      )
      .in('stream_status', ['live', 'starting'])
      .or(`last_ping.lt.${staleBefore},last_ping.is.null`);

    if (candidateError) {
      console.error(
        '[EGRESS SWEEPER] Failed to load stale-stream candidates:',
        candidateError.message
      );
      return;
    }

    const staleStreams = (candidates || []).filter(stream =>
      streamLooksStale(stream)
    );

    if (staleStreams.length === 0) {
      return;
    }

    const roomClient = getRoomServiceClient();
    const egressClient = getEgressClient();

    for (const candidate of staleStreams) {
      let cleanupLeaseToken = null;
      let cleanupLeaseTimer = null;
      let cleanupLeaseRenewal = null;
      let cleanupLeaseClosing = false;
      let cleanupLeaseLost = false;

      const renewCleanupLease = async () => {
        if (!cleanupLeaseToken || cleanupLeaseClosing || cleanupLeaseLost) return false;
        if (cleanupLeaseRenewal) return cleanupLeaseRenewal;

        cleanupLeaseRenewal = (async () => {
          try {
            const { data, error } = await supabase.rpc(
              'bushrann_renew_egress_recovery_lease',
              {
                p_stream_id: candidate.id,
                p_user_id: candidate.user_id,
                p_lease_token: cleanupLeaseToken,
                p_lease_seconds: 120,
              }
            );
            if (error || data !== true) cleanupLeaseLost = true;
            return !cleanupLeaseLost;
          } catch (error) {
            cleanupLeaseLost = true;
            console.warn('[EGRESS SWEEPER] Lease renewal failed:', error.message);
            return false;
          } finally {
            cleanupLeaseRenewal = null;
          }
        })();

        return cleanupLeaseRenewal;
      };

      try {
        // Re-read immediately. The host may have recovered between
        // the candidate query and this stream's turn in the loop.
        const {
          data: latest,
          error: latestError,
        } = await supabase
          .from('live_streams')
          .select(
            'id, user_id, channel_name, last_ping, created_at, is_live, stream_status'
          )
          .eq('id', candidate.id)
          .maybeSingle();

        if (latestError) {
          console.warn(
            '[EGRESS SWEEPER] Could not re-check stream:',
            candidate.id,
            latestError.message
          );
          continue;
        }

        if (
          !latest ||
          !((latest.is_live === true && latest.stream_status === 'live') || (latest.is_live === false && latest.stream_status === 'starting')) ||
          !streamLooksStale(latest)
        ) {
          continue;
        }

        if (!latest.channel_name || !latest.user_id) {
          console.warn(
            '[EGRESS SWEEPER] Stale stream is missing room/owner; preserving:',
            latest.id
          );
          continue;
        }

        // Exclusively claim this stale stream before touching LiveKit.
        // Recording start, ensure-active, normal stop, and stop recovery
        // cannot acquire their respective leases while this is held.
        const { data: acquiredLease, error: acquireError } =
          await supabase.rpc('bushrann_acquire_egress_recovery_lease', {
            p_stream_id: latest.id,
            p_user_id: latest.user_id,
            p_lease_seconds: 120,
          });

        if (acquireError) throw acquireError;
        if (!acquiredLease) continue;

        cleanupLeaseToken = acquiredLease;
        cleanupLeaseTimer = setInterval(() => {
          renewCleanupLease().catch(error => {
            cleanupLeaseLost = true;
            console.warn('[EGRESS SWEEPER] Lease timer failed:', error.message);
          });
        }, 30000);
        cleanupLeaseTimer.unref?.();

        // First LiveKit verification.
        //
        // If LiveKit itself cannot be checked, preserve the row.
        // We never infer "host disconnected" from an API failure.
        let hostConnected;

        try {
          hostConnected = await isHostConnected(
            roomClient,
            latest.channel_name,
            latest.user_id
          );
        } catch (participantError) {
          console.warn(
            '[EGRESS SWEEPER] LiveKit participant check failed; preserving stream:',
            latest.id,
            participantError.message
          );
          continue;
        }

        if (hostConnected) {
          continue;
        }

        // Discover active egresses using LiveKit's trusted room mapping.
        // Never use a client-provided egress/room relationship here.
        let activeEgresses;

        try {
          activeEgresses = await egressClient.listEgress({
            roomName: latest.channel_name,
            active: true,
          });
        } catch (egressListError) {
          console.warn(
            '[EGRESS SWEEPER] Active egress lookup failed; preserving stream:',
            latest.id,
            egressListError.message
          );
          continue;
        }

        if (!Array.isArray(activeEgresses)) {
          console.warn('[EGRESS SWEEPER] Invalid discovery; preserving:', latest.id);
          continue;
        }

        // Narrow the recovery race further. The host could have
        // reconnected while the egress lookup was running.
        const {
          data: finalCheck,
          error: finalCheckError,
        } = await supabase
          .from('live_streams')
          .select(
            'id, user_id, channel_name, last_ping, created_at, is_live, stream_status'
          )
          .eq('id', latest.id)
          .maybeSingle();

        if (finalCheckError) {
          console.warn(
            '[EGRESS SWEEPER] Final heartbeat check failed; preserving stream:',
            latest.id,
            finalCheckError.message
          );
          continue;
        }

        if (
          !finalCheck ||
          !((finalCheck.is_live === true && finalCheck.stream_status === 'live') || (finalCheck.is_live === false && finalCheck.stream_status === 'starting')) ||
          !streamLooksStale(finalCheck)
        ) {
          continue;
        }

        // Second LiveKit verification immediately before stopping
        // any recording.
        let finalHostConnected;

        try {
          finalHostConnected = await isHostConnected(
            roomClient,
            finalCheck.channel_name,
            finalCheck.user_id
          );
        } catch (participantError) {
          console.warn(
            '[EGRESS SWEEPER] Final LiveKit participant check failed; preserving stream:',
            finalCheck.id,
            participantError.message
          );
          continue;
        }

        if (finalHostConnected) {
          continue;
        }

        if (!(await renewCleanupLease())) {
          console.warn('[EGRESS SWEEPER] Lease lost; preserving:', finalCheck.id);
          continue;
        }

        // Stop every active egress associated with this abandoned room.
        // If ANY stop fails, preserve the live_streams row so ownership
        // information remains available and the next sweep can retry.
        let allEgressesStopped = true;
        const orphanedRecordingFilenames = new Set();

        for (const egress of activeEgresses || []) {
  const orphanedEgressId = egress?.egressId;

  if (!orphanedEgressId) {
    allEgressesStopped = false;

    console.warn(
      '[EGRESS SWEEPER] Active egress had no egressId; preserving stream:',
      finalCheck.id
    );

    continue;
  }

  // Capture the trusted Storage filename from LiveKit BEFORE stopping.
  // This abnormal/crash path intentionally does not create a replay, so
  // any resulting MP4 must be removed after LiveKit finishes uploading it.
  const orphanedFilename = isLivestreamRecordingEgress(
    egress,
    finalCheck.id
  )
    ? (
        egressFilenameOf(egress) ||
        egress.request?.value?.fileOutputs?.[0]?.filepath ||
        null
      )
    : null;

  try {
    if (!(await renewCleanupLease())) {
      allEgressesStopped = false;
      break;
    }

    // A scholar may reconnect while the sweeper processes egresses.
    // Never stop another recording after detecting that recovery.
    const hostReconnected = await isHostConnected(
      roomClient,
      finalCheck.channel_name,
      finalCheck.user_id
    );

    if (hostReconnected) {
      allEgressesStopped = false;
      console.warn(
        '[EGRESS SWEEPER] Host reconnected; aborting recording cleanup:',
        finalCheck.id
      );
      break;
    }

    if (!(await renewCleanupLease())) {
      allEgressesStopped = false;
      break;
    }

    await egressClient.stopEgress(orphanedEgressId);

    console.log(
      '[EGRESS SWEEPER] Stopped orphaned egress:',
      orphanedEgressId
    );

    if (orphanedFilename) {
      orphanedRecordingFilenames.add(orphanedFilename);
    } else {
      console.warn(
        '[EGRESS CLEANUP] Stopped orphaned egress had no trusted filename:',
        orphanedEgressId
      );
    }
  } catch (stopError) {
    allEgressesStopped = false;

    console.warn(
      '[EGRESS SWEEPER] Failed to stop orphaned egress:',
      orphanedEgressId,
      stopError.message
    );
  }
}

        if (!allEgressesStopped) {
          continue;
        }

        // Do not assume stopEgress completed for every recording merely
        // because the calls returned. Re-query active egresses. If one is
        // still active, preserve the row and retry on a future sweep.
        let remainingActiveEgresses;

        try {
          remainingActiveEgresses = await egressClient.listEgress({
            roomName: finalCheck.channel_name,
            active: true,
          });
        } catch (verifyEgressError) {
          console.warn(
            '[EGRESS SWEEPER] Could not verify egress shutdown; preserving stream:',
            finalCheck.id,
            verifyEgressError.message
          );
          continue;
        }

        if (
          !Array.isArray(remainingActiveEgresses) ||
          remainingActiveEgresses.length > 0
        ) {
          console.warn(
            '[EGRESS SWEEPER] Egress still active after stop; preserving stream:',
            finalCheck.id
          );
          continue;
        }

        // Last DB check after the potentially slow LiveKit operations.
        // If the scholar recovered and heartbeat advanced, abort deletion.
        const {
          data: deleteCheck,
          error: deleteCheckError,
        } = await supabase
          .from('live_streams')
          .select(
            'id, user_id, channel_name, last_ping, created_at, is_live, stream_status'
          )
          .eq('id', finalCheck.id)
          .maybeSingle();

        if (deleteCheckError) {
          console.warn(
            '[EGRESS SWEEPER] Pre-delete heartbeat check failed; preserving stream:',
            finalCheck.id,
            deleteCheckError.message
          );
          continue;
        }

        if (
          !deleteCheck ||
          !((deleteCheck.is_live === true && deleteCheck.stream_status === 'live') || (deleteCheck.is_live === false && deleteCheck.stream_status === 'starting')) ||
          !streamLooksStale(deleteCheck)
        ) {
          continue;
        }

        // Last LiveKit participant check. This protects the narrow window
        // between the previous check and deletion.
        let hostConnectedBeforeDelete;

        try {
          hostConnectedBeforeDelete = await isHostConnected(
            roomClient,
            deleteCheck.channel_name,
            deleteCheck.user_id
          );
        } catch (participantError) {
          console.warn(
            '[EGRESS SWEEPER] Pre-delete LiveKit check failed; preserving stream:',
            deleteCheck.id,
            participantError.message
          );
          continue;
        }

        if (hostConnectedBeforeDelete) {
          continue;
        }

        if (!(await renewCleanupLease())) {
          console.warn('[EGRESS SWEEPER] Lease expired; preserving:', deleteCheck.id);
          continue;
        }

        // Conditional delete: require the row to still be live AND its
        // last_ping to still be stale. A heartbeat written after deleteCheck
        // therefore prevents this delete even if it happens in this final gap.
        let deleteQuery = supabase
          .from('live_streams')
          .update({ is_live: false, stream_status: 'ended' })
          .eq('id', deleteCheck.id)
          .eq('stream_status', deleteCheck.stream_status)
          .eq('is_live', deleteCheck.is_live)
          .eq('egress_stop_pending', false)
          .eq('egress_recovery_lease_token', cleanupLeaseToken)
          .gt('egress_recovery_lease_until', new Date().toISOString());

        if (deleteCheck.last_ping) {
          deleteQuery = deleteQuery.lt(
            'last_ping',
            new Date(Date.now() - STALE_STREAM_MS).toISOString()
          );
        } else {
          deleteQuery = deleteQuery.is('last_ping', null);
        }

        const { data: endedRows, error: deleteError } = await deleteQuery
          .select('id');

        if (deleteError) {
          console.warn(
            '[EGRESS SWEEPER] Failed to end stale stream:',
            deleteCheck.id,
            deleteError.message
          );
          continue;
        }

        if (!endedRows?.some(row => row.id === deleteCheck.id)) {
          console.log(
            '[EGRESS SWEEPER] Stream changed before termination; preserving recordings:',
            deleteCheck.id
          );
          continue;
        }

        // Preserve abandoned scholar recordings for possible replay recovery.
        // Do not enqueue them for automatic Storage deletion.
        if (orphanedRecordingFilenames.size > 0) {
          console.warn(
            '[EGRESS SWEEPER] Preserving abandoned recordings for recovery:',
            deleteCheck.id,
            orphanedRecordingFilenames.size
          );
        }

        console.log(
          '[EGRESS SWEEPER] Marked abandoned livestream as ended:',
          deleteCheck.id
        );

      } catch (streamError) {
        console.warn(
          '[EGRESS SWEEPER] Cleanup failed for stream:',
          candidate.id,
          streamError.message
        );
      } finally {
        cleanupLeaseClosing = true;
        if (cleanupLeaseTimer) clearInterval(cleanupLeaseTimer);
        if (cleanupLeaseRenewal) await cleanupLeaseRenewal;

        if (cleanupLeaseToken) {
          try {
            const { error: releaseError } = await supabase.rpc(
              'bushrann_release_egress_recovery_lease',
              {
                p_stream_id: candidate.id,
                p_user_id: candidate.user_id,
                p_lease_token: cleanupLeaseToken,
              }
            );
            if (releaseError) {
              console.error('[EGRESS SWEEPER] Lease release failed:', releaseError.message);
            }
          } catch (releaseError) {
            console.error(
              '[EGRESS SWEEPER] Lease release threw:',
              releaseError.message
            );
          }
        }
      }
    }
  } catch (error) {
    console.error(
      '[EGRESS SWEEPER] Sweep failed:',
      error.message
    );
  } finally {
    staleSweepInProgress = false;
  }
}


let thumbnailSweepInProgress = false;

async function sweepExpiredThumbnailEgresses() {
  if (thumbnailSweepInProgress) return;
  thumbnailSweepInProgress = true;

  try {
    const egressClient = getEgressClient();
    const activeEgresses = await egressClient.listEgress({
      active: true,
    });

    for (const info of activeEgresses || []) {
      if (!info?.egressId || info?.request?.case !== 'participant') continue;

      // Only Bushrann's own thumbnail jobs.
      const outputs = info.request.value?.imageOutputs || [];
      const isThumbnail = outputs.some(output =>
        /^thumbnails\/[0-9a-f-]{36}_\d+$/i.test(
          output.filenamePrefix || ''
        )
      );

      if (!isThumbnail) continue;

      // LiveKit EgressInfo.startedAt is in nanoseconds.
      const startedAt = Number(info.startedAt);
      if (!Number.isFinite(startedAt) || startedAt <= 0) {
        console.warn(
          '[THUMBNAIL CLEANUP] Missing start time:',
          info.egressId
        );
        continue;
      }

      const ageMs = Date.now() - startedAt / 1e6;
      if (ageMs < 25000) continue;

      try {
        await egressClient.stopEgress(info.egressId);
        console.log(
          '[THUMBNAIL CLEANUP] Stopped expired job:',
          info.egressId
        );
      } catch (error) {
        if (!isAlreadyEndedStopError(error)) {
          console.warn(
            '[THUMBNAIL CLEANUP] Stop failed:',
            info.egressId,
            error.message
          );
        }
      }
    }
  } catch (error) {
    console.error(
      '[THUMBNAIL CLEANUP] Sweep failed:',
      error.message
    );
  } finally {
    thumbnailSweepInProgress = false;
  }
}

const LIVE_THUMBNAIL_ORPHAN_GRACE_MS = 10 * 60 * 1000;
let liveThumbnailOrphanSweepRunning = false;

async function sweepOrphanLiveThumbnails() {
  if (liveThumbnailOrphanSweepRunning) return;
  liveThumbnailOrphanSweepRunning = true;

  try {
    const bucket = supabase.storage.from('livestreams');
    const cutoff = Date.now() - LIVE_THUMBNAIL_ORPHAN_GRACE_MS;
    let offset = 0;
    const pageSize = 100;
    const candidates = [];

    // List only JPEGs under livestreams/thumbnails.
    // Never inspect or delete MP4 recordings.
    while (true) {
      const { data: files, error } = await bucket.list('thumbnails', {
        limit: pageSize,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });

      if (error) throw error;

      if (!files?.length) break;

      for (const file of files) {
        const match = file.name.match(
          /^([0-9a-f-]{36})_(\d+)_\d+\.jpe?g$/i
        );

        if (!match) continue;

        const createdAt = Number(match[2]);

        if (
          !Number.isSafeInteger(createdAt) ||
          createdAt > cutoff ||
          createdAt < 1600000000000
        ) {
          continue;
        }

        candidates.push({
          name: file.name,
          streamId: match[1],
        });
      }

      if (files.length < pageSize) break;
      offset += pageSize;
    }

    for (const candidate of candidates) {
      const storagePath = `thumbnails/${candidate.name}`;
      const { data: publicData } = bucket.getPublicUrl(storagePath);
      const publicUrl = publicData.publicUrl;

      // Preserve images still referenced by an active livestream.
      const { data: liveRows, error: liveError } = await supabase
        .from('live_streams')
        .select('id')
        .eq('thumbnail_url', publicUrl)
        .limit(1);

      if (liveError) throw liveError;
      if (liveRows?.length) continue;

      // Preserve any JPEG referenced by a replay.
      const { data: replayRows, error: replayError } = await supabase
        .from('livestreams')
        .select('id')
        .eq('thumbnail_url', publicUrl)
        .limit(1);

      if (replayError) throw replayError;
      if (replayRows?.length) continue;

      const { data: videoRows, error: videoError } = await supabase
        .from('videos')
        .select('id')
        .eq('thumbnail_url', publicUrl)
        .limit(1);

      if (videoError) throw videoError;
      if (videoRows?.length) continue;

      // Protect any currently active stream even if its thumbnail
      // has not yet been linked to the database.
      const { data: activeRows, error: activeError } = await supabase
        .from('live_streams')
        .select('id')
        .eq('id', candidate.streamId)
        .eq('is_live', true)
        .limit(1);

      if (activeError) throw activeError;
      if (activeRows?.length) continue;

      const { error: removeError } = await bucket.remove([storagePath]);

      if (removeError) throw removeError;

      console.log('[AUTO THUMBNAIL] Removed orphan:', storagePath);
    }
  } catch (error) {
    console.warn(
      '[AUTO THUMBNAIL] Orphan sweep failed:',
      error.message
    );
  } finally {
    liveThumbnailOrphanSweepRunning = false;
  }
}
function startLivestreamSweeper() {
  // Avoid duplicate timers if this module is accidentally initialized
  // more than once inside the same Node process.
  const globalKey = '__bushrannLivestreamSweeperStarted';

  if (globalThis[globalKey]) {
    return;
  }

  globalThis[globalKey] = true;

  // Give Railway time to finish booting before the first pass.
  const firstRunTimer = setTimeout(() => {
    sweepStaleLivestreams().catch(error => {
      console.error(
        '[EGRESS SWEEPER] Initial sweep failed:',
        error.message
      );
    });

    sweepRecordingCleanupQueue().catch(error => {
      console.error(
        '[EGRESS CLEANUP] Initial cleanup sweep failed:',
        error.message
      );
    });

    sweepOrphanLiveThumbnails().catch(error => {
      console.warn(
        '[AUTO THUMBNAIL] Scheduled orphan cleanup failed:',
        error.message
      );
    });
    sweepReplayRecovery().catch(error => {
      console.error(
        '[RECOVERY] Initial replay recovery sweep failed:',
        error.message
      );
    });
  }, 15 * 1000);

  // These timers must not be the only thing keeping Node alive.
  firstRunTimer.unref?.();

  const sweepTimer = setInterval(() => {
    sweepStaleLivestreams().catch(error => {
      console.error(
        '[EGRESS SWEEPER] Scheduled sweep failed:',
        error.message
      );
    });

    sweepRecordingCleanupQueue().catch(error => {
      console.error(
        '[EGRESS CLEANUP] Scheduled cleanup sweep failed:',
        error.message
      );
    });

    sweepOrphanLiveThumbnails().catch(error => {
      console.warn(
        '[AUTO THUMBNAIL] Scheduled orphan cleanup failed:',
        error.message
      );
    });
    sweepReplayRecovery().catch(error => {
      console.error(
        '[RECOVERY] Scheduled replay recovery sweep failed:',
        error.message
      );
    });
  }, SWEEP_INTERVAL_MS);

  sweepTimer.unref?.();

  console.log(
    '[EGRESS SWEEPER] Started — interval=%dms staleAfter=%dms',
    SWEEP_INTERVAL_MS,
    STALE_STREAM_MS
  );
}

startLivestreamSweeper();

// Clean up thumbnail jobs left behind by a Railway restart.
// Runs once per server startup, not every 60 seconds.
const thumbnailStartupCleanup = setTimeout(() => {
  sweepExpiredThumbnailEgresses().catch(error => {
    console.warn(
      '[THUMBNAIL CLEANUP] Startup cleanup failed:',
      error.message
    );
  });
}, 30000);

thumbnailStartupCleanup.unref?.();

// ─── GENERATE LIVEKIT TOKEN ──────────────────────────────────────
router.post('/token', requireAuth, async (req, res) => {
  try {
    const { roomName, isHost } = req.body;

    if (!roomName || typeof roomName !== 'string') {
      return res.status(400).json({ error: 'Missing roomName' });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      return res
        .status(500)
        .json({ error: 'LiveKit credentials not configured' });
    }

    // LiveKit identity ALWAYS comes from the verified Supabase token.
    const userId = req.authUserId;
    let canPublish = false;
    let viewerSessionId = null;

    if (isHost === true) {
      // Host intent: the server INDEPENDENTLY verifies that the
      // authenticated account is an approved scholar AND owns the
      // requested stream. The client-controlled isHost/userId values
      // play no part in this decision.
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('is_scholar')
        .eq('id', userId)
        .single();

      if (
        profileError ||
        !profile ||
        !profile.is_scholar
      ) {
        return res
          .status(403)
          .json({
            error: 'Only approved scholars can host streams',
          });
      }

      const streamRow = await findStreamByRoom(roomName);

      if (!streamRow) {
        return res.status(404).json({ error: 'Stream not found' });
      }

      if (streamRow.user_id !== userId) {
        return res
          .status(403)
          .json({ error: 'You do not own this stream' });
      }

      canPublish = true;
    } else {
      // Viewer intent: the room must correspond to an existing stream.
      // Viewers can NEVER publish, regardless of anything else sent
      // in the request body.
      const streamRow = await findStreamByRoom(roomName);

      if (!streamRow) {
        return res.status(404).json({ error: 'Stream not found' });
      }

      if (streamRow.is_live !== true) {
        return res.status(409).json({ error: 'Stream is not live yet' });
      }

      // Protect the host from same-account viewer connections.
      if (String(streamRow.user_id) === String(userId)) {
        return res.status(409).json({
          code: 'OWN_LIVESTREAM',
          error: 'You are already hosting this livestream. Use another account to watch.',
        });
      }

      // Full viewers claim one atomic session per account.
      // Previews and older app versions remain exempt.
      if (req.body.purpose === 'watch') {
        const requestedId = req.body.viewerSessionId;
        if (requestedId != null &&
            (typeof requestedId !== 'string' ||
             !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedId))) {
          return res.status(400).json({ error: 'Invalid viewer session' });
        }

        viewerSessionId = requestedId || require('node:crypto').randomUUID();
        const { data: claimed, error: leaseError } = await supabase.rpc(
          'claim_bushrann_viewer',
          { p_user_id: userId, p_session_id: viewerSessionId, p_room_name: roomName }
        );

        if (leaseError) {
          console.error('[LIVEKIT] Viewer lease error:', leaseError.message);
          return res.status(503).json({ error: 'Unable to verify viewer session' });
        }
        if (claimed !== true) {
          return res.status(409).json({
            code: 'ALREADY_WATCHING',
            error: 'This account is already watching a livestream on another device.',
          });
        }
      }
    }

    const now = Math.floor(Date.now() / 1000);

    const payload = {
      iss: apiKey,
      sub: canPublish ? userId : `viewer:${userId}:${require('node:crypto').randomUUID()}`,
      iat: now,
      exp: now + 2 * 60 * 60,
      nbf: now,
      video: {
        room: roomName,
        roomJoin: true,
        canPublish,
        canSubscribe: true,
        canPublishData: true,
      },
    };

    const token = jwt.sign(payload, apiSecret, {
      algorithm: 'HS256',
    });

    console.log(
      '[LIVEKIT] Token generated (publish=%s)',
      canPublish
    );    res.json({
      token,
      url: process.env.LIVEKIT_URL,
      roomName,
      viewerSessionId,
    });
  } catch (error) {
    console.error(
      '[LIVEKIT] Token error:',
      error.message
    );

    res
      .status(500)
      .json({ error: 'Failed to generate token' });
  }
});

// Renew or release a viewer lease. User identity always comes from requireAuth.
async function handleViewerSessionAction(req, res, action) {
  try {
    const { viewerSessionId, roomName } = req.body || {};

    if (
      typeof viewerSessionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(viewerSessionId) ||
      typeof roomName !== 'string' ||
      !roomName ||
      roomName.length > 256
    ) {
      return res.status(400).json({ error: 'Invalid viewer session' });
    }

    const rpcName = action === 'renew'
      ? 'renew_bushrann_viewer'
      : 'release_bushrann_viewer';

    const { data, error } = await supabase.rpc(rpcName, {
      p_user_id: req.authUserId,
      p_session_id: viewerSessionId,
      p_room_name: roomName,
    });

    if (error) {
      console.error('[LIVEKIT] Viewer session RPC error:', error.message);
      return res.status(503).json({
        error: 'Unable to update viewer session',
      });
    }

    if (action === 'renew') {
      if (data !== true) {
        return res.status(409).json({
          code: 'VIEWER_SESSION_EXPIRED',
          error: 'Your viewing session expired. Please rejoin.',
        });
      }
      return res.json({ active: true });
    }

    return res.json({ released: data === true });
  } catch (error) {
    console.error('[LIVEKIT] Viewer session error:', error.message);
    return res.status(500).json({
      error: 'Viewer session request failed',
    });
  }
}

router.post('/viewer-session/renew', requireAuth, (req, res) => {
  return handleViewerSessionAction(req, res, 'renew');
});

router.post('/viewer-session/release', requireAuth, (req, res) => {
  return handleViewerSessionAction(req, res, 'release');
});

// ─── RECORDING STORAGE CLEANUP ───────────────────────────────────
//
// Recordings that intentionally have no replay are persisted into
// livestream_recording_cleanup before cleanup is attempted.
//
// The queue lives in Supabase rather than process memory, so a Railway
// restart cannot forget which exact recording needs to be removed.
//
// Successful published scholar replays are never added to this queue.

async function scheduleUnreferencedRecordingCleanup(filename) {
  if (!filename || typeof filename !== 'string') {
    return;
  }

  const queued = await queueRecordingCleanup(filename);

  if (!queued) {
    console.error(
      '[EGRESS CLEANUP] CRITICAL: Could not persist orphan recording cleanup:',
      filename
    );

    return;
  }

  // Try immediately as an optimization. If LiveKit has not finished
  // uploading yet, the durable queue row remains and the scheduled
  // sweeper will retry later.
  sweepRecordingCleanupQueue().catch(error => {
    console.error(
      '[EGRESS CLEANUP] Immediate persistent cleanup attempt failed:',
      filename,
      error.message
    );
  });
}

// ─── DURABLE REPLAY RECOVERY SWEEPER ─────────────────────────────
//
// The livestreams table itself is the durable recovery source: a replay
// row with video_url='processing' and a persisted recording_filename is
// an unfinished replay, regardless of whether its in-memory
// processRecording job is still running, timed out, or died with a
// Railway restart. This sweeper resumes finalization automatically.
//
// A recording is only declared terminally failed after the bounded
// recovery window (24h, same constant as orphan-cleanup expiry) AND a
// confirmed-missing storage check. Transient storage/network errors
// never fail a replay.

const REPLAY_RECOVERY_MAX_AGE_MS =
  RECORDING_CLEANUP_MISSING_EXPIRY_MS;

let replayRecoverySweepInProgress = false;

// Restore missing replay rows from durable recovery jobs.
// The source_live_stream_id uniqueness constraint prevents duplicates.
async function restoreMissingReplayRows() {
  const { data: jobs, error: jobsError } = await supabase
    .from('livestream_replay_recovery')
    .select('*')
    .is('recovered_at', null)
    .order('created_at', { ascending: true })
    .limit(50);

  if (jobsError) {
    console.error('[RECOVERY] Job lookup failed:', jobsError.message);
    return;
  }

  for (const job of jobs || []) {
    try {
      if (!job.stream_id || !job.user_id ||
          !job.egress_id || !job.recording_filename) {
        console.warn('[RECOVERY] Incomplete job retained:', job.stream_id);
        continue;
      }

      // Resume a previously initiated stop after a Railway restart.
      // Never initiate a stop for a stream without persisted stop intent.
      const reconcileInterruptedReplayStop = async () => {
        const { data: pendingStream, error: pendingError } = await supabase
          .from('live_streams')
          .select('id, user_id, channel_name, egress_stop_pending')
          .eq('id', job.stream_id)
          .eq('user_id', job.user_id)
          .maybeSingle();

        if (pendingError) throw pendingError;
        if (!pendingStream || pendingStream.egress_stop_pending !== true) {
          return;
        }

        const { data: leaseToken, error: leaseError } = await supabase.rpc(
          'bushrann_acquire_egress_stop_recovery_lease',
          {
            p_stream_id: job.stream_id,
            p_user_id: job.user_id,
            p_lease_seconds: 120,
          }
        );

        if (leaseError) throw leaseError;
        if (!leaseToken) return;

        let recoveryLeaseRenewalTimer = null;
        let recoveryLeaseRenewalPromise = null;
        let recoveryLeaseClosing = false;
        let recoveryLeaseLost = false;

        const renewRecoveryLease = async () => {
          if (recoveryLeaseClosing || recoveryLeaseLost) return false;
          if (recoveryLeaseRenewalPromise) {
            return recoveryLeaseRenewalPromise;
          }

          recoveryLeaseRenewalPromise = (async () => {
            try {
              const { data, error } = await supabase.rpc(
                'bushrann_renew_egress_stop_lease',
                {
                  p_stream_id: job.stream_id,
                  p_user_id: job.user_id,
                  p_lease_token: leaseToken,
                  p_lease_seconds: 120,
                }
              );

              if (error || data !== true) {
                recoveryLeaseLost = true;
                return false;
              }

              return true;
            } catch (error) {
              recoveryLeaseLost = true;
              console.error(
                '[RECOVERY] Stop lease renewal failed:',
                job.stream_id,
                error.message
              );
              return false;
            } finally {
              recoveryLeaseRenewalPromise = null;
            }
          })();

          return recoveryLeaseRenewalPromise;
        };

        recoveryLeaseRenewalTimer = setInterval(() => {
          renewRecoveryLease().catch(error => {
            recoveryLeaseLost = true;
            console.error(
              '[RECOVERY] Stop lease timer failed:',
              job.stream_id,
              error.message
            );
          });
        }, 30000);

        recoveryLeaseRenewalTimer.unref?.();

        try {
          const roomName = pendingStream.channel_name;
          if (!roomName) return;

          const roomClient = getRoomServiceClient();
          const client = getEgressClient();

          if (!(await renewRecoveryLease())) {
            throw new Error('Recovery stop lease lost');
          }


          const roomEgresses = await client.listEgress({ roomName });
          if (!Array.isArray(roomEgresses)) {
            throw new Error('Stop recovery discovery unavailable');
          }

          for (const item of roomEgresses) {
            if (
              !item?.egressId ||
              item.roomName !== roomName ||
              !isLivestreamRecordingEgress(item, job.stream_id) ||
              isEgressTerminal(item.status)
            ) {
              continue;
            }

            if (!(await renewRecoveryLease())) {
              throw new Error('Recovery stop lease lost');
            }


            if (!(await renewRecoveryLease())) {
              throw new Error('Recovery stop lease lost before stopping');
            }

            try {
              await client.stopEgress(item.egressId);
            } catch (stopError) {
              if (!isAlreadyEndedStopError(stopError)) {
                throw stopError;
              }
            }

            console.log(
              '[RECOVERY] Interrupted recording stop resumed:',
              job.stream_id,
              item.egressId
            );
          }

          if (!(await renewRecoveryLease())) {
            throw new Error('Recovery lease lost before final discovery');
          }

          const finalRecoveryEgresses = await client.listEgress({
            roomName,
          });

          if (!Array.isArray(finalRecoveryEgresses)) {
            throw new Error('Final recovery discovery unavailable');
          }

          const unfinishedRecoveryEgresses =
            finalRecoveryEgresses.filter(
              (item) =>
                item?.roomName === roomName &&
                isLivestreamRecordingEgress(item, job.stream_id) &&
                (
                  !item.egressId ||
                  !isEgressTerminal(item.status)
                )
            );

          if (unfinishedRecoveryEgresses.length > 0) {
            throw new Error(
              'New or unfinished recording detected; recovery will retry'
            );
          }

          if (!(await renewRecoveryLease())) {
            throw new Error('Recovery lease lost after final discovery');
          }
        } finally {
          recoveryLeaseClosing = true;

          if (recoveryLeaseRenewalTimer) {
            clearInterval(recoveryLeaseRenewalTimer);
            recoveryLeaseRenewalTimer = null;
          }

          if (recoveryLeaseRenewalPromise) {
            await recoveryLeaseRenewalPromise;
          }

          try {
            const { error: releaseError } = await supabase.rpc(
              'bushrann_release_egress_stop_lease',
              {
                p_stream_id: job.stream_id,
                p_user_id: job.user_id,
                p_lease_token: leaseToken,
              }
            );

            if (releaseError) {
              console.error(
                '[RECOVERY] Stop recovery lease release failed:',
                releaseError.message
              );
            }
          } catch (releaseError) {
            console.error(
              '[RECOVERY] Stop recovery lease release threw:',
              releaseError?.message || releaseError
            );
          }
        }
      };
      await reconcileInterruptedReplayStop();
      // Reconstruct an unfinished pre-stop intent after Railway restarts.
      // Never publish until LiveKit confirms the complete source set.
      if (job.recording_manifest_ready !== true) {
        const client = getEgressClient();

        const originals = await client.listEgress({
          egressId: job.egress_id,
        });

        const original = (originals || []).find(
          (item) =>
            item.egressId === job.egress_id &&
            isLivestreamRecordingEgress(item, job.stream_id) &&
            egressFilenameOf(item) === job.recording_filename
        );

        if (
          !original ||
          original.status !== EGRESS_STATUS_COMPLETE ||
          !original.roomName
        ) {
          console.warn(
            '[RECOVERY] Original recording not COMPLETE:',
            job.stream_id
          );
          continue;
        }

        const roomEgresses = await client.listEgress({
          roomName: original.roomName,
        });

        const matching = (roomEgresses || []).filter(
          (item) =>
            item &&
            isLivestreamRecordingEgress(item, job.stream_id)
        );

        // A missing, incomplete, or failed source makes the
        // manifest unsafe to finalize.
        if (
          matching.length === 0 ||
          matching.some(
            (item) =>
              item.status !== EGRESS_STATUS_COMPLETE ||
              !item.egressId ||
              !egressFilenameOf(item)
          )
        ) {
          console.warn(
            '[RECOVERY] Recording segments not all COMPLETE:',
            job.stream_id
          );
          continue;
        }

        const byId = new Map();

        for (const item of matching) {
          if (byId.has(item.egressId)) {
            throw new Error('Duplicate LiveKit egress identity');
          }

          byId.set(item.egressId, {
            egressId: item.egressId,
            filename: egressFilenameOf(item),
            startedAt: String(item.startedAt || 0),
          });
        }

        const segments = [...byId.values()].sort((a, b) => {
          const x = BigInt(a.startedAt);
          const y = BigInt(b.startedAt);
          return x < y ? -1 : x > y ? 1 : 0;
        });

        if (
          !segments.some(
            (segment) =>
              segment.egressId === job.egress_id &&
              segment.filename === job.recording_filename
          )
        ) {
          console.warn(
            '[RECOVERY] Original egress absent from room manifest:',
            job.stream_id
          );
          continue;
        }

        const mergedTarget =
          segments.length > 1
            ? `recordings/merged_${job.stream_id}_${Date.now()}.mp4`
            : null;

        const { data: finalized, error: finalizeError } =
          await supabase.rpc('bushrann_recover_replay_manifest', {
            p_stream_id: job.stream_id,
            p_user_id: job.user_id,
            p_egress_id: job.egress_id,
            p_original_filename: job.recording_filename,
            p_segments: segments,
            p_merged_target: mergedTarget,
          });

        if (finalizeError) throw finalizeError;

        if (!finalized) {
          console.log(
            '[RECOVERY] Manifest recovery deferred:',
            job.stream_id
          );
          continue;
        }

        // Refresh the authoritative job before restoring its replay row.
        const { data: refreshed, error: refreshError } =
          await supabase
            .from('livestream_replay_recovery')
            .select('recording_filename, recording_manifest_ready')
            .eq('stream_id', job.stream_id)
            .eq('user_id', job.user_id)
            .single();

        if (refreshError) throw refreshError;

        if (!refreshed?.recording_manifest_ready) {
          continue;
        }

        job.recording_filename = refreshed.recording_filename;

        console.log(
          '[RECOVERY] Recording manifest reconstructed:',
          job.stream_id,
          segments.length
        );
      }

      // Never restore a replay while its LiveKit recording is active.
      const recoveryEgressClient = getEgressClient();
      const recoveryEgresses = await recoveryEgressClient.listEgress({
        egressId: job.egress_id,
      });

      const recoveryEgress = (recoveryEgresses || []).find(
        (item) =>
          item.egressId === job.egress_id &&
          isLivestreamRecordingEgress(item, job.stream_id)
      );

      if (!recoveryEgress ||
          !isEgressTerminal(recoveryEgress.status)) {
        console.warn(
          '[RECOVERY] Recording not confirmed terminal; retry later:',
          job.stream_id
        );
        continue;
      }

      const { data: existing, error: lookupError } = await supabase
        .from('livestreams')
        .select('id, recording_filename')
        .eq('source_live_stream_id', job.stream_id)
        .maybeSingle();

      if (lookupError) throw lookupError;

      if (!existing) {
        const { error: insertError } = await supabase
          .from('livestreams')
          .insert({
            user_id: job.user_id,
            source_live_stream_id: job.stream_id,
            // REPLAY SYNC: durable recovery metadata
            egress_started_at: job.egress_started_at ?? null,
            public_activated_at: job.public_activated_at ?? null,
            trim_head_ms: job.trim_head_ms ?? null,
            trim_end_ms: job.trim_end_ms ?? null,
            video_url: 'processing',
            recording_filename: job.recording_filename,
            thumbnail_url: job.thumbnail_url || null,
            title: job.replay_title || 'Live Stream',
            is_public: true,
          });

        if (insertError && insertError.code !== '23505') {
          throw insertError;
        }
      } else if (
        existing.recording_filename !== job.recording_filename
      ) {
        console.error(
          '[RECOVERY] Filename conflict; retaining job:',
          job.stream_id
        );
        continue;
      }

      // A durable replay and completed recordings must not leave the
      // original host marked LIVE after its LiveKit room has closed.
      const { data: recoveryStream, error: streamStateError } =
        await supabase
          .from('live_streams')
          .select('id, user_id, channel_name, is_live, egress_stop_pending')
          .eq('id', job.stream_id)
          .eq('user_id', job.user_id)
          .maybeSingle();

      if (streamStateError) throw streamStateError;

      if (recoveryStream?.is_live === true) {
        if (
          recoveryStream.egress_stop_pending !== true ||
          !recoveryStream.channel_name
        ) {
          console.warn('[RECOVERY] Live stream not safe to finalize:', job.stream_id);
          continue;
        }

        const roomService = getRoomServiceClient();
        const roomName = recoveryStream.channel_name;

        // Fail closed if the room is active or room discovery fails.
        const rooms = await roomService.listRooms([roomName]);
        if (!Array.isArray(rooms) || rooms.length !== 0) {
          console.log('[RECOVERY] Room still present; retry later:', job.stream_id);
          continue;
        }

        const { data: recoveryStopToken, error: acquireStopError } =
          await supabase.rpc('bushrann_acquire_egress_stop_recovery_lease', {
            p_stream_id: job.stream_id,
            p_user_id: job.user_id,
            p_lease_seconds: 120,
          });

        if (acquireStopError) throw acquireStopError;
        if (!recoveryStopToken) continue;

        let recoveryEnded = false;

        try {
          // Check again after acquiring exclusive ownership.
          const finalRooms = await roomService.listRooms([roomName]);
          if (!Array.isArray(finalRooms) || finalRooms.length !== 0) {
            throw new Error('LiveKit room reappeared during finalization');
          }

          const completed = await getEgressClient().listEgress({ roomName });
          if (!Array.isArray(completed)) {
            throw new Error('Recovery recording discovery unavailable');
          }

          const sources = completed.filter(
            item =>
              item?.egressId &&
              item.roomName === roomName &&
              isLivestreamRecordingEgress(item, job.stream_id)
          );

          if (
            sources.length === 0 ||
            sources.some(item =>
              Number(item.status) !== Number(EGRESS_STATUS_COMPLETE) ||
              !egressFilenameOf(item)
            )
          ) {
            throw new Error('Recovery recording is not fully COMPLETE');
          }

          const { data: renewed, error: renewError } =
            await supabase.rpc('bushrann_renew_egress_stop_lease', {
              p_stream_id: job.stream_id,
              p_user_id: job.user_id,
              p_lease_token: recoveryStopToken,
              p_lease_seconds: 120,
            });

          if (renewError || renewed !== true) {
            throw new Error('Recovery finalization lost stop lease');
          }

          const { data: ended, error: endError } = await supabase
            .from('live_streams')
            .update({
              is_live: false,
              stream_status: 'ended',
              egress_stop_pending: false,
              ended_at: new Date().toISOString(),
              egress_stop_lease_token: null,
              egress_stop_lease_until: null,
            })
            .eq('id', job.stream_id)
            .eq('user_id', job.user_id)
            .eq('is_live', true)
            .eq('egress_stop_pending', true)
            .eq('egress_stop_lease_token', recoveryStopToken)
            .gt('egress_stop_lease_until', new Date().toISOString())
            .select('id')
            .maybeSingle();

          if (endError) throw endError;
          if (!ended) {
            throw new Error('Recovery stream state changed; retry later');
          }

          recoveryEnded = true;
          console.log('[RECOVERY] Stale livestream finalized:', job.stream_id);
        } finally {
          if (!recoveryEnded) {
            const { error: releaseError } = await supabase.rpc(
              'bushrann_release_egress_stop_lease',
              {
                p_stream_id: job.stream_id,
                p_user_id: job.user_id,
                p_lease_token: recoveryStopToken,
              }
            );
            if (releaseError) {
              console.error(
                '[RECOVERY] Finalization lease release failed:',
                releaseError.message
              );
            }
          }
        }
      }
      // Mark recovered only after the replay row exists.
      const { data: verified, error: verifyError } = await supabase
        .from('livestreams')
        .select('id, recording_filename')
        .eq('source_live_stream_id', job.stream_id)
        .maybeSingle();

      if (verifyError) throw verifyError;

      if (!verified ||
          verified.recording_filename !== job.recording_filename) {
        continue;
      }

      const { error: markError } = await supabase
        .from('livestream_replay_recovery')
        .update({ recovered_at: new Date().toISOString() })
        .eq('stream_id', job.stream_id)
        .is('recovered_at', null);

      if (markError) throw markError;

      console.log('[RECOVERY] Replay row secured:', job.stream_id);
    } catch (error) {
      console.error(
        '[RECOVERY] Job retry failed:',
        job.stream_id,
        error.message
      );
    }
  }
}

async function sweepReplayRecovery() {
  if (replayRecoverySweepInProgress) {
    return;
  }

  replayRecoverySweepInProgress = true;

  try {
    await restoreMissingReplayRows();

    const { data: candidates, error } =
      await supabase
        .from('livestreams')
        .select(
          'id, recording_filename, created_at'
        )
        .eq('video_url', 'processing')
        .not('recording_filename', 'is', null)
        .order('created_at', { ascending: true })
        .limit(50);

    if (error) {
      console.error(
        '[RECOVERY] Failed to load pending replay rows:',
        error.message
      );

      return;
    }

    for (const candidate of candidates || []) {
      try {
      const filename = candidate?.recording_filename;

      if (!filename || typeof filename !== 'string') {
        continue;
      }

      const publicUrl =
        `${process.env.SUPABASE_URL}` +
        `/storage/v1/object/public/livestreams/${filename}`;

      let fileExists = false;

      try {
        const response = await fetch(publicUrl, {
          method: 'HEAD',
        });

        fileExists = response.ok;
      } catch (headError) {
        // Transient network/storage error: never fail, never finalize;
        // retry on a later sweep.
        console.warn(
          '[RECOVERY] Storage check failed; keeping replay pending:',
          candidate.id,
          headError.message
        );

        continue;
      }

      if (fileExists) {
        console.log(
          '[RECOVERY] Late recording found; finalizing replay:',
          candidate.id,
          filename
        );

        // Shared finalization is idempotent: the atomic conditional
        // publish guarantees a single winner even if processRecording
        // is concurrently finalizing the same replay.
        await finalizeReplay(
          candidate.id,
          filename,
          `recovery-${candidate.id}`
        );

        continue;
      }

      // Merged multi-segment replays: the file is produced by a background
      // merge that may have died with a Railway restart. The row IS the
      // durable job — rediscover the segments from LiveKit and rebuild
      // under this row's exact merged filename. The row stays 'processing'
      // while rebuilding is impossible; the bounded failure window below
      // still applies afterwards.
      if (filename.startsWith('recordings/merged_')) {
        const rebuilt = await rebuildMergedReplay(
          candidate
        );

        if (rebuilt) {
          console.log(
            '[RECOVERY] Merged replay rebuilt; finalizing:',
            candidate.id,
            filename
          );

          await finalizeReplay(
            candidate.id,
            filename,
            `recovery-${candidate.id}`
          );
        }

        continue;
      }

      // Confirmed missing. Only inside the bounded recovery window the
      // row simply stays pending; past it, declare terminal failure.
      const createdAtMs = Date.parse(
        candidate?.created_at
      );

      const isExpired =
        Number.isFinite(createdAtMs) &&
        Date.now() - createdAtMs >
          REPLAY_RECOVERY_MAX_AGE_MS;

      if (!isExpired) {
        continue;
      }

      // Final confirmed-missing check happened above (fileExists is
      // false and the HEAD succeeded). Atomically transition
      // processing → failed so a concurrent finalizer that already
      // published can never be overwritten.
      const {
        data: failedReplay,
        error: failError,
      } = await supabase
        .from('livestreams')
        .update({ video_url: 'failed' })
        .eq('id', candidate.id)
        .eq('video_url', 'processing')
        .select('id')
        .maybeSingle();

      if (failError) {
        console.error(
          '[RECOVERY] Failed to mark replay as failed:',
          candidate.id,
          failError.message
        );

        continue;
      }

      if (failedReplay) {
        console.warn(
          '[RECOVERY] Recording missing after recovery window; replay marked failed (recording retained for manual recovery):',
          candidate.id,
          filename
        );

        // Deliberately NOT queued for orphan cleanup: the MP4 may still
        // materialize, and the replay row keeps recording_filename so the
        // recording can be recovered manually. Only genuinely unreferenced
        // recordings (no replay row) enter the cleanup queue.
      }
      } catch (candidateError) {
        console.error(
          '[RECOVERY] Candidate processing failed; retry later:',
          candidate?.id,
          candidateError?.message || candidateError
        );
      }
    }

    // REPLAY-SYNC: correction sweep. Picks up replays that published
    // BEFORE this build shipped (no post-publish hook ran), crashed
    // mid-correction (stale 'correcting' lease), or failed retryably.
    // Sequential, bounded to 10 per sweep, and each candidate claim is
    // row-lock atomic, so overlapping sweeps across replicas are safe.
    try {
      const staleBefore = new Date(
        Date.now() - CORRECTION_STALE_MS
      ).toISOString();

      const { data: correctionRows, error: correctionQueryError } =
        await supabase
          .from('livestreams')
          .select('id')
          .neq('video_url', 'processing')
          .neq('video_url', 'failed')
          .not('trim_head_ms', 'is', null)
          .not('trim_end_ms', 'is', null)
          .lt('correction_attempts', CORRECTION_MAX_ATTEMPTS)
          .or(
            `correction_status.is.null,` +
            `and(correction_status.eq.correcting,` +
            `correction_claimed_at.lt.${staleBefore})`
          )
          .limit(10);

      if (correctionQueryError) {
        console.error(
          '[REPLAY-SYNC] Correction sweep query failed:',
          correctionQueryError.message || correctionQueryError
        );
      } else {
        for (const row of correctionRows || []) {
          // Detached with bounded concurrency: the recovery sweep never
          // blocks on a correction job. Replays that cannot get a slot
          // keep their status and are retried by the next sweep.
          scheduleReplayCorrection(row.id);
        }
      }
    } catch (correctionSweepOuter) {
      console.error(
        '[REPLAY-SYNC] Correction sweep failed:',
        correctionSweepOuter?.message || correctionSweepOuter
      );
    }
  } finally {
    replayRecoverySweepInProgress = false;
  }
}

const thumbnailStartLocks = new Set();

function needsLiveThumbnail(streamRow) {
  return (
    streamRow?.is_live === true &&
    !String(streamRow.thumbnail_url || '').includes('/livestreams/thumbnails/')
  );
}

async function captureAutomaticLiveThumbnail(roomName, streamRow) {
  if (!needsLiveThumbnail(streamRow)) return;

  const streamId = streamRow.id;
  if (thumbnailStartLocks.has(roomName)) return;

  thumbnailStartLocks.add(roomName);

  let egressId = null;
  let prefix = null;

  let egressClient;

  try {
    egressClient = getEgressClient();

    const latest = await findStreamByRoom(roomName);
    if (!latest || latest.id !== streamId || !needsLiveThumbnail(latest)) {
      return;
    }

    const existingFiles = await supabase.storage
      .from('livestreams')
      .list('thumbnails', {
        limit: 100,
        search: `${streamId}_`,
      });

    if (existingFiles.error) throw existingFiles.error;

    let filename = (existingFiles.data || [])
      .filter(file =>
        file.name.startsWith(`${streamId}_`) &&
        /\.jpe?g$/i.test(file.name)
      )
      .sort((a, b) => a.name.localeCompare(b.name))[0]?.name;

    if (!filename) {
      const activeEgresses = await egressClient.listEgress({
        roomName,
        active: true,
      });

      if ((activeEgresses || []).some(info =>
        isLivestreamThumbnailEgress(info, streamId) &&
        !isEgressTerminal(info.status)
      )) {
        return;
      }

      const participants = await getRoomServiceClient()
        .listParticipants(roomName);

      const host = (participants || []).find(
        participant => participant.identity === streamRow.user_id
      );

      const cameraAvailable = (host?.tracks || []).some(
        track => track.type === 1 &&
          track.source === 1 &&
          !track.muted
      );

      console.log('[AUTO THUMBNAIL] Camera check:', {
        roomName,
        streamId,
        hostFound: !!host,
        tracks: host?.tracks?.map(track => ({
          type: track.type,
          source: track.source,
          muted: track.muted,
        })) || [],
        cameraAvailable,
      });

      if (!cameraAvailable) return;

      prefix = `thumbnails/${streamId}_${Date.now()}`;

      const info = await egressClient.startParticipantEgress(
        roomName,
        streamRow.user_id,
        {
          images: {
            captureInterval: 10,
            width: 720,
            height: 1280,
            filenamePrefix: prefix,
            filenameSuffix: ImageFileSuffix.IMAGE_SUFFIX_INDEX,
            imageCodec: ImageCodec.IC_JPEG,
            disableManifest: true,
            output: {
              case: 's3',
              value: {
                accessKey: process.env.SUPABASE_S3_KEY_ID,
                secret: process.env.SUPABASE_S3_SECRET,
                region: process.env.SUPABASE_S3_REGION || 'us-east-1',
                endpoint: process.env.SUPABASE_S3_ENDPOINT,
                bucket: 'livestreams',
                forcePathStyle: true,
              },
            },
          },
        }
      );

      if (!info?.egressId) {
        throw new Error('No thumbnail egressId returned');
      }

      egressId = info.egressId;
      const prefixName = prefix.split('/').pop();

      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000));

        const result = await supabase.storage
          .from('livestreams')
          .list('thumbnails', {
            limit: 100,
            search: prefixName,
          });

        if (result.error) throw result.error;

        filename = (result.data || []).find(file =>
          file.name.startsWith(prefixName) &&
          /\.jpe?g$/i.test(file.name)
        )?.name;

        if (filename) break;
      }
    }

    if (!filename) {
      console.warn('[AUTO THUMBNAIL] No JPEG captured:', streamId);
      return;
    }

    const storagePath = `thumbnails/${filename}`;
    const { data: urlData } = supabase.storage
      .from('livestreams')
      .getPublicUrl(storagePath);

    let updateQuery = supabase
      .from('live_streams')
      .update({ thumbnail_url: urlData.publicUrl })
      .eq('id', streamId)
      .eq('is_live', true);

    updateQuery = latest.thumbnail_url == null
      ? updateQuery.is('thumbnail_url', null)
      : updateQuery.eq('thumbnail_url', latest.thumbnail_url);

    const { data: updated, error: updateError } =
      await updateQuery.select('id');

    if (updateError) throw updateError;

    if (!updated?.length) {
      const { data: current } = await supabase
        .from('live_streams')
        .select('thumbnail_url')
        .eq('id', streamId)
        .maybeSingle();

      if (current?.thumbnail_url !== urlData.publicUrl) {
        const { error: removeError } = await supabase.storage
          .from('livestreams')
          .remove([storagePath]);

        if (removeError) {
          console.warn('[AUTO THUMBNAIL] Cleanup failed:', removeError.message);
        }
      }
      return;
    }

    console.log('[AUTO THUMBNAIL] Saved:', streamId, storagePath);
  } catch (error) {
    console.warn('[AUTO THUMBNAIL] Failed:', error.message);
  } finally {
    if (egressId) {
      try {
        await egressClient.stopEgress(egressId);
      } catch (error) {
        if (!isAlreadyEndedStopError(error)) {
          console.warn('[AUTO THUMBNAIL] Stop failed:', error.message);
        }
      }
    }

    // AUTO THUMBNAIL ORPHAN CLEANUP V2
    if (prefix) {
      try {
        const prefixName = prefix.split('/').pop();
        const { data: files, error: listError } = await supabase.storage
          .from('livestreams')
          .list('thumbnails', { limit: 100, search: prefixName });

        if (listError) throw listError;

        const { data: row, error: rowError } = await supabase
          .from('live_streams')
          .select('thumbnail_url')
          .eq('id', streamId)
          .maybeSingle();

        if (rowError) throw rowError;

        for (const file of files || []) {
          if (!file.name.startsWith(prefixName) || !/\.jpe?g$/i.test(file.name)) {
            continue;
          }

          const storagePath = `thumbnails/${file.name}`;
          const { data: publicData } = supabase.storage
            .from('livestreams')
            .getPublicUrl(storagePath);

          if (row?.thumbnail_url !== publicData.publicUrl) {
            const { error: removeError } = await supabase.storage
              .from('livestreams')
              .remove([storagePath]);

            if (removeError) throw removeError;
          }
        }
      } catch (cleanupError) {
        console.warn('[AUTO THUMBNAIL] Orphan cleanup failed:', cleanupError.message);
      }
    }

    thumbnailStartLocks.delete(roomName);
  }
}
// TEST ONLY: Capture a scholar's livestream frame.
// Does not modify the MP4 recording or replay.
router.post('/egress/thumbnail-test', requireAuth, async (req, res) => {
  try {
    const { roomName } = req.body || {};

    if (typeof roomName !== 'string' || !roomName.trim()) {
      return res.status(400).json({ error: 'Missing roomName' });
    }

    const streamRow = await findStreamByRoom(roomName);

    if (!streamRow) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (streamRow.user_id !== req.authUserId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (streamRow.is_live !== true) {
      return res.status(409).json({
        error: 'Livestream is not active',
      });
    }

    const requiredEnv = [
      'SUPABASE_S3_KEY_ID',
      'SUPABASE_S3_SECRET',
      'SUPABASE_S3_ENDPOINT',
    ];

    if (requiredEnv.some(key => !process.env[key])) {
      return res.status(500).json({
        error: 'Thumbnail storage is not configured',
      });
    }

    // Confirm the scholar is actually connected.
    const participants = await getRoomServiceClient()
      .listParticipants(roomName);

    const hostConnected = participants.some(
      participant => participant.identity === streamRow.user_id
    );

    if (!hostConnected) {
      return res.status(409).json({
        error: 'Scholar is not connected',
      });
    }

    const host = participants.find(
      participant => participant.identity === streamRow.user_id
    );

    const hasCameraVideo = (host?.tracks || []).some(
      track => track.type === 1 &&
        track.source === 1 &&
        !track.muted
    );

    if (!hasCameraVideo) {
      return res.status(409).json({
        error: 'Scholar camera video is not available',
      });
    }

    const egressClient = getEgressClient();

    if (thumbnailStartLocks.has(roomName)) {
      return res.status(409).json({
        error: 'Thumbnail capture request already in progress',
      });
    }

    thumbnailStartLocks.add(roomName);
    let info;
    let thumbnailPrefix;

    try {
    // Prevent duplicate thumbnail capture jobs for this livestream.
    const activeEgresses = await egressClient.listEgress({
      roomName,
      active: true,
    });

    const existingThumbnail = (activeEgresses || []).find(
      info =>
        info?.egressId &&
        isLivestreamThumbnailEgress(info, streamRow.id) &&
        !isEgressTerminal(info.status)
    );

    if (existingThumbnail) {

      return res.status(409).json({
        error: 'Thumbnail capture already in progress',
      });
    }

    thumbnailPrefix = `thumbnails/${streamRow.id}_${Date.now()}`;

      info = await egressClient.startParticipantEgress(
        roomName,
        streamRow.user_id,
        {
          images: {
            captureInterval: 10,
            width: 720,
            height: 1280,
            filenamePrefix: thumbnailPrefix,
            filenameSuffix: ImageFileSuffix.IMAGE_SUFFIX_INDEX,
            imageCodec: ImageCodec.IC_JPEG,
            disableManifest: true,
            output: {
              case: 's3',
              value: {
                accessKey: process.env.SUPABASE_S3_KEY_ID,
                secret: process.env.SUPABASE_S3_SECRET,
                region: process.env.SUPABASE_S3_REGION || 'us-east-1',
                endpoint: process.env.SUPABASE_S3_ENDPOINT,
                bucket: 'livestreams',
                forcePathStyle: true,
              },
            },
          },
        }
      );

    } finally {
      thumbnailStartLocks.delete(roomName);
    }

    if (!info?.egressId) {
      console.error('[THUMBNAIL TEST] Missing egressId:', {
        responsePresent: !!info,
        responseType: typeof info,
        responseKeys: info ? Object.keys(info) : [],
        status: info?.status,
        error: info?.error,
      });

      throw new Error('LiveKit returned no thumbnail egressId');
    }

    // Test-only: stop after first image, with a 25-second safety limit.
    const thumbnailEgressId = info.egressId;

    let finished = false;
    let checking = false;

    const stopThumbnail = async (reason) => {
      if (finished) return;
      finished = true;

      clearInterval(imageCheckTimer);
      clearTimeout(stopTimer);

      try {
        await egressClient.stopEgress(thumbnailEgressId);
        console.log('[THUMBNAIL TEST] Stopped:', reason);
      } catch (error) {
        if (!isAlreadyEndedStopError(error)) {
          console.error(
            '[THUMBNAIL TEST] Stop failed:',
            error?.message || error
          );
        }
      }
    };

    const imageCheckTimer = setInterval(async () => {
      if (finished || checking) return;
      checking = true;

      try {
        const results = await egressClient.listEgress({
          egressId: thumbnailEgressId,
        });

        if (finished) return;

        const current = results?.[0];
        if (!current) return;

        console.log('[THUMBNAIL DIAG]', {
          egressId: thumbnailEgressId,
          status: String(current.status),
          imageResults: (current.imageResults || []).map(result => ({
            imageCount: String(result.imageCount ?? 0),
            filenamePrefix: result.filenamePrefix,
          })),
        });

        const prefixFilename = thumbnailPrefix.split('/').pop();

        const { data: uploadedImages, error: storageError } =
          await supabase.storage
            .from('livestreams')
            .list('thumbnails', {
              limit: 1,
              search: prefixFilename,
            });

        if (storageError) {
          throw storageError;
        }

        const imageCount = (uploadedImages || []).filter(file =>
          file.name.startsWith(prefixFilename) &&
          /\.jpe?g$/i.test(file.name)
        ).length;

        if (isEgressTerminal(current.status)) {
          finished = true;
          clearInterval(imageCheckTimer);
          clearTimeout(stopTimer);
          console.log('[THUMBNAIL TEST] Egress already ended:', imageCount);
        } else if (imageCount > 0) {
          await stopThumbnail('first image captured');
        }
      } catch (error) {
        console.warn('[THUMBNAIL TEST] Image check failed:', error.message);
      } finally {
        checking = false;
      }
    }, 2000);

    imageCheckTimer.unref?.();

    const stopTimer = setTimeout(() => {
      stopThumbnail('25-second safety timeout').catch(console.error);
    }, 25000);

    stopTimer.unref?.();

    return res.json({
      status: 'started',
      egressId: info.egressId,
    });
  } catch (error) {
    console.error(
      '[THUMBNAIL TEST] Error:',
      error?.response?.data || error?.message || error
    );

    return res.status(500).json({
      error: 'Thumbnail test failed',
    });
  }
});


// ─── START EGRESS RECORDING ──────────────────────────────────────
router.post('/stream-active', requireAuth, async (req, res) => {
  try {
    const { roomName } = req.body || {};

    if (!roomName || typeof roomName !== 'string') {
      return res.status(400).json({ error: 'Missing roomName' });
    }

    const streamRow = await findStreamByRoom(roomName);

    if (!streamRow) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (streamRow.user_id !== req.authUserId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (streamRow.stream_notified_at) {
      return res
        .status(409)
        .json({ error: 'Already notified' });
    }

    // Require the host's unmuted camera track to be present in the room
    // before notifying followers, so a host stuck on the preview screen
    // never triggers a notification.
    const participants = await getRoomServiceClient().listParticipants(
      roomName
    );

    const host = (participants || []).find(
      p => String(p.identity) === String(streamRow.user_id)
    );

    const hasCamera = (host?.tracks || []).some(
      t => t.type === 1 && t.source === 1 && !t.muted
    );

    if (!hasCamera) {
      return res
        .status(503)
        .json({ retryable: true, error: 'Host camera not live yet' });
    }

    const { data: claimed, error: claimError } = await supabase.rpc(
      'claim_live_notification',
      { p_stream_id: streamRow.id }
    );

    // The RPC may not exist yet if the migration has not been applied.
    if (claimError) {
      console.error(
        '[NOTIFY] claim_live_notification RPC failed:',
        claimError.message
      );

      return res
        .status(503)
        .json({ retryable: true, error: 'Notification infra unavailable' });
    }

    if (claimed !== true) {
      return res
        .status(409)
        .json({ error: 'Already notified' });
    }

    return res.json({ notified: true });
  } catch (error) {
    console.error(
      '[NOTIFY] stream-active error:',
      error?.message || error
    );

    return res
      .status(500)
      .json({ error: 'Failed to process stream-active' });
  }
});

router.post('/egress/start', requireAuth, async (req, res) => {
  let leaseToken = null;
  let leaseStreamId = null;
  let renewalTimer = null;
  let renewalPromise = null;
  let leaseClosing = false;
  let leaseLost = false;

  const renewLease = async () => {
    if (leaseClosing || leaseLost || !leaseToken) return false;
    if (renewalPromise) return renewalPromise;

    renewalPromise = (async () => {
      try {
        const { data, error } = await supabase.rpc(
          'bushrann_renew_egress_recovery_lease',
          {
            p_stream_id: leaseStreamId,
            p_user_id: req.authUserId,
            p_lease_token: leaseToken,
            p_lease_seconds: 120,
          }
        );

        if (error || data !== true) {
          leaseLost = true;
          return false;
        }

        return true;
      } catch (error) {
        leaseLost = true;
        console.error('[EGRESS] Start lease renewal failed:', error?.message);
        return false;
      } finally {
        renewalPromise = null;
      }
    })();

    return renewalPromise;
  };

  try {
    const { roomName } = req.body || {};
    const startPerfT0 = Date.now();
    let startPerfLastMs = startPerfT0;
    const markStartPerf = stage => {
      const now = Date.now();
      console.log('[EGRESS-START-PERF]', stage, {
        stepMs: now - startPerfLastMs,
        totalMs: now - startPerfT0,
      });
      startPerfLastMs = now;
    };

    if (!roomName || typeof roomName !== 'string') {
      return res.status(400).json({ error: 'Missing roomName' });
    }

    const streamRow = await findStreamByRoom(roomName);
    markStartPerf('stream_lookup');

    if (!streamRow) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (streamRow.user_id !== req.authUserId) {
      return res.status(403).json({ error: 'Not authorized to record this stream' });
    }

    const { data: acquired, error: acquireError } = await supabase.rpc(
      'bushrann_acquire_egress_recovery_lease',
      {
        p_stream_id: streamRow.id,
        p_user_id: req.authUserId,
        p_lease_seconds: 120,
      }
    );

    markStartPerf('lease_acquire');
    if (acquireError) throw acquireError;

    if (!acquired) {
      return res.status(409).json({
        error: 'Recording start is busy or stream is stopping',
      });
    }

    leaseToken = acquired;
    leaseStreamId = streamRow.id;

    renewalTimer = setInterval(() => {
      renewLease().catch(error => {
        leaseLost = true;
        console.error('[EGRESS] Start lease timer failed:', error?.message);
      });
    }, 30000);

    renewalTimer.unref?.();

    if (!(await renewLease())) {
      return res.status(409).json({ error: 'Recording start lease lost' });
    }

    markStartPerf('initial_lease_verification');
    const egressClient = getEgressClient();
    const activeEgresses = await egressClient.listEgress({
      roomName,
      active: true,
    });

    markStartPerf('existing_recording_lookup');
    if (!Array.isArray(activeEgresses)) {
      throw new Error('Recording discovery unavailable');
    }

    const existing = activeEgresses.find(
      item =>
        item?.egressId &&
        item.roomName === roomName &&
        isLivestreamRecordingEgress(item, streamRow.id) &&
        [0, 1, 2].includes(Number(item.status))
    );

    if (existing) {
      const existingFilename = egressFilenameOf(existing);

      if (
        typeof existingFilename !== 'string' ||
        !existingFilename.trim()
      ) {
        console.error(
          '[EGRESS] Existing recording missing filename:',
          existing.egressId
        );

        return res.status(409).json({
          error: 'Existing recording metadata incomplete',
          reconciliationRequired: true,
        });
      }

      if (Number(existing.status) === 2) {
        return res.status(409).json({
          error: 'Existing recording is ending',
          reconciliationRequired: true,
        });
      }

      return res.json({
        egressId: existing.egressId,
        filename: existingFilename,
      });
    }

    if (!(await renewLease())) {
      return res.status(409).json({ error: 'Recording start lease lost' });
    }

    markStartPerf('pre_start_lease_verification');
    const started = await startCompositeRecording(roomName, streamRow, req.body?.orientation);
    markStartPerf('livekit_recording_start');

    // REPLAY-SYNC: anchor the moment the start call resolved on Railway's clock.
    // The client timer starts only after /egress/activate succeeds, so this is the
    // closest server-side approximation of MP4 t=0. First-write-wins: ensure-active
    // reconnects must never overwrite it.
    try {
      const { error: anchorErr } = await supabase
        .from('live_streams')
        .update({ egress_media_started_at: new Date().toISOString() })
        .eq('id', streamRow.id)
        .is('egress_media_started_at', null);
      if (anchorErr) {
        console.warn('[REPLAY-SYNC] Media start anchor write failed:', anchorErr.message || anchorErr);
      } else {
        console.log('[REPLAY-SYNC] Media start anchor set for stream', streamRow.id);
      }
    } catch (anchorEx) {
      console.warn('[REPLAY-SYNC] Media start anchor write threw:', anchorEx?.message || anchorEx);
    }

    if (!(await renewLease())) {
      console.error(
        '[EGRESS] Start lease lost after recording creation:',
        streamRow.id,
        started.egressId
      );

      return res.status(409).json({
        error: 'Recording start lease lost after creation',
        reconciliationRequired: true,
      });
    }

    markStartPerf('anchor_and_final_lease');
    void captureAutomaticLiveThumbnail(roomName, streamRow)
      .catch(error => {
        console.warn(
          '[AUTO THUMBNAIL] Background capture failed:',
          error.message
        );
      });

    return res.json(started);
  } catch (error) {
    console.error('[EGRESS] Start error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to start recording' });
  } finally {
    leaseClosing = true;

    if (renewalTimer) clearInterval(renewalTimer);
    if (renewalPromise) await renewalPromise;

    if (leaseToken && leaseStreamId) {
      try {
        const { error } = await supabase.rpc(
          'bushrann_release_egress_recovery_lease',
          {
            p_stream_id: leaseStreamId,
            p_user_id: req.authUserId,
            p_lease_token: leaseToken,
          }
        );

        if (error) throw error;
      } catch (error) {
        console.error('[EGRESS] Start lease release failed:', error?.message);
      }
    }
  }
});
router.post('/egress/readiness', requireAuth, async (req, res) => {
  try {
    const { roomName, egressId } = req.body || {};

    if (
      typeof roomName !== 'string' || !roomName ||
      typeof egressId !== 'string' || !egressId
    ) {
      return res.status(400).json({
        error: 'Missing roomName or egressId',
      });
    }

    const streamRow = await findStreamByRoom(roomName);

    if (!streamRow) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (streamRow.user_id !== req.authUserId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const infos = await getEgressClient().listEgress({ egressId });

    const info = Array.isArray(infos)
      ? infos.find(item =>
          item.egressId === egressId &&
          item.roomName === roomName &&
          isLivestreamRecordingEgress(item, streamRow.id)
        )
      : null;

    if (!info) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    // LiveKit EGRESS_ACTIVE = 1.
    if (info.status === 1) {
      return res.json({ state: 'active' });
    }

    if (isEgressTerminal(info.status)) {
      return res.status(409).json({ state: 'terminal' });
    }

    return res.status(202).json({ state: 'starting' });

  } catch (error) {
    console.error('[EGRESS] Readiness check failed:', error.message);

    return res.status(503).json({
      error: 'Recording readiness unavailable',
    });
  }
});
// ─── STREAM ACTIVE (follower "went live" notification trigger) ──
// Called by the host client once its local camera track has published.
// Verifies the caller owns the stream and that the host's camera track is
// actually live in the LiveKit room, then atomically claims the stream
// and enqueues the 'live_started' notification job via
// claim_live_notification (migration 20261025). Safe to call repeatedly:
// the claim is one-shot per stream (stream_notified_at).
// Activate a prepared livestream only after LiveKit recording is ACTIVE.
const activatePreparedEgress = async (req, res, allowPending = false) => {
  try {
    const { roomName, egressId } = req.body || {};

    const timingFromRow = row => {
      const started = row?.egress_started_at
        ? Date.parse(row.egress_started_at)
        : null;
      const activated = row?.public_activated_at
        ? Date.parse(row.public_activated_at)
        : null;

      const startMs = Number.isFinite(started) ? started : null;
      const activationMs = Number.isFinite(activated) ? activated : null;

      return {
        egressReportedStartedAtMs: startMs,
        activationObservedAtMs: activationMs,
        reportedStartLeadMs:
          startMs !== null && activationMs !== null
            ? activationMs - startMs
            : null
      };
    };

    if (
      typeof roomName !== 'string' || !roomName.trim() ||
      typeof egressId !== 'string' || !egressId.trim()
    ) {
      return res.status(400).json({ error: 'Missing roomName or egressId' });
    }

    const { data: streamRow, error: lookupError } = await supabase
      .from('live_streams')
      .select('id, user_id, is_live, stream_status, egress_started_at, public_activated_at')
      .eq('channel_name', roomName)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!streamRow) {
      return res.status(404).json({ error: 'Stream not found' });
    }
    if (streamRow.user_id !== req.authUserId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (streamRow.stream_status === 'live' && streamRow.is_live === true) {
      return res.json({ activated: true, alreadyLive: true, timing: timingFromRow(streamRow) });
    }

    if (streamRow.stream_status !== 'starting' || streamRow.is_live !== false) {
      return res.status(409).json({ error: 'Stream is not starting' });
    }

    const infos = await getEgressClient().listEgress({ egressId });
    const info = Array.isArray(infos)
      ? infos.find(item =>
          item.egressId === egressId &&
          item.roomName === roomName &&
          isLivestreamRecordingEgress(item, streamRow.id)
        )
      : null;

    if (allowPending && info && info.status !== 1 && !isEgressTerminal(info.status)) {
      return res.status(202).json({ state: 'starting' });
    }

    if (!info || info.status !== 1) {
      return res.status(409).json({ error: 'Recording is not ACTIVE' });
    }

    const participants = await getRoomServiceClient().listParticipants(
      roomName
    );
    const host = (participants || []).find(
      p => String(p.identity) === String(streamRow.user_id)
    );
    const hasCamera = (host?.tracks || []).some(
      t => t.type === 1 && t.source === 1 && !t.muted
    );

    if (!hasCamera) {
      return res.status(503).json({
        retryable: true,
        error: 'Host camera not ready',
      });
    }

    // Capture the request-side activation timestamp before the atomic
    // database update. This is NOT a frame-accurate MP4 offset.
    const activationRequestedAt = new Date();
    let egressStartedAtIso = null;

    try {
      const startedNs = BigInt(
        info.startedAt?.toString?.() ?? '0'
      );

      if (startedNs > 0n) {
        const startedMs = Number(startedNs / 1000000n);

        if (
          Number.isSafeInteger(startedMs) &&
          startedMs > 0 &&
          startedMs <= activationRequestedAt.getTime()
        ) {
          egressStartedAtIso = new Date(startedMs).toISOString();
        }
      }
    } catch (_) {
      // Timestamp unavailable; recording activation can still proceed.
    }

    const { data: activated, error: activationError } = await supabase
      .from('live_streams')
      .update({
        is_live: true,
        stream_status: 'live',
        egress_started_at: egressStartedAtIso,
        public_activated_at: activationRequestedAt.toISOString()
      })
      .eq('id', streamRow.id)
      .eq('user_id', req.authUserId)
      .eq('stream_status', 'starting')
      .eq('is_live', false)
      .eq('egress_stop_pending', false)
      .select('id, egress_started_at, public_activated_at')
      .maybeSingle();

    if (activationError) {
      if (activationError.code === '23505') {
        return res.status(409).json({
          error: 'Another livestream is already active',
        });
      }
      throw activationError;
    }

    if (!activated) {
      return res.status(409).json({
        error: 'Stream changed before activation',
      });
    }

    // REPLAY SYNC PHASE 2: read the timestamps persisted by activation.
    const timing = timingFromRow(activated);

    console.log('[REPLAY-SYNC] Public activation timing', {
      streamId: streamRow.id,
      egressId,
      ...timing
    });

    return res.json({ activated: true, timing });
  } catch (error) {
    console.error('[EGRESS] Activation failed:', error?.message);
    return res.status(503).json({ error: 'Activation unavailable' });
  }
};

router.post('/egress/ready-activate', requireAuth, (req, res) =>
  activatePreparedEgress(req, res, true)
);
router.post('/egress/activate', requireAuth, (req, res) => activatePreparedEgress(req, res));
router.post('/stream-active', requireAuth, async (req, res) => {
  try {
    const { roomName } = req.body || {};

    if (!roomName || typeof roomName !== 'string') {
      return res.status(400).json({ error: 'Missing roomName' });
    }

    const streamRow = await findStreamByRoom(roomName);

    if (!streamRow) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (streamRow.user_id !== req.authUserId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (streamRow.is_live !== true) {
      return res.status(409).json({ error: 'Stream is not live yet' });
    }

    if (streamRow.stream_notified_at) {
      return res
        .status(409)
        .json({ error: 'Already notified' });
    }

    // Require the host's unmuted camera track to be present in the room
    // before notifying followers, so a host stuck on the preview screen
    // never triggers a notification.
    const participants = await getRoomServiceClient().listParticipants(
      roomName
    );

    const host = (participants || []).find(
      p => String(p.identity) === String(streamRow.user_id)
    );

    const hasCamera = (host?.tracks || []).some(
      t => t.type === 1 && t.source === 1 && !t.muted
    );

    if (!hasCamera) {
      return res
        .status(503)
        .json({ retryable: true, error: 'Host camera not live yet' });
    }

    const { data: claimed, error: claimError } = await supabase.rpc(
      'claim_live_notification',
      { p_stream_id: streamRow.id }
    );

    // The RPC may not exist yet if the migration has not been applied.
    if (claimError) {
      console.error(
        '[NOTIFY] claim_live_notification RPC failed:',
        claimError.message
      );

      return res
        .status(503)
        .json({ retryable: true, error: 'Notification infra unavailable' });
    }

    if (claimed !== true) {
      return res
        .status(409)
        .json({ error: 'Already notified' });
    }

    return res.json({ notified: true });
  } catch (error) {
    console.error(
      '[NOTIFY] stream-active error:',
      error?.message || error
    );

    return res
      .status(500)
      .json({ error: 'Failed to process stream-active' });
  }
});

// ─── ENSURE ACTIVE RECORDING (post-reconnect recovery) ───────────
// After a LiveKit reconnect the room may have been torn down and
// recreated (the old room's composite egress then ends with "Source
// closed"). The client calls this with its current egressId; the
// server verifies ownership, re-checks the egress status FROM LIVEKIT
// (never trusting the client's claim), and:
//   1. does nothing when that egress (or any active egress for the
//      room) is still recording, or
//   2. starts ONE new room-composite recording and returns its id.
// Every path is safe to call repeatedly and concurrently: LiveKit is
// the single source of truth for "is something already recording".
router.post(
  '/egress/ensure-active',
  requireAuth,
  async (req, res) => {
    let recoveryLeaseToken = null;
    let recoveryLeaseStreamId = null;
    let recoveryLeaseTimer = null;
    let recoveryLeaseRenewing = false;
    let recoveryLeaseLost = false;

    const verifyRecoveryLease = async () => {
      if (!recoveryLeaseToken || recoveryLeaseLost) return false;

      const { data, error } = await supabase.rpc(
        'bushrann_verify_egress_recovery_lease',
        {
          p_stream_id: recoveryLeaseStreamId,
          p_user_id: req.authUserId,
          p_lease_token: recoveryLeaseToken,
        }
      );

      if (error || data !== true) {
        recoveryLeaseLost = true;
        return false;
      }

      return true;
    };

    try {
      const { roomName, egressId } = req.body || {};

      if (!roomName || typeof roomName !== 'string') {
        return res
          .status(400)
          .json({ error: 'Missing roomName' });
      }

      const streamRow = await findStreamByRoom(roomName);

      if (!streamRow) {
        return res
          .status(404)
          .json({ error: 'Stream not found' });
      }

      if (streamRow.user_id !== req.authUserId) {
        return res
          .status(403)
          .json({ error: 'Not authorized' });
      }

      // Recovery is allowed only for an active livestream that is not
      // being stopped. Never restart recording during End Stream.
      const { data: recoveryState, error: recoveryStateError } =
        await supabase
          .from('live_streams')
          .select('is_live, stream_status, egress_stop_pending')
          .eq('id', streamRow.id)
          .eq('user_id', req.authUserId)
          .maybeSingle();

      if (recoveryStateError) throw recoveryStateError;

      if (
        !recoveryState ||
        recoveryState.is_live !== true ||
        recoveryState.stream_status !== 'live' ||
        recoveryState.egress_stop_pending !== false
      ) {
        return res.status(409).json({
          error: 'Livestream is not eligible for recording recovery',
        });
      }

      const { data: acquiredRecoveryLease, error: recoveryLeaseError } =
        await supabase.rpc('bushrann_acquire_egress_recovery_lease', {
          p_stream_id: streamRow.id,
          p_user_id: req.authUserId,
          p_lease_seconds: 120,
        });

      if (recoveryLeaseError) throw recoveryLeaseError;

      if (!acquiredRecoveryLease) {
        return res.status(409).json({
          error: 'Recording recovery is busy or stream is stopping',
        });
      }

      recoveryLeaseToken = acquiredRecoveryLease;
      recoveryLeaseStreamId = streamRow.id;

      recoveryLeaseTimer = setInterval(async () => {
        if (recoveryLeaseRenewing || recoveryLeaseLost) return;
        recoveryLeaseRenewing = true;

        try {
          const { data, error } = await supabase.rpc(
            'bushrann_renew_egress_recovery_lease',
            {
              p_stream_id: recoveryLeaseStreamId,
              p_user_id: req.authUserId,
              p_lease_token: recoveryLeaseToken,
              p_lease_seconds: 120,
            }
          );

          if (error || data !== true) {
            recoveryLeaseLost = true;
            console.error('[EGRESS] Recovery lease renewal failed');
          }
        } catch (error) {
          recoveryLeaseLost = true;
          console.error(
            '[EGRESS] Recovery lease renewal error:',
            error?.message || error
          );
        } finally {
          recoveryLeaseRenewing = false;
        }
      }, 30000);

      recoveryLeaseTimer.unref?.();

      const egressClient = getEgressClient();

      // 1. The client's current egress may still be recording (the
      //    room survived the reconnect). Verify against LiveKit.
      if (egressId && typeof egressId === 'string') {
        try {
          const current =
            await egressClient.listEgress({ egressId });

          const currentInfo =
            current && current.length > 0
              ? current[0]
              : null;

          if (
            currentInfo &&
            currentInfo.egressId &&
            currentInfo.roomName === roomName &&
            isLivestreamRecordingEgress(currentInfo, streamRow.id) &&
            [0, 2].includes(Number(currentInfo.status))
          ) {
            return res.status(202).json({
              egressId: currentInfo.egressId,
              status: 'pending',
              recovered: false,
              message: 'Recording is transitioning',
            });
          }

          if (
            currentInfo &&
            currentInfo.egressId &&
            currentInfo.roomName === roomName &&
            isLivestreamRecordingEgress(currentInfo, streamRow.id) &&
            Number(currentInfo.status) === 1
          ) {
            return res.json({
              egressId: currentInfo.egressId,
              filename: egressFilenameOf(currentInfo),
              status: 'active',
              recovered: false,
            });
          }
        } catch (lookupError) {
          console.warn(
            '[EGRESS] Recovery: current egress lookup failed:',
            lookupError.message
          );

          return res
            .status(500)
            .json({ error: 'Could not verify recording' });
        }
      }

      // 2. Another non-terminal egress may already exist for this
      //    room (e.g. a concurrent recovery attempt won the race).
      //    Adopt it instead of starting a duplicate.
      try {
        const activeForRoom =
          await egressClient.listEgress({
            roomName,
            active: true,
          });

        const existing = Array.isArray(activeForRoom)
          ? activeForRoom.find(
              info =>
                info?.egressId &&
                isLivestreamRecordingEgress(info, streamRow.id) &&
                [0, 1, 2].includes(Number(info.status))
            ) || null
          : null;

        if (existing && Number(existing.status) !== 1) {
          return res.status(202).json({
            egressId: existing.egressId,
            status: 'pending',
            recovered: false,
            message: 'Recording is transitioning',
          });
        }

        if (existing) {
          console.log(
            '[EGRESS] Recovery: adopting existing active egress:',
            existing.egressId
          );

          return res.json({
            egressId: existing.egressId,
            filename: egressFilenameOf(existing),
            status: 'active',
            recovered: false,
          });
        }
      } catch (activeLookupError) {
        console.warn(
          '[EGRESS] Recovery: active egress lookup failed:',
          activeLookupError.message
        );

        return res
          .status(500)
          .json({ error: 'Could not verify recording' });
      }

      // 3. Nothing is recording — start one new segment. The unique
      //    timestamped filename guarantees the new MP4 never
      //    overwrites an earlier completed segment.
      try {
        if (!(await verifyRecoveryLease())) {
          return res.status(409).json({
            error: 'Recording recovery lease ownership lost',
          });
        }

        const started = await startCompositeRecording(
          roomName,
          streamRow,
          req.body?.orientation
        );

        if (!(await verifyRecoveryLease())) {
          console.error(
            '[EGRESS] Recovery lease lost after LiveKit start; preserving recording for reconciliation:',
            {
              streamId: streamRow.id,
              egressId: started.egressId,
              filename: started.filename,
            }
          );

          return res.status(409).json({
            error: 'Recovery lease lost after recording start',
            reconciliationRequired: true,
          });
        }

        console.log(
          '[EGRESS] Recovery: started new recording after reconnect:',
          started.egressId
        );

        return res.json({
          ...started,
          status: 'started',
          recovered: true,
        });
      } catch (startError) {
        console.error(
          '[EGRESS] Recovery: start failed:',
          startError?.response?.data ||
            startError?.message ||
            startError
        );

        return res
          .status(500)
          .json({ error: 'Failed to restart recording' });
      }
    } catch (error) {
      console.error(
        '[EGRESS] Recovery error:',
        error?.message || error
      );

      return res
        .status(500)
        .json({ error: 'Failed to verify recording' });
    } finally {
      if (recoveryLeaseTimer) {
        clearInterval(recoveryLeaseTimer);
      }

      if (recoveryLeaseToken && recoveryLeaseStreamId) {
        try {
          const { error: releaseError } = await supabase.rpc(
            'bushrann_release_egress_recovery_lease',
            {
              p_stream_id: recoveryLeaseStreamId,
              p_user_id: req.authUserId,
              p_lease_token: recoveryLeaseToken,
            }
          );
          if (releaseError) throw releaseError;
        } catch (releaseError) {
          console.error(
            '[EGRESS] Recovery lease release failed:',
            releaseError?.message || releaseError
          );
        }
      }
    }
  }
);

// ─── MULTI-SEGMENT REPLAY MERGE ──────────────────────────────────
//
// When a host's LiveKit room is torn down mid-stream and the recording
// recovers (see /egress/ensure-active), one livestream produces several
// COMPLETE room-composite MP4 segments in the "livestreams" bucket. At
// End Stream the segments are discovered FROM LIVEKIT (listEgress by room,
// sorted by startedAt) and concatenated with FFmpeg stream copy — no
// re-encoding — into ONE replay. Original segments are NEVER modified or
// deleted here. Any failure falls back to replaying the newest segment.

function storagePublicUrl(filename) {
  return (
    `${process.env.SUPABASE_URL}` +
    `/storage/v1/object/public/livestreams/${filename}`
  );
}

// Poll Supabase Storage until an object is downloadable. LiveKit may still
// be finalizing/uploading a segment for a while after its egress completes.
async function waitForStorageFile(
  url,
  label,
  attempts = 30,
  delayMs = 20000
) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
      });

      if (response.ok) {
        console.log(
          `[MERGE] Segment available after ${i * delayMs}ms:`,
          label
        );
        return;
      }
    } catch (e) {
      // Not ready yet.
    }

    await new Promise(resolve =>
      setTimeout(resolve, delayMs)
    );
  }

  throw new Error(
    `Segment never became available: ${label}`
  );
}

// Duration in seconds via ffprobe (null when unprobeable).
async function probeVideoDuration(filePath) {
  const ffmpeg = require('fluent-ffmpeg');

  ffmpeg.setFfprobePath(
    require('ffprobe-static').path
  );

  return new Promise(resolve => {
    ffmpeg(filePath).ffprobe((error, data) => {
      if (error) {
        return resolve(null);
      }

      const duration = Number(
        data?.format?.duration
      );

      resolve(
        Number.isFinite(duration) && duration > 0
          ? duration
          : null
      );
    });
  });
}

// Stream a remote object to a local file. Never buffers the whole
// file in memory.
async function downloadToFile(url, destPath) {
  const fs = require('fs');
  const { Readable } = require('stream');

  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(
      `Download failed with HTTP ${response.status}: ${url}`
    );
  }

  await new Promise((resolve, reject) => {
    const writeStream =
      fs.createWriteStream(destPath);

    writeStream.on('finish', resolve);
    writeStream.on('error', reject);

    Readable
      .fromWeb(response.body)
      .pipe(writeStream);
  });
}

// FFmpeg concat demuxer with stream copy (no re-encode). Safe because all
// segments come from the same LiveKit room-composite encoding settings.
function runConcatCopy(listPath, outPath) {
  const ffmpeg = require('fluent-ffmpeg');

  ffmpeg.setFfmpegPath(
    require('ffmpeg-static')
  );

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .addOption('-c', 'copy')
      .save(outPath)
      .on('end', () => resolve())
      .on('error', (error) => reject(error));
  });
}

// Merge chronological segments [{egressId, filename, startedAt}] into one
// MP4. When targetFilename is provided (the durable restart-recovery path)
// the merged output is written under that EXACT name; otherwise a new unique
// name is generated. If the target already exists in Storage — e.g. a
// previous attempt uploaded it and then Railway died — it is reused as-is
// (its duration was verified before that upload) instead of merging again.
// Returns the merged Storage filename, or null when anything fails (callers
// fall back safely). Only Railway /tmp files are removed; original segments
// are untouched.
async function mergeRecordingSegments(
  streamRowId,
  segments,
  targetFilename = null
) {
  const fs = require('fs');

  const jobId =
    `${streamRowId}_${Date.now()}_` +
    Math.random().toString(36).slice(2, 8);

  const tmpPaths = [];

  const mergedFilename =
    targetFilename ||
    `recordings/merged_${streamRowId}_${Date.now()}.mp4`;

  try {
    try {
      const existing = await fetch(
        storagePublicUrl(mergedFilename),
        { method: 'HEAD' }
      );

      if (existing.ok) {
        console.log(
          '[MERGE] Merged output already exists; reusing:',
          mergedFilename
        );

        return mergedFilename;
      }
    } catch (reuseCheckError) {
      // Transient check failure — proceed with a normal merge attempt.
      console.warn(
        '[MERGE] Reuse check failed; merging anyway:',
        reuseCheckError.message
      );
    }

    // Verify each source recording is COMPLETE before downloading
    // or merging. Storage existence alone is not enough.
    const egressClient = getEgressClient();

    if (
      !Array.isArray(segments) ||
      segments.length < 2 ||
      segments.some(
        (segment) =>
          !segment?.egressId ||
          !segment?.filename
      )
    ) {
      throw new Error('Invalid multi-segment recording manifest');
    }

    for (const segment of segments) {
      const results = await egressClient.listEgress({
        egressId: segment.egressId,
      });

      const confirmed = (results || []).find(
        (item) =>
          item.egressId === segment.egressId &&
          item.status === EGRESS_STATUS_COMPLETE &&
          isLivestreamRecordingEgress(item, streamRowId) &&
          egressFilenameOf(item) === segment.filename
      );

      if (!confirmed) {
        throw new Error(
          `Recording segment not confirmed COMPLETE: ${segment.egressId}`
        );
      }
    }

    let totalDuration = 0;
    const concatLines = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const url = storagePublicUrl(
        segment.filename
      );

      await waitForStorageFile(
        url,
        segment.filename
      );

      const tmpPath =
        `/tmp/merge_${jobId}_seg${i}.mp4`;
      tmpPaths.push(tmpPath);

      await downloadToFile(url, tmpPath);

      const duration =
        await probeVideoDuration(tmpPath);

      if (duration === null) {
        throw new Error(
          `Segment ${i} is not a valid video: ${segment.filename}`
        );
      }

      totalDuration += duration;

      concatLines.push(
        `file '${tmpPath.replace(/'/g, `'\\''`)}'`
      );

      console.log(
        `[MERGE] Segment ${i + 1}/${segments.length} ready (${duration}s):`,
        segment.filename
      );
    }

    const listPath = `/tmp/merge_${jobId}.txt`;
    tmpPaths.push(listPath);
    fs.writeFileSync(
      listPath,
      concatLines.join('\n')
    );

    const outPath =
      `/tmp/merge_${jobId}_out.mp4`;
    tmpPaths.push(outPath);

    await runConcatCopy(listPath, outPath);

    const mergedDuration =
      await probeVideoDuration(outPath);

    if (mergedDuration === null) {
      throw new Error(
        'Merged output is not a valid video'
      );
    }

    // Tolerate container/timestamp drift at segment boundaries.
    const tolerance =
      Math.max(5, totalDuration * 0.02);

    if (
      Math.abs(mergedDuration - totalDuration) >
      tolerance
    ) {
      throw new Error(
        `Merged duration ${mergedDuration}s differs ` +
          `from segment total ${totalDuration}s ` +
          `beyond tolerance ${tolerance.toFixed(1)}s`
      );
    }

    // Stream from disk — never load the MP4 into memory. upsert:true so a
    // retried merge after a crash can replace its own partial artifact;
    // original segments are never the upload target here.
    const { error: uploadError } =
      await supabase.storage
        .from('livestreams')
        .upload(
          mergedFilename,
          fs.createReadStream(outPath),
          {
            contentType: 'video/mp4',
            upsert: true,
          }
        );

    if (uploadError) {
      throw new Error(
        `Merged upload failed: ${uploadError.message}`
      );
    }

    // Verify the uploaded object exists before letting callers publish it.
    const verifyResponse = await fetch(
      storagePublicUrl(mergedFilename),
      { method: 'HEAD' }
    );

    if (!verifyResponse.ok) {
      throw new Error(
        `Merged object missing after upload: ${mergedFilename}`
      );
    }

    console.log(
      '[MERGE] Merged replay ready:',
      mergedFilename,
      `(${mergedDuration}s from ${segments.length} segments)`
    );

    return mergedFilename;
  } catch (error) {
    console.error(
      '[MERGE] Failed:',
      error?.message || error
    );

    return null;
  } finally {
    for (const tmpPath of tmpPaths) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (e) {}
    }
  }
}

// Background continuation for the multi-segment End Stream path: merge,
// then create the single replay row and hand off to the existing
// processRecording/finalizeReplay pipeline (which is restart-resilient and
// single-winner). On merge failure, falls back to the newest segment so the
// Background continuation for the multi-segment End Stream path. The
// replay row is created synchronously by /egress/stop BEFORE this runs so
// the job survives a Railway restart (the row is the durable job record).
// Merges into the row's exact merged filename; on merge failure, retargets
// the still-'processing' row at the newest segment so the host's replay is
// never lost entirely. Original segments are never touched.
async function processMultiSegmentReplay(
  recordId,
  streamRow,
  segments,
  stoppedEgressId,
  mergedTargetFilename
) {
  try {
    const mergedFilename =
      await mergeRecordingSegments(
        streamRow.id,
        segments,
        mergedTargetFilename
      );

    if (mergedFilename) {
      // The MP4 is already in Supabase Storage. processRecording waits for
      // it, creates the thumbnail, and publishes the replay metadata.
      processRecording(
        recordId,
        mergedFilename,
        stoppedEgressId
      );
      return;
    }

    // Preserve all original MP4 segments for recovery.
    // Never substitute one segment for the complete replay.
    console.error(
      '[MERGE] Merge failed; retaining complete recording manifest for retry:',
      streamRow.id
    );
    return;  } catch (error) {
    console.error(
      '[MERGE] Replay processing error:',
      error?.message || error
    );
  }
}

// ─── RESTART RECOVERY FOR MERGED REPLAYS ─────────────────────────
//
// The merged filename embeds the live_streams id
// (recordings/merged_<streamId>_<ts>.mp4) and every original segment is
// named recordings/<streamId>_<ts>.mp4, so after a Railway restart the
// segment list can be rediscovered FROM LIVEKIT alone — even though the
// live_streams row is long deleted — by filename prefix. This powers the
// sweeper branch that rebuilds a merged replay whose file is still missing.

// In-flight rebuilds, so a slow merge is never started twice concurrently
// (in-process; the unique target filename makes retries idempotent anyway).
const mergeRebuildInProgress = new Set();

async function rediscoverSegmentsForStream(
  streamRowId
) {
  const egressClient = getEgressClient();

  const allEgresses =
    await egressClient.listEgress();

  const prefix = `recordings/${streamRowId}_`;

  const segmentsById = new Map();

  for (const item of allEgresses || []) {
    if (!item || !item.egressId) {
      continue;
    }

    if (item.status !== EGRESS_STATUS_COMPLETE) {
      continue;
    }

    const filename = egressFilenameOf(item);

    // Prefix match keeps the original segments; merged_ files never match.
    if (!filename || !filename.startsWith(prefix)) {
      continue;
    }

    segmentsById.set(item.egressId, {
      egressId: item.egressId,
      filename,
      startedAt:
        typeof item.startedAt === 'number'
          ? item.startedAt
          : 0,
    });
  }

  return [...segmentsById.values()].sort(
    (a, b) => a.startedAt - b.startedAt
  );
}

// Returns true when the merged file for this row now exists (reused or
// rebuilt), false when rebuilding is not possible yet (sweeper retries).
async function rebuildMergedReplay(candidate) {
  const filename = candidate?.recording_filename;

  const match =
    filename &&
    filename.match(
      /^recordings\/merged_(.+)_\d{10,}\.mp4$/
    );

  if (!match || !match[1]) {
    return false;
  }

  const streamRowId = match[1];

  if (mergeRebuildInProgress.has(candidate.id)) {
    return false;
  }

  mergeRebuildInProgress.add(candidate.id);

  try {
    const { data: recoveryJob, error: recoveryError } =
      await supabase
        .from('livestream_replay_recovery')
        .select(
          'recording_filename, merged_target_filename, recording_segments, recording_manifest_ready'
        )
        .eq('stream_id', streamRowId)
        .single();

    if (recoveryError || !recoveryJob) {
      console.warn(
        '[RECOVERY] Missing saved merge manifest:',
        streamRowId
      );
      return false;
    }

    const segments = recoveryJob.recording_segments;

    if (
      recoveryJob.recording_manifest_ready !== true ||
      recoveryJob.recording_filename !== filename ||
      recoveryJob.merged_target_filename !== filename ||
      !Array.isArray(segments) ||
      segments.length < 2 ||
      segments.some(
        (segment) =>
          !segment ||
          typeof segment.egressId !== 'string' ||
          !segment.egressId ||
          typeof segment.filename !== 'string' ||
          !segment.filename ||
          !segment.filename.startsWith(
            `recordings/${streamRowId}_`
          ) ||
          !/^\d+$/.test(String(segment.startedAt))
      ) ||
      new Set(segments.map((segment) => segment.egressId)).size !==
        segments.length ||
      new Set(segments.map((segment) => segment.filename)).size !==
        segments.length
    ) {
      console.warn(
        '[RECOVERY] Invalid or incomplete saved merge manifest:',
        streamRowId
      );
      return false;
    }
    const merged = await mergeRecordingSegments(
      streamRowId,
      segments,
      filename
    );

    return merged !== null;
  } catch (error) {
    console.warn(
      '[RECOVERY] Merged replay rebuild failed:',
      candidate.id,
      error.message
    );

    return false;
  } finally {
    mergeRebuildInProgress.delete(candidate.id);
  }
}

// ─── STOP EGRESS AND SAVE REPLAY ─────────────────────────────────
router.post('/egress/stop', requireAuth, async (req, res) => {
  let stopClaimedForCatch = false;
  let livekitStoppedForCatch = false;
  let stopStreamIdForCatch = null;
  let stopLeaseTokenForCatch = null;
  let stopLeaseRenewalTimer = null;
  let stopLeaseRenewalInProgress = false;
  let stopLeaseRenewalClosing = false;
  let stopLeaseRenewalPromise = null;
  let stopLeaseLost = false;
  let stopLeaseReleasePromise = null;

  const releaseStopLeaseSafely = () => {
    if (stopLeaseReleasePromise) return stopLeaseReleasePromise;

    stopLeaseRenewalClosing = true;

    if (stopLeaseRenewalTimer) {
      clearInterval(stopLeaseRenewalTimer);
      stopLeaseRenewalTimer = null;
    }

    stopLeaseReleasePromise = (async () => {
      if (stopLeaseRenewalPromise) {
        await stopLeaseRenewalPromise;
      }

      if (!stopLeaseTokenForCatch) {
        return { data: false, error: new Error('No stop lease token') };
      }

      return supabase.rpc('bushrann_release_egress_stop_lease', {
        p_stream_id: stopStreamIdForCatch,
        p_user_id: req.authUserId,
        p_lease_token: stopLeaseTokenForCatch,
      });
    })();

    return stopLeaseReleasePromise;
  };

  const verifyStopLease = async () => {
    if (!stopLeaseTokenForCatch || stopLeaseLost) return false;

    const { data, error } = await supabase.rpc(
      'bushrann_renew_egress_stop_lease',
      {
        p_stream_id: stopStreamIdForCatch,
        p_user_id: req.authUserId,
        p_lease_token: stopLeaseTokenForCatch,
        p_lease_seconds: 120,
      }
    );

    if (error || data !== true) {
      stopLeaseLost = true;
      return false;
    }

    return true;
  };

  try {
    const { egressId } = req.body;

    if (!egressId || typeof egressId !== 'string') {
      return res.status(400).json({ error: 'Missing egressId' });
    }

    const egressClient = getEgressClient();

    // Establish the egress -> room relationship from LIVEKIT itself, never
    // from the request body. This holds even after a server restart, so no
    // client-supplied roomName/filename/userId is ever trusted.
    const egressList = await egressClient.listEgress({
      egressId,
    });

    const egressInfo =
      egressList && egressList.length > 0
        ? egressList[0]
        : null;

    if (!egressInfo) {
      return res.status(404).json({ error: 'Egress not found' });
    }

    const actualRoomName = egressInfo.roomName;

    if (
      !actualRoomName ||
      typeof actualRoomName !== 'string'
    ) {
      return res
        .status(404)
        .json({
          error: 'Egress room information unavailable',
        });
    }

    // Ownership: the authenticated user must own the live_streams row for
    // the room LiveKit says this egress is recording.
    const streamRow =
      await findStreamByRoom(actualRoomName);

    if (!streamRow) {
      return res
        .status(404)
        .json({
          error: 'Stream not found for this recording',
        });
    }

    if (streamRow.user_id !== req.authUserId) {
      return res
        .status(403)
        .json({
          error: 'Not authorized to stop this recording',
        });
    }

    // REPLAY-SYNC: compute the measured per-stream trim plan. clientElapsedMs is
    // a DURATION (timer stop - timer start on the client), so it is immune to
    // clock skew. Null plan = insufficient data, correction stays idle.
    const clientElapsedMs =
      typeof req.body?.clientElapsedMs === 'number' &&
      Number.isFinite(req.body.clientElapsedMs) &&
      req.body.clientElapsedMs > 0
        ? Math.round(req.body.clientElapsedMs)
        : null;
    const replayTrim = computeReplayTrim(streamRow, clientElapsedMs);
    console.log('[REPLAY-SYNC] Trim plan:', {
      streamId: streamRow.id,
      clientElapsedMs,
      headMs: replayTrim ? replayTrim.headMs : null,
      endMs: replayTrim ? replayTrim.endMs : null,
    });

    // Only MP4 room-composite recordings may enter the replay workflow.
    // Never allow participant thumbnail egress to be stopped here.
    if (!isLivestreamRecordingEgress(egressInfo, streamRow.id)) {
      console.warn(
        '[EGRESS] Rejected non-recording egress:',
        egressId
      );

      return res.status(409).json({
        error: 'Egress is not a Bushrann MP4 recording',
      });
    }

    // Acquire an exclusive, expiring stop/replay lease.
    const { data: stopLeaseToken, error: stopLeaseError } =
      await supabase.rpc('bushrann_acquire_egress_stop_lease', {
        p_stream_id: streamRow.id,
        p_user_id: req.authUserId,
        p_lease_seconds: 120,
      });

    if (stopLeaseError) throw stopLeaseError;

    if (!stopLeaseToken) {
      return res.status(409).json({
        error: 'Recording stop already in progress; retry shortly',
      });
    }

    stopClaimedForCatch = true;
    stopStreamIdForCatch = streamRow.id;
    stopLeaseTokenForCatch = stopLeaseToken;

    stopLeaseRenewalTimer = setInterval(() => {
      if (
        stopLeaseRenewalClosing ||
        stopLeaseRenewalInProgress ||
        stopLeaseLost
      ) return;

      stopLeaseRenewalInProgress = true;

      stopLeaseRenewalPromise = (async () => {
        try {
          if (!stopLeaseRenewalClosing) {
            await verifyStopLease();
          }
        } catch (error) {
          stopLeaseLost = true;
          console.error(
            '[EGRESS] Stop lease renewal failed:',
            error?.message || error
          );
        } finally {
          stopLeaseRenewalInProgress = false;
        }
      })();
    }, 30000);

    stopLeaseRenewalTimer.unref?.();

    let livekitStopConfirmed = false;

    // Trusted file locator from LiveKit's own egress record.
    console.log('[EGRESS-TIMING] Stop request:', {
      egressId,
      status: egressInfo.status,
      startedAt: egressInfo.startedAt?.toString?.() ?? 'unavailable',
      endedAt: egressInfo.endedAt?.toString?.() ?? 'unavailable',
      serverTimeMs: Date.now(),
    });

    const trustedFilename = egressFilenameOf(egressInfo);

    // Persist the user's replay-save intent BEFORE stopping LiveKit.
    // The recovery worker must independently verify terminal egress status.
    const wantsReplaySaveBeforeStop =
      typeof req.body.title === 'string' &&
      req.body.title.length > 0;

    if (wantsReplaySaveBeforeStop) {
      if (!trustedFilename) {
        return res.status(503).json({
          error: 'Recording filename unavailable before stop; retry',
        });
      }

      const { error: preStopRecoveryError } = await supabase
        .from('livestream_replay_recovery')
        .upsert(
          {
            stream_id: streamRow.id,
            user_id: streamRow.user_id,
            egress_id: egressId,
            recording_filename: trustedFilename,
            replay_title: streamRow.title || 'Live Stream',
            thumbnail_url: streamRow.thumbnail_url || null,
            egress_started_at: streamRow.egress_started_at ?? null,
            public_activated_at: streamRow.public_activated_at ?? null,
            trim_head_ms: replayTrim ? replayTrim.headMs : null,
            trim_end_ms: replayTrim ? replayTrim.endMs : null,
          },
          {
            onConflict: 'stream_id',
            ignoreDuplicates: true,
          }
        );

      if (preStopRecoveryError) {
        console.error(
          '[RECOVERY] Pre-stop intent failed:',
          preStopRecoveryError.message
        );

        return res.status(503).json({
          error: 'Could not secure replay recovery before stop',
        });
      }
    }

    // An egress that already reached a terminal status (e.g. its room was
    // closed by LiveKit — "Source closed" — during a host reconnect) can no
    // longer be stopped: LiveKit answers with HTTP 412. Treat that as
    // "already stopped" and continue the replay path; only genuinely active
    // egresses are stopped here. EGRESS_ENDING is intentionally NOT
    // terminal: finalization may still need the stop request.
    if (!isEgressTerminal(egressInfo.status)) {
      try {
        await egressClient.stopEgress(egressId);
        livekitStopConfirmed = true;
      } catch (stopError) {
        // Race window: the egress may have ended between the status check
        // above and this stop request. Only that specific LiveKit 412 is
        // tolerated; every other error is a real failure.
        if (!isAlreadyEndedStopError(stopError)) {
          // A timeout may mean LiveKit stopped successfully but the
          // response was lost. Verify before releasing the DB guard.
          let verifiedEgress = null;
          try {
            const verifiedList = await egressClient.listEgress({ egressId });
            verifiedEgress = Array.isArray(verifiedList)
              ? verifiedList.find((item) =>
                  item.egressId === egressId &&
                  item.roomName === actualRoomName &&
                  isLivestreamRecordingEgress(item, streamRow.id)
                )
              : null;
          } catch (verificationError) {
            console.error(
              '[EGRESS] Stop outcome verification failed:',
              verificationError.message
            );
          }

          if (!verifiedEgress) {
            // Unknown outcome: do not allow a stopped recording to
            // become live through a concurrent activation.
            livekitStoppedForCatch = true;
            throw stopError;
          }

          if (!isEgressTerminal(verifiedEgress.status)) {
            // A still-active or ending egress cannot be treated as
            // safely stopped. Retain the claim if it is ending.
            if (verifiedEgress.status === 2) {
              livekitStoppedForCatch = true;
            }
            throw stopError;
          }

          livekitStopConfirmed = true;
        } else {
          livekitStopConfirmed = true;
        }

        console.log(
          '[EGRESS] Egress already ended before stop (412 race); continuing:',
          egressId
        );
      }
    } else {
      livekitStopConfirmed = true;
      console.log(
        '[EGRESS] Egress already in terminal status; skipping stop:',
        egressId,
        'status:',
        egressInfo.status
      );
    }

    livekitStoppedForCatch = livekitStopConfirmed;
    console.log('[EGRESS-TIMING] Stop completed:', {
      egressId,
      serverTimeMs: Date.now(),
    });

    console.log('[EGRESS] Stopped:', egressId);

    // Reconcile other MP4 egresses belonging to this exact livestream.
    // Never stop thumbnail jobs or recordings from another stream.
    const reconcileAdditionalRecordings = async () => {
      if (!(await verifyStopLease())) {
        throw new Error('Stop lease lost before recording reconciliation');
      }

      const roomEgresses = await egressClient.listEgress({
        roomName: actualRoomName,
      });

      if (!Array.isArray(roomEgresses)) {
        throw new Error('LiveKit recording discovery unavailable');
      }

      for (const item of roomEgresses) {
        if (
          !item?.egressId ||
          item.egressId === egressId ||
          item.roomName !== actualRoomName ||
          !isLivestreamRecordingEgress(item, streamRow.id)
        ) {
          continue;
        }

        if (isEgressTerminal(item.status)) continue;

        if (!(await verifyStopLease())) {
          throw new Error('Stop lease lost during recording reconciliation');
        }

        try {
          await egressClient.stopEgress(item.egressId);
        } catch (error) {
          if (!isAlreadyEndedStopError(error)) {
            throw error;
          }
        }

        console.log(
          '[EGRESS] Reconciled additional recording:',
          item.egressId
        );
      }
    };

    try {
      await reconcileAdditionalRecordings();
    } catch (reconciliationError) {
      console.error(
        '[EGRESS] Additional recording reconciliation incomplete:',
        reconciliationError?.message || reconciliationError
      );

      return res.status(503).json({
        error: 'Recording reconciliation incomplete; recovery pending',
      });
    }

    // Preserve the current wire contract: a replay row is saved only when
    // the caller includes a title in the stop request. The title VALUE is
    // taken from the verified stream row — never from the request body.
    const wantsReplaySave =
      typeof req.body.title === 'string' &&
      req.body.title.length > 0;

    if (!wantsReplaySave) {
      // A concurrent normal stop may already own this recording.
      // Never queue cleanup if a replay exists for this stream.
      const { data: existingReplay, error: existingReplayError } =
        await supabase
          .from('livestreams')
          .select('id')
          .eq('source_live_stream_id', streamRow.id)
          .limit(1);

      if (existingReplayError) {
        throw existingReplayError;
      }

      if (existingReplay?.length > 0) {
        return res.json({ success: true, alreadySaved: true });
      }

      // Preserve recordings stopped during abnormal teardown.
      // The host may have disconnected before the replay-save request.
      // Recovery or explicit retention policy must decide their fate.
      if (trustedFilename) {
        console.warn(
          '[EGRESS] Preserving abnormal-stop recording for recovery:',
          streamRow.id,
          trustedFilename
        );
      } else {
        console.warn(
          '[EGRESS] Abnormal-stop recording has no trusted filename:',
          streamRow.id
        );
      }

      return res.json({ success: true });
    }

    // Multi-segment detection: when the room died mid-stream and recording
    // recovered, LiveKit holds several COMPLETE egresses for this room —
    // that is the authoritative, chronologically ordered segment ledger.
    // A single segment keeps the existing simple path (no FFmpeg merge).
    let multiSegments = null;

    try {
      // LiveKit may finalize/upload the MP4 after accepting stopEgress.
      // Do not treat a non-COMPLETE recording as a valid replay.
      const completionDeadline = Date.now() + 20000;
      let roomEgresses;

      while (true) {
        if (!(await verifyStopLease())) {
          throw new Error('Stop lease lost during recording finalization');
        }

        roomEgresses = await egressClient.listEgress({
          roomName: actualRoomName,
        });

        if (!Array.isArray(roomEgresses)) {
          throw new Error('Recording discovery unavailable');
        }

        const recordingSegments = roomEgresses.filter(
          item =>
            item?.egressId &&
            isLivestreamRecordingEgress(item, streamRow.id)
        );

        const allComplete =
          recordingSegments.some(item => item.egressId === egressId) &&
          recordingSegments.every(
            item =>
              Number(item.status) === Number(EGRESS_STATUS_COMPLETE) &&
              Boolean(egressFilenameOf(item))
          );

        if (allComplete) break;

        if (Date.now() >= completionDeadline) {
          throw new Error(
            'Recording finalization timed out; recovery pending'
          );
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const segmentsById = new Map();

      for (const item of roomEgresses || []) {
        if (!item || !item.egressId) {
          continue;
        }

        // Exclude thumbnail jobs and unrelated egresses.
        if (!isLivestreamRecordingEgress(item, streamRow.id)) {
          continue;
        }

        // Only fully completed recordings with a real uploaded file are
        // valid merge inputs.
        if (Number(item.status) !== Number(EGRESS_STATUS_COMPLETE)) {
          throw new Error(
            `Recording segment not COMPLETE: ${item.egressId}`
          );
        }

        const segmentFilename =
          egressFilenameOf(item);

        if (!segmentFilename) {
          throw new Error(
            `Recording segment filename unavailable: ${item.egressId}`
          );
        }

        segmentsById.set(item.egressId, {
          egressId: item.egressId,
          filename: segmentFilename,
          startedAt:
            typeof item.startedAt === 'bigint'
              ? item.startedAt
              : BigInt(0),
        });
      }



      const orderedSegments = [
        ...segmentsById.values(),
      ].sort((a, b) =>
        a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0
      );

      if (orderedSegments.length > 1) {
        multiSegments = orderedSegments;
      }
    } catch (discoveryError) {
      console.error(
        '[MERGE] Segment discovery incomplete; retaining recovery intent:',
        discoveryError.message
      );

      return res.status(503).json({
        error: 'Recording segment discovery incomplete; recovery pending',
      });
    }

    // Renew and verify exclusive ownership before creating a replay.
    // If another request acquired the expired lease, this request
    // must not create or process a replay.
    const { data: leaseRenewed, error: leaseRenewError } =
      await supabase.rpc('bushrann_renew_egress_stop_lease', {
        p_stream_id: streamRow.id,
        p_user_id: req.authUserId,
        p_lease_token: stopLeaseToken,
        p_lease_seconds: 120,
      });

    if (leaseRenewError) throw leaseRenewError;

    if (leaseRenewed !== true) {
      return res.status(409).json({
        error: 'Recording stop lease expired; retry',
      });
    }
    // Persist replay intent before attempting the replay insert.
    // This survives deletion of live_streams and Railway restarts.
    // The existing merged replay recovery path rediscovers segments
    // from LiveKit using the stream ID embedded in the target filename.
    const recoveryFilename = multiSegments
      ? `recordings/merged_${streamRow.id}_${Date.now()}.mp4`
      : trustedFilename;

    if (!recoveryFilename) {
      return res.status(503).json({
        error: 'Recording filename unavailable; retry',
      });
    }

    const { error: recoveryJobError } = await supabase
      .from('livestream_replay_recovery')
      .upsert(
        {
          stream_id: streamRow.id,
          user_id: streamRow.user_id,
          egress_id: egressId,
          recording_filename: recoveryFilename,
          replay_title: streamRow.title || 'Live Stream',
          thumbnail_url: streamRow.thumbnail_url || null,
          egress_started_at: streamRow.egress_started_at ?? null,
          public_activated_at: streamRow.public_activated_at ?? null,
          trim_head_ms: replayTrim ? replayTrim.headMs : null,
          trim_end_ms: replayTrim ? replayTrim.endMs : null,
        },
        {
          onConflict: 'stream_id',
          ignoreDuplicates: true,
        }
      );

    if (recoveryJobError) {
      console.error(
        '[RECOVERY] Failed to persist replay job:',
        recoveryJobError.message
      );

      return res.status(503).json({
        error: 'Replay recovery could not be saved; retry',
      });
    }

    // Read the authoritative persisted job. A concurrent request may
    // have created it first; never use a newly generated merge target.
    const { data: savedRecoveryJob, error: savedJobError } =
      await supabase
        .from('livestream_replay_recovery')
        .select('user_id, egress_id, recording_filename')
        .eq('stream_id', streamRow.id)
        .single();

    if (savedJobError || !savedRecoveryJob) {
      return res.status(503).json({
        error: 'Replay recovery job verification failed; retry',
      });
    }

    if (
      savedRecoveryJob.user_id !== streamRow.user_id ||
      !savedRecoveryJob.recording_filename
    ) {
      return res.status(409).json({
        error: 'Replay recovery job conflict',
      });
    }

    // Convert LiveKit BigInt timestamps into JSON-safe strings.
    const manifestSegments = multiSegments
      ? multiSegments.map((segment) => ({
          egressId: segment.egressId,
          filename: segment.filename,
          startedAt: String(segment.startedAt),
        }))
      : [{
          egressId,
          filename: trustedFilename,
          startedAt: String(egressInfo.startedAt || 0),
        }];

    if (manifestSegments.some(
      (segment) => !segment.egressId || !segment.filename
    )) {
      return res.status(503).json({
        error: 'Recording manifest incomplete; retry',
      });
    }

    const proposedMergedTarget = multiSegments
      ? `recordings/merged_${streamRow.id}_${Date.now()}.mp4`
      : null;

    if (!(await verifyStopLease())) {
      return res.status(409).json({
        error: 'Recording stop lease ownership lost; recovery required',
      });
    }

    // Fail closed if LiveKit reports a new or unfinished recording.
    const finalManifestDiscoveryCheck =
      await egressClient.listEgress({ roomName: actualRoomName });

    if (!Array.isArray(finalManifestDiscoveryCheck)) {
      return res.status(503).json({
        error: 'Final recording discovery unavailable; recovery pending',
      });
    }

    const expectedEgressIds = new Set(
      manifestSegments.map((segment) => segment.egressId)
    );

    for (const item of finalManifestDiscoveryCheck) {
      if (
        !item?.egressId ||
        item.roomName !== actualRoomName ||
        !isLivestreamRecordingEgress(item, streamRow.id)
      ) {
        continue;
      }

      if (
        Number(item.status) !== Number(EGRESS_STATUS_COMPLETE) ||
        !egressFilenameOf(item) ||
        !expectedEgressIds.has(item.egressId)
      ) {
        return res.status(503).json({
          error: 'Recording segments changed; recovery pending',
        });
      }
    }

    if (!(await verifyStopLease())) {
      return res.status(409).json({
        error: 'Recording stop lease lost before manifest finalization',
      });
    }

    const { data: manifestFinalized, error: manifestError } =
      await supabase.rpc('bushrann_finalize_replay_manifest', {
        p_stream_id: streamRow.id,
        p_user_id: streamRow.user_id,
        p_lease_token: stopLeaseToken,
        p_egress_id: savedRecoveryJob.egress_id,
        p_segments: manifestSegments,
        p_merged_target: proposedMergedTarget,
      });

    if (manifestError) throw manifestError;

    const { data: finalManifest, error: finalManifestError } =
      await supabase
        .from('livestream_replay_recovery')
        .select(
          'recording_filename, merged_target_filename, recording_segments, recording_manifest_ready'
        )
        .eq('stream_id', streamRow.id)
        .eq('user_id', streamRow.user_id)
        .single();

    if (finalManifestError) throw finalManifestError;

    if (
      finalManifest.recording_manifest_ready !== true ||
      !Array.isArray(finalManifest.recording_segments) ||
      finalManifest.recording_segments.length !== manifestSegments.length ||
      finalManifest.recording_segments.some(
        (segment, index) =>
          segment.egressId !== manifestSegments[index].egressId ||
          segment.filename !== manifestSegments[index].filename ||
          String(segment.startedAt) !== manifestSegments[index].startedAt
      ) ||
      Boolean(finalManifest.merged_target_filename) !== Boolean(multiSegments) ||
      finalManifest.recording_filename !== (
        multiSegments
          ? finalManifest.merged_target_filename
          : trustedFilename
      )
    ) {
      return res.status(409).json({
        error: 'Recording manifest conflict; recovery required',
      });
    }

    if (!manifestFinalized) {
      console.log(
        '[RECOVERY] Reusing previously finalized manifest:',
        streamRow.id
      );
    }

    // Shared finalization for every successful stop/replay path.
    // Only the current stop-lease owner may close this stream.
    const finalizeStoppedStream = async () => {
      // Prevent concurrent timer renewal while closing the stop lease.
      stopLeaseRenewalClosing = true;

      if (stopLeaseRenewalTimer) {
        clearInterval(stopLeaseRenewalTimer);
        stopLeaseRenewalTimer = null;
      }

      if (stopLeaseRenewalPromise) {
        await stopLeaseRenewalPromise;
      }

      if (!(await verifyStopLease())) {
        throw new Error('Stop lease lost before stream finalization');
      }

      const { data: ended, error } = await supabase
        .from('live_streams')
        .update({
          is_live: false,
          stream_status: 'ended',
          egress_stop_pending: false,
          ended_at: new Date().toISOString(),
          egress_stop_lease_token: null,
          egress_stop_lease_until: null,
        })
        .eq('id', streamRow.id)
        .eq('user_id', req.authUserId)
        .eq('is_live', true)
        .eq('egress_stop_pending', true)
        .eq('egress_stop_lease_token', stopLeaseToken)
        .gt('egress_stop_lease_until', new Date().toISOString())
        .select('id')
        .maybeSingle();

      if (error) throw error;
      if (!ended) {
        throw new Error('Stream finalization ownership or state changed');
      }

      stopLeaseRenewalClosing = true;
      if (stopLeaseRenewalTimer) {
        clearInterval(stopLeaseRenewalTimer);
        stopLeaseRenewalTimer = null;
      }

      console.log('[EGRESS] Livestream finalized:', streamRow.id);
    };
    const authoritativeFilename = finalManifest.recording_filename;
    if (multiSegments) {
      console.log(
        '[MERGE] Multiple recording segments detected:',
        multiSegments.length,
        '— merging in background'
      );

      // Create the durable replay row NOW (before merging) so the job
      // survives a Railway restart: video_url='processing' +
      // recording_filename=<merged target> is exactly the contract
      // sweepReplayRecovery already resumes. The merged filename embeds
      // streamRow.id so the segments can be rediscovered from LiveKit
      // after a restart even though the live_streams row is deleted.
      const mergedTargetFilename = authoritativeFilename;

      const {
        data: mergedRecord,
        error: mergedDbError,
      } = await supabase
        .from('livestreams')
        .insert({
          user_id: streamRow.user_id,
          source_live_stream_id: streamRow.id,
          egress_started_at: streamRow.egress_started_at ?? null,
          public_activated_at: streamRow.public_activated_at ?? null,
          trim_head_ms: replayTrim ? replayTrim.headMs : null,
          trim_end_ms: replayTrim ? replayTrim.endMs : null,
          video_url: 'processing',
          recording_filename:
            mergedTargetFilename,
          thumbnail_url:
            streamRow.thumbnail_url || null,
          title:
            streamRow.title || 'Live Stream',
          is_public: true,
        })
        .select()
        .single();

      if (mergedDbError?.code === '23505') {
        // Another request already created this stream's replay.
        // Never clean up or overwrite its recording.
        const { data: savedReplay, error: replayLookupError } =
          await supabase
            .from('livestreams')
            .select('id, recording_filename')
            .eq('source_live_stream_id', streamRow.id)
            .maybeSingle();

        if (replayLookupError) throw replayLookupError;

        if (
          !savedReplay ||
          savedReplay.recording_filename !== mergedTargetFilename
        ) {
          return res.status(409).json({
            error: 'Existing replay differs; recovery required',
          });
        }

        await finalizeStoppedStream();
        return res.json({ success: true, alreadySaved: true });
      }

      if (mergedDbError || !mergedRecord) {
        // Without the durable row there is nothing for the recovery
        // sweeper to resume. The stream still ends successfully; the
        // original segments remain safe in Storage.
        console.error(
          '[MERGE] Replay row creation failed; merge aborted (segments preserved):',
          mergedDbError?.message
        );

        const { error: releaseError } =
          await releaseStopLeaseSafely();

        if (releaseError) {
          console.error(
            '[EGRESS] Failed to release replay retry lease:',
            releaseError.message
          );
        }

        return res.status(503).json({
          error: 'Replay creation failed; retry',
        });
      }

      // Background: merging large MP4s can exceed any HTTP timeout, and a
      // merge failure must never prevent the host from ending the stream.
      await finalizeStoppedStream();
      processMultiSegmentReplay(
        mergedRecord.id,
        streamRow,
        multiSegments,
        egressId,
        mergedTargetFilename
      );

      return res.json({ success: true });
    }

    // A single replay must have a trusted recording filename before
    // creating its durable database row.
    if (!trustedFilename) {
      console.error(
        '[EGRESS] Recording filename unavailable; preserving stream for retry:',
        streamRow.id
      );

      const { error: releaseError } =
        await releaseStopLeaseSafely();

      if (releaseError) {
        console.error(
          '[EGRESS] Could not release stop lease:',
          releaseError.message
        );
      }

      return res.status(503).json({
        error: 'Recording filename unavailable; retry',
      });
    }

    const {
      data: record,
      error: dbError,
    } = await supabase
      .from('livestreams')
      .insert({
        user_id: streamRow.user_id,
        source_live_stream_id: streamRow.id,
        egress_started_at: streamRow.egress_started_at ?? null,
        public_activated_at: streamRow.public_activated_at ?? null,
        trim_head_ms: replayTrim ? replayTrim.headMs : null,
        trim_end_ms: replayTrim ? replayTrim.endMs : null,
        video_url: 'processing',
        recording_filename: authoritativeFilename,
        thumbnail_url: streamRow.thumbnail_url || null,
        title: streamRow.title || 'Live Stream',
        is_public: true,
      })
      .select()
      .single();

    if (dbError?.code === '23505') {
      // A conflict is only success if the existing replay has a
      // usable recording reference.
      const { data: existingReplay, error: lookupError } =
        await supabase
          .from('livestreams')
          .select('id, recording_filename')
          .eq('source_live_stream_id', streamRow.id)
          .maybeSingle();

      if (lookupError) {
        throw lookupError;
      }

      if (existingReplay?.recording_filename) {
        return res.json({ success: true, alreadySaved: true });
      }

      return res.status(503).json({
        error: 'Existing replay is incomplete; recovery required',
      });
    }

    if (dbError || !record) {
      console.error(
        '[EGRESS] Replay creation failed:',
        dbError?.message || 'No replay row returned'
      );

      console.warn(
        '[EGRESS] Preserving recording for retry:',
        trustedFilename
      );

      const { error: releaseError } =
        await releaseStopLeaseSafely();

      if (releaseError) {
        console.error(
          '[EGRESS] Failed to release replay retry lease:',
          releaseError.message
        );
      }

      return res.status(503).json({
        error: 'Replay creation failed; retry',
      });
    }

    await finalizeStoppedStream();

    // The existing processor waits for the MP4 and publishes the replay.
    processRecording(record.id, authoritativeFilename, egressId);

    return res.json({ success: true });
  } catch (error) {
    if (stopClaimedForCatch && !livekitStoppedForCatch) {
      try {
        const { data: released, error: releaseError } =
          await releaseStopLeaseSafely();
        if (releaseError || released !== true) {
          console.error(
            '[EGRESS] Stop guard release failed:',
            releaseError?.message || 'No matching stop claim'
          );
        }
      } catch (releaseError) {
        console.error('[EGRESS] Failed to release stop guard:', releaseError);
      }
    }
    console.error(
      '[EGRESS] Stop error:',
      error.message
    );

    res
      .status(500)
      .json({ error: 'Failed to stop recording' });
  } finally {
    stopLeaseRenewalClosing = true;

    if (stopLeaseRenewalTimer) {
      clearInterval(stopLeaseRenewalTimer);
    }

    if (stopLeaseRenewalPromise) {
      await stopLeaseRenewalPromise;
    }
  }
});

// ─── BACKGROUND: PROCESS RECORDING ───────────────────────────────
//
// LiveKit already uploads the MP4 directly into the Supabase
// "livestreams" Storage bucket. This job waits for that object,
// generates a thumbnail, and publishes the replay metadata.

async function processRecording(
  recordId,
  filename,
  egressId
) {
  try {
    console.log(
      '[PROCESS] Waiting for LiveKit to finish uploading to Supabase...'
    );

    const publicUrl =
      `${process.env.SUPABASE_URL}` +
      `/storage/v1/object/public/livestreams/${filename}`;

    // Poll Supabase Storage until file appears.
    // 60 attempts × 30 seconds = maximum ~30-minute wait. The first
    // check runs immediately so short uploads are detected without an
    // initial 30-second delay; long streams produce large MP4s whose
    // egress finalization/upload can far exceed the old 5-minute cap.
    let fileReady = false;

    for (let i = 0; i < 60; i++) {
      if (i > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, 30000)
        );
      }

      try {
        const response = await fetch(publicUrl, {
          method: 'HEAD',
        });

        if (response.ok) {
          fileReady = true;

          console.log(
            `[PROCESS] File ready after ${i * 30}s`
          );

          break;
        }
      } catch (e) {
        // Not ready yet.
      }

      console.log(
        `[PROCESS] File not ready yet (attempt ${i + 1})`
      );
    }

    if (!fileReady) {
      console.error(
        '[PROCESS] File not ready within the normal processing window:',
        recordId,
        filename
      );

      // Never mark failed, never delete, never queue for orphan cleanup
      // here. The replay row stays video_url='processing' with its
      // persisted recording_filename, and the durable recovery sweeper
      // (sweepReplayRecovery) continues the watch across restarts and
      // late-arriving MP4s. Normal processing simply yields.
      return;
    }

    await finalizeReplay(recordId, filename, egressId);
  } catch (error) {
    console.error(
      '[PROCESS] Error:',
      error.message
    );
  }
}

// ─── SHARED REPLAY FINALIZATION ──────────────────────────────────
//
// Downloads the recorded MP4, generates a best-effort thumbnail
// (failure never blocks publication), publishes the replay with an
// atomic single-winner conditional update, and adds it to the main
// feed. Safe to run from both processRecording and the recovery
// sweeper; concurrent runners cannot double-publish.

async function finalizeReplay(
  recordId,
  filename,
  workerId
) {
  try {
    const publicUrl =
      `${process.env.SUPABASE_URL}` +
      `/storage/v1/object/public/livestreams/${filename}`;

  // Generate thumbnail from video.
  let thumbnailUrl = null;

    try {
      const ffmpeg = require('fluent-ffmpeg');

      ffmpeg.setFfmpegPath(
        require('ffmpeg-static')
      );

      const fs = require('fs');

      const tempVideoPath =
        `/tmp/${workerId}.mp4`;

      const tempThumbPath =
        `/tmp/${workerId}.jpg`;

      try {
        // Download video.
        const videoResponse =
          await fetch(publicUrl);

        if (!videoResponse.ok) {
          throw new Error(
            `Video download failed with HTTP ${videoResponse.status}`
          );
        }

        const videoBuffer = Buffer.from(
          await videoResponse.arrayBuffer()
        );

        fs.writeFileSync(
          tempVideoPath,
          videoBuffer
        );

        // Extract frame at 1 second.
        await new Promise((resolve, reject) => {
          ffmpeg(tempVideoPath)
            .seekInput(1)
            .outputOptions([
              '-frames:v 1',
              '-vf scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280'
            ])
            .output(tempThumbPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        // Upload thumbnail.
        const thumbBuffer =
          fs.readFileSync(tempThumbPath);

        const { error: thumbError } =
          await supabase.storage
            .from('thumbnails')
            .upload(
              `${workerId}_thumb.jpg`,
              thumbBuffer,
              {
                contentType: 'image/jpeg',
                upsert: true,
              }
            );

        if (thumbError) {
          console.error(
            '[PROCESS] Thumbnail upload error:',
            thumbError.message
          );
        } else {
          const {
            data: { publicUrl: thumbUrl },
          } = supabase.storage
            .from('thumbnails')
            .getPublicUrl(
              `${workerId}_thumb.jpg`
            );

          thumbnailUrl = thumbUrl;

          console.log(
            '[PROCESS] Thumbnail generated:',
            thumbnailUrl
          );
        }
      } finally {
        // Always remove temporary Railway files, including when FFmpeg,
        // download, or thumbnail upload fails.
        try {
          fs.unlinkSync(tempVideoPath);
        } catch (e) {}

        try {
          fs.unlinkSync(tempThumbPath);
        } catch (e) {}
      }
    } catch (thumbErr) {
      console.error(
        '[PROCESS] Thumbnail error:',
        thumbErr.message
      );
    }

    // Publish the replay only if the original processing row still exists.
    const {
      data: updatedReplay,
      error: updateError,
    } = await supabase
      .from('livestreams')
      .update({
        video_url: publicUrl,
        thumbnail_url: thumbnailUrl,
      })
      .eq('id', recordId)
      .eq('video_url', 'processing')
      .select('user_id, title')
      .maybeSingle();

    if (updateError) {
      console.error(
        '[PROCESS] DB update error:',
        updateError.message
      );

      // Preserve the MP4 here. A database failure may be transient and
      // deleting a successfully recorded scholar stream would cause
      // irreversible data loss.
      return;
    }

    if (!updatedReplay) {
      console.warn(
        '[PROCESS] Replay record no longer exists or was already processed:',
        recordId
      );

      // Do not guess that the MP4 is orphaned. Another successful replay
      // operation may already reference the same recording.
      return;
    }

    console.log(
      '[PROCESS] Replay ready! 🎉',
      publicUrl
    );

    // Feed dedupe: only insert when no videos row already references
    // this exact replay URL. The conditional publish above guarantees a
    // single winner per replay, but a retried finalization after a
    // partial failure (publish succeeded, feed insert failed) must not
    // create a duplicate feed entry.
    const {
      data: existingFeedRows,
      error: feedCheckError,
    } = await supabase
      .from('videos')
      .select('id')
      .eq('video_url', publicUrl)
      .limit(1);

    if (feedCheckError) {
      console.error(
        '[PROCESS] Feed dedupe check failed:',
        feedCheckError.message
      );
      // Do not guess: skip the insert this run. The recovery sweeper
      // retries later and the check runs again.
      return;
    }

    if (existingFeedRows && existingFeedRows.length > 0) {
      console.log(
        '[PROCESS] Replay already present in main feed:',
        publicUrl
      );

      return;
    }

    // Also insert into videos table so the replay appears in the main feed.
    const { error: videoInsertError } = await supabase
      .from('videos')
      .insert({
        user_id: updatedReplay.user_id,
        video_url: publicUrl,
        thumbnail_url: thumbnailUrl,
        title:
          updatedReplay.title ||
          'Live Stream Replay',
        is_live_stream: true,
        status: 'approved',
        is_private: false,
      });

    if (videoInsertError) {
      console.error(
        '[PROCESS] Failed to add replay to main feed:',
        videoInsertError.message
      );
    } else {
      console.log(
        '[PROCESS] Added to main feed!'
      );
    }

    // REPLAY-SYNC: the replay is published; schedule the corrected shadow
    // candidate. Detached and fail-open: publication never blocks on
    // correction, and any failure leaves the original replay untouched.
    // Shadow mode only -- video_url is never re-pointed here.
    scheduleReplayCorrection(recordId);
  } catch (error) {
    console.error(
      '[PROCESS] Error:',
      error.message
    );
  }
}

// ─── GCASH DONATION VIA PAYMONGO ─────────────────────────────────
// NOTE: intentionally untouched in this batch. Donation hardening
// (payment confirmation webhook, server-side validation) is a
// separate, later batch.
router.post('/donate', async (req, res) => {
  try {
    const {
      amount,
      scholarName,
      streamId,
    } = req.body;

    const amountInCentavos =
      Math.round(amount * 100);

    if (amountInCentavos < 2000) {
      return res
        .status(400)
        .json({
          error: 'Minimum donation is ₱20',
        });
    }

    const response = await axios.post(
      'https://api.paymongo.com/v1/links',
      {
        data: {
          attributes: {
            amount: amountInCentavos,
            description:
              `Support ${scholarName} on Balagh`,
            remarks: `stream_${streamId}`,
          },
        },
      },
      {
        headers: {
          Authorization:
            `Basic ${Buffer.from(
              process.env.PAYMONGO_SECRET_KEY + ':'
            ).toString('base64')}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const checkoutUrl =
      response.data.data.attributes.checkout_url;

    const paymentLinkId =
      response.data.data.id;

    console.log(
      '[PAYMONGO] Payment link created:',
      checkoutUrl
    );

    // Save donation record to database.
    const {
      donorId,
      scholarId,
    } = req.body;

    if (donorId && scholarId) {
      await supabase
        .from('donations')
        .insert({
          donor_id: donorId,
          scholar_id: scholarId,
          stream_id: streamId,
          amount,
          status: 'pending',
          payment_link_id: paymentLinkId,
        });
    }

    res.json({ checkoutUrl });
  } catch (error) {
    console.error(
      '[PAYMONGO] Error:',
      error.response?.data ||
        error.message
    );

    res
      .status(500)
      .json({
        error: 'Failed to create payment link',
      });
  }
});

module.exports = router;
