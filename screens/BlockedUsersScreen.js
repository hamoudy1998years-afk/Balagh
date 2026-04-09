import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import ModernDialog from './ModernDialog';
import { useUser } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { COLORS } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';

export default function BlockedUsersScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { user, unblockUser } = useUser();
  const [blockedList, setBlockedList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState({ visible: false, title: '', message: '', type: 'info', buttons: [] });

  const fetchBlockedUsers = useCallback(async () => {
    if (!user?.id) {
      setLoading(false);
      return;
    }
    
    try {
      const { data: blockedData, error: blockedError } = await supabase
        .from('blocked_users')
        .select('blocked_id')
        .eq('blocker_id', user.id);
      
      if (blockedError) throw blockedError;
      
      if (!blockedData || blockedData.length === 0) {
        setBlockedList([]);
        return;
      }
      
      const blockedIds = blockedData.map(b => b.blocked_id);
      
      if (blockedIds.length === 0) {
        setBlockedList([]);
        setLoading(false);
        return;
      }
      
      // Step 2: Get profiles for those users
      const { data: profilesData, error: profilesError } = await supabase
        .from('profiles')
        .select('id, username, avatar_url')
        .in('id', blockedIds);
      
      if (profilesError) throw profilesError;
      
      // Step 3: Combine data
      const combined = blockedIds.map(blockedId => {
        const profile = profilesData?.find(p => p.id === blockedId);
        return {
          blocked_id: blockedId,
          profiles: profile || { username: 'Unknown User', avatar_url: null }
        };
      });
      
      setBlockedList(combined);
    } catch (err) {
      setDialog({
        visible: true,
        title: 'Error',
        message: 'Failed to load blocked users: ' + err.message,
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  // Initial mount fetch
  useEffect(() => {
    fetchBlockedUsers();
  }, [user?.id, fetchBlockedUsers]);

  // Refetch when screen comes into focus (handles navigation caching)
  useFocusEffect(
    useCallback(() => {
      fetchBlockedUsers();
    }, [fetchBlockedUsers])
  );

  const handleUnblock = (blockedUser) => {
    setDialog({
      visible: true,
      title: 'Unblock User',
      message: `Are you sure you want to unblock ${blockedUser.profiles?.username || 'this user'}?`,
      type: 'warning',
      buttons: [
        { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
        {
          text: 'Unblock',
          style: 'destructive',
          onPress: async () => {
            setDialog(d => ({ ...d, visible: false }));
            try {
              await unblockUser(blockedUser.blocked_id);
              fetchBlockedUsers();
            } catch (err) {
              console.error('Failed to unblock:', err);
              setDialog({
                visible: true,
                title: 'Error',
                message: 'Failed to unblock user',
                type: 'error',
                buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
              });
            }
          }
        }
      ]
    });
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

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <ActivityIndicator color={COLORS.gold} size="large" />
        <Text style={{marginTop: 10, color: '#1a2e44'}}>Loading blocked users...</Text>
      </View>
    );
  }

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

      <ModernDialog
        visible={dialog.visible}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        buttons={dialog.buttons}
        onDismiss={() => setDialog({ ...dialog, visible: false })}
      />
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
