import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Image, ActivityIndicator, RefreshControl,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { SystemBars } from 'react-native-edge-to-edge';
import { supabase } from '../lib/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';
import { ROUTES } from '../constants/routes';
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
      const entry = SystemBars.pushStackEntry({ style: 'dark' });
      return () => SystemBars.popStackEntry(entry);
    }, [])
  );

  useEffect(() => {
    if (currentUserId !== null) loadUsers();
  }, [currentUserId]);

  const loadUsers = async () => {
    try {
      let profileIds = [];

      // Get blocked users list
      const { data: blockedUsers } = await supabase
        .from('blocks')
        .select('blocked_id')
        .eq('blocker_id', currentUserId);
      const blockedIds = blockedUsers?.map(b => b.blocked_id) ?? [];

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

      // Exclude blocked users
      if (blockedIds.length > 0) {
        profileIds = profileIds.filter(id => !blockedIds.includes(id));
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

  const handleNavigateUserProfile = useCallback((profileUserId) => {
    navigation.navigate(ROUTES.USER_PROFILE, { profileUserId });
  }, [navigation]);

  return (
    <View style={styles.container}>


      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={navigation.goBack} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Back</Text>
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
              onPress={() => handleNavigateUserProfile(item.id)}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={COLORS.gold}
              colors={[COLORS.gold]}
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
    backgroundColor: '#ffffff',
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
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  backBtn: {
    padding: 4,
    width: 60,
  },
  backBtnText: {
    color: '#1a2e44',
    fontSize: 15,
    fontWeight: '600',
  },
  headerTitle: {
    color: '#1a2e44',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: '#ffffff',
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#f1f5f9',
  },
  avatarFallback: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#B76E79',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '700',
  },
  userInfo: {
    flex: 1,
    marginLeft: 14,
  },
  displayName: {
    color: '#1a2e44',
    fontSize: 15,
    fontWeight: '700',
  },
  username: {
    color: '#94a3b8',
    fontSize: 13,
    marginTop: 2,
    fontWeight: '500',
  },
  followBtn: {
    backgroundColor: COLORS.gold,
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 18,
    alignItems: 'center',
    minHeight: 36,
    justifyContent: 'center',
    shadowColor: COLORS.gold,
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  followingBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: COLORS.gold,
    shadowOpacity: 0,
    elevation: 0,
  },
  followBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  followingBtnText: {
    color: COLORS.gold,
  },
  separator: {
    height: 1,
    backgroundColor: '#f1f5f9',
    marginLeft: 84,
  },
  emptyIcon: {
    fontSize: 52,
  },
  emptyText: {
    color: '#94a3b8',
    fontSize: 15,
    fontWeight: '600',
  },
});