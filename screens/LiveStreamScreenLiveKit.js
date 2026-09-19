import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  FlatList,
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
import ModernDialog from './ModernDialog';
import { Room, RoomEvent, Track } from 'livekit-client';
import { registerGlobals, VideoView } from '@livekit/react-native';
import { Camera } from 'expo-camera';
import { Audio } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SystemBars } from 'react-native-edge-to-edge';
import { supabase } from '../lib/supabase';
import { setSuppressNotifications } from '../lib/notificationPolicy';
import AnimatedButton from './AnimatedButton';
import { useViewerCount } from '../hooks/useViewerCount';
import { useRecentViewers } from '../hooks/useRecentViewers';
import { useEngagedViewers } from '../hooks/useEngagedViewers';
import { useFeatureFlag } from '../hooks/useFeatureFlag';
import { COLORS } from '../constants/theme';
import { useUser } from '../context/UserContext';
import { filterMessage } from '../utils/moderation';
import { fetchWithTimeout } from '../utils/apiClient';

const { width, height } = Dimensions.get('window');
const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL;

// Returns the current Supabase access token for authenticated Railway
// requests, refreshing first if it is about to expire. Resolves to null
// when there is no usable session (caller must fail gracefully).
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

// Room-specific intentional disconnect tracking so stale Rooms cannot poison future ones.
const intentionalDisconnectRooms = new WeakSet();

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
  const streamDurationRef = useRef(0);

  // --- Pre-stream settings ---
  const [allowQuestions, setAllowQuestions] = useState(true);
  const [useExternalMic, setUseExternalMic] = useState(false);
  // NOTE: saveToProfile removed — recording not available on free LiveKit plan

  // --- UI state ---
  const [showEndModal, setShowEndModal] = useState(false);
  const [egressId, setEgressId] = useState(null);
  const egressIdRef = useRef(null);
  const egressFilenameRef = useRef(null);
  // Holds the in-flight /egress/start promise so cleanup()/abnormal teardown
  // can await it before deciding whether an egress exists that must be
  // stopped before the live_streams row may be deleted.
  const egressStartPromiseRef = useRef(null);
  const [isEnding, setIsEnding] = useState(false);
  const [streamAnalytics, setStreamAnalytics] = useState(null);
  const peakViewersRef = useRef(0);
  const [showViewerList, setShowViewerList] = useState(false);
  const [viewerListMode, setViewerListMode] = useState('recent');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [dialog, setDialog] = useState({ visible: false, title: '', message: '', type: 'info', buttons: [] });

  // --- Chat & Questions ---
  const [messages, setMessages] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [chatInput, setChatInput] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  const [liveNotifs, setLiveNotifs] = useState([]);
  const notifId = useRef(0);
  const [mutedUsers, setMutedUsers] = useState([]);
  const mutedUsersRef = useRef([]);
  const [blockedUsers, setBlockedUsers] = useState([]);
  const blockedUsersRef = useRef([]);
  const [pinnedMessage, setPinnedMessage] = useState(null);
  const [moderationMenu, setModerationMenu] = useState(null);

  // --- Refs ---
  const roomRef = useRef(null);
  const flatListRef = useRef(null);
  const currentStreamIdRef = useRef(null);
  const isConnectedRef = useRef(false);
  const isMountedRef = useRef(true);
  const chatChannelRef = useRef(null);
  const questionsChannelRef = useRef(null);
  const liveFeedChannelRef = useRef(null);
  const pingInterval = useRef(null);
  // Token for the in-flight host heartbeat tick (null = none running). An
  // object token (not a boolean) so a still-running OLD tick's finally can
  // never clear the guard while a NEW stream's tick owns it.
  const pingInFlightRef = useRef(null);
  const durationIntervalRef = useRef(null);
  const backgroundTimeRef = useRef(null);
  const appStateSubscription = useRef(null);
  const cameraRetryTimeoutRef = useRef(null);
  // Holds { timeoutId, resolve } for the pending camera-retry delay so cleanup can abort the wait.
  const cameraRetryWaitRef = useRef(null);

  // --- Lifecycle guards (start attempt tracking, double-tap guard, normal-vs-abnormal end) ---
  const startAttemptIdRef = useRef(0);
  const isStartingRef = useRef(false);
  const streamEndedRef = useRef(true); // true until a stream is actually created
  const questionsRequestIdRef = useRef(0);
  const moderationRequestIdRef = useRef(0);
  // True while a live_moderation upsert is in flight, so rapid Mute/Block
  // taps can never launch concurrent writes or land out of order.
  const moderationInFlightRef = useRef(false);
  // True while a chat message insert is in flight, so rapid Send taps or
  // submit+tap can never launch concurrent inserts.
  const sendingMessageRef = useRef(false);

  // --- Viewer hooks ---
  const { viewerCount } = useViewerCount(streamId);
  const { recentViewers } = useRecentViewers(streamId);
  const { engagedViewers } = useEngagedViewers(streamId);
  const { enabled: showEngagedTab } = useFeatureFlag('engaged_viewers_tab');

  useEffect(() => {
    if (viewerCount > peakViewersRef.current) {
      peakViewersRef.current = viewerCount;
    }
  }, [viewerCount]);

  // ─── MOUNT ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;

    (async () => {
      try {
        const [cameraPermission, microphonePermission] = await Promise.all([
          Camera.requestCameraPermissionsAsync(),
          Audio.requestPermissionsAsync(),
        ]);

        if (!isMountedRef.current) return;

        const granted =
          cameraPermission.status === 'granted' &&
          microphonePermission.status === 'granted';

        setHasPermission(granted);

        if (!granted) {
          setDialog({
            visible: true,
            title: 'Permission needed',
            message: 'Camera and microphone permissions are required to stream.',
            type: 'warning',
            buttons: [
              {
                text: 'OK',
                onPress: () =>
                  setDialog(d => ({ ...d, visible: false })),
              },
            ],
          });
        }
      } catch (permissionError) {
        if (!isMountedRef.current) return;

        setHasPermission(false);

        setDialog({
          visible: true,
          title: 'Permission error',
          message: 'Could not check camera and microphone permissions. Please try again.',
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
    })();

    const name = `bushrann_${currentUser?.id ?? Date.now()}_${Date.now()}`;
    setRoomName(name);

    const keyboardDidShow = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const keyboardDidHide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });

    // Suppress push notifications while streaming without replacing
    // the app-wide notification handler.
    setSuppressNotifications(true);

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
      setSuppressNotifications(false);
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
    console.log('[CLEANUP] Starting cleanup...');
    isMountedRef.current = false;
    isConnectedRef.current = false;

    if (pingInterval.current) {
      clearInterval(pingInterval.current);
      pingInterval.current = null;
    }
    // Release the heartbeat guard for any future stream attempt. Safe even
    // if an old tick is still running: its finally only clears the ref when
    // it still owns its token, and it can only write to its snapshotted
    // (old, deleted) stream id — never a new stream's row.
    pingInFlightRef.current = null;
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    if (cameraRetryTimeoutRef.current) {
      clearTimeout(cameraRetryTimeoutRef.current);
      cameraRetryTimeoutRef.current = null;
    }
    if (cameraRetryWaitRef.current) {
      clearTimeout(cameraRetryWaitRef.current.timeoutId);
      cameraRetryWaitRef.current.resolve();
      cameraRetryWaitRef.current = null;
    }
    console.log('[CLEANUP] Intervals cleared');

    if (chatChannelRef.current) {
      supabase.removeChannel(chatChannelRef.current).catch(console.warn);
      chatChannelRef.current = null;
    }
    if (questionsChannelRef.current) {
      supabase.removeChannel(questionsChannelRef.current).catch(console.warn);
      questionsChannelRef.current = null;
    }
    if (liveFeedChannelRef.current) {
      supabase.removeChannel(liveFeedChannelRef.current).catch(console.warn);
      liveFeedChannelRef.current = null;
    }
    console.log('[CLEANUP] Supabase channels removed');

    let abnormalEgressStopped = true;
    if (!streamEndedRef.current) {
      // If /egress/start is still in flight, wait for it to settle before
      // deciding whether an egress exists: deleting live_streams while the
      // start is unresolved could orphan a successfully created egress (the
      // secured /egress/stop endpoint verifies ownership via that row).
      const inFlightEgressStart = egressStartPromiseRef.current;
      if (inFlightEgressStart) {
        try {
          await inFlightEgressStart;
        } catch (e) {
          console.warn('[EGRESS] In-flight start settle error:', e);
        }
      }
      // Await the egress stop before any row deletion: /egress/stop verifies
      // stream ownership via the live_streams row, so the row must still
      // exist while the stop request runs.
      abnormalEgressStopped = await stopEgressAbnormally();
    }

    if (roomRef.current) {
      console.log('[CLEANUP] Disconnecting LiveKit...');
      try {
        intentionalDisconnectRooms.add(roomRef.current);
        await Promise.race([
          roomRef.current.disconnect(),
          new Promise(resolve => setTimeout(resolve, 1500))
        ]);
        console.log('[CLEANUP] LiveKit disconnected');
      } catch (e) {
        console.warn('[LIVEKIT] Disconnect error:', e);
      }
      roomRef.current = null;
    }

    // Best-effort: if this is an abnormal teardown (screen closed / connection
    // died without going through confirmEndStream), don't leave the stream
    // marked live on the backend. confirmEndStream sets streamEndedRef=true
    // before it does its own delete, so this never double-fires for a normal end.
    // Only delete when there is no active egress or it was stopped successfully;
    // a failed stop preserves the row so a later cleanup pass can retry the stop.
    if (!streamEndedRef.current && currentStreamIdRef.current) {
      if (abnormalEgressStopped) {
        const abandonedStreamId = currentStreamIdRef.current;
        streamEndedRef.current = true;
        supabase
          .from('live_streams')
          .delete()
          .eq('id', abandonedStreamId)
          .then(() => console.log('[CLEANUP] Abnormal stream removal complete'))
          .catch(e => console.warn('[CLEANUP] Abnormal stream removal error:', e));
      } else {
        console.warn('[CLEANUP] Egress stop failed; preserving live_streams row');
      }
    }
    currentStreamIdRef.current = null;

    console.log('[CLEANUP] Cleanup complete!');
  }

  // ─── ROLLBACK A FAILED START ─────────────────────────────────────────────────
  const rollbackFailedStart = async (streamRowId, room) => {
    console.log('[LIVEKIT] Rolling back failed start...');

    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    if (pingInterval.current) {
      clearInterval(pingInterval.current);
      pingInterval.current = null;
    }
    // Release the heartbeat guard so a future stream attempt never inherits
    // a stale in-flight token (old ticks only clear the ref if they own it).
    pingInFlightRef.current = null;
    if (cameraRetryTimeoutRef.current) {
      clearTimeout(cameraRetryTimeoutRef.current);
      cameraRetryTimeoutRef.current = null;
    }
    if (cameraRetryWaitRef.current) {
      clearTimeout(cameraRetryWaitRef.current.timeoutId);
      cameraRetryWaitRef.current.resolve();
      cameraRetryWaitRef.current = null;
    }
    if (chatChannelRef.current) {
      supabase.removeChannel(chatChannelRef.current).catch(console.warn);
      chatChannelRef.current = null;
    }
    if (questionsChannelRef.current) {
      supabase.removeChannel(questionsChannelRef.current).catch(console.warn);
      questionsChannelRef.current = null;
    }
    if (liveFeedChannelRef.current) {
      supabase.removeChannel(liveFeedChannelRef.current).catch(console.warn);
      liveFeedChannelRef.current = null;
    }

    if (room) {
      try {
        intentionalDisconnectRooms.add(room);
        await Promise.race([
          room.disconnect(),
          new Promise(resolve => setTimeout(resolve, 1500))
        ]);
      } catch (e) {
        console.warn('[LIVEKIT] Rollback disconnect error:', e);
      }
    }
    if (roomRef.current === room) {
      roomRef.current = null;
    }

    if (streamRowId) {
      try {
        await supabase.from('live_streams').delete().eq('id', streamRowId);
        console.log('[LIVEKIT] Rollback: removed partially-created stream row');
      } catch (e) {
        console.error('[LIVEKIT] Rollback stream delete error:', e);
      }
    }

    streamEndedRef.current = true;
    currentStreamIdRef.current = null;
    isConnectedRef.current = false;
  };

  // ─── START STREAM ─────────────────────────────────────────────────────────────
  const startStream = async () => {
    // Prevent rapid double-tap from launching two simultaneous attempts.
    if (isStartingRef.current || isConnectedRef.current) {
      return;
    }
    if (!hasPermission) {
      setDialog({
        visible: true,
        title: 'Error',
        message: 'Camera and microphone permissions are required to stream.',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
      });
      return;
    }
    if (!currentUser) {
      setDialog({
        visible: true,
        title: 'Error',
        message: 'You must be logged in to stream',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
      });
      return;
    }

    // Verify the current Supabase session before anything else. The same
    // token authorizes the token/egress requests to the Railway server.
    const accessToken = await getAccessToken();
    if (!accessToken) {
      setDialog({
        visible: true,
        title: 'Session expired',
        message: 'Please log in again to start a live stream.',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
      });
      return;
    }

    try {
      registerGlobals();
    } catch (e) {
      // Already initialized – ignore
    }

    isStartingRef.current = true;
    const attemptId = ++startAttemptIdRef.current;
    // True if the component unmounted, or a newer start attempt has begun
    // (e.g. user left the screen mid-await, or double-tapped Start).
    const isStale = () => !isMountedRef.current || startAttemptIdRef.current !== attemptId;

    setIsConnecting(true);
    setError(null);

    let createdStreamId = null;
    let room = null;

    try {
      // Load the profile first — defense-in-depth scholar check before any
      // stream row is created or any host token is requested.
      const { data: profile } = await supabase
        .from('profiles')
        .select('username, avatar_url, is_scholar')
        .eq('id', currentUser.id)
        .single();

      if (isStale()) return;

      // Defense-in-depth only — the server independently re-verifies
      // scholar status before granting a publish-capable token.
      if (profile?.is_scholar !== true) {
        if (isMountedRef.current && startAttemptIdRef.current === attemptId) {
          setIsConnecting(false);
          setDialog({
            visible: true,
            title: 'Not Authorized',
            message: 'Only verified scholars can start a live stream.',
            type: 'error',
            buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }]
          });
        }
        return;
      }

      setUsername(profile?.username ?? 'Scholar');

      await supabase
        .from('live_streams')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('is_live', true);

      if (isStale()) return;

      // Create the stream record BEFORE requesting the host token so the
      // token server can verify that this authenticated scholar owns this
      // exact room (it looks up live_streams by channel_name).
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
          last_ping: new Date().toISOString(),
        })
        .select()
        .single();

      if (streamError) {
        throw new Error('Could not create stream record');
      }

      createdStreamId = stream.id;

      if (isStale()) {
        await rollbackFailedStart(createdStreamId, null);
        return;
      }

      const response = await fetchWithTimeout(`${SERVER_URL}/api/livekit/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          roomName,
          isHost: true, // intent flag only; server verifies scholar + ownership
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();

        console.error(
          '[LIVEKIT] Token server error:',
          response.status,
          errorText,
          'roomName:',
          roomName
        );

        throw new Error(`Server error: ${response.status}`);
      }

      const { token, url } = await response.json();

      if (isStale()) {
        await rollbackFailedStart(createdStreamId, null);
        return;
      }

      streamEndedRef.current = false;
      setStreamId(createdStreamId);
      currentStreamIdRef.current = createdStreamId;

      room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      roomRef.current = room;

      room.on(RoomEvent.Connected, () => {
        if (isStale()) return;
        console.log('[LIVEKIT] Connected');
        setIsConnected(true);
        // Don't setIsConnecting(false) here - wait for camera
        isConnectedRef.current = true;
        setConnectionStatus('connected');
      });

      // ─── FIX 3: unexpected disconnect handler ──────────────────────────────
      room.on(RoomEvent.Disconnected, async () => {
        if (!isMountedRef.current) return;
        console.log('[LIVEKIT] Disconnected');
        setIsConnected(false);
        setLocalVideoTrack(null);
        isConnectedRef.current = false;

        const wasIntentional = intentionalDisconnectRooms.has(room);
        intentionalDisconnectRooms.delete(room);

        // Only clean up if this was NOT an intentional disconnect (cleanup/rollback/end)
        if (!wasIntentional && currentStreamIdRef.current) {
          console.log('[LIVEKIT] Unexpected disconnect — cleaning up active stream');
          const abandonedStreamId = currentStreamIdRef.current;
          startAttemptIdRef.current += 1;
          isStartingRef.current = false;

          // Stop timers
          if (pingInterval.current) {
            clearInterval(pingInterval.current);
            pingInterval.current = null;
          }
          // Release the heartbeat guard so a future stream attempt's ticks
          // don't keep skipping on this old stream's token. Safe: a
          // still-running old tick only clears the ref if it still owns its
          // token, and it can only write to its snapshotted old stream id.
          pingInFlightRef.current = null;
          if (durationIntervalRef.current) {
            clearInterval(durationIntervalRef.current);
            durationIntervalRef.current = null;
          }
          if (cameraRetryTimeoutRef.current) {
            clearTimeout(cameraRetryTimeoutRef.current);
            cameraRetryTimeoutRef.current = null;
          }
          if (cameraRetryWaitRef.current) {
            clearTimeout(cameraRetryWaitRef.current.timeoutId);
            cameraRetryWaitRef.current.resolve();
            cameraRetryWaitRef.current = null;
          }

          // Remove Supabase channels
          if (chatChannelRef.current) {
            supabase.removeChannel(chatChannelRef.current).catch(console.warn);
            chatChannelRef.current = null;
          }
          if (questionsChannelRef.current) {
            supabase.removeChannel(questionsChannelRef.current).catch(console.warn);
            questionsChannelRef.current = null;
          }
          if (liveFeedChannelRef.current) {
            supabase.removeChannel(liveFeedChannelRef.current).catch(console.warn);
            liveFeedChannelRef.current = null;
          }

          // If /egress/start is still in flight, wait for it to settle before
          // deciding whether an egress exists that must be stopped first —
          // deleting live_streams while the start is unresolved could orphan
          // a successfully created egress.
          const inFlightEgressStart = egressStartPromiseRef.current;
          if (inFlightEgressStart) {
            try {
              await inFlightEgressStart;
            } catch (e) {
              console.warn('[EGRESS] In-flight start settle error:', e);
            }
          }

          // Stop egress BEFORE deleting the live_streams row: /egress/stop
          // verifies ownership via that row, so it must still exist while
          // the stop request runs. If the stop fails, keep both egressIdRef
          // and the row (streamEndedRef stays false) so the unmount cleanup
          // pass can retry the stop before any deletion.
          const egressStopped = await stopEgressAbnormally();

          if (!egressStopped) {
            console.warn('[LIVEKIT] Egress stop failed; preserving live_streams row');
            return;
          }

          currentStreamIdRef.current = null;
          streamEndedRef.current = true;

          // Delete the live stream row
          supabase
            .from('live_streams')
            .delete()
            .eq('id', abandonedStreamId)
            .then(() => console.log('[LIVEKIT] Unexpected disconnect cleanup complete'))
            .catch(e => console.warn('[LIVEKIT] Unexpected disconnect cleanup error:', e));
        }
      });

      room.on(RoomEvent.Reconnecting, () => {
        if (!isMountedRef.current) return;
        console.log('[LIVEKIT] Reconnecting...');
        setConnectionStatus('reconnecting');
      });

      room.on(RoomEvent.Reconnected, () => {
        if (!isMountedRef.current) return;
        console.log('[LIVEKIT] Reconnected!');
        setConnectionStatus('connected');
      });

      room.on(RoomEvent.LocalTrackPublished, (publication) => {
        if (!isMountedRef.current) return;
        if (publication.track && publication.track.kind === Track.Kind.Video) {
          console.log('[LIVEKIT] Local video track ready');
          setLocalVideoTrack(publication.track);
        }
      });

      await room.connect(url, token);

      if (isStale()) {
        await rollbackFailedStart(createdStreamId, room);
        return;
      }

      // Enable camera with awaited, cancellation-safe retries
      const tryEnableCamera = async (attempt = 1) => {
        if (!isMountedRef.current || !isConnectedRef.current || isStale()) {
          console.log('[LIVEKIT] Stopping camera - stream ended');
          return;
        }

        try {
          console.log(`[LIVEKIT] Enabling camera (attempt ${attempt})...`);
          await room.localParticipant.enableCameraAndMicrophone();
          console.log('[LIVEKIT] Camera enabled successfully');
          // Only hide loading after camera is ready
          if (isMountedRef.current && !isStale()) {
            setIsConnecting(false);
          }
        } catch (e) {
          console.error(`[LIVEKIT] Camera error (attempt ${attempt}):`, e.message);
          if (attempt < 4 && isMountedRef.current && isConnectedRef.current && !isStale()) {
            const delay = attempt * 2000; // Faster retry (2s instead of 3s)
            console.log(`[LIVEKIT] Retrying in ${delay}ms...`);

            // Await the retry delay, but keep it cancellable via cleanup()/rollbackFailedStart().
            let resolver;
            const timeoutId = setTimeout(() => {
              if (cameraRetryWaitRef.current?.timeoutId === timeoutId) {
                cameraRetryWaitRef.current = null;
              }
              cameraRetryTimeoutRef.current = null;
              resolver();
            }, delay);
            cameraRetryTimeoutRef.current = timeoutId;
            await new Promise((resolve) => {
              resolver = resolve;
              cameraRetryWaitRef.current = { timeoutId, resolve };
            });

            if (!isMountedRef.current || !isConnectedRef.current || isStale()) {
              console.log('[LIVEKIT] Camera retry aborted - stale/unmounted');
              return;
            }
            await tryEnableCamera(attempt + 1);
          } else {
            console.error('[LIVEKIT] Camera failed after 4 attempts');
            throw new Error('Camera failed to start. Please check permissions and try again.');
          }
        }
      };
      await applyMicSetting();

      try {
        await tryEnableCamera();
      } catch (e) {
        await rollbackFailedStart(createdStreamId, room);

        if (isMountedRef.current && startAttemptIdRef.current === attemptId) {
          setIsConnecting(false);
          setError(e.message);
          setStreamId(null);
        }

        return;
      }

      if (isStale()) {
        await rollbackFailedStart(createdStreamId, room);
        return;
      }

      // Restore this stream's persisted mute/block sets before any chat
      // subscription can deliver messages, so the ref filters in
      // subscribeToChat agree with the database after a reconnect/remount.
      await hydrateModeration(createdStreamId);

      durationIntervalRef.current = setInterval(() => {
        streamDurationRef.current += 1;
        setStreamDuration(streamDurationRef.current);
      }, 1000);

      // Single 5s heartbeat for this stream attempt: refreshes last_ping and
      // writes the fresh (90s-window) viewer count into viewer_count for the
      // home card. The stream id is snapshotted per tick and used in the
      // UPDATE filter, so a slow tick from a previous stream can never touch
      // a newly started stream's row. A count-query failure only skips the
      // viewer_count write — last_ping is always refreshed and the stream
      // never crashes on a transient count error.
      pingInterval.current = setInterval(async () => {
        // Skip this tick while the previous one is still running: setInterval
        // does not await async callbacks, and without this guard a slow tick
        // could finish AFTER a newer tick and regress last_ping/viewer_count.
        if (pingInFlightRef.current) return;
        const pingStreamId = currentStreamIdRef.current;
        if (!pingStreamId) return;

        // Token guard: only the tick that owns the ref clears it, so an old
        // stream's late-finishing tick can't clobber a new stream's guard.
        const myPingToken = {};
        pingInFlightRef.current = myPingToken;

        try {
          let freshViewerCount = null;
          try {
            const freshCutoff = new Date(Date.now() - 90_000).toISOString();
            const { count, error: countError } = await supabase
              .from('stream_viewers')
              .select('*', { count: 'exact', head: true })
              .eq('stream_id', pingStreamId)
              .gt('last_seen_at', freshCutoff);
            if (!countError) freshViewerCount = count || 0;
          } catch (e) {
            console.warn('[VIEWERS] Heartbeat count query failed:', e);
          }

          const pingUpdate = { last_ping: new Date().toISOString() };
          if (freshViewerCount !== null) pingUpdate.viewer_count = freshViewerCount;

          try {
            const { error: pingError } = await supabase
              .from('live_streams')
              .update(pingUpdate)
              .eq('id', pingStreamId);
            if (pingError) {
              console.warn('[VIEWERS] Heartbeat live_streams update failed:', pingError);
            }
          } catch (e) {
            console.warn('[VIEWERS] Heartbeat live_streams update failed:', e);
          }
        } finally {
          if (pingInFlightRef.current === myPingToken) {
            pingInFlightRef.current = null;
          }
        }
      }, 5000);

      // Start egress recording. The secured /egress/start endpoint requires a
      // valid auth token — skip the request entirely when there is no session
      // instead of sending an unauthenticated request. The in-flight promise
      // is stored in egressStartPromiseRef so cleanup()/abnormal teardown can
      // await it before deciding whether a live_streams row may be deleted:
      // deleting the row while the start is still unresolved would leave a
      // successfully created egress orphaned (the secured /egress/stop
      // endpoint verifies ownership via that row).
      let startedEgressId = null;
      let startedEgressFilename = null;
      let egressStartFailed = false;

      const egressStartPromise = (async () => {
        try {
          const egressToken = await getAccessToken();

          if (!egressToken) {
            egressStartFailed = true;
            console.error('[EGRESS] Failed to start recording: no auth session');
            return;
          }

          const egressRes = await fetchWithTimeout(`${SERVER_URL}/api/livekit/egress/start`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${egressToken}`,
            },
            body: JSON.stringify({ roomName }),
          });

          if (egressRes.ok) {
            const egressData = await egressRes.json();

            startedEgressId = egressData.egressId ?? null;
            startedEgressFilename = egressData.filename ?? null;

            if (!startedEgressId) {
              egressStartFailed = true;
            }

            // Assign egressIdRef as soon as the egress exists so an
            // in-flight cleanup that awaited this promise can see and stop it.
            if (startedEgressId) {
              egressIdRef.current = startedEgressId;
              egressFilenameRef.current = startedEgressFilename;
            }
          } else {
            egressStartFailed = true;
            console.error('[EGRESS] Failed to start recording:', egressRes.status);
          }
        } catch (e) {
          egressStartFailed = true;
          console.error('[EGRESS] Failed to start recording:', e);
        }
      })();

      egressStartPromiseRef.current = egressStartPromise;

      try {
        await egressStartPromise;
      } finally {
        if (egressStartPromiseRef.current === egressStartPromise) {
          egressStartPromiseRef.current = null;
        }
      }

      if (isStale()) {
        // egressIdRef was assigned inside the start operation above, so the
        // shared authenticated stop helper (with its concurrent-stop guard)
                // can stop it. Await the stop BEFORE rolling back: /egress/stop
        // verifies ownership via the live_streams row, so the row must still
        // exist while the stop request runs. If the stop fails (or another
        // stop is already in flight), keep the row.
        const egressStopped = await stopEgressAbnormally();
        if (!egressStopped) {
          console.warn('[LIVEKIT] Stale start: egress stop failed, preserving live_streams row');
          return;
        }
        await rollbackFailedStart(createdStreamId, room);
        return;
      }

      if (startedEgressId) {
        setEgressId(startedEgressId);
        console.log('[EGRESS] Recording started:', startedEgressId);
      } else if (egressStartFailed && isMountedRef.current && !isStale()) {
        setDialog({
          visible: true,
          title: 'Recording unavailable',
          message: 'Your livestream is live, but recording could not start. Viewers can still watch, but a replay may not be saved.',
          type: 'warning',
          buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }],
        });
      }

      subscribeToChat(createdStreamId);
      subscribeToQuestions(createdStreamId);
      subscribeToLiveFeed(createdStreamId);

    } catch (err) {
      console.error('[LIVEKIT] Start stream error:', err);
      await rollbackFailedStart(createdStreamId, room);
      if (isMountedRef.current && startAttemptIdRef.current === attemptId) {
        setError(err.message);
        setIsConnecting(false);
        setStreamId(null);
      }
    } finally {
      isStartingRef.current = false;
    }
  };

  // ─── EXTERNAL MIC ────────────────────────────────────────────────────────────
  const applyMicSetting = async () => {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      interruptionModeIOS: useExternalMic ? 2 : 1,
      interruptionModeAndroid: useExternalMic ? 2 : 1,
    });
  };

  // ─── LIVE NOTIFICATIONS ──────────────────────────────────────────────────────
  const showLiveNotif = (text) => {
    const id = notifId.current++;
    setLiveNotifs(prev => [...prev, { id, text }]);
    setTimeout(() => {
      if (!isMountedRef.current) return;
      setLiveNotifs(prev => prev.filter(n => n.id !== id));
    }, 3000);
  };

  // ─── SWITCH CAMERA ───────────────────────────────────────────────────────────
  const switchCamera = async () => {
    if (!roomRef.current) return;
    try {
      const pub = roomRef.current.localParticipant.getTrackPublication(Track.Source.Camera);
      if (pub?.track) {
        const nextFacing = isFrontCamera ? 'environment' : 'user';
        await pub.track.restartTrack({ facingMode: nextFacing });
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

  const egressStopInProgressRef = useRef(false);

  // Awaits an authenticated /egress/stop for the currently stored egress id.
  // Returns true when it is safe to delete the live_streams row afterwards
  // (no active egress, or the egress was stopped successfully). Returns false
  // when an active egress remains — stop failed or no auth token — in which
  // case the caller MUST preserve egressIdRef and the live_streams row.
  const stopEgressAbnormally = async () => {
    const snapshottedId = egressIdRef.current;
    if (!snapshottedId) return true;
    // Another stop attempt is already in flight; don't delete the row under it.
    if (egressStopInProgressRef.current) return false;
    // Keep egressIdRef intact until the stop is known to have succeeded so a
    // failed attempt can be retried by a later cleanup pass.
    egressStopInProgressRef.current = true;
    try {
      const stopToken = await getAccessToken();
      if (!stopToken) {
        console.warn('[EGRESS] Abnormal stop skipped: no auth session');
        return false;
      }
      const abnormalStopRes = await fetchWithTimeout(`${SERVER_URL}/api/livekit/egress/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${stopToken}`,
        },
        body: JSON.stringify({ egressId: snapshottedId }),
      });
      if (!abnormalStopRes.ok) {
        console.warn('[EGRESS] Abnormal stop failed:', abnormalStopRes.status);
        return false;
      }
      // Success: release the stored egress id/filename.
      if (egressIdRef.current === snapshottedId) {
        egressIdRef.current = null;
        egressFilenameRef.current = null;
      }
      return true;
    } catch (e) {
      console.warn('[EGRESS] Abnormal stop failed:', e);
      return false;
    } finally {
      egressStopInProgressRef.current = false;
    }
  };

  const confirmEndStream = useCallback(async () => {
    console.log('[END] Starting cleanup - deleting stream to save storage');
    console.log('[END] currentStreamIdRef.current =', currentStreamIdRef.current);
    console.log('[END] Step 1 - Setting isEnding true');

    // Mark this as a normal end BEFORE any awaits, so cleanup()'s abnormal-end
    // path never races with (or double-deletes behind) this flow.
    streamEndedRef.current = true;

    setShowEndModal(false);
    setIsEnding(true);

    // Stop egress and save replay BEFORE deleting the live_streams row:
    // the secured /egress/stop endpoint verifies ownership via the
    // live_streams row, so the row must still exist while it runs. The
    // endpoint only kicks off processRecording() in the background, so
    // waiting here is just the HTTP stop operation, not video processing.
    // Body sends egressId + title only: the title's PRESENCE is the
    // wire-contract signal that a normal end should create a replay; its
    // VALUE and all other replay metadata (userId, thumbnail, filename,
    // ownership) are derived server-side from LiveKit + live_streams.
    // Snapshot — do NOT clear yet. egressIdRef is only released once the stop
    // is known to have succeeded; on failure both refs and the live_streams
    // row stay intact so the end can be retried.
    // First, if /egress/start is still in flight, wait for it to settle:
    // snapshotting egressIdRef while the start is unresolved could miss an
    // egress that is about to be created, leading to live_streams being
    // deleted while a recording exists that can no longer be stopped
    // (the secured /egress/stop endpoint verifies ownership via that row).
    const inFlightEgressStart = egressStartPromiseRef.current;
    if (inFlightEgressStart) {
      try {
        await inFlightEgressStart;
      } catch (e) {
        console.warn('[EGRESS] In-flight start settle error:', e);
      }
    }
    const normalEgressId = egressIdRef.current;

    if (normalEgressId) {
      let egressStopped = false;
      if (egressStopInProgressRef.current) {
        // Another stop (e.g. an abnormal-path stop after an unexpected
        // disconnect) is already in flight — do not send a duplicate
        // /egress/stop for the same egress, and do not delete the
        // live_streams row underneath that operation.
        console.warn('[EGRESS] Stop already in progress; skipping normal stop');
      } else {
        // Share the concurrent-stop guard with stopEgressAbnormally() so a
        // LiveKit disconnect during this request cannot trigger a second stop.
        egressStopInProgressRef.current = true;
        try {
          const stopToken = await getAccessToken();
          if (!stopToken) {
            console.error('[EGRESS] Failed to save replay: no auth session');
          } else {
            const stopRes = await fetchWithTimeout(`${SERVER_URL}/api/livekit/egress/stop`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${stopToken}`,
              },
              body: JSON.stringify({
                egressId: normalEgressId,
                title,
              }),
            });
            if (stopRes.ok) {
              egressStopped = true;
              console.log('[EGRESS] Replay saved!');
            } else {
              console.error('[EGRESS] Failed to save replay:', stopRes.status);
            }
          }
        } catch (e) {
          console.error('[EGRESS] Failed to save replay:', e);
        } finally {
          egressStopInProgressRef.current = false;
        }
      }

      if (!egressStopped) {
        // Invariant: an active egress exists and was NOT stopped — preserve
        // egressIdRef and the live_streams row, and keep the stream running.
        console.error('[END] Egress stop failed; aborting stream deletion');
        streamEndedRef.current = false;
        setIsEnding(false);
        return;
      }

      // Stop succeeded — now release the stored egress id/filename.
      if (egressIdRef.current === normalEgressId) {
        egressIdRef.current = null;
        egressFilenameRef.current = null;
      }
    }

    // Save stream ID before deleting
    const streamIdSnapshot = currentStreamIdRef.current;

    // Collect analytics BEFORE deleting stream
    try {
      const streamStart = new Date(Date.now() - streamDurationRef.current * 1000).toISOString();

      const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
      ]);

      // Count only viewers still within the 90s freshness window (3x the 30s
      // heartbeat) so stale/zombie rows don't inflate the total.
      const analyticsViewerCutoff = new Date(Date.now() - 90_000).toISOString();
      const [viewersRes, likesRes, donationsRes, followsRes] = await withTimeout(
        Promise.all([
          supabase
            .from('stream_viewers')
            .select('*', { count: 'exact', head: true })
            .eq('stream_id', streamIdSnapshot)
            .gt('last_seen_at', analyticsViewerCutoff),
          supabase
            .from('live_reactions')
            .select('*', { count: 'exact', head: true })
            .eq('stream_id', streamIdSnapshot)
            .eq('reaction', '❤️'),
          supabase
            .from('donations')
            .select('amount')
            .eq('stream_id', streamIdSnapshot),
          supabase
            .from('follows')
            .select('*', { count: 'exact', head: true })
            .eq('following_id', currentUser.id)
            .gte('created_at', streamStart),
        ]),
        5000
      );

      const totalDonations = (donationsRes.data || []).reduce(
        (sum, d) => sum + Number(d.amount || 0),
        0
      );

      if (isMountedRef.current) {
        setStreamAnalytics({
          viewers: viewersRes.count || 0,
          peakViewers: peakViewersRef.current,
          likes: likesRes.count || 0,
          donations: totalDonations,
          newFollowers: followsRes.count || 0,
          duration: streamDurationRef.current,
        });
      }
    } catch (analyticsError) {
      console.warn('[END] Analytics collection failed:', analyticsError);
    }

    // Stop timers immediately
    if (pingInterval.current) {
      clearInterval(pingInterval.current);
      pingInterval.current = null;
    }
    pingInFlightRef.current = null;

    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    // Remove realtime channels
    if (chatChannelRef.current) {
      supabase.removeChannel(chatChannelRef.current).catch(console.warn);
      chatChannelRef.current = null;
    }

    if (questionsChannelRef.current) {
      supabase.removeChannel(questionsChannelRef.current).catch(console.warn);
      questionsChannelRef.current = null;
    }

    if (liveFeedChannelRef.current) {
      supabase.removeChannel(liveFeedChannelRef.current).catch(console.warn);
      liveFeedChannelRef.current = null;
    }

    // Delete the live stream row after the recording has stopped.
    if (streamIdSnapshot) {
      try {
        const { error: deleteError } = await supabase
          .from('live_streams')
          .delete()
          .eq('id', streamIdSnapshot);

        if (deleteError) {
          console.error('[END] Failed to delete live stream:', deleteError);
        } else {
          console.log('[END] Live stream deleted');
        }
      } catch (deleteError) {
        console.error('[END] Failed to delete live stream:', deleteError);
      }
    }

    currentStreamIdRef.current = null;

    // Disconnect after DB cleanup.
    if (roomRef.current) {
      try {
        intentionalDisconnectRooms.add(roomRef.current);
        await Promise.race([
          roomRef.current.disconnect(),
          new Promise(resolve => setTimeout(resolve, 1500)),
        ]);
      } catch (disconnectError) {
        console.warn('[END] LiveKit disconnect error:', disconnectError);
      }
      roomRef.current = null;
    }

    isConnectedRef.current = false;

    if (isMountedRef.current) {
      setIsConnected(false);
      setLocalVideoTrack(null);
      setIsEnding(false);
    }

    console.log('[END] Stream ended');
  }, [currentUser?.id, title]);

  // ─── CHAT SUBSCRIPTION ───────────────────────────────────────────────────────
  const subscribeToChat = (id) => {
    if (!id) return;

    if (chatChannelRef.current) {
      supabase.removeChannel(chatChannelRef.current).catch(console.warn);
      chatChannelRef.current = null;
    }

    const channel = supabase
      .channel(`live_messages:${id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'live_messages',
          filter: `stream_id=eq.${id}`,
        },
        payload => {
          const message = payload.new;
          if (!message) return;

          // Blocked users' messages never appear to the host.
          if (blockedUsersRef.current.includes(message.user_id)) {
            return;
          }

          setMessages(prev => {
            if (prev.some(item => item.id === message.id)) {
              return prev;
            }

            const next = [...prev, message];

            // Keep memory bounded during very long streams.
            if (next.length > 300) {
              return next.slice(next.length - 300);
            }

            return next;
          });

          requestAnimationFrame(() => {
            flatListRef.current?.scrollToEnd?.({
              animated: true,
            });
          });
        }
      )
      .subscribe();

    chatChannelRef.current = channel;

    // Load existing recent chat.
    supabase
      .from('live_messages')
      .select('*')
      .eq('stream_id', id)
      .order('created_at', { ascending: true })
      .limit(100)
      .then(({ data, error: loadError }) => {
        if (
          loadError ||
          !isMountedRef.current ||
          currentStreamIdRef.current !== id
        ) {
          return;
        }

        const filtered = (data || []).filter(
          message => !blockedUsersRef.current.includes(message.user_id)
        );

        setMessages(filtered);
      });
  };

  // ─── QUESTION SUBSCRIPTION ───────────────────────────────────────────────────
  const subscribeToQuestions = (id) => {
    if (!id) return;

    if (questionsChannelRef.current) {
      supabase.removeChannel(questionsChannelRef.current).catch(console.warn);
      questionsChannelRef.current = null;
    }

    const requestId = ++questionsRequestIdRef.current;

    const loadQuestions = async () => {
      const { data, error: loadError } = await supabase
        .from('live_questions')
        .select('*')
        .eq('stream_id', id)
        .order('created_at', { ascending: true });

      if (
        loadError ||
        !isMountedRef.current ||
        currentStreamIdRef.current !== id ||
        questionsRequestIdRef.current !== requestId
      ) {
        return;
      }

      const filtered = (data || []).filter(
        question =>
          !blockedUsersRef.current.includes(question.user_id) &&
          !question.is_answered &&
          !question.is_dismissed
      );

      setQuestions(filtered);

      const selected = filtered.find(
        question => question.is_selected && !question.is_answered
      );

      setSelectedQuestion(selected || null);
    };

    loadQuestions();

    const channel = supabase
      .channel(`live_questions:${id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'live_questions',
          filter: `stream_id=eq.${id}`,
        },
        () => {
          loadQuestions();
        }
      )
      .subscribe();

    questionsChannelRef.current = channel;
  };

  // ─── LIVE FEED SUBSCRIPTION ──────────────────────────────────────────────────
  const subscribeToLiveFeed = (id) => {
    if (!id) return;

    if (liveFeedChannelRef.current) {
      supabase.removeChannel(liveFeedChannelRef.current).catch(console.warn);
      liveFeedChannelRef.current = null;
    }

    const channel = supabase
      .channel(`live_feed:${id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'live_reactions',
          filter: `stream_id=eq.${id}`,
        },
        payload => {
          if (!payload.new) return;

          if (blockedUsersRef.current.includes(payload.new.user_id)) {
            return;
          }

          if (payload.new.reaction === '❤️') {
            showLiveNotif('❤️');
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'follows',
          filter: `following_id=eq.${currentUser?.id}`,
        },
        payload => {
          const followerId = payload.new?.follower_id;
          if (!followerId) return;

          supabase
            .from('profiles')
            .select('username')
            .eq('id', followerId)
            .maybeSingle()
            .then(({ data }) => {
              if (!isMountedRef.current) return;

              showLiveNotif(
                data?.username
                  ? `@${data.username} followed you`
                  : 'New follower'
              );
            });
        }
      )
      .subscribe();

    liveFeedChannelRef.current = channel;
  };

  // ─── HYDRATE MODERATION ──────────────────────────────────────────────────────
  const hydrateModeration = async (id) => {
    if (!id) return;

    const requestId = ++moderationRequestIdRef.current;

    try {
      const { data, error: moderationError } = await supabase
        .from('live_moderation')
        .select('user_id, action')
        .eq('stream_id', id);

      if (
        moderationError ||
        !isMountedRef.current ||
        currentStreamIdRef.current !== id ||
        moderationRequestIdRef.current !== requestId
      ) {
        return;
      }

      const muted = [];
      const blocked = [];

      for (const row of data || []) {
        if (row.action === 'block') {
          blocked.push(row.user_id);
        } else if (row.action === 'mute') {
          muted.push(row.user_id);
        }
      }

      mutedUsersRef.current = muted;
      blockedUsersRef.current = blocked;

      setMutedUsers(muted);
      setBlockedUsers(blocked);

      // Remove blocked content that may have loaded before hydration.
      setMessages(prev =>
        prev.filter(
          message => !blocked.includes(message.user_id)
        )
      );

      setQuestions(prev =>
        prev.filter(
          question => !blocked.includes(question.user_id)
        )
      );

      setSelectedQuestion(prev =>
        prev && blocked.includes(prev.user_id)
          ? null
          : prev
      );
    } catch (e) {
      console.warn('[MODERATION] Hydration failed:', e);
    }
  };

  // ─── SEND CHAT MESSAGE ───────────────────────────────────────────────────────
  const sendMessage = async () => {
    if (sendingMessageRef.current) return;

    const streamIdSnapshot = currentStreamIdRef.current;
    const rawMessage = chatInput.trim();

    if (
      !streamIdSnapshot ||
      !currentUser?.id ||
      !rawMessage
    ) {
      return;
    }

    const moderationResult = filterMessage(rawMessage);

    if (!moderationResult.allowed) {
      setDialog({
        visible: true,
        title: 'Message not allowed',
        message: 'Please change your message and try again.',
        type: 'warning',
        buttons: [
          {
            text: 'OK',
            onPress: () =>
              setDialog(d => ({
                ...d,
                visible: false,
              })),
          },
        ],
      });
      return;
    }

    sendingMessageRef.current = true;

    try {
      const { error: insertError } = await supabase
        .from('live_messages')
        .insert({
          stream_id: streamIdSnapshot,
          user_id: currentUser.id,
          username,
          message: moderationResult.filteredText,
        });

      if (insertError) {
        throw insertError;
      }

      if (
        isMountedRef.current &&
        currentStreamIdRef.current === streamIdSnapshot
      ) {
        setChatInput('');
      }
    } catch (e) {
      console.error('[CHAT] Send error:', e);

      if (
        isMountedRef.current &&
        currentStreamIdRef.current === streamIdSnapshot
      ) {
        setDialog({
          visible: true,
          title: 'Message not sent',
          message: 'Your message could not be sent. Please try again.',
          type: 'error',
          buttons: [
            {
              text: 'OK',
              onPress: () =>
                setDialog(d => ({
                  ...d,
                  visible: false,
                })),
            },
          ],
        });
      }
    } finally {
      sendingMessageRef.current = false;
    }
  };

  // ─── QUESTION ACTIONS ────────────────────────────────────────────────────────
  const selectQuestion = async (question) => {
    if (!question?.id || !currentStreamIdRef.current) {
      return;
    }

    try {
      // Only one question should be selected at a time.
      if (
        selectedQuestion?.id &&
        selectedQuestion.id !== question.id
      ) {
        const { error: clearError } = await supabase
          .from('live_questions')
          .update({ is_selected: false })
          .eq('id', selectedQuestion.id)
          .eq('stream_id', currentStreamIdRef.current);

        if (clearError) {
          throw clearError;
        }
      }

      const { error: selectError } = await supabase
        .from('live_questions')
        .update({ is_selected: true })
        .eq('id', question.id)
        .eq('stream_id', currentStreamIdRef.current);

      if (selectError) {
        throw selectError;
      }

      setSelectedQuestion({
        ...question,
        is_selected: true,
      });
    } catch (e) {
      console.error('[QUESTIONS] Select error:', e);
    }
  };

  const markAnswered = async () => {
    if (
      !selectedQuestion?.id ||
      !currentStreamIdRef.current
    ) {
      return;
    }

    const questionId = selectedQuestion.id;

    try {
      const { error: updateError } = await supabase
        .from('live_questions')
        .update({
          is_answered: true,
          is_selected: false,
        })
        .eq('id', questionId)
        .eq('stream_id', currentStreamIdRef.current);

      if (updateError) {
        throw updateError;
      }

      setSelectedQuestion(null);
    } catch (e) {
      console.error('[QUESTIONS] Mark answered error:', e);
    }
  };

  const dismissQuestion = async () => {
    if (
      !selectedQuestion?.id ||
      !currentStreamIdRef.current
    ) {
      setSelectedQuestion(null);
      return;
    }

    const questionId = selectedQuestion.id;

    try {
      const { error: updateError } = await supabase
        .from('live_questions')
        .update({ is_selected: false, is_dismissed: true })
        .eq('id', questionId)
        .eq('stream_id', currentStreamIdRef.current);

      if (updateError) {
        throw updateError;
      }

      setSelectedQuestion(null);
    } catch (e) {
      console.error('[QUESTIONS] Dismiss error:', e);
    }
  };

  // ─── PIN MESSAGE ─────────────────────────────────────────────────────────────
  const pinMessage = (message) => {
    if (!message) return;

    setPinnedMessage(message);
    setModerationMenu(null);
  };

  const unpinMessage = () => {
    setPinnedMessage(null);
  };

  // ─── MODERATION ──────────────────────────────────────────────────────────────
  const applyModeration = async (
    targetUserId,
    targetUsername,
    action
  ) => {
    if (
      moderationInFlightRef.current ||
      !currentStreamIdRef.current ||
      !targetUserId ||
      targetUserId === currentUser?.id
    ) {
      return;
    }

    moderationInFlightRef.current = true;

    const streamIdSnapshot =
      currentStreamIdRef.current;

    try {
      const { error: moderationError } =
        await supabase
          .from('live_moderation')
          .upsert(
            {
              stream_id: streamIdSnapshot,
              user_id: targetUserId,
              created_by: currentUser.id,
              action,
            },
            {
              onConflict: 'stream_id,user_id',
            }
          );

      if (moderationError) {
        throw moderationError;
      }

      if (
        !isMountedRef.current ||
        currentStreamIdRef.current !==
          streamIdSnapshot
      ) {
        return;
      }

      if (action === 'block') {
        blockedUsersRef.current = Array.from(
          new Set([
            ...blockedUsersRef.current,
            targetUserId,
          ])
        );

        mutedUsersRef.current =
          mutedUsersRef.current.filter(
            id => id !== targetUserId
          );

        setBlockedUsers([
          ...blockedUsersRef.current,
        ]);

        setMutedUsers([
          ...mutedUsersRef.current,
        ]);

        setMessages(prev =>
          prev.filter(
            message =>
              message.user_id !== targetUserId
          )
        );

        setQuestions(prev =>
          prev.filter(
            question =>
              question.user_id !== targetUserId
          )
        );

        setSelectedQuestion(prev =>
          prev?.user_id === targetUserId
            ? null
            : prev
        );

        if (
          pinnedMessage?.user_id ===
          targetUserId
        ) {
          setPinnedMessage(null);
        }

        showLiveNotif(
          `🚫 @${targetUsername || 'user'} blocked`
        );
      } else {
        mutedUsersRef.current = Array.from(
          new Set([
            ...mutedUsersRef.current.filter(
              id => id !== targetUserId
            ),
            targetUserId,
          ])
        );

        blockedUsersRef.current =
          blockedUsersRef.current.filter(
            id => id !== targetUserId
          );

        setMutedUsers([
          ...mutedUsersRef.current,
        ]);

        setBlockedUsers([
          ...blockedUsersRef.current,
        ]);

        showLiveNotif(
          `🔇 @${targetUsername || 'user'} muted`
        );
      }

      setModerationMenu(null);
    } catch (e) {
      console.error(
        '[MODERATION] Update failed:',
        e
      );

      if (
        isMountedRef.current &&
        currentStreamIdRef.current ===
          streamIdSnapshot
      ) {
        // Re-hydrate authoritative DB state after
        // failure instead of leaving optimistic state.
        await hydrateModeration(
          streamIdSnapshot
        );

        setDialog({
          visible: true,
          title: 'Moderation failed',
          message:
            'The moderation action could not be saved. Please try again.',
          type: 'error',
          buttons: [
            {
              text: 'OK',
              onPress: () =>
                setDialog(d => ({
                  ...d,
                  visible: false,
                })),
            },
          ],
        });
      }
    } finally {
      moderationInFlightRef.current = false;
    }
  };

  const muteUser = (
    userId,
    targetUsername
  ) => {
    applyModeration(
      userId,
      targetUsername,
      'mute'
    );
  };

  const blockUser = (
    userId,
    targetUsername
  ) => {
    applyModeration(
      userId,
      targetUsername,
      'block'
    );
  };

  // ─── LOADING / ERROR ─────────────────────────────────────────────────────────
  if (hasPermission === null) {
    return (
      <View style={styles.loadingContainer}>
        <SystemBars style="light" />
        <ActivityIndicator
          size="large"
          color={COLORS.gold}
        />
        <Text style={styles.loadingText}>
          Checking camera permission...
        </Text>
      </View>
    );
  }

  if (isConnecting) {
    return (
      <View style={styles.loadingContainer}>
        <SystemBars style="light" />
        <ActivityIndicator
          size="large"
          color={COLORS.gold}
        />
        <Text style={styles.loadingText}>
          Starting your livestream...
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.loadingContainer}>
        <SystemBars style="light" />
        <Text style={styles.errorText}>
          {error}
        </Text>

        <AnimatedButton
          style={styles.actionButton}
          onPress={() => {
            setError(null);
            startStream();
          }}
        >
          <Text style={styles.actionButtonText}>
            Try Again
          </Text>
        </AnimatedButton>

        <AnimatedButton
          style={styles.cancelBtn}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.cancelBtnText}>
            Cancel
          </Text>
        </AnimatedButton>
      </View>
    );
  }

  if (isEnding) {
    return (
      <View style={styles.loadingContainer}>
        <SystemBars style="light" />
        <ActivityIndicator
          size="large"
          color={COLORS.gold}
        />
        <Text style={styles.loadingText}>
          Ending stream...
        </Text>
      </View>
    );
  }

  if (streamAnalytics) {
    const formatDuration = seconds => {
      const hrs = Math.floor(seconds / 3600);
      const mins = Math.floor(
        (seconds % 3600) / 60
      );
      const secs = seconds % 60;

      if (hrs > 0) {
        return `${hrs}h ${mins}m ${secs}s`;
      }

      return `${mins}m ${secs}s`;
    };

    return (
      <View style={styles.loadingContainer}>
        <SystemBars style="light" />

        <View style={styles.preStreamContainer}>
          <Text style={styles.preStreamTitle}>
            Stream Ended
          </Text>

          <Text style={styles.preStreamSubtitle}>
            Here's how your livestream performed
          </Text>

          <View style={styles.analyticsCard}>
            <View style={styles.analyticsRow}>
              <Text style={styles.analyticsEmoji}>
                👀
              </Text>
              <Text style={styles.analyticsLabel}>
                Viewers at End
              </Text>
              <Text style={styles.analyticsValue}>
                {streamAnalytics.viewers}
              </Text>
            </View>

            <View style={styles.analyticsDivider} />

            <View style={styles.analyticsRow}>
              <Text style={styles.analyticsEmoji}>
                📈
              </Text>
              <Text style={styles.analyticsLabel}>
                Peak Viewers
              </Text>
              <Text style={styles.analyticsValue}>
                {streamAnalytics.peakViewers}
              </Text>
            </View>

            <View style={styles.analyticsDivider} />

            <View style={styles.analyticsRow}>
              <Text style={styles.analyticsEmoji}>
                ❤️
              </Text>
              <Text style={styles.analyticsLabel}>
                Likes
              </Text>
              <Text style={styles.analyticsValue}>
                {streamAnalytics.likes}
              </Text>
            </View>

            <View style={styles.analyticsDivider} />

            <View style={styles.analyticsRow}>
              <Text style={styles.analyticsEmoji}>
                💰
              </Text>
              <Text style={styles.analyticsLabel}>
                Donations
              </Text>
              <Text style={styles.analyticsValue}>
                ₱{streamAnalytics.donations.toFixed(2)}
              </Text>
            </View>

            <View style={styles.analyticsDivider} />

            <View style={styles.analyticsRow}>
              <Text style={styles.analyticsEmoji}>
                ➕
              </Text>
              <Text style={styles.analyticsLabel}>
                New Followers
              </Text>
              <Text style={styles.analyticsValue}>
                {streamAnalytics.newFollowers}
              </Text>
            </View>

            <View style={styles.analyticsDivider} />

            <View style={styles.analyticsRow}>
              <Text style={styles.analyticsEmoji}>
                ⏱️
              </Text>
              <Text style={styles.analyticsLabel}>
                Duration
              </Text>
              <Text style={styles.analyticsValue}>
                {formatDuration(
                  streamAnalytics.duration
                )}
              </Text>
            </View>
          </View>

          <AnimatedButton
            style={styles.actionButton}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.actionButtonText}>
              Done
            </Text>
          </AnimatedButton>
        </View>
      </View>
    );
  }

  // ─── PRE-LIVE SCREEN ──────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <View style={styles.loadingContainer}>
        <SystemBars style="light" />

        <View style={styles.preStreamContainer}>
          <Text style={styles.preStreamTitle}>
            Go Live
          </Text>

          <Text style={styles.preStreamSubtitle}>
            {title}
          </Text>

          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>
                Allow Questions
              </Text>

              <Text style={styles.settingDescription}>
                Viewers can ask questions during your stream
              </Text>
            </View>

            <Switch
              value={allowQuestions}
              onValueChange={setAllowQuestions}
              trackColor={{
                false: '#767577',
                true: COLORS.gold,
              }}
              thumbColor={
                allowQuestions
                  ? '#fff'
                  : '#f4f3f4'
              }
            />
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>
                External Mic
              </Text>

              <Text style={styles.settingDescription}>
                Use Bluetooth or wired external microphone
              </Text>
            </View>

            <Switch
              value={useExternalMic}
              onValueChange={setUseExternalMic}
              trackColor={{
                false: '#767577',
                true: COLORS.gold,
              }}
              thumbColor={
                useExternalMic
                  ? '#fff'
                  : '#f4f3f4'
              }
            />
          </View>

          <AnimatedButton
            style={styles.goLiveBtn}
            onPress={startStream}
          >
            <Text style={styles.goLiveBtnText}>
              Start Streaming
            </Text>
          </AnimatedButton>

          <AnimatedButton
            style={styles.cancelBtn}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.cancelBtnText}>
              Cancel
            </Text>
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
        <View
          style={[
            StyleSheet.absoluteFill,
            styles.cameraFeedPlaceholder,
          ]}
        >
          <ActivityIndicator
            size="large"
            color={COLORS.gold}
          />

          <Text style={styles.cameraWaitText}>
            Camera starting...
          </Text>
        </View>
      )}

      {connectionStatus !== 'connected' && (
        <View style={styles.reconnectOverlay}>
          {connectionStatus ===
          'reconnecting' ? (
            <>
              <ActivityIndicator
                size="large"
                color="#fff"
              />

              <Text style={styles.reconnectText}>
                Reconnecting...
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.reconnectIcon}>
                ⚠️
              </Text>

              <Text style={styles.reconnectText}>
                Connection lost
              </Text>
            </>
          )}
        </View>
      )}

      {/* Live Notifications */}
      <View style={styles.liveNotifContainer}>
        {liveNotifs.map(n => (
          <View
            key={n.id}
            style={styles.liveNotif}
          >
            <Text style={styles.liveNotifText}>
              {n.text}
            </Text>
          </View>
        ))}
      </View>

      {/* TOP BAR */}
      <View
        style={[
          styles.topBar,
          {
            paddingTop:
              insets.top + 8,
          },
        ]}
      >
        <View style={styles.liveBadge}>
          <View style={styles.liveDot} />

          <Text style={styles.liveText}>
            LIVE
          </Text>

          <Text style={styles.liveDuration}>
            {String(
              Math.floor(
                streamDuration / 3600
              )
            ).padStart(2, '0')}
            :
            {String(
              Math.floor(
                (streamDuration % 3600) /
                  60
              )
            ).padStart(2, '0')}
            :
            {String(
              streamDuration % 60
            ).padStart(2, '0')}
          </Text>
        </View>

        <AnimatedButton
          style={styles.viewerBadge}
          onPress={() =>
            setShowViewerList(
              !showViewerList
            )
          }
        >
          <Text style={styles.viewerText}>
            👀 {viewerCount}
          </Text>
        </AnimatedButton>

        <AnimatedButton
          style={styles.endBtn}
          onPress={endStream}
        >
          <Text style={styles.endBtnText}>
            🛑
          </Text>
        </AnimatedButton>

        {showViewerList && (
          <View style={styles.viewerListPanel}>
            <View
              style={
                styles.viewerListHeader
              }
            >
              <Text
                style={
                  styles.viewerListTitle
                }
              >
                {showEngagedTab
                  ? viewerListMode ===
                    'recent'
                    ? 'Recent Viewers'
                    : 'Engaged Viewers'
                  : 'Recent Viewers'}{' '}
                (
                {showEngagedTab &&
                viewerListMode ===
                  'engaged'
                  ? engagedViewers.length
                  : viewerCount}
                )
              </Text>

              <AnimatedButton
                onPress={() =>
                  setShowViewerList(
                    false
                  )
                }
              >
                <Text
                  style={
                    styles.closeListText
                  }
                >
                  ✕
                </Text>
              </AnimatedButton>
            </View>

            {showEngagedTab && (
              <View
                style={
                  styles.viewerListTabs
                }
              >
                <AnimatedButton
                  style={[
                    styles.viewerListTab,
                    viewerListMode ===
                      'recent' &&
                      styles.viewerListTabActive,
                  ]}
                  onPress={() =>
                    setViewerListMode(
                      'recent'
                    )
                  }
                >
                  <Text
                    style={[
                      styles.viewerListTabText,
                      viewerListMode ===
                        'recent' &&
                        styles.viewerListTabTextActive,
                    ]}
                  >
                    Recent
                  </Text>
                </AnimatedButton>

                <AnimatedButton
                  style={[
                    styles.viewerListTab,
                    viewerListMode ===
                      'engaged' &&
                      styles.viewerListTabActive,
                  ]}
                  onPress={() =>
                    setViewerListMode(
                      'engaged'
                    )
                  }
                >
                  <Text
                    style={[
                      styles.viewerListTabText,
                      viewerListMode ===
                        'engaged' &&
                        styles.viewerListTabTextActive,
                    ]}
                  >
                    Engaged
                  </Text>
                </AnimatedButton>
              </View>
            )}

            <FlatList
              data={
                showEngagedTab &&
                viewerListMode ===
                  'engaged'
                  ? engagedViewers
                  : recentViewers
              }
              keyExtractor={item =>
                item.userId
              }
              style={styles.viewerList}
              renderItem={({
                item,
              }) => (
                <View
                  style={
                    styles.viewerItem
                  }
                >
                  {item.avatarUrl ? (
                    <Image
                      source={{
                        uri: item.avatarUrl,
                      }}
                      style={
                        styles.viewerAvatar
                      }
                    />
                  ) : (
                    <View
                      style={
                        styles.viewerAvatarPlaceholder
                      }
                    >
                      <Text
                        style={
                          styles.viewerAvatarText
                        }
                      >
                        {item.username
                          .charAt(0)
                          .toUpperCase()}
                      </Text>
                    </View>
                  )}

                  <Text
                    style={
                      styles.viewerUsername
                    }
                  >
                    @{item.username}
                  </Text>

                  {item.badge && (
                    <Text>
                      {item.badge}
                    </Text>
                  )}
                </View>
              )}
              ListEmptyComponent={
                <Text
                  style={
                    styles.emptyViewerList
                  }
                >
                  {showEngagedTab &&
                  viewerListMode ===
                    'engaged'
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
          <Text
            style={
              styles.questionBannerLabel
            }
          >
            💬 Question from @
            {selectedQuestion.username}
          </Text>

          <Text
            style={
              styles.questionBannerText
            }
          >
            {selectedQuestion.question}
          </Text>

          <View
            style={
              styles.questionBannerActions
            }
          >
            <AnimatedButton
              style={styles.answeredBtn}
              onPress={markAnswered}
            >
              <Text
                style={
                  styles.answeredBtnText
                }
              >
                ✅ Answered
              </Text>
            </AnimatedButton>

            <AnimatedButton
              style={styles.dismissBtn}
              onPress={dismissQuestion}
            >
              <Text
                style={
                  styles.dismissBtnText
                }
              >
                ✕ Dismiss
              </Text>
            </AnimatedButton>
          </View>
        </View>
      )}

      {/* Pinned Message */}
      {pinnedMessage && (
        <View style={styles.pinnedMessage}>
          <Text style={styles.pinnedLabel}>
            📌 Pinned
          </Text>

          <Text style={styles.pinnedText}>
            @{pinnedMessage.username}:{' '}
            {pinnedMessage.message}
          </Text>

          <AnimatedButton
            onPress={unpinMessage}
          >
            <Text style={styles.pinnedClose}>
              ✕
            </Text>
          </AnimatedButton>
        </View>
      )}

      {/* Moderation Menu */}
      {moderationMenu && (
        <View
          style={styles.moderationOverlay}
        >
          <View
            style={styles.moderationSheet}
          >
            <Text
              style={
                styles.moderationTitle
              }
            >
              @{moderationMenu.username}
            </Text>

            <Text
              style={
                styles.moderationMessage
              }
              numberOfLines={2}
            >
              {moderationMenu.message}
            </Text>

            <AnimatedButton
              style={
                styles.moderationBtn
              }
              onPress={() =>
                pinMessage(
                  moderationMenu
                )
              }
            >
              <Text
                style={
                  styles.moderationBtnText
                }
              >
                📌 Pin Message
              </Text>
            </AnimatedButton>

            <AnimatedButton
              style={
                styles.moderationBtn
              }
              onPress={() =>
                muteUser(
                  moderationMenu.user_id,
                  moderationMenu.username
                )
              }
            >
              <Text
                style={
                  styles.moderationBtnText
                }
              >
                🔇 Mute User
              </Text>
            </AnimatedButton>

            <AnimatedButton
              style={[
                styles.moderationBtn,
                styles.moderationBtnDanger,
              ]}
              onPress={() =>
                blockUser(
                  moderationMenu.user_id,
                  moderationMenu.username
                )
              }
            >
              <Text
                style={
                  styles.moderationBtnText
                }
              >
                🚫 Block User
              </Text>
            </AnimatedButton>

            <AnimatedButton
              style={
                styles.moderationCancelBtn
              }
              onPress={() =>
                setModerationMenu(null)
              }
            >
              <Text
                style={
                  styles.moderationCancelText
                }
              >
                Cancel
              </Text>
            </AnimatedButton>
          </View>
        </View>
      )}

      {/* BOTTOM PANEL */}
      <View
        style={[
          styles.bottomPanel,
          {
            paddingBottom:
              insets.bottom + 8,
          },
        ]}
      >
        {activeTab === 'chat' && (
          <FlatList
            ref={flatListRef}
                        data={messages}
            keyExtractor={(item) => String(item.id)}
            style={styles.chatList}
            renderItem={({ item }) => (
              <AnimatedButton
                style={styles.chatMessage}
                onLongPress={() => setModerationMenu(item)}
                delayLongPress={400}
              >
                <Text style={styles.chatUsername}>@{item.username} </Text>
                <Text style={styles.chatText}>{item.message}</Text>
              </AnimatedButton>
            )}
            showsVerticalScrollIndicator={false}
          />
        )}

        <View style={styles.tabs}>
          <AnimatedButton
            style={[styles.tab, activeTab === 'chat' && styles.tabActive]}
            onPress={() => setActiveTab('chat')}
          >
            <Text style={[styles.tabText, activeTab === 'chat' && styles.tabTextActive]}>
              💬 Chat
            </Text>
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
          <View
            style={[
              styles.chatInputRow,
              {
                marginBottom: Math.max(
                  10,
                  keyboardHeight - 45
                ),
              },
            ]}
          >
            <TextInput
              style={styles.chatInput}
              value={chatInput}
              onChangeText={setChatInput}
              placeholder="Say something..."
              placeholderTextColor="#64748b"
              onSubmitEditing={sendMessage}
              returnKeyType="send"
              maxLength={500}
            />

            <AnimatedButton
              style={styles.sendBtn}
              onPress={sendMessage}
            >
              <Text style={styles.sendBtnText}>
                Send
              </Text>
            </AnimatedButton>
          </View>
        )}

        {activeTab === 'questions' && (
          <FlatList
            data={questions}
            keyExtractor={(item) => String(item.id)}
            style={styles.chatList}
            ListEmptyComponent={
              <View style={styles.emptyQuestions}>
                <Text style={styles.emptyQuestionsText}>
                  No questions yet
                </Text>

                <Text style={styles.emptyQuestionsSubtext}>
                  Viewers can submit questions during your live
                </Text>
              </View>
            }
            renderItem={({ item }) => (
              <AnimatedButton
                style={[
                  styles.questionItem,
                  item.is_selected &&
                    styles.questionItemSelected,
                ]}
                onPress={() => selectQuestion(item)}
              >
                <Text style={styles.questionUsername}>
                  @{item.username}
                </Text>

                <Text style={styles.questionText}>
                  {item.question}
                </Text>

                {item.is_selected && (
                  <Text style={styles.questionSelectedBadge}>
                    👀 On screen
                  </Text>
                )}
              </AnimatedButton>
            )}
          />
        )}

        <View style={styles.cameraControls}>
          <AnimatedButton
            style={styles.flipBtnBottom}
            onPress={switchCamera}
          >
            <Text style={styles.flipBtnBottomText}>
              🔄 Flip
            </Text>
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

            <Text style={styles.glassModalTitle}>
              End Stream
            </Text>

            <Text style={styles.glassModalSubtitle}>
              This will end your live session for all viewers.
            </Text>

            <View style={styles.glassModalButtons}>
              <AnimatedButton
                style={styles.glassModalCancel}
                onPress={() =>
                  setShowEndModal(false)
                }
              >
                <Text style={styles.glassModalCancelText}>
                  Cancel
                </Text>
              </AnimatedButton>

              <AnimatedButton
                style={styles.glassModalEnd}
                onPress={confirmEndStream}
              >
                <Text style={styles.glassModalEndText}>
                  End Stream
                </Text>
              </AnimatedButton>
            </View>
          </View>
        </View>
      )}

      <ModernDialog
        visible={dialog.visible}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        buttons={dialog.buttons}
        onDismiss={() =>
          setDialog({
            ...dialog,
            visible: false,
          })
        }
      />
    </View>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
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
    gap: 16,
    paddingHorizontal: 24,
  },

  loadingText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },

  errorText: {
    color: '#ef4444',
    fontSize: 15,
    marginBottom: 20,
    textAlign: 'center',
    fontWeight: '600',
  },

  actionButton: {
    backgroundColor: COLORS.gold,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 24,
    marginTop: 16,
    shadowColor: COLORS.gold,
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    elevation: 4,
  },

  actionButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700'
  },

  preStreamContainer: {
    width: '100%',
    padding: 24,
    alignItems: 'center'
  },

  preStreamTitle: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 6,
    letterSpacing: -0.5,
  },

  preStreamSubtitle: {
    color: COLORS.gold,
    fontSize: 16,
    marginBottom: 36,
    fontWeight: '500',
  },

  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },

  settingInfo: {
    flex: 1,
    marginRight: 12
  },

  settingLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4
  },

  settingDescription: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
    lineHeight: 18,
  },

  noticeBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
    padding: 14,
    width: '100%',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 10,
  },

  noticeIcon: {
    fontSize: 16
  },

  noticeText: {
    flex: 1,
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
    lineHeight: 19,
  },

  goLiveBtn: {
    backgroundColor: '#B76E79',
    borderRadius: 14,
    paddingHorizontal: 40,
    paddingVertical: 16,
    width: '100%',
    alignItems: 'center',
    marginTop: 4,
    shadowColor: '#B76E79',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    elevation: 6,
  },

  goLiveBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0.3,
  },

  cancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 14,
    paddingHorizontal: 40,
    paddingVertical: 16,
    width: '100%',
    alignItems: 'center',
    marginTop: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },

  cancelBtnText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    fontWeight: '600'
  },

  cameraFeedPlaceholder: {
    backgroundColor: '#0a0a0a',
    justifyContent: 'center',
    alignItems: 'center',
  },

  cameraWaitText: {
    color: 'rgba(255,255,255,0.5)',
    marginTop: 12,
    fontSize: 14,
    fontWeight: '500',
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
    zIndex: 10,
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
    shadowOffset: {
      width: 0,
      height: 2,
    },
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

  liveDuration: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
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

  endBtn: {
    marginLeft: 'auto',
    backgroundColor: 'rgba(239,68,68,0.85)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.5)',
  },

  endBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13
  },

  viewerListPanel: {
    position: 'absolute',
    top: 50,
    right: 16,
    width: 260,
    maxHeight: 320,
    backgroundColor: 'rgba(10,10,10,0.95)',
    borderRadius: 16,
    padding: 14,
    zIndex: 100,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },

  viewerListHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },

  viewerListTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700'
  },

  closeListText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 16,
    fontWeight: '700'
  },

  viewerList: {
    maxHeight: 250
  },

  viewerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10
  },

  viewerAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17
  },

  viewerAvatarPlaceholder: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: COLORS.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },

  viewerAvatarText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700'
  },

  viewerUsername: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600'
  },

  emptyViewerList: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20
  },

  viewerListTabs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12
  },

  viewerListTab: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },

  viewerListTabActive: {
    backgroundColor: COLORS.gold,
    borderColor: COLORS.gold,
  },

  viewerListTabText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '600'
  },

  viewerListTabTextActive: {
    color: '#fff'
  },

  questionBanner: {
    position: 'absolute',
    top: 100,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.9)',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.gold,
    zIndex: 20,
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
    marginBottom: 12,
    lineHeight: 22,
  },

  questionBannerActions: {
    flexDirection: 'row',
    gap: 10
  },

  answeredBtn: {
    flex: 1,
    backgroundColor: '#10b981',
    borderRadius: 12,
    padding: 10,
    alignItems: 'center',
  },

  answeredBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13
  },

  dismissBtn: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    padding: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },

  dismissBtnText: {
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '700',
    fontSize: 13
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
  },

  tabText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    fontWeight: '600'
  },

  tabTextActive: {
    color: '#fff'
  },

  chatList: {
    maxHeight: height * 0.25,
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
    fontSize: 13
  },

  chatText: {
    color: '#fff',
    fontSize: 13
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
  },

  sendBtn: {
    backgroundColor: COLORS.gold,
    borderRadius: 24,
    paddingHorizontal: 18,
    justifyContent: 'center',
    shadowColor: COLORS.gold,
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    elevation: 3,
  },

  sendBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13
  },

  emptyQuestions: {
    padding: 24,
    alignItems: 'center'
  },

  emptyQuestionsText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6,
  },

  emptyQuestionsSubtext: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    textAlign: 'center',
  },

  questionItem: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },

  questionItemSelected: {
    borderWidth: 1,
    borderColor: COLORS.gold,
    backgroundColor: 'rgba(183,110,121,0.15)',
  },

  questionUsername: {
    color: COLORS.gold,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },

  questionText: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 20,
  },

  questionSelectedBadge: {
    color: COLORS.gold,
    fontSize: 11,
    marginTop: 6,
    fontWeight: '600',
  },

  cameraControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 10,
  },

  flipBtnBottom: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },

  flipBtnBottomText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },

  liveNotifContainer: {
    position: 'absolute',
    top: 120,
    left: 16,
    zIndex: 50,
    gap: 8,
  },

  liveNotif: {
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },

  liveNotifText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },

  reconnectOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },

  reconnectText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 16,
  },

  reconnectIcon: {
    fontSize: 48
  },

  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },

  glassModal: {
    width: 300,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    padding: 30,
    alignItems: 'center',
  },

  glassModalIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },

  glassModalDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#ef4444',
  },

  glassModalTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 8,
    letterSpacing: -0.5,
  },

  glassModalSubtitle: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 28,
  },

  glassModalButtons: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },

  glassModalCancel: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },

  glassModalCancelText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 14,
    fontWeight: '600',
  },

  glassModalEnd: {
    flex: 1,
    backgroundColor: '#ef4444',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    shadowColor: '#ef4444',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    elevation: 4,
  },

  glassModalEndText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },

  analyticsCard: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 20,
    padding: 20,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },

  analyticsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },

  analyticsEmoji: {
    fontSize: 22,
    width: 32,
  },

  analyticsLabel: {
    flex: 1,
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    fontWeight: '500',
  },

  analyticsValue: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },

  analyticsDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },

  pinnedMessage: {
    position: 'absolute',
    top: 80,
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

  pinnedClose: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 16,
    fontWeight: '700',
  },

  moderationOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
    zIndex: 999,
  },

  moderationSheet: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
    gap: 10,
  },

  moderationTitle: {
    color: COLORS.gold,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 4,
  },

  moderationMessage: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    marginBottom: 12,
  },

  moderationBtn: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },

  moderationBtnDanger: {
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderColor: 'rgba(239,68,68,0.3)',
  },

  moderationBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },

  moderationCancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    marginTop: 4,
  },

  moderationCancelText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 15,
    fontWeight: '600',
  },
});