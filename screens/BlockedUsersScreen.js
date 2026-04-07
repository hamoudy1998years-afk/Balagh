import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Image,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useUser } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { COLORS } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';

export default function BlockedUsersScreen({ navigation }) {
  console.log('>>> BlockedUsersScreen RENDER TRIGGERED');
  
  const insets = useSafeAreaInsets();
  const { user, unblockUser } = useUser();
  console.log('👤 user?.id:', user?.id || 'UNDEFINED');
  const [blockedList, setBlockedList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchBlockedUsers = useCallback(async () => {
    console.log('🚀 FETCH BLOCKED USERS STARTED');
    console.log('👤 user?.id:', user?.id);
    
    if (!user?.id) {
      console.log('❌ ERROR: No user ID, cannot fetch');
      setLoading(false);
      return;
    }
    
    console.log('🔍 Fetching blocked users for:', user.id);
    
    try {
      // Step 1: Get blocked user IDs
      console.log('📡 Querying Supabase for blocked_users...');
      const { data: blockedData, error: blockedError } = await supabase
        .from('blocked_users')
        .select('blocked_id')
        .eq('blocker_id', user.id);
      
      console.log('✅ Supabase query executed');
      console.log('📦 blockedData:', JSON.stringify(blockedData));
      console.log('❌ blockedError:', blockedError);
        
      if (blockedError) throw blockedError;
      
      if (!blockedData || blockedData.length === 0) {
        setBlockedList([]);
        return;
      }
      
      const blockedIds = blockedData.map(b => b.blocked_id);
      console.log('🔍 Found blocked IDs:', blockedIds);
      
      if (blockedIds.length === 0) {
        console.log('📭 No blocked IDs found in database');
        setBlockedList([]);
        setLoading(false);
        return;
      }
      
      // Step 2: Get profiles for those users
      const { data: profilesData, error: profilesError } = await supabase
        .from('profiles')
        .select('id, username, avatar_url')
        .in('id', blockedIds);
      
      console.log('👤 Profiles data:', profilesData);
      console.log('❌ Profiles error:', profilesError);
        
      if (profilesError) throw profilesError;
      
      console.log('👤 Found profiles:', profilesData);
      
      // Step 3: Combine data
      const combined = blockedIds.map(blockedId => {
        const profile = profilesData?.find(p => p.id === blockedId);
        console.log('🔄 Combining for ID:', blockedId, 'found profile:', profile);
        return {
          blocked_id: blockedId,
          profiles: profile || { username: 'Unknown User', avatar_url: null }
        };
      });
      
      console.log('📋 Combined list:', combined);
      
      setBlockedList(combined);
    } catch (err) {
      console.error('💥 CRITICAL ERROR:', err);
      console.error('📋 Error stack:', err.stack);
      Alert.alert('Error', 'Failed to load blocked users: ' + err.message);
    } finally {
      console.log('🏁 Fetch completed, setting loading false');
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  // Initial mount fetch
  useEffect(() => {
    console.log('⚡ useEffect running (initial mount), user?.id:', user?.id);
    fetchBlockedUsers();
  }, [user?.id, fetchBlockedUsers]);

  // Refetch when screen comes into focus (handles navigation caching)
  useFocusEffect(
    useCallback(() => {
      console.log('👁️ useFocusEffect TRIGGERED - screen focused');
      fetchBlockedUsers();
    }, [fetchBlockedUsers])
  );

  const handleUnblock = (blockedUser) => {
    Alert.alert(
      'Unblock User',
      `Are you sure you want to unblock ${blockedUser.profiles?.username || 'this user'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          style: 'destructive',
          onPress: async () => {
            try {
              await unblockUser(blockedUser.blocked_id);
              // Refresh the list
              fetchBlockedUsers();
            } catch (err) {
              console.error('Failed to unblock:', err);
              Alert.alert('Error', 'Failed to unblock user');
            }
          }
        }
      ]
    );
  };

  const renderItem = ({ item }) => (
    <View style={styles.userItem}>
      <View style={styles.userInfo}>
        {item.profiles?.avatar_url ? (
          <Image source={{ uri: item.profiles.avatar_url }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Ionicons name="person" size={24} color="#64748b" />
          </View>
        )}
        <Text style={styles.username}>@{item.profiles?.username || 'unknown'}</Text>
      </View>
      <TouchableOpacity 
        style={styles.unblockButton}
        onPress={() => handleUnblock(item)}
      >
        <Text style={styles.unblockText}>Unblock</Text>
      </TouchableOpacity>
    </View>
  );

  console.log('🎨 Rendering with blockedList:', blockedList);
  console.log('⏳ Loading state:', loading);

  if (loading) {
    console.log('⏳ Showing loading spinner');
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <ActivityIndicator color={COLORS.gold} size="large" />
        <Text style={{marginTop: 10, color: '#1a2e44'}}>Loading blocked users...</Text>
      </View>
    );
  }

  console.log('🔍 Checking empty state, length:', blockedList.length);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#1a2e44" />
        </TouchableOpacity>
        <Text style={styles.title}>Blocked Users</Text>
        <View style={{ width: 40 }} />
      </View>

      {blockedList.length === 0 ? (
        console.log('📭 Showing empty state, blockedList:', blockedList),
        <View style={styles.emptyState}>
          <Ionicons name="shield-checkmark" size={64} color={COLORS.gold} />
          <Text style={styles.emptyText}>No blocked users</Text>
          <Text style={styles.emptySubtext}>
            Users you block will appear here
          </Text>
        </View>
      ) : (
        <FlatList
          data={blockedList}
          keyExtractor={(item) => item.blocked_id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                fetchBlockedUsers();
              }}
              tintColor={COLORS.gold}
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a2e44',
  },
  list: {
    padding: 16,
  },
  userItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    marginRight: 12,
  },
  avatarPlaceholder: {
    backgroundColor: '#f1f5f9',
    justifyContent: 'center',
    alignItems: 'center',
  },
  username: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a2e44',
  },
  unblockButton: {
    backgroundColor: '#fee2e2',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  unblockText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a2e44',
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 8,
    textAlign: 'center',
  },
});
