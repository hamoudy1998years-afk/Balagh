import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useEffect, useState } from 'react';
import { useRoute } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import VideoCard from '../components/VideoCard.js';
import { COLORS } from '../constants/theme';

export default function VideoDetailScreen({ navigation }) {
  const route = useRoute();
  const { videoId } = route.params;
  const [video, setVideo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    loadVideo();
  }, [videoId]);

  async function loadVideo() {
    const { data, error } = await supabase
      .from('videos')
      .select('*, profiles!videos_user_id_profiles_fkey(id, username, avatar_url)')
      .eq('id', videoId)
      .single();
    if (error || !data) { setError(true); setLoading(false); return; }

    const { data: { user } } = await supabase.auth.getUser();
    let liked = false;
    let followed = false;

    if (user) {
      const [{ data: likeData }, { data: followData }] = await Promise.all([
        supabase.from('likes').select('id').eq('user_id', user.id).eq('video_id', data.id).maybeSingle(),
        supabase.from('follows').select('id').eq('follower_id', user.id).eq('following_id', data.user_id).maybeSingle(),
      ]);
      liked = !!likeData;
      followed = !!followData;
    }

    setVideo({ ...data, initialLiked: liked, initialFollowed: followed });
    setLoading(false);
  }

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={COLORS.gold} size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={{ color: '#fff', fontSize: 16 }}>Video not found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity
        onPress={() => navigation.goBack()}
        style={{ position: 'absolute', top: 48, left: 16, zIndex: 99 }}
      >
        <Text style={{ color: '#fff', fontSize: 28, fontWeight: '700' }}>←</Text>
      </TouchableOpacity>
      {video && (
        <VideoCard
          item={video}
          isActive={true}
          isVisible={true}
          isTabActive={true}
          initialLiked={video.initialLiked ?? false}
          initialFollowed={video.initialFollowed ?? false}
          username={video.profiles?.username ?? 'user'}
          avatarUrl={video.profiles?.avatar_url ?? null}
          navigation={navigation}
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