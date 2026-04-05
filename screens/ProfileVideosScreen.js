import { View, StyleSheet, FlatList, Text, useWindowDimensions, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVideoPlayerPool } from '../components/VideoPlayerPool';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { SystemBars } from 'react-native-edge-to-edge';
import VideoCard from './VideoCard';
import AnimatedButton from './AnimatedButton';

export default function ProfileVideosScreen({ route, navigation }) {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { videos: videosParam, startIndex } = route.params ?? {};
  const videos = videosParam || []; // Ensure videos is always an array
  const [activeIndex, setActiveIndex] = useState(startIndex ?? 0);
  const playerPool = useVideoPlayerPool();
  const [showSwipeHint, setShowSwipeHint] = useState(true);
  const swipeHintOpacity = useRef(new Animated.Value(1));

  useEffect(() => {
    if (videos.length === 0) return;
    const current = videos[activeIndex];
    const next = videos[activeIndex + 1];
    const prev = videos[activeIndex - 1];
    if (current) playerPool.loadVideo('current', current.video_url);
    if (next) playerPool.loadVideo('next', next.video_url);
    if (prev) playerPool.loadVideo('prev', prev.video_url);
    playerPool.playCurrent();
  }, [activeIndex, videos]);

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems?.length > 0) {
      setActiveIndex(viewableItems[0].index);
    }
  }).current;

  useFocusEffect(
    useCallback(() => {
      const entry = SystemBars.pushStackEntry({ style: 'light' });
      return () => SystemBars.popStackEntry(entry);
    }, [])
  );

  useEffect(() => {
    if (videos.length <= 1) return;
    const timer = setTimeout(() => {
      Animated.timing(swipeHintOpacity.current, {
        toValue: 0,
        duration: 800,
        useNativeDriver: true,
      }).start(() => setShowSwipeHint(false));
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  if (videos.length === 0) {
    return (
      <View style={[styles.container, {
        height, width,
        justifyContent: 'center',
        alignItems: 'center'
      }]}>
        <AnimatedButton
          style={[styles.backBtn, { top: insets.top + 10 }]}
          onPress={navigation.goBack}
        >
          <Text style={styles.backText}>✕</Text>
        </AnimatedButton>
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateIcon}>🎬</Text>
          <Text style={styles.emptyStateTitle}>
            No Videos Found
          </Text>
          <Text style={styles.emptyStateSubtitle}>
            There's nothing to show here
          </Text>
          <AnimatedButton
            style={styles.emptyStateBtn}
            onPress={navigation.goBack}
          >
            <Text style={styles.emptyStateBtnText}>
              Go Back
            </Text>
          </AnimatedButton>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { height, width }]}>

      <AnimatedButton style={[styles.backBtn, { top: insets.top + 10 }]} onPress={navigation.goBack}>
        <Text style={styles.backText}>✕</Text>
      </AnimatedButton>
      <View style={[styles.videoCounter, { top: insets.top + 10 }]}>
        <Text style={styles.videoCounterText}>
          {activeIndex + 1} / {videos.length}
        </Text>
      </View>
      {showSwipeHint && videos.length > 1 && (
        <Animated.View style={[
          styles.swipeHint,
          {
            opacity: swipeHintOpacity.current,
            bottom: insets.bottom + 100,
          }
        ]}>
          <Text style={styles.swipeHintText}>
            👆 Swipe for more
          </Text>
        </Animated.View>
      )}
      <FlatList
        data={videos}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <View style={{ height, width, overflow: 'hidden', backgroundColor: '#000' }}>
            {Math.abs(index - activeIndex) > 1 ? null : <VideoCard
              item={item}
              player={
                index === activeIndex - 1 ? playerPool.getPlayerRef('prev') :
                index === activeIndex ? playerPool.getPlayerRef('current') :
                index === activeIndex + 1 ? playerPool.getPlayerRef('next') : null
              }
              isActive={index === activeIndex}
              isTabActive={true}
              isVisible={true}
              cardHeight={height}
              navigation={navigation}
              username={item.profiles?.username ?? 'user'}
              avatarUrl={item.profiles?.avatar_url ?? null}
              initialLiked={false}
              initialFollowed={false}
            />}
          </View>
        )}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 80 }}
        initialScrollIndex={startIndex ?? 0}
        getItemLayout={(_, index) => ({
          length: height,
          offset: height * index,
          index,
        })}
        snapToInterval={height}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum={true}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  backBtn: {
    position: 'absolute', left: 16, zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  backText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  videoCounter: {
    position: 'absolute',
    right: 16,
    zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  videoCounterText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  emptyState: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 24,
    padding: 36,
    marginHorizontal: 32,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  emptyStateIcon: {
    fontSize: 56,
    marginBottom: 16,
  },
  emptyStateTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  emptyStateSubtitle: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  emptyStateBtn: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  emptyStateBtnText: {
    color: '#000000',
    fontSize: 15,
    fontWeight: '700',
  },
  swipeHint: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  swipeHintText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
