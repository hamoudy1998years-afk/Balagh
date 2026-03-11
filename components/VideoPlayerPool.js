// components/VideoPlayerPool.js
import { useRef, useCallback } from 'react';

// Global tracker to stop all audio on hot reload
const activeRefs = new Set();

if (module.hot) {
  module.hot.accept(() => {
    activeRefs.forEach(ref => {
      try {
        if (ref?.current) ref.current.seek(0);
      } catch (e) {}
    });
    activeRefs.clear();
  });
}

// Pool of 3 video refs for react-native-video.
// IMPORTANT: play/pause is controlled entirely by the `paused` prop on <Video>
// in VideoCard (isPaused = !isActive || paused || !isTabActive).
// This pool only manages slot rotation and URL tracking — it does NOT
// call setNativeProps to override pause state.
export function useVideoPlayerPool() {
  const player1Ref = useRef(null);
  const player2Ref = useRef(null);
  const player3Ref = useRef(null);

  const playerRefs = useRef([player1Ref, player2Ref, player3Ref]).current;

  // Register refs globally for hot reload cleanup
  playerRefs.forEach(ref => activeRefs.add(ref));

  // Track which ref holds which video URL
  const videoMap = useRef(new Map()).current;

  // Slot indices: which playerRefs index maps to prev/current/next
  const indices = useRef({ prev: 0, current: 1, next: 2 }).current;

  // ── Rotate slots when scrolling down ──────────────────────────────────────
  const scrollNext = useCallback(() => {
    const oldPrev = indices.prev;
    indices.prev = indices.current;
    indices.current = indices.next;
    indices.next = oldPrev;
    // Reset the recycled slot
    const recycledRef = playerRefs[indices.next];
    videoMap.delete(recycledRef);
    try {
      if (recycledRef?.current) recycledRef.current.seek(0);
    } catch (e) {}
  }, [indices, playerRefs, videoMap]);

  // ── Rotate slots when scrolling up ────────────────────────────────────────
  const scrollPrev = useCallback(() => {
    const oldNext = indices.next;
    indices.next = indices.current;
    indices.current = indices.prev;
    indices.prev = oldNext;
    // Reset the recycled slot
    const recycledRef = playerRefs[indices.prev];
    videoMap.delete(recycledRef);
    try {
      if (recycledRef?.current) recycledRef.current.seek(0);
    } catch (e) {}
  }, [indices, playerRefs, videoMap]);

  // ── Get ref for a named slot ───────────────────────────────────────────────
  const getPlayerRef = useCallback((slot) => {
    if (slot === 'prev') return playerRefs[indices.prev];
    if (slot === 'current') return playerRefs[indices.current];
    if (slot === 'next') return playerRefs[indices.next];
    return null;
  }, [indices, playerRefs]);

  // ── Seek a slot to the beginning ──────────────────────────────────────────
  const seekToStart = useCallback((slot) => {
    const ref = getPlayerRef(slot);
    try {
      if (ref?.current) ref.current.seek(0);
    } catch (e) {}
  }, [getPlayerRef]);

  // ── Get the tracked URL for a slot ────────────────────────────────────────
  const getVideoUrl = useCallback((slot) => {
    const ref = getPlayerRef(slot);
    return videoMap.get(ref) ?? null;
  }, [getPlayerRef, videoMap]);

  // ── Assign a URL to a slot and seek it to start ───────────────────────────
  const loadVideo = useCallback((slot, videoUrl) => {
    const ref = getPlayerRef(slot);
    if (!ref) return;
    if (videoMap.get(ref) !== videoUrl) {
      videoMap.set(ref, videoUrl);
      setTimeout(() => {
        try {
          if (ref?.current) ref.current.seek(0);
        } catch (e) {}
      }, 100);
    }
  }, [getPlayerRef, videoMap]);

  // ── playCurrent / pauseAll ─────────────────────────────────────────────────
  // These are intentional no-ops: pause/play is driven entirely by the
  // `paused` prop on <Video> in VideoCard via isTabActive + isActive state.
  // Calling setNativeProps here would fight React's reconciler and cause
  // the "Property does not exist" native errors seen previously.
  const playCurrent = useCallback(() => {
    // No-op: VideoCard's `isPaused` prop handles this reactively
  }, []);

  const pauseAll = useCallback(() => {
    // No-op: VideoCard's `isPaused` prop handles this reactively.
    // Seek all slots to 0 as a best-effort reset on cleanup.
    playerRefs.forEach(ref => {
      try {
        if (ref?.current) ref.current.seek(0);
      } catch (e) {}
    });
  }, [playerRefs]);

  const pauseCurrent = useCallback(() => {
    // No-op: controlled via props
  }, []);

  return {
    getPlayerRef,
    getVideoUrl,
    loadVideo,
    seekToStart,
    scrollNext,
    scrollPrev,
    playCurrent,
    pauseCurrent,
    pauseAll,
    indices,
  };
}