import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, useWindowDimensions } from 'react-native';
import { useEffect, useState, useRef } from 'react';
import { useRoute } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import VideoCard from '../screens/VideoCard';
import { COLORS } from '../constants/theme';
import { useUser } from '../context/UserContext';

export default function VideoDetailScreen({ navigation }) {
  const route = useRoute();
  const { videoId } = route.params ?? {};
  const { height } = useWindowDimensions();
  const playerRef = useRef(null);
  const { user: authUser } = useUser();
  const [video, setVideo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    loadVideo();
  }, [videoId]);

  async function loadVideo() {
    if (!videoId) { setError(true); setLoading(false); return; }
    const { data, error } = await supabase
      .from('videos')
      .select('*, profiles!videos_user_id_profiles_fkey(id, username, avatar_url)')
      .eq('id', videoId)
      .single();
    if (error || !data) { setError(true); setLoading(false); return; }

    const user = authUser;
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
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.gold} size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={{ color: '#fff', fontSize: 16 }}>Video not found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity
        onPress={() => navigation.goBack()}
        style={styles.backBtn}
      >
        <Text style={styles.backText}>←</Text>
      </TouchableOpacity>
      {video && (
        <VideoCard
          item={video}
          player={playerRef}
          isActive={true}
          isVisible={true}
          isTabActive={true}
          cardHeight={height}
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
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  backBtn: { position: 'absolute', top: 48, left: 16, zIndex: 99 },
  backText: { color: '#fff', fontSize: 28, fontWeight: '700' },
});