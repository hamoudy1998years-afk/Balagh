import Video from 'react-native-video';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import CommentsModal from './CommentsModal';
import { useDownload } from '../context/DownloadContext';
import { useUser } from '../context/UserContext';
import { useFocusEffect } from '@react-navigation/native';
import { videoCache } from '../utils/VideoCache';
import {
  View, Text, StyleSheet, TouchableOpacity, Share,
  useWindowDimensions, Image, PanResponder, Animated, Linking,
  Pressable, Alert, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { s, ms } from '../utils/responsive';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import AnimatedButton from './AnimatedButton';
import ModernDialog from './ModernDialog';
import { ROUTES } from '../constants/routes';
import { COLORS } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';

const DownloadProgressOverlay = React.memo(function DownloadProgressOverlay({ visible, progress }) {
  if (!visible) return null;
  const pct = Math.round(progress * 100);
  return (
    <View style={styles.dlOverlay} pointerEvents="none">
      <View style={styles.dlBox}>
        <Text style={styles.dlTitle}>⬇️ Downloading...</Text>
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
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const safeBottom = insets?.bottom ?? 0;
  const { showVideoOptionsSheet, showTikTokShare } = useDownload();
  const { blockedUsers } = useUser();

  const [liked, setLiked] = useState(initialLiked);
  const [likeCount, setLikeCount] = useState(item.likes_count ?? 0);
  const [isLiking, setIsLiking] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [followed, setFollowed] = useState(initialFollowed);
  const [isBlocked, setIsBlocked] = useState(false);
  const [videoUri, setVideoUri] = useState(null);
  const [isLoadingSignedUrl, setIsLoadingSignedUrl] = useState(false);

  // Fetch signed URL for livestream videos
  useEffect(() => {
    const fetchSignedUrl = async () => {

      // Only fetch signed URL for livestream videos (m3u8 files)
      if (item.video_url && item.video_url.includes('.m3u8')) {
        setIsLoadingSignedUrl(true);
        try {
          const response = await fetch(
            `https://balagh-server-production.up.railway.app/api/recording/livestreams/${item.id}/play`
          );
          const data = await response.json();

          if (data.signedUrl) {

            setVideoUri(data.signedUrl);

          } else {
            // Fallback to original URL
            setVideoUri(item.video_url);
          }
        } catch (error) {

          // Fallback to original URL
          setVideoUri(item.video_url);
        } finally {
          setIsLoadingSignedUrl(false);
        }
      } else {
        // For regular videos, use original URL
        setVideoUri(item.video_url);
      }
    };

    if (item.id && item.video_url) {
      fetchSignedUrl();
    }
  }, [item.id, item.video_url]);

  useEffect(() => {
    async function checkBlocked() {
      if (!currentUserId || !item.user_id) return;
      const { data } = await supabase
        .from('blocks')
        .select('id')
        .eq('blocker_id', currentUserId)
        .eq('blocked_id', item.user_id)
        .maybeSingle();
      setIsBlocked(!!data);
    }
    checkBlocked();
  }, [currentUserId, item.user_id]);


  const { user: authUser, loading: authLoading } = useUser();
  const currentUserId = authUser?.id ?? null;
  const [paused, setPaused] = useState(false);
  const [showHeart, setShowHeart] = useState(false);
  const [showPauseIcon, setShowPauseIcon] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showProgress, setShowProgress] = useState(true);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const [isDownloading, setIsDownloading] = useState(false);
  // Refs to fix stale closure in PanResponder - always hold latest values
  const durationRef = useRef(0);
  const playerRef = useRef(null);
  const isVideoReadyRef = useRef(false);
  const isSeeking = useRef(false);
  const progressBarRef = useRef(null);  // Ref for measure()
  const progressBarPageX = useRef(0);   // Absolute screen X position
  const lastSeekTime = useRef(0);  // Throttle video seek during drag
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [hasDownloaded, setHasDownloaded] = useState(false);
  const [showReportSheet, setShowReportSheet] = useState(false);
  const [showFullCaption, setShowFullCaption] = useState(false);
  const manualPauseRef = useRef(false);

  // Check if video owner is blocked (from context)
  const isUserBlocked = blockedUsers?.has(item.user_id);
  
  // Fade animation for blocked content
  const fadeAnim = useRef(new Animated.Value(1)).current;

  // ── PLAY/PAUSE LOGIC ──────────────────────────────────────────────────────

  // When user scrolls away — reset manual pause so it auto-plays on return
  useEffect(() => {
    if (!isActive) {
      manualPauseRef.current = false;
      setPaused(true);
    } else {
      // Scrolled back — restart from 0 and play like TikTok
      manualPauseRef.current = false;
      try {
        if (player?.current?.seek) {
          player.current.seek(0);
        }
      } catch (e) {}
      setPaused(false);
    }
  }, [isActive]);

  // When tab switches — pause/resume and restart from beginning
  useEffect(() => {
    if (isTabActive) {
      if (isActive) {
        manualPauseRef.current = false;
        setPaused(false);
        try { 
          if (player?.current?.seek) {
            player.current.seek(0); 
          }
        } catch (e) {}
      } else {
        manualPauseRef.current = false;
        setPaused(false);
      }
    } else {
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

  // FIX: Pause video when navigating away to profile/search/other screens
  useFocusEffect(
    useCallback(() => {
      return () => {
        // Screen lost focus — pause video to stop audio leak
        setPaused(true);
        manualPauseRef.current = false;
      };
    }, [])
  );

  // ─────────────────────────────────────────────────────────────────────────

  const [dialog, setDialog] = useState({
    visible: false, title: '', message: '', type: 'info', buttons: []
  });
  // TikTok-style progress bar visibility
  const [isDragging, setIsDragging] = useState(false);
  const barOpacity = useRef(new Animated.Value(0)).current;

  const username = usernameProp ?? 'user';
  const avatarUrl = avatarUrlProp ?? null;
  const isScholar = isScholarProp ?? item.profiles?.is_scholar ?? false;
  const isTrusted = isTrustedProp ?? item.profiles?.trusted_user ?? false;

  useEffect(() => { setLiked(initialLiked); }, [initialLiked]);
  useEffect(() => { setFollowed(initialFollowed); }, [item.user_id]);
  // Sync state to refs so PanResponder always reads latest values
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => { 
    if (player?.current) {
      playerRef.current = player.current; 
    }
  }, [player?.current]);
  // TikTok-style: fade in/out progress bar based on paused or dragging
  useEffect(() => {
    if (paused || isDragging) {
      // Show instantly (100ms fade in)
      Animated.timing(barOpacity, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }).start();
    } else {
      // Smooth fade out (250ms)
      Animated.timing(barOpacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }
  }, [paused, isDragging]);

  useEffect(() => {
  const loadCachedVideo = async () => {
    const cachedUri = await videoCache.getCachedVideo(item.video_url);
    if (cachedUri) {
      // Verify the file actually exists before using it
      const fileInfo = await FileSystem.getInfoAsync(cachedUri);
      if (fileInfo.exists) {
        setVideoUri(cachedUri);
      } else {
        // File is gone — delete bad cache entry and use remote URL
        await videoCache.removeCachedVideo(item.video_url);
        setVideoUri(item.video_url);
        videoCache.cacheVideo(item.video_url);
      }
    } else {
      setVideoUri(item.video_url);
      videoCache.cacheVideo(item.video_url);
    }
  };
  loadCachedVideo();
}, [item.video_url]);

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

  // Progress bar dragging
  const progressBarWidth = useRef(0);
  // Helper for instant UI updates during drag
  const updateProgressBarUI = (pct) => {
    const safePct = Math.max(0, Math.min(1, pct));
    progressAnim.setValue(safePct);
  };
  // Capture both width AND absolute screen position on layout
  const onProgressBarLayout = (e) => {
    const { width } = e.nativeEvent.layout;
    progressBarWidth.current = width;

    // measure() gives true pageX after layout
    progressBarRef.current?.measure((fx, fy, w, h, pageX, pageY) => {
      progressBarPageX.current = pageX;
    });
  };

  // Convert any touch's pageX into 0-1 percentage along the bar
  const pageXToPercentage = (pageX) => {
    const offset = pageX - progressBarPageX.current;
    return Math.max(0, Math.min(1, offset / progressBarWidth.current));
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,

      onPanResponderGrant: (evt) => {
        setIsDragging(true); // Forces bar to show
        isSeeking.current = true;
        manualPauseRef.current = true;
        setPaused(true); // Pause while dragging

        const pct = pageXToPercentage(evt.nativeEvent.pageX);
        updateProgressBarUI(pct);
        seekToPosition(pct);
      },

      onPanResponderMove: (evt) => {
        const pct = pageXToPercentage(evt.nativeEvent.pageX);
        updateProgressBarUI(pct);

        const now = Date.now();
        if (now - lastSeekTime.current > 100) {
          seekToPosition(pct);
          lastSeekTime.current = now;
        }
      },

      onPanResponderRelease: (evt) => {
        const pct = pageXToPercentage(evt.nativeEvent.pageX);
        updateProgressBarUI(pct);
        seekToPosition(pct);

        isSeeking.current = false;
        manualPauseRef.current = false;
        setPaused(false); // Resume playback
        setIsDragging(false); // Hide bar (fade out handled by useEffect)
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (tapTimer.current) clearTimeout(tapTimer.current);
      if (player?.current) {
        try { player.current.seek(0); } catch (e) {}
      }
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
    if (!requireAuth() || !currentUserId || currentUserId === item.user_id) return;
    const newFollowed = !followed;
    setFollowed(newFollowed);
    if (onFollowChange) onFollowChange(item.user_id, newFollowed);
    const { DeviceEventEmitter } = require('react-native');
    DeviceEventEmitter.emit('followChanged', { userId: item.user_id, isFollowing: newFollowed });
    if (followed) {
      await supabase.from('follows').delete().eq('follower_id', currentUserId).eq('following_id', item.user_id);
    } else {
      await supabase.from('follows').insert({ follower_id: currentUserId, following_id: item.user_id });
    }
  }, [followed, item, currentUserId, onFollowChange, requireAuth]);

  const handleTap = useCallback(() => {
    const now = Date.now();
    if (lastTap.current && now - lastTap.current < 300) {
      // Double tap - like the video
      clearTimeout(tapTimer.current);
      lastTap.current = null;
      handleLike();
      setShowHeart(true);
      setShowPauseIcon(false);
      setTimeout(() => setShowHeart(false), 800);
    } else {
      // Single tap - toggle pause/play
      lastTap.current = now;
      tapTimer.current = setTimeout(() => {
        setPaused(prev => {
          const newPaused = !prev;
          manualPauseRef.current = newPaused;
          
          // Show icon when state changes, but don't auto-hide when pausing
          setShowPauseIcon(true);
          
          // Only auto-hide when resuming (unpausing), not when pausing
          if (!newPaused) {
            // Resuming - hide icon after delay
            setTimeout(() => setShowPauseIcon(false), 800);
          }
          // When pausing (newPaused = true), icon stays visible
          
          return newPaused;
        });
        lastTap.current = null;
      }, 300);
    }
  }, [handleLike]);

  const handleLongPress = useCallback(() => {
    if (!showVideoOptionsSheet) return;
    showVideoOptionsSheet(item, false, hasDownloaded, {
      onDownload: handleDownloadVideo,
      onPin: null,
      onDelete: null,
      onBlock: handleBlockUser,
    }, currentUserId, navigation);
  }, [showVideoOptionsSheet, item, hasDownloaded, handleBlockUser, currentUserId, navigation]);

  const handleDownloadVideo = useCallback(async () => {
    if (hasDownloaded) return;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        setDialog({ 
          visible: true, 
          title: 'Permission Required', 
          message: 'Please allow access to your media library to download videos.', 
          type: 'warning', 
          buttons: [
            { text: 'Cancel', style: 'cancel' },
            { 
              text: 'Open Settings', 
              onPress: () => Linking.openSettings(),
              style: 'destructive'
            },
          ] 
        });
        return;
      }
      setIsDownloading(true);
      setDownloadProgress(0);
      const fileUri = FileSystem.documentDirectory + `balagh_${item.id}.mp4`;
      const downloadResumable = FileSystem.createDownloadResumable(
        item.video_url, fileUri, {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          if (totalBytesExpectedToWrite > 0) setDownloadProgress(totalBytesWritten / totalBytesExpectedToWrite);
        }
      );
      const result = await downloadResumable.downloadAsync();
      if (!result?.uri) throw new Error('Download failed');
      await MediaLibrary.saveToLibraryAsync(result.uri);
      await FileSystem.deleteAsync(result.uri, { idempotent: true });
      setIsDownloading(false);
      setHasDownloaded(true);
      setDialog({ visible: true, title: 'Downloaded ✅', message: 'Video saved to your gallery!', type: 'success', buttons: [{ text: 'OK' }] });
    } catch (e) {
      setIsDownloading(false);
      setDialog({ visible: true, title: 'Error', message: 'Could not download the video. Please try again.', type: 'error', buttons: [{ text: 'OK' }] });
      __DEV__ && console.error('Download error:', e);
    }
  }, [item, hasDownloaded]);

  const handleReport = useCallback(async (reason) => {
    if (!currentUserId) return;
    await supabase.from('reports').insert({ reporter_id: currentUserId, reported_user_id: item.user_id, video_id: item.id, reason });
    setShowReportSheet(false);
    setDialog({ visible: true, title: 'Report Submitted ✅', message: 'Thanks for reporting. We will review this video.', type: 'success', buttons: [{ text: 'OK' }] });
  }, [currentUserId, item]);

  const handleBlockUser = useCallback(async () => {
    if (!currentUserId || !item.user_id) return;
    try {
      await supabase.from('blocks').insert({ blocker_id: currentUserId, blocked_id: item.user_id });
      setIsBlocked(true);
      setDialog({ visible: true, title: 'Blocked 🚫', message: 'You have blocked this user. Their content will no longer appear in your feed.', type: 'success', buttons: [{ text: 'OK', onPress: () => onBlocked?.(index) }] });
    } catch (error) {
      console.error('Block error:', error);
      setDialog({ visible: true, title: 'Error', message: 'Could not block user. Please try again.', type: 'error', buttons: [{ text: 'OK' }] });
    }
  }, [currentUserId, item.user_id]);



  const handleNavigateUserProfile = useCallback(() => {
    navigation.navigate(ROUTES.USER_PROFILE, { profileUserId: item.user_id });
  }, [navigation, item.user_id]);

  const handleOpenComments = useCallback(() => {
    if (requireAuth()) setShowComments(true);
  }, [requireAuth]);

  const handleOpenReportSheet = useCallback(() => setShowReportSheet(true), []);

  const avatarLetter = username[0]?.toUpperCase() ?? '?';
  const hashtags = item.caption?.match(/#\w+/g) ?? [];
  const captionText = item.caption?.replace(/#\w+/g, '').trim() ?? '';

  return (
    <Animated.View style={[styles.card, { height: cardHeight, opacity: isUserBlocked ? 0 : 1 }]}>
      {videoUri ? (
        <Video
          ref={player}
          source={{ uri: videoUri }}
          style={styles.video}
          resizeMode="contain"
          repeat={true}
          paused={!isActive || !isTabActive || paused}
          muted={false}
          playInBackground={false}
          playWhenInactive={false}
          ignoreSilentSwitch="ignore"
          progressUpdateInterval={250}
          bufferConfig={{
            minBufferMs: 15000,
            maxBufferMs: 50000,
            bufferForPlaybackMs: 2500,
            bufferForPlaybackAfterRebufferMs: 5000,
          }}
          onError={(e) => {

            __DEV__ && console.log('Video error:', e);
          }}
          onLoad={(data) => {
            if (data?.duration) {
              setDuration(data.duration);
              durationRef.current = data.duration; // Set ref immediately, no useEffect lag
              isVideoReadyRef.current = true;
            }
          }}
          onProgress={(data) => {
            if (isSeeking.current) return;  // Skip updates while user is seeking
            if (data?.currentTime && data?.seekableDuration) {
              setCurrentTime(data.currentTime);
              const progress = data.currentTime / data.seekableDuration;
              progressAnim.setValue(progress);
            }
          }}
          useTextureView={false}
        />
      ) : (
        <View style={[styles.video, { backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }]}>
          <ActivityIndicator color={COLORS.gold} size="large" />
        </View>
      )}

      {/* Full-screen tap area for pause/play (behind progress bar) */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={handleTap}
        activeOpacity={1}
      />

      {showHeart && (
        <View style={styles.heartOverlay}><Text style={styles.heartIcon}>❤️</Text></View>
      )}
      {showPauseIcon && paused && (
        <View style={styles.pauseOverlay}>
          <Ionicons 
            name="play" 
            size={60} 
            color="#ffffff" 
            style={{ opacity: 0.9 }}
          />
        </View>
      )}

      {/* Bottom UI - fades out when dragging (TikTok style) */}
      <Animated.View style={[styles.overlay, { 
        bottom: safeBottom + s(95),
      }]}>

        {/* Username row — always on top */}
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

        {/* Caption — 2 lines max with more/less toggle */}
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

        {/* Hashtags — always at the bottom */}
        {hashtags.length > 0 && (
          <View style={styles.hashtagsRow}>
            {hashtags.map((tag, i) => <Text key={i} style={styles.hashtag}>{tag}</Text>)}
          </View>
        )}
      </Animated.View>

      <View style={[styles.actions, { bottom: safeBottom + s(100) }]}>
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
          onPress={() => {
            console.log('📤 SHARE BUTTON TAPPED - calling showTikTokShare with:', item?.id, currentUserId);
            showTikTokShare(item, currentUserId);
          }} 
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
      </View>

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

      <CommentsModal
        visible={showComments}
        onClose={() => setShowComments(false)}
        videoId={item.id}
        navigation={navigation}
        isCreator={currentUserId === item.user_id}
      />

      <DownloadProgressOverlay visible={isDownloading} progress={downloadProgress} />

      <ModernDialog
        visible={dialog.visible}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        buttons={dialog.buttons}
        onDismiss={() => setDialog({ ...dialog, visible: false })}
      />

      {/* =====================================================
          TikTok-style Progress Bar — UPDATED with duration
          ===================================================== */}
      <Animated.View 
        style={[
          styles.progressContainer, 
          { 
            bottom: safeBottom + s(58),  // ← changed from s(55)
            zIndex: 10, 
            height: s(40),                   // ← changed from 40
            justifyContent: 'center',
            opacity: barOpacity
          }
        ]}
        onLayout={onProgressBarLayout}
        {...panResponder.panHandlers}
      >
        {/* ✅ NEW: TikTok-style current time / total duration */}
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
          <Text style={styles.timeText}>{formatTime(duration)}</Text>
        </View>

        {/* Invisible hit slop area */}
        <View style={{ paddingVertical: 2, width: '100%' }}>
          <View
            ref={progressBarRef}
            style={[
              styles.progressBarBg, 
              { height: isDragging ? 6 : 4 }
            ]}
          >
            <Animated.View 
              pointerEvents="none"
              style={[
                styles.progressBarFill,
                { width: progressAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0%', '100%']
                })}
              ]} 
            />
            <Animated.View 
              pointerEvents="none"
              style={[
                styles.progressThumb,
                { 
                  left: progressAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%']
                  }),
                  marginLeft: -6,
                }
              ]}
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
  heartOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 2, pointerEvents: 'none' },
  heartIcon: { fontSize: ms(80), opacity: 0.9 },
  pauseOverlay: { 
    position: 'absolute', 
    top: 0, 
    left: 0, 
    right: 0, 
    bottom: 0, 
    alignItems: 'center', 
    justifyContent: 'center', 
    zIndex: 2, 
    pointerEvents: 'none',
  },

  overlay: { position: 'absolute', left: s(16), right: s(80), zIndex: 3 },
  username: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: ms(16),
    marginBottom: 10,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  caption: {
    color: '#ffffff',
    fontSize: ms(14),
    fontWeight: '400',
    lineHeight: ms(18),
    marginBottom: 4,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  hashtagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  hashtag: {
    color: COLORS.gold,
    fontSize: ms(13),
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  captionMore: {
    color: COLORS.gold,
    fontSize: ms(12),
    fontWeight: '700',
    marginTop: 2,
  },
  actions: { position: 'absolute', right: s(12), alignItems: 'center', width: s(56), zIndex: 10 },
  actionBtn: { alignItems: 'center', marginBottom: 20 },
  actionIcon: { fontSize: ms(32) },
  actionCount: {
    color: '#ffffff',
    fontSize: ms(11),
    textAlign: 'center',
    marginTop: 4,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  goldBadge: {
    backgroundColor: '#B76E79',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  goldBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  blueBadge: {
    backgroundColor: '#3b82f6',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  blueBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  creatorContainer: { alignItems: 'center', marginBottom: 16 },
  creatorAvatar: {
    width: s(52),
    height: s(52),
    borderRadius: s(26),
    backgroundColor: COLORS.gold,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  creatorAvatarFollowed: { borderColor: COLORS.gold, borderWidth: 2 },
  creatorAvatarText: { color: '#fff', fontWeight: '700', fontSize: ms(20) },
  followBadge: {
    width: 27,
    height: 27,
    borderRadius: 13.5,
    backgroundColor: COLORS.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -13.5,
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  followedBadge: { backgroundColor: '#10b981' },
  followBadgeText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  dlOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 99, backgroundColor: 'rgba(0,0,0,0.55)', pointerEvents: 'none' },
  dlBox: { backgroundColor: '#1a2e44', borderRadius: 20, padding: 28, width: '75%', alignItems: 'center', gap: 14 },
  dlTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  dlBarBg: { width: '100%', height: 8, backgroundColor: '#2a3a5c', borderRadius: 4, overflow: 'hidden' },
  dlBarFill: { height: '100%', backgroundColor: COLORS.gold, borderRadius: 4 },
  dlPercent: { color: COLORS.gold, fontSize: 22, fontWeight: '800' },
  progressContainer: {
    position: 'absolute',
    left: s(16),
    right: s(16),
    zIndex: 5,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  timeText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: ms(11),
    fontWeight: '600',
  },
  progressBarBg: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    overflow: 'visible',
    position: 'relative',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: COLORS.gold,
    borderRadius: 2,
    position: 'absolute',
    left: 0,
    top: 0,
  },
  progressThumb: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#ffffff',
    position: 'absolute',
    top: -4,
    marginLeft: -6,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
});

function areEqual(prevProps, nextProps) {
  return (
    prevProps.item.id === nextProps.item.id &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.isVisible === nextProps.isVisible &&
    prevProps.isTabActive === nextProps.isTabActive
  );
}

export default React.memo(VideoCard, areEqual);