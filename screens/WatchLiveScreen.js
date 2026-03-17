import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TextInput, FlatList,
  Keyboard, Platform, ActivityIndicator,
  Animated, Dimensions, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createAgoraRtcEngine,
  ChannelProfileType,
  ClientRoleType,
  RtcSurfaceView,
} from 'react-native-agora';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { useViewerTracking } from '../hooks/useViewerTracking';
import { useViewerCount } from '../hooks/useViewerCount';
import { COLORS } from '../constants/theme';

const { width, height } = Dimensions.get('window');
const AGORA_APP_ID = process.env.EXPO_PUBLIC_AGORA_APP_ID;
const REACTIONS = ['❤️', '🤲', '☪️', '🌟', '👍'];
const HOST_TIMEOUT_MS = 30000; // ⏱️ TIMEOUT: 30 seconds

export default function WatchLiveScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { stream } = route.params ?? {};

  const [loading, setLoading] = useState(false);
  const [joining, setJoining] = useState(true);
  const [hostUid, setHostUid] = useState(0);
  const [hostJoined, setHostJoined] = useState(false);
  const [streamEnded, setStreamEnded] = useState(false);
  const [messages, setMessages] = useState([]);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [chatInput, setChatInput] = useState('');
  const [questionInput, setQuestionInput] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  const [currentUser, setCurrentUser] = useState(null);
  const [username, setUsername] = useState('');
  const [questionsLeft, setQuestionsLeft] = useState(stream.max_questions ?? 5);
  const [floatingReactions, setFloatingReactions] = useState([]);
  const [hostTimeoutReached, setHostTimeoutReached] = useState(false); // ⏱️ TIMEOUT: Track if we hit timeout
  const [retryCount, setRetryCount] = useState(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const hasJoinedRef = useRef(false);

  const engineRef = useRef(null);
  const flatListRef = useRef(null);
  const reactionId = useRef(0);
  const isCleaningUp = useRef(false);
  const hostWaitTimeoutRef = useRef(null);
  const chatChannelRef = useRef(null);
  const questionsChannelRef = useRef(null);
  const streamChannelRef = useRef(null);

  // ✅ NEW: Use the viewer tracking hooks
  useViewerTracking(stream.id, false, currentUser, retryCount); // Track this viewer (isStreamer = false)
  const { viewerCount } = useViewerCount(stream.id); // Get real-time viewer count

  useEffect(() => {
    setup();
    return () => {
      if (!isCleaningUp.current) {
        cleanup();
      }
    };
  }, []);

  // ⏱️ TIMEOUT: Cleanup timeout on unmount
  useEffect(() => {
      const keyboardDidShow = Keyboard.addListener('keyboardDidShow', (e) => {
        setKeyboardHeight(e.endCoordinates.height);
      });
      const keyboardDidHide = Keyboard.addListener('keyboardDidHide', () => {
        setKeyboardHeight(0);
      });

      return () => {
        if (hostWaitTimeoutRef.current) {
          clearTimeout(hostWaitTimeoutRef.current);
        }
        keyboardDidShow.remove();
        keyboardDidHide.remove();
      };
    }, []);

  // ⏱️ TIMEOUT: Start timeout when joining completes but host hasn't joined
  useEffect(() => {
    if (!joining && !hostJoined && !hostTimeoutReached && !streamEnded) {
      __DEV__ && console.log('⏱️ TIMEOUT: Starting 30s host wait timer...');
      hostWaitTimeoutRef.current = setTimeout(() => {
        __DEV__ && console.log('⏱️ TIMEOUT: Host wait timeout reached!');
        setHostTimeoutReached(true);
      }, HOST_TIMEOUT_MS);
    }

    // Clear timeout if host joins or stream ends
    if ((hostJoined || streamEnded) && hostWaitTimeoutRef.current) {
      __DEV__ && console.log('⏱️ TIMEOUT: Clearing timer - host joined or stream ended');
      clearTimeout(hostWaitTimeoutRef.current);
      hostWaitTimeoutRef.current = null;
    }
  }, [joining, hostJoined, hostTimeoutReached, streamEnded]);

  async function setup() {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        Alert.alert('Error', 'Please login to watch streams');
        navigation.goBack();
        return;
      }
      setCurrentUser(user);

      const { data: profile } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', user.id)
        .single();
      setUsername(profile?.username ?? 'viewer');

      const token = stream.viewer_token;

      if (!token) {
        Alert.alert('Error', 'Stream token not available.');
        navigation.goBack();
        return;
      }

      // ✅ REMOVED: No more increment_viewer_count RPC call
      // The useViewerTracking hook now handles adding this user to stream_viewers table
      hasJoinedRef.current = true;

      const engine = createAgoraRtcEngine();
      engineRef.current = engine;

      engine.initialize({ appId: AGORA_APP_ID });
      engine.setChannelProfile(ChannelProfileType.ChannelProfileLiveBroadcasting);
      engine.setClientRole(ClientRoleType.ClientRoleAudience);
      engine.enableVideo();

      await engine.joinChannel(token, stream.channel_name, 0, {
        clientRoleType: ClientRoleType.ClientRoleAudience,
      });

      setJoining(false);

      engine.addListener('onUserJoined', (connection, remoteUid) => {
        setHostUid(remoteUid);
        setHostJoined(true);
        setHostTimeoutReached(false); // ⏱️ TIMEOUT: Reset timeout state if host joins
      });

      engine.addListener('onRemoteVideoStateChanged', (connection, remoteUid, state, reason, elapsed) => {
        if (state === 2) {
          setHostUid(remoteUid);
          setHostJoined(true);
          setHostTimeoutReached(false); // ⏱️ TIMEOUT: Reset timeout state
        }
      });

      engine.addListener('onUserOffline', (connection, remoteUid, reason) => {
        __DEV__ && console.log('Host offline, reason:', reason);
        setHostJoined(false);
        if (reason === 0) {
          setStreamEnded(true);
        }
      });

      engine.addListener('onError', (err) => {
        __DEV__ && console.log('Agora error:', err);
      });

      setLoading(false);

      const { data: existingMessages } = await supabase
        .from('live_messages')
        .select('*')
        .eq('stream_id', stream.id)
        .order('created_at', { ascending: true })
        .limit(50);
      setMessages(existingMessages ?? []);

      const { data: selectedQ } = await supabase
        .from('live_questions')
        .select('*')
        .eq('stream_id', stream.id)
        .eq('is_selected', true)
        .single();
      if (selectedQ) setSelectedQuestion(selectedQ);

      const { count } = await supabase
        .from('live_questions')
        .select('*', { count: 'exact' })
        .eq('stream_id', stream.id)
        .eq('user_id', user.id);
      setQuestionsLeft(Math.max(0, (stream.max_questions ?? 5) - (count ?? 0)));

      subscribeToChat();
      subscribeToQuestions();
      subscribeToStream();
    } catch (e) {
      __DEV__ && console.error('Setup error:', e);
      Alert.alert('Error', 'Failed to join stream.');
      navigation.goBack();
    }
  }

  // ⏱️ TIMEOUT: Retry function to rejoin
  async function handleRetryJoin() {
    __DEV__ && console.log('🔄 RETRY: User clicked try again');
    setHostTimeoutReached(false);
    setJoining(true);
    setRetryCount(prev => prev + 1);
    
    // Cleanup existing engine
    if (engineRef.current) {
      try {
        engineRef.current.removeAllListeners();
        await engineRef.current.leaveChannel();
        engineRef.current.release();
      } catch (e) {
        __DEV__ && console.log('Retry cleanup error:', e);
      }
      engineRef.current = null;
    }
    
    // Small delay then rejoin
    setTimeout(() => {
      setup();
    }, 1000);
  }

  async function cleanup() {
    if (isCleaningUp.current) return;
    isCleaningUp.current = true;

    __DEV__ && console.log('🧹 Cleanup called');

    // ⏱️ TIMEOUT: Clear timeout on cleanup
    if (hostWaitTimeoutRef.current) {
      clearTimeout(hostWaitTimeoutRef.current);
      hostWaitTimeoutRef.current = null;
    }

    // ✅ REMOVED: No more decrement_viewer_count RPC call
    // The useViewerTracking hook now handles removing this user from stream_viewers table
    // (it runs cleanup on unmount)
    if (chatChannelRef.current) { await supabase.removeChannel(chatChannelRef.current); chatChannelRef.current = null; }
    if (questionsChannelRef.current) { await supabase.removeChannel(questionsChannelRef.current); questionsChannelRef.current = null; }
    if (streamChannelRef.current) { await supabase.removeChannel(streamChannelRef.current); streamChannelRef.current = null; }

    if (engineRef.current) {
      try {
        engineRef.current.removeAllListeners();
        engineRef.current.leaveChannel();
        engineRef.current.release();
      } catch (e) {
        __DEV__ && console.log('Engine cleanup error:', e);
      }
      engineRef.current = null;
    }
  }

  function subscribeToChat() {
    chatChannelRef.current = supabase.channel(`watch_messages_${stream.id}`);
    chatChannelRef.current
      .on('postgres_changes', { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'live_messages', 
        filter: `stream_id=eq.${stream.id}` 
      }, (payload) => {
        setMessages(prev => [...prev, payload.new]);
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      })
      .subscribe();
  }

  function subscribeToQuestions() {
    questionsChannelRef.current = supabase.channel(`watch_questions_${stream.id}`);
    questionsChannelRef.current
      .on('postgres_changes', { 
        event: '*', 
        schema: 'public', 
        table: 'live_questions', 
        filter: `stream_id=eq.${stream.id}` 
      }, (payload) => {
        if (payload.new.is_selected) {
          setSelectedQuestion(payload.new);
        } else if (!payload.new.is_selected && payload.new.id === selectedQuestion?.id) {
          setSelectedQuestion(null);
        }
      })
      .subscribe();
  }

  function subscribeToStream() {
    streamChannelRef.current = supabase.channel(`watch_stream_${stream.id}`);
    streamChannelRef.current
      .on('postgres_changes', { 
        event: 'DELETE', 
        schema: 'public', 
        table: 'live_streams', 
        filter: `id=eq.${stream.id}` 
      }, () => {
        __DEV__ && console.log('Stream deleted, ending...');
        setStreamEnded(true);
      })
      .on('postgres_changes', { 
        event: 'UPDATE', 
        schema: 'public', 
        table: 'live_streams', 
        filter: `id=eq.${stream.id}` 
      }, (payload) => {
        // ✅ REMOVED: setViewerCount - now handled by useViewerCount hook
        if (!payload.new.is_live) {
          setStreamEnded(true);
        }
      })
      .subscribe();
  }

  async function sendMessage() {
    if (!chatInput.trim() || !stream.id || !currentUser) return;
    const msg = chatInput.trim();
    setChatInput('');

    try {
      await supabase.from('live_messages').insert({ 
        stream_id: stream.id, 
        user_id: currentUser.id, 
        username, 
        message: msg 
      });
    } catch (e) {
      __DEV__ && console.log('Failed to send message:', e);
    }
  }

  async function submitQuestion() {
    if (!questionInput.trim() || !currentUser) return;
    
    // Check if questions are allowed for this stream
    const { data: streamData } = await supabase
      .from('live_streams')
      .select('allow_questions')
      .eq('id', stream.id)
      .single();
      
    if (!streamData?.allow_questions) {
      Alert.alert('Questions Disabled', 'The scholar is not accepting questions right now.');
      return;
    }
    
    if (questionsLeft <= 0) { 
      Alert.alert('Limit Reached', `The scholar has set a limit of ${stream.max_questions} questions per viewer.`); 
      return; 
    }
    
    const q = questionInput.trim();
    setQuestionInput('');

    try {
      await supabase.from('live_questions').insert({ 
        stream_id: stream.id, 
        user_id: currentUser.id, 
        username, 
        question: q 
      });
      setQuestionsLeft(prev => prev - 1);
    } catch (e) {
      __DEV__ && console.log('Failed to submit question:', e);
    }
  }

  function sendReaction(emoji) {
    const id = reactionId.current++;
    const startX = Math.random() * (width - 60);
    const anim = new Animated.Value(0);
    setFloatingReactions(prev => [...prev, { id, emoji, startX, anim }]);
    Animated.timing(anim, { toValue: 1, duration: 2000, useNativeDriver: true }).start(() => {
      setFloatingReactions(prev => prev.filter(r => r.id !== id));
    });

    if (stream?.id && currentUser) {
      // 🔧 FIXED: Proper async/await with try-catch
      const saveReaction = async () => {
        try {
          await supabase.from('live_reactions').insert({ 
            stream_id: stream.id, 
            user_id: currentUser.id, 
            reaction: emoji 
          });
        } catch (e) {
          __DEV__ && console.log('Reaction error:', e);
        }
      };
      saveReaction();
    }
  }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#ef4444" size="large" />
        <Text style={styles.loadingText}>Joining live stream...</Text>
      </View>
    );
  }

  if (streamEnded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={{ fontSize: 48 }}>🎙️</Text>
        <Text style={styles.loadingText}>Stream has ended</Text>
        <AnimatedButton style={styles.goBackBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.goBackBtnText}>Go Back</Text>
        </AnimatedButton>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <RtcSurfaceView 
        style={StyleSheet.absoluteFill} 
        canvas={{ uid: hostUid, renderMode: 1 }} 
        zOrderMediaOverlay={true}
      />

      {joining && (
        <View style={styles.connectingOverlay}>
          <ActivityIndicator color="#fff" size="small" />
          <Text style={styles.connectingText}>Joining...</Text>
        </View>
      )}

      {/* ⏱️ TIMEOUT: Show timeout UI instead of infinite "Waiting for host" */}
      {!hostJoined && !joining && hostTimeoutReached && (
        <View style={styles.timeoutContainer}>
          <Text style={{ fontSize: 48 }}>⏱️</Text>
          <Text style={styles.timeoutTitle}>Connection Timed Out</Text>
          <Text style={styles.timeoutText}>
            The host is taking longer than expected to connect.
          </Text>
          <AnimatedButton style={styles.retryBtn} onPress={handleRetryJoin}>
            <Text style={styles.retryBtnText}>🔄 Try Again</Text>
          </AnimatedButton>
          <AnimatedButton style={[styles.retryBtn, { backgroundColor: '#4b5563', marginTop: 8 }]} onPress={() => navigation.goBack()}>
            <Text style={styles.retryBtnText}>← Go Back</Text>
          </AnimatedButton>
        </View>
      )}

      {/* Original waiting UI - only show if NOT timed out */}
      {!hostJoined && !joining && !hostTimeoutReached && (
        <View style={styles.waitingContainer}>
          <ActivityIndicator color="#ef4444" size="large" />
          <Text style={styles.waitingText}>Waiting for host...</Text>
        </View>
      )}

      {floatingReactions.map(r => (
        <Animated.Text key={r.id} style={[styles.floatingReaction, {
          left: r.startX,
          transform: [{ translateY: r.anim.interpolate({ inputRange: [0, 1], outputRange: [height * 0.7, height * 0.2] }) }],
          opacity: r.anim.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
        }]}>{r.emoji}</Animated.Text>
      ))}

      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.liveBadge}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
        <Text style={styles.streamTitle} numberOfLines={1}>{stream.title}</Text>
        <View style={styles.viewerBadge}>
          <Text style={styles.viewerText}>👁️ {viewerCount}</Text>
        </View>
        <AnimatedButton style={styles.closeBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.closeBtnText}>✕</Text>
        </AnimatedButton>
      </View>

      {selectedQuestion && (
        <View style={styles.questionBanner}>
          <Text style={styles.questionBannerLabel}>❓ Question from @{selectedQuestion.username}</Text>
          <Text style={styles.questionBannerText}>{selectedQuestion.question}</Text>
        </View>
      )}

      <View style={[styles.bottomPanel, { paddingBottom: insets.bottom + 8 }]}>
        <View style={styles.tabs}>
          <AnimatedButton style={[styles.tab, activeTab === 'chat' && styles.tabActive]} onPress={() => setActiveTab('chat')}>
            <Text style={[styles.tabText, activeTab === 'chat' && styles.tabTextActive]}>💬 Chat</Text>
          </AnimatedButton>
          <AnimatedButton style={[styles.tab, activeTab === 'question' && styles.tabActive]} onPress={() => setActiveTab('question')}>
            <Text style={[styles.tabText, activeTab === 'question' && styles.tabTextActive]}>❓ Ask ({questionsLeft} left)</Text>
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
            <View style={[styles.chatInputRow, { marginBottom: Math.max(0, keyboardHeight - 45) }]}>
              <TextInput style={styles.chatInput} value={chatInput} onChangeText={setChatInput}
                placeholder="Say something..." placeholderTextColor="#64748b" onSubmitEditing={sendMessage} />
              <AnimatedButton style={styles.sendBtn} onPress={sendMessage}>
                <Text style={styles.sendBtnText}>Send</Text>
              </AnimatedButton>
            </View>
          </>
        )}

        {activeTab === 'question' && (
          <View style={styles.questionInputContainer}>
            {stream.allow_questions === false ? (
              // Questions disabled by streamer
              <View style={styles.disabledContainer}>
                <Text style={styles.disabledEmoji}>🚫</Text>
                <Text style={styles.disabledTitle}>Questions Disabled</Text>
                <Text style={styles.disabledText}>
                  The scholar is not accepting questions during this stream.
                </Text>
              </View>
            ) : (
              // Questions allowed
              <>
                <Text style={styles.questionHint}>
                  Ask the scholar a question. You have {questionsLeft} question{questionsLeft !== 1 ? 's' : ''} left.
                </Text>
                <View style={[styles.chatInputRow, { marginBottom: keyboardHeight > 0 ? keyboardHeight : 0 }]}>
                  <TextInput style={styles.chatInput} value={questionInput} onChangeText={setQuestionInput}
                    placeholder="Type your question..." placeholderTextColor="#64748b" multiline maxLength={200} />
                  <AnimatedButton style={[styles.sendBtn, questionsLeft <= 0 && { backgroundColor: COLORS.goldDark }]}
                    onPress={submitQuestion} disabled={questionsLeft <= 0}>
                    <Text style={styles.sendBtnText}>Ask</Text>
                  </AnimatedButton>
                </View>
              </>
            )}
          </View>
        )}

        <View style={styles.reactionsRow}>
          {REACTIONS.map(emoji => (
            <AnimatedButton key={emoji} style={styles.reactionBtn} onPress={() => sendReaction(emoji)}>
              <Text style={styles.reactionEmoji}>{emoji}</Text>
            </AnimatedButton>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#000' },
  loadingContainer: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', gap: 16 },
  loadingText:      { color: '#fff', fontSize: 16, fontWeight: '600' },
  waitingContainer: { ...StyleSheet.absoluteFillObject, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 5 },
  waitingText:      { color: '#fff', fontSize: 15 },
  // ⏱️ TIMEOUT: New styles for timeout UI
  timeoutContainer: { ...StyleSheet.absoluteFillObject, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 5, padding: 32 },
  timeoutTitle:     { color: '#ef4444', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  timeoutText:      { color: '#94a3b8', fontSize: 14, textAlign: 'center', marginBottom: 16 },
  retryBtn:         { backgroundColor: COLORS.gold, borderRadius: 12, paddingHorizontal: 32, paddingVertical: 14, minWidth: 200, alignItems: 'center' },
  retryBtnText:     { color: '#fff', fontWeight: '700', fontSize: 16 },
  floatingReaction: { position: 'absolute', fontSize: 32, zIndex: 100 },
  topBar:       { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8, zIndex: 10 },
  liveBadge:    { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ef4444', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, gap: 6 },
  liveDot:      { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  liveText:     { color: '#fff', fontWeight: '800', fontSize: 13 },
  streamTitle:  { flex: 1, color: '#fff', fontWeight: '600', fontSize: 14 },
  viewerBadge:  { backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  viewerText:   { color: '#fff', fontSize: 13, fontWeight: '600' },
  closeBtn:     { backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20, width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  closeBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  questionBanner:      { position: 'absolute', top: 100, left: 16, right: 16, backgroundColor: 'rgba(245,166,35,0.9)', borderRadius: 14, padding: 14, zIndex: 20 },
  questionBannerLabel: { color: '#fff', fontSize: 12, fontWeight: '700', marginBottom: 4 },
  questionBannerText:  { color: '#fff', fontSize: 15, fontWeight: '600' },
  bottomPanel: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 12 },
  tabs:          { flexDirection: 'row', gap: 8, marginBottom: 8 },
  tab:           { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.1)' },
  tabActive:     { backgroundColor: COLORS.gold },
  tabText:       { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  chatList:    { maxHeight: height * 0.25, marginBottom: 8 },
  chatMessage: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
  chatUsername: { 
    color: COLORS.gold, 
    fontWeight: '700', 
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2
  },
  chatText: { 
    color: '#fff', 
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2
  },
  chatInputRow:         { flexDirection: 'row', gap: 8, marginBottom: 8 },
  chatInput: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8, color: 'rgba(255,255,255,0.9)', fontSize: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  sendBtn:              { backgroundColor: COLORS.gold, borderRadius: 20, paddingHorizontal: 16, justifyContent: 'center' },
  sendBtnText:          { color: '#fff', fontWeight: '700', fontSize: 13 },
  questionInputContainer: { marginBottom: 8 },
  questionHint:           { color: '#94a3b8', fontSize: 12, marginBottom: 8 },
  reactionsRow:  { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 8 },
  reactionBtn:   { padding: 8 },
  reactionEmoji: { fontSize: 26 },
  goBackBtn:     { backgroundColor: COLORS.gold, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  goBackBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  connectingOverlay: {
    position: 'absolute',
    top: 100,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 50,
  },
  connectingText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  disabledContainer: {
    alignItems: 'center',
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  disabledEmoji: {
    fontSize: 40,
    marginBottom: 12,
  },
  disabledTitle: {
    color: '#ef4444',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  disabledText: {
    color: '#94a3b8',
    fontSize: 14,
    textAlign: 'center',
  },
});