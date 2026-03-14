import Video from 'react-native-video';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import CommentsModal from './CommentsModal';
import { useDownload } from '../context/DownloadContext';
import {
  View, Text, StyleSheet, TouchableOpacity, Share,
  useWindowDimensions, Animated, Pressable, Alert, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import AnimatedButton from './AnimatedButton';

const downloadedVideoIds = new Set();

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

// ── FIX: Accept username + avatarUrl as props — no DB fetch needed per card ───
export default function VideoCard({
  item, player, isActive, isVisible, isTabActive = true,
  initialLiked = false, initialFollowed = false,
  onFollowChange, navigation, cardHeight,
  username: usernameProp,   // ✅ passed from HomeScreen
  avatarUrl: avatarUrlProp, // ✅ passed from HomeScreen
}) {

  const { width } = useWindowDimensions();
  const { showVideoOptionsSheet } = useDownload();
  const [liked, setLiked] = useState(initialLiked);
  const [likeCount, setLikeCount] = useState(item.likes_count ?? 0);
  const [showComments, setShowComments] = useState(false);
  const [followed, setFollowed] = useState(initialFollowed);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [paused, setPaused] = useState(false);
  const [showHeart, setShowHeart] = useState(false);
  const [showPauseIcon, setShowPauseIcon] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [hasDownloaded, setHasDownloaded] = useState(() => downloadedVideoIds.has(item.id));

  // ── Use props directly — no more per-card DB fetch ─────────────────────────
  const username = usernameProp ?? 'user';
  const avatarUrl = avatarUrlProp ?? null;

  const requireAuth = useCallback(() => {
    if (!currentUserId) {
      Alert.alert(
        'Join Bushrann',
        'Login or create an account to interact with content.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Login', onPress: () => navigation.navigate('Login') },
        ]
      );
      return false;
    }
    return true;
  }, [currentUserId, navigation]);

  const lastTap = useRef(null);
  const tapTimer = useRef(null);
  const hasPlayed = useRef(false);
  const insets = useSafeAreaInsets();

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      setPaused(true);
      if (player?.current) {
        try { player.current.seek(0); } catch (e) {}
      }
    };
  }, [player]);

  // When scrolling to a video — always unpause it
  useEffect(() => {
    if (isActive) {
      setPaused(false);
      hasPlayed.current = true;
    }
  }, [isActive]);

  // When switching tabs back — resume whatever video is currently active
  useEffect(() => {
    if (isTabActive && isActive) {
      setPaused(false);
    }
  }, [isTabActive]);

  useEffect(() => { setFollowed(initialFollowed); }, [initialFollowed]);

  // Only fetch current user ID — lightweight, cached by Supabase client
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
    });
  }, []);

  const handleLike = useCallback(async () => {
    if (!requireAuth()) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    if (liked) {
      setLiked(false); setLikeCount(prev => prev - 1);
      await supabase.from('likes').delete().eq('user_id', user.id).eq('video_id', item.id);
    } else {
      setLiked(true); setLikeCount(prev => prev + 1);
      await supabase.from('likes').insert({ user_id: user.id, video_id: item.id });
    }
  }, [liked, item, requireAuth]);

  const handleFollow = useCallback(async () => {
    if (!requireAuth()) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.id === item.user_id) return;
    const newFollowed = !followed;
    setFollowed(newFollowed);
    if (onFollowChange) onFollowChange(item.user_id, newFollowed);
    if (followed) {
      await supabase.from('follows').delete().eq('follower_id', user.id).eq('following_id', item.user_id);
    } else {
      await supabase.from('follows').insert({ follower_id: user.id, following_id: item.user_id });
    }
  }, [followed, item, onFollowChange, requireAuth]);


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
          setShowPauseIcon(true);
          setTimeout(() => setShowPauseIcon(false), 600);
          return newPaused;
        });
        lastTap.current = null;
      }, 300);
    }
  }, [handleLike]);

  const handleLongPress = useCallback(() => {
    showVideoOptionsSheet(
      item,
      false,
      hasDownloaded,
      {
        onDownload: handleDownloadVideo,
        onPin: null,
        onDelete: null,
      }
    );
  }, [showVideoOptionsSheet, item, hasDownloaded]);

  const handleDownloadVideo = useCallback(async () => {
    if (downloadedVideoIds.has(item.id)) return;

    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Please allow access to your media library.');
        return;
      }

      setIsDownloading(true);
      setDownloadProgress(0);

      const fileUri = FileSystem.documentDirectory + `balagh_${item.id}.mp4`;

      const downloadResumable = FileSystem.createDownloadResumable(
        item.video_url,
        fileUri,
        {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          if (totalBytesExpectedToWrite > 0) {
            setDownloadProgress(totalBytesWritten / totalBytesExpectedToWrite);
          }
        }
      );

      const result = await downloadResumable.downloadAsync();
      if (!result?.uri) throw new Error('Download failed');

      await MediaLibrary.saveToLibraryAsync(result.uri);
      await FileSystem.deleteAsync(result.uri, { idempotent: true });

      setIsDownloading(false);
      downloadedVideoIds.add(item.id);
      setHasDownloaded(true);

      Alert.alert('Downloaded ✅', 'Video saved to your gallery!');
    } catch (e) {
      setIsDownloading(false);
      Alert.alert('Error', 'Could not download the video. Please try again.');
      console.error('Download error:', e);
    }
  }, [item]);

  const handleShare = useCallback(async () => {
    await Share.share({ message: `Watch "${item.caption}" on Balagh! ☪️` });
  }, [item]);

  const avatarLetter = username[0]?.toUpperCase() ?? '?';
  const hashtags = item.caption?.match(/#\w+/g) ?? [];
  const captionText = item.caption?.replace(/#\w+/g, '').trim() ?? '';

  const [playerReady, setPlayerReady] = useState(false);

  useEffect(() => {
    if (player) {
      const timer = setTimeout(() => setPlayerReady(true), 50);
      return () => {
        clearTimeout(timer);
        setPlayerReady(false);
      };
    }
  }, [player]);

  if (!player) {
    return <View style={{ height: cardHeight, backgroundColor: '#000' }} />;
  }

  return (
    <View style={[styles.card, { height: cardHeight }]}>
      <Video
        key={item.id}
        ref={player}
        source={{ uri: item.video_url }}
        style={styles.video}
        resizeMode="contain"
        repeat={true}
        paused={!isActive || !isTabActive || paused}
        muted={false}
        playInBackground={false}
        playWhenInactive={false}
        ignoreSilentSwitch="ignore"
        progressUpdateInterval={250}
        onError={(e) => console.log('Video error:', e)}
      />

      <TouchableOpacity
        style={styles.tapArea}
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

      <View style={styles.overlay}>
        <AnimatedButton onPress={() => navigation.navigate('UserProfile', { profileUserId: item.user_id })}>
          <Text style={styles.username}>@{username}</Text>
        </AnimatedButton>
        {captionText ? <Text style={styles.caption}>{captionText}</Text> : null}
        {hashtags.length > 0 && (
          <View style={styles.hashtagsRow}>
            {hashtags.map((tag, i) => <Text key={i} style={styles.hashtag}>{tag}</Text>)}
          </View>
        )}
      </View>

      <View style={styles.actions}>
        <View style={styles.creatorContainer}>
          <AnimatedButton onPress={() => navigation.navigate('UserProfile', { profileUserId: item.user_id })}>
            <View style={[styles.creatorAvatar, followed && styles.creatorAvatarFollowed]}>
              {avatarUrl
                ? <Image source={{ uri: avatarUrl }} style={{ width: 48, height: 48, borderRadius: 24 }} />
                : <Text style={styles.creatorAvatarText}>{avatarLetter}</Text>
              }
            </View>
          </AnimatedButton>
          <AnimatedButton onPress={handleFollow}>
            {currentUserId !== item.user_id && (
              !followed ? (
                <View style={styles.followBadge}><Text style={styles.followBadgeText}>+</Text></View>
              ) : (
                <View style={[styles.followBadge, styles.followedBadge]}><Text style={styles.followBadgeText}>✓</Text></View>
              )
            )}
          </AnimatedButton>
        </View>
        <AnimatedButton onPress={handleLike} style={styles.actionBtn}>
          <Text style={styles.actionIcon}>{liked ? '❤️' : '🤍'}</Text>
          <Text style={styles.actionCount}>{likeCount}</Text>
        </AnimatedButton>
        <AnimatedButton style={styles.actionBtn} onPress={() => { if (requireAuth()) setShowComments(true); }}>
          <Text style={styles.actionIcon}>💬</Text>
          <Text style={styles.actionCount}>Comment</Text>
        </AnimatedButton>
        <AnimatedButton style={styles.actionBtn} onPress={handleShare}>
          <Text style={styles.actionIcon}>↗️</Text>
          <Text style={styles.actionCount}>Share</Text>
        </AnimatedButton>
      </View>

      <CommentsModal visible={showComments} onClose={() => setShowComments(false)} videoId={item.id} navigation={navigation} />

      <DownloadProgressOverlay visible={isDownloading} progress={downloadProgress} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: '100%', backgroundColor: '#000' },
  video: { width: '100%', height: '100%', position: 'absolute' },
  tapArea: { position: 'absolute', top: 0, left: 0, right: 80, bottom: 0, zIndex: 1 },
  heartOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 2, pointerEvents: 'none' },
  heartIcon: { fontSize: 100, opacity: 0.9 },
  overlay: { position: 'absolute', bottom: 80, left: 16, right: 80 },
  username: { color: '#ffffff', fontWeight: '700', fontSize: 15, marginBottom: 4 },
  caption: { color: '#e2e8f0', fontSize: 13, lineHeight: 18, marginBottom: 4 },
  hashtagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  hashtag: { color: '#a78bfa', fontSize: 13, fontWeight: '600' },
  actions: { position: 'absolute', right: 12, bottom: 100, alignItems: 'center' },
  actionBtn: { alignItems: 'center', marginBottom: 20 },
  actionIcon: { fontSize: 32 },
  actionCount: { color: '#fff', fontSize: 11, textAlign: 'center', marginTop: 2 },
  creatorContainer: { alignItems: 'center', marginBottom: 24 },
  creatorAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#7c3aed', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#ffffff' },
  creatorAvatarFollowed: { borderColor: '#a78bfa', borderWidth: 2 },
  creatorAvatarText: { color: '#fff', fontWeight: '700', fontSize: 20 },
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