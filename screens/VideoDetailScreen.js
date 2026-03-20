import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, useWindowDimensions } from 'react-native';
import { useEffect, useState, useRef } from 'react';
import { useRoute } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import VideoCard from '../screens/VideoCard';
import { COLORS } from '../constants/theme';
import { useUser } from '../context/UserContext';

export default function VideoDetailScreen({ navigation }) {
  const route = useRoute();
  const videoId = route.params?.id || route.params?.videoId;
  console.log('[VideoDetail] Extracted videoId:', videoId);
  const { height } = useWindowDimensions();
  const playerRef = useRef(null);
  const { user: authUser } = useUser();
  const [video, setVideo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Debug logs at component start
  console.log('[VideoDetail] Route params:', route.params);
  console.log('[VideoDetail] Video object from params:', route.params?.video ? 'exists' : 'null');

  useEffect(() => {
    console.log('[VideoDetail] useEffect triggered. videoId:', videoId, 'video state:', video ? 'exists' : 'null');
    if (videoId && !route.params?.video) {
      fetchVideoById(videoId);
    } else if (route.params?.video) {
      setVideo(route.params.video);
      setLoading(false);
    }
  }, [videoId]);

  // Debug log when video state updates
  useEffect(() => {
    console.log('[VideoDetail] Video state updated:', video ? 'video loaded' : 'video null');
  }, [video]);

  async function fetchVideoById(id) {
    try {
      console.log('[VideoDetail] Starting fetch for ID:', id);
      setLoading(true);
      
      // Fetch video WITHOUT broken foreign key join
      const { data: videoData, error: videoError } = await supabase
        .from('videos')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      
      if (videoError) {
        console.error('[VideoDetail] Supabase error:', videoError.message);
        throw videoError;
      }
      
      if (!videoData) {
        console.log('[VideoDetail] No video found');
        setVideo(null);
        setLoading(false);
        return;
      }
      
      console.log('[VideoDetail] Video fetched:', videoData.id);
      
      // Fetch profile separately (no FK join)
      let profileData = null;
      if (videoData.user_id) {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id, username, avatar_url')
          .eq('id', videoData.user_id)
          .single();
          
        if (profileError) {
          console.log('[VideoDetail] Profile fetch error:', profileError.message);
        } else if (profile) {
          profileData = profile;
          console.log('[VideoDetail] Profile fetched:', profile.username);
        }
      }
      
      // Combine them
      const combined = {
        ...videoData,
        profiles: profileData || { username: 'Unknown' }
      };
      
      console.log('[VideoDetail] Setting video state with profile');
      setVideo(combined);
      
    } catch (error) {
      console.error('[VideoDetail] Fetch error:', error.message);
      setVideo(null);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    console.log('[VideoDetail] Rendering loading state');
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.gold} size="large" />
      </View>
    );
  }

  if (error || !video) {
    console.log('[VideoDetail] Rendering not found state');
    return (
      <View style={styles.center}>
        <Text style={{ color: '#fff', fontSize: 16 }}>Video not found.</Text>
      </View>
    );
  }

  console.log('[VideoDetail] Rendering video:', video?.id, 'caption:', video?.caption?.substring(0, 30));
  return (
    <View style={styles.container}>
      <TouchableOpacity
        onPress={navigation.goBack}
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