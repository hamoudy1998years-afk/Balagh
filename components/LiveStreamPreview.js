import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Room, RoomEvent, Track } from 'livekit-client';
import { registerGlobals, VideoView } from '@livekit/react-native';
import { supabase } from '../lib/supabase';
import { fetchWithTimeout } from '../utils/apiClient';

const TOKEN_SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL;
const RETRY_DELAY_MS = 8000;

// Returns the current Supabase access token for authenticated Railway
// requests, refreshing first if it is about to expire. Mirrors the proven
// WatchLiveScreen pattern.
async function getAccessToken() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    let accessToken = session?.access_token ?? null;

    if (session?.expires_at && session.expires_at * 1000 < Date.now() + 60 * 1000) {
      const { data } = await supabase.auth.refreshSession();
      accessToken = data?.session?.access_token ?? accessToken;
    }

    return accessToken || null;
  } catch (e) {
    return null;
  }
}

// Lightweight, VIDEO-ONLY, muted LiveKit preview of a livestream.
// Renders nothing until the host's video track is available — the caller is
// expected to keep a thumbnail underneath, which stays visible before the
// preview connects, while connecting, on failure, and when disabled.
export default function LiveStreamPreview({ stream, enabled = true }) {
  const [videoTrack, setVideoTrack] = useState(null);
  const roomRef = useRef(null);
  const setupIdRef = useRef(0);
  const hostIdentityRef = useRef(null);
  const retryTimeoutRef = useRef(null);
  // Guards the single automatic retry: at most ONE retry after an unexpected
  // disconnect per continuous enabled preview lifecycle. Reset each time the
  // effect (re)starts, so a fresh preview lifecycle gets its one retry back.
  const retryUsedRef = useRef(false);

  const channelName = stream?.channel_name ?? null;
  const hostUserId = stream?.user_id ?? null;

  useEffect(() => {
    if (!enabled || !channelName || !hostUserId) return undefined;

    const setupId = setupIdRef.current;
    const isStale = () => setupIdRef.current !== setupId;
    retryUsedRef.current = false;

    async function setup() {
      // Room created by this attempt but not yet adopted into roomRef — must
      // be explicitly disconnected on any failure/stale path below.
      let pendingRoom = null;
      try {
        try { registerGlobals(); } catch (e) {}

        const accessToken = await getAccessToken();
        if (isStale()) return;
        if (!accessToken) return; // stay on thumbnail fallback

        const response = await fetchWithTimeout(`${TOKEN_SERVER_URL}/api/livekit/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            roomName: channelName,
            isHost: false,
          }),
        });
        if (isStale()) return;
        if (!response.ok) throw new Error(`Token server error: ${response.status}`);

        const { token, url } = await response.json();
        if (isStale()) return;

        const room = new Room({ adaptiveStream: true, dynacast: true });
        pendingRoom = room;

        room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (isStale()) return;
          if (track.kind === Track.Kind.Audio) {
            // Preview must stay silent: never attach audio and force volume 0.
            try { track.setVolume?.(0); } catch (e) {}
            return;
          }
          if (
            track.kind === Track.Kind.Video &&
            String(participant.identity) === String(hostUserId)
          ) {
            hostIdentityRef.current = participant.identity;
            setVideoTrack(track);
          }
        });

        room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
          if (isStale()) return;
          if (
            track.kind === Track.Kind.Video &&
            participant.identity === hostIdentityRef.current
          ) {
            setVideoTrack(null);
          }
        });

        room.on(RoomEvent.ParticipantDisconnected, (participant) => {
          if (isStale()) return;
          if (hostIdentityRef.current && participant.identity === hostIdentityRef.current) {
            hostIdentityRef.current = null;
            setVideoTrack(null);
          }
        });

        room.on(RoomEvent.Disconnected, () => {
          if (isStale()) return;
          hostIdentityRef.current = null;
          setVideoTrack(null);
          scheduleRetry();
        });

        await room.connect(url, token);

        // If disabled/stream changed/unmounted while connecting, drop this room.
        if (isStale()) {
          try { await room.disconnect(); } catch (e) {}
          return;
        }

        // Adopt only after the stale guard: roomRef can never be replaced by
        // a stale async setup, and no room is ever double-adopted.
        roomRef.current = room;
        pendingRoom = null;

        // Host may already be publishing when we join.
        for (const participant of room.remoteParticipants.values()) {
          if (String(participant.identity) !== String(hostUserId)) continue;
          for (const publication of participant.trackPublications.values()) {
            if (publication.track && publication.track.kind === Track.Kind.Video) {
              hostIdentityRef.current = participant.identity;
              setVideoTrack(publication.track);
            }
          }
        }
      } catch (e) {
        // A room created before/during a failed setup or connect must not be
        // left orphaned with its listeners installed — disconnect it. Adopted
        // rooms (pendingRoom === null) are owned by roomRef and cleaned up by
        // the effect cleanup instead.
        if (pendingRoom) {
          try { await pendingRoom.disconnect(); } catch (err) {}
          pendingRoom = null;
        }
        if (__DEV__) console.warn('[LivePreview] setup failed:', e?.message);
      }
    }

    // At most ONE gentle retry after an unexpected disconnect — never a loop.
    // A disconnect after that single retry falls back to the thumbnail.
    function scheduleRetry() {
      if (isStale() || retryUsedRef.current || retryTimeoutRef.current) return;
      retryUsedRef.current = true;
      retryTimeoutRef.current = setTimeout(() => {
        retryTimeoutRef.current = null;
        if (!isStale()) setup();
      }, RETRY_DELAY_MS);
    }

    setup();

    return () => {
      setupIdRef.current += 1;
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      const room = roomRef.current;
      roomRef.current = null;
      hostIdentityRef.current = null;
      setVideoTrack(null);
      if (room) {
        try { room.disconnect(); } catch (e) {}
      }
    };
  }, [enabled, channelName, hostUserId]);

  if (!videoTrack) return null;

  return (
    <VideoView
      videoTrack={videoTrack}
      style={styles.video}
      objectFit="cover"
    />
  );
}

const styles = StyleSheet.create({
  video: {
    ...StyleSheet.absoluteFillObject,
  },
});
