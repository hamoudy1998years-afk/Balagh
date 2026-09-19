import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, FlatList,
  Keyboard, Platform, ActivityIndicator,
  Animated, Dimensions, Modal, Pressable, Share,
} from 'react-native';
import ModernDialog from './ModernDialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SystemBars } from 'react-native-edge-to-edge';
import { Room, RoomEvent, Track } from 'livekit-client';
import * as WebBrowser from 'expo-web-browser';
import { WebView } from 'react-native-webview';
import { registerGlobals, VideoView } from '@livekit/react-native';
import { supabase } from '../lib/supabase';
import { filterMessage } from '../utils/moderation';
import { setSuppressNotifications } from '../lib/notificationPolicy';
import AnimatedButton from './AnimatedButton';
import { useViewerTracking } from '../hooks/useViewerTracking';
import { useViewerCount } from '../hooks/useViewerCount';
import { COLORS } from '../constants/theme';
import { useUser } from '../context/UserContext';
import { fetchWithTimeout } from '../utils/apiClient';

const { width, height } = Dimensions.get('window');
const TOKEN_SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL;
const REACTIONS = ['❤️', '🤲', '☪️', '🌟', '👍'];
const HOST_TIMEOUT_MS = 30000;
const REACTION_THROTTLE_MS = 2000;

// Returns the current Supabase access token for authenticated Railway
// requests, refreshing first if it is about to expire. Resolves to null
// when there is no usable session (caller must not send the request).
async function getAccessToken() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    let accessToken = session?.access_token ?? null;

    if (session?.expires_at && session.expires_at * 1000 < Date.now() + 60 * 1000) {
      const { data } = await supabase.auth.refreshSession();
      accessToken = data?.session?.access_token ?? accessToken;
    }

    return accessToken || null;
  } catch (e) {
    return null;
  }
}

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
  const [likeCount, setLikeCount] = useState(0);
  const [pinnedMessage, setPinnedMessage] = useState(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [floatingHearts, setFloatingHearts] = useState([]);
  const [questionNotifs, setQuestionNotifs] = useState([]);
  // This viewer's own moderation row for this stream: null | 'mute' | 'block'.
  // RLS guarantees the app can only ever read the viewer's own row.
  const [moderationAction, setModerationAction] = useState(null);
  const heartId = useRef(0);

  const roomRef = useRef(null);
  const flatListRef = useRef(null);
  const reactionId = useRef(0);
  const isCleaningUp = useRef(false);
  const hostWaitTimeoutRef = useRef(null);
  const chatChannelRef = useRef(null);
  const questionsChannelRef = useRef(null);
  const streamChannelRef = useRef(null);

  // --- Race/lifecycle protection refs ---
  const setupIdRef = useRef(0);          // generation guard for setup() attempts
  const retryTimeoutRef = useRef(null);  // pending retry setTimeout
  const hostIdentityRef = useRef(null);  // LiveKit identity of the participant providing host video
  const selectedQuestionIdRef = useRef(null); // avoids stale closure in realtime callback
  const submittingQuestionRef = useRef(false); // guards rapid duplicate question submits
  const sendingMessageRef = useRef(false); // guards rapid duplicate chat sends
  const lastReactionAtRef = useRef(0); // shared client throttle for emoji + heart reaction writes
  // Own-question notification: tracks last seen flag states per question id so
  // we only notify on a real false -> true transition of is_answered/is_dismissed.
  const ownQuestionStatesRef = useRef({});
  const questionNotifId = useRef(0);

  useViewerTracking(stream.id, false, currentUser, retryCount, !streamEnded);
  const { viewerCount } = useViewerCount(stream.id);

  // Keep the ref in sync so the realtime subscription (created once) never
  // reads a stale `selectedQuestion` value from its closure.
  useEffect(() => {
    selectedQuestionIdRef.current = selectedQuestion?.id ?? null;
  }, [selectedQuestion]);

  useEffect(() => {
    setup();

    // Suppress push notifications while watching live. This goes through
    // the centralized notification policy module instead of overwriting
    // the global handler directly, so it can't clobber a handler installed
    // by another part of the app.
    setSuppressNotifications(true);

    return () => {
      if (!isCleaningUp.current) {
        cleanup();
      }
      setSuppressNotifications(false);
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

  async function cleanupChannels() {
    if (chatChannelRef.current) { await supabase.removeChannel(chatChannelRef.current); chatChannelRef.current = null; }
    if (questionsChannelRef.current) { await supabase.removeChannel(questionsChannelRef.current); questionsChannelRef.current = null; }
    if (streamChannelRef.current) { await supabase.removeChannel(streamChannelRef.current); streamChannelRef.current = null; }
  }

  async function setup() {
    // Every attempt (initial mount or retry) gets its own generation id.
    // Any async continuation below must verify this id is still current
    // before touching React state or installing resources.
    const setupId = ++setupIdRef.current;
    const isStale = () => setupIdRef.current !== setupId || isCleaningUp.current;

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
      if (isStale()) return;
      setUsername(profile?.username ?? 'viewer');

      // Register LiveKit WebRTC globals
      try { registerGlobals(); } catch (e) {}

      // Get LiveKit token from the secured server endpoint. Requires a valid
      // Supabase session — skip the request entirely when there is no usable
      // token and fail through the existing setup error flow below. The
      // server derives viewer identity from the verified JWT, so the body
      // carries no client-authoritative userId.
      const accessToken = await getAccessToken();
      if (isStale()) return;
      if (!accessToken) {
        throw new Error('No auth session');
      }
      const response = await fetchWithTimeout(`${TOKEN_SERVER_URL}/api/livekit/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          roomName: stream.channel_name,
          isHost: false,
        }),
      });

      if (!response.ok) throw new Error(`Token server error: ${response.status}`);
      const { token, url } = await response.json();
      if (isStale()) return;

      // Create LiveKit room (kept local until we know this attempt is still current)
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: { width: 640, height: 360, frameRate: 15 },
        },
        publishDefaults: {
          videoEncoding: {
            maxBitrate: 500_000,
            maxFramerate: 15,
          },
          simulcast: false,
        },
      });

      // Listen for host's video track.
      // Only the participant whose video we first receive is treated as the
      // host; any later ParticipantDisconnected is checked against this
      // identity so a random viewer leaving doesn't end the stream.
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (setupIdRef.current !== setupId || isCleaningUp.current) return;
        if (
          track.kind === Track.Kind.Video &&
          String(participant.identity) === String(stream.user_id)
        ) {
          __DEV__ && console.log('[LIVEKIT] Host video track received');
          hostIdentityRef.current = participant.identity;
          setHostVideoTrack(track);
          setHostJoined(true);
          setHostTimeoutReached(false);
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        if (setupIdRef.current !== setupId || isCleaningUp.current) return;
        if (
          track.kind === Track.Kind.Video &&
          participant.identity === hostIdentityRef.current
        ) {
          setHostVideoTrack(null);
          setHostJoined(false);
        }
      });

      room.on(RoomEvent.ParticipantConnected, (participant) => {
        __DEV__ && console.log('[LIVEKIT] Participant connected:', participant.identity);
      });

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (setupIdRef.current !== setupId || isCleaningUp.current) return;
        // The host dropping can be a transient network interruption — the
        // host client may still reconnect (its own RoomEvent.Reconnecting/
        // Reconnected cycle). Don't declare the stream ended here; just clear
        // host presence and let the existing 30s no-host timeout decide. A
        // returning host re-triggers TrackSubscribed and restores video.
        // Authoritative end signals remain the live_streams DELETE / is_live
        // = false realtime events (subscribeToStream).
        if (hostIdentityRef.current && participant.identity === hostIdentityRef.current) {
          hostIdentityRef.current = null;
          setHostVideoTrack(null);
          setHostJoined(false);
        }
      });

      room.on(RoomEvent.Disconnected, () => {
        if (setupIdRef.current !== setupId || isCleaningUp.current) return;
        // The VIEWER's own connection dropped after LiveKit's reconnect
        // attempts were exhausted — the stream itself may still be live.
        // Route to the existing timeout/retry UI instead of the final
        // "Stream has ended" screen; Try Again runs handleRetryJoin with the
        // existing setupId generation guards and room/channel cleanup.
        setHostJoined(false);
        setHostTimeoutReached(true);
      });

      // Connect to room
      await room.connect(url, token);

      // If a newer setup/retry started, or the screen was torn down, while
      // we were connecting, this room is stale — disconnect it and bail
      // out rather than adopting it as the active room.
      if (isStale()) {
        try { await room.disconnect(); } catch (e) {}
        return;
      }

      roomRef.current = room;
      setJoining(false);

      // Check if host is already in the room and has video
      for (const participant of room.remoteParticipants.values()) {
        if (String(participant.identity) !== String(stream.user_id)) continue;
        for (const publication of participant.trackPublications.values()) {
          if (publication.track && publication.track.kind === Track.Kind.Video) {
            hostIdentityRef.current = participant.identity;
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
      if (isStale()) return;
      setMessages(existingMessages ?? []);

      const { data: selectedQ } = await supabase
        .from('live_questions')
        .select('*')
        .eq('stream_id', stream.id)
        .eq('is_selected', true)
        .single();
      if (isStale()) return;
      if (selectedQ) setSelectedQuestion(selectedQ);

      const { count } = await supabase
        .from('live_questions')
        .select('*', { count: 'exact' })
        .eq('stream_id', stream.id)
        .eq('user_id', currentUser.id);
      if (isStale()) return;
      setQuestionsLeft(Math.max(0, (stream.max_questions ?? 5) - (count ?? 0)));

      // Check whether the host has muted/blocked this viewer for this stream.
      // RLS returns only the viewer's own row; null means no moderation.
      const ownModeration = await fetchOwnModeration();
      if (isStale()) return;
      setModerationAction(ownModeration);

      subscribeToChat(setupId);
      subscribeToQuestions(setupId);
      subscribeToStream(setupId);

      // Load already pinned message
      const { data: streamData } = await supabase
        .from('live_streams')
        .select('pinned_message')
        .eq('id', stream.id)
        .single();
      if (isStale()) return;
      if (streamData?.pinned_message) setPinnedMessage(streamData.pinned_message);

      // Check if already following
      if (stream?.user_id && currentUser) {
        const { data: followData } = await supabase
          .from('follows')
          .select('id')
          .eq('follower_id', currentUser.id)
          .eq('following_id', stream.user_id)
          .maybeSingle();
        if (isStale()) return;
        setIsFollowing(!!followData);
      }

    } catch (e) {
      __DEV__ && console.error('Setup error:', e);
      if (isStale()) return;
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

    // Invalidate the previous setup session immediately so any of its
    // in-flight async work becomes a no-op.
    setupIdRef.current += 1;

    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }

    if (roomRef.current) {
      try {
        await roomRef.current.disconnect();
      } catch (e) {}
      roomRef.current = null;
    }

    // Remove existing realtime subscriptions so setup() doesn't create
    // duplicate channel subscriptions on retry.
    await cleanupChannels();

    retryTimeoutRef.current = setTimeout(() => {
      retryTimeoutRef.current = null;
      if (isCleaningUp.current) return;
      setup();
    }, 1000);
  }

  async function cleanup() {
    if (isCleaningUp.current) return;
    isCleaningUp.current = true;

    // Invalidate any setup attempt still in flight.
    setupIdRef.current += 1;

    if (hostWaitTimeoutRef.current) {
      clearTimeout(hostWaitTimeoutRef.current);
      hostWaitTimeoutRef.current = null;
    }
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }

    await cleanupChannels();

    if (roomRef.current) {
      try { await roomRef.current.disconnect(); } catch (e) {}
      roomRef.current = null;
    }
  }

  function subscribeToChat(setupId) {
    chatChannelRef.current = supabase.channel(`watch_messages_${stream.id}`);
    chatChannelRef.current
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public',
        table: 'live_messages', filter: `stream_id=eq.${stream.id}`
      }, (payload) => {
        if (setupIdRef.current !== setupId || isCleaningUp.current) return;
        setMessages(prev => [...prev, payload.new]);
        setTimeout(() => {
          if (setupIdRef.current !== setupId || isCleaningUp.current) return;
          flatListRef.current?.scrollToEnd({ animated: true });
        }, 100);
      })
      .subscribe();
  }

  function subscribeToQuestions(setupId) {
    questionsChannelRef.current = supabase.channel(`watch_questions_${stream.id}`);
    questionsChannelRef.current
      .on('postgres_changes', {
        event: '*', schema: 'public',
        table: 'live_questions', filter: `stream_id=eq.${stream.id}`
      }, (payload) => {
        if (setupIdRef.current !== setupId || isCleaningUp.current) return;

        if (payload.eventType === 'DELETE') {
          if (payload.old?.id === selectedQuestionIdRef.current) {
            setSelectedQuestion(null);
          }
          return;
        }

        // Brief confirmation when the viewer's OWN question is answered or
        // dismissed. Track last-seen flag states per question so unrelated
        // updates and re-fires of the same state never notify twice.
        const ownId = currentUser?.id;
        const newRow = payload.new;
        if (ownId && newRow && newRow.user_id === ownId) {
          const prev = ownQuestionStatesRef.current[newRow.id] || { is_answered: false, is_dismissed: false };

          if (newRow.is_answered && !prev.is_answered) {
            showQuestionNotif('✅ Your question was answered');
          } else if (newRow.is_dismissed && !prev.is_dismissed) {
            showQuestionNotif('Your question was dismissed');
          }

          ownQuestionStatesRef.current[newRow.id] = {
            is_answered: !!newRow.is_answered,
            is_dismissed: !!newRow.is_dismissed,
          };
        }

        if (payload.new?.is_selected) {
          setSelectedQuestion(payload.new);
        } else if (!payload.new?.is_selected && payload.new?.id === selectedQuestionIdRef.current) {
          setSelectedQuestion(null);
        }
      })
      .subscribe();
  }

  // Transient, non-blocking notification (mirrors the host's showLiveNotif).
  function showQuestionNotif(text) {
    const id = questionNotifId.current++;
    setQuestionNotifs(prev => [...prev, { id, text }]);
    setTimeout(() => {
      if (isCleaningUp.current) return;
      setQuestionNotifs(prev => prev.filter(n => n.id !== id));
    }, 3000);
  }

  function subscribeToStream(setupId) {
    streamChannelRef.current = supabase.channel(`watch_stream_${stream.id}`);
    streamChannelRef.current
      .on('postgres_changes', {
        event: 'DELETE', schema: 'public',
        table: 'live_streams', filter: `id=eq.${stream.id}`
      }, () => {
        if (setupIdRef.current !== setupId || isCleaningUp.current) return;
        setStreamEnded(true);
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public',
        table: 'live_streams', filter: `id=eq.${stream.id}`
      }, (payload) => {
        if (setupIdRef.current !== setupId || isCleaningUp.current) return;
        if (!payload.new.is_live) setStreamEnded(true);
        setPinnedMessage(payload.new.pinned_message ?? null);
      })
      .subscribe();
  }

  // ─── MODERATION (viewer side) ─────────────────────────────────────────────
  // Mute disables chat only; block disables chat + questions + reactions.
  // The database (RLS + triggers) is always authoritative — local state only
  // mirrors it and is refreshed from it whenever a write is rejected.
  const isChatDisabled = moderationAction === 'mute' || moderationAction === 'block';
  const isParticipationBlocked = moderationAction === 'block';

  // Fetches this viewer's own live_moderation row for this stream. RLS
  // guarantees only their own row is visible. Returns 'mute' | 'block' |
  // null (no row, or the lookup itself failed).
  async function fetchOwnModeration() {
    try {
      const { data, error } = await supabase
        .from('live_moderation')
        .select('action')
        .eq('stream_id', stream.id)
        .maybeSingle();
      if (error) {
        __DEV__ && console.log('Moderation lookup failed:', error);
        return null;
      }
      return data?.action ?? null;
    } catch (e) {
      __DEV__ && console.log('Moderation lookup failed:', e);
      return null;
    }
  }

  function showModerationDialog(action) {
    setDialog(action === 'block' ? {
      visible: true,
      title: 'Blocked',
      message: "You've been blocked from participating in this livestream. You can still watch.",
      type: 'info',
      buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
    } : {
      visible: true,
      title: 'Muted',
      message: "You've been muted by the host. You can still watch, ask questions, and react.",
      type: 'info',
      buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
    });
  }

  // Shared failure path after a rejected chat/question/reaction write:
  // re-fetch the viewer's own moderation row (never parsing error strings),
  // sync local state from the authoritative answer, and show the matching
  // message. When no moderation row exists the failure is treated as an
  // ordinary network/database error and the generic dialog is shown instead.
  async function handleModeratedWriteFailure(isChat, genericDialog) {
    const action = await fetchOwnModeration();
    // The viewer may have left the screen while the lookup was running —
    // never touch React state or dialogs after cleanup has begun.
    if (isCleaningUp.current) return;
    if (action) setModerationAction(action);
    if (action === 'block' || (action === 'mute' && isChat)) {
      showModerationDialog(action);
    } else {
      setDialog(genericDialog);
    }
  }

  const GENERIC_SEND_ERROR = {
    title: 'Error',
    message: 'Failed to send your message. Please try again.',
    type: 'error',
  };

  // After a rejected question insert, re-fetch the authoritative database
  // state and classify the failure WITHOUT parsing error strings:
  // blocked -> Blocked dialog; stream gone/ended -> stream-ended UI;
  // questions disabled -> info dialog; quota full -> Limit Reached
  // (recomputed from fresh max_questions + exact count); otherwise generic.
  // The typed question stays in the input on every failure path.
  async function reconcileQuestionFailure() {
    const questionStreamId = stream.id;
    const isStale = () => isCleaningUp.current || questionStreamId !== stream.id;

    const showGenericQuestionError = () => setDialog({
      visible: true,
      title: 'Error',
      message: 'Failed to submit your question. Please try again.',
      type: 'error',
      buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
    });

    // 1) Moderation first: a blocked viewer gets the Blocked dialog.
    const action = await fetchOwnModeration();
    if (isStale()) return;
    if (action) setModerationAction(action);
    if (action === 'block') {
      showModerationDialog('block');
      return;
    }

    // 2) Fresh stream state — the route-param snapshot may be stale.
    const { data: streamData, error: streamError } = await supabase
      .from('live_streams')
      .select('is_live, allow_questions, max_questions')
      .eq('id', questionStreamId)
      .maybeSingle();
    if (isStale()) return;

    // A failed lookup (data=null + error) is NOT proof the stream ended —
    // only treat the stream as gone when the query itself succeeded.
    if (streamError) {
      showGenericQuestionError();
      return;
    }

    if (!streamData || streamData.is_live !== true) {
      setStreamEnded(true);
      return;
    }

    if (streamData.allow_questions !== true) {
      setDialog({
        visible: true,
        title: 'Questions Disabled',
        message: 'The scholar is not accepting questions right now.',
        type: 'info',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
      });
      return;
    }

    // 3) Exact count -> authoritative remaining quota.
    const { count, error: countError } = await supabase
      .from('live_questions')
      .select('*', { count: 'exact', head: true })
      .eq('stream_id', questionStreamId)
      .eq('user_id', currentUser.id);
    if (isStale()) return;

    // A failed count query must not be treated as count = 0.
    if (countError) {
      showGenericQuestionError();
      return;
    }

    const maxQuestions = streamData?.max_questions ?? 5;
    const remaining = Math.max(0, maxQuestions - (count ?? 0));
    setQuestionsLeft(remaining);

    if (remaining <= 0) {
      setDialog({
        visible: true,
        title: 'Limit Reached',
        message: `The scholar has set a limit of ${maxQuestions} questions per viewer.`,
        type: 'info',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
      });
      return;
    }

    setDialog({
      visible: true,
      title: 'Error',
      message: 'Failed to submit your question. Please try again.',
      type: 'error',
      buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
    });
  }

  async function sendMessage() {
    if (!chatInput.trim() || !stream.id || !currentUser) return;
    if (sendingMessageRef.current) return;
    sendingMessageRef.current = true;
    const msg = chatInput.replace(/<[^>]*>/g, '').trim();
    // Same content rules as the host: banned words are blocked before any
    // DB write; links/card-like patterns are scrubbed to [removed].
    const moderationResult = filterMessage(msg, username);
    if (!moderationResult.allowed) {
      sendingMessageRef.current = false;
      setDialog({
        visible: true,
        title: 'Message Blocked',
        message: 'Your message contains inappropriate content.',
        type: 'warning',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
      });
      return;
    }
    let failed = false;
    try {
      const { error } = await supabase.from('live_messages').insert({
        stream_id: stream.id, user_id: currentUser.id, username, message: moderationResult.filteredText
      });
      if (error) {
        __DEV__ && console.log('Failed to send message:', error);
        failed = true;
      }
    } catch (e) {
      __DEV__ && console.log('Failed to send message:', e);
      failed = true;
    }
    sendingMessageRef.current = false;
    if (!failed) {
      setChatInput('');
      return;
    }
    // Keep the typed message in the input on failure (only cleared on
    // success) so a transient error doesn't silently destroy it.
    await handleModeratedWriteFailure(true, { ...GENERIC_SEND_ERROR, visible: true, buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
  }

  async function submitQuestion() {
    if (!questionInput.trim() || !currentUser) return;
    if (submittingQuestionRef.current) return;
    submittingQuestionRef.current = true;
    try {
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
      const { error } = await supabase.from('live_questions').insert({
        stream_id: stream.id, user_id: currentUser.id, username, question: q
      });
      if (!error) {
        setQuestionInput('');
        setQuestionsLeft(prev => Math.max(0, prev - 1));
      } else {
        __DEV__ && console.log('Failed to submit question:', error);
        await reconcileQuestionFailure();
      }
    } catch (e) {
      __DEV__ && console.log('Failed to submit question:', e);
      await reconcileQuestionFailure();
    } finally {
      submittingQuestionRef.current = false;
    }
  }

  function sendReaction(emoji) {
    if (!stream?.id || !currentUser || isParticipationBlocked) return;

    // Client-side defense-in-depth only.
    // The database trigger remains the authoritative rate limit.
    // This shared throttle also prevents alternating between emoji
    // reactions and the heart button to multiply DB writes.
    const now = Date.now();
    if (now - lastReactionAtRef.current < REACTION_THROTTLE_MS) return;
    lastReactionAtRef.current = now;

    const id = reactionId.current++;
    const startX = Math.random() * (width - 60);
    const anim = new Animated.Value(0);

    setFloatingReactions(prev => [
      ...prev,
      { id, emoji, startX, anim }
    ]);

    Animated.timing(anim, {
      toValue: 1,
      duration: 2000,
      useNativeDriver: true,
    }).start(() => {
      setFloatingReactions(prev =>
        prev.filter(r => r.id !== id)
      );
    });

    const saveReaction = async () => {
      try {
        const { error } = await supabase
          .from('live_reactions')
          .insert({
            stream_id: stream.id,
            user_id: currentUser.id,
            reaction: emoji,
          });

        if (error) {
          __DEV__ && console.log('Reaction error:', error);

          await handleModeratedWriteFailure(false, {
            ...GENERIC_SEND_ERROR,
            message: 'Failed to send your reaction. Please try again.',
            visible: true,
            buttons: [
              {
                text: 'OK',
                onPress: () =>
                  setDialog(d => ({ ...d, visible: false })),
              },
            ],
          });
        }
      } catch (e) {
        __DEV__ && console.log('Reaction error:', e);

        await handleModeratedWriteFailure(false, {
          ...GENERIC_SEND_ERROR,
          message: 'Failed to send your reaction. Please try again.',
          visible: true,
          buttons: [
            {
              text: 'OK',
              onPress: () =>
                setDialog(d => ({ ...d, visible: false })),
            },
          ],
        });
      }
    };

    saveReaction();
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
    if (!res.ok) {
      throw new Error(`Donation server error: ${res.status}`);
    }
    const data = await res.json();
    if (!data?.checkoutUrl || typeof data.checkoutUrl !== 'string') {
      throw new Error('Donation server did not return a checkout URL');
    }

    setDonateModal(false);
    setDonateAmount('');
    setCheckoutUrl(data.checkoutUrl);
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

  const spawnHeart = (x, y) => {
    const id = heartId.current++;
    const anim = new Animated.Value(0);
    setFloatingHearts(prev => [...prev, { id, x, y, anim }]);
    Animated.timing(anim, { toValue: 1, duration: 1200, useNativeDriver: true }).start(() => {
      setFloatingHearts(prev => prev.filter(h => h.id !== id));
    });
  };

  const handleLike = () => {
    if (!stream?.id || !currentUser || isParticipationBlocked) return;

    const now = Date.now();
    if (now - lastReactionAtRef.current < REACTION_THROTTLE_MS) return;
    lastReactionAtRef.current = now;

    setLikeCount(prev => prev + 1);
    spawnHeart(width - 60, height * 0.5);

    supabase
      .from('live_reactions')
      .insert({
        stream_id: stream.id,
        user_id: currentUser.id,
        reaction: '❤️',
      })
      .then(({ error }) => {
        if (error) {
          __DEV__ && console.log('Reaction error:', error);

          handleModeratedWriteFailure(false, {
            ...GENERIC_SEND_ERROR,
            message: 'Failed to send your reaction. Please try again.',
            visible: true,
            buttons: [
              {
                text: 'OK',
                onPress: () =>
                  setDialog(d => ({ ...d, visible: false })),
              },
            ],
          });
        }
      })
      .catch((e) => {
        __DEV__ && console.log('Reaction error:', e);

        handleModeratedWriteFailure(false, {
          ...GENERIC_SEND_ERROR,
          message: 'Failed to send your reaction. Please try again.',
          visible: true,
          buttons: [
            {
              text: 'OK',
              onPress: () =>
                setDialog(d => ({ ...d, visible: false })),
            },
          ],
        });
      });
  };

  const handleTapVideo = (e) => {
    const { locationX, locationY } = e.nativeEvent;
    spawnHeart(locationX, locationY);
  };

  const handleShare = async () => {
    if (!stream?.id) return;

    try {
      await Share.share({
        message: `Watch ${stream.title || 'this livestream'} live on Bushrann:\nbushrann://live/${stream.id}`,
        title: stream.title || 'Bushrann Live',
      });
    } catch (error) {
      __DEV__ && console.log('Failed to share livestream:', error);

      setDialog({
        visible: true,
        title: 'Share Failed',
        message: 'Could not share this livestream. Please try again.',
        type: 'error',
        buttons: [
          {
            text: 'OK',
            onPress: () =>
              setDialog(d => ({ ...d, visible: false })),
          },
        ],
      });
    }
  };

  const handleFollow = async () => {
    if (!currentUser || !stream?.user_id) return;
    if (isFollowing) return;
    setIsFollowing(true);
    const { error } = await supabase.from('follows').insert({
      follower_id: currentUser.id,
      following_id: stream.user_id,
    });
    if (error) {
      // Postgres unique_violation (already following) isn't a real failure —
      // any other error means the follow didn't actually happen, so roll back.
      if (error.code !== '23505') {
        setIsFollowing(false);
      }
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
        <>
          <VideoView
            style={StyleSheet.absoluteFill}
            videoTrack={hostVideoTrack}
            mirror={false}
          />
        </>
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

      {/* Floating hearts from tap */}
      {floatingHearts.map(h => (
        <Animated.Text key={h.id} style={[styles.floatingHeart, {
          left: h.x,
          top: h.y,
          transform: [{ translateY: h.anim.interpolate({ inputRange: [0, 1], outputRange: [0, -180] }) }],
          opacity: h.anim.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
        }]}>❤️</Animated.Text>
      ))}

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

      {/* Transient own-question notifications (answered / dismissed) */}
      {questionNotifs.map(n => (
        <View key={n.id} style={styles.questionNotif}>
          <Text style={styles.questionNotifText}>{n.text}</Text>
        </View>
      ))}

      {/* Pinned message */}
      {pinnedMessage && (
        <View style={styles.pinnedMessage}>
          <Text style={styles.pinnedLabel}>📌 Pinned</Text>
          <Text style={styles.pinnedText}>@{pinnedMessage.username}: {pinnedMessage.message}</Text>
        </View>
      )}

      {/* Right side buttons */}
      <View style={[styles.rightButtons, { bottom: 320 + keyboardHeight }]}>
        <AnimatedButton style={styles.rightBtn} onPress={handleFollow}>
          <Text style={styles.rightBtnEmoji}>{isFollowing ? '✅' : '➕'}</Text>
          <Text style={styles.rightBtnText}>{isFollowing ? 'Following' : 'Follow'}</Text>
        </AnimatedButton>

        <AnimatedButton style={styles.rightBtn} onPress={handleShare}>
          <Text style={styles.rightBtnEmoji}>↗️</Text>
          <Text style={styles.rightBtnText}>Share</Text>
        </AnimatedButton>

        <AnimatedButton style={styles.rightBtn} onPress={handleLike} disabled={isParticipationBlocked}>
          <Text style={styles.rightBtnEmoji}>❤️</Text>
          <Text style={styles.rightBtnText}>{likeCount}</Text>
        </AnimatedButton>
      </View>

      {/* Bottom panel */}
      <View style={[styles.bottomPanel, { paddingBottom: insets.bottom + 8 }]}>
        {activeTab === 'chat' && (
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
        )}

        <View style={styles.tabs}>
          <AnimatedButton style={[styles.tab, activeTab === 'chat' && styles.tabActive]} onPress={handleTabChat}>
            <Text style={[styles.tabText, activeTab === 'chat' && styles.tabTextActive]}>💬 Chat</Text>
          </AnimatedButton>
          <AnimatedButton style={[styles.tab, activeTab === 'question' && styles.tabActive]} onPress={handleTabQuestion}>
            <Text style={[styles.tabText, activeTab === 'question' && styles.tabTextActive]}>❓ Ask ({questionsLeft} left)</Text>
          </AnimatedButton>
          <AnimatedButton style={[styles.tab, styles.sadaqahTab]} onPress={() => setDonateModal(true)}>
            <Text style={styles.sadaqahTabText}>🤲 Sadaqah</Text>
          </AnimatedButton>
        </View>

        {activeTab === 'chat' && (
          <View style={[styles.chatInputRow, { marginBottom: Math.max(0, keyboardHeight - 45) }]}>
            <TextInput style={styles.chatInput} value={chatInput} onChangeText={setChatInput}
              placeholder="Say something..." placeholderTextColor="#64748b" onSubmitEditing={sendMessage}
              editable={!isChatDisabled} maxLength={500} />
            <AnimatedButton style={styles.sendBtn} onPress={sendMessage} disabled={isChatDisabled}>
              <Text style={styles.sendBtnText}>Send</Text>
            </AnimatedButton>
          </View>
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
                    onPress={submitQuestion} disabled={questionsLeft <= 0 || isParticipationBlocked}>
                    <Text style={styles.sendBtnText}>Ask</Text>
                  </AnimatedButton>
                </View>
              </>
            )}
          </View>
        )}

        <View style={styles.reactionsRow}>
          {REACTIONS.map(emoji => (
            <AnimatedButton key={emoji} style={styles.reactionBtn} onPress={() => sendReaction(emoji)}
              disabled={isParticipationBlocked}>
              <Text style={styles.reactionEmoji}>{emoji}</Text>
            </AnimatedButton>
          ))}
        </View>
      </View>

      {/* DONATION MODAL */}
<Modal visible={donateModal} transparent animationType="slide" onRequestClose={() => setDonateModal(false)}>
  <Pressable style={styles.donateBackdrop} onPress={() => setDonateModal(false)} />
  <View style={styles.donateSheet}>
    <Text style={styles.donateTitle}>🤲 Give Sadaqah</Text>
    <View style={styles.donateIslamicBox}>
      <Text style={styles.donateHadith}>"Charity does not decrease wealth."</Text>
      <Text style={styles.donateHadithSource}>— Prophet Muhammad ﷺ (Muslim)</Text>
      <Text style={styles.donateIslamicMsg}>
        Support this scholar and spread Islamic knowledge. In sha Allah, every peso you give will be rewarded on the Day of Judgment. 🌟
      </Text>
    </View>

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
  questionNotif: {
    position: 'absolute',
    top: 190,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    zIndex: 30,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  questionNotifText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
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
sadaqahTab: {
  backgroundColor: 'rgba(212,175,55,0.15)',
  borderWidth: 1,
  borderColor: COLORS.gold,
},
sadaqahTabText: {
  color: COLORS.gold,
  fontSize: 13,
  fontWeight: '700',
},
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
  textAlign: 'center', marginBottom: 12
},
donateSubtitle: {
  color: '#94a3b8', fontSize: 13,
  textAlign: 'center', marginBottom: 20
},
donateIslamicBox: {
  backgroundColor: 'rgba(212,175,55,0.08)',
  borderRadius: 16,
  borderWidth: 1,
  borderColor: 'rgba(212,175,55,0.3)',
  padding: 16,
  marginBottom: 20,
},
donateHadith: {
  color: COLORS.gold,
  fontSize: 15,
  fontWeight: '700',
  textAlign: 'center',
  fontStyle: 'italic',
  marginBottom: 4,
},
donateHadithSource: {
  color: 'rgba(212,175,55,0.6)',
  fontSize: 11,
  textAlign: 'center',
  marginBottom: 10,
},
donateIslamicMsg: {
  color: 'rgba(255,255,255,0.8)',
  fontSize: 13,
  textAlign: 'center',
  lineHeight: 20,
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
  floatingHeart: {
    position: 'absolute',
    fontSize: 30,
    zIndex: 100,
  },
  pinnedMessage: {
    position: 'absolute',
    top: 150,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 30,
    borderWidth: 1,
    borderColor: COLORS.gold,
    gap: 8,
  },
  pinnedLabel: {
    color: COLORS.gold,
    fontSize: 11,
    fontWeight: '700',
  },
  pinnedText: {
    flex: 1,
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  rightButtons: {
    position: 'absolute',
    right: 16,
    bottom: 220,
    alignItems: 'center',
    gap: 16,
    zIndex: 20,
  },
  rightBtn: {
    alignItems: 'center',
    gap: 4,
  },
  rightBtnEmoji: {
    fontSize: 32,
  },
  rightBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});