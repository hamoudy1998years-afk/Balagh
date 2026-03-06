import { View, StyleSheet, FlatList, Text, useWindowDimensions, StatusBar } from 'react-native';
import { useState, useRef } from 'react';
import VideoCard from './VideoCard';
import AnimatedButton from './AnimatedButton';

export default function ProfileVideosScreen({ route, navigation }) {
  const { height, width } = useWindowDimensions();
  const { videos, startIndex } = route.params;
  const [activeIndex, setActiveIndex] = useState(startIndex ?? 0);

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) {
      setActiveIndex(viewableItems[0].index);
    }
  }).current;

  return (
    <View style={[styles.container, { height, width }]}>
      <StatusBar hidden />
      <AnimatedButton style={styles.backBtn} onPress={() => navigation.goBack()}>
        <Text style={styles.backText}>✕</Text>
      </AnimatedButton>
      <FlatList
        data={videos}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <View style={{ height, width, overflow: 'hidden' }}>
            <VideoCard
              item={item}
              isActive={index === activeIndex}
              cardHeight={height}
              navigation={navigation}
            />
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