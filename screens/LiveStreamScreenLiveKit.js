import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  FlatList,
  Alert,
  Keyboard,
  Platform,
  ActivityIndicator,
  BackHandler,
  Dimensions,
  AppState,
  Switch,
  Image,
  InteractionManager,
} from 'react-native';
import { Room, RoomEvent, Track } from 'livekit-client';
import { registerGlobals, VideoView } from '@livekit/react-native';
import { Camera } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SystemBars } from 'react-native-edge-to-edge';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { useViewerCount } from '../hooks/useViewerCount';
import { useRecentViewers } from '../hooks/useRecentViewers';
import { useEngagedViewers } from '../hooks/useEngagedViewers';
import { useFeatureFlag } from '../hooks/useFeatureFlag';
import { COLORS } from '../constants/theme';
import { useUser } from '../context/UserContext';
import { filterMessage } from '../utils/moderation';

const { width, height } = Dimensions.get('window');
const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL;

export default function LiveStreamScreenLiveKit({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { user: currentUser } = useUser();
  const { title = 'Live Stream', maxQuestions = 5 } = route?.params ?? {};

  // --- Connection state ---
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasPermission, setHasPermission] = useState(null);
  const [roomName, setRoomName] = useState('');
  const [error, setError] = useState(null);
  const [localVideoTrack, setLocalVideoTrack] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connected');

  // --- Stream state ---
  const [streamId, setStreamId] = useState(null);
  const [username, setUsername] = useState('');
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [streamDuration, setStreamDuration] = useState(0);

  // --- Pre-stream settings ---
  const [allowQuestions, setAllowQuestions] = useState(true);
  // NOTE: saveToProfile removed — recording not available on free LiveKit plan

  // --- UI state ---
  const [showEndModal, setShowEndModal] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [showViewerList, setShowViewerList] = useState(false);
  const [viewerListMode, setViewerListMode] = useState('recent');
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // --- Chat & Questions ---
  const [messages, setMessages] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [chatInput, setChatInput] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  const [userStrikes, setUserStrikes] = useState({});

  // --- Refs ---
  const roomRef = useRef(null);
  const flatListRef = useRef(null);
  const currentStreamIdRef = useRef(null);
  const isConnectedRef = useRef(false);
  const isMountedRef = useRef(true);
  const chatChannelRef = useRef(null);
  const questionsChannelRef = useRef(null);
  const pingInterval = useRef(null);
  const durationIntervalRef = useRef(null);
  const backgroundTimeRef = useRef(null);
  const appStateSubscription = useRef(null);

  // --- Viewer hooks ---
  const { viewerCount } = useViewerCount(streamId);
  const { recentViewers } = useRecentViewers(streamId);
  const { engagedViewers } = useEngagedViewers(streamId);
  const { enabled: showEngagedTab } = useFeatureFlag('engaged_viewers_tab');

  // ─── MOUNT ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;

    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Camera permission is required to stream');
      }
    })();

    const name = `bushrann_${currentUser?.id ?? Date.now()}_${Date.now()}`;
    setRoomName(name);

    const keyboardDidShow = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const keyboardDidHide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });

    appStateSubscription.current = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        backgroundTimeRef.current = Date.now();
      } else if (nextAppState === 'active' && backgroundTimeRef.current) {
        const timeInBackground = Date.now() - backgroundTimeRef.current;
        backgroundTimeRef.current = null;
        if (timeInBackground > 30000 && isConnectedRef.current) {
          console.log('[LIVEKIT] App returned after long background, checking connection...');
        }
      }
    });

    return () => {
      isMountedRef.current = false;
      keyboardDidShow.remove();
      keyboardDidHide.remove();
      if (appStateSubscription.current) {
        appStateSubscription.current.remove();
      }
      cleanup();
    };
  }, []);

  // ─── BACK HANDLER ────────────────────────────────────────────────────────────
  useEffect(() => {
    const backAction = () => {
      if (!isConnected) {
        navigation.goBack();
        return true;
      }
      setShowEndModal(true);
      return true;
    };
    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [isConnected]);

  // ─── CLEANUP ─────────────────────────────────────────────────────────────────
  async function cleanup() {
    isMountedRef.current = false;
    isConnectedRef.current = false;

    if (pingInterval.current) {
      clearInterval(pingInterval.current);
      pingInterval.current = null;
    }
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    if (chatChannelRef.current) {
      await supabase.removeChannel(chatChannelRef.current);
      chatChannelRef.current = null;
    }
    if (questionsChannelRef.current) {
      await supabase.removeChannel(questionsChannelRef.current);
      questionsChannelRef.current = null;
    }
    if (roomRef.current) {
      try {
        await roomRef.current.disconnect();
      } catch (e) {
        console.error('[LIVEKIT] Disconnect error:', e);
      }
      roomRef.current = null;
    }
  }

  // ─── START STREAM ─────────────────────────────────────────────────────────────
  const startStream = async () => {
    if (!hasPermission) {
      Alert.alert('Error', 'Camera permission not granted');
      return;
    }
    if (!currentUser) {
      Alert.alert('Error', 'You must be logged in to stream');
      return;
    }

    try {
      registerGlobals();
    } catch (e) {
      // Already initialized – ignore
    }

    setIsConnecting(true);
    setError(null);

    try {
      await supabase
        .from('live_streams')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('is_live', true);

      const { data: profile } = await supabase
        .from('profiles')
        .select('username, avatar_url')
        .eq('id', currentUser.id)
        .single();
      setUsername(profile?.username ?? 'Scholar');

      const response = await fetch(`${SERVER_URL}/api/livekit/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName,
          userId: currentUser.id,
          isHost: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const { token, url } = await response.json();

      const { data: stream, error: streamError } = await supabase
        .from('live_streams')
        .insert({
          user_id: currentUser.id,
          title,
          channel_name: roomName,
          max_questions: maxQuestions,
          is_live: true,
          thumbnail_url: profile?.avatar_url || null,
          allow_questions: allowQuestions,
        })
        .select()
        .single();

      if (streamError) {
        throw new Error('Could not create stream record');
      }

      const currentStreamId = stream.id;
      setStreamId(currentStreamId);
      currentStreamIdRef.current = currentStreamId;

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      roomRef.current = room;

      room.on(RoomEvent.Connected, () => {
        console.log('[LIVEKIT] Connected');
        setIsConnected(true);
        setIsConnecting(false);
        isConnectedRef.current = true;
        setConnectionStatus('connected');
      });

      room.on(RoomEvent.Disconnected, () => {
        console.log('[LIVEKIT] Disconnected');
        setIsConnected(false);
        setLocalVideoTrack(null);
        isConnectedRef.current = false;
      });

      room.on(RoomEvent.Reconnecting, () => {
        console.log('[LIVEKIT] Reconnecting...');
        setConnectionStatus('reconnecting');
      });

      room.on(RoomEvent.Reconnected, () => {
        console.log('[LIVEKIT] Reconnected!');
        setConnectionStatus('connected');
      });

      room.on(RoomEvent.LocalTrackPublished, (publication) => {
        if (publication.track && publication.track.kind === Track.Kind.Video) {
          console.log('[LIVEKIT] Local video track ready');
          setLocalVideoTrack(publication.track);
        }
      });

      await room.connect(url, token);

      setTimeout(async () => {
        const tryEnableCamera = async (attempt = 1) => {
          try {
            console.log(`[LIVEKIT] Enabling camera (attempt ${attempt})...`);
            await room.localParticipant.enableCameraAndMicrophone();
            console.log('[LIVEKIT] Camera enabled successfully');
          } catch (e) {
            console.error(`[LIVEKIT] Camera error (attempt ${attempt}):`, e.message);
            if (attempt < 4) {
              const delay = attempt * 3000;
              console.log(`[LIVEKIT] Retrying in ${delay}ms...`);
              setTimeout(() => tryEnableCamera(attempt + 1), delay);
            } else {
              console.error('[LIVEKIT] Camera failed after 4 attempts');
            }
          }
        };
        tryEnableCamera();
      }, 5000);

      durationIntervalRef.current = setInterval(() => {
        setStreamDuration(prev => prev + 1);
      }, 1000);

      pingInterval.current = setInterval(async () => {
        if (currentStreamIdRef.current) {
          await supabase
            .from('live_streams')
            .update({ last_ping: new Date().toISOString() })
            .eq('id', currentStreamIdRef.current);
        }
      }, 5000);

      subscribeToChat(currentStreamId);
      subscribeToQuestions(currentStreamId);

    } catch (err) {
      console.error('[LIVEKIT] Start stream error:', err);
      setError(err.message);
      setIsConnecting(false);
    }
  };

  // ─── SWITCH CAMERA ───────────────────────────────────────────────────────────
  const switchCamera = async () => {
    if (!roomRef.current) return;
    try {
      const pub = roomRef.current.localParticipant.getTrackPublication(Track.Source.Camera);
      if (pub?.track) {
        await pub.track.switchCamera();
        setIsFrontCamera(prev => !prev);
        console.log('[LIVEKIT] Camera switched');
      }
    } catch (e) {
      console.error('[LIVEKIT] Switch camera error:', e);
    }
  };

  // ─── END STREAM ──────────────────────────────────────────────────────────────
  const endStream = () => {
    setShowEndModal(true);
  };

  const confirmEndStream = useCallback(async () => {
    setShowEndModal(false);
    setIsEnding(true);

    try {
      if (currentStreamIdRef.current) {
        await supabase
          .from('live_streams')
          .update({
            is_live: false,
            ended_at: new Date().toISOString(),
          })
          .eq('id', currentStreamIdRef.current);
      }
    } catch (e) {
      console.error('[END] Supabase cleanup error:', e);
    }

    await cleanup();

    if (isMountedRef.current) {
      setIsEnding(false);
      setIsConnected(false);
      setLocalVideoTrack(null);
    }

    navigation.goBack();
  }, [navigation]);

  // ─── SUPABASE CHAT SUBSCRIPTION ──────────────────────────────────────────────
  function subscribeToChat(sid) {
    chatChannelRef.current = supabase
      .channel(`live_messages_${sid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'live_messages', filter: `stream_id=eq.${sid}` },
        (payload) => {
          const moderationResult = filterMessage(payload.new.message, payload.new.username);

          if (!moderationResult.allowed) {
            console.log('[MODERATION] Blocked message from:', payload.new.username);
            const userId = payload.new.user_id;
            const newStrikes = (userStrikes[userId] || 0) + 1;
            setUserStrikes(prev => ({ ...prev, [userId]: newStrikes }));
            return;
          }

          const displayMessage = { ...payload.new, message: moderationResult.filteredText };
          setMessages(prev => [...prev, displayMessage]);
          setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
        }
      )
      .subscribe();
  }

  // ─── SUPABASE QUESTIONS SUBSCRIPTION ─────────────────────────────────────────
  function subscribeToQuestions(sid) {
    questionsChannelRef.current = supabase
      .channel(`live_questions_${sid}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'live_questions', filter: `stream_id=eq.${sid}` },
        () => loadQuestions(sid)
      )
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

  // ─── SEND CHAT MESSAGE ────────────────────────────────────────────────────────
  async function sendMessage() {
    if (!chatInput.trim() || !streamId || !currentUser) return;
    const msg = chatInput.replace(/<[^>]*>/g, '').trim();

    const moderationResult = filterMessage(msg, username);
    if (!moderationResult.allowed) {
      Alert.alert('Message Blocked', 'Your message contains inappropriate content.');
      return;
    }

    setChatInput('');
    await supabase.from('live_messages').insert({
      stream_id: streamId,
      user_id: currentUser.id,
      username,
      message: moderationResult.filteredText,
    });
  }

  // ─── QUESTIONS ACTIONS ────────────────────────────────────────────────────────
  async function selectQuestion(question) {
    setSelectedQuestion(question);
    await supabase.from('live_questions').update({ is_selected: true }).eq('id', question.id);
  }

  async function markAnswered() {
    if (!selectedQuestion) return;
    await supabase
      .from('live_questions')
      .update({ is_answered: true, is_selected: false })
      .eq('id', selectedQuestion.id);
    setSelectedQuestion(null);
    loadQuestions(streamId);
  }

  async function dismissQuestion() {
    if (!selectedQuestion) return;
    await supabase
      .from('live_questions')
      .update({ is_selected: false })
      .eq('id', selectedQuestion.id);
    setSelectedQuestion(null);
  }

  // ─── LOADING / ERROR SCREENS ──────────────────────────────────────────────────
  if (hasPermission === null) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.gold} />
        <Text style={styles.loadingText}>Requesting camera permission...</Text>
      </View>
    );
  }

  if (hasPermission === false) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.errorText}>Camera permission denied</Text>
        <AnimatedButton style={styles.actionButton} onPress={() => navigation.goBack()}>
          <Text style={styles.actionButtonText}>Go Back</Text>
        </AnimatedButton>
      </View>
    );
  }

  if (isConnecting) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.gold} />
        <Text style={styles.loadingText}>Starting your live stream...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.errorText}>Error: {error}</Text>
        <AnimatedButton style={styles.actionButton} onPress={() => setError(null)}>
          <Text style={styles.actionButtonText}>Retry</Text>
        </AnimatedButton>
      </View>
    );
  }

  if (isEnding) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.gold} />
        <Text style={styles.loadingText}>Ending stream...</Text>
      </View>
    );
  }

  // ─── PRE-LIVE SCREEN ──────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <View style={styles.loadingContainer}>
        <SystemBars style="light" />
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

          {/* No recording notice */}
          <View style={styles.noticeBox}>
            <Text style={styles.noticeIcon}>📢</Text>
            <Text style={styles.noticeText}>
              Live streams are not saved or recorded. Viewers can only watch while you are live.
            </Text>
          </View>

          <AnimatedButton style={styles.goLiveBtn} onPress={startStream}>
            <Text style={styles.goLiveBtnText}>Start Streaming</Text>
          </AnimatedButton>

          <AnimatedButton
            style={styles.cancelBtn}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </AnimatedButton>
        </View>
      </View>
    );
  }

  // ─── LIVE SCREEN ──────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <SystemBars style="light" />

      {localVideoTrack ? (
        <VideoView
          style={StyleSheet.absoluteFill}
          videoTrack={localVideoTrack}
          mirror={true}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.cameraFeedPlaceholder]}>
          <ActivityIndicator size="large" color={COLORS.gold} />
          <Text style={styles.cameraWaitText}>Camera starting...</Text>
        </View>
      )}

      {connectionStatus !== 'connected' && (
        <View style={styles.reconnectOverlay}>
          {connectionStatus === 'reconnecting' ? (
            <>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.reconnectText}>Reconnecting...</Text>
            </>
          ) : (
            <>
              <Text style={styles.reconnectIcon}>⚠️</Text>
              <Text style={styles.reconnectText}>Connection lost</Text>
            </>
          )}
        </View>
      )}

      {/* TOP BAR */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.liveBadge}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
          <Text style={styles.liveDuration}>
            {String(Math.floor(streamDuration / 3600)).padStart(2, '0')}:
            {String(Math.floor((streamDuration % 3600) / 60)).padStart(2, '0')}:
            {String(streamDuration % 60).padStart(2, '0')}
          </Text>
        </View>

        <AnimatedButton style={styles.viewerBadge} onPress={() => setShowViewerList(!showViewerList)}>
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
                  : 'Recent Viewers'}
                {' '}
                ({showEngagedTab && viewerListMode === 'engaged'
                  ? engagedViewers.length
                  : viewerCount})
              </Text>
              <AnimatedButton onPress={() => setShowViewerList(false)}>
                <Text style={styles.closeListText}>✕</Text>
              </AnimatedButton>
            </View>

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
                  {item.badge && <Text>{item.badge}</Text>}
                </View>
              )}
              ListEmptyComponent={
                <Text style={styles.emptyViewerList}>
                  {showEngagedTab && viewerListMode === 'engaged'
                    ? 'No engaged viewers yet'
                    : 'No viewers yet'}
                </Text>
              }
            />
          </View>
        )}
      </View>

      {/* Question Banner */}
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

      {/* BOTTOM PANEL */}
      <View style={[styles.bottomPanel, { paddingBottom: insets.bottom + 8 }]}>
        <View style={styles.tabs}>
          <AnimatedButton
            style={[styles.tab, activeTab === 'chat' && styles.tabActive]}
            onPress={() => setActiveTab('chat')}
          >
            <Text style={[styles.tabText, activeTab === 'chat' && styles.tabTextActive]}>💬 Chat</Text>
          </AnimatedButton>
          <AnimatedButton
            style={[styles.tab, activeTab === 'questions' && styles.tabActive]}
            onPress={() => setActiveTab('questions')}
          >
            <Text style={[styles.tabText, activeTab === 'questions' && styles.tabTextActive]}>
              ❓ Questions{questions.length > 0 ? ` (${questions.length})` : ''}
            </Text>
          </AnimatedButton>
        </View>

        {activeTab === 'chat' && (
          <>
            <FlatList
              ref={flatListRef}
              data={messages}
              keyExtractor={(item) => String(item.id)}
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
              <TextInput
                style={styles.chatInput}
                value={chatInput}
                onChangeText={setChatInput}
                placeholder="Say something..."
                placeholderTextColor="#64748b"
                onSubmitEditing={sendMessage}
                returnKeyType="send"
              />
              <AnimatedButton style={styles.sendBtn} onPress={sendMessage}>
                <Text style={styles.sendBtnText}>Send</Text>
              </AnimatedButton>
            </View>
          </>
        )}

        {activeTab === 'questions' && (
          <FlatList
            data={questions}
            keyExtractor={(item) => String(item.id)}
            style={styles.chatList}
            ListEmptyComponent={
              <View style={styles.emptyQuestions}>
                <Text style={styles.emptyQuestionsText}>No questions yet</Text>
                <Text style={styles.emptyQuestionsSubtext}>
                  Viewers can submit questions during your live
                </Text>
              </View>
            }
            renderItem={({ item }) => (
              <AnimatedButton
                style={[styles.questionItem, item.is_selected && styles.questionItemSelected]}
                onPress={() => selectQuestion(item)}
              >
                <Text style={styles.questionUsername}>@{item.username}</Text>
                <Text style={styles.questionText}>{item.question}</Text>
                {item.is_selected && (
                  <Text style={styles.questionSelectedBadge}>📌 On screen</Text>
                )}
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

      {/* End Stream Glass Modal */}
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

// ─── STYLES ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  loadingText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  errorText: { color: '#ef4444', fontSize: 16, marginBottom: 20, textAlign: 'center' },
  actionButton: {
    backgroundColor: COLORS.gold,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 25,
    marginTop: 16,
  },
  actionButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  // Pre-stream screen
  preStreamContainer: { width: '100%', padding: 20, alignItems: 'center' },
  preStreamTitle: { color: '#fff', fontSize: 28, fontWeight: 'bold', marginBottom: 8 },
  preStreamSubtitle: { color: COLORS.gold, fontSize: 16, marginBottom: 30 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  settingInfo: { flex: 1, marginRight: 12 },
  settingLabel: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 4 },
  settingDescription: { color: 'rgba(255,255,255,0.6)', fontSize: 13 },

  // No recording notice
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 12,
    padding: 14,
    width: '100%',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    gap: 10,
  },
  noticeIcon: { fontSize: 18 },
  noticeText: {
    flex: 1,
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    lineHeight: 19,
  },

  goLiveBtn: {
    backgroundColor: '#ef4444',
    borderRadius: 12,
    paddingHorizontal: 40,
    paddingVertical: 16,
    width: '100%',
    alignItems: 'center',
    marginTop: 4,
  },
  goLiveBtnText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  cancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    paddingHorizontal: 40,
    paddingVertical: 16,
    width: '100%',
    alignItems: 'center',
    marginTop: 12,
  },
  cancelBtnText: { color: 'rgba(255,255,255,0.7)', fontSize: 16, fontWeight: '600' },

  // Camera
  cameraFeedPlaceholder: {
    backgroundColor: '#1a1a1a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cameraWaitText: { color: '#fff', marginTop: 12, fontSize: 14 },

  // Top bar
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 10,
    zIndex: 10,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ef4444',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    gap: 6,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  liveText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  liveDuration: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  viewerBadge: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  viewerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  endBtn: {
    marginLeft: 'auto',
    backgroundColor: 'rgba(239,68,68,0.9)',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  endBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Viewer list panel
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
  viewerListTitle: { color: '#fff', fontSize: 14, fontWeight: '700' },
  closeListText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  viewerList: { maxHeight: 250 },
  viewerItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 10 },
  viewerAvatar: { width: 32, height: 32, borderRadius: 16 },
  viewerAvatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerAvatarText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  viewerUsername: { color: '#fff', fontSize: 13, fontWeight: '600' },
  emptyViewerList: { color: '#64748b', fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  viewerListTabs: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  viewerListTab: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
  },
  viewerListTabActive: { backgroundColor: COLORS.gold },
  viewerListTabText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  viewerListTabTextActive: { color: '#fff' },

  // Question banner
  questionBanner: {
    position: 'absolute',
    top: 100,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.gold,
    zIndex: 20,
  },
  questionBannerLabel: { color: COLORS.gold, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  questionBannerText: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 10 },
  questionBannerActions: { flexDirection: 'row', gap: 10 },
  answeredBtn: {
    flex: 1,
    backgroundColor: '#10b981',
    borderRadius: 8,
    padding: 8,
    alignItems: 'center',
  },
  answeredBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  dismissBtn: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 8,
    padding: 8,
    alignItems: 'center',
  },
  dismissBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  // Bottom panel
  bottomPanel: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 12 },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  tabActive: { backgroundColor: COLORS.gold },
  tabText: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  chatList: { maxHeight: height * 0.25, marginBottom: 8 },
  chatMessage: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
  chatUsername: { color: COLORS.gold, fontWeight: '700', fontSize: 13 },
  chatText: { color: '#fff', fontSize: 13 },
  chatInputRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  chatInput: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  sendBtn: {
    backgroundColor: COLORS.gold,
    borderRadius: 20,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  sendBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  emptyQuestions: { padding: 20, alignItems: 'center' },
  emptyQuestionsText: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  emptyQuestionsSubtext: { color: '#64748b', fontSize: 13, textAlign: 'center' },
  questionItem: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  questionItemSelected: {
    borderWidth: 1,
    borderColor: COLORS.gold,
    backgroundColor: 'rgba(245,166,35,0.2)',
  },
  questionUsername: { color: COLORS.gold, fontSize: 12, fontWeight: '700', marginBottom: 3 },
  questionText: { color: '#fff', fontSize: 14 },
  questionSelectedBadge: { color: COLORS.gold, fontSize: 11, marginTop: 4, fontWeight: '600' },
  cameraControls: { flexDirection: 'row', justifyContent: 'center', marginBottom: 8 },
  flipBtnBottom: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  flipBtnBottomText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  // Reconnect overlay
  reconnectOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  reconnectText: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: 16 },
  reconnectIcon: { fontSize: 48 },

  // End stream modal
  modalOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  glassModal: {
    width: 300,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.18)',
    padding: 30,
    alignItems: 'center',
  },
  glassModalIcon: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: 'rgba(239,68,68,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  glassModalDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#ef4444' },
  glassModalTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 8,
    letterSpacing: -0.5,
  },
  glassModalSubtitle: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 26,
  },
  glassModalButtons: { flexDirection: 'row', gap: 10, width: '100%' },
  glassModalCancel: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  glassModalCancelText: { color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: '600' },
  glassModalEnd: {
    flex: 1,
    backgroundColor: '#ef4444',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
  },
  glassModalEndText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});