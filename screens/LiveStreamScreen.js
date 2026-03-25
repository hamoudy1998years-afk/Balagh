import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, FlatList, Alert,
  Keyboard, Platform, ActivityIndicator, BackHandler,
  Dimensions, PermissionsAndroid, AppState, Switch,
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
import NetInfo from '@react-native-community/netinfo';
import { useViewerCount } from '../hooks/useViewerCount';
import { useRecentViewers } from '../hooks/useRecentViewers';
import { useEngagedViewers } from '../hooks/useEngagedViewers';
import { useFeatureFlag } from '../hooks/useFeatureFlag';
import RNFS from 'react-native-fs';
import { COLORS } from '../constants/theme';
import { ROUTES } from '../constants/routes';
import { useUser } from '../context/UserContext';
import { filterMessage } from '../utils/moderation';
import { SystemBars } from 'react-native-edge-to-edge';

const { width, height } = Dimensions.get('window');
const AGORA_APP_ID = process.env.EXPO_PUBLIC_AGORA_APP_ID;

// 🔧 FIXED: Removed trailing space
const THUMBNAIL_SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL;

// ✅ Dedicated recording UID - must NOT match any real participant UID
const RECORDING_UID = 12345;

async function getAgoraToken(channelName, uid, role) {
  __DEV__ && console.log('🚀 [getAgoraToken] Fetching token...');
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
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token server ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = await response.json();
    return data.token;
  } catch (error) {
    __DEV__ && console.log('[getAgoraToken] Network error:', error.message);
    return null;
  }
}

async function uploadThumbnail(filePath, streamId) {
  try {
    __DEV__ && console.log('📤 Uploading snapshot to Supabase...');

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
      __DEV__ && console.log('📤 Upload error (offline?):', error.message);
      return null;
    }

    __DEV__ && console.log('✅ Upload successful:', data);

    const { data: { publicUrl } } = supabase.storage
      .from('thumbnails')
      .getPublicUrl(fileName);

    __DEV__ && console.log('✅ Thumbnail public URL:', publicUrl);

    await supabase
      .from('live_streams')
      .update({ thumbnail_url: publicUrl })
      .eq('id', streamId);

    return publicUrl;
  } catch (error) {
    __DEV__ && console.log('📤 Thumbnail upload failed (offline?):', error.message);
    // Continue without thumbnail - stream still works
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
  const { user: currentUser } = useUser();
  const [username, setUsername] = useState('');
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [showViewerList, setShowViewerList] = useState(false);
  const [viewerListMode, setViewerListMode] = useState('recent');
  const [allowQuestions, setAllowQuestions] = useState(true);
  const [saveToProfile, setSaveToProfile] = useState(true); // default ON
  const [isStarting, setIsStarting] = useState(false);
  const [recordingIds, setRecordingIds] = useState({ resourceId: null, sid: null });
  const recordingIdsRef = useRef({ resourceId: null, sid: null });
  const [showEndModal, setShowEndModal] = useState(false);
  const [isEndingStream, setIsEndingStream] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState(null);
  const thumbnailUrlRef = useRef(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isEnding, setIsEnding] = useState(false);
  const [endingMessage, setEndingMessage] = useState('');
  
  // Network failover state
  const [connectionStatus, setConnectionStatus] = useState('connected'); // 'connected' | 'reconnecting' | 'failed'
  const lastNetworkType = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const backgroundTimeRef = useRef(null);
  const isReconnectingRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const isMountedRef = useRef(true);
  const MAX_RETRIES = 5;

  // Chat moderation state
  const [userStrikes, setUserStrikes] = useState({});

  const engineRef = useRef(null);
  const flatListRef = useRef(null);
  const appStateSubscription = useRef(null);
  const pingInterval = useRef(null);
  const snapshotTimeoutRef = useRef(null);
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
      isMountedRef.current = true;
      __DEV__ && console.log('📹 [LiveStreamScreen] Component MOUNTED');
      
      // REMOVED: setup() - now called manually when pressing "Start Streaming"
      
      // Network monitoring for failover
      const netInfoSubscription = NetInfo.addEventListener(state => {
        // Fix offline detection
        if (!state.isInternetReachable) {
          __DEV__ && console.log('[NETINFO] Setting OFFLINE');
          setConnectionStatus('offline');
        } else if (state.isInternetReachable && connectionStatus === 'offline') {
          // Internet back
          __DEV__ && console.log('[NetInfo] Back online, retrying...');
          reconnectAttemptRef.current = 0;
          setConnectionStatus('connected');
          handleNetworkReconnect();
        }
        
        const currentType = state.type;
        const wasOffline = !lastNetworkType.current || lastNetworkType.current === 'none';
        const isOffline = !state.isConnected || state.type === 'none';
        
        // Network type changed (e.g., wifi -> cellular, or connection lost)
        if (currentType !== lastNetworkType.current && isLiveRef.current) {
          __DEV__ && console.log('🌐 [Network] Type changed:', lastNetworkType.current, '->', currentType);
          
          if (isOffline || (!wasOffline && isOffline)) {
            __DEV__ && console.log('🌐 [Network] Connection lost, triggering reconnect...');
            if (!isReconnectingRef.current) {
              handleNetworkReconnect();
            }
          }
        }
        
        lastNetworkType.current = currentType;
      });
      
      appStateSubscription.current = AppState.addEventListener('change', nextAppState => {
        if (nextAppState === 'background' || nextAppState === 'inactive') {
          __DEV__ && console.log('App went to background, tracking time...');
          backgroundTimeRef.current = Date.now();
        } else if (nextAppState === 'active' && backgroundTimeRef.current) {
          const timeInBackground = Date.now() - backgroundTimeRef.current;
          __DEV__ && console.log('App returned from background after', timeInBackground, 'ms');
          
          // If was in background >30s and is live, force reconnect
          if (timeInBackground > 30000 && isLiveRef.current) {
            __DEV__ && console.log('🌐 [Network] Background timeout, forcing reconnect...');
            if (!isReconnectingRef.current) {
              handleNetworkReconnect();
            }
          }
          backgroundTimeRef.current = null;
        }
      });

      const keyboardDidShow = Keyboard.addListener('keyboardDidShow', (e) => {
        setKeyboardHeight(e.endCoordinates.height);
      });
      const keyboardDidHide = Keyboard.addListener('keyboardDidHide', () => {
        setKeyboardHeight(0);
      });

      return () => {
        isMountedRef.current = false;
        console.log('[DEBUG] Component unmounting, isMounted=false');
        if (appStateSubscription.current) {
          appStateSubscription.current.remove();
        }
        if (netInfoSubscription) {
          netInfoSubscription();
        }
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
        keyboardDidShow.remove();
        keyboardDidHide.remove();
        console.log('[LIFECYCLE] Component UNMOUNTING');
        cleanup();
      };
    }, []);

  // Log when connectionStatus changes
  // Simple stuck-state recovery
  useEffect(() => {
    if (isLive && !engineRef.current) {
      setIsLive(false);
      setConnectionStatus('disconnected');
    }
  }, [isLive]);

  // BackHandler with Alert confirmation
  useEffect(() => {
    const backAction = () => {
      if (!isLive) {
        navigation.goBack();
        return true;
      }
      // Show the same end stream modal as the End button
      setShowEndModal(true);
      return true;
    };
    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [isLive]);

  async function requestPermissions() {
    __DEV__ && console.log('🔐 [requestPermissions] Checking permissions...');
    
    if (Platform.OS === 'android') {
      __DEV__ && console.log('🔐 [requestPermissions] Android detected, requesting permissions...');
      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);
      
      const cameraGranted = results[PermissionsAndroid.PERMISSIONS.CAMERA] === PermissionsAndroid.RESULTS.GRANTED;
      const audioGranted = results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === PermissionsAndroid.RESULTS.GRANTED;
      console.log('[PERM] Camera:', cameraGranted, 'Audio:', audioGranted);
      
      __DEV__ && console.log('🔐 [requestPermissions] Camera granted:', cameraGranted);
      __DEV__ && console.log('🔐 [requestPermissions] Audio granted:', audioGranted);
      
      if (!cameraGranted) {
        __DEV__ && console.log('❌ [requestPermissions] Camera permission DENIED');
        Alert.alert('Permission Required', 'Camera permission is needed to stream');
        return false;
      }
      
      if (!audioGranted) {
        __DEV__ && console.log('⚠️ [requestPermissions] Audio permission DENIED (camera ok, continuing)');
      }
      
      __DEV__ && console.log('✅ [requestPermissions] All required permissions granted');
    } else {
      __DEV__ && console.log('🔐 [requestPermissions] iOS detected, permissions checked via Info.plist');
    }
    return true;
  }

  // Network failover: handle reconnection with exponential backoff
  const handleNetworkReconnect = useCallback(async (isFromError = false) => {
    // Guard: Don't proceed if component unmounted
    if (!isMountedRef.current) return;
    if (!isLiveRef.current || !engineRef.current) return;
    
    // Check internet first
    const netInfo = await NetInfo.fetch();
    if (!netInfo.isInternetReachable) {
      setConnectionStatus('offline');
      return;
    }
    
    // Prevent parallel reconnection attempts
    if (isReconnectingRef.current) return;
    
    // Check max retries BEFORE attempting
    if (reconnectAttemptRef.current >= MAX_RETRIES) {
      setConnectionStatus('failed');
      return;
    }
    
    isReconnectingRef.current = true;
    reconnectAttemptRef.current += 1;
    const attempt = reconnectAttemptRef.current;
    
    __DEV__ && console.log('🌐 [Network] Reconnect attempt', attempt, '/', MAX_RETRIES);
    setConnectionStatus('reconnecting');
    
    try {
      // Leave current channel
      await engineRef.current?.leaveChannel();
      __DEV__ && console.log('🌐 [Network] Left channel for reconnect');
      
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s (max 30s)
      // Add 5s penalty if rate limited (429 error)
      const baseDelay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
      const rateLimitPenalty = isFromError ? 5000 : 0;
      const delay = baseDelay + rateLimitPenalty;
      console.log(`[DEBUG] Calculated delay: ${delay}ms (attempt: ${attempt})`);
      __DEV__ && console.log('🌐 [Network] Retrying in', delay, 'ms');
      
      await new Promise(r => setTimeout(r, delay));
      
      // Guard after delay: Check if still mounted and live
      if (!isMountedRef.current || !isLiveRef.current) {
        console.log(`[DEBUG] Not mounted or not live anymore, returning. isMounted=${isMountedRef.current}, isLive=${isLiveRef.current}`);
        return;
      }
      
      // Guard before token fetch
      if (!isMountedRef.current) {
        console.log(`[DEBUG] Component unmounted before token fetch`);
        return;
      }
      
      // Fetch new token and rejoin
      const channel = currentChannelRef.current;
      console.log(`[DEBUG] About to fetch token...`);
      
      let hostToken;
      try {
        hostToken = await getAgoraToken(channel, 1, 'host');
      } catch (error) {
        if (error.message.includes('Network request failed') || error.message.includes('Network Error')) {
          console.log('[Network] Token fetch failed - offline');
          setConnectionStatus('offline');
          return;
        }
        throw error; // Re-throw other errors
      }
      
      // Guard after token fetch
      if (!isMountedRef.current || !engineRef.current) {
        console.log(`[DEBUG] Component unmounted or engine null after token fetch`);
        throw new Error('Component unmounted or engine null');
      }
      
      if (!hostToken) {
        console.log('[Network] Failed to get token for reconnect');
        isReconnectingRef.current = false;
        // Schedule next attempt if still mounted
        if (isMountedRef.current) {
          setTimeout(() => handleNetworkReconnect(true), 1000);
        }
        return;
      }
      
      console.log(`[DEBUG] Engine before join: ${engineRef.current ? 'exists' : 'NULL'}`);
      if (!engineRef.current) {
        console.error(`[DEBUG] Engine is NULL! Cannot join.`);
      }
      
      await engineRef.current.joinChannel(hostToken, channel, 1, {
        clientRoleType: ClientRoleType.ClientRoleBroadcaster,
        publishCameraTrack: true,
        publishMicrophoneTrack: true,
      });
      
      // SUCCESS - DO NOT reset counter here, only on initial setup or manual retry
      __DEV__ && console.log('✅ [Network] Reconnect successful');
      setConnectionStatus('connected');
    } catch (error) {
      console.log('[DEBUG-RECONNECT] handleReconnect FAILED:', error.message);
      // Use console.log for network errors, not console.error
      if (error.message.includes('Network') || error.message.includes('network') || error.message.includes('offline')) {
        setConnectionStatus('offline');
      }
      // Don't reset counter here - keep it for next attempt
      const isRateLimited = error?.response?.status === 429 || error?.message?.includes('429');
      if (!isMountedRef.current) return;
      if (attempt < MAX_RETRIES) {
        setTimeout(() => handleNetworkReconnect(isRateLimited), 1000);
      } else {
        setConnectionStatus('failed');
      }
    } finally {
      isReconnectingRef.current = false;
    }
  }, []);

  function switchCamera() {
    __DEV__ && console.log('🎥 [switchCamera] Switching camera...');
    __DEV__ && console.log('🎥 [switchCamera] Engine exists:', !!engineRef.current);
    
    if (engineRef.current) {
      try {
        engineRef.current.switchCamera();
        setIsFrontCamera(!isFrontCamera);
        __DEV__ && console.log('✅ [switchCamera] Camera switched to:', !isFrontCamera ? 'front' : 'back');
      } catch (e) {
        __DEV__ && console.error('❌ [switchCamera] Error:', e);
      }
    } else {
      __DEV__ && console.warn('⚠️ [switchCamera] No engine available');
    }
  }

  async function setup() {
    __DEV__ && console.log('🎬 [setup] ========== SETUP STARTED ==========');
    __DEV__ && console.log('🎬 [setup] currentUser exists:', !!currentUser);
    
    if (!currentUser) {
      __DEV__ && console.log('❌ [setup] No currentUser, aborting');
      setIsStarting(false);
      return;
    }

    const hasPermission = await requestPermissions();
    __DEV__ && console.log('🎬 [setup] Permissions result:', hasPermission);
    if (!hasPermission) {
      setIsStarting(false); // 🔧 FIXED: Reset button state
      return;
    }

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

      const channel = `bushrann_${currentUser.id}_${Date.now()}`;
      currentChannelRef.current = channel;
      __DEV__ && console.log('🎬 [setup] Channel name:', channel);

      __DEV__ && console.log('🎬 [setup] Fetching tokens...');
      const [hostToken, viewerToken] = await Promise.all([
        getAgoraToken(channel, 1, 'host'),
        getAgoraToken(channel, 0, 'audience')
      ]);

      __DEV__ && console.log('🎬 [setup] Host token received:', !!hostToken);
      __DEV__ && console.log('🎬 [setup] Viewer token received:', !!viewerToken);

      if (!hostToken) {
        __DEV__ && console.log('❌ [setup] No host token, aborting');
        Alert.alert('Error', 'Could not get streaming token. Please try again.');
        setIsStarting(false); // 🔧 FIXED: Reset button state
        navigation.goBack();
        return;
      }

      const { data: stream, error: streamError } = await supabase
        .from('live_streams')
        .insert({
          user_id: currentUser.id,
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

      __DEV__ && console.log('🎬 [setup] Creating Agora engine...');
      const engine = createAgoraRtcEngine();
      engineRef.current = engine;
      __DEV__ && console.log('🎬 [setup] Engine created:', !!engine);
      
      __DEV__ && console.log('🎬 [setup] Initializing Agora SDK...');
      __DEV__ && console.log('🎬 [setup] Using APP_ID:', AGORA_APP_ID?.substring(0, 8) + '...');
      
      try {
        const initResult = engine.initialize({ appId: AGORA_APP_ID });
        __DEV__ && console.log('🎬 [setup] Agora SDK initialized, result:', initResult);
      } catch (initError) {
        __DEV__ && console.error('❌ [setup] Agora SDK initialization FAILED:', initError);
        throw initError;
      }

      __DEV__ && console.log('🎬 [setup] Registering event handlers...');
      
      engine.registerEventHandler({
        onJoinChannelSuccess: (connection, elapsed) => {
          console.log('[AGORA] Joined channel! uid:', connection.localUid);
          __DEV__ && console.log('✅ [Agora] Joined channel:', connection.channelId);
          __DEV__ && console.log('✅ [Agora] Local UID:', connection.localUid);
          __DEV__ && console.log('✅ [Agora] Elapsed time:', elapsed);

          snapshotTimeoutRef.current = setTimeout(() => {
            // 🔧 FIXED: Use platform-specific path
            const snapshotPath = Platform.OS === 'ios' 
              ? `${RNFS.CachesDirectoryPath}/snapshot_${Date.now()}.jpg`
              : `/data/user/0/com.bushrann.app/cache/snapshot_${Date.now()}.jpg`;
            __DEV__ && console.log('📸 Taking Agora snapshot to:', snapshotPath);
            if (engineRef.current) {
              engineRef.current.takeSnapshot(0, snapshotPath);
            }
          }, 3000);
        },

        onSnapshotTaken: (connection, uid, filePath, width, height, errCode) => {
          __DEV__ && console.log('📸 [Agora] Snapshot taken! uid:', uid);
          __DEV__ && console.log('📸 [Agora] Path:', filePath);
          __DEV__ && console.log('📸 [Agora] Dimensions:', width, 'x', height);
          __DEV__ && console.log('📸 [Agora] Error code:', errCode);
          if (errCode === 0 && filePath) {
            uploadThumbnail(filePath, currentStreamIdRef.current).then(url => {
              if (url) {
                __DEV__ && console.log('📸 [Agora] Thumbnail URL saved to state:', url);
                setThumbnailUrl(url);
                thumbnailUrlRef.current = url;
              }
            });
          } else {
            __DEV__ && console.log('📸 Snapshot failed (offline?):', errCode);
          }
        },

        onError: (errCode, msg) => {
          __DEV__ && console.error('❌ [Agora] SDK Error - Code:', errCode, 'Message:', msg);
        },
        onLocalVideoStateChanged: (state, error) => {
          __DEV__ && console.log('📹 [Agora] Local video state:', state, 'error:', error);
          __DEV__ && console.log('📹 [Agora] State meaning:', state === 0 ? 'Stopped' : state === 1 ? 'Capturing' : state === 2 ? 'Encoding' : 'Unknown');
        },
        onUserJoined: (connection, uid, elapsed) => {
          console.log('[AGORA] User joined:', uid);
          __DEV__ && console.log('👤 [Agora] User joined - UID:', uid);
        },
        onUserOffline: (connection, uid, reason) => {
          console.log('[AGORA] User left:', uid);
          __DEV__ && console.log('👋 [Agora] User offline - UID:', uid, 'Reason:', reason);
        },
        onConnectionStateChanged: (connection, state, reason) => {
          console.log('[AGORA] State:', state, 'Reason:', reason);
          __DEV__ && console.log('🔗 [Agora] Connection state:', state, 'Reason:', reason);
          console.log('[DEBUG-AGORA] Connection state changed! State:', state, 'Reason:', reason);
          console.log('[DEBUG-AGORA] Current connectionStatus before handling:', connectionStatus);
          
          // Agora states: 1=Disconnected, 2=Connecting, 3=Connected, 4=Reconnecting, 5=Failed
          if (state === 1 || state === 5) {
            // Disconnected (1) or Failed (5) - trigger reconnection
            __DEV__ && console.log('🔗 [Agora] Connection lost, will reconnect...');
            console.log('[DEBUG-AGORA] State is DISCONNECTED/FAILED, checking if should reconnect...');
            console.log('[DEBUG-AGORA] isReconnectingRef:', isReconnectingRef.current);
            if (!isMountedRef.current || !engineRef.current) {
              console.log(`[DEBUG] Not mounted or no engine, skipping reconnect trigger`);
              return;
            }
            if (!isReconnectingRef.current) {
              console.log('[DEBUG-AGORA] Triggering handleReconnect from connection state change');
              handleNetworkReconnect();
            }
          } else if (state === 3) {
            // State 3 is CONNECTED - this is success
            __DEV__ && console.log('✅ [Agora] Connection established (state 3)');
            setConnectionStatus('connected');
            reconnectAttemptRef.current = 0; // Reset counter on confirmed connection
          }
        },
        onConnectionLost: () => {
          __DEV__ && console.log('🔗 [Agora] Connection lost - will attempt reconnect');
          if (!isMountedRef.current || !engineRef.current) {
            console.log(`[DEBUG] Not mounted or no engine, skipping connection lost handler`);
            return;
          }
          if (!isReconnectingRef.current) {
            handleNetworkReconnect();
          }
        }
      });

      __DEV__ && console.log('🎬 [setup] Setting channel profile to LIVE BROADCASTING');
      engine.setChannelProfile(ChannelProfileType.ChannelProfileLiveBroadcasting);
      
      __DEV__ && console.log('🎬 [setup] Setting client role to BROADCASTER');
      engine.setClientRole(ClientRoleType.ClientRoleBroadcaster);
      
      __DEV__ && console.log('🎬 [setup] Enabling video...');
      const videoEnableResult = engine.enableVideo();
      __DEV__ && console.log('🎬 [setup] enableVideo result:', videoEnableResult);
      
      __DEV__ && console.log('🎬 [setup] Starting camera preview...');
      const previewResult = engine.startPreview();
      __DEV__ && console.log('🎬 [setup] startPreview result:', previewResult);
      
      __DEV__ && console.log('🎬 [setup] Is front camera:', isFrontCamera);

      __DEV__ && console.log('🎬 [setup] Joining Agora channel...');
      __DEV__ && console.log('🎬 [setup] Channel:', channel);
      __DEV__ && console.log('🎬 [setup] UID: 1');
      __DEV__ && console.log('🎬 [setup] Token length:', hostToken?.length);
      
      try {
        const joinResult = await engine.joinChannel(hostToken, channel, 1, {
          clientRoleType: ClientRoleType.ClientRoleBroadcaster,
          publishCameraTrack: true,
          publishMicrophoneTrack: true,
        });
        __DEV__ && console.log('🎬 [setup] joinChannel result:', joinResult);
      } catch (joinError) {
        __DEV__ && console.error('❌ [setup] joinChannel FAILED:', joinError);
        throw joinError;
      }

      __DEV__ && console.log('✅ [setup] ========== SETUP COMPLETE ==========');
      console.log(`[DEBUG] Setup complete - resetting attemptRef to 0`);
      reconnectAttemptRef.current = 0;
      setIsLive(true);
      isLiveRef.current = true;
      __DEV__ && console.log('🔥 Engine exists:', engineRef.current !== null);
      setLoading(false);
      
      // Start cloud recording if saveToProfile is enabled
      if (saveToProfile) {
        startCloudRecording(channel, currentStreamId);
      }

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
      __DEV__ && console.error('❌ [setup] ========== SETUP FAILED ==========');
      __DEV__ && console.error('❌ [setup] Error:', e.message);
      __DEV__ && console.error('❌ [setup] Error stack:', e.stack);
      
      if (engineRef.current) {
        try { engineRef.current.release(); } catch (releaseError) {
          __DEV__ && console.error('❌ [setup] Engine release error:', releaseError);
        }
        engineRef.current = null;
      }
      Alert.alert('Error', 'Failed to start live stream: ' + e.message);
      setIsStarting(false);
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
    console.log('[FUNC] cleanup() STARTED. Reason:', 'unmount');
    __DEV__ && console.log('🧹 [cleanup] Cleaning up resources...');
    console.log('[DEBUG-CLEANUP] Cleanup started. Setting isLive false, isMounted false');
    console.log('[DEBUG-OFFLINE] Cleanup running. isLive was:', isLive);
    isMountedRef.current = false;
    isLiveRef.current = false;
    setIsLive(false); // Ensure React state is also updated
    
    if (snapshotTimeoutRef.current) {
      __DEV__ && console.log('🧹 [cleanup] Clearing snapshot timeout');
      clearTimeout(snapshotTimeoutRef.current);
      snapshotTimeoutRef.current = null;
    }
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
      __DEV__ && console.log('🧹 [cleanup] Leaving Agora channel...');
      try {
        engineRef.current.leaveChannel();
        __DEV__ && console.log('✅ [cleanup] Left channel');
      } catch (e) {
        __DEV__ && console.error('❌ [cleanup] Leave channel error:', e);
      }
      
      __DEV__ && console.log('🧹 [cleanup] Releasing Agora engine...');
      try {
        engineRef.current.release();
        __DEV__ && console.log('✅ [cleanup] Engine released');
      } catch (e) {
        __DEV__ && console.error('❌ [cleanup] Release engine error:', e);
      }
      console.log(`[DEBUG] Cleanup called. Setting engine to null.`);
      engineRef.current = null;
    }
    
    __DEV__ && console.log('✅ [cleanup] Cleanup complete');
  }

  function subscribeToChat(sid) {
    chatChannelRef.current = supabase
      .channel(`live_messages_${sid}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_messages', filter: `stream_id=eq.${sid}` },
        (payload) => {
          // Chat moderation check
          const moderationResult = filterMessage(payload.new.message, payload.new.username);
          
          if (!moderationResult.allowed) {
            console.log('[MODERATION] Blocked message from:', payload.new.username);
            
            // Track strikes
            const userId = payload.new.user_id;
            const newStrikes = (userStrikes[userId] || 0) + 1;
            setUserStrikes(prev => ({...prev, [userId]: newStrikes}));
            
            if (newStrikes >= 3) {
              console.log('[MODERATION] Auto-kick user:', userId);
              // Could add kick logic here
            }
            return; // Don't add to chat
          }
          
          // Use filtered text if links were removed
          const displayMessage = {
            ...payload.new,
            message: moderationResult.filteredText
          };
          
          setMessages(prev => [...prev, displayMessage]);
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
    console.log('[BTN] Send pressed. Message:', chatInput);
    if (!chatInput.trim() || !streamId || !currentUser) return;
    const msg = chatInput.replace(/<[^>]*>/g, '').trim();
    
    // Moderation check for host's own messages
    const moderationResult = filterMessage(msg, username);
    if (!moderationResult.allowed) {
      Alert.alert('Message Blocked', 'Your message contains inappropriate content.');
      return;
    }
    
    setChatInput('');
    await supabase.from('live_messages').insert({
      stream_id: streamId, user_id: currentUser.id, username, message: moderationResult.filteredText,
    });
  }

  async function selectQuestion(question) {
    setSelectedQuestion(question);
    await supabase.from('live_questions').update({ is_selected: true }).eq('id', question.id);
  }

  async function markAnswered() {
    console.log('[BTN] Mark Answered pressed');
    if (!selectedQuestion) return;
    await supabase.from('live_questions').update({ is_answered: true, is_selected: false }).eq('id', selectedQuestion.id);
    setSelectedQuestion(null);
    loadQuestions(streamId);
  }

  async function dismissQuestion() {
    console.log('[BTN] Dismiss Question pressed');
    if (!selectedQuestion) return;
    await supabase.from('live_questions').update({ is_selected: false }).eq('id', selectedQuestion.id);
    setSelectedQuestion(null);
  }

  async function endStream() {
    console.log('[FUNC] endStream() STARTED');
    setShowEndModal(true);
  }

  // Start Agora Cloud Recording
  async function startCloudRecording(channelName, currentStreamId) {
    try {
      console.log('[RECORDING] Starting cloud recording...');

      // ✅ Get a token for the recording UID
      const recordingToken = await getAgoraToken(channelName, RECORDING_UID, 'host');
      if (!recordingToken) {
        console.log('[RECORDING] Could not get recording token, skipping');
        return;
      }
      console.log('[RECORDING] Got recording token:', !!recordingToken);

      const url = `${THUMBNAIL_SERVER_URL}/api/recording/start`;
      console.log('[RECORDING] Calling URL:', url);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelName: channelName,
          uid: RECORDING_UID,
          token: recordingToken, // ✅ pass token to server
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to start recording: ${response.status}`);
      }

      const data = await response.json();
      console.log('[RECORDING] Started:', data);
      setRecordingIds({ resourceId: data.resourceId, sid: data.sid });
      recordingIdsRef.current = { resourceId: data.resourceId, sid: data.sid };
    } catch (error) {
      console.error('[RECORDING] Failed to start:', error);
    }
  }
  
  // Stop Agora Cloud Recording
  async function stopCloudRecording(placeholderId = null) {
    // Read IDs from state
    const { resourceId, sid } = recordingIdsRef.current;
    
    // Guard against double execution
    if (!resourceId || !sid) {
      console.log('[APP] No recording to stop');
      return null;
    }
    
    // CRITICAL: Clear state BEFORE async call to prevent race condition
    setRecordingIds({ resourceId: null, sid: null });
    recordingIdsRef.current = { resourceId: null, sid: null };
    console.log('[APP] Recording IDs cleared, proceeding with stop...');
    
    try {
      console.log('[APP] Calling recording/stop with:', { 
        resourceId, 
        sid, 
        channelName: currentChannelRef.current, 
        uid: RECORDING_UID, 
        userId: currentUser?.id,
        title: title || 'Live Stream',
        thumbnail_url: thumbnailUrlRef.current
      });
      
      const response = await fetch(`${THUMBNAIL_SERVER_URL}/api/recording/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceId,
          sid,
          channelName: currentChannelRef.current,
          uid: RECORDING_UID,
          userId: currentUser?.id,
          title: title || 'Live Stream',
          description: '',
          thumbnail_url: thumbnailUrlRef.current,
          placeholderId: placeholderId
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('[APP] Failed to stop recording:', response.status, errorData);
        throw new Error(`Failed to stop recording: ${response.status}`);
      }
      
      const data = await response.json();
      console.log('[APP] Recording stopped. Video saved:', data);
      return data;
    } catch (error) {
      console.error('[APP] Failed to stop recording:', error.message, error.response?.status, error.response?.data);
      return null;
    }
  }

  const confirmEndStream = useCallback(async () => {
    console.log('[BTN] Confirm End Stream pressed');
    setShowEndModal(false);

    // Insert placeholder record and capture its ID
    const { data: placeholder } = await supabase.from('livestreams').insert({
      user_id: currentUser?.id,
      title: title || 'Live Stream',
      thumbnail_url: thumbnailUrlRef.current,
      video_url: 'processing',
      created_at: new Date().toISOString(),
    }).select().single();

    // Pass placeholder ID to server so it updates instead of inserting a new record
    stopCloudRecording(placeholder?.id);

    await supabase.from('live_streams').delete().eq('id', streamId);
    await cleanup();

    // Instantly go back
    navigation.pop(2);
  }, [navigation, streamId, currentUser, title]);

  const handleStartStreaming = () => {
    console.log('[BTN] Start Live pressed');
    setIsStarting(true);
    setup();
  };

  const handleToggleViewerList = () => {
    console.log('[BTN] Viewer List pressed');
    setShowViewerList(!showViewerList);
  };

  const handleCloseViewerList = () => {
    setShowViewerList(false);
  };

  const handleViewerListModeRecent = () => {
    setViewerListMode('recent');
  };

  const handleViewerListModeEngaged = () => {
    setViewerListMode('engaged');
  };

  const handleTabChat = () => {
    console.log('[BTN] Chat pressed');
    setActiveTab('chat');
  };

  const handleTabQuestions = () => {
    console.log('[BTN] Questions pressed');
    setActiveTab('questions');
  };

  const handleSelectQuestion = (question) => {
    console.log('[BTN] Select Question pressed:', question?.id);
    selectQuestion(question);
  };

  const handleCloseEndModal = () => {
    console.log('[BTN] Close End Modal pressed');
    setShowEndModal(false);
  };

  // Safety check for engine
  const hasEngine = engineRef.current !== null;
  
  console.log('[RENDER] Rendering. isLive:', isLive, 'status:', connectionStatus, 'engine:', hasEngine);
  
  if (!isLive && !isEnding) {
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

            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Save to Profile</Text>
                <Text style={styles.settingDescription}>
                  Save this stream to your profile after it ends
                </Text>
              </View>
              <Switch
                value={saveToProfile}
                onValueChange={setSaveToProfile}
                trackColor={{ false: '#767577', true: COLORS.gold }}
                thumbColor={saveToProfile ? '#fff' : '#f4f3f4'}
              />
            </View>

            <AnimatedButton style={styles.goLiveBtn} onPress={handleStartStreaming}>
              <Text style={styles.goLiveBtnText}>Start Streaming</Text>
            </AnimatedButton>
          </View>
        )}
      </View>
    );
  }
  
  // isLive is true but engine is null - show loading with cancel option
  if (isLive && !hasEngine) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#ef4444" size="large" />
        <Text style={styles.loadingText}>Initializing stream...</Text>
        <AnimatedButton 
          style={[styles.goLiveBtn, { marginTop: 20, backgroundColor: '#64748b' }]}
          onPress={() => {
            console.log('[RECOVER] Cancel pressed - resetting stuck state');
            setIsLive(false);
            setConnectionStatus('connected');
            cleanup();
          }}
        >
          <Text style={styles.goLiveBtnText}>Cancel</Text>
        </AnimatedButton>
      </View>
    );
  }

  console.log('[RENDER] Showing LIVE UI');
  __DEV__ && console.log('🎨 [render] Rendering live stream UI - isLive:', isLive);
  __DEV__ && console.log('🎨 [render] Engine exists:', !!engineRef.current);
  
  return (
    <View style={styles.container}>
      <SystemBars style="light" />
      <RtcSurfaceView
        style={StyleSheet.absoluteFill}
        canvas={{ uid: 0, sourceType: VideoSourceType.VideoSourceCamera }}
      />

      {/* Network Reconnection Overlay */}
      {connectionStatus !== 'connected' && (
        <View style={styles.reconnectOverlay}>
          {connectionStatus === 'reconnecting' ? (
            <>
              {console.log('[RENDER] Showing RECONNECTING UI. Attempt:', reconnectAttemptRef.current)}
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.reconnectText}>Reconnecting...</Text>
              <Text style={styles.reconnectSubtext}>Attempt {reconnectAttemptRef.current}/{MAX_RETRIES}</Text>
            </>
          ) : connectionStatus === 'offline' ? (
            <>
              {console.log('[RENDER] Showing OFFLINE UI')}
              {console.log('[DEBUG-OFFLINE] Rendering offline UI. Current status:', connectionStatus)}
              <Text style={styles.reconnectIcon}>📡</Text>
              <Text style={styles.reconnectText}>No internet connection</Text>
              <AnimatedButton 
                style={styles.reconnectBtn}
                onPress={() => {
                  console.log('[BTN] Retry pressed. Current status:', connectionStatus);
                  // Check internet again
                  NetInfo.fetch().then(state => {
                    if (state.isInternetReachable) {
                      reconnectAttemptRef.current = 0;
                      handleNetworkReconnect();
                    }
                  });
                }}
              >
                <Text style={styles.reconnectBtnText}>Retry</Text>
              </AnimatedButton>
            </>
          ) : (
            <>
              <Text style={styles.reconnectIcon}>⚠️</Text>
              <Text style={styles.reconnectText}>Connection lost</Text>
              <AnimatedButton 
                style={styles.reconnectBtn}
                onPress={() => {
                  reconnectAttemptRef.current = 0;
                  handleNetworkReconnect();
                }}
              >
                <Text style={styles.reconnectBtnText}>Tap to retry</Text>
              </AnimatedButton>
            </>
          )}
        </View>
      )}

      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.liveBadge}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
        <AnimatedButton
          style={styles.viewerBadge}
          onPress={handleToggleViewerList}
        >
          <Text style={styles.viewerText}>👁️ {viewerCount}</Text>
        </AnimatedButton>
        <AnimatedButton style={styles.endBtn} onPress={() => {
          console.log('[BTN] End pressed. isLive:', isLive);
          endStream();
        }}>
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
              <AnimatedButton onPress={() => {
                console.log('[BTN] Close Viewer List pressed');
                handleCloseViewerList();
              }}>
                <Text style={styles.closeListText}>✕</Text>
              </AnimatedButton>
            </View>

            {/* Tabs - only show if feature flag is enabled */}
            {showEngagedTab && (
              <View style={styles.viewerListTabs}>
                <AnimatedButton
                  style={[styles.viewerListTab, viewerListMode === 'recent' && styles.viewerListTabActive]}
                  onPress={handleViewerListModeRecent}
                >
                  <Text style={[styles.viewerListTabText, viewerListMode === 'recent' && styles.viewerListTabTextActive]}>
                    Recent
                  </Text>
                </AnimatedButton>
                <AnimatedButton
                  style={[styles.viewerListTab, viewerListMode === 'engaged' && styles.viewerListTabActive]}
                  onPress={handleViewerListModeEngaged}
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
          <AnimatedButton style={[styles.tab, activeTab === 'chat' && styles.tabActive]} onPress={handleTabChat}>
            <Text style={[styles.tabText, activeTab === 'chat' && styles.tabTextActive]}>💬 Chat</Text>
          </AnimatedButton>
          <AnimatedButton style={[styles.tab, activeTab === 'questions' && styles.tabActive]} onPress={handleTabQuestions}>
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
              <AnimatedButton style={[styles.questionItem, item.is_selected && styles.questionItemSelected]} onPress={() => handleSelectQuestion(item)}>
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
                onPress={handleCloseEndModal}
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
      
      {/* Loading overlay when ending stream */}
      {isEnding && (
        <View style={styles.endingOverlay}>
          <ActivityIndicator color="#fff" size="large" />
          <Text style={styles.endingText}>{endingMessage}</Text>
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
  // Network reconnection overlay styles
  reconnectOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  reconnectText: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: 16 },
  reconnectSubtext: { color: 'rgba(255,255,255,0.6)', fontSize: 14, marginTop: 8 },
  reconnectIcon: { fontSize: 48 },
  reconnectBtn: { backgroundColor: COLORS.gold, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 20 },
  reconnectBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  endingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  endingText: {
    color: '#fff',
    marginTop: 12,
    fontSize: 16,
    fontWeight: '600',
  },
});