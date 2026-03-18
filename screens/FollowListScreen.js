import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Image, ActivityIndicator, RefreshControl, StatusBar,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';
import { useUser } from '../context/UserContext';

// ─── Single user row ──────────────────────────────────────────────────────────
function UserRow({ item, onPress, currentUserId, isViewingOwnList }) {
  const [following, setFollowing] = useState(item.isFollowing ?? false);
  const isOwnAccount = item.id === currentUserId;

  async function handleFollow() {
    if (isOwnAccount) return;
    if (following) {
      setFollowing(false);
      const { error } = await supabase.from('follows').delete()
        .eq('follower_id', currentUserId)
        .eq('following_id', item.id);
      if (error) setFollowing(true);
    } else {
      setFollowing(true);
      const { error } = await supabase.from('follows').insert({
        follower_id: currentUserId,
        following_id: item.id,
      });
      if (error) setFollowing(false);
    }
  }

  const letter = item.username?.[0]?.toUpperCase() ?? '?';

  return (
    <TouchableOpacity style={styles.userRow} onPress={onPress} activeOpacity={0.7}>
      {item.avatar_url ? (
        <Image source={{ uri: item.avatar_url, cache: 'force-cache', headers: { 'Cache-Control': 'max-age=86400' } }} style={styles.avatar} />
      ) : (
        <View style={styles.avatarFallback}>
          <Text style={styles.avatarLetter}>{letter}</Text>
        </View>
      )}

      <View style={styles.userInfo}>
        <Text style={styles.displayName}>
          {item.full_name || item.username || 'User'}
        </Text>
        <Text style={styles.username}>@{item.username || 'username'}</Text>
      </View>

      {/* ✅ FIXED: hide follow button on own account AND when viewing your own list */}
      {!isOwnAccount && (
        <TouchableOpacity
          style={[styles.followBtn, following && styles.followingBtn]}
          onPress={handleFollow}
        >
          <Text style={[styles.followBtnText, following && styles.followingBtnText]}>
            {following ? 'Following' : 'Follow'}
          </Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function FollowListScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { userId, type, username } = route.params ?? {};

  const [users,         setUsers]         = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const { user: authUser } = useUser();
  const currentUserId = authUser?.id ?? null;
  const flatListRef = useRef(null);

  useFocusEffect(
    useCallback(() => {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    }, [])
  );

  useEffect(() => {
    if (currentUserId !== null) loadUsers();
  }, [currentUserId]);

  const loadUsers = async () => {
    try {
      let profileIds = [];

      if (type === 'followers') {
        const { data } = await supabase
          .from('follows')
          .select('follower_id')
          .eq('following_id', userId);
        profileIds = (data ?? []).map(row => row.follower_id);
      } else {
        const { data } = await supabase
          .from('follows')
          .select('following_id')
          .eq('follower_id', userId);
        profileIds = (data ?? []).map(row => row.following_id);
      }

      if (profileIds.length === 0) {
        setUsers([]);
        setLoading(false);
        return;
      }

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, full_name, avatar_url')
        .in('id', profileIds);

      const list = profiles ?? [];

      if (currentUserId && list.length > 0) {
        const { data: myFollows } = await supabase
          .from('follows')
          .select('following_id')
          .eq('follower_id', currentUserId);
        const myFollowIds = new Set((myFollows ?? []).map(f => f.following_id));
        list.forEach(u => u.isFollowing = myFollowIds.has(u.id));
      }

      setUsers(list);
    } catch (e) {
      __DEV__ && console.error('Error loading follow list:', e);
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadUsers();
    setRefreshing(false);
  }, [currentUserId]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f0f0f" />

      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {username ? `@${username}'s ${type === 'followers' ? 'Followers' : 'Following'}` : (type === 'followers' ? 'Followers' : 'Following')}
        </Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.gold} />
        </View>
      ) : (
        <FlashList
          ref={flatListRef}
          data={users}
          keyExtractor={(item) => item.id}
          estimatedItemSize={74}
          renderItem={({ item }) => (
            <UserRow
              item={item}
              currentUserId={currentUserId}
              isViewingOwnList={userId === currentUserId}
              onPress={() => navigation.navigate('UserProfile', { profileUserId: item.id })}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#7c3aed"
              colors={['#7c3aed']}
            />
          }
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyIcon}>
                {type === 'followers' ? '👥' : '🔍'}
              </Text>
              <Text style={styles.emptyText}>
                {type === 'followers' ? 'No followers yet' : 'Not following anyone yet'}
              </Text>
            </View>
          }
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 20, flexGrow: 1 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 60,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
  },
  backBtn: { padding: 4, width: 40 },
  backBtnText: { color: '#fff', fontSize: 24, fontWeight: '700' },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#2a2a2a',
  },
  avatarFallback: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#7c3aed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  userInfo: {
    flex: 1,
    marginLeft: 12,
  },
  displayName: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  username: {
    color: '#64748b',
    fontSize: 13,
    marginTop: 2,
  },
  followBtn: {
    backgroundColor: COLORS.gold,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 16,
    alignItems: 'center',
    minHeight: 36,
    justifyContent: 'center',
  },
  followingBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: COLORS.gold,
  },
  followBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  followingBtnText: {
    color: COLORS.goldDark,
  },
  separator: {
    height: 1,
    backgroundColor: '#1e1e1e',
    marginLeft: 78,
  },
  emptyIcon: { fontSize: 48 },
  emptyText: {
    color: '#64748b',
    fontSize: 15,
    fontWeight: '600',
  },
});