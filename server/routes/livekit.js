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

    const requiredStorageEnv = [
      'SUPABASE_S3_KEY_ID',
      'SUPABASE_S3_SECRET',
      'SUPABASE_S3_ENDPOINT',
    ];

    const missingEnv = requiredStorageEnv.filter(
      key => !process.env[key]
    );

    if (missingEnv.length > 0) {
      console.error(
        '[EGRESS] Missing Supabase S3 configuration:',
        missingEnv.join(', ')
      );

      return res
        .status(500)
        .json({ error: 'Recording storage is not configured' });
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
      console.error(
        '[EGRESS] LiveKit returned no egressId:',
        info
      );

      return res
        .status(500)
        .json({ error: 'Recording did not start' });
    }

    console.log(
      '[EGRESS] Recording started:',
      info.egressId,
      filename
    );

    return res.json({
      egressId: info.egressId,
      filename,
    });
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
    const trustedFilename =
      (egressInfo.file &&
        egressInfo.file.filename) ||
      (egressInfo.fileResults &&
        egressInfo.fileResults.length > 0 &&
        egressInfo.fileResults[
          egressInfo.fileResults.length - 1
        ].filename) ||
      null;

    await egressClient.stopEgress(egressId);

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

    const {
      data: record,
      error: dbError,
    } = await supabase
      .from('livestreams')
      .insert({
        user_id: streamRow.user_id,
        video_url: 'processing',
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
    // 30 attempts × 10 seconds = maximum five-minute wait.
    let fileReady = false;

    for (let i = 0; i < 30; i++) {
      await new Promise(resolve =>
        setTimeout(resolve, 10000)
      );

      try {
        const response = await fetch(publicUrl, {
          method: 'HEAD',
        });

        if (response.ok) {
          fileReady = true;

          console.log(
            `[PROCESS] File ready after ${(i + 1) * 10}s`
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
        '[PROCESS] File never appeared in Supabase Storage'
      );

      // The replay row was created with video_url = "processing".
      // Do not leave a permanently broken replay in the database.
      const {
      data: deletedReplay,
      error: cleanupRecordError,
    } = await supabase
      .from('livestreams')
      .delete()
      .eq('id', recordId)
      .eq('video_url', 'processing')
      .select('id')
      .maybeSingle();

    if (cleanupRecordError) {
      console.error(
        '[PROCESS] Failed to remove stuck replay record:',
        cleanupRecordError.message
      );

      return;
    }

    if (deletedReplay) {
      console.log(
        '[PROCESS] Removed stuck replay record:',
        recordId
      );

      await scheduleUnreferencedRecordingCleanup(
        filename
      );
    } else {
      console.warn(
        '[PROCESS] Processing replay row was no longer present; recording cleanup not scheduled:',
        recordId
      );
    }

    return;
  }

  // Generate thumbnail from video.
  let thumbnailUrl = null;

    try {
      const ffmpeg = require('fluent-ffmpeg');

      ffmpeg.setFfmpegPath(
        require('ffmpeg-static')
      );

      const fs = require('fs');

      const tempVideoPath =
        `/tmp/${egressId}.mp4`;

      const tempThumbPath =
        `/tmp/${egressId}.jpg`;

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
              filename: `${egressId}.jpg`,
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
              `${egressId}_thumb.jpg`,
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
              `${egressId}_thumb.jpg`
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