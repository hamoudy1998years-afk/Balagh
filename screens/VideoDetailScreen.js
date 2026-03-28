import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, useWindowDimensions } from 'react-native';
import { SystemBars } from 'react-native-edge-to-edge';
import { useEffect, useState, useRef } from 'react';
import { useRoute } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import VideoCard from '../screens/VideoCard';
import { COLORS } from '../constants/theme';
import { useUser } from '../context/UserContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function VideoDetailScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const route = useRoute();
  const videoId = route.params?.id || route.params?.videoId;
  const { height } = useWindowDimensions();
  const playerRef = useRef(null);
  const { user: authUser } = useUser();
  const [video, setVideo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    console.log('[VIDEO_DETAIL] Received params:', route.params);
    console.log('[VIDEO_DETAIL] Video object:', route.params?.video);
    console.log('[VIDEO_DETAIL] Video URI:', route.params?.video?.video_url);
    
    if (videoId && !route.params?.video) {
      fetchVideoById(videoId);
    } else if (route.params?.video) {
      // ✅ NEW - check if m3u8
      const videoData = route.params.video;
      if (videoData.video_url && videoData.video_url.includes('.m3u8')) {
        getSignedUrl(videoData);
      } else {
        setVideo(videoData);
        setLoading(false);
      }
    }
  }, [videoId]);

  async function getSignedUrl(videoData) {
    try {
      setLoading(true);
      const response = await fetch(`${process.env.EXPO_PUBLIC_SERVER_URL}/api/recording/livestreams/${videoData.id}/play`);
      const data = await response.json();
      if (data.signedUrl) {
        setVideo({ ...videoData, video_url: data.signedUrl });
      } else {
        setVideo(videoData);
      }
    } catch (e) {
      console.error('[VideoDetail] Signed URL error:', e);
      setVideo(videoData); // fallback to original URL
    } finally {
      setLoading(false);
    }
  }

  async function fetchVideoById(id) {
    try {
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
        setVideo(null);
        setLoading(false);
        return;
      }
      
      // Fetch profile separately (no FK join)
      let profileData = null;
      if (videoData.user_id) {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id, username, avatar_url')
          .eq('id', videoData.user_id)
          .single();
          
        if (!profileError && profile) {
          profileData = profile;
        }
      }
      
      // Combine them
      const combined = {
        ...videoData,
        profiles: profileData || { username: 'Unknown' }
      };
      
      setVideo(combined);
      
    } catch (error) {
      console.error('[VideoDetail] Fetch error:', error.message);
      setVideo(null);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.gold} size="large" />
      </View>
    );
  }

  if (error || !video) {
    return (
      <View style={styles.center}>
        <Text style={{ color: '#fff', fontSize: 16 }}>Video not found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <SystemBars style="light" />
      <TouchableOpacity
        onPress={navigation.goBack}
        style={[styles.backBtn, { top: insets.top + 8 }]}
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
  backBtn: { position: 'absolute', top: 48, left: 16, zIndex: 99 }, // top overridden inline with insets
  backText: { color: '#fff', fontSize: 28, fontWeight: '700' },
});