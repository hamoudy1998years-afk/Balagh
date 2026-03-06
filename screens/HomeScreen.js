import { View, Text, StyleSheet, FlatList, ActivityIndicator, Dimensions, Animated, RefreshControl, Image } from 'react-native';
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

const { width, height } = Dimensions.get('window');

// ── Live Streams Feed ──────────────────────────────────────────────────────────
function LiveFeed({ navigation }) {
  const [streams, setStreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadStreams();
    const interval = setInterval(loadStreams, 5000);
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
    // Only show streams that pinged in the last 10 seconds
    const tenSecondsAgo = new Date(Date.now() - 10 * 1000).toISOString();
    
    const { data } = await supabase
      .from('live_streams')
      .select('*, profiles(username, avatar_url)')
      .eq('is_live', true)
      .gt('last_ping', tenSecondsAgo) // Only active streams
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
const VideoFeed = forwardRef(({ type, navigation, isTabActive }, ref) => {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [listHeight, setListHeight] = useState(height);
  const flatListRef = useRef(null);
  const [myLikes, setMyLikes] = useState([]);
  const [myFollows, setMyFollows] = useState([]);

  useEffect(() => {
    loadMyInteractions();
    loadVideos();
  }, [type]);

  useImperativeHandle(ref, () => ({
    refresh: async () => {
      await onRefresh();
      flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }
  }));

  async function loadMyInteractions() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: likes } = await supabase.from('likes').select('video_id').eq('user_id', user.id);
    const { data: follows } = await supabase.from('follows').select('following_id').eq('follower_id', user.id);
    setMyLikes(likes?.map(l => l.video_id) ?? []);
    setMyFollows(follows?.map(f => f.following_id) ?? []);
  }

  async function attachUsernames(videos) {
    if (!videos || videos.length === 0) return videos;
    const userIds = [...new Set(videos.map(v => v.user_id))];
    const { data: profiles } = await supabase.from('profiles').select('id, username').in('id', userIds);
    const usernameMap = {};
    profiles?.forEach(p => { usernameMap[p.id] = p.username; });
    return videos.map(v => ({ ...v, profiles: { username: usernameMap[v.user_id] ?? 'user' } }));
  }

  async function loadVideos() {
    setLoading(true);
    if (type === 'following') {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setVideos([]); setLoading(false); return; }
      const { data: follows } = await supabase.from('follows').select('following_id').eq('follower_id', user.id);
      if (!follows || follows.length === 0) { setVideos([]); setLoading(false); return; }
      const followingIds = follows.map(f => f.following_id);
      const { data } = await supabase.from('videos').select('*').in('user_id', followingIds).neq('user_id', user.id).order('created_at', { ascending: false }).limit(20);
      setVideos(await attachUsernames(data ?? []));
    } else {
      const { data } = await supabase.from('videos').select('*').order('created_at', { ascending: false }).limit(20);
      const shuffled = (data ?? []).sort(() => Math.random() - 0.5);
      setVideos(await attachUsernames(shuffled));
    }
    setLoading(false);
  }

  async function onRefresh() {
    setRefreshing(true);
    await loadVideos();
    setRefreshing(false);
  }

  function updateMyFollows(userId, isFollowing) {
    if (isFollowing) setMyFollows(prev => [...prev, userId]);
    else setMyFollows(prev => prev.filter(id => id !== userId));
  }

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) setActiveIndex(viewableItems[0].index);
  }).current;

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#7c3aed" size="large" />
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  if (videos.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.emptyIcon}>{type === 'following' ? '👥' : '🕌'}</Text>
        <Text style={styles.loadingText}>{type === 'following' ? 'No videos from people you follow' : 'No videos yet'}</Text>
        <Text style={styles.emptySubtext}>{type === 'following' ? 'Follow some creators to see their videos here!' : 'Be the first to upload dawah content!'}</Text>
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
        renderItem={({ item, index }) => (
          <VideoCard
            item={item}
            isActive={isTabActive && index === activeIndex}
            initialLiked={myLikes.includes(item.id)}
            initialFollowed={myFollows.includes(item.user_id)}
            onFollowChange={updateMyFollows}
            navigation={navigation}
            cardHeight={listHeight}
          />
        )}
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
export default function HomeScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(1);
  const [routes] = useState([
    { key: 'following', title: 'Following' },
    { key: 'foryou', title: 'For You' },
    { key: 'live', title: '🔴 Live' },
  ]);

  const isFocused = useIsFocused();
  const refreshKey = route?.params?.refreshKey || 0;
  const followingRef = useRef(null);
  const foryouRef    = useRef(null);

  useEffect(() => {
    homeRefreshRef.current = () => {
      switch (index) {
        case 0: followingRef.current?.refresh(); break;
        case 1: foryouRef.current?.refresh();    break;
      }
    };
  }, [index]);

  const renderScene = useCallback(({ route }) => {
    switch (route.key) {
      case 'following':
        return <VideoFeed ref={followingRef} type="following" navigation={navigation} isTabActive={isFocused && index === 0} />;
      case 'foryou':
        return <VideoFeed ref={foryouRef} type="foryou" navigation={navigation} isTabActive={isFocused && index === 1} />;
      case 'live':
        return <LiveFeed navigation={navigation} />;
      default:
        return null;
    }
  }, [navigation, index, isFocused]);

  const renderTabBar = (props) => {
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
                <AnimatedButton key={route.key} onPress={() => props.jumpTo(route.key)} style={{ paddingHorizontal: 16, paddingVertical: 8, alignItems: 'center' }}>
                  <Text style={{ color: isFocusedTab ? '#ffffff' : 'rgba(255,255,255,0.6)', fontSize: 15, fontWeight: isFocusedTab ? '700' : '600' }}>
                    {route.title}
                  </Text>
                  <Animated.View style={{ marginTop: 3, alignSelf: 'center', width: 30, height: 3, backgroundColor: '#ffffff', borderRadius: 2, opacity }} />
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
  };

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
      <TabView
        navigationState={{ index, routes }}
        renderScene={renderScene}
        renderTabBar={renderTabBar}
        onIndexChange={setIndex}
        initialLayout={{ width }}
        swipeEnabled={true}
        animationEnabled={true}
        tabBarPosition="top"
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loadingContainer: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText:      { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  emptyIcon:        { fontSize: 48 },
  emptySubtext:     { color: '#64748b', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
});