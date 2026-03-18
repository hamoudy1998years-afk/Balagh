import {
  View, Text, StyleSheet, FlatList,
  Image, Modal, Alert, useWindowDimensions,
  StatusBar, RefreshControl, Animated, Pressable,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import React, { useReducer, useEffect as useEffectHook, useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import AnimatedButton from './AnimatedButton';
import { useDownload } from '../context/DownloadContext';
import { userCache } from '../utils/userCache';
import { useUser } from '../context/UserContext';
import { COLORS } from '../constants/theme';

const downloadedVideoIds = new Set();

// ─── Reducers ───────────────────────────────────────────────────────────────

const initialProfileState = {
  profile: null,
  currentUser: null,
  isOwnProfile: true,
  following: false,
  blocked: false,
  followersCount: 0,
  followingCount: 0,
  isScholar: false,
  scholarData: null,
};

function profileReducer(state, action) {
  switch (action.type) {
    case 'RESET': return { ...initialProfileState };
    case 'SET_USER': return { ...state, currentUser: action.currentUser, isOwnProfile: action.isOwnProfile };
    case 'SET_PROFILE': return { ...state, profile: action.profile };
    case 'UPDATE_AVATAR': return { ...state, profile: state.profile ? { ...state.profile, avatar_url: action.url } : state.profile };
    case 'SET_SCHOLAR': return { ...state, isScholar: action.isScholar, scholarData: action.scholarData };
    case 'SET_FOLLOW_COUNTS': return { ...state, followersCount: action.followersCount, followingCount: action.followingCount };
    case 'SET_FOLLOWING': return { ...state, following: action.following };
    case 'SET_BLOCKED': return { ...state, blocked: action.blocked };
    case 'FOLLOW_CHANGE': return { ...state, following: action.following, followersCount: Math.max(0, state.followersCount + action.delta) };
    case 'BLOCK': return { ...state, blocked: true, following: false };
    case 'UNBLOCK': return { ...state, blocked: false };
    case 'ADJUST_FOLLOWING_COUNT': return { ...state, followingCount: Math.max(0, state.followingCount + action.delta) };
    default: return state;
  }
}

const initialVideoState = {
  publicVideos: [],
  privateVideos: [],
  likedVideos: [],
  totalLikes: 0,
  activeTab: 'videos',
};

function videoReducer(state, action) {
  switch (action.type) {
    case 'RESET': return { ...initialVideoState };
    case 'SET_PUBLIC': return { ...state, publicVideos: action.videos, totalLikes: action.totalLikes };
    case 'SET_PRIVATE': return { ...state, privateVideos: action.videos };
    case 'SET_LIKED': return { ...state, likedVideos: action.videos };
    case 'SET_ACTIVE_TAB': return { ...state, activeTab: action.tab };
    case 'REMOVE_VIDEO': return {
      ...state,
      publicVideos: state.publicVideos.filter(v => v.id !== action.id),
      privateVideos: state.privateVideos.filter(v => v.id !== action.id),
    };
    default: return state;
  }
}

const initialUIState = {
  loading: true,
  refreshing: false,
  avatarModal: false,
  enlargeAvatar: false,
  isDownloading: false,
  downloadProgress: 0,
};

function uiReducer(state, action) {
  switch (action.type) {
    case 'SET_LOADING': return { ...state, loading: action.loading };
    case 'SET_REFRESHING': return { ...state, refreshing: action.refreshing };
    case 'SET_AVATAR_MODAL': return { ...state, avatarModal: action.open };
    case 'SET_ENLARGE_AVATAR': return { ...state, enlargeAvatar: action.open };
    case 'SET_DOWNLOADING': return { ...state, isDownloading: action.isDownloading, downloadProgress: action.progress ?? state.downloadProgress };
    case 'SET_DOWNLOAD_PROGRESS': return { ...state, downloadProgress: action.progress };
    default: return state;
  }
}

function formatCount(n) {
  if (!n || n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

const Avatar = React.memo(function Avatar({ uri, username, size = 90, onPress }) {
  const letter = username?.[0]?.toUpperCase() ?? '?';
  return (
    <AnimatedButton onPress={onPress}>
      {uri ? (
        <Image source={{ uri, cache: 'force-cache', headers: { 'Cache-Control': 'max-age=86400' } }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#eee' }} />
      ) : (
        <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: COLORS.gold, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: size * 0.4, fontWeight: '700', color: '#fff' }}>{letter}</Text>
        </View>
      )}
    </AnimatedButton>
  );
});

const VideoGridItem = React.memo(function VideoGridItem({ item, onPress, onLongPress }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  function handleLongPress() {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.92, duration: 100, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
    ]).start(() => onLongPress && onLongPress(item));
  }

  return (
    <Animated.View style={[styles.gridItem, { transform: [{ scale: scaleAnim }] }]}>
      <AnimatedButton style={StyleSheet.absoluteFill} onPress={onPress} onLongPress={handleLongPress} delayLongPress={400}>
        <Image source={{ uri: item.thumbnail_url || item.video_url, cache: 'force-cache', headers: { 'Cache-Control': 'max-age=86400' } }} style={styles.gridThumb} resizeMode="cover" />
        <View style={styles.gridOverlay}><Text style={styles.gridPlayCount}>▶ {formatCount(item.views_count)}</Text></View>
        {item.is_pinned && <View style={styles.pinnedLabel}><Text style={styles.pinnedLabelText}>📌</Text></View>}
        {item.is_private && <View style={styles.privateLabel}><Text style={styles.privateLabelText}>🔒</Text></View>}
      </AnimatedButton>
    </Animated.View>
  );
});

function DownloadProgressOverlay({ visible, progress }) {
  if (!visible) return null;
  const pct = Math.round(progress * 100);
  return (
    <View style={styles.dlOverlay} pointerEvents="none">
      <View style={styles.dlBox}>
        <Text style={styles.dlTitle}>⬇️ Downloading...</Text>
        <View style={styles.dlBarBg}><View style={[styles.dlBarFill, { width: `${pct}%` }]} /></View>
        <Text style={styles.dlPercent}>{pct}%</Text>
      </View>
    </View>
  );
}

export default function ProfileScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const targetUserId = route?.params?.profileUserId ?? null;
  const { user: globalUser, loading: userLoading } = useUser();

  useEffectHook(() => {
    if (!navigation) return;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigation.replace('Login');
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) navigation.replace('Login');
    });
    return () => subscription.unsubscribe();
  }, []);

  const downloadContext = useDownload();
  const showVideoOptionsSheet = downloadContext?.showVideoOptionsSheet;

  const [profileState, dispatchProfile] = useReducer(profileReducer, initialProfileState);
  const [videoState, dispatchVideo] = useReducer(videoReducer, initialVideoState);
  const [uiState, dispatchUI] = useReducer(uiReducer, initialUIState);

  const { profile, currentUser, isOwnProfile, following, blocked, followersCount, followingCount, isScholar, scholarData } = profileState;
  const { publicVideos, privateVideos, likedVideos, totalLikes, activeTab } = videoState;
  const { loading, refreshing, avatarModal, enlargeAvatar, isDownloading, downloadProgress } = uiState;

  useEffectHook(() => {
    const unsubscribe = navigation.addListener('focus', async () => {
      const croppedUri = route?.params?.croppedUri;
      if (croppedUri) {
        navigation.setParams({ croppedUri: null });
        await uploadCroppedAvatar(croppedUri);
      }
    });
    return unsubscribe;
  }, [navigation, route?.params?.croppedUri]);

  useEffectHook(() => {
    const { DeviceEventEmitter } = require('react-native');
    const sub = DeviceEventEmitter.addListener('followChanged', ({ userId, isFollowing }) => {
      if (userId === currentUser?.id) return;
      dispatchProfile({ type: 'ADJUST_FOLLOWING_COUNT', delta: isFollowing ? 1 : -1 });
    });
    return () => sub.remove();
  }, [currentUser]);

  const flatListRef = useRef(null);
  const hasLoaded = useRef(false);

  useFocusEffect(
    useCallback(() => {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    }, [])
  );

  // Re-run when screen is focused (globalUser already loaded by then)
  useFocusEffect(
    useCallback(() => {
      __DEV__ && console.log('[ProfileScreen] useFocusEffect - globalUser:', globalUser?.id, 'hasLoaded:', hasLoaded.current);
      if (globalUser && !hasLoaded.current) {
        hasLoaded.current = true;
        init();
      }
    }, [globalUser])
  );

  // Re-run when globalUser loads after the screen is already focused
  useEffectHook(() => {
    __DEV__ && console.log('[ProfileScreen] useEffect[globalUser] - globalUser:', globalUser?.id, 'hasLoaded:', hasLoaded.current);
    if (globalUser && !hasLoaded.current) {
      hasLoaded.current = true;
      init();
    }
  }, [globalUser]);

  useEffectHook(() => {
    __DEV__ && console.log('[ProfileScreen] reset hasLoaded - targetUserId:', targetUserId, 'globalUser.id:', globalUser?.id);
    hasLoaded.current = false;
  }, [targetUserId, globalUser?.id]);

  async function init() {
    __DEV__ && console.log('[ProfileScreen] init() called - globalUser:', globalUser?.id, 'targetUserId:', targetUserId);
    dispatchProfile({ type: 'RESET' });
    dispatchVideo({ type: 'RESET' });

    if (globalUser) {
      const viewingId = targetUserId ?? globalUser.id;
      const ownProfile = viewingId === globalUser.id;
      __DEV__ && console.log('[ProfileScreen] loading profile for userId:', viewingId, 'isOwnProfile:', ownProfile);
      dispatchProfile({ type: 'SET_USER', currentUser: globalUser, isOwnProfile: ownProfile });
      dispatchUI({ type: 'SET_LOADING', loading: false });

      Promise.all([
        loadProfile(viewingId),
        loadVideos(viewingId, ownProfile),
      ]).catch(e => __DEV__ && console.error('Profile load error:', e));

      if (!ownProfile) {
        supabase.from('follows')
          .select('id')
          .eq('follower_id', globalUser.id)
          .eq('following_id', viewingId)
          .maybeSingle()
          .then(({ data }) => dispatchProfile({ type: 'SET_FOLLOWING', following: !!data }));

        supabase.from('blocks')
          .select('id')
          .eq('blocker_id', globalUser.id)
          .eq('blocked_id', viewingId)
          .maybeSingle()
          .then(({ data }) => dispatchProfile({ type: 'SET_BLOCKED', blocked: !!data }));
      } else {
        loadLikedVideos(globalUser.id);
      }
      return;
    }

    if (!userLoading) {
      const cachedUser = await userCache.get();
      if (cachedUser) {
        const viewingId = targetUserId ?? cachedUser.id;
        const ownProfile = viewingId === cachedUser.id;
        dispatchProfile({ type: 'SET_USER', currentUser: cachedUser, isOwnProfile: ownProfile });
        dispatchUI({ type: 'SET_LOADING', loading: false });
        Promise.all([
          loadProfile(viewingId),
          loadVideos(viewingId, ownProfile),
        ]).catch(e => __DEV__ && console.error('Profile load error:', e));
      }
    }
  }

  async function loadProfile(userId) {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (data) {
      dispatchProfile({ type: 'SET_PROFILE', profile: data });
      checkScholarStatus(userId, data.is_scholar);
      const [{ count: frsCount }, { count: fngCount }] = await Promise.all([
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
      ]);
      dispatchProfile({ type: 'SET_FOLLOW_COUNTS', followersCount: frsCount ?? 0, followingCount: fngCount ?? 0 });
    }
  }

  async function loadVideos(userId, isOwner) {
    const { data: pub } = await supabase.from('videos').select('*').eq('user_id', userId).eq('is_private', false)
      .order('is_pinned', { ascending: false }).order('pin_order', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false });
    const pubVideos = pub ?? [];
    dispatchVideo({ type: 'SET_PUBLIC', videos: pubVideos, totalLikes: pubVideos.reduce((sum, v) => sum + (v.likes_count ?? 0), 0) });
    if (isOwner) {
      const { data: priv } = await supabase.from('videos').select('*').eq('user_id', userId).eq('is_private', true).order('created_at', { ascending: false });
      dispatchVideo({ type: 'SET_PRIVATE', videos: priv ?? [] });
    }
  }

  async function loadLikedVideos(userId) {
    const { data } = await supabase.from('likes').select('video_id, videos(*)').eq('user_id', userId).order('created_at', { ascending: false });
    dispatchVideo({ type: 'SET_LIKED', videos: data?.map(l => l.videos).filter(Boolean) ?? [] });
  }

  async function checkScholarStatus(userId, isScholarValue) {
    const scholar = isScholarValue === true;
    if (scholar) {
      const { data: scholarInfo } = await supabase.from('scholar_applications').select('*')
        .eq('user_id', userId)
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      dispatchProfile({ type: 'SET_SCHOLAR', isScholar: true, scholarData: scholarInfo ?? null });
    } else {
      dispatchProfile({ type: 'SET_SCHOLAR', isScholar: false, scholarData: null });
    }
  }

  async function handleBlock() {
    if (!currentUser || isOwnProfile) return;
    if (blocked) {
      await supabase.from('blocks').delete()
        .eq('blocker_id', currentUser.id)
        .eq('blocked_id', targetUserId);
      dispatchProfile({ type: 'UNBLOCK' });
    } else {
      await supabase.from('blocks').insert({
        blocker_id: currentUser.id,
        blocked_id: targetUserId,
      });
      dispatchProfile({ type: 'BLOCK' });
      await supabase.from('follows').delete()
        .eq('follower_id', currentUser.id)
        .eq('following_id', targetUserId);
    }
  }

  async function handleFollow() {
    if (!currentUser || isOwnProfile) return;
    if (following) {
      dispatchProfile({ type: 'FOLLOW_CHANGE', following: false, delta: -1 });
      const { error } = await supabase.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', targetUserId);
      if (error) { dispatchProfile({ type: 'FOLLOW_CHANGE', following: true, delta: 1 }); Alert.alert('Error', 'Could not unfollow. Please try again.'); }
    } else {
      dispatchProfile({ type: 'FOLLOW_CHANGE', following: true, delta: 1 });
      const { error } = await supabase.from('follows').insert({ follower_id: currentUser.id, following_id: targetUserId });
      if (error) { dispatchProfile({ type: 'FOLLOW_CHANGE', following: false, delta: -1 }); Alert.alert('Error', 'Could not follow. Please try again.'); }
    }
  }

  async function uploadCroppedAvatar(croppedUri) {
    try {
      const user = currentUser;
      if (!user) { Alert.alert('Error', 'Not logged in.'); return; }
      const ext = 'jpg';
      const fileName = `${user.id}_avatar.${ext}`;
      const formData = new FormData();
      formData.append('file', { uri: croppedUri, name: fileName, type: `image/${ext}` });
      const { error: uploadError } = await supabase.storage.from('avatars').upload(fileName, formData, { upsert: true });
      if (uploadError) { Alert.alert('Error', uploadError.message); return; }
      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(fileName);
      const cacheBustedUrl = `${publicUrl}?t=${Date.now()}`;
      await supabase.from('profiles').update({ avatar_url: cacheBustedUrl }).eq('id', user.id);
      dispatchProfile({ type: 'UPDATE_AVATAR', url: cacheBustedUrl });
    } catch (e) {
      Alert.alert('Error', 'Could not upload avatar. Please try again.');
      __DEV__ && console.error('Upload error:', e);
    }
  }

  async function handleChangeAvatar() {
    dispatchUI({ type: 'SET_AVATAR_MODAL', open: false });
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
    });
    if (result.canceled) return;
    const uri = result.assets[0].uri;
    navigation.navigate('AvatarCrop', { imageUri: uri });
  }

  async function handlePinVideo(video) {
    if (!isOwnProfile) return;
    const pinnedCount = publicVideos.filter(v => v.is_pinned).length;
    if (video.is_pinned) {
      Alert.alert('Unpin Video', 'Remove this video from pinned?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unpin', onPress: async () => { await supabase.from('videos').update({ is_pinned: false, pin_order: null }).eq('id', video.id); if (currentUser?.id) loadVideos(currentUser.id, true); } },
      ]);
    } else {
      if (pinnedCount >= 3) { Alert.alert('Limit Reached', 'You can only pin up to 3 videos.'); return; }
      await supabase.from('videos').update({ is_pinned: true, pin_order: pinnedCount + 1 }).eq('id', video.id);
      if (currentUser?.id) loadVideos(currentUser.id, true);
    }
  }

  async function handleDeleteVideo(video) {
    Alert.alert('Delete Video', 'Are you sure? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await supabase.from('videos').delete().eq('id', video.id);
        dispatchVideo({ type: 'REMOVE_VIDEO', id: video.id });
        Alert.alert('Deleted', 'Video has been deleted.');
      }},
    ]);
  }

  function handleDownloadVideo(video) {
    if (downloadedVideoIds.has(video.id)) return;
    performDownload(video);
  }

  async function performDownload(video) {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Please allow access to your media library.');
        return;
      }
      dispatchUI({ type: 'SET_DOWNLOADING', isDownloading: true, progress: 0 });
      const fileUri = FileSystem.documentDirectory + `balagh_${video.id}.mp4`;
      const downloadResumable = FileSystem.createDownloadResumable(
        video.video_url, fileUri, {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          if (totalBytesExpectedToWrite > 0) dispatchUI({ type: 'SET_DOWNLOAD_PROGRESS', progress: totalBytesWritten / totalBytesExpectedToWrite });
        }
      );
      const result = await downloadResumable.downloadAsync();
      if (!result?.uri) throw new Error('Download failed');
      await MediaLibrary.saveToLibraryAsync(result.uri);
      await FileSystem.deleteAsync(result.uri, { idempotent: true });
      dispatchUI({ type: 'SET_DOWNLOADING', isDownloading: false, progress: 0 });
      downloadedVideoIds.add(video.id);
      Alert.alert('Downloaded ✅', 'Video saved to your gallery!');
    } catch (e) {
      dispatchUI({ type: 'SET_DOWNLOADING', isDownloading: false, progress: 0 });
      Alert.alert('Error', 'Could not download the video. Please try again.');
      __DEV__ && console.error('Download error:', e);
    }
  }

  const handleLongPress = useCallback((video) => {
    if (!showVideoOptionsSheet) return;
    const hasDownloaded = downloadedVideoIds.has(video.id);
    showVideoOptionsSheet(video, isOwnProfile, hasDownloaded, {
      onPin: handlePinVideo,
      onDelete: handleDeleteVideo,
      onDownload: handleDownloadVideo,
    });
  }, [showVideoOptionsSheet, isOwnProfile]);

  const onRefresh = useCallback(async () => {
    dispatchUI({ type: 'SET_REFRESHING', refreshing: true });
    try {
      await init();
    } finally {
      dispatchUI({ type: 'SET_REFRESHING', refreshing: false });
    }
  }, []);
  const openVideo = useCallback((videos, index) => navigation.navigate('ProfileVideos', { videos, startIndex: index }), [navigation]);

  const renderItem = useCallback(({ item, index }) => (
    <VideoGridItem item={item} onPress={() => openVideo(activeVideos, index)} onLongPress={handleLongPress} />
  ), [activeVideos, openVideo, handleLongPress]);

  const renderHeader = useCallback(() => (
    <View style={styles.headerSection}>
      <View style={styles.avatarSection}>
        <Avatar
          uri={profile?.avatar_url}
          username={profile?.username}
          size={90}
          onPress={() => { if (isOwnProfile) dispatchUI({ type: 'SET_AVATAR_MODAL', open: true }); else if (profile?.avatar_url) dispatchUI({ type: 'SET_ENLARGE_AVATAR', open: true }); }}
        />
        {isScholar && <View style={styles.scholarBadge}><Text style={styles.scholarBadgeText}>✓ Scholar</Text></View>}
      </View>

      {isScholar ? (
        <View style={styles.scholarCard}>
          <View style={styles.scholarCardHeader}>
            <Text style={styles.scholarCardIcon}>🎓</Text>
            <Text style={styles.scholarCardTitle}>Verified Scholar</Text>
          </View>
          <View style={styles.scholarCardDivider} />
          <View style={styles.scholarCardBody}>
            {scholarData?.full_name && (
              <View style={styles.scholarRow}>
                <Text style={styles.scholarRowLabel}>Full Name</Text>
                <Text style={styles.scholarRowValue}>{scholarData.full_name}</Text>
              </View>
            )}
            {scholarData?.age && (
              <View style={styles.scholarRow}>
                <Text style={styles.scholarRowLabel}>Age</Text>
                <Text style={styles.scholarRowValue}>{scholarData.age}</Text>
              </View>
            )}
            {scholarData?.location && (
              <View style={styles.scholarRow}>
                <Text style={styles.scholarRowLabel}>📍 Location</Text>
                <Text style={styles.scholarRowValue}>{scholarData.location}</Text>
              </View>
            )}
            {scholarData?.education && (
              <View style={styles.scholarRow}>
                <Text style={styles.scholarRowLabel}>🎓 Education</Text>
                <Text style={styles.scholarRowValue}>{scholarData.education}</Text>
              </View>
            )}
            {scholarData?.expertise && (
              <View style={styles.scholarRow}>
                <Text style={styles.scholarRowLabel}>⭐ Expertise</Text>
                <Text style={styles.scholarRowValue}>{scholarData.expertise}</Text>
              </View>
            )}
            {scholarData?.bio && (
              <View style={styles.scholarBioRow}>
                <Text style={styles.scholarRowLabel}>About</Text>
                <Text style={styles.scholarBioValue}>{scholarData.bio}</Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        <View style={styles.regularInfo}>
          <Text style={styles.displayName}>{profile?.full_name || profile?.username || 'User'}</Text>
          <Text style={styles.usernameText}>@{profile?.username || 'username'}</Text>
          {profile?.bio ? (
            <Text style={styles.bioText}>{profile.bio}</Text>
          ) : isOwnProfile ? (
            <AnimatedButton onPress={() => navigation.navigate('EditProfile')}>
              <Text style={styles.addBioText}>+ Add bio</Text>
            </AnimatedButton>
          ) : null}
        </View>
      )}

      <View style={styles.statsRow}>
        <View style={styles.statItem}>
          <Text style={styles.statNum}>{formatCount(publicVideos.length)}</Text>
          <Text style={styles.statLabel}>Videos</Text>
        </View>
        <View style={styles.statDivider} />
        <AnimatedButton style={styles.statItem} onPress={() => navigation.navigate('FollowList', { userId: targetUserId ?? currentUser?.id, type: 'followers', username: profile?.username })}>
          <Text style={styles.statNum}>{formatCount(followersCount)}</Text>
          <Text style={styles.statLabel}>Followers</Text>
        </AnimatedButton>
        <View style={styles.statDivider} />
        <AnimatedButton style={styles.statItem} onPress={() => navigation.navigate('FollowList', { userId: targetUserId ?? currentUser?.id, type: 'following', username: profile?.username })}>
          <Text style={styles.statNum}>{formatCount(followingCount)}</Text>
          <Text style={styles.statLabel}>Following</Text>
        </AnimatedButton>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statNum}>{formatCount(totalLikes)}</Text>
          <Text style={styles.statLabel}>Likes</Text>
        </View>
      </View>

      {isOwnProfile ? (
        !isScholar && (
          <View style={styles.actionButtons}>
            <AnimatedButton style={styles.scholarApplyBtn} onPress={() => navigation.navigate('ApplyScholar')}>
              <Text style={styles.scholarApplyBtnText}>🎓 Apply as Scholar</Text>
            </AnimatedButton>
          </View>
        )
      ) : (
        <View style={styles.actionButtons}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <AnimatedButton style={[styles.followBtn, following && styles.followingBtn, { flex: 1 }]} onPress={handleFollow}>
              <Text style={[styles.followBtnText, following && styles.followingBtnText]}>
                {following ? '✓ Following' : '+ Follow'}
              </Text>
            </AnimatedButton>
            <AnimatedButton style={styles.blockBtn} onPress={handleBlock}>
              <Text style={styles.blockBtnText}>{blocked ? '🚫 Blocked' : 'Block'}</Text>
            </AnimatedButton>
          </View>
        </View>
      )}

      <View style={styles.tabs}>
        <AnimatedButton style={[styles.tab, activeTab === 'videos' && styles.activeTab]} onPress={() => dispatchVideo({ type: 'SET_ACTIVE_TAB', tab: 'videos' })}>
          <Text style={[styles.tabText, activeTab === 'videos' && styles.activeTabText]}>🎥</Text>
        </AnimatedButton>
        {isOwnProfile && (
          <AnimatedButton style={[styles.tab, activeTab === 'private' && styles.activeTab]} onPress={() => dispatchVideo({ type: 'SET_ACTIVE_TAB', tab: 'private' })}>
            <Text style={[styles.tabText, activeTab === 'private' && styles.activeTabText]}>🔒</Text>
          </AnimatedButton>
        )}
        <AnimatedButton style={[styles.tab, activeTab === 'liked' && styles.activeTab]} onPress={() => dispatchVideo({ type: 'SET_ACTIVE_TAB', tab: 'liked' })}>
          <Text style={[styles.tabText, activeTab === 'liked' && styles.activeTabText]}>❤️</Text>
        </AnimatedButton>
      </View>
    </View>
  ), [profile, isScholar, scholarData, publicVideos, followersCount, followingCount, totalLikes, isOwnProfile, following, blocked, activeTab, currentUser, targetUserId, navigation]);

  const activeVideos = activeTab === 'videos' ? publicVideos : activeTab === 'private' ? privateVideos : likedVideos;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />

      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        {!isOwnProfile && (
          <AnimatedButton onPress={() => navigation.goBack()} style={styles.topBarBtn}>
            <Text style={styles.topBarBtnText}>←</Text>
          </AnimatedButton>
        )}
        <View style={{ flex: 1 }} />
        {isOwnProfile && (
          <AnimatedButton onPress={() => navigation.navigate('Settings')} style={styles.topBarBtn}>
            <Text style={styles.topBarBtnText}>☰</Text>
          </AnimatedButton>
        )}
      </View>

      <FlashList
        ref={flatListRef}
        data={activeVideos}
        keyExtractor={(item) => item.id}
        numColumns={3}
        estimatedItemSize={150}
        ListHeaderComponent={renderHeader}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.gold} progressViewOffset={35} />}
        renderItem={renderItem}
        ListEmptyComponent={
          <View style={styles.emptyGrid}>
            <Text style={styles.emptyGridIcon}>{activeTab === 'videos' ? '🎥' : activeTab === 'private' ? '🔒' : '❤️'}</Text>
            <Text style={styles.emptyGridText}>{activeTab === 'videos' ? 'No videos yet' : activeTab === 'private' ? 'No private videos' : 'No liked videos'}</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 20, paddingTop: insets.top + 50 }}
        showsVerticalScrollIndicator={false}
      />

      <DownloadProgressOverlay visible={isDownloading} progress={downloadProgress} />

      <Modal visible={avatarModal} transparent animationType="slide" onRequestClose={() => dispatchUI({ type: 'SET_AVATAR_MODAL', open: false })} statusBarTranslucent>
        <Pressable style={styles.modalBackdrop} onPress={() => dispatchUI({ type: 'SET_AVATAR_MODAL', open: false })} />
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>Profile Photo</Text>
          {profile?.avatar_url && (
            <AnimatedButton style={styles.modalOption} onPress={() => { dispatchUI({ type: 'SET_AVATAR_MODAL', open: false }); dispatchUI({ type: 'SET_ENLARGE_AVATAR', open: true }); }}>
              <Text style={styles.modalOptionText}>👁️ View Photo</Text>
            </AnimatedButton>
          )}
          <AnimatedButton style={styles.modalOption} onPress={handleChangeAvatar}>
            <Text style={styles.modalOptionText}>📷 Change Photo</Text>
          </AnimatedButton>
          <AnimatedButton style={styles.modalOption} onPress={() => dispatchUI({ type: 'SET_AVATAR_MODAL', open: false })}>
            <Text style={[styles.modalOptionText, { color: '#ef4444' }]}>Cancel</Text>
          </AnimatedButton>
        </View>
      </Modal>

      <Modal visible={enlargeAvatar} transparent animationType="fade" onRequestClose={() => dispatchUI({ type: 'SET_ENLARGE_AVATAR', open: false })} statusBarTranslucent>
        <Pressable style={styles.enlargeBackdrop} onPress={() => dispatchUI({ type: 'SET_ENLARGE_AVATAR', open: false })}>
          <View style={[styles.enlargeCloseBtn, { top: insets.top + 12 }]}>
            <Text style={styles.enlargeCloseBtnText}>✕</Text>
          </View>
          {profile?.avatar_url && (
            <Image source={{ uri: profile.avatar_url, cache: 'force-cache', headers: { 'Cache-Control': 'max-age=86400' } }} style={styles.enlargedAvatar} resizeMode="contain" />
          )}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 4,
    backgroundColor: 'rgba(255,255,255,0.9)', position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
  },
  topBarBtn: { padding: 8 },
  topBarBtnText: { color: '#111', fontSize: 22, fontWeight: '700' },
  headerSection: { backgroundColor: '#ffffff', paddingBottom: 4 },
  avatarSection: { alignItems: 'center', paddingTop: 8, paddingBottom: 12 },
  scholarBadge: { marginTop: 8, backgroundColor: COLORS.gold, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  scholarBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  regularInfo: { alignItems: 'center', paddingHorizontal: 24, marginBottom: 10 },
  displayName: { fontSize: 20, fontWeight: '800', color: '#111', marginBottom: 2 },
  usernameText: { fontSize: 14, color: '#888', marginBottom: 8 },
  bioText: { fontSize: 14, color: '#444', textAlign: 'center', lineHeight: 20 },
  addBioText: { fontSize: 14, color: COLORS.gold, fontWeight: '600' },
  scholarCard: { marginHorizontal: 16, marginBottom: 14, backgroundColor: '#f9f9f9', borderRadius: 16, borderWidth: 1, borderColor: `${COLORS.gold}44`, overflow: 'hidden' },
  scholarCardHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: `${COLORS.gold}18`, gap: 8 },
  scholarCardIcon: { fontSize: 18 },
  scholarCardTitle: { fontSize: 15, fontWeight: '800', color: COLORS.goldDark },
  scholarCardDivider: { height: 1, backgroundColor: `${COLORS.gold}33` },
  scholarCardBody: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  scholarRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  scholarRowLabel: { fontSize: 13, color: '#888', fontWeight: '600', flex: 1 },
  scholarRowValue: { fontSize: 13, color: '#222', fontWeight: '500', flex: 2, textAlign: 'right' },
  scholarBioRow: { gap: 4 },
  scholarBioValue: { fontSize: 13, color: '#444', lineHeight: 20 },
  statsRow: { flexDirection: 'row', backgroundColor: '#f5f5f5', borderRadius: 16, marginHorizontal: 16, marginBottom: 10, paddingVertical: 8, justifyContent: 'space-around', alignItems: 'center' },
  statItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, minWidth: 70 },
  statNum: { fontSize: 18, fontWeight: '800', color: '#111' },
  statLabel: { fontSize: 11, color: '#888', marginTop: 2 },
  statDivider: { width: 1, height: 28, backgroundColor: '#ddd' },
  actionButtons: { paddingHorizontal: 16, marginBottom: 10 },
  scholarApplyBtn: { backgroundColor: COLORS.gold, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  scholarApplyBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  followBtn: { backgroundColor: COLORS.gold, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  followingBtn: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: COLORS.gold },
  followBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  followingBtnText: { color: COLORS.goldDark },
  tabs: { flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: '#e5e5e5' },
  tab: { flex: 1, paddingVertical: 4, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  activeTab: { borderBottomColor: COLORS.gold },
  tabText: { fontSize: 20, opacity: 0.35 },
  activeTabText: { opacity: 1 },
  gridItem: { flex: 1, aspectRatio: 0.8, margin: 0.5, backgroundColor: '#f0f0f0' },
  gridThumb: { width: '100%', height: '100%' },
  gridOverlay: { position: 'absolute', bottom: 4, left: 4 },
  gridPlayCount: { color: '#fff', fontSize: 12, fontWeight: '600', textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  pinnedLabel: { position: 'absolute', top: 4, left: 4 },
  pinnedLabelText: { fontSize: 14 },
  privateLabel: { position: 'absolute', top: 4, right: 4 },
  privateLabelText: { fontSize: 14 },
  emptyGrid: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  emptyGridIcon: { fontSize: 48 },
  emptyGridText: { color: '#aaa', fontSize: 15, fontWeight: '600' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  modalSheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 40, paddingTop: 16, borderTopWidth: 0.5, borderColor: '#eee' },
  modalTitle: { color: '#111', fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: 16 },
  modalOption: { paddingVertical: 16, paddingHorizontal: 24 },
  modalOptionText: { color: '#111', fontSize: 16, fontWeight: '500' },
  enlargeBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center' },
  enlargedAvatar: { width: '90%', aspectRatio: 1, borderRadius: 12 },
  enlargeCloseBtn: { position: 'absolute', right: 20, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  enlargeCloseBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  dlOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', zIndex: 99, backgroundColor: 'rgba(0,0,0,0.4)', pointerEvents: 'none' },
  dlBox: { backgroundColor: '#fff', borderRadius: 20, padding: 28, width: '75%', alignItems: 'center', gap: 14 },
  dlTitle: { color: '#111', fontSize: 16, fontWeight: '700' },
  dlBarBg: { width: '100%', height: 8, backgroundColor: '#eee', borderRadius: 4, overflow: 'hidden' },
  dlBarFill: { height: '100%', backgroundColor: COLORS.gold, borderRadius: 4 },
  dlPercent: { color: COLORS.goldDark, fontSize: 22, fontWeight: '800' },
  blockBtn: { backgroundColor: '#f3f4f6', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  blockBtnText: { color: '#ef4444', fontSize: 14, fontWeight: '700' },
});