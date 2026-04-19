import {
  View, Text, StyleSheet,
  Image, Modal, Alert, useWindowDimensions,
  RefreshControl, Animated, Pressable,
  TouchableOpacity,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import React, { useReducer, useEffect as useEffectHook, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { SystemBars } from 'react-native-edge-to-edge';
import NetInfo from '@react-native-community/netinfo';
import { supabase } from '../lib/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';

import AnimatedButton from './AnimatedButton';
import { useDownload } from '../context/DownloadContext';
import { userCache } from '../utils/userCache';
import { useUser } from '../context/UserContext';
import { COLORS } from '../constants/theme';
import ModernDialog from './ModernDialog';
import { ROUTES } from '../constants/routes';
import { useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

const useDownloadedVideos = () => {
  const downloadedRef = useRef(new Set());
  return downloadedRef.current;
};

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
  hasPendingApplication: false,
};

function profileReducer(state, action) {
  switch (action.type) {
    case 'RESET': return { ...initialProfileState };
    case 'SET_USER': return { ...state, currentUser: action.currentUser, isOwnProfile: action.isOwnProfile };
    case 'SET_PROFILE': return { ...state, profile: action.profile };
    case 'UPDATE_AVATAR': return { ...state, profile: state.profile ? { ...state.profile, avatar_url: action.url } : state.profile };
    case 'SET_SCHOLAR': return { ...state, isScholar: action.isScholar, scholarData: action.scholarData };
    case 'SET_PENDING_APPLICATION': return { ...state, hasPendingApplication: action.hasPendingApplication };
    case 'SET_FOLLOW_COUNTS': return { ...state, followersCount: action.followersCount, followingCount: action.followingCount };
    case 'SET_FOLLOWING': return { ...state, following: action.following };
    case 'SET_ALL_PROFILE': return { ...state, profile: action.profile, followersCount: action.followersCount, followingCount: action.followingCount, isScholar: action.isScholar, scholarData: action.scholarData, hasPendingApplication: action.hasPendingApplication };
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
  livestreams: [],
  totalLikes: 0,
  activeTab: 'videos',
};

function videoReducer(state, action) {
  switch (action.type) {
    case 'RESET': return { ...initialVideoState };
    case 'SET_PUBLIC': return { ...state, publicVideos: action.videos, totalLikes: action.totalLikes };
    case 'SET_PRIVATE': return { ...state, privateVideos: action.videos };
    case 'SET_LIKED': return { ...state, likedVideos: action.videos };
    case 'SET_LIVESTREAMS': return { ...state, livestreams: action.videos };
    case 'SET_ACTIVE_TAB': return { ...state, activeTab: action.tab };
    case 'REMOVE_VIDEO': return {
      ...state,
      publicVideos: state.publicVideos.filter(v => v.id !== action.id),
      privateVideos: state.privateVideos.filter(v => v.id !== action.id),
      livestreams: state.livestreams.filter(v => v.id !== action.id),
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
  toast: null,
};

function uiReducer(state, action) {
  switch (action.type) {
    case 'SET_LOADING': return { ...state, loading: action.loading };
    case 'SET_REFRESHING': return { ...state, refreshing: action.refreshing };
    case 'SET_AVATAR_MODAL': return { ...state, avatarModal: action.open };
    case 'SET_ENLARGE_AVATAR': return { ...state, enlargeAvatar: action.open };
    case 'SET_DOWNLOADING': return { ...state, isDownloading: action.isDownloading, downloadProgress: action.progress ?? state.downloadProgress };
    case 'SET_DOWNLOAD_PROGRESS': return { ...state, downloadProgress: action.progress };
    case 'SET_TOAST': 
      console.log('[TOAST REDUCER] SET_TOAST called with:', JSON.stringify(action.toast));
      return { ...state, toast: action.toast };
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

const VideoGridItem = React.memo(function VideoGridItem({ item, onPress, onLongPress, isLivestreamItem }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  // Livestreams have video_url, regular videos have video_uri

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
        <View style={styles.gridOverlay}><Text style={styles.gridPlayCount}>▶ {formatCount(item.views_count || item.view_count)}</Text></View>
        {item.is_pinned && <View style={styles.pinnedLabel}><Text style={styles.pinnedLabelText}>📌</Text></View>}
        {item.is_private && <View style={styles.privateLabel}><Text style={styles.privateLabelText}>🔒</Text></View>}
        {isLivestreamItem && (
          <View style={styles.liveLabel}>
            <Text style={styles.liveLabelText}>
              {item.video_url && item.video_url !== 'processing' ? '🔴 REPLAY' : '⏳ Processing...'}
            </Text>
          </View>
        )}
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
  const { user: globalUser, loading: userLoading, blockUser } = useUser();

  useEffectHook(() => {
    if (!navigation) return;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigation.replace(ROUTES.LOGIN);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) navigation.replace(ROUTES.LOGIN);
    });
    return () => subscription.unsubscribe();
  }, []);

  const downloadContext = useDownload();
  const showVideoOptionsSheet = downloadContext?.showVideoOptionsSheet;

  const [profileState, dispatchProfile] = useReducer(profileReducer, initialProfileState);
  const [videoState, dispatchVideo] = useReducer(videoReducer, initialVideoState);
  const [uiState, dispatchUI] = useReducer(uiReducer, initialUIState);

  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [targetIsAdmin, setTargetIsAdmin] = useState(false);
  const [adminCount, setAdminCount] = useState(0);
  const [addingAdmin, setAddingAdmin] = useState(false);

  const { profile, currentUser, isOwnProfile, following, blocked, followersCount, followingCount, isScholar, scholarData, hasPendingApplication } = profileState;
  const { publicVideos, privateVideos, likedVideos, livestreams, totalLikes, activeTab } = videoState;
  const { loading, refreshing, avatarModal, enlargeAvatar, isDownloading, downloadProgress, toast } = uiState;

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
  const livestreamIdsRef = useRef(new Set());
  const hasLoaded = useRef(false);
  const downloadedVideoIds = useDownloadedVideos();

  // Track last user to prevent duplicate resets
  const lastUserIdRef = useRef(null);

  // Track timeouts for cleanup
  const timeoutsRef = useRef([]);

  useFocusEffect(
    useCallback(() => {
      // Don't fetch here - rely on listener which is more reliable
      // The listener continuously monitors connection state
      
      // Subscribe to network changes
      const unsubscribe = NetInfo.addEventListener(state => {
        const offline = !state.isConnected || state.isInternetReachable === false;
        setIsOffline(offline);
      });
      
      // Scroll to top on focus
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });

      // Always reload livestreams on focus to catch new recordings
      const user = globalUser || cachedUser;
      const viewingId = targetUserId ?? user?.id;
      if (viewingId && !isOffline) {
        loadLivestreams(viewingId);
        // Poll a few times to catch processing → ready transition
        // Clear any existing timeouts first
        timeoutsRef.current.forEach(clearTimeout);
        timeoutsRef.current = [];
        // Set new timeouts
        timeoutsRef.current = [
          setTimeout(() => loadLivestreams(viewingId), 3000),
          setTimeout(() => loadLivestreams(viewingId), 6000),
          setTimeout(() => loadLivestreams(viewingId), 12000),
          setTimeout(() => loadLivestreams(viewingId), 20000),
        ];
      }
      
      // DEBUG: Log focus state
      
      // Check if we need to load a different profile
      const currentId = targetUserId ?? globalUser?.id ?? cachedUser?.id;
      const activeUser = globalUser || cachedUser;
      
      let initTimer = null;
      
      // Always refresh on focus to get latest data (especially after livestream)
      if (currentId) {
        if (currentId !== lastUserIdRef.current) {
          lastUserIdRef.current = currentId;
        }
        
        // Delay fetch slightly to allow background save to complete
        // This ensures new livestreams appear immediately after ending stream
        initTimer = setTimeout(() => {
          init(currentId);
        }, 0);
      } else if (activeUser) {
        init(currentId);
      }
      
      // Dark icons for light/white background
      const entry = SystemBars.pushStackEntry({ style: 'dark' });
      
      return () => {
        unsubscribe();
        SystemBars.popStackEntry(entry);
        if (initTimer) clearTimeout(initTimer);
        // Clear all livestream polling timeouts
        timeoutsRef.current.forEach(clearTimeout);
        timeoutsRef.current = [];
      };
    }, [targetUserId, globalUser?.id, cachedUser?.id])
  );

  // Reset lastUserIdRef on unmount to allow fresh load next time
  useEffectHook(() => {
    return () => {
      lastUserIdRef.current = null;
    };
  }, []);

  useEffectHook(() => {
    livestreamIdsRef.current = new Set(livestreams.map(v => v.id));
  }, [livestreams]);

  async function init(viewingId) {
    const user = globalUser || cachedUser;
    
    // Only reset video state - preserve profile during loading to avoid blank screen
    dispatchVideo({ type: 'RESET' });
    // Note: We don't dispatch RESET for profile here to avoid blank screen
    // Profile will be updated when data loads, or preserved if offline

    if (user && viewingId) {
      const ownProfile = viewingId === user.id;
      dispatchProfile({ type: 'SET_USER', currentUser: user, isOwnProfile: ownProfile });

      // Check admin status
      if (ownProfile) {
        const { data: adminData } = await supabase.from('admins').select('id, role').eq('user_id', user.id).limit(1).single();
        console.log('ADMIN DEBUG:', { userId: user.id, adminData, isAdmin: !!adminData, isSuperAdmin: adminData?.role === 'super_admin' });
        setIsAdmin(!!adminData);
        setIsSuperAdmin(adminData?.role === 'super_admin');
      } else {
        // Check if current user is super_admin
        const { data: myAdminData } = await supabase.from('admins').select('role').eq('user_id', user.id).maybeSingle();
        setIsSuperAdmin(myAdminData?.role === 'super_admin');
        // Check if target user is admin
        const { data: targetAdminData } = await supabase.from('admins').select('id').eq('user_id', viewingId).maybeSingle();
        setTargetIsAdmin(!!targetAdminData);
        // Get admin count
        const { count } = await supabase.from('admins').select('*', { count: 'exact', head: true });
        setAdminCount(count || 0);
      }

      // If offline, skip network requests and show cached data only
      if (isOffline) {
        // Try to load from cache if available, but don't fail
        try {
          const cachedProfile = await userCache.get();
          if (cachedProfile) {
            dispatchProfile({ type: 'SET_PROFILE', profile: cachedProfile });
          }
        } catch (e) {
        }
        return;
      }

      Promise.all([
        loadProfile(viewingId),
        loadVideos(viewingId, ownProfile),
        loadLivestreams(viewingId),
      ]).then(([profileResult, videoResult, _]) => {
        if (profileResult) {
          const { data, frsCount, fngCount, scholarResult } = profileResult;
          dispatchProfile({
            type: 'SET_ALL_PROFILE',
            profile: data,
            followersCount: frsCount ?? 0,
            followingCount: fngCount ?? 0,
            isScholar: data.is_scholar === true,
            scholarData: data.is_scholar ? (scholarResult.data ?? null) : null,
            hasPendingApplication: data.is_scholar ? false : !!scholarResult.data,
          });
        }
        if (videoResult) {
          const { pubVideos, privVideos } = videoResult;
          dispatchVideo({ type: 'SET_PUBLIC', videos: pubVideos, totalLikes: pubVideos.reduce((sum, v) => sum + (v.likes_count ?? 0), 0) });
          dispatchVideo({ type: 'SET_PRIVATE', videos: privVideos });
        }
        dispatchUI({ type: 'SET_LOADING', loading: false });
      }).catch(async (e) => {
        
        // If API fails, try to use cached data
        try {
          const cachedProfile = await userCache.get();
          if (cachedProfile) {
            // Keep showing cached data, show offline toast
            dispatchProfile({ type: 'SET_PROFILE', profile: cachedProfile });
            dispatchUI({ type: 'SET_TOAST', toast: { message: 'Offline mode - showing cached data', type: 'offline' } });
            setTimeout(() => dispatchUI({ type: 'SET_TOAST', toast: null }), 2000);
          } else {
            // No cached data - show error state
            dispatchUI({ type: 'SET_TOAST', toast: { message: 'Failed to load profile. Please check your connection.', type: 'error' } });
            setTimeout(() => dispatchUI({ type: 'SET_TOAST', toast: null }), 3000);
          }
        } catch (cacheError) {
        }
      });

      if (!ownProfile) {
        supabase.from('follows')
          .select('id')
          .eq('follower_id', user.id)
          .eq('following_id', viewingId)
          .maybeSingle()
          .then(({ data }) => dispatchProfile({ type: 'SET_FOLLOWING', following: !!data }))
          .catch(() => {/* offline - ignore */});

        supabase.from('blocks')
          .select('id')
          .eq('blocker_id', user.id)
          .eq('blocked_id', viewingId)
          .maybeSingle()
          .then(({ data }) => dispatchProfile({ type: 'SET_BLOCKED', blocked: !!data }))
          .catch(() => {/* offline - ignore */});
      } else {
        loadLikedVideos(user.id).catch(() => {/* offline - ignore */});
      }
      return;
    }
  }

  async function loadProfile(userId) {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (!data) return null;
    const [{ count: frsCount }, { count: fngCount }, scholarResult] = await Promise.all([
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
      data.is_scholar
        ? supabase.from('scholar_applications').select('*').eq('user_id', userId).order('submitted_at', { ascending: false }).limit(1).maybeSingle()
        : supabase.from('scholar_applications').select('id').eq('user_id', userId).eq('status', 'pending').maybeSingle(),
    ]);
    return { data, frsCount, fngCount, scholarResult };
  }

  async function loadVideos(userId, isOwner) {
    const { data: pub } = await supabase.from('videos').select('*').eq('user_id', userId).eq('is_private', false)
      .order('is_pinned', { ascending: false }).order('pin_order', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false });
    const pubVideos = pub ?? [];
    let privVideos = [];
    if (isOwner) {
      const { data: priv } = await supabase.from('videos').select('*').eq('user_id', userId).eq('is_private', true).order('created_at', { ascending: false });
      privVideos = priv ?? [];
    }
    return { pubVideos, privVideos };
  }

  async function loadLivestreams(userId) {
    const { data, error } = await supabase
      .from('livestreams')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) {
    }
    
    console.log('[PROFILE] Fetched livestreams count:', data?.length);
    console.log('[PROFILE] First livestream:', data?.[0]);
    
    dispatchVideo({ type: 'SET_LIVESTREAMS', videos: data ?? [] });
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
      dispatchProfile({ type: 'SET_PENDING_APPLICATION', hasPendingApplication: false });
    } else {
      // Check for pending application
      const { data: pendingApp } = await supabase
        .from('scholar_applications')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .maybeSingle();
      dispatchProfile({ type: 'SET_SCHOLAR', isScholar: false, scholarData: null });
      dispatchProfile({ type: 'SET_PENDING_APPLICATION', hasPendingApplication: !!pendingApp });
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
      blockUser(targetUserId);
      navigation.goBack();
    }
  }

  const handleAddAdmin = useCallback(async () => {
    if (!currentUser || isOwnProfile || !isSuperAdmin || targetIsAdmin || adminCount >= 10) return;
    setAddingAdmin(true);
    try {
      const { error } = await supabase.from('admins').insert({
        user_id: targetUserId,
        role: 'admin',
        added_by: currentUser.id,
      });
      if (error) {
        if (error.message?.includes('duplicate') || error.code === '23505') {
          setDialog({ visible: true, title: 'Already Admin', message: 'This user is already an admin.', type: 'warning', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
        } else {
          setDialog({ visible: true, title: 'Error', message: error.message || 'Failed to add admin.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
        }
        setAddingAdmin(false);
        return;
      }
      setTargetIsAdmin(true);
      setAdminCount(prev => prev + 1);
      setDialog({ visible: true, title: 'Admin Added!', message: `Admin added! @${profile?.username || 'user'} is now an admin.`, type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    } catch (e) {
      setDialog({ visible: true, title: 'Error', message: 'Could not add admin. Please try again.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    } finally {
      setAddingAdmin(false);
    }
  }, [currentUser, isOwnProfile, isSuperAdmin, targetIsAdmin, adminCount, targetUserId, profile?.username]);

  async function handleFollow() {
    if (!currentUser || isOwnProfile) return;
    if (following) {
      dispatchProfile({ type: 'FOLLOW_CHANGE', following: false, delta: -1 });
      const { error } = await supabase.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', targetUserId);
      if (error) { dispatchProfile({ type: 'FOLLOW_CHANGE', following: true, delta: 1 }); setDialog({ visible: true, title: 'Error', message: 'Could not unfollow. Please try again.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] }); }
    } else {
      dispatchProfile({ type: 'FOLLOW_CHANGE', following: true, delta: 1 });
      const { error } = await supabase.from('follows').insert({ follower_id: currentUser.id, following_id: targetUserId });
      if (error) { dispatchProfile({ type: 'FOLLOW_CHANGE', following: false, delta: -1 }); setDialog({ visible: true, title: 'Error', message: 'Could not follow. Please try again.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] }); }
    }
  }

  async function uploadCroppedAvatar(croppedUri) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setDialog({ visible: true, title: 'Error', message: 'Not logged in.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] }); return; }
      const user = session.user;
      const ext = 'jpg';
      const fileName = `${user.id}_avatar.${ext}`;
      const formData = new FormData();
      formData.append('file', { uri: croppedUri, name: fileName, type: `image/${ext}` });
      const { error: uploadError } = await supabase.storage.from('avatars').upload(fileName, formData, { upsert: true });
      if (uploadError) { setDialog({ visible: true, title: 'Error', message: uploadError.message, type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] }); return; }
      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(fileName);
      const cacheBustedUrl = `${publicUrl}?t=${Date.now()}`;
      await supabase.from('profiles').update({ avatar_url: cacheBustedUrl }).eq('id', user.id);
      dispatchProfile({ type: 'UPDATE_AVATAR', url: cacheBustedUrl });
    } catch (e) {
      setDialog({ visible: true, title: 'Error', message: 'Could not upload avatar. Please try again.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    }
  }

  async function handleChangeAvatar() {
    try {
      dispatchUI({ type: 'SET_AVATAR_MODAL', open: false });
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      });
      if (result.canceled) return;
      const uri = result.assets[0].uri;
      navigation.navigate(ROUTES.AVATAR_CROP, { imageUri: uri });
    } catch (e) {
      setDialog({ visible: true, title: 'Error', message: 'Could not open image picker. Please try again.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    }
  }

  async function handlePinVideo(video) {
    if (!isOwnProfile) return;
    try {
      const pinnedCount = (publicVideos || []).filter(v => v.is_pinned).length;
      if (video.is_pinned) {
        setDialog({ visible: true, title: 'Unpin Video', message: 'Remove this video from pinned?', type: 'confirm', buttons: [
          { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
          { text: 'Unpin', onPress: async () => { 
            setDialog(d => ({ ...d, visible: false }));
            try {
              await supabase.from('videos').update({ is_pinned: false, pin_order: null }).eq('id', video.id); 
              if (currentUser?.id) loadVideos(currentUser.id, true); 
            } catch (e) {
              setDialog({ visible: true, title: 'Error', message: 'Could not unpin video. Please try again.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            }
          } },
        ]});
      } else {
        if (pinnedCount >= 3) { setDialog({ visible: true, title: 'Limit Reached', message: 'You can only pin up to 3 videos.', type: 'warning', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] }); return; }
        await supabase.from('videos').update({ is_pinned: true, pin_order: pinnedCount + 1 }).eq('id', video.id);
        if (currentUser?.id) loadVideos(currentUser.id, true);
      }
    } catch (e) {
      setDialog({ visible: true, title: 'Error', message: 'Could not pin video. Please try again.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    }
  }

  async function handleDeleteVideo(video) {
    const skipAlert = await AsyncStorage.getItem('skip_delete_alert');
    if (skipAlert === 'true') {
      try {
        const table = livestreamIdsRef.current.has(video.id) ? 'livestreams' : 'videos';
        console.log('[DELETE] fast path - table:', table, 'video id:', video.id);
        const { error } = await supabase.from(table).delete().eq('id', video.id);
        console.log('[DELETE] fast path - delete result error:', error);
        if (error) { setDialog({ visible: true, title: 'Error', message: error.message, type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] }); return; }
        dispatchVideo({ type: 'REMOVE_VIDEO', id: video.id });
        console.log('[DELETE] fast path - about to set timeout for toast');
        setTimeout(() => {
          console.log('[DELETE] fast path - inside timeout, dispatching toast');
          dispatchUI({ type: 'SET_TOAST', toast: { message: 'Done', type: 'success' } });
          setTimeout(() => {
            console.log('[DELETE] fast path - clearing toast');
            dispatchUI({ type: 'SET_TOAST', toast: null });
          }, 1500);
        }, 300);
      } catch (e) {
        console.log('[DELETE] fast path - CATCH ERROR:', e);
        setDialog({ visible: true, title: 'Error', message: 'Could not delete video. Please try again.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
      }
    } else {
      setDontShowAgain(false);
      setDeleteModal({ visible: true, video });
    }
  }

  async function confirmDelete() {
    const { video } = deleteModal;
    console.log('[DELETE] confirmDelete called, video:', video?.id);
    setDeleteModal({ visible: false, video: null });
    try {
      const table = livestreamIdsRef.current.has(video.id) ? 'livestreams' : 'videos';
      const { error } = await supabase.from(table).delete().eq('id', video.id);
      console.log('[DELETE] supabase delete result - error:', error);
      if (error) { setDialog({ visible: true, title: 'Error', message: error.message, type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] }); return; }
      dispatchVideo({ type: 'REMOVE_VIDEO', id: video.id });
      console.log('[DELETE] dontShowAgain:', dontShowAgain);
      if (dontShowAgain) await AsyncStorage.setItem('skip_delete_alert', 'true');
      setTimeout(() => {
        console.log('[DELETE] firing toast now');
        dispatchUI({ type: 'SET_TOAST', toast: { message: 'Done', type: 'success' } });
        setTimeout(() => dispatchUI({ type: 'SET_TOAST', toast: null }), 1500);
      }, 300);
    } catch (e) {
      console.log('[DELETE] catch error:', e);
      setDialog({ visible: true, title: 'Error', message: 'Could not delete video. Please try again.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    }
  }

  function handleDownloadVideo(video) {
    if (downloadedVideoIds.has(video.id)) return;
    performDownload(video);
  }

  async function performDownload(video) {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        setDialog({ visible: true, title: 'Permission Denied', message: 'Please allow access to your media library.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
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
      setDialog({ visible: true, title: 'Downloaded ✅', message: 'Video saved to your gallery!', type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    } catch (e) {
      dispatchUI({ type: 'SET_DOWNLOADING', isDownloading: false, progress: 0 });
      setDialog({ visible: true, title: 'Error', message: 'Could not download the video. Please try again.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
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

  const handleOpenVideo = useCallback((videos, index) => {
    openVideo(videos, index);
  }, [openVideo]);

  const handleAvatarPress = useCallback(() => {
    if (isOwnProfile) {
      dispatchUI({ type: 'SET_AVATAR_MODAL', open: true });
    } else if (profile?.avatar_url) {
      dispatchUI({ type: 'SET_ENLARGE_AVATAR', open: true });
    }
  }, [isOwnProfile, profile?.avatar_url]);

  const handleNavigateEditProfile = useCallback(() => {
    navigation.navigate(ROUTES.EDIT_PROFILE);
  }, [navigation]);

  const handleNavigateFollowers = useCallback(() => {
    navigation.navigate(ROUTES.FOLLOW_LIST, { userId: targetUserId ?? currentUser?.id, type: 'followers', username: profile?.username });
  }, [navigation, targetUserId, currentUser?.id, profile?.username]);

  const handleNavigateFollowing = useCallback(() => {
    navigation.navigate(ROUTES.FOLLOW_LIST, { userId: targetUserId ?? currentUser?.id, type: 'following', username: profile?.username });
  }, [navigation, targetUserId, currentUser?.id, profile?.username]);

  const handleNavigateApplyScholar = useCallback(() => {
    navigation.navigate(ROUTES.APPLY_SCHOLAR);
  }, [navigation]);

  const handleTabVideos = useCallback(() => {
    dispatchVideo({ type: 'SET_ACTIVE_TAB', tab: 'videos' });
  }, []);

  const handleTabPrivate = useCallback(() => {
    dispatchVideo({ type: 'SET_ACTIVE_TAB', tab: 'private' });
  }, []);

  const handleTabLiked = useCallback(() => {
    dispatchVideo({ type: 'SET_ACTIVE_TAB', tab: 'liked' });
  }, []);

  const handleTabLivestreams = useCallback(() => {
    dispatchVideo({ type: 'SET_ACTIVE_TAB', tab: 'livestreams' });
  }, []);

  const handleNavigateSettings = useCallback(() => {
    navigation.navigate(ROUTES.SETTINGS);
  }, [navigation]);

  const handleCloseAvatarModal = useCallback(() => {
    dispatchUI({ type: 'SET_AVATAR_MODAL', open: false });
  }, []);

  const handleViewEnlargedAvatar = useCallback(() => {
    dispatchUI({ type: 'SET_AVATAR_MODAL', open: false });
    dispatchUI({ type: 'SET_ENLARGE_AVATAR', open: true });
  }, []);

  const handleCloseEnlargedAvatar = useCallback(() => {
    dispatchUI({ type: 'SET_ENLARGE_AVATAR', open: false });
  }, []);

  const onRefresh = useCallback(async () => {
    // Check current connection directly, not stale state
    const netInfo = await NetInfo.fetch();
    const currentlyOffline = !netInfo.isConnected || netInfo.isInternetReachable === false;
    
    if (currentlyOffline) {
      dispatchUI({ type: 'SET_TOAST', toast: { message: 'No connection - showing cached data', type: 'offline' } });
      setTimeout(() => dispatchUI({ type: 'SET_TOAST', toast: null }), 2000);
      setIsOffline(true); // Sync state
      return;
    }
    
    dispatchUI({ type: 'SET_REFRESHING', refreshing: true });
    try {
      // Don't reset hasLoaded to avoid clearing existing data on refresh
      // Just reload profile and videos in the background
      const user = globalUser || cachedUser;
      if (user) {
        const viewingId = targetUserId ?? user.id;
        const ownProfile = viewingId === user.id;
        
        try {
          await Promise.all([
            loadProfile(viewingId),
            loadVideos(viewingId, ownProfile),
            loadLivestreams(viewingId),
          ]);
        } catch (e) {
          // Don't clear data on refresh failure - keep showing cached data
        }
        
        if (!ownProfile) {
          supabase.from('follows')
            .select('id')
            .eq('follower_id', user.id)
            .eq('following_id', viewingId)
            .maybeSingle()
            .then(({ data }) => dispatchProfile({ type: 'SET_FOLLOWING', following: !!data }))
            .catch(() => {/* offline - ignore */});

          supabase.from('blocks')
            .select('id')
            .eq('blocker_id', user.id)
            .eq('blocked_id', viewingId)
            .maybeSingle()
            .then(({ data }) => dispatchProfile({ type: 'SET_BLOCKED', blocked: !!data }))
            .catch(() => {/* offline - ignore */});
        } else {
          loadLikedVideos(user.id).catch(() => {/* offline - ignore */});
        }
      }
    } finally {
      dispatchUI({ type: 'SET_REFRESHING', refreshing: false });
    }
  }, [globalUser, cachedUser, targetUserId, isOffline]);
  const openVideo = useCallback((videos, index) => {
    // Normalize videos to handle both regular videos and livestreams
    const normalizedVideos = videos.map(v => {
      const normalized = {
        ...v,
        // Normalize video URL: livestreams use video_url, regular videos use video_uri
        video_uri: v.video_uri || v.video_url,
        // Normalize thumbnail: livestreams use thumbnail_url, regular videos use thumbnail_uri
        thumbnail_uri: v.thumbnail_uri || v.thumbnail_url || null,
        thumbnail: v.thumbnail_url || v.thumbnail_uri || null,  // ADD THIS for compatibility
        thumbnailUrl: v.thumbnail_url || v.thumbnail_uri || null,  // ADD THIS for compatibility
        // Mark type for UI display
        type: v.video_url && !v.video_uri ? 'livestream' : 'video'
      };
      
      // Log livestream mapping
      if (v.video_url && !v.video_uri) {
        console.log('[PROFILE] Mapping livestream:', v.id, 'thumbnail:', v.thumbnail_url, '-> thumbnail_uri:', normalized.thumbnail_uri);
      }
      
      return normalized;
    });
    
    console.log('[PROFILE] Combined content:', normalizedVideos?.length);
    console.log('[PROFILE] Content items:', normalizedVideos?.map(item => ({
      id: item.id,
      type: item.type,
      hasThumbnail: !!item.thumbnail_uri,
      thumbnail_uri: item.thumbnail_uri,
      thumbnail: item.thumbnail,
      thumbnailUrl: item.thumbnailUrl
    })));
    
    navigation.navigate(ROUTES.PROFILE_VIDEOS, { videos: normalizedVideos, startIndex: index });
  }, [navigation]);

  const renderItem = useCallback(({ item, index }) => {
    console.log('[PROFILE] Rendering item:', { 
      id: item.id, 
      type: item.video_url && !item.video_uri ? 'livestream' : 'video', 
      thumbnail: item.thumbnail_url || item.thumbnail_uri 
    });
    
    const isLivestream = activeTab === 'livestreams';
    
    return (
      <VideoGridItem 
        item={item}
        isLivestreamItem={isLivestream}
        onPress={() => {
          if (isLivestream) {
            navigation.navigate(ROUTES.VIDEO_DETAIL, {
              video: {
                id: item.id,
                video_url: item.video_url,
                thumbnail_uri: item.thumbnail_url,
                title: item.title,
                description: item.description,
                user_id: item.user_id,
                type: 'livestream',
                profiles: { username: profile?.username ?? 'user', avatar_url: profile?.avatar_url }
              }
            });
          } else {
            // Get fresh videos array at tap time (not stale closure)
            const videosToPass = activeTab === 'videos' ? publicVideos : 
                                activeTab === 'private' ? privateVideos : 
                                likedVideos;
            openVideo(videosToPass, index);
          }
        }} 
        onLongPress={handleLongPress} 
      />
    );
  }, [activeTab, publicVideos, privateVideos, livestreams, likedVideos, openVideo, handleLongPress, navigation]);

  const renderHeader = useCallback(() => {
    if (!profile) return null;
    return (
    <View style={styles.headerSection}>
      <View style={styles.avatarSection}>
        <View style={{ position: 'relative' }}>
          <Avatar
            uri={profile?.avatar_url}
            username={profile?.username}
            size={90}
            onPress={handleAvatarPress}
          />
          {isOwnProfile && (
            <TouchableOpacity
              style={{
                position: 'absolute',
                bottom: -2,
                right: -2,
                backgroundColor: COLORS.gold,
                borderRadius: 16,
                width: 32,
                height: 32,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 2,
                borderColor: '#fff',
              }}
              onPress={handleAvatarPress}
              activeOpacity={0.8}
            >
              <Text style={{ fontSize: 16 }}>📷</Text>
            </TouchableOpacity>
          )}
        </View>
        {isScholar && <View style={styles.scholarBadge} accessibilityLabel="Verified scholar badge" accessibilityRole="image" accessible={true}><Text style={styles.scholarBadgeText}>✓ Scholar</Text></View>}
        {!isScholar && profile?.trusted_user && (
          <View style={[styles.scholarBadge, { backgroundColor: '#3b82f6' }]}>
            <Text style={styles.scholarBadgeText}>⭐ Trusted</Text>
          </View>
        )}
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
          <Text style={styles.displayName}>{profile?.full_name || profile?.username || ''}</Text>
          <Text style={styles.usernameText}>@{profile?.username || ''}</Text>
          {profile?.bio ? (
            <Text style={styles.bioText}>{profile.bio}</Text>
          ) : isOwnProfile ? (
            <AnimatedButton onPress={handleNavigateEditProfile}>
              <Text style={styles.addBioText}>+ Add bio</Text>
            </AnimatedButton>
          ) : null}
        </View>
      )}

      <View style={styles.statsRow}>
        <View style={styles.statItem} accessibilityLabel={`${formatCount((publicVideos || []).length)} videos`} accessibilityRole="text" accessible={true}>
          <Text style={styles.statNum}>{formatCount((publicVideos || []).length)}</Text>
          <Text style={styles.statLabel}>Videos</Text>
        </View>
        <View style={styles.statDivider} />
        <AnimatedButton style={styles.statItem} onPress={handleNavigateFollowers}>
          <Text style={styles.statNum}>{formatCount(followersCount)}</Text>
          <Text style={styles.statLabel}>Followers</Text>
        </AnimatedButton>
        <View style={styles.statDivider} />
        <AnimatedButton style={styles.statItem} onPress={handleNavigateFollowing}>
          <Text style={styles.statNum}>{formatCount(followingCount)}</Text>
          <Text style={styles.statLabel}>Following</Text>
        </AnimatedButton>
        <View style={styles.statDivider} />
        <View style={styles.statItem} accessibilityLabel={`${formatCount(totalLikes)} likes`} accessibilityRole="text" accessible={true}>
          <Text style={styles.statNum}>{formatCount(totalLikes)}</Text>
          <Text style={styles.statLabel}>Likes</Text>
        </View>
      </View>

      {isOwnProfile ? (
        <>
          {!isScholar && !hasPendingApplication && !isAdmin && (
            <View style={styles.actionButtons}>
              <AnimatedButton style={styles.scholarApplyBtn} onPress={handleNavigateApplyScholar}>
                <Text style={styles.scholarApplyBtnText}>🎓 Apply as Scholar</Text>
              </AnimatedButton>
            </View>
          )}
          {!isScholar && hasPendingApplication && !isAdmin && (
            <View style={styles.actionButtons}>
              <AnimatedButton
                style={[styles.scholarApplyBtn, { backgroundColor: '#94a3b8' }]}
                disabled={true}
              >
                <Text style={styles.scholarApplyBtnText}>🎓 Application Pending</Text>
              </AnimatedButton>
            </View>
          )}

          {/* Show My Uploads + Help & Support for normal users and scholars (NOT admins) */}
          {!isAdmin && (
            <View style={[styles.actionButtons, { flexDirection: 'row', gap: 10 }]}>
              {!isScholar && (
                <AnimatedButton style={styles.myUploadsBtn} onPress={() => navigation.navigate(ROUTES.MY_UPLOADS)}>
                  <Text style={styles.myUploadsBtnText}>📁 My Uploads</Text>
                </AnimatedButton>
              )}
              <AnimatedButton style={[styles.contactBtn, isScholar && { flex: 1 }]} onPress={() => navigation.navigate(ROUTES.CONTACT_ADMIN)}>
                <Text style={styles.contactBtnText}>🆘 Help & Support</Text>
              </AnimatedButton>
            </View>
          )}

          {/* Show Admin button only for admins */}
          {isAdmin && (
            <TouchableOpacity
              style={styles.adminButton}
              onPress={() => navigation.navigate(ROUTES.ADMIN)}
            >
              <Text style={styles.adminButtonText}>🛡️ Admin Panel</Text>
            </TouchableOpacity>
          )}
        </>
      ) : (
        <View style={styles.actionButtons}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {!blocked && (
              <AnimatedButton 
                style={[styles.followBtn, following && styles.followingBtn, { flex: 1 }]} 
                onPress={handleFollow}
                accessibilityLabel={following ? "Unfollow user" : "Follow user"}
                accessibilityRole="button"
                accessibilityState={{ selected: following }}
              >
                <Text style={[styles.followBtnText, following && styles.followingBtnText]}>
                  {following ? '✓ Following' : '+ Follow'}
                </Text>
              </AnimatedButton>
            )}
            <AnimatedButton 
              style={[styles.blockBtn, blocked && { flex: 1 }]} 
              onPress={handleBlock}
              accessibilityLabel={blocked ? "Unblock user" : "Block user"}
              accessibilityRole="button"
              accessibilityState={{ selected: blocked }}
            >
              <Text style={styles.blockBtnText}>{blocked ? '🚫 Blocked' : 'Block'}</Text>
            </AnimatedButton>
          </View>
          {isSuperAdmin && targetIsAdmin && (
            <View style={styles.adminBadge}>
              <Ionicons name="shield-checkmark" size={16} color={COLORS.gold} />
              <Text style={styles.adminBadgeText}>✓ Admin</Text>
            </View>
          )}
          {isSuperAdmin && !targetIsAdmin && adminCount < 10 && (
            <AnimatedButton
              style={[styles.addAdminBtn, addingAdmin && styles.addAdminBtnDisabled]}
              onPress={() => {
                setDialog({
                  visible: true,
                  title: 'Add as Admin?',
                  message: `Make @${profile?.username || 'user'} an admin? They will be able to review videos, handle reports, and reply to user messages. (${adminCount}/10 admins)`,
                  type: 'confirm',
                  buttons: [
                    { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
                    { text: 'Confirm', onPress: () => { setDialog(d => ({ ...d, visible: false })); handleAddAdmin(); } },
                  ]
                });
              }}
              disabled={addingAdmin}
            >
              <Ionicons name="shield-checkmark" size={18} color="#ffffff" />
              <Text style={styles.addAdminBtnText}>Add as Admin</Text>
            </AnimatedButton>
          )}
          {isSuperAdmin && !targetIsAdmin && adminCount >= 10 && (
            <View style={styles.adminLimitBadge}>
              <Text style={styles.adminLimitText}>Admin limit reached ({adminCount}/10)</Text>
            </View>
          )}
        </View>
      )}

      <View style={styles.tabs}>
        <AnimatedButton style={[styles.tab, activeTab === 'videos' && styles.activeTab]} onPress={handleTabVideos}>
          <Text style={[styles.tabText, activeTab === 'videos' && styles.activeTabText]}>🎥</Text>
        </AnimatedButton>
        {isOwnProfile && (
          <AnimatedButton 
            style={[styles.tab, activeTab === 'private' && styles.activeTab]} 
            onPress={handleTabPrivate}
            accessibilityLabel="Private videos tab"
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'private' }}
          >
            <Text style={[styles.tabText, activeTab === 'private' && styles.activeTabText]}>🔒</Text>
          </AnimatedButton>
        )}
        <AnimatedButton 
          style={[styles.tab, activeTab === 'livestreams' && styles.activeTab]} 
          onPress={handleTabLivestreams}
          accessibilityLabel="Livestreams tab"
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'livestreams' }}
        >
          <Text style={[styles.tabText, activeTab === 'livestreams' && styles.activeTabText]}>🔴</Text>
        </AnimatedButton>
        <AnimatedButton 
          style={[styles.tab, activeTab === 'liked' && styles.activeTab]} 
          onPress={handleTabLiked}
          accessibilityLabel="Liked videos tab"
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'liked' }}
        >
          <Text style={[styles.tabText, activeTab === 'liked' && styles.activeTabText]}>❤️</Text>
        </AnimatedButton>
      </View>
    </View>
    );
  }, [profile, isScholar, scholarData, hasPendingApplication, publicVideos, followersCount, followingCount, totalLikes, isOwnProfile, following, blocked, activeTab, currentUser, targetUserId, navigation, isAdmin, isSuperAdmin, targetIsAdmin, adminCount, addingAdmin, handleAddAdmin]);

  const activeVideos = activeTab === 'videos' 
    ? publicVideos.filter(v => !v.video_url?.includes('.m3u8'))
    : activeTab === 'private' 
      ? privateVideos.filter(v => !v.video_url?.includes('.m3u8'))
      : activeTab === 'livestreams' 
        ? livestreams 
        : likedVideos;
  
  // Debug: Log which array is being used for current tab
  console.log('[PROFILE] Active tab:', activeTab, '| Active videos count:', activeVideos?.length);
  console.log('[PROFILE] All arrays - public:', publicVideos?.length, '| livestreams:', livestreams?.length, '| private:', privateVideos?.length);

  // Check for cached user when globalUser is null (offline scenario)
  const [cachedUser, setCachedUser] = useState(null);
  const [isOffline, setIsOffline] = useState(false);
  const [deleteModal, setDeleteModal] = useState({ visible: false, video: null });
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [dialog, setDialog] = useState({ 
    visible: false, 
    title: '', 
    message: '', 
    type: 'info', 
    buttons: [] 
  });

  // Fetch signed URL for secure video playback
  const getSignedVideoUrl = async (livestreamId) => {
    try {
      const response = await fetch(`https://balagh-server-production.up.railway.app/api/recording/livestreams/${livestreamId}/play`);
      const data = await response.json();
      return data.signedUrl;
    } catch (e) {
      console.error('[VIDEO] Failed to get signed URL:', e);
      return null;
    }
  };
  
  useEffectHook(() => {
    async function checkCachedUser() {
      if (!userLoading && !globalUser) {
        const cached = await userCache.get();
        if (cached) {
          setCachedUser(cached);
          setIsOffline(true);
        } else {
          // No cached user, redirect to login
          navigation.replace(ROUTES.LOGIN);
        }
      }
    }
    checkCachedUser();
  }, [userLoading, globalUser]);

  // Show loading only on initial load when we have no data at all
  if (userLoading && !globalUser && !cachedUser) return (
    <View style={[styles.container, { alignItems: 'center', justifyContent: 'center' }]}>
      <ActivityIndicator color={COLORS.gold} size="large" />
    </View>
  );
  
  // Use globalUser or cachedUser (for offline)
  const activeUser = globalUser || cachedUser;
  if (!activeUser) return null;

  return (
    <View style={styles.container}>

      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        {!isOwnProfile && (
          <AnimatedButton 
            onPress={navigation.goBack} 
            style={styles.topBarBtn}
            accessibilityLabel="Go back"
            accessibilityRole="button"
          >
            <Text style={styles.topBarBtnText}>←</Text>
          </AnimatedButton>
        )}
        
        {/* Offline indicator - only shows when offline */}
        {isOffline && (
          <View style={styles.offlineIndicator}>
            <Text style={styles.offlineText}>📴 Offline</Text>
          </View>
        )}
        
        {/* Toast notification */}
        
        <DownloadProgressOverlay visible={isDownloading} progress={downloadProgress} />
        
        <View style={{ flex: 1 }} />
        {isOwnProfile && (
          <AnimatedButton onPress={handleNavigateSettings} style={styles.topBarBtn}>
            <Text style={styles.topBarBtnText}>⚙️</Text>
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
          !profile ? null : (
          <View style={styles.emptyGrid}>
            <Text style={styles.emptyGridIcon}>{activeTab === 'videos' ? '🎥' : activeTab === 'private' ? '🔒' : activeTab === 'livestreams' ? '🔴' : '❤️'}</Text>
            <Text style={styles.emptyGridText}>{activeTab === 'videos' ? 'No videos yet' : activeTab === 'private' ? 'No private videos' : activeTab === 'livestreams' ? 'No live replays' : 'No liked videos'}</Text>
          </View>
          )
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 80, paddingTop: insets.top + 50 }}
        showsVerticalScrollIndicator={false}
      />

      <DownloadProgressOverlay visible={isDownloading} progress={downloadProgress} />

        {toast && (
          <View style={[
            styles.toastContainer,
            toast.type === 'error' && styles.toastError,
            toast.type === 'offline' && styles.toastOffline,
          ]}>
            {toast.type === 'success' && (
              <View style={styles.toastCheckCircle}>
                <Text style={styles.toastCheckMark}>✓</Text>
              </View>
            )}
            <Text style={styles.toastText}>{toast.message}</Text>
          </View>
        )}

      <Modal visible={avatarModal} transparent animationType="slide" onRequestClose={() => dispatchUI({ type: 'SET_AVATAR_MODAL', open: false })} statusBarTranslucent>
        <Pressable style={styles.modalBackdrop} onPress={handleCloseAvatarModal} />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 20 }]}>
          <Text style={styles.modalTitle}>Profile Photo</Text>
          {profile?.avatar_url && (
            <AnimatedButton style={styles.modalOption} onPress={handleViewEnlargedAvatar}>
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
        <Pressable style={styles.enlargeBackdrop} onPress={handleCloseEnlargedAvatar}>
          <View style={[styles.enlargeCloseBtn, { top: insets.top + 12 }]}>
            <Text style={styles.enlargeCloseBtnText}>✕</Text>
          </View>
          {profile?.avatar_url && (
            <Image source={{ uri: profile.avatar_url, cache: 'force-cache', headers: { 'Cache-Control': 'max-age=86400' } }} style={styles.enlargedAvatar} resizeMode="contain" />
          )}
        </Pressable>
      </Modal>

        <Modal visible={deleteModal.visible} transparent animationType="fade" onRequestClose={() => setDeleteModal({ visible: false, video: null })}>
          <Pressable style={styles.modalBackdrop} onPress={() => setDeleteModal({ visible: false, video: null })} />
          <View style={styles.deleteModalBox}>
            <Text style={styles.deleteModalTitle}>Delete Video</Text>
            <Text style={styles.deleteModalMsg}>Are you sure? This cannot be undone.</Text>

            <TouchableOpacity style={styles.deleteCheckRow} onPress={() => setDontShowAgain(p => !p)} activeOpacity={0.7}>
              <View style={[styles.deleteCheckBox, dontShowAgain && styles.deleteCheckBoxChecked]}>
                {dontShowAgain && <Text style={styles.deleteCheckMark}>✓</Text>}
              </View>
              <Text style={styles.deleteCheckLabel}>Don't show this again</Text>
            </TouchableOpacity>

            <View style={styles.deleteModalButtons}>
              <TouchableOpacity style={styles.deleteCancelBtn} onPress={() => setDeleteModal({ visible: false, video: null })}>
                <Text style={styles.deleteCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.deleteConfirmBtn} onPress={confirmDelete}>
                <Text style={styles.deleteConfirmText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

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
  container: { flex: 1, backgroundColor: '#ffffff' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 4,
    backgroundColor: 'rgba(255,255,255,0.9)', position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
  },
  topBarBtn: { padding: 8 },
  topBarBtnText: { color: '#1a2e44', fontSize: 22, fontWeight: '700' },
  headerSection: {
    backgroundColor: '#ffffff',
    paddingBottom: 0,
  },
  avatarSection: {
    alignItems: 'center',
    paddingTop: 16,
    paddingBottom: 16,
  },
  scholarBadge: {
    marginTop: 8,
    backgroundColor: COLORS.gold,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    shadowColor: COLORS.gold,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  scholarBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  regularInfo: {
    alignItems: 'center',
    paddingHorizontal: 32,
    marginBottom: 16,
  },
  displayName: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1a2e44',
    marginBottom: 3,
    letterSpacing: -0.3,
  },
  usernameText: {
    fontSize: 14,
    color: '#94a3b8',
    marginBottom: 10,
    fontWeight: '500',
  },
  bioText: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 22,
  },
  addBioText: {
    fontSize: 14,
    color: COLORS.gold,
    fontWeight: '600',
  },
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
  statsRow: {
    flexDirection: 'row',
    backgroundColor: '#f8fafc',
    borderRadius: 20,
    marginHorizontal: 16,
    marginBottom: 14,
    paddingVertical: 14,
    justifyContent: 'space-around',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#f1f5f9',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  statNum: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1a2e44',
    letterSpacing: -0.5,
  },
  statLabel: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 3,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statDivider: {
    width: 1,
    height: 32,
    backgroundColor: '#e2e8f0',
  },
  actionButtons: {
    paddingHorizontal: 16,
    marginBottom: 14,
  },
  scholarApplyBtn: {
    backgroundColor: COLORS.gold,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    shadowColor: COLORS.gold,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  scholarApplyBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  followBtn: {
    backgroundColor: COLORS.gold,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    shadowColor: COLORS.gold,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  followingBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: COLORS.gold,
    shadowOpacity: 0,
    elevation: 0,
  },
  followBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  followingBtnText: {
    color: COLORS.gold,
  },
  tabs: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    marginTop: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2.5,
    borderBottomColor: 'transparent',
  },
  activeTab: {
    borderBottomColor: COLORS.gold,
  },
  tabText: {
    fontSize: 20,
    opacity: 0.3,
  },
  activeTabText: {
    opacity: 1,
  },
  gridItem: { flex: 1, aspectRatio: 0.8, margin: 0.5, backgroundColor: '#f0f0f0' },
  gridThumb: { width: '100%', height: '100%' },
  gridOverlay: { position: 'absolute', bottom: 4, left: 4 },
  gridPlayCount: { color: '#fff', fontSize: 12, fontWeight: '600', textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  pinnedLabel: { position: 'absolute', top: 4, left: 4 },
  pinnedLabelText: { fontSize: 14 },
  privateLabel: { position: 'absolute', top: 4, right: 4 },
  privateLabelText: { fontSize: 14 },
  liveLabel: { position: 'absolute', bottom: 4, right: 4, backgroundColor: COLORS.gold, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  liveLabelText: { fontSize: 10, fontWeight: '700', color: '#fff' },
  emptyGrid: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  emptyGridIcon: { fontSize: 48 },
  emptyGridText: { color: '#aaa', fontSize: 15, fontWeight: '600' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  modalSheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 40, paddingTop: 16, borderTopWidth: 0.5, borderColor: '#eee' }, // paddingBottom overridden inline
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
  blockBtn: {
    backgroundColor: '#fff1f2',
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#fecdd3',
  },
  blockBtnText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '700',
  },
  myUploadsBtn: {
    backgroundColor: '#f1f5f9',
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flex: 1,
  },
  myUploadsBtnText: {
    color: '#1a2e44',
    fontSize: 14,
    fontWeight: '700',
  },
  contactBtn: {
    backgroundColor: '#fff7ed',
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#fed7aa',
    flex: 1,
  },
  contactBtnText: {
    color: '#c2410c',
    fontSize: 14,
    fontWeight: '700',
  },
  addAdminBtn: {
    backgroundColor: COLORS.gold,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: COLORS.gold,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  addAdminBtnDisabled: {
    backgroundColor: COLORS.goldDark,
    opacity: 0.7,
  },
  addAdminBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  adminBadge: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: COLORS.gold + '15',
    borderRadius: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.gold + '40',
  },
  adminBadgeText: {
    color: COLORS.gold,
    fontWeight: '700',
    fontSize: 14,
  },
  adminLimitBadge: {
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9',
    borderRadius: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  adminLimitText: {
    color: '#94a3b8',
    fontWeight: '700',
    fontSize: 13,
  },
  offlineIndicator: { 
    backgroundColor: 'rgba(0,0,0,0.7)', 
    borderRadius: 12, 
    paddingHorizontal: 10, 
    paddingVertical: 4,
    marginLeft: 8,
  },
  offlineText: { 
    color: '#fff', 
    fontSize: 12, 
    fontWeight: '600' 
  },
  adminButton: {
    backgroundColor: '#ff4757',
    padding: 16,
    borderRadius: 12,
    margin: 16,
    alignItems: 'center',
  },
  adminButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  toastContainer: {
  position: 'absolute',
  top: '50%',
  alignSelf: 'center',
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  backgroundColor: '#1a2e44',
  borderRadius: 100,
  paddingHorizontal: 18,
  paddingVertical: 10,
  zIndex: 9999,
  elevation: 9999,
  },
  toastCheckCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#22c55e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastCheckMark: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
  },
  toastText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  toastError: {
    backgroundColor: '#ef4444',
  },
  toastOffline: {
    backgroundColor: '#555',
  },
  deleteModalBox: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, paddingBottom: 40,
  },
  deleteModalTitle: { fontSize: 17, fontWeight: '800', color: '#111', marginBottom: 6 },
  deleteModalMsg: { fontSize: 14, color: '#666', marginBottom: 20 },
  deleteCheckRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 24 },
  deleteCheckBox: {
    width: 20, height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: '#aaa',
    alignItems: 'center', justifyContent: 'center',
  },
  deleteCheckBoxChecked: { backgroundColor: '#ef4444', borderColor: '#ef4444' },
  deleteCheckMark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  deleteCheckLabel: { fontSize: 14, color: '#555' },
  deleteModalButtons: { flexDirection: 'row', gap: 10 },
  deleteCancelBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10,
    borderWidth: 0.5, borderColor: '#ccc', alignItems: 'center',
  },
  deleteCancelText: { fontSize: 15, color: '#111' },
  deleteConfirmBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: '#ef4444', alignItems: 'center' },
  deleteConfirmText: { fontSize: 15, color: '#fff', fontWeight: '700' },
});