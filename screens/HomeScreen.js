import { View, Text, StyleSheet, FlatList, ActivityIndicator, Dimensions, Animated, RefreshControl, TouchableOpacity } from 'react-native';
import { useRef, useState, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
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

const { width, height } = Dimensions.get('window');

// ── Simple in-memory feed cache ────────────────────────────────────────────────
const feedCache = {
  foryou: null,
  following: null,
  likes: null,
  follows: null,
  ts: {},
};
const CACHE_TTL = 60 * 1000; // 1 minute — serve cache, refresh in background

function isCacheValid(key) {
  return feedCache[key] !== null && feedCache.ts[key] && Date.now() - feedCache.ts[key] < CACHE_TTL;
}

// ── Live Streams Feed ──────────────────────────────────────────────────────────
function LiveFeed({ navigation }) {
  const [streams, setStreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadStreams();
    const interval = setInterval(loadStreams, 15000);
    const channel = supabase
      .channel('live_streams_home')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_streams' }, () => loadStreams())
      .subscribe();
    return () => {
      channel.unsubscribe();
      clearInterval(interval);
    };
  }, []);

  async function loadStreams() {
    const tenSecondsAgo = new Date(Date.now() - 10 * 1000).toISOString();
    const { data } = await supabase
      .from('live_streams')
      .select('*, profiles(username, avatar_url)')
      .eq('is_live', true)
      .gt('last_ping', tenSecondsAgo)
      .order('created_at', { ascending: false });
    setStreams(data ?? []);
    setLoading(false);
    setRefreshing(false);
  }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#ef4444" size="large" />
        <Text style={styles.loadingText}>Loading live streams...</Text>
      </View>
    );
  }

  if (streams.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.emptyIcon}>🔴</Text>
        <Text style={styles.loadingText}>No live streams right now</Text>
        <Text style={styles.emptySubtext}>Check back later for live scholars!</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <FlatList
        data={streams}
        numColumns={2}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 4, paddingTop: 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={loadStreams} tintColor="#ef4444" />}
        renderItem={({ item }) => (
          <View style={{ width: width / 2 - 8, margin: 4 }}>
            <LiveVideoCard
              stream={item}
              onPress={() => item.is_live && navigation.navigate('WatchLive', { stream: item })}
            />
          </View>
        )}
      />
    </View>
  );
}

// ── Video Feed ─────────────────────────────────────────────────────────────────
const VideoFeed = forwardRef(({ type, navigation, tabIndex, activeIndexRef, isFocusedRef }, ref) => {
  const [videos, setVideos] = useState(() => feedCache[type] ?? []);
  const [loading, setLoading] = useState(() => !feedCache[type]);
  const [refreshing, setRefreshing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [listHeight, setListHeight] = useState(height);
  const [myLikes, setMyLikes] = useState(() => feedCache.likes ?? []);
  const [myFollows, setMyFollows] = useState(() => feedCache.follows ?? []);

  const [isTabActive, setIsTabActive] = useState(
    () => !!(isFocusedRef?.current && activeIndexRef?.current === tabIndex)
  );

  const flatListRef = useRef(null);
  const playerPool = useVideoPlayerPool();
  const prevIndexRef = useRef(0);

  // ── Imperative handle ──────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    refresh: async () => {
      setActiveIndex(0);
      prevIndexRef.current = -1;
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
      // Force fresh fetch, skip cache
      feedCache[type] = null;
      feedCache.ts[type] = null;
      loadVideos();
      loadMyInteractions();
    },
    setActive: (val) => {
      setIsTabActive(!!val);
    },
  }));

  // ── Load first video when videos array arrives ─────────────────────────────
  useEffect(() => {
    if (videos.length === 0) return;
    if (prevIndexRef.current === -1) prevIndexRef.current = 0;
    playerPool.loadVideo('current', videos[0].video_url);
    if (isTabActive) playerPool.playCurrent();
    if (videos[1]) playerPool.loadVideo('next', videos[1].video_url);
    setActiveIndex(0);
  }, [videos]);

  // ── Manage player pool when active index changes ───────────────────────────
  useEffect(() => {
    if (videos.length === 0) return;

    const direction = activeIndex > prevIndexRef.current ? 'next' : 'prev';
    if (direction === 'next' && activeIndex > prevIndexRef.current) {
      playerPool.scrollNext();
    } else if (direction === 'prev' && activeIndex < prevIndexRef.current) {
      playerPool.scrollPrev();
    }

    const currentVideo = videos[activeIndex];
    if (currentVideo) {
      playerPool.loadVideo('current', currentVideo.video_url);
      if (isTabActive) playerPool.playCurrent();
    }

    const nextVideo = videos[activeIndex + 1];
    if (nextVideo) playerPool.loadVideo('next', nextVideo.video_url);

    const prevVideo = videos[activeIndex - 1];
    if (prevVideo) playerPool.loadVideo('prev', prevVideo.video_url);

    prevIndexRef.current = activeIndex;

    return () => {
      try { playerPool.pauseAll(); } catch (e) {}
    };
  }, [activeIndex, videos]);

  // ── Pause / resume when tab focus changes ─────────────────────────────────
  useEffect(() => {
    if (isTabActive) {
      try { playerPool.playCurrent(); } catch (e) {}
    } else {
      try { playerPool.pauseAll(); } catch (e) {}
    }
  }, [isTabActive]);

  // ── Load data on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    // If cache is valid, show it instantly and refresh in background
    if (isCacheValid(type)) {
      setVideos(feedCache[type]);
      setMyLikes(feedCache.likes ?? []);
      setMyFollows(feedCache.follows ?? []);
      setLoading(false);
      // Background refresh
      loadVideos(true);
      loadMyInteractions(true);
    } else {
      loadVideos();
      loadMyInteractions();
    }
  }, [type]);

  // ── FIX 1: Single query with profile join — no more attachUsernames ────────
  async function loadVideos(background = false) {
    if (!background) setLoading(true);

    if (type === 'following') {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setVideos([]); setLoading(false); return; }

      const { data: follows } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', user.id);

      if (!follows || follows.length === 0) {
        setVideos([]);
        setLoading(false);
        return;
      }

      const followingIds = follows.map(f => f.following_id);

      const { data } = await supabase
        .from('videos')
        .select('*, profiles!videos_user_id_profiles_fkey(id, username, avatar_url)')
        .in('user_id', followingIds)
        .neq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);

      const result = data ?? [];
      feedCache.following = result;
      feedCache.ts.following = Date.now();
      setVideos(result);

    } else {
      const { data } = await supabase
        .from('videos')
        .select('*, profiles!videos_user_id_profiles_fkey(id, username, avatar_url)')
        .order('created_at', { ascending: false })
        .limit(20);

      const shuffled = (data ?? []).sort(() => Math.random() - 0.5);
      feedCache.foryou = shuffled;
      feedCache.ts.foryou = Date.now();
      setVideos(shuffled);
    }

    setLoading(false);
  }

  // ── FIX 3: Load likes + follows in parallel with Promise.all ──────────────
  async function loadMyInteractions(background = false) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [likesRes, followsRes] = await Promise.all([
      supabase.from('likes').select('video_id').eq('user_id', user.id),
      supabase.from('follows').select('following_id').eq('follower_id', user.id),
    ]);

    const likes = likesRes.data?.map(l => l.video_id) ?? [];
    const follows = followsRes.data?.map(f => f.following_id) ?? [];

    feedCache.likes = likes;
    feedCache.follows = follows;

    setMyLikes(likes);
    setMyFollows(follows);
  }

  function updateMyFollows(userId, isFollowing) {
    if (isFollowing) setMyFollows(prev => [...prev, userId]);
    else setMyFollows(prev => prev.filter(id => id !== userId));
  }

  async function onRefresh() {
    setRefreshing(true);
    feedCache[type] = null;
    feedCache.ts[type] = null;
    await Promise.all([loadVideos(), loadMyInteractions()]);
    setRefreshing(false);
  }

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) setActiveIndex(viewableItems[0].index);
  }).current;

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#ffffff" size="large" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <FlatList
        ref={flatListRef}
        data={videos}
        keyExtractor={(item) => item.id}
        style={{ backgroundColor: '#000' }}
        overScrollMode="never"
        onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}
        renderItem={({ item, index }) => {
          const isVisible = Math.abs(index - activeIndex) <= 2;
          if (!isVisible) return <View style={{ height: listHeight }} />;

          let slot = null;
          if (index === activeIndex - 1) slot = 'prev';
          else if (index === activeIndex) slot = 'current';
          else if (index === activeIndex + 1) slot = 'next';

          return (
            <VideoCard
              item={item}
              player={slot ? playerPool.getPlayerRef(slot) : null}
              isActive={index === activeIndex}
              isVisible={isVisible}
              isTabActive={isTabActive}
              initialLiked={myLikes.includes(item.id)}
              initialFollowed={myFollows.includes(item.user_id)}
              onFollowChange={updateMyFollows}
              navigation={navigation}
              cardHeight={listHeight}
              // ── FIX 4: Pass profile data as props — no fetch needed in VideoCard
              username={item.profiles?.username ?? 'user'}
              avatarUrl={item.profiles?.avatar_url ?? null}
            />
          );
        }}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 80 }}
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
    </View>
  );
});

// ── Home Screen ────────────────────────────────────────────────────────────────
export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(1);
  const [routes] = useState([
    { key: 'following', title: 'Following' },
    { key: 'foryou', title: 'For You' },
    { key: 'live', title: '🔴 Live' },
  ]);

  const isFocused = useIsFocused();
  const followingRef = useRef(null);
  const foryouRef = useRef(null);

  const indexRef = useRef(index);
  const isFocusedRef = useRef(isFocused);

  useEffect(() => { indexRef.current = index; }, [index]);
  useEffect(() => { isFocusedRef.current = isFocused; }, [isFocused]);

  useEffect(() => {
    followingRef.current?.setActive(isFocused && index === 0);
    foryouRef.current?.setActive(isFocused && index === 1);
  }, [isFocused]);

  useEffect(() => {
    homeRefreshRef.current = () => {
      if (index === 0) followingRef.current?.refresh();
      else if (index === 1) foryouRef.current?.refresh();
    };
  }, [index]);

  const handleIndexChange = useCallback((newIndex) => {
    setIndex(newIndex);
    followingRef.current?.setActive(isFocusedRef.current && newIndex === 0);
    foryouRef.current?.setActive(isFocusedRef.current && newIndex === 1);
  }, []);

  const renderScene = useCallback(({ route }) => {
    switch (route.key) {
      case 'following':
        return (
          <VideoFeed
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
            ref={foryouRef}
            type="foryou"
            navigation={navigation}
            tabIndex={1}
            activeIndexRef={indexRef}
            isFocusedRef={isFocusedRef}
          />
        );
      case 'live':
        return <LiveFeed navigation={navigation} />;
      default:
        return null;
    }
  }, [navigation]);

  const renderTabBar = useCallback((props) => {
    const { navigationState, position } = props;
    return (
      <View style={{ position: 'absolute', top: insets.top, left: 0, right: 0, zIndex: 10, paddingHorizontal: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'center' }}>
            {navigationState.routes.map((route, i) => {
              const isFocusedTab = navigationState.index === i;
              const opacity = position.interpolate({
                inputRange: [i - 1, i, i + 1],
                outputRange: [0, 1, 0],
                extrapolate: 'clamp',
              });
              return (
                <AnimatedButton
                  key={route.key}
                  onPress={() => props.jumpTo(route.key)}
                  style={{ paddingHorizontal: 16, paddingVertical: 8, alignItems: 'center' }}
                >
                  <Text style={{
                    color: isFocusedTab ? COLORS.gold : 'rgba(255,255,255,0.6)',
                    fontSize: 15,
                    fontWeight: isFocusedTab ? '700' : '600',
                  }}>
                    {route.title}
                  </Text>
                  <Animated.View style={{
                    marginTop: 3,
                    alignSelf: 'center',
                    width: 30,
                    height: 3,
                    backgroundColor: COLORS.gold,
                    borderRadius: 2,
                    opacity,
                  }} />
                </AnimatedButton>
              );
            })}
          </View>
          <AnimatedButton onPress={() => navigation.navigate('Search')}>
            <Text style={{ fontSize: 22 }}>🔍</Text>
          </AnimatedButton>
        </View>
      </View>
    );
  }, [insets.top, index]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
      <TabView
        navigationState={{ index, routes }}
        renderScene={renderScene}
        renderTabBar={renderTabBar}
        onIndexChange={handleIndexChange}
        initialLayout={{ width }}
        lazy={true}
        swipeEnabled={true}
        animationEnabled={true}
        tabBarPosition="top"
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loadingContainer: { flex: 1, backgroundColor: COLORS.bgDark, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: COLORS.textWhite, fontSize: 16, fontWeight: '600' },
  emptyIcon: { fontSize: 48 },
  emptySubtext: { color: '#64748b', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
});