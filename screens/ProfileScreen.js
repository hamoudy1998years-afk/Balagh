import {
  View, Text, StyleSheet, FlatList,
  Image, Dimensions, Modal, Alert,
  StatusBar, RefreshControl, Animated, Pressable, PanResponder,
} from 'react-native';
import { useState, useEffect as useEffectHook, useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import AnimatedButton from './AnimatedButton';
import { useDownload } from '../context/DownloadContext';
import { userCache } from '../utils/userCache';
import { useUser } from '../context/UserContext';

const { width } = Dimensions.get('window');
const GRID_ITEM_SIZE = (width - 3) / 3;
const downloadedVideoIds = new Set();

function formatCount(n) {
  if (!n || n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function Avatar({ uri, username, size = 90, onPress }) {
  const letter = username?.[0]?.toUpperCase() ?? '?';
  return (
    <AnimatedButton onPress={onPress}>
      {uri ? (
        <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#2a2a2a' }} />
      ) : (
        <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#7c3aed', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: size * 0.4, fontWeight: '700', color: '#fff' }}>{letter}</Text>
        </View>
      )}
    </AnimatedButton>
  );
}

// ─── Video Grid Item ──────────────────────────────────────────────────────────
function VideoGridItem({ item, onPress, onLongPress }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  function handleLongPress() {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.92, duration: 100, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
    ]).start(() => onLongPress && onLongPress(item));
  }

  return (
    <Animated.View style={[styles.gridItem, { transform: [{ scale: scaleAnim }] }]}>
      <AnimatedButton style={StyleSheet.absoluteFill} onPress={onPress} onLongPress={handleLongPress} delayLongPress={400}>
        <Image source={{ uri: item.thumbnail_url || item.video_url }} style={styles.gridThumb} resizeMode="cover" />
        <View style={styles.gridOverlay}><Text style={styles.gridPlayCount}>▶ {formatCount(item.views_count)}</Text></View>
        {item.is_pinned && <View style={styles.pinnedLabel}><Text style={styles.pinnedLabelText}>📌</Text></View>}
        {item.is_private && <View style={styles.privateLabel}><Text style={styles.privateLabelText}>🔒</Text></View>}
      </AnimatedButton>
    </Animated.View>
  );
}

// ─── Download Progress Overlay ────────────────────────────────────────────────
function DownloadProgressOverlay({ visible, progress }) {
  if (!visible) return null;
  const pct = Math.round(progress * 100);
  return (
    <View style={styles.dlOverlay} pointerEvents="none">
      <View style={styles.dlBox}>
        <Text style={styles.dlTitle}>⬇️ Downloading...</Text>
        <View style={styles.dlBarBg}><View style={[styles.dlBarFill, { width: `${pct}%` }]} /></View>
        <Text style={styles.dlPercent}>{pct}%</Text>
      </View>
    </View>
  );
}

export default function ProfileScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const targetUserId = route?.params?.profileUserId ?? null;
  const { user: globalUser, loading: userLoading } = useUser();

  useEffectHook(() => {
    if (!navigation) return;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigation.replace('Login');
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) navigation.replace('Login');
    });
    return () => subscription.unsubscribe();
  }, []);
  
  // SAFETY CHECK for context
  const downloadContext = useDownload();
  const showVideoOptionsSheet = downloadContext?.showVideoOptionsSheet;

  const [profile, setProfile] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [isOwnProfile, setIsOwnProfile] = useState(true);
  const [following, setFollowing] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [isScholar, setIsScholar] = useState(false);
  const [scholarData, setScholarData] = useState(null);
  const [activeTab, setActiveTab] = useState('videos');
  const [publicVideos, setPublicVideos] = useState([]);
  const [privateVideos, setPrivateVideos] = useState([]);
  const [likedVideos, setLikedVideos] = useState([]);
  const [totalLikes, setTotalLikes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [avatarModal, setAvatarModal] = useState(false);
  const [enlargeAvatar, setEnlargeAvatar] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  useEffectHook(() => {
    const unsubscribe = navigation.addListener('focus', async () => {
      const croppedUri = route?.params?.croppedUri;
      if (croppedUri) {
        navigation.setParams({ croppedUri: null });
        await uploadCroppedAvatar(croppedUri);
      }
    });
    return unsubscribe;
  }, [navigation, route?.params?.croppedUri]);

  useFocusEffect(
    useCallback(() => {
      if (globalUser) {
        init();
      }
    }, [globalUser])
  );

  useEffectHook(() => {
    if (globalUser && !currentUser) {
      init();
    }
  }, [globalUser, userLoading]);

  async function init() {
    setProfile(null);
    setPublicVideos([]);
    setPrivateVideos([]);
    setLikedVideos([]);
    setFollowersCount(0);
    setFollowingCount(0);
    setTotalLikes(0);
    setIsScholar(false);
    setScholarData(null);
    setFollowing(false);
    
    // STEP 1: Show global user instantly (0ms - from memory)
    if (globalUser) {
      setCurrentUser(globalUser);
      const viewingId = targetUserId ?? globalUser.id;
      const ownProfile = viewingId === globalUser.id;
      setIsOwnProfile(ownProfile);
      setLoading(false); // Show screen immediately!
      
      // Load everything in background (no await!)
      Promise.all([
        loadProfile(viewingId), 
        loadVideos(viewingId, ownProfile), 
        checkScholarStatus(viewingId)
      ]);
      
      if (!ownProfile) {
        supabase.from('follows')
          .select('id')
          .eq('follower_id', globalUser.id)
          .eq('following_id', viewingId)
          .maybeSingle()
          .then(({ data }) => setFollowing(!!data));
      } else {
        loadLikedVideos(globalUser.id);
      }
      
      return; // SKIP STEP 2 - we already have user!
    }
    
    // STEP 2: Only run if no global user (fallback)
    if (!userLoading) {
      const cachedUser = await userCache.get();
      if (cachedUser) {
        setCurrentUser(cachedUser);
        const viewingId = targetUserId ?? cachedUser.id;
        const ownProfile = viewingId === cachedUser.id;
        setIsOwnProfile(ownProfile);
        setLoading(false);
        
        Promise.all([
          loadProfile(viewingId), 
          loadVideos(viewingId, ownProfile), 
          checkScholarStatus(viewingId)
        ]);
      }
    }
  }

  async function loadProfile(userId) {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (data) {
      setProfile(data);
      const [{ count: frsCount }, { count: fngCount }] = await Promise.all([
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
      ]);
      setFollowersCount(frsCount ?? 0);
      setFollowingCount(fngCount ?? 0);
    }
  }

  async function loadVideos(userId, isOwner) {
    const { data: pub } = await supabase.from('videos').select('*').eq('user_id', userId).eq('is_private', false)
      .order('is_pinned', { ascending: false }).order('pin_order', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false });
    setPublicVideos(pub ?? []);
    setTotalLikes((pub ?? []).reduce((sum, v) => sum + (v.likes_count ?? 0), 0));
    if (isOwner) {
      const { data: priv } = await supabase.from('videos').select('*').eq('user_id', userId).eq('is_private', true).order('created_at', { ascending: false });
      setPrivateVideos(priv ?? []);
    }
  }

  async function loadLikedVideos(userId) {
    const { data } = await supabase.from('likes').select('video_id, videos(*)').eq('user_id', userId).order('created_at', { ascending: false });
    setLikedVideos(data?.map(l => l.videos).filter(Boolean) ?? []);
  }

  async function checkScholarStatus(userId) {
    const { data: profileData } = await supabase.from('profiles').select('is_scholar').eq('id', userId).single();
    const scholar = profileData?.is_scholar === true;
    setIsScholar(scholar);
    if (scholar) {
      const { data: scholarInfo } = await supabase.from('scholar_applications').select('*')
        .eq('user_id', userId)
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      setScholarData(scholarInfo);
    }
  }

  async function handleFollow() {
    if (!currentUser || isOwnProfile) return;
    if (following) {
      setFollowing(false); setFollowersCount(prev => prev - 1);
      await supabase.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', targetUserId);
    } else {
      setFollowing(true); setFollowersCount(prev => prev + 1);
      await supabase.from('follows').insert({ follower_id: currentUser.id, following_id: targetUserId });
    }
  }

  async function uploadCroppedAvatar(croppedUri) {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { Alert.alert('Error', 'Not logged in.'); return; }

      const ext = 'jpg';
      const fileName = `${user.id}_avatar.${ext}`;
      const formData = new FormData();
      formData.append('file', { uri: croppedUri, name: fileName, type: `image/${ext}` });
      const { error: uploadError } = await supabase.storage.from('avatars').upload(fileName, formData, { upsert: true });
      if (uploadError) { Alert.alert('Error', uploadError.message); return; }
      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(fileName);
      const cacheBustedUrl = `${publicUrl}?t=${Date.now()}`;
      await supabase.from('profiles').update({ avatar_url: cacheBustedUrl }).eq('id', user.id);
      setProfile(prev => ({ ...prev, avatar_url: cacheBustedUrl }));
    } catch (e) {
      Alert.alert('Error', 'Could not upload avatar. Please try again.');
      console.error('Upload error:', e);
    }
  }
      
  async function handleChangeAvatar() {
    setAvatarModal(false);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
    });
    if (result.canceled) return;
    const uri = result.assets[0].uri;
    navigation.navigate('AvatarCrop', { imageUri: uri });
  }

  async function handlePinVideo(video) {
    if (!isOwnProfile) return;
    const pinnedCount = publicVideos.filter(v => v.is_pinned).length;
    if (video.is_pinned) {
      Alert.alert('Unpin Video', 'Remove this video from pinned?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unpin', onPress: async () => { await supabase.from('videos').update({ is_pinned: false, pin_order: null }).eq('id', video.id); loadVideos(currentUser.id, true); } },
      ]);
    } else {
      if (pinnedCount >= 3) { Alert.alert('Limit Reached', 'You can only pin up to 3 videos.'); return; }
      await supabase.from('videos').update({ is_pinned: true, pin_order: pinnedCount + 1 }).eq('id', video.id);
      loadVideos(currentUser.id, true);
    }
  }

  async function handleDeleteVideo(video) {
    Alert.alert('Delete Video', 'Are you sure? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await supabase.from('videos').delete().eq('id', video.id);
        setPublicVideos(prev => prev.filter(v => v.id !== video.id));
        setPrivateVideos(prev => prev.filter(v => v.id !== video.id));
        Alert.alert('Deleted', 'Video has been deleted.');
      }},
    ]);
  }

  function handleDownloadVideo(video) {
    if (downloadedVideoIds.has(video.id)) return;
    performDownload(video);
  }

  async function performDownload(video) {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') { 
        Alert.alert('Permission Denied', 'Please allow access to your media library.'); 
        return; 
      }
      
      setIsDownloading(true);
      setDownloadProgress(0);
      
      const fileUri = FileSystem.documentDirectory + `balagh_${video.id}.mp4`;
      
      const downloadResumable = FileSystem.createDownloadResumable(
        video.video_url, fileUri, {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          if (totalBytesExpectedToWrite > 0) setDownloadProgress(totalBytesWritten / totalBytesExpectedToWrite);
        }
      );
      
      const result = await downloadResumable.downloadAsync();
      if (!result?.uri) throw new Error('Download failed');
      
      await MediaLibrary.saveToLibraryAsync(result.uri);
      await FileSystem.deleteAsync(result.uri, { idempotent: true });
      
      setIsDownloading(false);
      downloadedVideoIds.add(video.id);
      
      Alert.alert('Downloaded ✅', 'Video saved to your gallery!');
    } catch (e) {
      setIsDownloading(false);
      Alert.alert('Error', 'Could not download the video. Please try again.');
      console.error('Download error:', e);
    }
  }

  // SAFETY CHECK added here
  function handleLongPress(video) { 
    if (!showVideoOptionsSheet) {
      console.log('showVideoOptionsSheet not available');
      return;
    }
    
    const hasDownloaded = downloadedVideoIds.has(video.id);
    showVideoOptionsSheet(
      video,
      isOwnProfile,
      hasDownloaded,
      {
        onPin: handlePinVideo,
        onDelete: handleDeleteVideo,
        onDownload: handleDownloadVideo,
      }
    );
  }

  const onRefresh = useCallback(async () => { setRefreshing(true); await init(); setRefreshing(false); }, []);
  const openVideo = (videos, index) => navigation.navigate('ProfileVideos', { videos, startIndex: index });

  const renderHeader = () => (
    <View style={styles.headerSection}>
      <View style={styles.avatarSection}>
        <Avatar
          uri={profile?.avatar_url}
          username={profile?.username}
          size={90}
          onPress={() => { if (isOwnProfile) setAvatarModal(true); else if (profile?.avatar_url) setEnlargeAvatar(true); }}
        />
        {isScholar && <View style={styles.scholarBadge}><Text style={styles.scholarBadgeText}>✓ Scholar</Text></View>}
      </View>

      {isScholar ? (
        <View style={styles.scholarCard}>
          <View style={styles.scholarCardHeader}>
            <Text style={styles.scholarCardIcon}>🎓</Text>
            <Text style={styles.scholarCardTitle}>Verified Scholar</Text>
          </View>
          <View style={styles.scholarCardDivider} />
          <View style={styles.scholarCardBody}>
            {scholarData?.full_name && (
              <View style={styles.scholarRow}>
                <Text style={styles.scholarRowLabel}>Full Name</Text>
                <Text style={styles.scholarRowValue}>{scholarData.full_name}</Text>
              </View>
            )}
            {scholarData?.age && (
              <View style={styles.scholarRow}>
                <Text style={styles.scholarRowLabel}>Age</Text>
                <Text style={styles.scholarRowValue}>{scholarData.age}</Text>
              </View>
            )}
            {scholarData?.location && (
              <View style={styles.scholarRow}>
                <Text style={styles.scholarRowLabel}>📍 Location</Text>
                <Text style={styles.scholarRowValue}>{scholarData.location}</Text>
              </View>
            )}
            {scholarData?.education && (
              <View style={styles.scholarRow}>
                <Text style={styles.scholarRowLabel}>🎓 Education</Text>
                <Text style={styles.scholarRowValue}>{scholarData.education}</Text>
              </View>
            )}
            {scholarData?.expertise && (
              <View style={styles.scholarRow}>
                <Text style={styles.scholarRowLabel}>⭐ Expertise</Text>
                <Text style={styles.scholarRowValue}>{scholarData.expertise}</Text>
              </View>
            )}
            {scholarData?.bio && (
              <View style={styles.scholarBioRow}>
                <Text style={styles.scholarRowLabel}>About</Text>
                <Text style={styles.scholarBioValue}>{scholarData.bio}</Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        <View style={styles.regularInfo}>
          <Text style={styles.displayName}>{profile?.full_name || profile?.username || 'User'}</Text>
          <Text style={styles.usernameText}>@{profile?.username || 'username'}</Text>
          {profile?.bio ? (
            <Text style={styles.bioText}>{profile.bio}</Text>
          ) : isOwnProfile ? (
            <AnimatedButton onPress={() => navigation.navigate('EditProfile')}>
              <Text style={styles.addBioText}>+ Add bio</Text>
            </AnimatedButton>
          ) : null}
        </View>
      )}

      <View style={styles.statsRow}>
        <View style={styles.statItem}>
          <Text style={styles.statNum}>{formatCount(publicVideos.length)}</Text>
          <Text style={styles.statLabel}>Videos</Text>
        </View>
        
        <View style={styles.statDivider} />
        
        <AnimatedButton style={styles.statItem} onPress={() => navigation.navigate('FollowList', { userId: targetUserId ?? currentUser?.id, type: 'followers', username: profile?.username })}>
          <Text style={styles.statNum}>{formatCount(followersCount)}</Text>
          <Text style={styles.statLabel}>Followers</Text>
        </AnimatedButton>
        
        <View style={styles.statDivider} />
        
        <AnimatedButton style={styles.statItem} onPress={() => navigation.navigate('FollowList', { userId: targetUserId ?? currentUser?.id, type: 'following', username: profile?.username })}>
          <Text style={styles.statNum}>{formatCount(followingCount)}</Text>
          <Text style={styles.statLabel}>Following</Text>
        </AnimatedButton>
        
        <View style={styles.statDivider} />
        
        <View style={styles.statItem}>
          <Text style={styles.statNum}>{formatCount(totalLikes)}</Text>
          <Text style={styles.statLabel}>Likes</Text>
        </View>
      </View>

      {isOwnProfile ? (
        !isScholar && (
          <View style={styles.actionButtons}>
            <AnimatedButton style={styles.scholarApplyBtn} onPress={() => navigation.navigate('ApplyScholar')}>
              <Text style={styles.scholarApplyBtnText}>🎓 Apply as Scholar</Text>
            </AnimatedButton>
          </View>
        )
      ) : (
        <View style={styles.actionButtons}>
          <AnimatedButton style={[styles.followBtn, following && styles.followingBtn]} onPress={handleFollow}>
            <Text style={[styles.followBtnText, following && styles.followingBtnText]}>
              {following ? '✓ Following' : '+ Follow'}
            </Text>
          </AnimatedButton>
        </View>
      )}

      <View style={styles.tabs}>
        <AnimatedButton style={[styles.tab, activeTab === 'videos' && styles.activeTab]} onPress={() => setActiveTab('videos')}>
          <Text style={[styles.tabText, activeTab === 'videos' && styles.activeTabText]}>🎥</Text>
        </AnimatedButton>
        {isOwnProfile && (
          <AnimatedButton style={[styles.tab, activeTab === 'private' && styles.activeTab]} onPress={() => setActiveTab('private')}>
            <Text style={[styles.tabText, activeTab === 'private' && styles.activeTabText]}>🔒</Text>
          </AnimatedButton>
        )}
        <AnimatedButton style={[styles.tab, activeTab === 'liked' && styles.activeTab]} onPress={() => setActiveTab('liked')}>
          <Text style={[styles.tabText, activeTab === 'liked' && styles.activeTabText]}>❤️</Text>
        </AnimatedButton>
      </View>
    </View>
  );

  const activeVideos = activeTab === 'videos' ? publicVideos : activeTab === 'private' ? privateVideos : likedVideos;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f0f0f" />

      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        {!isOwnProfile && (
          <AnimatedButton onPress={() => navigation.goBack()} style={styles.topBarBtn}>
            <Text style={styles.topBarBtnText}>←</Text>
          </AnimatedButton>
        )}
        <View style={{ flex: 1 }} />
        {isOwnProfile && (
          <AnimatedButton onPress={() => navigation.navigate('Settings')} style={styles.topBarBtn}>
            <Text style={styles.topBarBtnText}>☰</Text>
          </AnimatedButton>
        )}
      </View>

      <FlatList
        data={activeVideos}
        keyExtractor={(item) => item.id}
        numColumns={3}
        ListHeaderComponent={renderHeader}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#7c3aed" progressViewOffset={35} />}
        renderItem={({ item, index }) => (
          <VideoGridItem item={item} onPress={() => openVideo(activeVideos, index)} onLongPress={handleLongPress} />
        )}
        ListEmptyComponent={
          <View style={styles.emptyGrid}>
            <Text style={styles.emptyGridIcon}>{activeTab === 'videos' ? '🎥' : activeTab === 'private' ? '🔒' : '❤️'}</Text>
            <Text style={styles.emptyGridText}>{activeTab === 'videos' ? 'No videos yet' : activeTab === 'private' ? 'No private videos' : 'No liked videos'}</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 20, paddingTop: insets.top + 50 }}
        showsVerticalScrollIndicator={false}
      />

      <DownloadProgressOverlay visible={isDownloading} progress={downloadProgress} />

      <Modal
        visible={avatarModal}
        transparent
        animationType="slide"
        onRequestClose={() => setAvatarModal(false)}
        statusBarTranslucent
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setAvatarModal(false)} />
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>Profile Photo</Text>
          {profile?.avatar_url && (
            <AnimatedButton style={styles.modalOption} onPress={() => { setAvatarModal(false); setEnlargeAvatar(true); }}>
              <Text style={styles.modalOptionText}>👁️ View Photo</Text>
            </AnimatedButton>
          )}
          <AnimatedButton style={styles.modalOption} onPress={handleChangeAvatar}>
            <Text style={styles.modalOptionText}>📷 Change Photo</Text>
          </AnimatedButton>
          <AnimatedButton style={styles.modalOption} onPress={() => setAvatarModal(false)}>
            <Text style={[styles.modalOptionText, { color: '#ef4444' }]}>Cancel</Text>
          </AnimatedButton>
        </View>
      </Modal>

      <Modal
        visible={enlargeAvatar}
        transparent
        animationType="fade"
        onRequestClose={() => setEnlargeAvatar(false)}
        statusBarTranslucent
      >
        <Pressable style={styles.enlargeBackdrop} onPress={() => setEnlargeAvatar(false)}>
          <View style={styles.enlargeCloseBtn}>
            <Text style={styles.enlargeCloseBtnText}>✕</Text>
          </View>
          {profile?.avatar_url && (
            <Image source={{ uri: profile.avatar_url }} style={styles.enlargedAvatar} resizeMode="contain" />
          )}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 4,
    backgroundColor: 'rgba(15, 15, 15, 0.5)', position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
  },
  topBarBtn: { padding: 8 },
  topBarBtnText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  headerSection: { backgroundColor: '#0f0f0f', paddingBottom: 4 },
  avatarSection: { alignItems: 'center', paddingTop: 8, paddingBottom: 12 },
  scholarBadge: { marginTop: 8, backgroundColor: '#7c3aed', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  scholarBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  regularInfo: { alignItems: 'center', paddingHorizontal: 24, marginBottom: 10 },
  displayName: { fontSize: 20, fontWeight: '800', color: '#fff', marginBottom: 2 },
  usernameText: { fontSize: 14, color: '#94a3b8', marginBottom: 8 },
  bioText: { fontSize: 14, color: '#cbd5e1', textAlign: 'center', lineHeight: 20 },
  addBioText: { fontSize: 14, color: '#7c3aed', fontWeight: '600' },
  scholarCard: { marginHorizontal: 16, marginBottom: 14, backgroundColor: '#1a1d27', borderRadius: 16, borderWidth: 1, borderColor: '#7c3aed44', overflow: 'hidden' },
  scholarCardHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#7c3aed22', gap: 8 },
  scholarCardIcon: { fontSize: 18 },
  scholarCardTitle: { fontSize: 15, fontWeight: '800', color: '#a78bfa' },
  scholarCardDivider: { height: 1, backgroundColor: '#7c3aed33' },
  scholarCardBody: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  scholarRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  scholarRowLabel: { fontSize: 13, color: '#64748b', fontWeight: '600', flex: 1 },
  scholarRowValue: { fontSize: 13, color: '#e2e8f0', fontWeight: '500', flex: 2, textAlign: 'right' },
  scholarBioRow: { gap: 4 },
  scholarBioValue: { fontSize: 13, color: '#cbd5e1', lineHeight: 20 },
  statsRow: { flexDirection: 'row', backgroundColor: '#1a1d27', borderRadius: 16, marginHorizontal: 16, marginBottom: 10, paddingVertical: 8, justifyContent: 'space-around', alignItems: 'center' },
  statItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, minWidth: 70 },
  statNum: { fontSize: 18, fontWeight: '800', color: '#fff' },
  statLabel: { fontSize: 11, color: '#64748b', marginTop: 2 },
  statDivider: { width: 1, height: 28, backgroundColor: '#2d3148' },
  actionButtons: { paddingHorizontal: 16, marginBottom: 10 },
  scholarApplyBtn: { backgroundColor: '#7c3aed', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  scholarApplyBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  followBtn: { backgroundColor: '#7c3aed', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  followingBtn: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#7c3aed' },
  followBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  followingBtnText: { color: '#a78bfa' },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#1e1e1e' },
  tab: { flex: 1, paddingVertical: 4, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  activeTab: { borderBottomColor: '#7c3aed' },
  tabText: { fontSize: 20, opacity: 0.5 },
  activeTabText: { opacity: 1 },
  gridItem: { width: GRID_ITEM_SIZE, height: GRID_ITEM_SIZE * 1.2, margin: 0.5, backgroundColor: '#1a1a1a' },
  gridThumb: { width: '100%', height: '100%' },
  gridOverlay: { position: 'absolute', bottom: 4, left: 4 },
  gridPlayCount: { color: '#fff', fontSize: 11, fontWeight: '600', textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  pinnedLabel: { position: 'absolute', top: 4, left: 4 },
  pinnedLabelText: { fontSize: 14 },
  privateLabel: { position: 'absolute', top: 4, right: 4 },
  privateLabelText: { fontSize: 14 },
  emptyGrid: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  emptyGridIcon: { fontSize: 48 },
  emptyGridText: { color: '#64748b', fontSize: 15, fontWeight: '600' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#1a1d27', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 40, paddingTop: 16 },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: 16 },
  modalOption: { paddingVertical: 16, paddingHorizontal: 24 },
  modalOptionText: { color: '#fff', fontSize: 16, fontWeight: '500' },
  enlargeBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center' },
  enlargedAvatar: { width: width - 40, height: width - 40, borderRadius: 12 },
  enlargeCloseBtn: { position: 'absolute', top: 50, right: 20, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  enlargeCloseBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  dlOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', zIndex: 99, backgroundColor: 'rgba(0,0,0,0.55)', pointerEvents: 'none' },
  dlBox: { backgroundColor: '#1a1d27', borderRadius: 20, padding: 28, width: width * 0.75, alignItems: 'center', gap: 14 },
  dlTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  dlBarBg: { width: '100%', height: 8, backgroundColor: '#2d3148', borderRadius: 4, overflow: 'hidden' },
  dlBarFill: { height: '100%', backgroundColor: '#7c3aed', borderRadius: 4 },
  dlPercent: { color: '#a78bfa', fontSize: 22, fontWeight: '800' },
});