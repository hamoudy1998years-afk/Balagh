import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TextInput, FlatList, Alert,
  Keyboard, Platform, ActivityIndicator, BackHandler,
  Dimensions, PermissionsAndroid, AppState, Image, Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createAgoraRtcEngine,
  ChannelProfileType,
  ClientRoleType,
  RtcSurfaceView,
  VideoSourceType,
} from 'react-native-agora';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { useViewerCount } from '../hooks/useViewerCount';
import { useRecentViewers } from '../hooks/useRecentViewers';
import { useEngagedViewers } from '../hooks/useEngagedViewers';
import { useFeatureFlag } from '../hooks/useFeatureFlag';
import RNFS from 'react-native-fs';
import { COLORS } from '../constants/theme';

const { width, height } = Dimensions.get('window');
const AGORA_APP_ID = process.env.EXPO_PUBLIC_AGORA_APP_ID;

// 🔧 FIXED: Removed trailing space
const THUMBNAIL_SERVER_URL = 'https://balagh-server-production.up.railway.app';

async function getAgoraToken(channelName, uid, role) {
  console.log('🚀 Fetching token...');
  const fetchWithTimeout = (url, options, timeout = 10000) => {
    return Promise.race([
      fetch(url, options),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), timeout)
      )
    ]);
  };
  try {
    const response = await fetchWithTimeout(
      `${THUMBNAIL_SERVER_URL}/token?channelName=${channelName}&uid=${uid}&role=${role}`,
      { method: 'GET', headers: { 'Accept': 'application/json' } },
      10000
    );
    const data = await response.json();
    console.log('✅ Token received:', data.token ? 'YES' : 'NO');
    return data.token;
  } catch (error) {
    console.error('❌ Token error:', error);
    return null;
  }
}

async function uploadThumbnail(filePath, streamId) {
  try {
    console.log('📤 Uploading snapshot to Supabase...');

    const fileName = `thumbnail_${streamId}_${Date.now()}.jpg`;

    const formData = new FormData();
    formData.append('file', {
      uri: filePath.startsWith('file://') ? filePath : `file://${filePath}`,
      name: fileName,
      type: 'image/jpeg',
    });

    const { data, error } = await supabase.storage
      .from('thumbnails')
      .upload(fileName, formData, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (error) {
      console.error('❌ Upload error:', JSON.stringify(error, null, 2));
      return null;
    }

    console.log('✅ Upload successful:', data);

    const { data: { publicUrl } } = supabase.storage
      .from('thumbnails')
      .getPublicUrl(fileName);

    console.log('✅ Thumbnail public URL:', publicUrl);

    await supabase
      .from('live_streams')
      .update({ thumbnail_url: publicUrl })
      .eq('id', streamId);

    return publicUrl;
  } catch (error) {
    console.error('❌ Upload failed:', error);
    return null;
  }
}

export default function LiveStreamScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { title = 'Live Stream', maxQuestions = 5 } = route?.params ?? {};

  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [streamId, setStreamId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [chatInput, setChatInput] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  const [currentUser, setCurrentUser] = useState(null);
  const [username, setUsername] = useState('');
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [showViewerList, setShowViewerList] = useState(false);
  const [viewerListMode, setViewerListMode] = useState('recent');
  const [allowQuestions, setAllowQuestions] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const engineRef = useRef(null);
  const flatListRef = useRef(null);
  const appStateSubscription = useRef(null);
  const pingInterval = useRef(null);
  const currentStreamIdRef = useRef(null);
  const currentChannelRef = useRef(null);
  const isLiveRef = useRef(false);
  const chatChannelRef = useRef(null);
  const questionsChannelRef = useRef(null);

  // ✅ NEW: Use the viewer count hook (streamer doesn't track themselves)
  const { viewerCount } = useViewerCount(streamId);
  const { recentViewers } = useRecentViewers(streamId);
  const { engagedViewers } = useEngagedViewers(streamId);
  const { enabled: showEngagedTab } = useFeatureFlag('engaged_viewers_tab');

  useEffect(() => {
      // REMOVED: setup() - now called manually when pressing "Start Streaming"
      appStateSubscription.current = AppState.addEventListener('change', nextAppState => {
        if (nextAppState === 'background' || nextAppState === 'inactive') {
          console.log('App went to background, ending stream...');
          forceEndStream();
        }
      });

      const keyboardDidShow = Keyboard.addListener('keyboardDidShow', (e) => {
        setKeyboardHeight(e.endCoordinates.height);
      });
      const keyboardDidHide = Keyboard.addListener('keyboardDidHide', () => {
        setKeyboardHeight(0);
      });

      const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
        if (isLiveRef.current) {
          setShowEndModal(true);
          return true; // blocks the default back action
        }
        return false;
      });

      return () => {
        if (appStateSubscription.current) {
          appStateSubscription.current.remove();
        }
        keyboardDidShow.remove();
        keyboardDidHide.remove();
        backHandler.remove();
        cleanup();
      };
    }, []);

  async function requestPermissions() {
    if (Platform.OS === 'android') {
      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);
      if (results[PermissionsAndroid.PERMISSIONS.CAMERA] !== PermissionsAndroid.RESULTS.GRANTED) {
        console.log('❌ Camera permission denied');
        Alert.alert('Permission Required', 'Camera permission is needed to stream');
        return false;
      }
    }
    return true;
  }

  function switchCamera() {
    if (engineRef.current) {
      engineRef.current.switchCamera();
      setIsFrontCamera(!isFrontCamera);
    }
  }

  async function setup() {
    const hasPermission = await requestPermissions();
    if (!hasPermission) {
      setIsStarting(false); // 🔧 FIXED: Reset button state
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setIsStarting(false); // 🔧 FIXED: Reset button state
        return;
      }
      setCurrentUser(user);

      await supabase
        .from('live_streams')
        .delete()
        .eq('user_id', user.id)
        .eq('is_live', true);

      const { data: profile } = await supabase
        .from('profiles')
        .select('username, avatar_url')
        .eq('id', user.id)
        .single();
      setUsername(profile?.username ?? 'Scholar');

      const channel = `bushrann_${user.id}_${Date.now()}`;
      currentChannelRef.current = channel;

      const [hostToken, viewerToken] = await Promise.all([
        getAgoraToken(channel, 1, 'host'),
        getAgoraToken(channel, 0, 'audience')
      ]);

      if (!hostToken) {
        Alert.alert('Error', 'Could not get streaming token. Please try again.');
        setIsStarting(false); // 🔧 FIXED: Reset button state
        navigation.goBack();
        return;
      }

      const { data: stream, error: streamError } = await supabase
        .from('live_streams')
        .insert({
          user_id: user.id,
          title,
          channel_name: channel,
          max_questions: maxQuestions,
          is_live: true,
          viewer_token: viewerToken,
          thumbnail_url: profile?.avatar_url || null,
          allow_questions: allowQuestions,
        })
        .select()
        .single();

      if (streamError) {
        Alert.alert('Error', 'Could not start stream.');
        setIsStarting(false); // 🔧 FIXED: Reset button state
        navigation.goBack();
        return;
      }

      const currentStreamId = stream.id;
      setStreamId(currentStreamId);
      currentStreamIdRef.current = currentStreamId;

      const engine = createAgoraRtcEngine();
      engineRef.current = engine;
      engine.initialize({ appId: AGORA_APP_ID });

      engine.registerEventHandler({
        onJoinChannelSuccess: (connection, elapsed) => {
          console.log('✅ Joined channel:', connection.channelId, 'uid:', connection.localUid);

          setTimeout(() => {
            // 🔧 FIXED: Use platform-specific path
            const snapshotPath = Platform.OS === 'ios' 
              ? `${RNFS.CachesDirectoryPath}/snapshot_${Date.now()}.jpg`
              : `/data/user/0/com.bushrann.app/cache/snapshot_${Date.now()}.jpg`;
            console.log('📸 Taking Agora snapshot to:', snapshotPath);
            engine.takeSnapshot(0, snapshotPath);
          }, 3000);
        },

        onSnapshotTaken: (connection, uid, filePath, width, height, errCode) => {
          console.log('📸 Snapshot taken! uid:', uid, 'Path:', filePath, 'Error:', errCode);
          if (errCode === 0 && filePath) {
            uploadThumbnail(filePath, currentStreamIdRef.current);
          } else {
            console.error('❌ Snapshot failed with error code:', errCode);
          }
        },

        onError: (errCode, msg) => {
          console.log('❌ Agora error:', errCode, msg);
        },
        onLocalVideoStateChanged: (state, error) => {
          console.log('📹 Local video state:', state, 'error:', error);
        }
      });

      engine.setChannelProfile(ChannelProfileType.ChannelProfileLiveBroadcasting);
      engine.setClientRole(ClientRoleType.ClientRoleBroadcaster);
      engine.enableVideo();
      engine.startPreview();

      await engine.joinChannel(hostToken, channel, 1, {
        clientRoleType: ClientRoleType.ClientRoleBroadcaster,
        publishCameraTrack: true,
        publishMicrophoneTrack: true,
      });

      setIsLive(true);
      isLiveRef.current = true;
      console.log('🔥 Engine exists:', engineRef.current !== null);
      setLoading(false);

      pingInterval.current = setInterval(async () => {
        if (currentStreamId) {
          await supabase
            .from('live_streams')
            .update({ last_ping: new Date().toISOString() })
            .eq('id', currentStreamId);
        }
      }, 5000);

      subscribeToChat(stream.id);
      subscribeToQuestions(stream.id);

    } catch (e) {
      console.error('Setup error:', e);
      Alert.alert('Error', 'Failed to start live stream.');
      setIsStarting(false); // 🔧 FIXED: Reset button state
      navigation.goBack();
    }
  }

  async function forceEndStream() {
    if (streamId) {
      await supabase.from('live_streams').delete().eq('id', streamId);
    }
    await cleanup();
    navigation.goBack();
  }

  async function cleanup() {
    if (pingInterval.current) {
      clearInterval(pingInterval.current);
      pingInterval.current = null;
    }
    if (chatChannelRef.current) {
      await supabase.removeChannel(chatChannelRef.current);
      chatChannelRef.current = null;
    }
    if (questionsChannelRef.current) {
      await supabase.removeChannel(questionsChannelRef.current);
      questionsChannelRef.current = null;
    }
    if (engineRef.current) {
      engineRef.current.leaveChannel();
      engineRef.current.release();
      engineRef.current = null;
    }
  }

  function subscribeToChat(sid) {
    chatChannelRef.current = supabase
      .channel(`live_messages_${sid}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_messages', filter: `stream_id=eq.${sid}` },
        (payload) => {
          setMessages(prev => [...prev, payload.new]);
          setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
        })
      .subscribe();
  }

  function subscribeToQuestions(sid) {
    questionsChannelRef.current = supabase
      .channel(`live_questions_${sid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_questions', filter: `stream_id=eq.${sid}` },
        () => loadQuestions(sid))
      .subscribe();
  }

  async function loadQuestions(sid) {
    const { data } = await supabase
      .from('live_questions')
      .select('*')
      .eq('stream_id', sid)
      .eq('is_answered', false)
      .order('created_at', { ascending: true });
    setQuestions(data ?? []);
  }

  async function sendMessage() {
    if (!chatInput.trim() || !streamId || !currentUser) return;
    const msg = chatInput.trim();
    setChatInput('');
    await supabase.from('live_messages').insert({
      stream_id: streamId, user_id: currentUser.id, username, message: msg,
    });
  }

  async function selectQuestion(question) {
    setSelectedQuestion(question);
    await supabase.from('live_questions').update({ is_selected: true }).eq('id', question.id);
  }

  async function markAnswered() {
    if (!selectedQuestion) return;
    await supabase.from('live_questions').update({ is_answered: true, is_selected: false }).eq('id', selectedQuestion.id);
    setSelectedQuestion(null);
    loadQuestions(streamId);
  }

  async function dismissQuestion() {
    if (!selectedQuestion) return;
    await supabase.from('live_questions').update({ is_selected: false }).eq('id', selectedQuestion.id);
    setSelectedQuestion(null);
  }

  async function endStream() {
    setShowEndModal(true);
  }

  async function confirmEndStream() {
    setShowEndModal(false);
    await supabase.from('live_streams').delete().eq('id', streamId);
    await cleanup();
    navigation.goBack();
  }

  if (!isLive) {
    return (
      <View style={styles.loadingContainer}>
        {isStarting ? (
          <>
            <ActivityIndicator color="#ef4444" size="large" />
            <Text style={styles.loadingText}>Starting your live stream...</Text>
          </>
        ) : (
          <View style={styles.preStreamContainer}>
            <Text style={styles.preStreamTitle}>Go Live</Text>
            <Text style={styles.preStreamSubtitle}>{title}</Text>

            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Allow Questions</Text>
                <Text style={styles.settingDescription}>
                  Viewers can ask questions during your stream
                </Text>
              </View>
              <Switch
                value={allowQuestions}
                onValueChange={setAllowQuestions}
                trackColor={{ false: '#767577', true: COLORS.gold }}
                thumbColor={allowQuestions ? '#fff' : '#f4f3f4'}
              />
            </View>

            <AnimatedButton style={styles.goLiveBtn} onPress={() => {
              setIsStarting(true);
              setup();
            }}>
              <Text style={styles.goLiveBtnText}>Start Streaming</Text>
            </AnimatedButton>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <RtcSurfaceView
        style={StyleSheet.absoluteFill}
        canvas={{ uid: 0, sourceType: VideoSourceType.VideoSourceCamera }}
      />

      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.liveBadge}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
        <AnimatedButton
          style={styles.viewerBadge}
          onPress={() => setShowViewerList(!showViewerList)}
        >
          <Text style={styles.viewerText}>👁️ {viewerCount}</Text>
        </AnimatedButton>
        <AnimatedButton style={styles.endBtn} onPress={endStream}>
          <Text style={styles.endBtnText}>End</Text>
        </AnimatedButton>

        {showViewerList && (
          <View style={styles.viewerListPanel}>
            <View style={styles.viewerListHeader}>
              <Text style={styles.viewerListTitle}>
                {showEngagedTab
                  ? (viewerListMode === 'recent' ? 'Recent Viewers' : 'Engaged Viewers')
                  : 'Recent Viewers'
                }
                ({showEngagedTab && viewerListMode === 'engaged' ? engagedViewers.length : viewerCount})
              </Text>
              <AnimatedButton onPress={() => setShowViewerList(false)}>
                <Text style={styles.closeListText}>✕</Text>
              </AnimatedButton>
            </View>

            {/* Tabs - only show if feature flag is enabled */}
            {showEngagedTab && (
              <View style={styles.viewerListTabs}>
                <AnimatedButton
                  style={[styles.viewerListTab, viewerListMode === 'recent' && styles.viewerListTabActive]}
                  onPress={() => setViewerListMode('recent')}
                >
                  <Text style={[styles.viewerListTabText, viewerListMode === 'recent' && styles.viewerListTabTextActive]}>
                    Recent
                  </Text>
                </AnimatedButton>
                <AnimatedButton
                  style={[styles.viewerListTab, viewerListMode === 'engaged' && styles.viewerListTabActive]}
                  onPress={() => setViewerListMode('engaged')}
                >
                  <Text style={[styles.viewerListTabText, viewerListMode === 'engaged' && styles.viewerListTabTextActive]}>
                    Engaged
                  </Text>
                </AnimatedButton>
              </View>
            )}

            {/* List */}
            <FlatList
              data={showEngagedTab && viewerListMode === 'engaged' ? engagedViewers : recentViewers}
              keyExtractor={(item) => item.userId}
              style={styles.viewerList}
              renderItem={({ item }) => (
                <View style={styles.viewerItem}>
                  {item.avatarUrl ? (
                    <Image source={{ uri: item.avatarUrl }} style={styles.viewerAvatar} />
                  ) : (
                    <View style={styles.viewerAvatarPlaceholder}>
                      <Text style={styles.viewerAvatarText}>
                        {item.username.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <Text style={styles.viewerUsername}>@{item.username}</Text>
                  {item.badge && <Text style={styles.viewerBadge}>{item.badge}</Text>}
                </View>
              )}
              ListEmptyComponent={
                <Text style={styles.emptyViewerList}>
                  {showEngagedTab && viewerListMode === 'engaged'
                    ? 'No engaged viewers yet'
                    : 'No viewers yet'
                  }
                </Text>
              }
            />
          </View>
        )}
      </View>

      {selectedQuestion && (
        <View style={styles.questionBanner}>
          <Text style={styles.questionBannerLabel}>❓ Question from @{selectedQuestion.username}</Text>
          <Text style={styles.questionBannerText}>{selectedQuestion.question}</Text>
          <View style={styles.questionBannerActions}>
            <AnimatedButton style={styles.answeredBtn} onPress={markAnswered}>
              <Text style={styles.answeredBtnText}>✅ Answered</Text>
            </AnimatedButton>
            <AnimatedButton style={styles.dismissBtn} onPress={dismissQuestion}>
              <Text style={styles.dismissBtnText}>✕ Dismiss</Text>
            </AnimatedButton>
          </View>
        </View>
      )}

      <View style={[styles.bottomPanel, { paddingBottom: insets.bottom + 8 }]}>
        <View style={styles.tabs}>
          <AnimatedButton style={[styles.tab, activeTab === 'chat' && styles.tabActive]} onPress={() => setActiveTab('chat')}>
            <Text style={[styles.tabText, activeTab === 'chat' && styles.tabTextActive]}>💬 Chat</Text>
          </AnimatedButton>
          <AnimatedButton style={[styles.tab, activeTab === 'questions' && styles.tabActive]} onPress={() => setActiveTab('questions')}>
            <Text style={[styles.tabText, activeTab === 'questions' && styles.tabTextActive]}>
              ❓ Questions {questions.length > 0 ? `(${questions.length})` : ''}
            </Text>
          </AnimatedButton>
        </View>

        {activeTab === 'chat' && (
          <>
            <FlatList
              ref={flatListRef}
              data={messages}
              keyExtractor={(item) => item.id}
              style={styles.chatList}
              renderItem={({ item }) => (
                <View style={styles.chatMessage}>
                  <Text style={styles.chatUsername}>@{item.username} </Text>
                  <Text style={styles.chatText}>{item.message}</Text>
                </View>
              )}
              showsVerticalScrollIndicator={false}
            />
            <View style={[styles.chatInputRow, { marginBottom: Math.max(10, keyboardHeight - 45) }]}>
              <TextInput style={styles.chatInput} value={chatInput} onChangeText={setChatInput}
                placeholder="Say something..." placeholderTextColor="#64748b" onSubmitEditing={sendMessage} />
              <AnimatedButton style={styles.sendBtn} onPress={sendMessage}>
                <Text style={styles.sendBtnText}>Send</Text>
              </AnimatedButton>
            </View>
          </>
        )}

        {activeTab === 'questions' && (
          <FlatList
            data={questions}
            keyExtractor={(item) => item.id}
            style={styles.chatList}
            ListEmptyComponent={
              <View style={styles.emptyQuestions}>
                <Text style={styles.emptyQuestionsText}>No questions yet</Text>
                <Text style={styles.emptyQuestionsSubtext}>Viewers can submit questions during your live</Text>
              </View>
            }
            renderItem={({ item }) => (
              <AnimatedButton style={[styles.questionItem, item.is_selected && styles.questionItemSelected]} onPress={() => selectQuestion(item)}>
                <Text style={styles.questionUsername}>@{item.username}</Text>
                <Text style={styles.questionText}>{item.question}</Text>
                {item.is_selected && <Text style={styles.questionSelectedBadge}>📌 On screen</Text>}
              </AnimatedButton>
            )}
          />
        )}

        <View style={styles.cameraControls}>
          <AnimatedButton style={styles.flipBtnBottom} onPress={switchCamera}>
            <Text style={styles.flipBtnBottomText}>🔄 Flip Camera</Text>
          </AnimatedButton>
        </View>
      </View>
    {showEndModal && (
        <View style={styles.modalOverlay}>
          <View style={styles.glassModal}>
            <View style={styles.glassModalIcon}>
              <View style={styles.glassModalDot} />
            </View>
            <Text style={styles.glassModalTitle}>End Stream</Text>
            <Text style={styles.glassModalSubtitle}>
              This will end your live session for all viewers.
            </Text>
            <View style={styles.glassModalButtons}>
              <AnimatedButton
                style={styles.glassModalCancel}
                onPress={() => setShowEndModal(false)}
              >
                <Text style={styles.glassModalCancelText}>Cancel</Text>
              </AnimatedButton>
              <AnimatedButton
                style={styles.glassModalEnd}
                onPress={confirmEndStream}
              >
                <Text style={styles.glassModalEndText}>End Stream</Text>
              </AnimatedButton>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

// 🔧 FIXED: Removed duplicate styles - only one definition each
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  loadingContainer: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', gap: 16 },
  loadingText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 10, zIndex: 10 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ef4444', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, gap: 6 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  liveText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  viewerBadge: { backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  viewerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  endBtn: { marginLeft: 'auto', backgroundColor: 'rgba(239,68,68,0.9)', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
  endBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  questionBanner: { position: 'absolute', top: 100, left: 16, right: 16, backgroundColor: 'rgba(0,0,0,0.85)', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: COLORS.gold, zIndex: 20 },
  questionBannerLabel: { color: COLORS.gold, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  questionBannerText: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 10 },
  questionBannerActions: { flexDirection: 'row', gap: 10 },
  answeredBtn: { flex: 1, backgroundColor: '#10b981', borderRadius: 8, padding: 8, alignItems: 'center' },
  answeredBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  dismissBtn: { flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 8, padding: 8, alignItems: 'center' },
  dismissBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  bottomPanel: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 12 },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  tab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.1)' },
  tabActive: { backgroundColor: COLORS.gold },
  tabText: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  chatList: { maxHeight: height * 0.25, marginBottom: 8 },
  chatMessage: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
  chatUsername: { color: COLORS.gold, fontWeight: '700', fontSize: 13 },
  chatText: { color: '#fff', fontSize: 13 },
  chatInputRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  chatInput: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8, color: 'rgba(255,255,255,0.9)', fontSize: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  sendBtn: { backgroundColor: COLORS.gold, borderRadius: 20, paddingHorizontal: 16, justifyContent: 'center' },
  sendBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  emptyQuestions: { padding: 20, alignItems: 'center' },
  emptyQuestionsText: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  emptyQuestionsSubtext: { color: '#64748b', fontSize: 13, textAlign: 'center' },
  questionItem: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 12, padding: 12, marginBottom: 8 },
  questionItemSelected: { borderWidth: 1, borderColor: COLORS.gold, backgroundColor: 'rgba(245,166,35,0.2)' },
  questionUsername: { color: COLORS.gold, fontSize: 12, fontWeight: '700', marginBottom: 3 },
  questionText: { color: '#fff', fontSize: 14 },
  questionSelectedBadge: { color: COLORS.gold, fontSize: 11, marginTop: 4, fontWeight: '600' },
  cameraControls: { flexDirection: 'row', justifyContent: 'center', marginBottom: 8 },
  flipBtnBottom: { backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20, paddingHorizontal: 20, paddingVertical: 10, flexDirection: 'row', alignItems: 'center' },
  flipBtnBottomText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  viewerListPanel: {
    position: 'absolute',
    top: 50,
    right: 16,
    width: 250,
    maxHeight: 300,
    backgroundColor: 'rgba(0,0,0,0.9)',
    borderRadius: 12,
    padding: 12,
    zIndex: 100,
  },
  viewerListHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.2)',
  },
  viewerListTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  closeListText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  viewerList: {
    maxHeight: 250,
  },
  viewerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  viewerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  viewerAvatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerAvatarText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  viewerUsername: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  emptyViewerList: {
    color: '#64748b',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20,
  },
  viewerListTabs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  viewerListTab: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
  },
  viewerListTabActive: {
    backgroundColor: COLORS.gold,
  },
  viewerListTabText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    fontWeight: '600',
  },
  viewerListTabTextActive: {
    color: '#fff',
  },
  preStreamContainer: {
    width: '100%',
    padding: 20,
    alignItems: 'center',
  },
  preStreamTitle: {
    color: '#fff',
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  preStreamSubtitle: {
    color: COLORS.gold,
    fontSize: 16,
    marginBottom: 30,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    padding: 16,
    marginBottom: 30,
  },
  settingInfo: {
    flex: 1,
    marginRight: 12,
  },
  settingLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  settingDescription: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
  },
  goLiveBtn: {
    backgroundColor: '#ef4444',
    borderRadius: 12,
    paddingHorizontal: 40,
    paddingVertical: 16,
  },
  goLiveBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  modalOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', zIndex: 999 },
  glassModal: { width: 300, borderRadius: 24, overflow: 'hidden', backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.18)', padding: 30, alignItems: 'center' },
  glassModalIcon: { width: 60, height: 60, borderRadius: 18, backgroundColor: 'rgba(239,68,68,0.2)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  glassModalDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#ef4444' },
  glassModalTitle: { color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 8, letterSpacing: -0.5 },
  glassModalSubtitle: { color: 'rgba(255,255,255,0.45)', fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 26 },
  glassModalButtons: { flexDirection: 'row', gap: 10, width: '100%' },
  glassModalCancel: { flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 14, padding: 14, alignItems: 'center', borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.15)' },
  glassModalCancelText: { color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: '600' },
  glassModalEnd: { flex: 1, backgroundColor: '#ef4444', borderRadius: 14, padding: 14, alignItems: 'center' },
  glassModalEndText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});