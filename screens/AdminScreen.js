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
import { SystemBars } from 'react-native-edge-to-edge';
import { useFocusEffect } from '@react-navigation/native';

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

      console.log('DEBUG - Reports fetched:', reportsData);
      console.log('DEBUG - Reports count:', reportsData?.length);
      console.log('DEBUG - Reports error:', reportsError);

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
      const { error } = await supabase
        .from('reports')
        .delete()
        .eq('id', reportId);

      if (error) {
        console.error('Dismiss error:', error);
        Alert.alert('Error', 'Failed to dismiss report: ' + error.message);
        return;
      }

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
          <Text style={styles.dismissText}>Dismiss</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.button, styles.banButton]}
          onPress={() => handleBanUser(item.reported_user_id, item.id)}
        >
          <Text style={styles.banText}>Ban User</Text>
        </TouchableOpacity>

        {item.video_id && (
          <TouchableOpacity 
            style={[styles.button, styles.deleteButton]}
            onPress={() => handleDeleteVideo(item.video_id, item.id)}
          >
            <Text style={styles.deleteText}>Delete Video</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  useFocusEffect(
    useCallback(() => {
      const entry = SystemBars.pushStackEntry({ style: 'light' });
      return () => SystemBars.popStackEntry(entry);
    }, [])
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
    backgroundColor: '#ffffff',
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#1a2e44',
    padding: 20,
    paddingBottom: 4,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: '#94a3b8',
    fontWeight: '600',
    paddingHorizontal: 20,
    marginBottom: 16,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  list: {
    padding: 16,
    paddingBottom: 40,
  },
  reportCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#f1f5f9',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  reportHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  userInfo: {
    flex: 1,
  },
  reportedUserInfo: {
    marginBottom: 12,
    padding: 12,
    backgroundColor: '#fff7ed',
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#f97316',
  },
  label: {
    fontSize: 11,
    color: '#94a3b8',
    marginBottom: 3,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  username: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1a2e44',
  },
  date: {
    fontSize: 12,
    color: '#94a3b8',
    fontWeight: '500',
  },
  reasonContainer: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  reason: {
    fontSize: 14,
    color: '#475569',
    fontWeight: '500',
    lineHeight: 20,
  },
  videoInfo: {
    marginBottom: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  thumbnail: {
    width: '100%',
    height: 150,
    borderRadius: 10,
    marginTop: 8,
    marginBottom: 8,
    backgroundColor: '#e2e8f0',
  },
  caption: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  button: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissButton: {
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  banButton: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  deleteButton: {
    backgroundColor: '#fff7ed',
    borderWidth: 1,
    borderColor: '#fed7aa',
  },
  buttonText: {
    fontWeight: '700',
    fontSize: 12,
    color: '#1a2e44',
  },
  empty: {
    textAlign: 'center',
    color: '#94a3b8',
    fontSize: 16,
    marginTop: 60,
    fontWeight: '600',
  },
  dismissText: {
    fontWeight: '700',
    fontSize: 12,
    color: '#64748b',
  },
  banText: {
    fontWeight: '700',
    fontSize: 12,
    color: '#dc2626',
  },
  deleteText: {
    fontWeight: '700',
    fontSize: 12,
    color: '#ea580c',
  },
});
