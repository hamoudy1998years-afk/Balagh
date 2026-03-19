import React, { useEffect, useState } from 'react';
import { View, FlatList, RefreshControl, Dimensions } from 'react-native';
import { supabase } from '../lib/supabase';
import LiveVideoCard from '../components/LiveVideoCard';
import { ROUTES } from '../constants/routes';

const { width } = Dimensions.get('window');
const numColumns = 2;

export default function LiveFeedScreen({ navigation }) {
  const [streams, setStreams] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

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
      <View style={{ flex: 1, backgroundColor: '#000' }}>
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={fetchStreams} tintColor="#7c3aed" />}
        />
      </View>
    );
  }