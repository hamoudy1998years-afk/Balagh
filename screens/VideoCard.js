import Video from 'react-native-video';
import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { supabase } from '../lib/supabase';
import CommentsModal from './CommentsModal';
import { useDownload } from '../context/DownloadContext';
import { useUser } from '../context/UserContext';
import { useFocusEffect } from '@react-navigation/native';
import { videoCache } from '../utils/VideoCache';
import { downloadWatermarkedVideoToGallery } from '../utils/videoDownload';
import {
  View, Text, StyleSheet, TouchableOpacity, Share,
  useWindowDimensions, Image, PanResponder, Animated, Linking,
  Pressable, Alert, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { s, ms } from '../utils/responsive';
import { downloadLivestreamReplayToGallery } from '../utils/videoDownload';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import AnimatedButton from './AnimatedButton';
import { logAnalyticsEvent } from '../services/analytics';
import ModernDialog from './ModernDialog';
import { ROUTES } from '../constants/routes';
import { COLORS } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import {
  hasCountedVideoView,
  recordVideoView,
} from '../utils/videoViewTracker';

// __DEV__-only playback diagnostics: timestamped, keyed by video id.
const vdiag = (msg) => {
  __DEV__ && console.log(`[VIDEO DIAG] t=${Date.now()} ${msg}`);
};
const uriKind = (uri) =>
  typeof uri === 'string' && uri.startsWith('file://')
    ? `CACHE:${uri.split('/').pop()}`
    : 'REMOTE';

// Remembers which card is playing now, so HomeScreen can pause it instantly.
export const activeVideoHolder = { player: null, itemId: null, pausedByUs: false };

const DownloadProgressOverlay = React.memo(function DownloadProgressOverlay({ visible, progress, preparing }) {
  if (!visible) return null;
  const pct = Math.round(progress * 100);
  return (
    <View style={styles.dlOverlay} pointerEvents="none">
      <View style={styles.dlBox}>
        <Text style={styles.dlTitle}>{preparing ? '⏳ Preparing video...' : '⬇️ Downloading...'}</Text>
        <View style={styles.dlBarBg}>
          <View style={[styles.dlBarFill, { width: `${pct}%` }]} />
        </View>
        <Text style={styles.dlPercent}>{pct}%</Text>
      </View>
    </View>
  );
});

function VideoCard({
  item, player, isActive, isVisible, isTabActive = true,
  index,
  currentTab,
  initialLiked = false, initialFollowed = false,
  onFollowChange, navigation, cardHeight,
  username: usernameProp,
  avatarUrl: avatarUrlProp,
  isScholar: isScholarProp,
  isTrusted: isTrustedProp,
  onBlocked,
    scrollOpacity,
  }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const safeBottom = insets?.bottom ?? 0;
  const { showVideoOptionsSheet, showTikTokShare } = useDownload();
  const { user: authUser, loading: authLoading, blockedUsers } = useUser();
  const currentUserId = authUser?.id ?? null;

  const [liked, setLiked] = useState(initialLiked);
  const [likeCount, setLikeCount] = useState(item.likes_count ?? 0);
  const [isLiking, setIsLiking] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [followed, setFollowed] = useState(initialFollowed);
  const [isBlocked, setIsBlocked] = useState(false);

  // Always start with the video URL immediately — no null, no black frame
  const [videoUri, setVideoUri] = useState(() => item.video_url ?? null);
  // Protect cached files while this card references them.
  useEffect(() => {
    if (!videoUri?.startsWith('file://')) return;

    videoCache.retainCachedVideo(videoUri);

    return () => {
      videoCache.releaseCachedVideo(videoUri);
    };
  }, [videoUri]);

  // isReady: false = show thumbnail overlay, true = show video
  const [isReady, setIsReady] = useState(false);
  const [isLoadingSignedUrl, setIsLoadingSignedUrl] = useState(false);

  const isVideoReadyRef = useRef(false);
  // True once playback has actually begun. Async cache lookups must never
  // swap the source (remote → local) underneath a running player.
  const playbackStartedRef = useRef(false);
  const pendingCacheUrlRef = useRef(null);
  // Last genuine progress position, for backward-jump detection.
  const lastProgressTimeRef = useRef(null);
  // One-shot flag: log only the FIRST onProgress tick per item.
  const firstProgressLoggedRef = useRef(false);
  // True once this card's current item has been activated at least once.
  // Unlike playbackStartedRef (which preloaded paused cards can set via
  // onProgress), this only flips on real activation — the correct signal
  // for "revisit: seek to 0 for intentional replay".
  const wasActivatedRef = useRef(false);
  const currentItemIdRef = useRef(item.id);
  const isMountedRef = useRef(true);

  useEffect(() => {
    currentItemIdRef.current = item.id;
    wasActivatedRef.current = false;
  }, [item.id]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Upgrade to cached local file silently — never set to null
  useEffect(() => {
    let cancelled = false;

    // Sync immediately so a recycled card never keeps showing a previous
    // item's video while the cache lookup below is still in flight.
    setVideoUri(item.video_url ?? null);
    pendingCacheUrlRef.current = null;

    const loadVideoUri = async () => {
      if (item.video_url?.includes('?')) return;
      if (item.type === 'livestream' || item.video_url?.includes('.m3u8')) return;

      const cachedUri = await videoCache.getCachedVideo(item.video_url);
      if (cancelled) return;
      if (cachedUri) {
        const fileInfo = await FileSystem.getInfoAsync(cachedUri);
        if (cancelled) return;
        if (fileInfo.exists) {
          // If playback already started on the remote URL, keep it — a
          // source swap would restart ExoPlayer from position 0. The cache
          // remains valid for the next time this video mounts.
          if (playbackStartedRef.current) return;
          setVideoUri(cachedUri);
          return;
        }
        await videoCache.removeCachedVideo(item.video_url);
        if (cancelled) return;
        setVideoUri(item.video_url);
      }
      pendingCacheUrlRef.current = item.video_url;
    };

    if (item.id && item.video_url) {
      loadVideoUri();
    }

    return () => { cancelled = true; };
  }, [item.id, item.video_url, item.type]);

  const previousVideoUriRef = useRef(videoUri);
  useEffect(() => {
    if (previousVideoUriRef.current !== videoUri) {
      vdiag(`videoId=${item.id} sourceChange ${uriKind(previousVideoUriRef.current)} -> ${uriKind(videoUri)}`);
      previousVideoUriRef.current = videoUri;
      isVideoReadyRef.current = false;
      setIsReady(false);
    }
  }, [videoUri]);

  useEffect(() => {
    let cancelled = false;
    async function checkBlocked() {
      if (!currentUserId || !item.user_id) return;
      const { data } = await supabase
        .from('blocks')
        .select('id')
        .eq('blocker_id', currentUserId)
        .eq('blocked_id', item.user_id)
        .maybeSingle();
      if (!cancelled) setIsBlocked(!!data);
    }
    checkBlocked();
    return () => { cancelled = true; };
  }, [currentUserId, item.user_id]);

  const [paused, setPaused] = useState(false);
  const [showHeart, setShowHeart] = useState(false);
  const [showPauseIcon, setShowPauseIcon] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showProgress, setShowProgress] = useState(true);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const [isDownloading, setIsDownloading] = useState(false);
  const durationRef = useRef(0);
  const playerRef = useRef(null);
  const isSeeking = useRef(false);
  const progressBarRef = useRef(null);
  const lastSeekTime = useRef(0);
  const dragStartPageX = useRef(0);
  const dragStartPct = useRef(0);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadPreparing, setDownloadPreparing] = useState(false);
  const [hasDownloaded, setHasDownloaded] = useState(false);
  const [showReportSheet, setShowReportSheet] = useState(false);
  const [showFullCaption, setShowFullCaption] = useState(false);
  const manualPauseRef = useRef(false);
  const isFollowLoading = useRef(false);
  const viewWatchTimeRef = useRef(0);
  const lastViewProgressRef = useRef(null);
  const viewCountTriggeredRef = useRef(false);
  const analyticsSentMsRef = useRef(0);   // watch time already reported to Firebase (non-overlapping)
  const viewedFiredRef = useRef(false);   // Firebase video_viewed dedup
  const analyticsVideoIdRef = useRef(item.id); // video id the current refs belong to

  // Bounded automatic recovery from ExoPlayer source errors (e.g. EOFException).
  const playbackRetryCountRef = useRef(0);
  const playbackRetryTimeoutRef = useRef(null);
  // Watch-time marker: retries re-arm only after ≥3s of genuinely accumulated
  // playback since the last recovery, never merely from onReadyForDisplay.
  const playbackRecoveredAtRef = useRef(0);
  const isActiveRef = useRef(isActive);
  const isTabActiveRef = useRef(isTabActive);
  const pausedRef = useRef(paused);
  const [playbackReloadKey, setPlaybackReloadKey] = useState(0);
  // TEMPORARY __DEV__-only native playback/stall diagnostics.
  const nativeBufferingDiagRef = useRef(null);
  const nativePlaybackDiagRef = useRef({ isPlaying: null, isSeeking: null });
  const stallProbeRef = useRef({ lastPos: null, lastAdvanceAt: 0, startedAt: 0, stalled: false });
  const PLAYBACK_MAX_RETRIES = 2;
  const PLAYBACK_RETRY_DELAY_MS = 1500;
  const RETRY_REARM_PLAY_SECONDS = 3;

  const isUserBlocked = blockedUsers?.has(item.user_id);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  // ── PLAY/PAUSE LOGIC ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!isActive) {
      vdiag(`videoId=${item.id} isActive=false (deactivated)`);
      manualPauseRef.current = false;
      setPaused(true);
      setCurrentTime(0);
      progressAnim.setValue(0);
      // DO NOT reset isReady — prevents flicker when scrolling back
    } else {
      const revisit = wasActivatedRef.current;
      vdiag(`videoId=${item.id} isActive=true reason=activate seek0=${revisit} (wasActivated)`);
      manualPauseRef.current = false;
      // Seek to 0 only when this item was activated before (revisit): the
      // pooled player may hold a nonzero position and replay is intended.
      // On first activation a fresh player already starts at 0, and a
      // redundant seek can race playback on slow devices (late restart).
      if (revisit) {
        try {
          if (player?.current?.seek) {
            player.current.seek(0);
          }
        } catch (e) {}
      }
      wasActivatedRef.current = true;
      activeVideoHolder.player = player?.current ?? null;
      activeVideoHolder.itemId = item.id;
      activeVideoHolder.pausedByUs = false;
      setPaused(false);
    }
  }, [isActive]);

  // TEMPORARY __DEV__ handoff timing (A→B delay investigation).
  // Same wall clock (Date.now) as all other [VIDEO DIAG] lines.
  // renderStart fires when a render with a CHANGED isActive begins
  // (transition-guarded to avoid per-render flooding). COMMIT fires in
  // useLayoutEffect, synchronously after React's host-tree mutation for
  // this commit — it marks the JS-side commit boundary and the moment the
  // paused prop batch has been ENQUEUED to native, not when ExoPlayer has
  // applied anything (native pause completion is NOT measurable here).
  const renderProbeIsActiveRef = useRef(isActive);
  if (renderProbeIsActiveRef.current !== isActive) {
    renderProbeIsActiveRef.current = isActive;
    vdiag(`videoId=${item.id} renderStart isActive=${isActive}`);
  }
  useLayoutEffect(() => {
    vdiag(`videoId=${item.id} COMMIT isActive=${isActive} effPaused=${!isActive || !isTabActive || paused}`);
  }, [isActive]);

  useEffect(() => {
    __DEV__ && console.log('[LEAK DEBUG] VideoCard isTabActive changed:', isTabActive, 'item:', item.id, 'isActive:', isActive);
    if (isTabActive) {
      if (isActive) {
        vdiag(`videoId=${item.id} isTabActive=true isActive=true reason=tab-activate seek0`);
        manualPauseRef.current = false;
        setPaused(false);
        try {
          if (player?.current?.seek) {
            player.current.seek(0);
          }
        } catch (e) {}
      } else {
        vdiag(`videoId=${item.id} isTabActive=true isActive=false resume-without-seek`);
        manualPauseRef.current = false;
        setPaused(false);
      }
    } else {
      vdiag(`videoId=${item.id} isTabActive=false (tab hidden)`);
      setPaused(true);
      if (isActive) {
        try {
          if (player?.current?.seek) {
            player.current.seek(0);
          }
        } catch (e) {}
      }
    }
  }, [isTabActive]);

  // Player slot reassignment (player pool rotation) — no seek here by design.
  useEffect(() => {
    vdiag(`videoId=${item.id} playerRefChanged hasRef=${!!player}`);
  }, [player]);

  useFocusEffect(
    useCallback(() => {
      // Resume the active video when returning to the feed.
      if (isActive && isTabActive) {
        manualPauseRef.current = false;
        setPaused(false);
      }

      return () => {
        setPaused(true);
        manualPauseRef.current = false;
      };
    }, [isActive, isTabActive])
  );

  useEffect(() => {
    const { DeviceEventEmitter } = require('react-native');
    const sub = DeviceEventEmitter.addListener('pauseAllVideos', () => {
      setPaused(true);
      manualPauseRef.current = false;
    });
    return () => sub.remove();
  }, []);

  // ─────────────────────────────────────────────────────────────────────────

  const [dialog, setDialog] = useState({
    visible: false, title: '', message: '', type: 'info', buttons: []
  });
  const [isDragging, setIsDragging] = useState(false);
  const barOpacity = useRef(new Animated.Value(0)).current;

  const username = usernameProp ?? 'user';
  const avatarUrl = avatarUrlProp ?? null;
  const isScholar = isScholarProp ?? item.profiles?.is_scholar ?? false;
  const isTrusted = isTrustedProp ?? item.profiles?.trusted_user ?? false;

  useEffect(() => { setLiked(initialLiked); }, [item.id, initialLiked]);
  useEffect(() => { setLikeCount(item.likes_count ?? 0); }, [item.id]);
  useEffect(() => { setFollowed(initialFollowed); }, [item.id, initialFollowed]);
  useEffect(() => { setHasDownloaded(false); }, [item.id]);
  useEffect(() => {
    setDuration(0);
    durationRef.current = 0;
  }, [item.id]);
  useEffect(() => {
    // Flush any unreported watch time under the OLD video id before reset.
    flushAnalyticsWatchTime(analyticsVideoIdRef.current);

    viewWatchTimeRef.current = 0;
    lastViewProgressRef.current = null;
    analyticsSentMsRef.current = 0;
    viewedFiredRef.current = false;
    analyticsVideoIdRef.current = item.id;
    // Firebase video_viewed dedup is keyed to the video, not the user, so a
    // mid-session login cannot make it fire twice for the same viewing.
  }, [item.id]);

  // Playback-error recovery: reset per video, cancel when the card stops being
  // the active playback surface, and never leak the retry timer.
  const clearPlaybackRetry = useCallback(() => {
    if (playbackRetryTimeoutRef.current) {
      clearTimeout(playbackRetryTimeoutRef.current);
      playbackRetryTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    playbackRetryCountRef.current = 0;
    playbackRecoveredAtRef.current = 0;
    playbackStartedRef.current = false;
    lastProgressTimeRef.current = null;
    firstProgressLoggedRef.current = false;
    setPlaybackReloadKey(0);
    clearPlaybackRetry();
  }, [item.id, clearPlaybackRetry]);

  // Keep fire-time-checkable copies of the playback surface state.
  useEffect(() => {
    isActiveRef.current = isActive;
    isTabActiveRef.current = isTabActive;
    pausedRef.current = paused;
  });

  useEffect(() => {
    if (!isActive || !isTabActive || paused) {
      clearPlaybackRetry();
    }
  }, [isActive, isTabActive, paused, clearPlaybackRetry]);

  useEffect(() => () => clearPlaybackRetry(), [clearPlaybackRetry]);

  // Effective pause is the exact value passed to <Video paused={...}>.
  useEffect(() => {
    if (!__DEV__) return;
    vdiag(`videoId=${item.id} commandedPause=${!isActive || !isTabActive || paused} isActive=${isActive} isTabActive=${isTabActive} localPaused=${paused} source=${uriKind(videoUri)}`);
  }, [item.id, isActive, isTabActive, paused, videoUri]);

  // Poll only the genuinely active playing card. No native commands are issued.
  useEffect(() => {
    if (!__DEV__) return;
    nativeBufferingDiagRef.current = null;
    nativePlaybackDiagRef.current = { isPlaying: null, isSeeking: null };
    stallProbeRef.current = { lastPos: null, lastAdvanceAt: 0, startedAt: 0, stalled: false };

    if (!isActive || !isTabActive || paused || !isReady || !videoUri || isDragging) return;

    const intervalId = setInterval(() => {
      if (isSeeking.current || nativePlaybackDiagRef.current.isSeeking === true) return;
      const probe = stallProbeRef.current;
      if (probe.lastAdvanceAt === 0 || probe.stalled) return;
      const elapsedMs = Date.now() - probe.lastAdvanceAt;
      if (elapsedMs >= 1500) {
        probe.stalled = true;
        probe.startedAt = Date.now();
        vdiag(`videoId=${item.id} STALL_START elapsedMs=${elapsedMs} pos=${probe.lastPos} buffering=${nativeBufferingDiagRef.current} nativePlaying=${nativePlaybackDiagRef.current.isPlaying} nativeSeeking=${nativePlaybackDiagRef.current.isSeeking} source=${uriKind(videoUri)}`);
      }
    }, 250);

    return () => {
      clearInterval(intervalId);
      stallProbeRef.current = { lastPos: null, lastAdvanceAt: 0, startedAt: 0, stalled: false };
    };
  }, [item.id, videoUri, playbackReloadKey, isActive, isTabActive, paused, isReady, isDragging]);
  // Supabase view counting stays per-user: re-evaluate the session count
  // whenever the video or the signed-in identity changes.
  useEffect(() => {
    viewCountTriggeredRef.current = hasCountedVideoView(
      item.id,
      currentUserId
    );
  }, [item.id, currentUserId]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => {
    if (player?.current) {
      playerRef.current = player.current;
    }
  }, [player?.current]);

  useEffect(() => {
    if (paused || isDragging) {
      Animated.timing(barOpacity, {
        toValue: 1, duration: 100, useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(barOpacity, {
        toValue: 0, duration: 250, useNativeDriver: true,
      }).start();
    }
  }, [paused, isDragging]);

  useEffect(() => {
    const channel = supabase
      .channel(`video-${item.id}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'videos', filter: `id=eq.${item.id}` },
        (payload) => { setLikeCount(payload.new.likes_count); }
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [item.id]);

  const requireAuth = useCallback(() => {
    if (authLoading) return false;
    if (!currentUserId) {
      setDialog({
        visible: true,
        title: 'Join Bushrann',
        message: 'Login or create an account to interact with content.',
        type: 'info',
        buttons: [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Login', onPress: () => navigation.navigate(ROUTES.LOGIN) },
        ]
      });
      return false;
    }
    return true;
  }, [currentUserId, authLoading, navigation]);

  const lastTap = useRef(null);
  const tapTimer = useRef(null);

  const progressBarWidth = useRef(0);
  const updateProgressBarUI = (pct) => {
    const safePct = Math.max(0, Math.min(1, pct));
    progressAnim.setValue(safePct);
  };
  const onProgressBarLayout = (e) => {
    const { width } = e.nativeEvent.layout;
    progressBarWidth.current = width;
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponderCapture: (_, gestureState) => Math.abs(gestureState.dx) > 1,
      onPanResponderTerminationRequest: () => false,

      onPanResponderGrant: (evt) => {
        setIsDragging(true);
        isSeeking.current = true;
        manualPauseRef.current = true;
        setPaused(true);
        dragStartPageX.current = evt.nativeEvent.pageX;
        dragStartPct.current = progressAnim.__getValue();
      },

      onPanResponderMove: (evt) => {
        if (!(progressBarWidth.current > 0)) return;
        const delta = (evt.nativeEvent.pageX - dragStartPageX.current) / progressBarWidth.current;
        const newPct = Math.max(0, Math.min(1, dragStartPct.current + delta * 1.0));
        updateProgressBarUI(newPct);
        const now = Date.now();
        if (now - lastSeekTime.current > 100) {
          seekToPosition(newPct);
          lastSeekTime.current = now;
        }
      },

      onPanResponderRelease: (evt) => {
        if (!(progressBarWidth.current > 0)) {
          isSeeking.current = false;
          manualPauseRef.current = false;
          setPaused(false);
          setIsDragging(false);
          return;
        }
        const delta = (evt.nativeEvent.pageX - dragStartPageX.current) / progressBarWidth.current;
        const newPct = Math.max(0, Math.min(1, dragStartPct.current + delta * 1.0));
        updateProgressBarUI(newPct);
        seekToPosition(newPct);
        isSeeking.current = false;
        manualPauseRef.current = false;
        setPaused(false);
        setIsDragging(false);
      },

      onPanResponderTerminate: () => {
        isSeeking.current = false;
        setPaused(false);
        setIsDragging(false);
      },
    })
  ).current;

  const seekToPosition = (percentage) => {
    const dur = durationRef.current;
    if (dur === 0) return;
    const newTime = percentage * dur;
    progressAnim.setValue(percentage);
    setCurrentTime(newTime);
    if (playerRef.current && isVideoReadyRef.current) {
      playerRef.current.seek(newTime);
    }
  };

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    return () => {
      if (tapTimer.current) clearTimeout(tapTimer.current);
    };
  }, [player]);

  const handleLike = useCallback(async () => {
    if (!requireAuth() || isLiking) return;
    setIsLiking(true);
    const newLiked = !liked;
    const countChange = newLiked ? 1 : -1;
    setLiked(newLiked);
    setLikeCount(prev => prev + countChange);
    try {
      if (newLiked) {
        const { error } = await supabase.from('likes').insert({ user_id: currentUserId, video_id: item.id });
        if (error) throw error;
      } else {
        const { error } = await supabase.from('likes').delete().match({ user_id: currentUserId, video_id: item.id });
        if (error) throw error;
      }
    } catch (error) {
      __DEV__ && console.log('Like error:', error);
      setLiked(liked);
      setLikeCount(prev => prev - countChange);
    } finally {
      setIsLiking(false);
    }
  }, [liked, item, requireAuth, currentUserId, isLiking]);

  const handleFollow = useCallback(async () => {
    if (!requireAuth() || !currentUserId || currentUserId === item.user_id || isFollowLoading.current) return;
    isFollowLoading.current = true;
    const previousFollowed = followed;
    const newFollowed = !followed;
    setFollowed(newFollowed);
    if (onFollowChange) onFollowChange(item.user_id, newFollowed);
    const { DeviceEventEmitter } = require('react-native');
    DeviceEventEmitter.emit('followChanged', { userId: item.user_id, isFollowing: newFollowed });
    try {
      if (previousFollowed) {
        const { error } = await supabase.from('follows').delete().eq('follower_id', currentUserId).eq('following_id', item.user_id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('follows').insert({ follower_id: currentUserId, following_id: item.user_id });
        if (error) throw error;
      }
    } catch (error) {
      __DEV__ && console.log('Follow error:', error);
      setFollowed(previousFollowed);
      if (onFollowChange) onFollowChange(item.user_id, previousFollowed);
      DeviceEventEmitter.emit('followChanged', { userId: item.user_id, isFollowing: previousFollowed });
    } finally {
      isFollowLoading.current = false;
    }
  }, [followed, item, currentUserId, onFollowChange, requireAuth]);

  const handleTap = useCallback(() => {
    const now = Date.now();
    if (lastTap.current && now - lastTap.current < 300) {
      clearTimeout(tapTimer.current);
      lastTap.current = null;
      handleLike();
      setShowHeart(true);
      setShowPauseIcon(false);
      setTimeout(() => setShowHeart(false), 800);
    } else {
      lastTap.current = now;
      tapTimer.current = setTimeout(() => {
        setPaused(prev => {
          const newPaused = !prev;
          manualPauseRef.current = newPaused;
          setShowPauseIcon(true);
          if (!newPaused) {
            setTimeout(() => setShowPauseIcon(false), 800);
          }
          return newPaused;
        });
        lastTap.current = null;
      }, 300);
    }
  }, [handleLike]);

  const handleDownloadVideo = useCallback(async () => {
    if (hasDownloaded) return;
    const downloadItemId = item.id;
    const isStillRelevant = () => isMountedRef.current && currentItemIdRef.current === downloadItemId;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        if (isStillRelevant()) {
          setDialog({
            visible: true, title: 'Permission Required',
            message: 'Please allow access to your media library to download videos.',
            type: 'warning',
            buttons: [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings(), style: 'destructive' },
            ]
          });
        }
        return;
      }
      if (isStillRelevant()) {
        setIsDownloading(true);
        setDownloadProgress(0);
      }
      await (item.type === 'livestream'
        ? downloadLivestreamReplayToGallery
        : downloadWatermarkedVideoToGallery)(item, {
        onProgress: (progress) => {
          if (isStillRelevant()) setDownloadProgress(progress);
        },
        onPreparingChange: (preparing) => {
          if (isStillRelevant()) setDownloadPreparing(preparing);
        },
      });
      if (isStillRelevant()) {
        setIsDownloading(false);
        setDownloadPreparing(false);
        setHasDownloaded(true);
        setDialog({ visible: true, title: 'Downloaded ✅', message: 'Video saved to your gallery!', type: 'success', buttons: [{ text: 'OK' }] });
      }
    } catch (e) {
      if (isStillRelevant()) {
        setIsDownloading(false);
        setDownloadPreparing(false);
        setDialog({ visible: true, title: 'Error', message: e?.message || 'Could not download the video. Please try again.', type: 'error', buttons: [{ text: 'OK' }] });
      }
      __DEV__ && console.error('Download error:', e);
    }
  }, [item, hasDownloaded]);

  const handleReport = useCallback(async (reason) => {
    if (!currentUserId) return;
    try {
      const { error } = await supabase.from('reports').insert({ reporter_id: currentUserId, reported_user_id: item.user_id, video_id: item.id, reason });
      if (error) throw error;
      setShowReportSheet(false);
      setDialog({ visible: true, title: 'Report Submitted ✅', message: 'Thanks for reporting. We will review this video.', type: 'success', buttons: [{ text: 'OK' }] });
    } catch (error) {
      __DEV__ && console.log('Report error:', error);
      setShowReportSheet(false);
      setDialog({ visible: true, title: 'Error', message: 'Could not submit report. Please try again.', type: 'error', buttons: [{ text: 'OK' }] });
    }
  }, [currentUserId, item]);

  const handleBlockUser = useCallback(async () => {
    if (!currentUserId || !item.user_id) return;
    try {
      const { error } = await supabase.from('blocks').insert({ blocker_id: currentUserId, blocked_id: item.user_id });
      if (error) throw error;
      setIsBlocked(true);
      setDialog({ visible: true, title: 'Blocked 🚫', message: 'You have blocked this user. Their content will no longer appear in your feed.', type: 'success', buttons: [{ text: 'OK', onPress: () => onBlocked?.(index) }] });
    } catch (error) {
      console.error('Block error:', error);
      setDialog({ visible: true, title: 'Error', message: 'Could not block user. Please try again.', type: 'error', buttons: [{ text: 'OK' }] });
    }
  }, [currentUserId, item.user_id, index, onBlocked]);

  const handleLongPress = useCallback(() => {
    if (!showVideoOptionsSheet) return;
    showVideoOptionsSheet(item, false, hasDownloaded, {
      onDownload: handleDownloadVideo,
      onPin: null,
      onDelete: null,
      onBlock: handleBlockUser,
    }, currentUserId, navigation);
  }, [
    showVideoOptionsSheet,
    item,
    hasDownloaded,
    handleDownloadVideo,
    handleBlockUser,
    currentUserId,
    navigation,
  ]);

  const handleNavigateUserProfile = useCallback(() => {
    navigation.navigate(ROUTES.USER_PROFILE, { profileUserId: item.user_id });
  }, [navigation, item.user_id]);

  const handleOpenComments = useCallback(() => {
    if (requireAuth()) setShowComments(true);
  }, [requireAuth]);

  const handleOpenReportSheet = useCallback(() => setShowReportSheet(true), []);
  // Reports only watch time accumulated since the last flush, so summing
  // video_watch_time events never double-counts a millisecond.
  const flushAnalyticsWatchTime = useCallback((videoId) => {
    const totalMs = Math.round(viewWatchTimeRef.current * 1000);
    const deltaMs = totalMs - analyticsSentMsRef.current;
    if (!videoId || deltaMs <= 0) return;
    analyticsSentMsRef.current = totalMs;
    logAnalyticsEvent('video_watch_time', {
      video_id: String(videoId),
      watched_ms: deltaMs,
    });
  }, []);

  // Final flush when the card is truly unmounted.
  useEffect(() => () => flushAnalyticsWatchTime(analyticsVideoIdRef.current), [flushAnalyticsWatchTime]);

  const trackVideoViewProgress = useCallback((current) => {
    if (!Number.isFinite(current)) return;

    if (item.type === 'livestream' || item.video_url?.includes('.m3u8')) {
      return;
    }

    if (currentUserId && currentUserId === item.user_id) {
      return;
    }

    if (
      !isActive ||
      !isTabActive ||
      paused ||
      isSeeking.current
    ) {
      lastViewProgressRef.current = current;
      return;
    }

    const previous = lastViewProgressRef.current;
    lastViewProgressRef.current = current;

    if (previous === null) return;

    const delta = current - previous;

    if (delta > 0 && delta <= 1) {
      viewWatchTimeRef.current += delta;
    }

    // Supabase view counter — unchanged: fires once at >=3s of actual playback.
    if (!viewCountTriggeredRef.current && viewWatchTimeRef.current >= 3) {
      viewCountTriggeredRef.current = true;

      recordVideoView(item.id, currentUserId).then((success) => {
        if (!success) {
          viewCountTriggeredRef.current = hasCountedVideoView(
            item.id,
            currentUserId
          );
        }
      });
    }

    // Firebase video_viewed — independent: once at >=5s of actual playback.
    if (!viewedFiredRef.current && viewWatchTimeRef.current >= 5) {
      viewedFiredRef.current = true;
      logAnalyticsEvent('video_viewed', { video_id: String(item.id) });
    }
  }, [
    item.id,
    item.user_id,
    item.type,
    item.video_url,
    currentUserId,
    isActive,
    isTabActive,
    paused,
  ]);

  const avatarLetter = username[0]?.toUpperCase() ?? '?';
  const hashtags = item.caption?.match(/#\w+/g) ?? [];
  const captionText = item.caption?.replace(/#\w+/g, '').trim() ?? '';

  return (
    <Animated.View style={[styles.card, { height: cardHeight, opacity: isUserBlocked ? 0 : 1 }]}>

      {/* Thumbnail — always rendered, hides once video is ready */}
      <Image
        source={{ uri: item.thumbnail_url ?? '' }}
        style={[styles.video, { zIndex: 1, opacity: isReady ? 0 : 1, backgroundColor: '#000' }]}
        resizeMode="contain"
      />

      {/* Video — invisible until onReadyForDisplay fires */}
      {videoUri ? (
        <Video
          key={playbackReloadKey}
          ref={player}
          source={{ uri: videoUri }}
          onReadyForDisplay={() => {
            isVideoReadyRef.current = true;
            setIsReady(true);
            // Confirmed ready: mark the watch-time baseline for re-arming
            // retries. The counter itself is NOT reset here — it re-arms in
            // onError only after ≥3s of genuinely accumulated playback.
            playbackRecoveredAtRef.current = viewWatchTimeRef.current;
            clearPlaybackRetry();
          }}
          style={[styles.video, { zIndex: 2, opacity: isReady ? 1 : 0 }]}
          resizeMode="contain"
          repeat={true}
          paused={!isActive || !isTabActive || paused}
          muted={false}
          playInBackground={false}
          playWhenInactive={false}
          ignoreSilentSwitch="ignore"
          progressUpdateInterval={500}
          bufferConfig={{
            minBufferMs: 5000,
            maxBufferMs: 10000,
            bufferForPlaybackMs: 500,
            bufferForPlaybackAfterRebufferMs: 3000,
          }}
          onBuffer={(event) => {
            if (!__DEV__) return;
            const value = event?.isBuffering;
            if (typeof value !== 'boolean' || nativeBufferingDiagRef.current === value) return;
            nativeBufferingDiagRef.current = value;
            vdiag(`videoId=${item.id} nativeBuffering=${value} active=${isActiveRef.current} commandedPause=${!isActiveRef.current || !isTabActiveRef.current || pausedRef.current} source=${uriKind(videoUri)}`);
          }}
          onPlaybackStateChanged={(event) => {
            if (!__DEV__) return;
            const nextPlaying = typeof event?.isPlaying === 'boolean' ? event.isPlaying : null;
            const nextSeeking = typeof event?.isSeeking === 'boolean' ? event.isSeeking : null;
            const prior = nativePlaybackDiagRef.current;
            if (prior.isPlaying === nextPlaying && prior.isSeeking === nextSeeking) return;
            nativePlaybackDiagRef.current = { isPlaying: nextPlaying, isSeeking: nextSeeking };
            vdiag(`videoId=${item.id} nativePlaying=${nextPlaying} nativeSeeking=${nextSeeking} buffering=${nativeBufferingDiagRef.current} commandedPause=${!isActiveRef.current || !isTabActiveRef.current || pausedRef.current} source=${uriKind(videoUri)}`);
          }}
          onError={(e) => {
            __DEV__ && console.log('Video error:', e);
            __DEV__ && (() => {
              const isCached = typeof videoUri === 'string' && videoUri.startsWith('file://');
              const basename = isCached ? videoUri.split('/').pop() : null;
              const errCode = e?.error?.errorCode ?? e?.error?.code ?? 'unknown';
              const errMsg = e?.error?.errorString ?? e?.error?.message ?? JSON.stringify(e?.error ?? e);
              console.log(
                `[VIDEO DIAG] onError videoId=${item.id} source=${isCached ? 'CACHE' : 'REMOTE'}` +
                (basename ? ` file=${basename}` : '') +
                ` code=${errCode} msg=${errMsg} retryCount=${playbackRetryCountRef.current}`
              );
            })();
            isVideoReadyRef.current = false;
            // Bounded recovery: only for the active, playing surface, max 2
            // retries per failure sequence with a short delay. Remounting via
            // key releases the failed native player as the replacement mounts.
            if (!isActive || !isTabActive || paused || !videoUri) return;
            clearPlaybackRetry();
            // Re-arm only after genuinely sustained playback (≥3s accumulated
            // watch time since the last recovery), at most once per period.
            if (
              viewWatchTimeRef.current - playbackRecoveredAtRef.current >=
              RETRY_REARM_PLAY_SECONDS
            ) {
              playbackRetryCountRef.current = 0;
              playbackRecoveredAtRef.current = viewWatchTimeRef.current;
            }
            if (playbackRetryCountRef.current >= PLAYBACK_MAX_RETRIES) return;
            playbackRetryCountRef.current += 1;
            playbackRetryTimeoutRef.current = setTimeout(() => {
              playbackRetryTimeoutRef.current = null;
              if (!isMountedRef.current) return;
              // Fire-time guard against stale closures: skip if the surface
              // became paused/inactive during the delay window.
              if (
                !isActiveRef.current ||
                !isTabActiveRef.current ||
                pausedRef.current
              ) {
                return;
              }
              // If the failed source was the cached local file, fall back to
              // the remote URL so the same invalid file is never retried.
              if (
                videoUri !== item.video_url &&
                item.video_url &&
                !item.video_url.includes('?')
              ) {
                setVideoUri(item.video_url);
              }
              setPlaybackReloadKey((k) => k + 1);
              vdiag(`videoId=${item.id} remount reason=error-retry retryCount=${playbackRetryCountRef.current}`);
            }, PLAYBACK_RETRY_DELAY_MS);
          }}
          onLoad={(data) => {

            if (data?.duration && data.duration > 0 && data.duration < 86400) {
              setDuration(data.duration);
              durationRef.current = data.duration;
              isVideoReadyRef.current = true;
            } else {
              isVideoReadyRef.current = true;
            }
          }}
          onSeek={(e) => {
            vdiag(`videoId=${item.id} onSeek current=${e?.currentTime} seekTo=${e?.seekTime} isActive=${isActiveRef.current} paused=${pausedRef.current}`);
          }}
          onProgress={(data) => {

            if (isSeeking.current) return;

            const current = Number(data?.currentTime);
            if (__DEV__ && isActive && isTabActive && !paused && isReady && !isDragging && !isSeeking.current && Number.isFinite(current)) {
              const probe = stallProbeRef.current;
              const now = Date.now();
              const progressed = probe.lastPos === null || current > probe.lastPos + 0.03 || current < probe.lastPos - 0.5;
              if (progressed) {
                if (probe.stalled) {
                  vdiag(`videoId=${item.id} STALL_END durationMs=${now - probe.startedAt} totalNoAdvanceMs=${now - probe.lastAdvanceAt} pos=${current} buffering=${nativeBufferingDiagRef.current} nativePlaying=${nativePlaybackDiagRef.current.isPlaying} source=${uriKind(videoUri)}`);
                }
                probe.lastPos = current;
                probe.lastAdvanceAt = now;
                probe.startedAt = 0;
                probe.stalled = false;
              }
            }

            trackVideoViewProgress(current);
            const seekableDuration = Number(data?.seekableDuration);
            let effectiveDuration = durationRef.current;

            // Some Android/video-container combinations can report an inaccurate
            // onLoad duration. Once playback exposes a valid seekableDuration,
            // allow it to correct a clearly inconsistent duration.
            if (
              Number.isFinite(seekableDuration) &&
              seekableDuration > 0 &&
              seekableDuration < 86400
            ) {
              const currentDuration = durationRef.current;

              const shouldCorrectDuration =
                currentDuration <= 0 ||
                Math.abs(seekableDuration - currentDuration) >
                  Math.max(2, currentDuration * 0.05);

              if (shouldCorrectDuration) {
                durationRef.current = seekableDuration;
                setDuration(seekableDuration);
                effectiveDuration = seekableDuration;
              }
            }

            if (
              Number.isFinite(current) &&
              current >= 0 &&
              effectiveDuration > 0
            ) {
              // Detect backward jumps during the first seconds of playback
              // (0.1–5s window), threshold 0.1s, without per-tick logging.
              if (
                lastProgressTimeRef.current !== null &&
                lastProgressTimeRef.current >= 0.1 &&
                lastProgressTimeRef.current <= 5 &&
                current < lastProgressTimeRef.current - 0.1
              ) {
                vdiag(`videoId=${item.id} backwardJump from=${lastProgressTimeRef.current.toFixed(2)} to=${current.toFixed(2)}`);
              }
              lastProgressTimeRef.current = current;
              if (!firstProgressLoggedRef.current) {
                firstProgressLoggedRef.current = true;
                vdiag(`videoId=${item.id} firstProgress pos=${current.toFixed(2)} isActive=${isActive} paused=${paused || !isActive || !isTabActive} source=${uriKind(videoUri)}`);
              }
              playbackStartedRef.current = true;
              if (
                pendingCacheUrlRef.current &&
                isActive &&
                isTabActive &&
                !paused &&
                current >= 2
              ) {
                const urlToCache = pendingCacheUrlRef.current;
                pendingCacheUrlRef.current = null;
                videoCache.cacheVideo(urlToCache);
              }
              setCurrentTime(current);

              const progress = Math.max(
                0,
                Math.min(1, current / effectiveDuration)
              );

              progressAnim.setValue(progress);
            }
          }}
          useTextureView={true}
        />
      ) : (
        <View style={[styles.video, { zIndex: 2, backgroundColor: '#000' }]} />
      )}

      {/* Full-screen tap area */}
      <Pressable
        style={[StyleSheet.absoluteFill, { zIndex: 3 }]}
        onPress={handleTap}
        onLongPress={handleLongPress}
        delayLongPress={400}
        activeOpacity={1}
      />

      {showHeart && (
        <View style={styles.heartOverlay}><Text style={styles.heartIcon}>❤️</Text></View>
      )}
      {showPauseIcon && paused && (
        <View style={styles.pauseOverlay}>
          <Ionicons name="play" size={60} color="#ffffff" style={{ opacity: 0.9 }} />
        </View>
      )}

      <Animated.View style={[styles.overlay, { bottom: safeBottom + s(95), opacity: scrollOpacity ?? 1 }]}>
        <AnimatedButton onPress={handleNavigateUserProfile}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.username}>{username}</Text>
            {isScholar && (
              <View style={styles.goldBadge}>
                <Text style={styles.goldBadgeText}>✓ Scholar</Text>
              </View>
            )}
            {!isScholar && isTrusted && (
              <View style={styles.blueBadge}>
                <Text style={styles.blueBadgeText}>✓ Trusted</Text>
              </View>
            )}
            {!isScholar && !isTrusted && (
              <View style={[styles.blueBadge, { backgroundColor: '#2563eb' }]}>
                <Text style={styles.blueBadgeText}>Community</Text>
              </View>
            )}
          </View>
        </AnimatedButton>

        {captionText ? (
          <Pressable onPress={() => setShowFullCaption(prev => !prev)} style={{ marginBottom: 4 }}>
            <Text style={styles.caption} numberOfLines={showFullCaption ? undefined : 2} ellipsizeMode="tail">
              {captionText}
            </Text>
            {captionText.length > 80 && (
              <Text style={styles.captionMore}>{showFullCaption ? 'less ↑' : 'more ↓'}</Text>
            )}
          </Pressable>
        ) : null}

        {hashtags.length > 0 && (
          <View style={styles.hashtagsRow}>
            {hashtags.map((tag, i) => <Text key={i} style={styles.hashtag}>{tag}</Text>)}
          </View>
        )}
      </Animated.View>

      <Animated.View style={[styles.actions, { bottom: safeBottom + s(100), opacity: scrollOpacity ?? 1 }]}>
        <View style={styles.creatorContainer}>
          <AnimatedButton onPress={handleNavigateUserProfile}>
            <View style={[styles.creatorAvatar, followed && styles.creatorAvatarFollowed]}>
              {avatarUrl
                ? <Image source={{ uri: avatarUrl, cache: 'force-cache', headers: { 'Cache-Control': 'max-age=86400' } }} style={{ width: s(48), height: s(48), borderRadius: s(24) }} />
                : <Text style={styles.creatorAvatarText}>{avatarLetter}</Text>
              }
            </View>
          </AnimatedButton>
          {!isBlocked && currentUserId && currentUserId !== item.user_id && (
            <AnimatedButton onPress={handleFollow}>
              {!followed
                ? <View style={styles.followBadge}><Text style={styles.followBadgeText}>+</Text></View>
                : <View style={[styles.followBadge, styles.followedBadge]}><Text style={styles.followBadgeText}>✓</Text></View>
              }
            </AnimatedButton>
          )}
        </View>
        <AnimatedButton
          onPress={handleLike}
          style={styles.actionBtn}
          accessibilityLabel={liked ? "Unlike video" : "Like video"}
          accessibilityRole="button"
          accessibilityState={{ selected: liked }}
        >
          <View style={{ shadowColor: '#000', shadowOpacity: 0.8, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } }}>
            <Ionicons name={liked ? 'heart' : 'heart-outline'} size={28} color={liked ? '#ef4444' : '#ffffff'} />
          </View>
          <Text style={styles.actionCount}>{likeCount}</Text>
        </AnimatedButton>
        <AnimatedButton
          onPress={handleOpenComments}
          style={styles.actionBtn}
          accessibilityLabel="View comments"
          accessibilityRole="button"
          accessibilityHint="Opens comments section"
        >
          <View style={{ shadowColor: '#000', shadowOpacity: 0.8, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } }}>
            <Ionicons name="chatbubble-outline" size={26} color="#ffffff" />
          </View>
          <Text style={styles.actionCount}>Comment</Text>
        </AnimatedButton>
        <AnimatedButton
          onPress={() => { showTikTokShare(item, currentUserId, navigation); }}
          style={styles.actionBtn}
          accessibilityLabel="Share video"
          accessibilityRole="button"
        >
          <View style={{ shadowColor: '#000', shadowOpacity: 0.8, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } }}>
            <Ionicons name="arrow-redo-outline" size={26} color="#ffffff" />
          </View>
          <Text style={styles.actionCount}>Share</Text>
        </AnimatedButton>
        <AnimatedButton
          onPress={handleOpenReportSheet}
          style={[styles.actionBtn, { opacity: currentUserId && currentUserId !== item.user_id ? 1 : 0 }]}
          disabled={!currentUserId || currentUserId === item.user_id}
          accessibilityLabel="Report video"
          accessibilityRole="button"
        >
          <View style={{ shadowColor: '#000', shadowOpacity: 0.8, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } }}>
            <Ionicons name="flag-outline" size={24} color="#ffffff" />
          </View>
          <Text style={styles.actionCount}>Report</Text>
        </AnimatedButton>
      </Animated.View>

      <ModernDialog
        visible={showReportSheet}
        title="Report Video"
        message="Why are you reporting this video?"
        type="warning"
        buttons={[
          { text: 'Spam', onPress: () => handleReport('spam') },
          { text: 'Inappropriate', onPress: () => handleReport('inappropriate') },
          { text: 'Harassment', onPress: () => handleReport('harassment') },
          { text: 'Copyright Violation', onPress: () => handleReport('copyright') },
          { text: 'Cancel', style: 'cancel', onPress: () => setShowReportSheet(false) },
        ]}
        onDismiss={() => setShowReportSheet(false)}
      />

      {showComments && (
        <CommentsModal
          visible={showComments}
          onClose={() => setShowComments(false)}
          videoId={item.id}
          navigation={navigation}
          isCreator={currentUserId === item.user_id}
        />
      )}

      <DownloadProgressOverlay visible={isDownloading} progress={downloadProgress} preparing={downloadPreparing} />

      <ModernDialog
        visible={dialog.visible}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        buttons={dialog.buttons}
        onDismiss={() => setDialog({ ...dialog, visible: false })}
      />

      <Animated.View
        style={[
          styles.progressContainer,
          {
            bottom: safeBottom + s(65),
            zIndex: 10,
            height: s(40),
            justifyContent: 'center',
            opacity: barOpacity,
          }
        ]}
        onLayout={onProgressBarLayout}
        hitSlop={{ top: 20, bottom: 20, left: 0, right: 0 }}
        {...panResponder.panHandlers}
      >
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
          <Text style={styles.timeText}>{formatTime(duration)}</Text>
        </View>

        <View style={{ paddingVertical: 4, width: '100%' }}>
          <View ref={progressBarRef} style={[styles.progressBarBg, { height: isDragging ? 6 : 4 }]}>
            <Animated.View
              pointerEvents="none"
              style={[styles.progressBarFill, {
                width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
              }]}
            />
            <Animated.View
              pointerEvents="none"
              style={[styles.progressThumb, {
                left: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                marginLeft: -6,
              }]}
            />
          </View>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { width: '100%', backgroundColor: '#000' },
  video: { width: '100%', height: '100%', position: 'absolute' },
  tapAreaFull: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 },
  heartOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 5, pointerEvents: 'none' },
  heartIcon: { fontSize: ms(80), opacity: 0.9 },
  pauseOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', zIndex: 5, pointerEvents: 'none',
  },
  overlay: { position: 'absolute', left: s(16), right: s(80), zIndex: 4 },
  username: {
    color: '#ffffff', fontWeight: '900', fontSize: ms(16), marginBottom: 10,
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  caption: {
    color: '#ffffff', fontSize: ms(14), fontWeight: '400', lineHeight: ms(18), marginBottom: 4,
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  hashtagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  hashtag: {
    color: COLORS.gold, fontSize: ms(13), fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  captionMore: { color: COLORS.gold, fontSize: ms(12), fontWeight: '700', marginTop: 2 },
  actions: { position: 'absolute', right: s(12), alignItems: 'center', width: s(56), zIndex: 4 },
  actionBtn: { alignItems: 'center', marginBottom: 20 },
  actionIcon: { fontSize: ms(32) },
  actionCount: {
    color: '#ffffff', fontSize: ms(11), textAlign: 'center', marginTop: 4, fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  goldBadge: { backgroundColor: '#B76E79', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  goldBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  blueBadge: { backgroundColor: '#3b82f6', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  blueBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  creatorContainer: { alignItems: 'center', marginBottom: 16 },
  creatorAvatar: {
    width: s(52), height: s(52), borderRadius: s(26), backgroundColor: COLORS.gold,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#ffffff',
  },
  creatorAvatarFollowed: { borderColor: COLORS.gold, borderWidth: 2 },
  creatorAvatarText: { color: '#fff', fontWeight: '700', fontSize: ms(20) },
  followBadge: {
    width: 27, height: 27, borderRadius: 13.5, backgroundColor: COLORS.gold,
    alignItems: 'center', justifyContent: 'center', marginTop: -13.5,
    borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  followedBadge: { backgroundColor: '#10b981' },
  followBadgeText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  dlOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 99, backgroundColor: 'rgba(0,0,0,0.55)', pointerEvents: 'none' },
  dlBox: { backgroundColor: '#1a2e44', borderRadius: 20, padding: 28, width: '75%', alignItems: 'center', gap: 14 },
  dlTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  dlBarBg: { width: '100%', height: 8, backgroundColor: '#2a3a5c', borderRadius: 4, overflow: 'hidden' },
  dlBarFill: { height: '100%', backgroundColor: COLORS.gold, borderRadius: 4 },
  dlPercent: { color: COLORS.gold, fontSize: 22, fontWeight: '800' },
  progressContainer: { position: 'absolute', left: s(16), right: s(16), zIndex: 5 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  timeText: { color: 'rgba(255,255,255,0.8)', fontSize: ms(11), fontWeight: '600' },
  progressBarBg: {
    height: 3, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 2,
    overflow: 'visible', position: 'relative',
  },
  progressBarFill: {
    height: '100%', backgroundColor: COLORS.gold, borderRadius: 2,
    position: 'absolute', left: 0, top: 0,
  },
  progressThumb: {
    width: 12, height: 12, borderRadius: 6, backgroundColor: '#ffffff',
    position: 'absolute', top: -4, marginLeft: -6,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 5,
  },
});

function areEqual(prevProps, nextProps) {
  return (
    prevProps.item.id === nextProps.item.id &&
    prevProps.item.video_url === nextProps.item.video_url &&
    prevProps.item.type === nextProps.item.type &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.isVisible === nextProps.isVisible &&
    prevProps.isTabActive === nextProps.isTabActive &&
    prevProps.player === nextProps.player &&
    prevProps.index === nextProps.index &&
    prevProps.onBlocked === nextProps.onBlocked
  );
}

export default React.memo(VideoCard, areEqual);