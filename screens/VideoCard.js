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
  useWindowDimensions, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { s, ms } from '../utils/responsive';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import AnimatedButton from './AnimatedButton';
import ModernDialog from './ModernDialog';
import { ROUTES } from '../constants/routes';

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
}) {
  const { width } = useWindowDimensions();
  const { showVideoOptionsSheet } = useDownload();

  const [liked, setLiked] = useState(initialLiked);
  const [likeCount, setLikeCount] = useState(item.likes_count ?? 0);
  const [isLiking, setIsLiking] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [followed, setFollowed] = useState(initialFollowed);
  const [videoUri, setVideoUri] = useState(item.video_url);
  console.log('[VIDEO_PLAYER] Received item:', item);
  console.log('[VIDEO_PLAYER] Video URI being used:', item.video_url);
  console.log('[VIDEO_PLAYER] Item keys:', Object.keys(item));
  const { user: authUser, loading: authLoading } = useUser();
  const currentUserId = authUser?.id ?? null;
  const [paused, setPaused] = useState(false);
  const [showHeart, setShowHeart] = useState(false);
  const [showPauseIcon, setShowPauseIcon] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [hasDownloaded, setHasDownloaded] = useState(false);
  const [showReportSheet, setShowReportSheet] = useState(false);
  const manualPauseRef = useRef(false);

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
        if (player?.current) player.current.seek(0);
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
        try { if (player?.current) player.current.seek(0); } catch (e) {}
      } else {
        manualPauseRef.current = false;
        setPaused(false);
      }
    } else {
      setPaused(true);
      if (isActive) {
        try { if (player?.current) player.current.seek(0); } catch (e) {}
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

  const username = usernameProp ?? 'user';
  const avatarUrl = avatarUrlProp ?? null;

  useEffect(() => { setLiked(initialLiked); }, [initialLiked]);
  useEffect(() => { setFollowed(initialFollowed); }, [item.user_id]);

  useEffect(() => {
    const loadCachedVideo = async () => {
      const cachedUri = await videoCache.getCachedVideo(item.video_url);
      if (cachedUri) {
        setVideoUri(cachedUri);
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
  const insets = useSafeAreaInsets();

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
          setTimeout(() => setShowPauseIcon(false), 600);
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
    });
  }, [showVideoOptionsSheet, item, hasDownloaded]);

  const handleDownloadVideo = useCallback(async () => {
    if (hasDownloaded) return;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        setDialog({ visible: true, title: 'Permission Denied', message: 'Please allow access to your media library.', type: 'warning', buttons: [{ text: 'OK' }] });
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

  const handleShare = useCallback(async () => {
    await Share.share({ message: `Watch "${item.caption}" on Balagh! ☪️` });
  }, [item]);

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
    <View style={[styles.card, { height: cardHeight }]}>
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
          minBufferMs: 500,
          maxBufferMs: 2000,
          bufferForPlaybackMs: 250,
          bufferForPlaybackAfterRebufferMs: 500,
        }}
        onError={(e) => {
          console.log('[VIDEO ERROR] Full error:', JSON.stringify(e));
          console.log('[VIDEO ERROR] Video URL:', videoUri);
          __DEV__ && console.log('Video error:', e);
        }}
        onLoad={() => {
          console.log('[VIDEO SUCCESS] Video loaded:', videoUri);
        }}
        useTextureView={false}
      />

      <TouchableOpacity
        style={styles.tapAreaFull}
        onPress={handleTap}
        onLongPress={handleLongPress}
        delayLongPress={500}
        activeOpacity={1}
      />

      {showHeart && (
        <View style={styles.heartOverlay}><Text style={styles.heartIcon}>❤️</Text></View>
      )}
      {showPauseIcon && (
        <View style={styles.heartOverlay}><Text style={styles.heartIcon}>{paused ? '⏸️' : '▶️'}</Text></View>
      )}

      <View style={[styles.overlay, { bottom: insets.bottom + s(80) }]}>
        <AnimatedButton onPress={handleNavigateUserProfile}>
          <Text style={styles.username}>@{username}</Text>
        </AnimatedButton>
        {captionText ? <Text style={styles.caption}>{captionText}</Text> : null}
        {hashtags.length > 0 && (
          <View style={styles.hashtagsRow}>
            {hashtags.map((tag, i) => <Text key={i} style={styles.hashtag}>{tag}</Text>)}
          </View>
        )}
      </View>

      <View style={[styles.actions, { bottom: insets.bottom + s(100) }]}>
        <View style={styles.creatorContainer}>
          <AnimatedButton onPress={handleNavigateUserProfile}>
            <View style={[styles.creatorAvatar, followed && styles.creatorAvatarFollowed]}>
              {avatarUrl
                ? <Image source={{ uri: avatarUrl, cache: 'force-cache', headers: { 'Cache-Control': 'max-age=86400' } }} style={{ width: s(48), height: s(48), borderRadius: s(24) }} />
                : <Text style={styles.creatorAvatarText}>{avatarLetter}</Text>
              }
            </View>
          </AnimatedButton>
          <AnimatedButton onPress={handleFollow}>
            {currentUserId && currentUserId !== item.user_id && (
              !followed
                ? <View style={styles.followBadge}><Text style={styles.followBadgeText}>+</Text></View>
                : <View style={[styles.followBadge, styles.followedBadge]}><Text style={styles.followBadgeText}>✓</Text></View>
            )}
          </AnimatedButton>
        </View>
        <AnimatedButton onPress={handleLike} style={styles.actionBtn}>
          <Text style={styles.actionIcon}>{liked ? '❤️' : '🤍'}</Text>
          <Text style={styles.actionCount}>{likeCount}</Text>
        </AnimatedButton>
        <AnimatedButton onPress={handleOpenComments} style={styles.actionBtn}>
          <Text style={styles.actionIcon}>💬</Text>
          <Text style={styles.actionCount}>Comment</Text>
        </AnimatedButton>
        <AnimatedButton onPress={handleShare} style={styles.actionBtn}>
          <Text style={styles.actionIcon}>↗️</Text>
          <Text style={styles.actionCount}>Share</Text>
        </AnimatedButton>
        {currentUserId && currentUserId !== item.user_id && (
          <AnimatedButton onPress={handleOpenReportSheet} style={styles.actionBtn}>
            <Text style={styles.actionIcon}>🚩</Text>
            <Text style={styles.actionCount}>Report</Text>
          </AnimatedButton>
        )}
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
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: '100%', backgroundColor: '#000' },
  video: { width: '100%', height: '100%', position: 'absolute' },
  tapAreaFull: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 },
  heartOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 2, pointerEvents: 'none' },
  heartIcon: { fontSize: ms(80), opacity: 0.9 },
  overlay: { position: 'absolute', left: s(16), right: s(80), zIndex: 3 },
  username: { color: '#ffffff', fontWeight: '700', fontSize: ms(15), marginBottom: 4 },
  caption: { color: '#e2e8f0', fontSize: ms(13), lineHeight: ms(18), marginBottom: 4 },
  hashtagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  hashtag: { color: '#a78bfa', fontSize: ms(13), fontWeight: '600' },
  actions: { position: 'absolute', right: s(12), alignItems: 'center', width: s(56), zIndex: 10 },
  actionBtn: { alignItems: 'center', marginBottom: 20 },
  actionIcon: { fontSize: ms(32) },
  actionCount: { color: '#fff', fontSize: ms(11), textAlign: 'center', marginTop: 2 },
  creatorContainer: { alignItems: 'center', marginBottom: 24 },
  creatorAvatar: { width: s(52), height: s(52), borderRadius: s(26), backgroundColor: '#7c3aed', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#ffffff' },
  creatorAvatarFollowed: { borderColor: '#a78bfa', borderWidth: 2 },
  creatorAvatarText: { color: '#fff', fontWeight: '700', fontSize: ms(20) },
  followBadge: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#ff2d55', alignItems: 'center', justifyContent: 'center', marginTop: -11, borderWidth: 1.5, borderColor: '#0f0f0f' },
  followedBadge: { backgroundColor: '#10b981' },
  followBadgeText: { color: '#fff', fontSize: 13, fontWeight: '800', lineHeight: 14 },
  dlOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 99, backgroundColor: 'rgba(0,0,0,0.55)', pointerEvents: 'none' },
  dlBox: { backgroundColor: '#1a1d27', borderRadius: 20, padding: 28, width: '75%', alignItems: 'center', gap: 14 },
  dlTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  dlBarBg: { width: '100%', height: 8, backgroundColor: '#2d3148', borderRadius: 4, overflow: 'hidden' },
  dlBarFill: { height: '100%', backgroundColor: '#7c3aed', borderRadius: 4 },
  dlPercent: { color: '#a78bfa', fontSize: 22, fontWeight: '800' },
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