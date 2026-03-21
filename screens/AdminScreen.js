import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Image,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useUser } from '../context/UserContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { s, ms } from '../utils/responsive';
import { COLORS } from '../constants/theme';
import { StatusBar } from 'expo-status-bar';

// Admin user ID from environment variable
const ADMIN_USER_ID = process.env.EXPO_PUBLIC_ADMIN_USER_ID; 

export default function AdminScreen({ navigation }) {
  const { user: authUser } = useUser();
  const insets = useSafeAreaInsets();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Check if current user is admin
  useEffect(() => {
    if (authUser?.id !== ADMIN_USER_ID) {
      Alert.alert('Access Denied', 'You do not have admin privileges.');
      navigation.goBack();
    }
  }, [authUser]);

  const loadReports = useCallback(async () => {
    try {
      // Simple query without foreign key joins
      const { data: reportsData, error: reportsError } = await supabase
        .from('reports')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (reportsError) throw reportsError;
      
      // Fetch reporter and reported user info separately
      const enrichedReports = await Promise.all((reportsData || []).map(async (report) => {
        // Get reporter username
        const { data: reporter } = await supabase
          .from('profiles')
          .select('username')
          .eq('id', report.reporter_id)
          .single();
          
        // Get reported user username  
        const { data: reportedUser } = await supabase
          .from('profiles')
          .select('username')
          .eq('id', report.reported_user_id)
          .single();
          
        // Get video info if exists
        let video = null;
        if (report.video_id) {
          const { data: videoData } = await supabase
            .from('videos')
            .select('id, caption, thumbnail_url, video_url')
            .eq('id', report.video_id)
            .single();
          video = videoData;
        }
        
        return {
          ...report,
          reporter: reporter || { username: 'Unknown' },
          reported_user: reportedUser || { username: 'Unknown' },
          video
        };
      }));

      setReports(enrichedReports);
    } catch (error) {
      console.error('Error loading reports:', error);
      Alert.alert('Error', 'Failed to load reports');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const handleDismiss = async (reportId) => {
    try {
      await supabase.from('reports').delete().eq('id', reportId);
      setReports(prev => prev.filter(r => r.id !== reportId));
      Alert.alert('Success', 'Report dismissed');
    } catch (error) {
      Alert.alert('Error', 'Failed to dismiss report');
    }
  };

  const handleBanUser = async (userId, reportId) => {
    Alert.alert(
      'Ban User',
      'Are you sure you want to ban this user?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Ban',
          style: 'destructive',
          onPress: async () => {
            try {
              // Add to banned_users table
              await supabase.from('banned_users').insert({
                user_id: userId,
                banned_by: authUser.id,
                reason: 'Violation of community guidelines'
              });
              
              // Dismiss report
              await supabase.from('reports').delete().eq('id', reportId);
              setReports(prev => prev.filter(r => r.id !== reportId));
              Alert.alert('Success', 'User banned');
            } catch (error) {
              Alert.alert('Error', 'Failed to ban user');
            }
          }
        }
      ]
    );
  };

  const handleDeleteVideo = async (videoId, reportId) => {
    Alert.alert(
      'Delete Video',
      'Are you sure you want to delete this video?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await supabase.from('videos').delete().eq('id', videoId);
              await supabase.from('reports').delete().eq('id', reportId);
              setReports(prev => prev.filter(r => r.id !== reportId));
              Alert.alert('Success', 'Video deleted');
            } catch (error) {
              Alert.alert('Error', 'Failed to delete video');
            }
          }
        }
      ]
    );
  };

  const renderReport = ({ item }) => (
    <View style={styles.reportCard}>
      <View style={styles.reportHeader}>
        <View style={styles.userInfo}>
          <Text style={styles.label}>Reported by:</Text>
          <Text style={styles.username}>@{item.reporter?.username || 'Unknown'}</Text>
        </View>
        <Text style={styles.date}>
          {new Date(item.created_at).toLocaleDateString()}
        </Text>
      </View>

      <View style={styles.reportedUserInfo}>
        <Text style={styles.label}>Reported User:</Text>
        <Text style={styles.username}>@{item.reported_user?.username || 'Unknown'}</Text>
      </View>

      <View style={styles.reasonContainer}>
        <Text style={styles.label}>Reason:</Text>
        <Text style={styles.reason}>{item.reason}</Text>
      </View>

      {item.video && (
        <View style={styles.videoInfo}>
          <Text style={styles.label}>Video:</Text>
          {item.video.thumbnail_url && (
            <Image 
              source={{ uri: item.video.thumbnail_url }} 
              style={styles.thumbnail}
            />
          )}
          <Text style={styles.caption} numberOfLines={2}>
            {item.video.caption || 'No caption'}
          </Text>
        </View>
      )}

      <View style={styles.actions}>
        <TouchableOpacity 
          style={[styles.button, styles.dismissButton]}
          onPress={() => handleDismiss(item.id)}
        >
          <Text style={styles.buttonText}>Dismiss</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.button, styles.banButton]}
          onPress={() => handleBanUser(item.reported_user_id, item.id)}
        >
          <Text style={styles.buttonText}>Ban User</Text>
        </TouchableOpacity>

        {item.video_id && (
          <TouchableOpacity 
            style={[styles.button, styles.deleteButton]}
            onPress={() => handleDeleteVideo(item.video_id, item.id)}
          >
            <Text style={styles.buttonText}>Delete Video</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color={COLORS.gold} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar style="light" backgroundColor="transparent" translucent />
      <Text style={styles.title}>Admin Panel - Reports</Text>
      <Text style={styles.subtitle}>{reports.length} pending reports</Text>
      
      <FlatList
        data={reports}
        renderItem={renderReport}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          loadReports();
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>No reports to review</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgDark,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: ms(24),
    fontWeight: 'bold',
    color: COLORS.textWhite,
    padding: s(16),
    paddingBottom: s(8),
  },
  subtitle: {
    fontSize: ms(14),
    color: '#ffffff',
    paddingHorizontal: s(16),
    marginBottom: s(16),
  },
  list: {
    padding: s(16),
  },
  reportCard: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    padding: s(16),
    marginBottom: s(12),
    borderWidth: 1,
    borderColor: '#2d2d44',
  },
  reportHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: s(12),
  },
  userInfo: {
    flex: 1,
  },
  reportedUserInfo: {
    marginBottom: s(12),
  },
  label: {
    fontSize: ms(12),
    color: COLORS.textSecondary,
    marginBottom: 2,
  },
  username: {
    fontSize: ms(16),
    fontWeight: '600',
    color: COLORS.textWhite,
  },
  date: {
    fontSize: ms(12),
    color: COLORS.textSecondary,
  },
  reasonContainer: {
    backgroundColor: '#2d2d44',
    borderRadius: 8,
    padding: s(12),
    marginBottom: s(12),
  },
  reason: {
    fontSize: ms(14),
    color: COLORS.textWhite,
    fontWeight: '500',
  },
  videoInfo: {
    marginBottom: s(12),
  },
  thumbnail: {
    width: '100%',
    height: s(150),
    borderRadius: 8,
    marginTop: s(8),
    marginBottom: s(8),
    backgroundColor: '#2d2d44',
  },
  caption: {
    fontSize: ms(13),
    color: COLORS.textSecondary,
  },
  actions: {
    flexDirection: 'row',
    gap: s(8),
    marginTop: s(8),
  },
  button: {
    flex: 1,
    paddingVertical: s(10),
    borderRadius: 8,
    alignItems: 'center',
  },
  dismissButton: {
    backgroundColor: '#4a5568',
  },
  banButton: {
    backgroundColor: '#dc2626',
  },
  deleteButton: {
    backgroundColor: '#7c3aed',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: ms(12),
  },
  empty: {
    textAlign: 'center',
    color: '#ffffff',
    fontSize: ms(16),
    marginTop: s(40),
  },
});
