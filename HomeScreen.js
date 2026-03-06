import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Animated, Dimensions } from 'react-native';
import { useRef, useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import GestureRecognizer from 'react-native-swipe-gestures';
import VideoCard from './VideoCard';

const { height } = Dimensions.get('window');

  export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [feedTab, setFeedTab] = useState(null);
  const [myLikes, setMyLikes] = useState([]);      // 👈 new
  const [myFollows, setMyFollows] = useState([]);  // 👈 new
  const flatListRef = useRef(null);
  const [listHeight, setListHeight] = useState(height);

  const slideAnim = useRef(new Animated.Value(0)).current;

  function switchTab(newTab) {
    const currentIndex = tabs.indexOf(feedTab);
    const newIndex = tabs.indexOf(newTab);
    const direction = newIndex > currentIndex ? 1 : -1;

    slideAnim.setValue(direction * 400);
    setFeedTab(newTab);

    Animated.spring(slideAnim, {
      toValue: 0,
      useNativeDriver: true,
      tension: 60,
      friction: 10,
    }).start();
  }

  function updateMyFollows(userId, isFollowing) {
    if (isFollowing) {
      setMyFollows(prev => [...prev, userId]);
    } else {
      setMyFollows(prev => prev.filter(id => id !== userId));
    }
  }

  useEffect(() => {
    async function loadMyInteractions() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: likes } = await supabase
        .from('likes')
        .select('video_id')
        .eq('user_id', user.id);

      const { data: follows } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', user.id);

      setMyLikes(likes?.map(l => l.video_id) ?? []);
      setMyFollows(follows?.map(f => f.following_id) ?? []);
    }
    loadMyInteractions();
  }, []);
  
  useEffect(() => {
    if (feedTab === null) {
      setFeedTab('foryou');
      return;
    }
    setLoading(true);
    setVideos([]);
    if (feedTab === 'following') {
      loadFollowingVideos();
    } else if (feedTab === 'foryou') {
      supabase
        .from('videos')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20)
        .then(({ data }) => {
          setVideos(data ?? []);
          setLoading(false);
        });
    } else if (feedTab === 'live') {
      setVideos([]);
      setLoading(false);
    }
  }, [feedTab]);

  useEffect(() => {
    const unsubscribe = navigation?.addListener('tabPress', () => {
      setFeedTab('foryou');
      handleRefresh();
    });
    return unsubscribe;
  }, [navigation]);

  useEffect(() => {
    const unsubscribe = navigation?.addListener('focus', async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: follows } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', user.id);
      setMyFollows(follows?.map(f => f.following_id) ?? []);
    });
    return unsubscribe;
  }, [navigation]);

  async function loadFollowingVideos() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setVideos([]); setLoading(false); return; }

    const { data: follows } = await supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', user.id)
      .neq('following_id', user.id); // prevent self-follows

    if (!follows || follows.length === 0) {
      setVideos([]);
      setLoading(false);
      return;
    }

    const followingIds = follows.map(f => f.following_id);

    const { data } = await supabase
      .from('videos')
      .select('*')
      .in('user_id', followingIds)
      .neq('user_id', user.id) // 👈 extra safety: never show your own videos here
      .order('created_at', { ascending: false })
      .limit(20);

    setVideos(data ?? []);
    setLoading(false);
  }

  async function handleRefresh() {
    setRefreshing(true);
    const { data } = await supabase
      .from('videos')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    const shuffled = (data ?? []).sort(() => Math.random() - 0.5);
    setVideos(shuffled);
    setActiveIndex(0);
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    setRefreshing(false);
  }

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) {
      setActiveIndex(viewableItems[0].index);
    }
  }).current;

  const tabs = ['following', 'foryou', 'live'];

  const onSwipeLeft = useCallback(() => {
    const currentIndex = tabs.indexOf(feedTab);
    if (currentIndex < tabs.length - 1) {
      switchTab(tabs[currentIndex + 1]);
    }
  }, [feedTab]);

  const onSwipeRight = useCallback(() => {
    const currentIndex = tabs.indexOf(feedTab);
    if (currentIndex > 0) {
      switchTab(tabs[currentIndex - 1]);
    }
  }, [feedTab]);

    return (
      <GestureRecognizer
        onSwipeLeft={onSwipeLeft}
        onSwipeRight={onSwipeRight}
        config={{
          velocityThreshold: 1.2,
          directionalOffsetThreshold: 60,
        }}
        style={{ flex: 1, backgroundColor: '#000' }}
      >
      <View style={styles.container}>
      <View style={[styles.topBar, { top: insets.top }]}>
        <TouchableOpacity style={styles.topTab} onPress={() => setFeedTab('following')}>
          <Text style={[styles.topTabText, feedTab === 'following' && styles.topTabActive]}>Following</Text>
          {feedTab === 'following' && <View style={styles.topTabUnderline} />}
        </TouchableOpacity>
        <TouchableOpacity style={styles.topTab} onPress={() => setFeedTab('foryou')}>
          <Text style={[styles.topTabText, feedTab === 'foryou' && styles.topTabActive]}>For You</Text>
          {feedTab === 'foryou' && <View style={styles.topTabUnderline} />}
        </TouchableOpacity>
        <TouchableOpacity style={styles.topTab} onPress={() => setFeedTab('live')}>
          <Text style={[styles.topTabText, feedTab === 'live' && styles.topTabActive]}>🔴 Live</Text>
          {feedTab === 'live' && <View style={styles.topTabUnderline} />}
        </TouchableOpacity>
        <TouchableOpacity style={styles.topSearch} onPress={() => navigation.navigate('Search')}>
          <Text style={styles.topSearchIcon}>🔍</Text>
        </TouchableOpacity>
      </View>

      <Animated.View style={{ flex: 1, transform: [{ translateX: slideAnim }], backgroundColor: '#000' }}> 
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color="#7c3aed" size="large" />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      ) : videos.length === 0 ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.emptyIcon}>
            {feedTab === 'following' ? '👥' : feedTab === 'live' ? '🔴' : '🕌'}
          </Text>
          <Text style={styles.loadingText}>
            {feedTab === 'following' ? 'No videos from people you follow' : feedTab === 'live' ? 'No live streams right now' : 'No videos yet'}
          </Text>
          <Text style={styles.emptySubtext}>
            {feedTab === 'following' ? 'Follow some creators to see their videos here!' : feedTab === 'live' ? 'Check back later for live scholars!' : 'Be the first to upload dawah content!'}
          </Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          key={feedTab}
          data={videos}
          keyExtractor={(item) => item.id}
          style={{ backgroundColor: '#000' }}
          overScrollMode="never"
          onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}
          
          renderItem={({ item, index }) => (
            <VideoCard 
              item={item} 
              isActive={index === activeIndex}
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
          refreshing={refreshing}
          onRefresh={handleRefresh}
        />
      )}
      </Animated.View>
    </View>
    </GestureRecognizer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', paddingTop: 0 },
  loadingContainer: {
    flex: 1, backgroundColor: '#000', alignItems: 'center',
    justifyContent: 'center', gap: 12, paddingTop: 100,
  },
  loadingText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  emptyIcon: { fontSize: 48 },
  emptySubtext: { color: '#64748b', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  topGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 120,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  topBar: {
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
      flexDirection: 'row', alignItems: 'center',
      justifyContent: 'center', paddingHorizontal: 16,
    },
  topTab: { alignItems: 'center', marginHorizontal: 12 },
  topTabText: { color: 'rgba(255,255,255,0.6)', fontSize: 15, fontWeight: '600' },
  topTabActive: { color: '#ffffff', fontWeight: '700' },
  topTabUnderline: { width: '100%', height: 2, backgroundColor: '#ffffff', marginTop: 3, borderRadius: 2 },
  topSearch: { position: 'absolute', right: 16 },
  topSearchIcon: { fontSize: 22 },
});