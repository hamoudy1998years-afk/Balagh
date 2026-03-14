import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { useEffect, useState } from 'react';
import { useRoute } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import VideoCard from '../components/LiveVideoCard.js';
import { COLORS } from '../constants/theme';

export default function VideoDetailScreen() {
  const route = useRoute();
  const { videoId } = route.params;
  const [video, setVideo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadVideo();
  }, [videoId]);

  async function loadVideo() {
    const { data } = await supabase
      .from('videos')
      .select('*, profiles!videos_user_id_profiles_fkey(id, username, avatar_url)')
      .eq('id', videoId)
      .single();
    setVideo(data);
    setLoading(false);
  }

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={COLORS.gold} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {video && (
        <VideoCard
          item={video}
          isActive={true}
          isVisible={true}
          isTabActive={true}
          initialLiked={false}
          initialFollowed={false}
          username={video.profiles?.username ?? 'user'}
          avatarUrl={video.profiles?.avatar_url ?? null}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
  },
});