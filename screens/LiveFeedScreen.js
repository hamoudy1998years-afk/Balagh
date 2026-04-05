import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, RefreshControl, Dimensions, ActivityIndicator, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import LiveVideoCard from '../components/LiveVideoCard';
import { ROUTES } from '../constants/routes';
import { COLORS } from '../constants/theme';

const { width } = Dimensions.get('window');
const numColumns = 2;

export default function LiveFeedScreen({ navigation }) {
  const [streams, setStreams] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
const [loading, setLoading] = useState(true);
const insets = useSafeAreaInsets();

  const fetchStreams = async () => {
    const { data } = await supabase
      .from('live_streams')
      .select('*, thumbnail_url, viewer_token, user:profiles(name, avatar)')
      .eq('is_live', true)
      .order('started_at', { ascending: false });
    
    setStreams(data || []);
    setRefreshing(false);
  };

  useEffect(() => {
    fetchStreams();
    
    // Auto-refresh every 5 seconds to remove ended streams
    const interval = setInterval(fetchStreams, 5000);
    
    const sub = supabase.channel('live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_streams' }, fetchStreams)
      .subscribe();
    
    return () => {
      sub.unsubscribe();
      clearInterval(interval);
    };
  }, []);

  return (
      <View style={styles.container}>
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={COLORS.gold} size="large" />
            <Text style={styles.loadingText}>Loading live streams...</Text>
          </View>
        ) : streams.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyIcon}>📡</Text>
            <Text style={styles.emptyTitle}>No Live Streams</Text>
            <Text style={styles.emptySubtext}>Check back later for live scholars!</Text>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
        <FlatList
          data={streams}
          numColumns={numColumns}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View style={{ width: width / numColumns - 4, margin: 4 }}>
              <LiveVideoCard 
                stream={item} 
                onPress={() => navigation.navigate(ROUTES.WATCH_LIVE, { 
                  stream: {
                    ...item,
                    viewer_token: item.viewer_token
                  } 
                })}
              />
            </View>
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={fetchStreams} tintColor={COLORS.gold} />}
        />
      </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 40,
  },
  loadingText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    fontWeight: '600',
  },
  emptyIcon: {
    fontSize: 52,
  },
  emptyTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  emptySubtext: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
});