import { View, Text, StyleSheet, FlatList, ActivityIndicator, Animated, RefreshControl, useWindowDimensions, AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { FlashList } from '@shopify/flash-list';
import { useRef, useState, useEffect, useCallback, forwardRef, useImperativeHandle, useMemo } from 'react';
import { TabView } from 'react-native-tab-view';
import { useIsFocused } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import VideoCard from './VideoCard';
import { homeRefreshRef } from '../utils/refs';
import AnimatedButton from './AnimatedButton';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import LiveVideoCard from '../components/LiveVideoCard';
import { useVideoPlayerPool } from '../components/VideoPlayerPool';
import { COLORS } from '../constants/theme';
import { ROUTES } from '../constants/routes';
import { useUser } from '../context/UserContext';
import { SystemBars } from 'react-native-edge-to-edge';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Linking } from 'react-native';



const CURRENT_VERSION_CODE = 58; // CHANGE THIS when you bump versionCode
const VERSION_CHECK_URL = 'https://raw.githubusercontent.com/hamoudy1998years-afk/Balagh/main/version.json';
const UPDATE_CHECK_KEY = 'lastUpdateCheck';

async function checkForUpdate() {
  try {
    const netState = await NetInfo.fetch();
    if (!netState.isConnected) return;

    const lastCheck = await AsyncStorage.getItem(UPDATE_CHECK_KEY);
    const now = Date.now();
    if (lastCheck && now - parseInt(lastCheck) < 24 * 60 * 60 * 1000) return;

    const response = await fetch(VERSION_CHECK_URL, { cache: 'no-cache' });
    if (!response.ok) return;
    const data = await response.json();

    if (data.latestVersionCode > CURRENT_VERSION_CODE) {
      Alert.alert(
        '📦 New Update Available',
        `Version ${data.latestVersion} is now live!\n\n${data.changelog}`,
        [
          { text: 'Later', style: 'cancel' },
          { text: 'Update Now', onPress: () => Linking.openURL(data.updateUrl) },
        ],
        { cancelable: false }
      );
    }

    await AsyncStorage.setItem(UPDATE_CHECK_KEY, now.toString());
  } catch (e) {
    // Silent fail — don't block app if version check fails
  }
}

// ── Simple in-memory feed cache ────────────────────────────────────────────────
const feedCache = {
  foryou: null,
  following: null,
  likes: null,
  follows: null,
  ts: {},
};

const CACHE_TTL = 60 * 1000;
let feedCacheUserId = undefined; // undefined = never synced yet

// Monotonic counter guarding the "following" cache slot specifically.
// Several independent loaders write feedCache.following (loadVideos refresh/paginate,
// loadFollowingInBackground, preloadFollowingFeed). Whichever loader was *started*
// most recently should win, regardless of which one's network call resolves first.
let followingCacheRequestId = 0;

export function clearFeedCache() {
  feedCache.foryou = null;
  feedCache.following = null;
  feedCache.likes = null;
  feedCache.follows = null;
  feedCache.ts = {};
  // Invalidate every in-flight Following writer that started before this clear —
  // covers logout/login and any other same-user cache-clear race, not just account switches.
  followingCacheRequestId++;
}

// Synchronously wipes the cache the instant the authenticated user changes,
// so no component can read a previous account's cached data.
function syncFeedCacheOwner(userId) {
  const normalized = userId ?? null;
  if (feedCacheUserId !== normalized) {
    clearFeedCache();
    feedCacheUserId = normalized;
  }
}

// Lets in-flight background requests check, right before they write to the
// shared cache, whether the account they were fetched for is still current.
function isFeedCacheOwner(userId) {
  return feedCacheUserId === (userId ?? null);
}

function isCacheValid(key) {
  return feedCache[key] !== null && feedCache.ts[key] && Date.now() - feedCache.ts[key] < CACHE_TTL;
}

// ── Live Streams Feed ──────────────────────────────────────────────────────────
function LiveFeed({ navigation, isActive = true }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [streams, setStreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // The single stream id allowed to run a live video preview. At most one
  // preview is connected at a time (data/battery/CPU/bandwidth).
  const [activePreviewId, setActivePreviewId] = useState(null);
  const [appActive, setAppActive] = useState(true);

  const intervalRef = useRef(null);
  const mountedRef = useRef(true);
  const loadStreamsRequestIdRef = useRef(0);

  // Stable viewability config/callback so FlashList never sees new prop
  // identities across re-renders (changing viewabilityConfig on the fly is
  // not supported).
  const previewViewabilityConfig = useRef({
    itemVisiblePercentThreshold: 60,
    minimumViewTime: 300,
  }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    const first = viewableItems.find((v) => v.isViewable && v.item?.id);
    const id = first ? first.item.id : null;
    setActivePreviewId((prev) => (prev === id ? prev : id));
  }).current;

  useEffect(() => {
    const channelRef = { current: null };
    const retryTimeoutRef = { current: null };
    let isMounted = true;

    loadStreams();
    intervalRef.current = setInterval(loadStreams, 15000);

    let retryCount = 0;
    const maxRetries = 3;

    const subscribeToLiveStreams = () => {
      if (!isMounted) return;

      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      const channel = supabase
        .channel('live_streams_home')
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'live_streams'
        }, (payload) => {
          loadStreams();
        })
        .subscribe((status, err) => {
          if (err) {
            if (isMounted && retryCount < maxRetries) {
              retryCount++;
              retryTimeoutRef.current = setTimeout(() => {
                if (isMounted) subscribeToLiveStreams();
              }, 2000 * retryCount);
            }
          } else if (status === 'SUBSCRIBED') {
            retryCount = 0;
          }
        });

      channelRef.current = channel;
    };

    subscribeToLiveStreams();

    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        setAppActive(true);
        clearInterval(intervalRef.current);
        intervalRef.current = setInterval(loadStreams, 15000);
        loadStreams();
      } else {
        setAppActive(false);
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    });

    return () => {
      isMounted = false;
      mountedRef.current = false;
      appStateSub.remove();
      clearInterval(intervalRef.current);
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, []);

  async function loadStreams() {
    const requestId = ++loadStreamsRequestIdRef.current;
    try {
      // 30s freshness window = 6 host heartbeat periods (5s). The old 10s
      // window left almost no tolerance for latency, a slow Supabase request
      // (the heartbeat's in-flight guard intentionally skips a tick), or
      // short background timer pauses, causing healthy streams to flicker
      // out of the list. Authoritative removal on stream end is still
      // instantaneous via the realtime DELETE/is_live=false events.
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000).toISOString();
      const { data, error } = await supabase
        .from('live_streams')
        .select('*, profiles:profiles!live_streams_user_id_fkey(username, avatar_url)')
        .eq('is_live', true)
        .gt('last_ping', thirtySecondsAgo)
        .order('created_at', { ascending: false });

      if (!mountedRef.current || loadStreamsRequestIdRef.current !== requestId) return;

      if (error) {
        // PostgREST errors (RLS, PGRST200 embed errors, etc.) are RETURNED,
        // not thrown — without this check they silently became [] and the
        // UI showed "No live streams" for every failure.
        if (__DEV__) {
          console.warn('loadStreams PostgREST error:', JSON.stringify(error, null, 2));
        }
        // Preserve previous streams on failure; do not overwrite with [].
        return;
      }

      if (__DEV__) {
        console.warn('loadStreams OK, rows:', data?.length ?? 0,
          'cutoff:', thirtySecondsAgo,
          'deviceNow:', new Date().toISOString());
      }

      setStreams(data ?? []);
    } catch (error) {
      __DEV__ && console.warn('loadStreams error:', error?.message);
    } finally {
      if (mountedRef.current && loadStreamsRequestIdRef.current === requestId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: '#FFFFFF' }]}>
        <ActivityIndicator color={COLORS.gold} size="large" />
        <Text style={[styles.loadingText, { color: '#1a2e44' }]}>Loading live streams...</Text>
      </View>
    );
  }

  if (streams.length === 0) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: '#FFFFFF' }]}>
        <Text style={styles.emptyIcon}>🔴</Text>
        <Text style={[styles.loadingText, { color: '#1a2e44' }]}>No live streams right now</Text>
        <Text style={[styles.emptySubtext, { color: '#666666' }]}>Check back later for live scholars!</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
      <FlashList
        data={streams}
        keyExtractor={(item) => item.id}
        estimatedItemSize={420}
        contentContainerStyle={{ padding: 4, paddingTop: insets.top + 60 }}
        viewabilityConfig={previewViewabilityConfig}
        onViewableItemsChanged={onViewableItemsChanged}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={loadStreams}
            tintColor={COLORS.gold}
          />
        }
        renderItem={({ item }) => (
          <View style={{ width: Math.min(width - 32, 480), alignSelf: 'center', marginVertical: 4 }}>
            <LiveVideoCard
              stream={item}
              previewActive={
                isActive && appActive && activePreviewId === item.id
              }
              onPress={
                item.is_live
                  ? () => navigation.navigate(ROUTES.WATCH_LIVE, { stream: item })
                  : undefined
              }
            />
          </View>
        )}
      />
    </View>
  );
}

// ── Video Feed ─────────────────────────────────────────────────────────────────
const VideoFeed = forwardRef(
  ({ type, navigation, tabIndex, activeIndexRef, isFocusedRef }, ref) => {
    const { user: authUser, blockedUsers } = useUser();
    const authUserIdRef = useRef(authUser?.id ?? null);
    authUserIdRef.current = authUser?.id ?? null;

    const [videos, setVideos] = useState(() => feedCache[type] ?? []);
    const visibleVideos = videos;
    const [loading, setLoading] = useState(() => !feedCache[type]);
    const [refreshing, setRefreshing] = useState(false);
    const [feedError, setFeedError] = useState(null);
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const { width, height } = useWindowDimensions();

    const [listHeight, setListHeight] = useState(null);

    const [myLikes, setMyLikes] = useState(() => feedCache.likes ?? []);
    const [myFollows, setMyFollows] = useState(() => feedCache.follows ?? []);

    const [isTabActive, setIsTabActive] = useState(
      () => isFocusedRef.current && activeIndexRef.current === tabIndex
    );

    // Preload Following feed when For You loads
    useEffect(() => {
      if (type === 'foryou' && !isCacheValid('following')) {
        loadFollowingInBackground();
      }
    }, [type, authUser?.id]);

    async function loadFollowingInBackground() {
      const user = authUser;
      if (!user) return;
      const ownerId = user.id;
      const writeId = ++followingCacheRequestId;

      try {
        const { data: blockedUsers } = await supabase
          .from('blocks')
          .select('blocked_id')
          .eq('blocker_id', user.id);

        const blockedIds = blockedUsers?.map(b => b.blocked_id) ?? [];

        const { data: follows } = await supabase
          .from('follows')
          .select('following_id')
          .eq('follower_id', user.id);

        if (!follows || follows.length === 0) {
          if (isFeedCacheOwner(ownerId) && writeId === followingCacheRequestId) {
            feedCache.following = [];
            feedCache.ts.following = Date.now();
          }
          return;
        }

        const followingIds = follows.map(f => f.following_id);

        let query = supabase
          .from('videos')
          .select('*, profiles!videos_user_id_profiles_fkey(id, username, avatar_url, is_scholar, trusted_user)')
          .in('user_id', followingIds)
          .neq('user_id', user.id)
          .eq('status', 'approved')
          .eq('processing_status', 'ready');

        if (blockedIds.length > 0) {
          query = query.not('user_id', 'in', `(${blockedIds.join(',')})`);
        }

        const { data } = await query
          .order('created_at', { ascending: false })
          .limit(20);

        if (isFeedCacheOwner(ownerId) && writeId === followingCacheRequestId) {
          feedCache.following = data ?? [];
          feedCache.ts.following = Date.now();
        }
      } catch (e) {
        __DEV__ && console.warn('loadFollowingInBackground error:', e?.message);
      }
    }

    const flatListRef = useRef(null);
    const loadVideosRequestIdRef = useRef(0);
    const loadInteractionsRequestIdRef = useRef(0);
    const loadingMoreRef = useRef(false);
    const playerPool = useVideoPlayerPool();
    const prevIndexRef = useRef(0);
    const isRefreshingRef = useRef(false);
    const scrollDebounceRef = useRef(null);
    const pendingDirectionRef = useRef(null);
    const scrollStartYRef = useRef(0);
    const scrollOpacityAnim = useRef(new Animated.Value(1)).current;

    useImperativeHandle(ref, () => ({
      refresh: async () => {
        isRefreshingRef.current = true;
        setActiveIndex(0);
        prevIndexRef.current = 0;
        flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
        await loadVideos();
        await loadMyInteractions();
        isRefreshingRef.current = false;
      },
      setActive: (val) => {
        setIsTabActive(!!val);
      },
    }));

    useEffect(() => {
      if (videos.length === 0) return;

      const direction = activeIndex > prevIndexRef.current ? 'next' : 'prev';

      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
      }

      pendingDirectionRef.current = {
        direction,
        activeIndex,
        prevIndex: prevIndexRef.current,
      };

      scrollDebounceRef.current = setTimeout(() => {
        const pending = pendingDirectionRef.current;
        if (!pending) return;

        if (
          pending.direction === 'next' &&
          pending.activeIndex > pending.prevIndex
        ) {
          playerPool.scrollNext();
        } else if (
          pending.direction === 'prev' &&
          pending.activeIndex < pending.prevIndex
        ) {
          playerPool.scrollPrev();
        }

        const currentVideo = videos[pending.activeIndex];
        if (currentVideo) {
          playerPool.loadVideo('current', currentVideo.video_url);
        }

        const nextVideo = videos[pending.activeIndex + 1];
        if (nextVideo) playerPool.loadVideo('next', nextVideo.video_url);

        const next2Video = videos[pending.activeIndex + 2];
        if (next2Video) playerPool.loadVideo('next2', next2Video.video_url);

        const prevVideo = videos[pending.activeIndex - 1];
        if (prevVideo) playerPool.loadVideo('prev', prevVideo.video_url);

        const prev2Video = videos[pending.activeIndex - 2];
        if (prev2Video) playerPool.loadVideo('prev2', prev2Video.video_url);

        prevIndexRef.current = pending.activeIndex;
        pendingDirectionRef.current = null;
      }, 50);

      return () => {
        if (scrollDebounceRef.current) {
          clearTimeout(scrollDebounceRef.current);
        }
      };
    }, [activeIndex, videos]);

    useEffect(() => {
      if (isCacheValid(type)) {
        const cachedVideos = feedCache[type];

        setVideos(cachedVideos);
        setOffset(cachedVideos.length);
        setHasMore(cachedVideos.length >= 20);
        setMyLikes(feedCache.likes ?? []);
        setMyFollows(feedCache.follows ?? []);
        setLoading(false);
        loadMyInteractions(true);
      } else {
        loadVideos();
        loadMyInteractions();
      }
    }, [type, authUser?.id]);

    async function loadVideos(background = false, loadMore = false) {
      const requestId = ++loadVideosRequestIdRef.current;
      const ownerId = authUser?.id ?? null;
      const authIdAtStart = authUserIdRef.current;

      if (!background) {
        setLoading(true);
        setFeedError(null);
      }

      try {
        if (type === 'following') {
          const user = authUser;

          if (!user) {
            if (loadVideosRequestIdRef.current === requestId) {
              setVideos([]);
              setLoading(false);
            }
            return;
          }

          const followingWriteId = ++followingCacheRequestId;

          const { data: blockedUsers } = await supabase
            .from('blocks')
            .select('blocked_id')
            .eq('blocker_id', user.id);

          const blockedIds = blockedUsers?.map(b => b.blocked_id) ?? [];

          const { data: follows } = await supabase
            .from('follows')
            .select('following_id')
            .eq('follower_id', user.id);

          if (
            loadVideosRequestIdRef.current !== requestId ||
            authUserIdRef.current !== authIdAtStart
          ) {
            return;
          }

          if (!follows || follows.length === 0) {
            if (
              isFeedCacheOwner(ownerId) &&
              followingWriteId === followingCacheRequestId
            ) {
              feedCache.following = [];
              feedCache.ts.following = Date.now();
            }

            setVideos([]);
            setLoading(false);
            return;
          }

          const followingIds = follows.map(f => f.following_id);

          let query = supabase
            .from('videos')
            .select('*, profiles!videos_user_id_profiles_fkey(id, username, avatar_url, is_scholar, trusted_user)')
            .in('user_id', followingIds)
            .neq('user_id', user.id)
            .eq('status', 'approved')
            .eq('processing_status', 'ready');

          if (blockedIds.length > 0) {
            query = query.not('user_id', 'in', `(${blockedIds.join(',')})`);
          }

          const currentOffset = loadMore ? offset : 0;

          const { data, error } = await query
            .order('created_at', { ascending: false })
            .range(currentOffset, currentOffset + 19);

          if (
            loadVideosRequestIdRef.current !== requestId ||
            authUserIdRef.current !== authIdAtStart
          ) {
            return;
          }

          if (error) {
            __DEV__ && console.warn('Following feed error:', error.message);
            setFeedError('Could not load your feed.');
            setLoading(false);
            return;
          }

          const newVideos = data ?? [];
          setHasMore(newVideos.length === 20);

          if (loadMore) {
            const combined = [...videos, ...newVideos];

            if (
              isFeedCacheOwner(ownerId) &&
              followingWriteId === followingCacheRequestId
            ) {
              feedCache.following = combined;
              feedCache.ts.following = Date.now();
            }

            setVideos(combined);
            setOffset(currentOffset + 20);
          } else {
            if (
              isFeedCacheOwner(ownerId) &&
              followingWriteId === followingCacheRequestId
            ) {
              feedCache.following = newVideos;
              feedCache.ts.following = Date.now();
            }

            setVideos(newVideos);
            setOffset(20);
          }
        } else {
          const currentUser = authUser;

          let blockedIds = [];

          if (currentUser?.id) {
            const { data: blockedUsers } = await supabase
              .from('blocks')
              .select('blocked_id')
              .eq('blocker_id', currentUser.id);

            blockedIds = blockedUsers?.map(b => b.blocked_id) ?? [];
          }

          if (
            loadVideosRequestIdRef.current !== requestId ||
            authUserIdRef.current !== authIdAtStart
          ) {
            return;
          }

          let query = supabase
            .from('videos')
            .select('*, likes_count, profiles!videos_user_id_profiles_fkey(id, username, avatar_url, is_scholar, trusted_user)')
            .eq('status', 'approved')
            .eq('processing_status', 'ready');

          if (blockedIds.length > 0) {
            query = query.not('user_id', 'in', `(${blockedIds.join(',')})`);
          }

          const currentOffset = loadMore ? offset : 0;

          const { data, error } = await query
            .order('created_at', { ascending: false })
            .range(currentOffset, currentOffset + 19);

          if (
            loadVideosRequestIdRef.current !== requestId ||
            authUserIdRef.current !== authIdAtStart
          ) {
            return;
          }

          if (error) {
            console.error('[HOME FEED] Error:', error.message);
          }

          if (error) {
            __DEV__ && console.warn('ForYou feed error:', error.message);
            setFeedError('Could not load your feed.');
            setLoading(false);
            return;
          }

          const newVideos = data ?? [];
          setHasMore(newVideos.length === 20);

          if (loadMore) {
            const newArr = [...newVideos];

            for (let i = newArr.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
            }

            const combined = [...videos, ...newArr];

            if (isFeedCacheOwner(ownerId)) {
              feedCache.foryou = combined;
              feedCache.ts.foryou = Date.now();
            }

            setVideos(combined);
            setOffset(currentOffset + 20);
          } else {
            const arr = [...newVideos];

            for (let i = arr.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [arr[i], arr[j]] = [arr[j], arr[i]];
            }

            if (isFeedCacheOwner(ownerId)) {
              feedCache.foryou = arr;
              feedCache.ts.foryou = Date.now();
            }

            setVideos(arr);
            setOffset(20);
          }
        }

        if (
          loadVideosRequestIdRef.current === requestId &&
          authUserIdRef.current === authIdAtStart
        ) {
          setLoading(false);
        }
      } catch (e) {
        __DEV__ && console.warn('loadVideos error:', e?.message);

        if (
          loadVideosRequestIdRef.current === requestId &&
          authUserIdRef.current === authIdAtStart
        ) {
          setFeedError('Could not load your feed.');
          setLoading(false);
        }
      }
    }

    async function loadMyInteractions(background = false) {
      const user = authUser;
      if (!user) return;

      const requestId = ++loadInteractionsRequestIdRef.current;
      const ownerId = user.id;
      const authIdAtStart = authUserIdRef.current;

      try {
        const [likesRes, followsRes] = await Promise.all([
          supabase.from('likes').select('video_id').eq('user_id', user.id),
          supabase
            .from('follows')
            .select('following_id')
            .eq('follower_id', user.id),
        ]);

        if (
          loadInteractionsRequestIdRef.current !== requestId ||
          authUserIdRef.current !== authIdAtStart
        ) {
          return;
        }

        if (likesRes.error || followsRes.error) {
          __DEV__ &&
            console.warn(
              'Interaction load error:',
              likesRes.error?.message ?? followsRes.error?.message
            );
          return;
        }

        const likes = likesRes.data?.map(l => l.video_id) ?? [];
        const follows = followsRes.data?.map(f => f.following_id) ?? [];

        if (isFeedCacheOwner(ownerId)) {
          feedCache.likes = likes;
          feedCache.follows = follows;
        }

        setMyLikes(likes);
        setMyFollows(follows);
      } catch (e) {
        __DEV__ && console.warn('loadMyInteractions error:', e?.message);
      }
    }

    function updateMyFollows(userId, isFollowing) {
      ++loadInteractionsRequestIdRef.current;

      setMyFollows(prev =>
        isFollowing
          ? prev.includes(userId)
            ? prev
            : [...prev, userId]
          : prev.filter(id => id !== userId)
      );

      const ownerId = authUser?.id ?? null;

      if (isFeedCacheOwner(ownerId)) {
        feedCache.follows = isFollowing
          ? [...new Set([...(feedCache.follows ?? []), userId])]
          : (feedCache.follows ?? []).filter(id => id !== userId);
      }
    }

    const onEndReached = useCallback(async () => {
      if (loadingMoreRef.current || !hasMore) return;

      loadingMoreRef.current = true;
      setLoadingMore(true);

      try {
        await loadVideos(true, true);
      } finally {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }, [hasMore, offset]);

    async function onRefresh() {
      clearFeedCache();
      setOffset(0);
      setHasMore(true);
      setRefreshing(true);
      await Promise.all([loadVideos(), loadMyInteractions()]);
      setRefreshing(false);
    }

    const onViewableItemsChanged = useRef(({ viewableItems }) => {
      if (viewableItems.length > 0) {
        setActiveIndex(viewableItems[0].index);
      }
    }).current;

    const renderItem = useCallback(
      ({ item, index }) => {
        const isVisible = Math.abs(index - activeIndex) <= 5;

        if (!isVisible) {
          return <View style={{ height: listHeight }} />;
        }

        let slot = null;

        if (index === activeIndex - 2) slot = 'prev2';
        else if (index === activeIndex - 1) slot = 'prev';
        else if (index === activeIndex) slot = 'current';
        else if (index === activeIndex + 1) slot = 'next';
        else if (index === activeIndex + 2) slot = 'next2';

        return (
          <VideoCard
            key={item.id}
            item={item}
            player={slot ? playerPool.getPlayerRef(slot) : null}
            isActive={index === activeIndex}
            isVisible={isVisible}
            isTabActive={isTabActive}
            index={index}
            currentTab={type}
            initialLiked={myLikes.includes(item.id)}
            initialFollowed={myFollows.includes(item.user_id)}
            onFollowChange={updateMyFollows}
            navigation={navigation}
            cardHeight={listHeight}
            username={item.profiles?.username ?? 'user'}
            avatarUrl={item.profiles?.avatar_url ?? null}
            scrollOpacity={scrollOpacityAnim}
            onBlocked={(blockedIndex) => {
              const nextIndex = blockedIndex + 1;

              if (nextIndex < videos.length) {
                flatListRef.current?.scrollToIndex({
                  index: nextIndex,
                  animated: false,
                });
              }
            }}
          />
        );
      },
      [
        activeIndex,
        listHeight,
        myLikes,
        myFollows,
        isTabActive,
        playerPool,
        updateMyFollows,
        navigation,
        videos,
        flatListRef,
      ]
    );

    if (feedError) {
      return (
        <View style={styles.loadingContainer}>
          <Text style={styles.emptyIcon}>⚠️</Text>
          <Text style={styles.loadingText}>Couldn't load videos</Text>
          <Text style={styles.emptySubtext}>
            Check your connection and try again.
          </Text>

          <AnimatedButton
            style={styles.retryBtn}
            onPress={() => loadVideos()}
          >
            <Text style={styles.retryBtnText}>Retry</Text>
          </AnimatedButton>
        </View>
      );
    }

    if (loading) {
      return (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={COLORS.gold} size="large" />
        </View>
      );
    }

    if (videos.length === 0 && type === 'following') {
      return (
        <View style={styles.loadingContainer}>
          <Text style={styles.emptyIcon}>🕌</Text>
          <Text style={styles.loadingText}>
            You're not following anyone yet!
          </Text>
          <Text style={styles.emptySubtext}>
            Follow scholars and creators to see their videos here.
          </Text>
        </View>
      );
    }

    return (
      <View
        style={{ flex: 1, backgroundColor: '#000' }}
        onLayout={(e) => {
          const measured = e.nativeEvent.layout.height;

          if (measured > 0 && measured !== listHeight) {
            setListHeight(measured);
          }
        }}
      >
        {listHeight ? (
          <FlatList
            ref={flatListRef}
            data={visibleVideos}
            keyExtractor={(item) => item.id}
            style={{ backgroundColor: '#000' }}
            overScrollMode="never"
            renderItem={renderItem}
            pagingEnabled={false}
            decelerationRate="fast"
            snapToInterval={listHeight}
            snapToAlignment="start"
            disableIntervalMomentum={true}
            showsVerticalScrollIndicator={false}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={{ itemVisiblePercentThreshold: 80 }}
            windowSize={3}
            maxToRenderPerBatch={2}
            initialNumToRender={1}
            onEndReached={onEndReached}
            onEndReachedThreshold={0.5}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            getItemLayout={(data, index) => ({
              length: listHeight,
              offset: listHeight * index,
              index,
            })}
            onScrollBeginDrag={() => {
              scrollStartYRef.current = activeIndex * listHeight;

              Animated.timing(scrollOpacityAnim, {
                toValue: 0.3,
                duration: 150,
                useNativeDriver: true,
              }).start();
            }}
            onScrollEndDrag={(e) => {
              const currentOffset = e.nativeEvent.contentOffset.y;
              const currentIndexOffset = activeIndex * listHeight;
              const dragDistance = currentOffset - currentIndexOffset;
              const dragPercent = Math.abs(dragDistance) / listHeight;
              const velocity = e.nativeEvent.velocity?.y ?? 0;
              const isFastScroll = Math.abs(velocity) > 0.3;

              let targetIndex = activeIndex;

              if (isFastScroll) {
                // Fast scroll/flick — change video easily
                if (dragDistance > 0) {
                  targetIndex = Math.min(
                    activeIndex + 1,
                    visibleVideos.length - 1
                  );
                } else if (dragDistance < 0) {
                  targetIndex = Math.max(activeIndex - 1, 0);
                }
              } else {
                // Slow drag — need 45% to change video
                if (dragPercent >= 0.45) {
                  if (dragDistance > 0) {
                    targetIndex = Math.min(
                      activeIndex + 1,
                      visibleVideos.length - 1
                    );
                  } else {
                    targetIndex = Math.max(activeIndex - 1, 0);
                  }
                }
              }

              setTimeout(() => {
                flatListRef.current?.scrollToOffset({
                  offset: targetIndex * listHeight,
                  animated: false,
                });
              }, 50);

              Animated.timing(scrollOpacityAnim, {
                toValue: 1,
                duration: 200,
                useNativeDriver: true,
              }).start();
            }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor="#ffffff"
                colors={['#ffffff']}
                progressBackgroundColor="#000000"
                progressViewOffset={90}
              />
            }
          />
        ) : null}
      </View>
    );
  }
);

// ── Home Screen ────────────────────────────────────────────────────────────────
export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { user: authUser } = useUser();

  syncFeedCacheOwner(authUser?.id);

  const [index, setIndex] = useState(1);

  const [routes] = useState([
    { key: 'following', title: 'Following' },
    { key: 'foryou', title: 'For You' },
    { key: 'live', title: 'Live' },
  ]);

  const [isConnected, setIsConnected] = useState(true);
  const [showOffline, setShowOffline] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);

  const { width: screenWidth } = useWindowDimensions();
  const isFocused = useIsFocused();
  const followingRef = useRef(null);
  const foryouRef = useRef(null);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    checkForUpdate();
  }, []);

  const pulseAnim = useRef(new Animated.Value(1)).current;

  const indexRef = useRef(index);
  const isFocusedRef = useRef(isFocused);

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useEffect(() => {
    isFocusedRef.current = isFocused;
  }, [isFocused]);

  const wasOfflineRef = useRef(false);

  useEffect(() => {
    const handleNetworkState = (state) => {
      const isOffline =
        state.isConnected === false ||
        state.isInternetReachable === false;

      const wasOffline = wasOfflineRef.current;

      wasOfflineRef.current = isOffline;

      setShowOffline(isOffline);
      setIsConnected(!isOffline);

      if (wasOffline && !isOffline) {
        setIsReconnecting(true);

        Promise.all([
          followingRef.current?.refresh?.(),
          foryouRef.current?.refresh?.(),
        ]).finally(() => {
          setIsReconnecting(false);
        });
      }
    };

    const unsubscribe = NetInfo.addEventListener(handleNetworkState);

    NetInfo.fetch().then(handleNetworkState);

    return unsubscribe;
  }, []);

  useEffect(() => {
    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.5,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    );

    pulseAnimation.start();

    return () => pulseAnimation.stop();
  }, []);

  useEffect(() => {
    if (index === 1 && isFocused) {
      preloadFollowingFeed();
    }
  }, [index, isFocused]);

  async function preloadFollowingFeed() {
    if (!isConnected) return;
    if (isCacheValid('following')) return;

    const user = authUser;
    if (!user) return;

    const ownerId = user.id;
    const writeId = ++followingCacheRequestId;

    try {
      const { data: blockedUsers } = await supabase
        .from('blocks')
        .select('blocked_id')
        .eq('blocker_id', user.id);

      const blockedIds = blockedUsers?.map(b => b.blocked_id) ?? [];

      const { data: follows } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', user.id);

      if (!follows || follows.length === 0) {
        if (
          isFeedCacheOwner(ownerId) &&
          writeId === followingCacheRequestId
        ) {
          feedCache.following = [];
          feedCache.ts.following = Date.now();
        }
        return;
      }

      const followingIds = follows.map(f => f.following_id);

      let query = supabase
        .from('videos')
        .select('*, profiles!videos_user_id_profiles_fkey(id, username, avatar_url, is_scholar, trusted_user)')
        .in('user_id', followingIds)
        .neq('user_id', user.id)
        .eq('status', 'approved')
        .eq('processing_status', 'ready');

      if (blockedIds.length > 0) {
        query = query.not('user_id', 'in', `(${blockedIds.join(',')})`);
      }

      const { data } = await query
        .order('created_at', { ascending: false })
        .limit(20);

      if (
        isFeedCacheOwner(ownerId) &&
        writeId === followingCacheRequestId
      ) {
        feedCache.following = data ?? [];
        feedCache.ts.following = Date.now();
      }
    } catch (error) {
      __DEV__ &&
        console.warn('preloadFollowingFeed error:', error?.message);
    }
  }

  useFocusEffect(
    useCallback(() => {
      followingRef.current?.setActive(index === 0);
      foryouRef.current?.setActive(index === 1);

      const entry = SystemBars.pushStackEntry({
        style: index === 2 ? 'dark' : 'light',
      });

      return () => {
        __DEV__ &&
          console.log(
            '[LEAK DEBUG] Home blur cleanup firing, index:',
            index
          );

        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('pauseAllVideos');

        followingRef.current?.setActive(false);
        foryouRef.current?.setActive(false);

        SystemBars.popStackEntry(entry);
      };
    }, [index])
  );

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }

    if (isFocused) {
      if (index === 0 && !isCacheValid('following')) {
        followingRef.current?.refresh?.();
      } else if (index === 1 && !isCacheValid('foryou')) {
        foryouRef.current?.refresh?.();
      }
    }
  }, [isFocused]);

  useEffect(() => {
    homeRefreshRef.current = () => {
      if (index === 0) {
        followingRef.current?.refresh();
      } else if (index === 1) {
        foryouRef.current?.refresh();
      }
    };
  }, [index]);

  const handleIndexChange = useCallback((newIndex) => {
    setIndex(newIndex);

    followingRef.current?.setActive(
      isFocusedRef.current && newIndex === 0
    );

    foryouRef.current?.setActive(
      isFocusedRef.current && newIndex === 1
    );
  }, []);

  const renderScene = useCallback(
    ({ route }) => {
      switch (route.key) {
        case 'following':
          return (
            <VideoFeed
              key={`${route.key}:${authUser?.id ?? 'anon'}`}
              ref={followingRef}
              type="following"
              navigation={navigation}
              tabIndex={0}
              activeIndexRef={indexRef}
              isFocusedRef={isFocusedRef}
            />
          );

        case 'foryou':
          return (
            <VideoFeed
              key={`${route.key}:${authUser?.id ?? 'anon'}`}
              ref={foryouRef}
              type="foryou"
              navigation={navigation}
              tabIndex={1}
              activeIndexRef={indexRef}
              isFocusedRef={isFocusedRef}
            />
          );

        case 'live':
          return (
            <LiveFeed navigation={navigation} isActive={index === 2 && isFocused} />
          );

        default:
          return null;
      }
    },
    [navigation, authUser?.id, index, isFocused]
  );

  const renderTabBar = useCallback(
    (props) => {
      const { navigationState, position } = props;
      const isLiveTab = index === 2;

      return (
        <View
          style={{
            position: 'absolute',
            top: insets.top,
            left: 0,
            right: 0,
            zIndex: 10,
            paddingHorizontal: 16,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <View
              style={{
                flex: 1,
                flexDirection: 'row',
                justifyContent: 'center',
              }}
            >
              {navigationState.routes.map((route, i) => {
                const isFocusedTab =
                  navigationState.index === i;

                const opacity = position.interpolate({
                  inputRange: [i - 1, i, i + 1],
                  outputRange: [0, 1, 0],
                  extrapolate: 'clamp',
                });

                return (
                  <AnimatedButton
                    key={route.key}
                    onPress={() => props.jumpTo(route.key)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 8,
                      alignItems: 'center',
                    }}
                  >
                    {route.key === 'live' ? (
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                        }}
                      >
                        <Animated.View
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 4,
                            backgroundColor: '#FF3B30',
                            transform: [{ scale: pulseAnim }],
                            marginRight: 6,
                          }}
                        />

                        <Text
                          style={{
                            color: isFocusedTab
                              ? '#FF3B30'
                              : isLiveTab
                                ? 'rgba(255,59,48,0.5)'
                                : 'rgba(255,59,48,0.6)',
                            fontSize: 15,
                            fontWeight: isFocusedTab
                              ? '700'
                              : '600',
                            letterSpacing: 0.5,
                          }}
                        >
                          LIVE
                        </Text>
                      </View>
                    ) : (
                      <Text
                        style={{
                          color: isFocusedTab
                            ? isLiveTab
                              ? '#1a2e44'
                              : COLORS.gold
                            : isLiveTab
                              ? 'rgba(26,46,68,0.5)'
                              : 'rgba(255,255,255,0.6)',
                          fontSize: 15,
                          fontWeight: isFocusedTab
                            ? '700'
                            : '600',
                        }}
                      >
                        {route.title}
                      </Text>
                    )}

                    <Animated.View
                      style={{
                        marginTop: 3,
                        alignSelf: 'center',
                        width: 30,
                        height: 3,
                        backgroundColor: isLiveTab
                          ? '#1a2e44'
                          : COLORS.gold,
                        borderRadius: 2,
                        opacity,
                      }}
                    />
                  </AnimatedButton>
                );
              })}
            </View>

            <AnimatedButton
              onPress={() => navigation.navigate(ROUTES.SEARCH)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: 'rgba(255,255,255,0.15)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 18 }}>🔍</Text>
            </AnimatedButton>
          </View>
        </View>
      );
    },
    [insets.top, index, pulseAnim]
  );

  return (
    <GestureHandlerRootView
      style={{
        flex: 1,
        backgroundColor: '#000',
      }}
    >
      {showOffline && (
        <View
          style={{
            position: 'absolute',
            top: insets.top + 50,
            alignSelf: 'center',
            backgroundColor: 'rgba(0,0,0,0.85)',
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: isReconnecting
              ? '#22c55e'
              : '#ef4444',
            zIndex: 999,
            elevation: 5,
          }}
        >
          {isReconnecting ? (
            <ActivityIndicator
              size="small"
              color="#4CAF50"
              style={{ marginRight: 8 }}
            />
          ) : (
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: '#ff4757',
                marginRight: 8,
              }}
            />
          )}

          <Text
            style={{
              color: '#fff',
              fontSize: 13,
              fontWeight: '600',
            }}
          >
            {isReconnecting
              ? 'Reconnecting...'
              : 'No internet connection'}
          </Text>
        </View>
      )}

      <TabView
        navigationState={{ index, routes }}
        renderScene={renderScene}
        renderTabBar={renderTabBar}
        onIndexChange={handleIndexChange}
        initialLayout={{ width: screenWidth }}
        lazy={true}
        swipeEnabled={true}
        animationEnabled={false}
        tabBarPosition="top"
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },

  loadingText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 40,
  },

  emptyIcon: {
    fontSize: 52,
  },

  emptySubtext: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 40,
    lineHeight: 22,
  },

  retryBtn: {
    backgroundColor: COLORS.gold,
    borderRadius: 20,
    paddingHorizontal: 32,
    paddingVertical: 12,
    marginTop: 8,
    shadowColor: COLORS.gold,
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: {
      width: 0,
      height: 3,
    },
    elevation: 4,
  },

  retryBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});