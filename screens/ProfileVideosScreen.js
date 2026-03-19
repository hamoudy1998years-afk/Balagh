import { View, StyleSheet, FlatList, Text, useWindowDimensions, StatusBar } from 'react-native';
import { useVideoPlayerPool } from '../components/VideoPlayerPool';
import { useState, useRef, useEffect } from 'react';
import VideoCard from './VideoCard';
import AnimatedButton from './AnimatedButton';

export default function ProfileVideosScreen({ route, navigation }) {
  const { height, width } = useWindowDimensions();
  const { videos, startIndex } = route.params ?? {};
  const [activeIndex, setActiveIndex] = useState(startIndex ?? 0);
  const playerPool = useVideoPlayerPool();

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
    if (viewableItems.length > 0) {
      setActiveIndex(viewableItems[0].index);
    }
  }).current;

  return (
    <View style={[styles.container, { height, width }]}>
      <StatusBar hidden />
      <AnimatedButton style={styles.backBtn} onPress={navigation.goBack}>
        <Text style={styles.backText}>✕</Text>
      </AnimatedButton>
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
    position: 'absolute', top: 50, left: 16, zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  backText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});