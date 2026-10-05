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
    .select('id, user_id, title, thumbnail_url')
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
  return (
    (egressInfo.file &&
      egressInfo.file.filename) ||
    (egressInfo.fileResults &&
      egressInfo.fileResults.length > 0 &&
      egressInfo.fileResults[
        egressInfo.fileResults.length - 1
      ].filename) ||
    null
  );
}

// Start a room-composite MP4 recording for a verified live_streams row.
// The filename is unique per attempt (stream id + timestamp), so a recovered
// recording started after a reconnect NEVER overwrites an earlier segment.
async function startCompositeRecording(roomName, streamRow) {
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

  const egressClient = getEgressClient();

  const filename =
    `recordings/${streamRow.id}_${Date.now()}.mp4`;

  const fileOutput = {
    fileType: EncodedFileType.MP4,
    filepath: filename,

    s3: {
      accessKey: process.env.SUPABASE_S3_KEY_ID,
      secret: process.env.SUPABASE_S3_SECRET,
      region: process.env.SUPABASE_S3_REGION || 'us-east-1',
      endpoint: process.env.SUPABASE_S3_ENDPOINT,
      bucket: 'livestreams',
      forcePathStyle: true,
    },
  };

  const info =
    await egressClient.startRoomCompositeEgress(
      roomName,
      {
        file: fileOutput,
      }
    );

  if (!info?.egressId) {
    throw new Error('LiveKit returned no egressId');
  }

  console.log(
    '[EGRESS] Recording started:',
    info.egressId,
    filename
  );

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
        'id, user_id, channel_name, last_ping, created_at, is_live'
      )
      .eq('is_live', true)
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
      try {
        // Re-read immediately. The host may have recovered between
        // the candidate query and this stream's turn in the loop.
        const {
          data: latest,
          error: latestError,
        } = await supabase
          .from('live_streams')
          .select(
            'id, user_id, channel_name, last_ping, created_at, is_live'
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
          latest.is_live !== true ||
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

        // Narrow the recovery race further. The host could have
        // reconnected while the egress lookup was running.
        const {
          data: finalCheck,
          error: finalCheckError,
        } = await supabase
          .from('live_streams')
          .select(
            'id, user_id, channel_name, last_ping, created_at, is_live'
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
          finalCheck.is_live !== true ||
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

        // Stop every active egress associated with this abandoned room.
        // If ANY stop fails, preserve the live_streams row so ownership
        // information remains available and the next sweep can retry.
        let allEgressesStopped = true;

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
  const orphanedFilename =
    (egress.file &&
      egress.file.filename) ||
    (egress.fileResults &&
      egress.fileResults.length > 0 &&
      egress.fileResults[
        egress.fileResults.length - 1
      ].filename) ||
    null;

  try {
    await egressClient.stopEgress(orphanedEgressId);

    console.log(
      '[EGRESS SWEEPER] Stopped orphaned egress:',
      orphanedEgressId
    );

    if (orphanedFilename) {
      await scheduleUnreferencedRecordingCleanup(
        orphanedFilename
      );
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
          Array.isArray(remainingActiveEgresses) &&
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
            'id, user_id, channel_name, last_ping, created_at, is_live'
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
          deleteCheck.is_live !== true ||
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

        // Conditional delete: require the row to still be live AND its
        // last_ping to still be stale. A heartbeat written after deleteCheck
        // therefore prevents this delete even if it happens in this final gap.
        let deleteQuery = supabase
          .from('live_streams')
          .delete()
          .eq('id', deleteCheck.id)
          .eq('is_live', true);

        if (deleteCheck.last_ping) {
          deleteQuery = deleteQuery.lt(
            'last_ping',
            new Date(Date.now() - STALE_STREAM_MS).toISOString()
          );
        } else {
          deleteQuery = deleteQuery.is('last_ping', null);
        }

        const { error: deleteError } = await deleteQuery;

        if (deleteError) {
          console.warn(
            '[EGRESS SWEEPER] Failed to delete stale stream:',
            deleteCheck.id,
            deleteError.message
          );
          continue;
        }

        console.log(
          '[EGRESS SWEEPER] Removed abandoned livestream:',
          deleteCheck.id
        );
      } catch (streamError) {
        console.warn(
          '[EGRESS SWEEPER] Cleanup failed for stream:',
          candidate.id,
          streamError.message
        );
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
    }

    const now = Math.floor(Date.now() / 1000);

    const payload = {
      iss: apiKey,
      sub: userId,
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

async function sweepReplayRecovery() {
  if (replayRecoverySweepInProgress) {
    return;
  }

  replayRecoverySweepInProgress = true;

  try {
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
    }
  } finally {
    replayRecoverySweepInProgress = false;
  }
}

// ─── START EGRESS RECORDING ──────────────────────────────────────
router.post('/egress/start', requireAuth, async (req, res) => {
  try {
    const { roomName } = req.body;

    if (!roomName || typeof roomName !== 'string') {
      return res.status(400).json({ error: 'Missing roomName' });
    }

    // Verify this room belongs to the authenticated host.
    const streamRow = await findStreamByRoom(roomName);

    if (!streamRow) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    if (streamRow.user_id !== req.authUserId) {
      return res
        .status(403)
        .json({ error: 'Not authorized to record this stream' });
    }

    try {
      const started = await startCompositeRecording(
        roomName,
        streamRow
      );

      return res.json(started);
    } catch (startError) {
      console.error(
        '[EGRESS] Start error:',
        startError?.response?.data ||
          startError?.message ||
          startError
      );

      return res
        .status(500)
        .json({ error: 'Failed to start recording' });
    }
  } catch (error) {
    console.error(
      '[EGRESS] Start error:',
      error?.response?.data ||
        error?.message ||
        error
    );

    return res
      .status(500)
      .json({ error: 'Failed to start recording' });
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
            !isEgressTerminal(currentInfo.status)
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

        const existing =
          activeForRoom &&
          activeForRoom.length > 0 &&
          activeForRoom[0].egressId
            ? activeForRoom[0]
            : null;

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
        const started = await startCompositeRecording(
          roomName,
          streamRow
        );

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

    // Merge failed — fall back to the newest complete segment as the replay.
    const newestSegment =
      segments[segments.length - 1];

    if (!newestSegment?.filename) {
      console.error(
        '[MERGE] No usable recording for replay; nothing was deleted, manual recovery possible'
      );
      return;
    }

    console.warn(
      '[MERGE] Falling back to newest segment as replay:',
      newestSegment.filename
    );

    // Retarget only while the row is still unpublished ('processing').
    const { error: retargetError } =
      await supabase
        .from('livestreams')
        .update({
          recording_filename:
            newestSegment.filename,
        })
        .eq('id', recordId)
        .eq('video_url', 'processing');

    if (retargetError) {
      console.error(
        '[MERGE] Fallback retarget failed:',
        retargetError.message
      );
      return;
    }

    processRecording(
      recordId,
      newestSegment.filename,
      stoppedEgressId
    );
  } catch (error) {
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
    const segments =
      await rediscoverSegmentsForStream(
        streamRowId
      );

    if (!segments || segments.length === 0) {
      console.warn(
        '[RECOVERY] No segments rediscovered yet for merged replay:',
        candidate.id
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

    // Trusted file locator from LiveKit's own egress record.
    const trustedFilename = egressFilenameOf(egressInfo);

    // An egress that already reached a terminal status (e.g. its room was
    // closed by LiveKit — "Source closed" — during a host reconnect) can no
    // longer be stopped: LiveKit answers with HTTP 412. Treat that as
    // "already stopped" and continue the replay path; only genuinely active
    // egresses are stopped here. EGRESS_ENDING is intentionally NOT
    // terminal: finalization may still need the stop request.
    if (!isEgressTerminal(egressInfo.status)) {
      try {
        await egressClient.stopEgress(egressId);
      } catch (stopError) {
        // Race window: the egress may have ended between the status check
        // above and this stop request. Only that specific LiveKit 412 is
        // tolerated; every other error is a real failure.
        if (!isAlreadyEndedStopError(stopError)) {
          throw stopError;
        }

        console.log(
          '[EGRESS] Egress already ended before stop (412 race); continuing:',
          egressId
        );
      }
    } else {
      console.log(
        '[EGRESS] Egress already in terminal status; skipping stop:',
        egressId,
        'status:',
        egressInfo.status
      );
    }

    console.log('[EGRESS] Stopped:', egressId);

    // Preserve the current wire contract: a replay row is saved only when
    // the caller includes a title in the stop request. The title VALUE is
    // taken from the verified stream row — never from the request body.
    const wantsReplaySave =
      typeof req.body.title === 'string' &&
      req.body.title.length > 0;

    if (!wantsReplaySave) {
      if (trustedFilename) {
        // This recording deliberately has no replay row and therefore
        // cannot be surfaced by Bushrann. Wait for LiveKit's upload to
        // settle and then remove the unreferenced MP4.
        await scheduleUnreferencedRecordingCleanup(
          trustedFilename
        );
      } else {
        console.warn(
          '[EGRESS CLEANUP] Recording has no replay and no trusted filename; nothing can be safely removed'
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
      const roomEgresses =
        await egressClient.listEgress({
          roomName: actualRoomName,
        });

      const segmentsById = new Map();

      for (const item of roomEgresses || []) {
        if (!item || !item.egressId) {
          continue;
        }

        // Only fully completed recordings with a real uploaded file are
        // valid merge inputs.
        if (item.status !== EGRESS_STATUS_COMPLETE) {
          continue;
        }

        const segmentFilename =
          egressFilenameOf(item);

        if (!segmentFilename) {
          continue;
        }

        segmentsById.set(item.egressId, {
          egressId: item.egressId,
          filename: segmentFilename,
          startedAt:
            typeof item.startedAt === 'number'
              ? item.startedAt
              : 0,
        });
      }

      // The egress stopped just now may still be ENDING (not yet COMPLETE)
      // in this listing. It IS the newest segment — include it from the
      // trusted pre-stop record so it is never dropped from the merge.
      if (
        !segmentsById.has(egressId) &&
        trustedFilename
      ) {
        segmentsById.set(egressId, {
          egressId,
          filename: trustedFilename,
          startedAt:
            typeof egressInfo.startedAt ===
            'number'
              ? egressInfo.startedAt
              : Number.MAX_SAFE_INTEGER,
        });
      }

      const orderedSegments = [
        ...segmentsById.values(),
      ].sort((a, b) => a.startedAt - b.startedAt);

      if (orderedSegments.length > 1) {
        multiSegments = orderedSegments;
      }
    } catch (discoveryError) {
      // Discovery failure must never break the normal end flow.
      console.warn(
        '[MERGE] Segment discovery failed; using single-segment path:',
        discoveryError.message
      );
    }

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
      const mergedTargetFilename =
        `recordings/merged_${streamRow.id}_${Date.now()}.mp4`;

      const {
        data: mergedRecord,
        error: mergedDbError,
      } = await supabase
        .from('livestreams')
        .insert({
          user_id: streamRow.user_id,
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

      if (mergedDbError || !mergedRecord) {
        // Without the durable row there is nothing for the recovery
        // sweeper to resume. The stream still ends successfully; the
        // original segments remain safe in Storage.
        console.error(
          '[MERGE] Replay row creation failed; merge aborted (segments preserved):',
          mergedDbError?.message
        );

        return res.json({ success: true });
      }

      // Background: merging large MP4s can exceed any HTTP timeout, and a
      // merge failure must never prevent the host from ending the stream.
      processMultiSegmentReplay(
        mergedRecord.id,
        streamRow,
        multiSegments,
        egressId,
        mergedTargetFilename
      );

      return res.json({ success: true });
    }

    const {
      data: record,
      error: dbError,
    } = await supabase
      .from('livestreams')
      .insert({
        user_id: streamRow.user_id,
        video_url: 'processing',
        recording_filename: trustedFilename || null,
        thumbnail_url:
          streamRow.thumbnail_url || null,
        title:
          streamRow.title || 'Live Stream',
        is_public: true,
      })
      .select()
      .single();

    if (dbError) {
      console.error(
        '[EGRESS] DB save error:',
        dbError.message
      );

      // The recording exists but no replay row references it because
      // creation of that row failed. It is therefore safe to clean up.
      if (trustedFilename) {
        await scheduleUnreferencedRecordingCleanup(
          trustedFilename
        );
      }

      return res.json({ success: true });
    }

    if (trustedFilename) {
      // The MP4 is already being written directly into Supabase Storage.
      // processRecording waits for it, creates the thumbnail, and publishes
      // the replay metadata.
      processRecording(
        record.id,
        trustedFilename,
        egressId
      );
    } else {
      console.error(
        '[EGRESS] Replay record saved but no filename available for processing'
      );

      // No recording filename means this replay can never be processed.
      // Remove only the still-processing row so a broken replay is not
      // left permanently in the database.
      const { error: cleanupRecordError } = await supabase
        .from('livestreams')
        .delete()
        .eq('id', record.id)
        .eq('video_url', 'processing');

      if (cleanupRecordError) {
        console.error(
          '[EGRESS] Failed to remove unprocessable replay record:',
          cleanupRecordError.message
        );
      } else {
        console.log(
          '[EGRESS] Removed unprocessable replay record:',
          record.id
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error(
      '[EGRESS] Stop error:',
      error.message
    );

    res
      .status(500)
      .json({ error: 'Failed to stop recording' });
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
            .screenshots({
              timestamps: ['1'],
              filename: `${workerId}.jpg`,
              folder: '/tmp',
              size: '720x?',
            })
            .on('end', resolve)
            .on('error', reject);
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
        type: 'livestream',
        status: 'approved',
        is_public: true,
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