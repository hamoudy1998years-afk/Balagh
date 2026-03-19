import { View, Text, StyleSheet, TextInput, FlatList, ActivityIndicator, Image, ScrollView, useWindowDimensions } from 'react-native';
import { useState, useRef, useCallback } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { COLORS } from '../constants/theme';
import { ROUTES } from '../constants/routes';
import { useUser } from '../context/UserContext';

const CATEGORIES = ['All', 'Quran', 'Hadith', 'Reminder', 'Lecture', 'Nasheeds', 'Dua', 'Other'];

function formatCount(n) {
  if (!n || n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function ProfileCard({ profile, isFollowing, onFollowToggle, onPress, currentUserId }) {
  const letter = profile.username?.[0]?.toUpperCase() ?? '?';
  return (
    <View style={styles.profileCard}>
      <AnimatedButton style={styles.profileCardLeft} onPress={onPress}>
        {profile.avatar_url ? (
          <Image
            source={{ uri: profile.avatar_url, cache: 'force-cache' }}
            style={styles.profileAvatar}
          />
        ) : (
          <View style={[styles.profileAvatar, styles.profileAvatarFallback]}>
            <Text style={styles.profileAvatarLetter}>{letter}</Text>
          </View>
        )}
        <View style={styles.profileInfo}>
          <Text style={styles.profileUsername} numberOfLines={1}>{profile.username}</Text>
          {profile.full_name ? (
            <Text style={styles.profileFullName} numberOfLines={1}>{profile.full_name}</Text>
          ) : null}
          <Text style={styles.profileFollowers}>{formatCount(profile.followerCount)} followers</Text>
        </View>
      </AnimatedButton>
      {profile.id !== currentUserId && (
        <AnimatedButton
          style={[styles.profileFollowBtn, isFollowing && styles.profileFollowingBtn]}
          onPress={onFollowToggle}
        >
          <Text style={[styles.profileFollowBtnText, isFollowing && styles.profileFollowingBtnText]}>
            {isFollowing ? 'Following' : 'Follow'}
          </Text>
        </AnimatedButton>
      )}
    </View>
  );
}

export default function SearchScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [profileResults, setProfileResults] = useState([]);
  const [videoResults, setVideoResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const { user: authUser } = useUser();
  const currentUserId = authUser?.id ?? null;
  const [followingIds, setFollowingIds] = useState(new Set());
  const scrollRef = useRef(null);
  const searchTimeout = useRef(null);

  const ITEM_SIZE = (width - 2) / 3;

  useFocusEffect(
    useCallback(() => {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [])
  );

  const handleSearch = useCallback((text) => {
    setQuery(text);
    if (text.trim().length < 2) {
      setProfileResults([]);
      setVideoResults([]);
      return;
    }
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(async () => {
      setLoading(true);
      const sanitized = text.replace(/[%_\\]/g, '\\$&').trim();

      let captionQuery = supabase.from('videos').select('*').ilike('caption', `%${sanitized}%`);
      if (selectedCategory !== 'All') captionQuery = captionQuery.eq('category', selectedCategory);

      const [
        { data: captionVideos, error: captionError },
        { data: matchedProfiles, error: profileError },
      ] = await Promise.all([
        captionQuery.limit(30),
        supabase
          .from('profiles')
          .select('id, username, avatar_url, full_name')
          .or(`username.ilike.%${sanitized}%,full_name.ilike.%${sanitized}%`)
          .limit(10),
      ]);

      if (captionError) {
        __DEV__ && console.warn('Search error:', captionError.message);
        setProfileResults([]);
        setVideoResults([]);
        setLoading(false);
        return;
      }

      let profiles = [];
      let combined = captionVideos ?? [];

      if (!profileError && matchedProfiles?.length > 0) {
        const profileIds = matchedProfiles.map(p => p.id);

        let profileVideoQuery = supabase.from('videos').select('*').in('user_id', profileIds);
        if (selectedCategory !== 'All') profileVideoQuery = profileVideoQuery.eq('category', selectedCategory);

        const parallelQueries = [
          supabase.from('follows').select('following_id').in('following_id', profileIds),
          profileVideoQuery.limit(30),
        ];
        if (currentUserId) {
          parallelQueries.push(
            supabase.from('follows').select('following_id')
              .eq('follower_id', currentUserId)
              .in('following_id', profileIds)
          );
        }

        const queryResults = await Promise.all(parallelQueries);
        const { data: followerRows } = queryResults[0];
        const { data: profileVideos } = queryResults[1];
        const followData = currentUserId ? (queryResults[2]?.data ?? []) : [];

        // Build follower count per profile
        const followerCountMap = {};
        (followerRows ?? []).forEach(row => {
          followerCountMap[row.following_id] = (followerCountMap[row.following_id] ?? 0) + 1;
        });

        profiles = matchedProfiles.map(p => ({
          ...p,
          followerCount: followerCountMap[p.id] ?? 0,
        }));

        setFollowingIds(new Set(followData.map(r => r.following_id)));

        // Merge profile videos, deduplicate by id
        if (profileVideos?.length > 0) {
          const seen = new Set(combined.map(v => v.id));
          for (const v of profileVideos) {
            if (!seen.has(v.id)) { combined.push(v); seen.add(v.id); }
          }
        }
      }

      setProfileResults(profiles);
      setVideoResults(combined.slice(0, 30));
      setLoading(false);
    }, 400);
  }, [selectedCategory, currentUserId]);

  const handleFollowToggle = useCallback(async (profile) => {
    if (!currentUserId) {
      navigation.navigate(ROUTES.LOGIN);
      return;
    }
    const isFollowing = followingIds.has(profile.id);

    // Optimistic update
    setFollowingIds(prev => {
      const next = new Set(prev);
      if (isFollowing) next.delete(profile.id); else next.add(profile.id);
      return next;
    });
    setProfileResults(prev => prev.map(p =>
      p.id === profile.id
        ? { ...p, followerCount: isFollowing ? Math.max(0, p.followerCount - 1) : p.followerCount + 1 }
        : p
    ));

    if (isFollowing) {
      await supabase.from('follows').delete()
        .eq('follower_id', currentUserId)
        .eq('following_id', profile.id);
    } else {
      await supabase.from('follows').insert({
        follower_id: currentUserId,
        following_id: profile.id,
      });
    }
  }, [currentUserId, followingIds]);

  const handleCategory = useCallback(async (cat) => {
    setSelectedCategory(cat);
    setProfileResults([]);
    setLoading(true);
    if (cat === 'All') {
      const { data, error } = await supabase.from('videos').select('*').limit(30);
      if (error) { __DEV__ && console.warn('Category error:', error.message); setVideoResults([]); setLoading(false); return; }
      setVideoResults(data ?? []);
    } else {
      const { data } = await supabase.from('videos').select('*').eq('category', cat).limit(30);
      setVideoResults(data ?? []);
    }
    setLoading(false);
  }, []);

  const hasResults = profileResults.length > 0 || videoResults.length > 0;

  const handleClearSearch = useCallback(() => {
    setQuery('');
    setProfileResults([]);
    setVideoResults([]);
  }, []);

  const handleCategoryPress = useCallback((item) => {
    handleCategory(item);
  }, [handleCategory]);

  const handleNavigateUserProfile = useCallback((profileUserId) => {
    navigation.navigate(ROUTES.USER_PROFILE, { profileUserId });
  }, [navigation]);

  const handleNavigateVideoDetail = useCallback((videoId) => {
    navigation.navigate(ROUTES.VIDEO_DETAIL, { videoId });
  }, [navigation]);

  return (
    <View style={styles.container}>
      {/* Fixed header — never affected by content below */}
      <View style={styles.header}>
        <Text style={[styles.title, { paddingTop: insets.top + 16 }]}>Search</Text>

        <View style={styles.searchBar}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search videos, scholars..."
            placeholderTextColor="#aaaaaa"
            value={query}
            onChangeText={handleSearch}
          />
          {query.length > 0 && (
            <AnimatedButton onPress={handleClearSearch}>
              <Text style={styles.clearBtn}>✕</Text>
            </AnimatedButton>
          )}
        </View>

        <FlatList
          data={CATEGORIES}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(item) => item}
          style={styles.categoryList}
          contentContainerStyle={styles.categoryListContent}
          renderItem={({ item }) => (
            <AnimatedButton
              style={[styles.categoryChip, selectedCategory === item && styles.categoryChipActive]}
              onPress={() => handleCategoryPress(item)}
            >
              <Text style={[styles.categoryChipText, selectedCategory === item && styles.categoryChipTextActive]}>{item}</Text>
            </AnimatedButton>
          )}
        />
      </View>

      {/* Content area — takes all remaining space */}
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator color={COLORS.gold} size="large" style={styles.loader} />
        ) : !hasResults ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🕌</Text>
            <Text style={styles.emptyText}>{query.length > 0 ? 'No results found' : 'Search for Islamic content'}</Text>
            <Text style={styles.emptySubtext}>{query.length > 0 ? 'Try different keywords' : 'or browse by category above'}</Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
          {profileResults.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>People</Text>
              {profileResults.map(profile => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  isFollowing={followingIds.has(profile.id)}
                  onFollowToggle={handleFollowToggle}
                  onPress={() => handleNavigateUserProfile(profile.id)}
                  currentUserId={currentUserId}
                />
              ))}
            </View>
          )}

          {videoResults.length > 0 && (
            <View style={styles.section}>
              {profileResults.length > 0 && <Text style={styles.sectionHeader}>Videos</Text>}
              <View style={styles.videoGrid}>
                {videoResults.map(item => (
                  <AnimatedButton
                    key={item.id}
                    onPress={() => handleNavigateVideoDetail(item.id)}
                    style={[styles.gridItem, { width: ITEM_SIZE, height: ITEM_SIZE * 1.3 }]}
                  >
                    <Image
                      source={{ uri: item.thumbnail_url || item.video_url, cache: 'force-cache', headers: { 'Cache-Control': 'max-age=86400' } }}
                      style={styles.gridThumb}
                      resizeMode="cover"
                      defaultSource={require('../assets/placeholder.png')}
                    />
                    <View style={styles.gridOverlay}>
                      <Text style={styles.gridViews}>▶ {item.views_count ?? 0}</Text>
                    </View>
                  </AnimatedButton>
                ))}
              </View>
            </View>
          )}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  header: { backgroundColor: '#ffffff' },
  content: { flex: 1 },
  title: { fontSize: 24, fontWeight: '700', color: '#111111', paddingHorizontal: 16, marginBottom: 16 },
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f5f5f5', borderRadius: 12, marginHorizontal: 16, paddingHorizontal: 12, marginBottom: 16, borderWidth: 0.5, borderColor: '#e5e5e5' },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, color: '#111111', fontSize: 15, paddingVertical: 14 },
  clearBtn: { color: '#aaaaaa', fontSize: 16, padding: 4 },
  categoryList: { marginBottom: 16, flexGrow: 0 },
  categoryListContent: { paddingHorizontal: 16 },
  categoryChip: { backgroundColor: '#f5f5f5', borderWidth: 0.5, borderColor: '#e5e5e5', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 },
  categoryChipActive: { backgroundColor: COLORS.gold, borderColor: COLORS.gold },
  categoryChipText: { color: '#888888', fontSize: 13, fontWeight: '600' },
  categoryChipTextActive: { color: '#ffffff' },
  loader: { marginTop: 60 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyText: { color: '#111111', fontSize: 16, fontWeight: '600', marginBottom: 6 },
  emptySubtext: { color: '#888888', fontSize: 14 },
  scrollContent: { paddingBottom: 40 },
  section: { marginBottom: 4 },
  sectionHeader: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111111',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: '#e5e5e5',
    marginBottom: 4,
  },
  // Profile card
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: '#f0f0f0',
  },
  profileCardLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  profileAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#f0f0f0' },
  profileAvatarFallback: { backgroundColor: COLORS.gold, alignItems: 'center', justifyContent: 'center' },
  profileAvatarLetter: { color: '#fff', fontSize: 20, fontWeight: '700' },
  profileInfo: { flex: 1 },
  profileUsername: { fontSize: 14, fontWeight: '700', color: '#111111' },
  profileFullName: { fontSize: 13, color: '#555555', marginTop: 1 },
  profileFollowers: { fontSize: 12, color: '#888888', marginTop: 2 },
  profileFollowBtn: {
    backgroundColor: COLORS.gold,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginLeft: 8,
    minHeight: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileFollowingBtn: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: COLORS.gold },
  profileFollowBtnText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  profileFollowingBtnText: { color: COLORS.gold },
  // Video grid
  videoGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridItem: { padding: 1, backgroundColor: '#f0f0f0' },
  gridThumb: { width: '100%', height: '100%' },
  gridOverlay: { position: 'absolute', bottom: 4, left: 4, backgroundColor: 'rgba(0,0,0,0.4)', paddingHorizontal: 4, borderRadius: 4 },
  gridViews: { color: '#fff', fontSize: 12, fontWeight: '600', textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
});
