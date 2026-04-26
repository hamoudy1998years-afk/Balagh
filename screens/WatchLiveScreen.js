import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, FlatList,
  Keyboard, Platform, ActivityIndicator,
  Animated, Dimensions, Modal, Pressable,
} from 'react-native';
import ModernDialog from './ModernDialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SystemBars } from 'react-native-edge-to-edge';
import { Room, RoomEvent, Track } from 'livekit-client';
import * as WebBrowser from 'expo-web-browser';
import { WebView } from 'react-native-webview';
import { registerGlobals, VideoView } from '@livekit/react-native';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { useViewerTracking } from '../hooks/useViewerTracking';
import { useViewerCount } from '../hooks/useViewerCount';
import { COLORS } from '../constants/theme';
import { useUser } from '../context/UserContext';

const { width, height } = Dimensions.get('window');
const TOKEN_SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL;
const REACTIONS = ['❤️', '🤲', '☪️', '🌟', '👍'];
const HOST_TIMEOUT_MS = 30000;

export default function WatchLiveScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { stream } = route.params ?? {};

  const [joining, setJoining] = useState(true);
  const [hostVideoTrack, setHostVideoTrack] = useState(null);
  const [hostJoined, setHostJoined] = useState(false);
  const [streamEnded, setStreamEnded] = useState(false);
  const [messages, setMessages] = useState([]);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [chatInput, setChatInput] = useState('');
  const [questionInput, setQuestionInput] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  const { user: currentUser } = useUser();
  const [username, setUsername] = useState('');
  const [questionsLeft, setQuestionsLeft] = useState(stream.max_questions ?? 5);
  const [floatingReactions, setFloatingReactions] = useState([]);
  const [hostTimeoutReached, setHostTimeoutReached] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [dialog, setDialog] = useState({ visible: false, title: '', message: '', type: 'info', buttons: [] });
  const [donateModal, setDonateModal] = useState(false);
  const [donateAmount, setDonateAmount] = useState('');
  const [donating, setDonating] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState(null);

  const roomRef = useRef(null);
  const flatListRef = useRef(null);
  const reactionId = useRef(0);
  const isCleaningUp = useRef(false);
  const hostWaitTimeoutRef = useRef(null);
  const chatChannelRef = useRef(null);
  const questionsChannelRef = useRef(null);
  const streamChannelRef = useRef(null);

  useViewerTracking(stream.id, false, currentUser, retryCount);
  const { viewerCount } = useViewerCount(stream.id);

  useEffect(() => {
    setup();
    return () => {
      if (!isCleaningUp.current) {
        cleanup();
      }
    };
  }, []);

  useEffect(() => {
    const keyboardDidShow = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const keyboardDidHide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      if (hostWaitTimeoutRef.current) clearTimeout(hostWaitTimeoutRef.current);
      keyboardDidShow.remove();
      keyboardDidHide.remove();
    };
  }, []);

  useEffect(() => {
    if (!joining && !hostJoined && !hostTimeoutReached && !streamEnded) {
      hostWaitTimeoutRef.current = setTimeout(() => {
        setHostTimeoutReached(true);
      }, HOST_TIMEOUT_MS);
    }
    if ((hostJoined || streamEnded) && hostWaitTimeoutRef.current) {
      clearTimeout(hostWaitTimeoutRef.current);
      hostWaitTimeoutRef.current = null;
    }
  }, [joining, hostJoined, hostTimeoutReached, streamEnded]);

  async function setup() {
    if (!currentUser) {
      setDialog({
        visible: true,
        title: 'Error',
        message: 'Please login to watch streams',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => { setDialog(d => ({ ...d, visible: false })); navigation.goBack(); } }]
      });
      return;
    }

    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', currentUser.id)
        .single();
      setUsername(profile?.username ?? 'viewer');

      // Register LiveKit WebRTC globals
      try { registerGlobals(); } catch (e) {}

      // Get LiveKit token from server
      const response = await fetch(`${TOKEN_SERVER_URL}/api/livekit/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName: stream.channel_name,
          userId: currentUser.id,
          isHost: false,
        }),
      });

      if (!response.ok) throw new Error(`Token server error: ${response.status}`);
      const { token, url } = await response.json();

      // Create LiveKit room
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      // Listen for host's video track
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === Track.Kind.Video) {
          __DEV__ && console.log('[LIVEKIT] Host video track received');
          setHostVideoTrack(track);
          setHostJoined(true);
          setHostTimeoutReached(false);
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Video) {
          setHostVideoTrack(null);
          setHostJoined(false);
        }
      });

      room.on(RoomEvent.ParticipantConnected, (participant) => {
        __DEV__ && console.log('[LIVEKIT] Participant connected:', participant.identity);
      });

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        __DEV__ && console.log('[LIVEKIT] Participant disconnected:', participant.identity);
        setHostJoined(false);
        setStreamEnded(true);
      });

      room.on(RoomEvent.Disconnected, () => {
        setHostJoined(false);
        setStreamEnded(true);
      });

      // Connect to room
      await room.connect(url, token);
      setJoining(false);

      // Check if host is already in the room and has video
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.track && publication.track.kind === Track.Kind.Video) {
            setHostVideoTrack(publication.track);
            setHostJoined(true);
          }
        }
      }

      // Load existing chat messages
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
        .eq('user_id', currentUser.id);
      setQuestionsLeft(Math.max(0, (stream.max_questions ?? 5) - (count ?? 0)));

      subscribeToChat();
      subscribeToQuestions();
      subscribeToStream();

    } catch (e) {
      __DEV__ && console.error('Setup error:', e);
      setDialog({
        visible: true,
        title: 'Error',
        message: 'Failed to join stream.',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => { setDialog(d => ({ ...d, visible: false })); navigation.goBack(); } }]
      });
    }
  }

  async function handleRetryJoin() {
    setHostTimeoutReached(false);
    setJoining(true);
    setRetryCount(prev => prev + 1);

    if (roomRef.current) {
      try {
        await roomRef.current.disconnect();
      } catch (e) {}
      roomRef.current = null;
    }

    setTimeout(() => { setup(); }, 1000);
  }

  async function cleanup() {
    if (isCleaningUp.current) return;
    isCleaningUp.current = true;

    if (hostWaitTimeoutRef.current) {
      clearTimeout(hostWaitTimeoutRef.current);
      hostWaitTimeoutRef.current = null;
    }

    if (chatChannelRef.current) { await supabase.removeChannel(chatChannelRef.current); chatChannelRef.current = null; }
    if (questionsChannelRef.current) { await supabase.removeChannel(questionsChannelRef.current); questionsChannelRef.current = null; }
    if (streamChannelRef.current) { await supabase.removeChannel(streamChannelRef.current); streamChannelRef.current = null; }

    if (roomRef.current) {
      try { await roomRef.current.disconnect(); } catch (e) {}
      roomRef.current = null;
    }
  }

  function subscribeToChat() {
    chatChannelRef.current = supabase.channel(`watch_messages_${stream.id}`);
    chatChannelRef.current
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public',
        table: 'live_messages', filter: `stream_id=eq.${stream.id}`
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
        event: '*', schema: 'public',
        table: 'live_questions', filter: `stream_id=eq.${stream.id}`
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
        event: 'DELETE', schema: 'public',
        table: 'live_streams', filter: `id=eq.${stream.id}`
      }, () => { setStreamEnded(true); })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public',
        table: 'live_streams', filter: `id=eq.${stream.id}`
      }, (payload) => {
        if (!payload.new.is_live) setStreamEnded(true);
      })
      .subscribe();
  }

  async function sendMessage() {
    if (!chatInput.trim() || !stream.id || !currentUser) return;
    const msg = chatInput.replace(/<[^>]*>/g, '').trim();
    setChatInput('');
    try {
      await supabase.from('live_messages').insert({
        stream_id: stream.id, user_id: currentUser.id, username, message: msg
      });
    } catch (e) { __DEV__ && console.log('Failed to send message:', e); }
  }

  async function submitQuestion() {
    if (!questionInput.trim() || !currentUser) return;
    const { data: streamData } = await supabase
      .from('live_streams').select('allow_questions').eq('id', stream.id).single();
    if (!streamData?.allow_questions) {
      setDialog({
        visible: true,
        title: 'Questions Disabled',
        message: 'The scholar is not accepting questions right now.',
        type: 'info',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
      });
      return;
    }
    if (questionsLeft <= 0) {
      setDialog({
        visible: true,
        title: 'Limit Reached',
        message: `The scholar has set a limit of ${stream.max_questions} questions per viewer.`,
        type: 'info',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
      });
      return;
    }
    const q = questionInput.replace(/<[^>]*>/g, '').trim();
    setQuestionInput('');
    try {
      await supabase.from('live_questions').insert({
        stream_id: stream.id, user_id: currentUser.id, username, question: q
      });
      setQuestionsLeft(prev => prev - 1);
    } catch (e) { __DEV__ && console.log('Failed to submit question:', e); }
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
      const saveReaction = async () => {
        try {
          await supabase.from('live_reactions').insert({
            stream_id: stream.id, user_id: currentUser.id, reaction: emoji
          });
        } catch (e) { __DEV__ && console.log('Reaction error:', e); }
      };
      saveReaction();
    }
  }

  const handleDonate = async () => {
  const amount = parseFloat(donateAmount);
  if (!amount || amount < 20) {
    setDialog({
      visible: true,
      title: 'Minimum ₱20',
      message: 'Please enter at least ₱20 to donate.',
      type: 'warning',
      buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
    });
    return;
  }

  setDonating(true);
  try {
    const res = await fetch(`${TOKEN_SERVER_URL}/api/livekit/donate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount,
        scholarName: stream.profiles?.username || 'Scholar',
        streamId: stream.id,
        donorId: currentUser?.id,
        scholarId: stream.user_id,
      }),
    });
    const data = await res.json();
    if (data.checkoutUrl) {
      setDonateModal(false);
      setDonateAmount('');
      setCheckoutUrl(data.checkoutUrl);
    }
  } catch (e) {
    setDialog({
      visible: true,
      title: 'Error',
      message: 'Could not process donation. Please try again.',
      type: 'error',
      buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
    });
  } finally {
    setDonating(false);
  }
};

  const handleTabChat = useCallback(() => setActiveTab('chat'), []);
  const handleTabQuestion = useCallback(() => setActiveTab('question'), []);

  if (streamEnded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={{ fontSize: 48 }}>🎙️</Text>
        <Text style={styles.loadingText}>Stream has ended</Text>
        <AnimatedButton style={styles.goBackBtn} onPress={navigation.goBack}>
          <Text style={styles.goBackBtnText}>Go Back</Text>
        </AnimatedButton>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <SystemBars style="light" />

      {/* Host video - full screen */}
      {hostVideoTrack ? (
        <VideoView
          style={StyleSheet.absoluteFill}
          videoTrack={hostVideoTrack}
          mirror={false}
        />
      ) : (
        <View style={styles.waitingContainer}>
          <ActivityIndicator color="#ef4444" size="large" />
          <Text style={styles.waitingText}>
            {joining ? 'Joining...' : 'Waiting for host...'}
          </Text>
        </View>
      )}

      {/* Timeout UI */}
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
          <AnimatedButton style={[styles.retryBtn, { backgroundColor: '#4b5563', marginTop: 8 }]} onPress={navigation.goBack}>
            <Text style={styles.retryBtnText}>← Go Back</Text>
          </AnimatedButton>
        </View>
      )}

      {/* Floating reactions */}
      {floatingReactions.map(r => (
        <Animated.Text key={r.id} style={[styles.floatingReaction, {
          left: r.startX,
          transform: [{ translateY: r.anim.interpolate({ inputRange: [0, 1], outputRange: [height * 0.7, height * 0.2] }) }],
          opacity: r.anim.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
        }]}>{r.emoji}</Animated.Text>
      ))}

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.liveBadge}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
        <Text style={styles.streamTitle} numberOfLines={1}>{stream.title}</Text>
        <View style={styles.viewerBadge}>
          <Text style={styles.viewerText}>👁️ {viewerCount}</Text>
        </View>
        <AnimatedButton style={styles.closeBtn} onPress={navigation.goBack}>
          <Text style={styles.closeBtnText}>✕</Text>
        </AnimatedButton>
      </View>

      {/* Selected question banner */}
      {selectedQuestion && (
        <View style={styles.questionBanner}>
          <Text style={styles.questionBannerLabel}>❓ Question from @{selectedQuestion.username}</Text>
          <Text style={styles.questionBannerText}>{selectedQuestion.question}</Text>
        </View>
      )}

      {/* Bottom panel */}
      <View style={[styles.bottomPanel, { paddingBottom: insets.bottom + 8 }]}>
        <View style={styles.tabs}>
          <AnimatedButton style={[styles.tab, activeTab === 'chat' && styles.tabActive]} onPress={handleTabChat}>
            <Text style={[styles.tabText, activeTab === 'chat' && styles.tabTextActive]}>💬 Chat</Text>
          </AnimatedButton>
          <AnimatedButton style={[styles.tab, activeTab === 'question' && styles.tabActive]} onPress={handleTabQuestion}>
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
              <View style={styles.disabledContainer}>
                <Text style={styles.disabledEmoji}>🚫</Text>
                <Text style={styles.disabledTitle}>Questions Disabled</Text>
                <Text style={styles.disabledText}>
                  The scholar is not accepting questions during this stream.
                </Text>
              </View>
            ) : (
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
          <AnimatedButton style={styles.donateBtn} onPress={() => setDonateModal(true)}>
            <Text style={styles.donateEmoji}>💰</Text>
          </AnimatedButton>
        </View>
      </View>

      {/* DONATION MODAL */}
<Modal visible={donateModal} transparent animationType="slide" onRequestClose={() => setDonateModal(false)}>
  <Pressable style={styles.donateBackdrop} onPress={() => setDonateModal(false)} />
  <View style={styles.donateSheet}>
    <Text style={styles.donateTitle}>💰 Support this Scholar</Text>
    <Text style={styles.donateSubtitle}>Help keep this stream going!</Text>

    <View style={styles.donateAmounts}>
      {[20, 50, 100, 200].map(amt => (
        <AnimatedButton
          key={amt}
          style={[styles.donateAmountBtn, donateAmount === String(amt) && styles.donateAmountBtnActive]}
          onPress={() => setDonateAmount(String(amt))}
        >
          <Text style={[styles.donateAmountText, donateAmount === String(amt) && styles.donateAmountTextActive]}>
            ₱{amt}
          </Text>
        </AnimatedButton>
      ))}
    </View>

    <TextInput
      style={styles.donateInput}
      value={donateAmount}
      onChangeText={setDonateAmount}
      placeholder="Or enter custom amount (₱)"
      placeholderTextColor="#94a3b8"
      keyboardType="numeric"
    />

    <AnimatedButton
      style={[styles.donateProceedBtn, donating && { opacity: 0.7 }]}
      onPress={handleDonate}
      disabled={donating}
    >
      <Text style={styles.donateProceedText}>
        {donating ? 'Processing...' : '💳 Donate via GCash'}
      </Text>
    </AnimatedButton>

    <Text style={styles.donateNote}>Powered by PayMongo • Safe & Secure</Text>
  </View>
</Modal>

      <ModernDialog
        visible={dialog.visible}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        buttons={dialog.buttons}
        onDismiss={() => setDialog({ ...dialog, visible: false })}
      />

      {/* GCash WebView Modal */}
      <Modal visible={!!checkoutUrl} animationType="slide" onRequestClose={() => setCheckoutUrl(null)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#111', paddingTop: insets.top, paddingHorizontal: 16, paddingBottom: 12 }}>
            <Text style={{ color: '#fff', flex: 1, fontWeight: '700', fontSize: 16 }}>💳 GCash Payment</Text>
            <AnimatedButton onPress={() => setCheckoutUrl(null)}>
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>✕</Text>
            </AnimatedButton>
          </View>
          {checkoutUrl && (
            <WebView
              source={{ uri: checkoutUrl }}
              style={{ flex: 1 }}
              onNavigationStateChange={(navState) => {
                if (navState.url.includes('success') || navState.url.includes('paid')) {
                  setCheckoutUrl(null);
                }
              }}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: '#000' 
  },
  loadingContainer: { 
    flex: 1, 
    backgroundColor: '#000', 
    alignItems: 'center', 
    justifyContent: 'center', 
    gap: 16 
  },
  loadingText: { 
    color: '#fff', 
    fontSize: 16, 
    fontWeight: '600',
    textAlign: 'center',
  },
  waitingContainer: { 
    ...StyleSheet.absoluteFillObject, 
    backgroundColor: '#0a0a0a', 
    alignItems: 'center', 
    justifyContent: 'center', 
    gap: 16, 
    zIndex: 5 
  },
  waitingText: { 
    color: 'rgba(255,255,255,0.7)', 
    fontSize: 15,
    fontWeight: '500',
  },
  timeoutContainer: { 
    ...StyleSheet.absoluteFillObject, 
    backgroundColor: 'rgba(10,10,10,0.95)', 
    alignItems: 'center', 
    justifyContent: 'center', 
    gap: 16, 
    zIndex: 5, 
    padding: 32 
  },
  timeoutTitle: { 
    color: '#ef4444', 
    fontSize: 22, 
    fontWeight: '800', 
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  timeoutText: { 
    color: '#94a3b8', 
    fontSize: 15, 
    textAlign: 'center', 
    marginBottom: 16,
    lineHeight: 22,
  },
  retryBtn: { 
    backgroundColor: COLORS.gold, 
    borderRadius: 16, 
    paddingHorizontal: 36, 
    paddingVertical: 16, 
    minWidth: 200, 
    alignItems: 'center',
    shadowColor: COLORS.gold,
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  retryBtnText: { 
    color: '#fff', 
    fontWeight: '700', 
    fontSize: 16,
    letterSpacing: 0.3,
  },
  floatingReaction: { 
    position: 'absolute', 
    fontSize: 36, 
    zIndex: 100,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  topBar: { 
    position: 'absolute', 
    top: 0, 
    left: 0, 
    right: 0, 
    flexDirection: 'row', 
    alignItems: 'center', 
    paddingHorizontal: 16, 
    gap: 10, 
    zIndex: 10 
  },
  liveBadge: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    backgroundColor: '#ef4444', 
    borderRadius: 20, 
    paddingHorizontal: 12, 
    paddingVertical: 6, 
    gap: 6,
    shadowColor: '#ef4444',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  liveDot: { 
    width: 7, 
    height: 7, 
    borderRadius: 4, 
    backgroundColor: '#fff' 
  },
  liveText: { 
    color: '#fff', 
    fontWeight: '800', 
    fontSize: 12,
    letterSpacing: 1,
  },
  streamTitle: { 
    flex: 1, 
    color: '#fff', 
    fontWeight: '700', 
    fontSize: 15,
    letterSpacing: -0.3,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  viewerBadge: { 
    backgroundColor: 'rgba(0,0,0,0.5)', 
    borderRadius: 20, 
    paddingHorizontal: 12, 
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  viewerText: { 
    color: '#fff', 
    fontSize: 13, 
    fontWeight: '600' 
  },
  closeBtn: { 
    backgroundColor: 'rgba(0,0,0,0.5)', 
    borderRadius: 20, 
    width: 36, 
    height: 36, 
    alignItems: 'center', 
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  closeBtnText: { 
    color: '#fff', 
    fontSize: 18, 
    fontWeight: '700' 
  },
  questionBanner: { 
    position: 'absolute', 
    top: 100, 
    left: 16, 
    right: 16, 
    backgroundColor: 'rgba(0,0,0,0.85)', 
    borderRadius: 16, 
    padding: 16, 
    zIndex: 20,
    borderWidth: 1,
    borderColor: COLORS.gold,
    shadowColor: COLORS.gold,
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  questionBannerLabel: { 
    color: COLORS.gold, 
    fontSize: 11, 
    fontWeight: '700', 
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  questionBannerText: { 
    color: '#fff', 
    fontSize: 15, 
    fontWeight: '600',
    lineHeight: 22,
  },
  bottomPanel: { 
    position: 'absolute', 
    bottom: 0, 
    left: 0, 
    right: 0, 
    paddingHorizontal: 12 
  },
  tabs: { 
    flexDirection: 'row', 
    gap: 8, 
    marginBottom: 10 
  },
  tab: { 
    paddingHorizontal: 16, 
    paddingVertical: 8, 
    borderRadius: 20, 
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  tabActive: { 
    backgroundColor: COLORS.gold,
    borderColor: COLORS.gold,
    shadowColor: COLORS.gold,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  tabText: { 
    color: 'rgba(255,255,255,0.5)', 
    fontSize: 13, 
    fontWeight: '600' 
  },
  tabTextActive: { 
    color: '#fff',
    fontWeight: '700',
  },
  chatList: { 
    maxHeight: height * 0.28, 
    marginBottom: 10 
  },
  chatMessage: { 
    flexDirection: 'row', 
    flexWrap: 'wrap', 
    marginBottom: 6,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chatUsername: { 
    color: COLORS.gold, 
    fontWeight: '700', 
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  chatText: { 
    color: '#fff', 
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  chatInputRow: { 
    flexDirection: 'row', 
    gap: 8, 
    marginBottom: 8 
  },
  chatInput: { 
    flex: 1, 
    backgroundColor: 'rgba(0,0,0,0.6)', 
    borderRadius: 24, 
    paddingHorizontal: 18, 
    paddingVertical: 10, 
    color: 'rgba(255,255,255,0.9)', 
    fontSize: 14, 
    borderWidth: 1, 
    borderColor: 'rgba(255,255,255,0.15)',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  sendBtn: { 
    backgroundColor: COLORS.gold, 
    borderRadius: 24, 
    paddingHorizontal: 18, 
    justifyContent: 'center',
    shadowColor: COLORS.gold,
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  sendBtnText: { 
    color: '#fff', 
    fontWeight: '700', 
    fontSize: 13,
    letterSpacing: 0.3,
  },
  questionInputContainer: { 
    marginBottom: 10 
  },
  questionHint: { 
    color: '#94a3b8', 
    fontSize: 13, 
    marginBottom: 10,
    fontWeight: '500',
  },
  reactionsRow: { 
    flexDirection: 'row', 
    justifyContent: 'space-around', 
    marginBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 30,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  reactionBtn: { 
    padding: 10,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  reactionEmoji: { 
    fontSize: 24,
  },
  goBackBtn: { 
    backgroundColor: COLORS.gold, 
    borderRadius: 16, 
    paddingHorizontal: 28, 
    paddingVertical: 14, 
    marginTop: 8,
    shadowColor: COLORS.gold,
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  goBackBtnText: { 
    color: '#fff', 
    fontWeight: '700', 
    fontSize: 15,
    letterSpacing: 0.3,
  },
  disabledContainer: { 
    alignItems: 'center', 
    paddingVertical: 24, 
    paddingHorizontal: 16,
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.2)',
    marginBottom: 10,
  },
  disabledEmoji: { 
    fontSize: 44, 
    marginBottom: 12 
  },
  disabledTitle: { 
    color: '#ef4444', 
    fontSize: 17, 
    fontWeight: '800', 
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  donateBtn: {
  padding: 10, borderRadius: 20,
  backgroundColor: 'rgba(212,175,55,0.2)',
  borderWidth: 1, borderColor: COLORS.gold,
},
donateEmoji: { fontSize: 24 },
donateBackdrop: {
  ...StyleSheet.absoluteFillObject,
  backgroundColor: 'rgba(0,0,0,0.6)'
},
donateSheet: {
  position: 'absolute', bottom: 0, left: 0, right: 0,
  backgroundColor: '#111', borderTopLeftRadius: 24,
  borderTopRightRadius: 24, padding: 24, paddingBottom: 48,
},
donateTitle: {
  color: '#fff', fontSize: 20, fontWeight: '800',
  textAlign: 'center', marginBottom: 6
},
donateSubtitle: {
  color: '#94a3b8', fontSize: 13,
  textAlign: 'center', marginBottom: 20
},
donateAmounts: {
  flexDirection: 'row', gap: 10,
  marginBottom: 16, justifyContent: 'center'
},
donateAmountBtn: {
  flex: 1, paddingVertical: 12, borderRadius: 12,
  backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center',
  borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
},
donateAmountBtnActive: { backgroundColor: COLORS.gold, borderColor: COLORS.gold },
donateAmountText: { color: '#94a3b8', fontWeight: '700', fontSize: 15 },
donateAmountTextActive: { color: '#fff' },
donateInput: {
  backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12,
  padding: 14, color: '#fff', fontSize: 15, marginBottom: 16,
  borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
},
donateProceedBtn: {
  backgroundColor: COLORS.gold, borderRadius: 14,
  paddingVertical: 16, alignItems: 'center', marginBottom: 12,
},
donateProceedText: { color: '#fff', fontWeight: '800', fontSize: 16 },
donateNote: { color: '#475569', fontSize: 12, textAlign: 'center' },
  disabledText: { 
    color: '#94a3b8', 
    fontSize: 14, 
    textAlign: 'center',
    lineHeight: 20,
  },
});