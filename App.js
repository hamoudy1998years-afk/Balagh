import { View, ActivityIndicator, TouchableOpacity, StyleSheet, Image, Pressable, Text, Linking, Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { supabase } from './lib/supabase';
import EditProfileScreen from './screens/EditProfileScreen';
import ApplyScholarScreen from './screens/ApplyScholarScreen';
import HomeScreen from './screens/HomeScreen';
import SearchScreen from './screens/SearchScreen';
import UploadScreen from './screens/UploadScreen';
import NotificationsScreen from './screens/NotificationsScreen';
import ProfileScreen from './screens/ProfileScreen';
import LoginScreen from './screens/LoginScreen';
import SignupScreen from './screens/SignupScreen';
import ProfileVideosScreen from './screens/ProfileVideosScreen';
import LiveStreamScreen from './screens/LiveStreamScreen';
import WatchLiveScreen from './screens/WatchLiveScreen';
import { homeRefreshRef } from './utils/refs';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useBiometricAuth } from './hooks/useBiometricAuth';
import FollowListScreen from './screens/FollowListScreen';
import SettingsScreen from './screens/SettingsScreen';
import AvatarCropScreen from './screens/AvatarCropScreen';
import VideoDetailScreen from './screens/VideoDetailScreen';
import { useEffect, useState, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import CommentsModal from './screens/CommentsModal';
import * as WebBrowser from 'expo-web-browser';
import * as Notifications from 'expo-notifications';
import { COLORS } from './constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { usePushNotifications } from './hooks/usePushNotifications';
import ResetPasswordScreen from './screens/ResetPasswordScreen';
import AdminScreen from './screens/AdminScreen';
import AgeGateScreen from './screens/AgeGateScreen';
import ErrorBoundary from './components/ErrorBoundary';
import * as Sentry from '@sentry/react-native';
import { loadBannedWords } from './utils/moderation';

// ADD THIS IMPORT
import { UserProvider } from './context/UserContext';

// Global Sheet Imports
import { DownloadProvider } from './context/DownloadContext';
import GlobalVideoOptionsSheet from './components/GlobalVideoOptionsSheet';

WebBrowser.maybeCompleteAuthSession();

// Sentry initialization
Sentry.init({
  dsn: 'https://e204442193cbb2af057e44b9613b630a@o4511072669335552.ingest.us.sentry.io/4511072675954688',
  enableInExpoDevelopment: true,
  debug: false,
  tracesSampleRate: 1.0,
  attachScreenshot: true,
});

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function ProfileTabIcon({ color, size, focused }) {
  const [avatarUrl, setAvatarUrl] = React.useState(null);
  const [imageError, setImageError] = React.useState(false);

  async function fetchAvatar() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('profiles')
      .select('avatar_url')
      .eq('id', user.id)
      .single();
    if (data?.avatar_url) setAvatarUrl(data.avatar_url);
  }

  React.useEffect(() => {
    fetchAvatar();
    const { DeviceEventEmitter } = require('react-native');
    const subscription = DeviceEventEmitter.addListener('avatarUpdated', fetchAvatar);
    return () => subscription.remove();
  }, []);

  if (avatarUrl && !imageError) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: focused ? 2 : 0,
          borderColor: COLORS.gold,
        }}
        onError={() => setImageError(true)}
      />
    );
  }

  return <Text style={{ fontSize: size, color: color }}>👤</Text>;
}

function MainTabs({ session }) {
  const [homeKey, setHomeKey] = useState(0);
  const navigation = useNavigation();

  const handleHomePress = () => {
    const state = navigation.getState();
    const mainRoute = state?.routes?.find(r => r.name === 'Main');
    const activeTab = mainRoute?.state?.routes?.[mainRoute?.state?.index]?.name;
    
    // If activeTab is undefined (navigator not ready) OR we're on Home, do refresh
    if (!activeTab || activeTab === 'Home') {
      if (homeRefreshRef.current) {
        homeRefreshRef.current();
      }
    } else {
      navigation.navigate('Main', { screen: 'Home' });
    }
  };

 return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: 'rgba(17,24,39,0.95)',
          borderTopColor: 'rgba(255,255,255,0.06)',
          borderTopWidth: 1,
          marginHorizontal: 12,
          marginBottom: 12,
          borderRadius: 22,
          height: 60,
          paddingBottom: 8,
          position: 'absolute',
          elevation: 0,
        },
        tabBarActiveTintColor: COLORS.bottomNavActive,
        tabBarInactiveTintColor: COLORS.bottomNavInactive,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'home' : 'home-outline'} size={size} color={color} />
          ),
        }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            handleHomePress();
          },
        }}
        initialParams={{ refreshKey: homeKey }}
      />
      <Tab.Screen
        name="Upload/Live"
        component={UploadScreen}
        options={{
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'add-circle' : 'add-circle-outline'} size={size} color={color} />
          ),
          tabBarButton: (props) => (
            <TouchableOpacity
              {...props}
              onPress={() => {
                if (!session) {
                  navigation.navigate('Login');
                } else {
                  props.onPress?.();
                }
              }}
            />
          ),
        }}
      />
      <Tab.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'notifications' : 'notifications-outline'} size={size} color={color} />
          ),
          tabBarButton: (props) => (
            <TouchableOpacity
              {...props}
              onPress={() => {
                if (!session) {
                  navigation.navigate('Login');
                } else {
                  props.onPress?.();
                }
              }}
            />
          ),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarIcon: ({ color, size, focused }) => <ProfileTabIcon color={color} size={size} focused={focused} />,
          tabBarButton: (props) => (
            <TouchableOpacity
              {...props}
              onPress={() => {
                if (!session) {
                  navigation.navigate('Login');
                } else {
                  props.onPress?.();
                }
              }}
            />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

// ADD THIS - tells React Navigation how to handle deep links
const linking = {
  prefixes: ['bushrann://', 'https://bushrann.app'],
  config: {
    screens: {
      ResetPassword: 'auth/callback',
      VideoDetail: 'video/:id',
      UserProfile: 'user/:id',
      WatchLive: 'live/:streamId',
      LiveStream: 'go-live',
    },
  },
};

function App() {
  const [session, setSession] = useState(undefined);
  const [ageVerified, setAgeVerified] = useState(null); // null = loading, false = show gate, true = show app
  const { runMigrationIfNeeded, updateStoredGoogleToken } = useBiometricAuth();
  usePushNotifications();
  const navigationRef = useRef(null);

  useEffect(() => {
    async function checkAge() {
      try {
        const verified = await AsyncStorage.getItem('ageVerified');
        setAgeVerified(verified === 'true');
      } catch (e) {
        setAgeVerified(false);
      }
    }
    checkAge();
  }, []);

  useEffect(() => {
    // Handle push notification taps
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data;
      
      if (data?.type === 'video' && data?.videoId) {
        navigationRef.current?.navigate('VideoDetail', { id: data.videoId });
      } else if (data?.type === 'live' && data?.streamId) {
        navigationRef.current?.navigate('WatchLive', { stream: { id: data.streamId } });
      } else if (data?.type === 'follow' && data?.userId) {
        navigationRef.current?.navigate('UserProfile', { profileUserId: data.userId });
      } else if (data?.type === 'message') {
        navigationRef.current?.navigate('Notifications');
      }
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    loadBannedWords();
  }, []);

  // Deep link logging
  useEffect(() => {
    const linkingSub = Linking.addEventListener('url', ({ url }) => {
      console.log('[DEEP LINK] URL received:', url);
    });
    
    // Also log initial URL
    Linking.getInitialURL().then(url => {
      if (url) console.log('[DEEP LINK] Initial URL:', url);
    });
    
    return () => linkingSub.remove();
  }, []);

  useEffect(() => {
    runMigrationIfNeeded();

    // Handle app opened from killed state
    Linking.getInitialURL().then((url) => {
      if (url) handleDeepLink(url);
    });

    // Handle app opened from background
    const linkingSub = Linking.addEventListener('url', ({ url }) => {
      if (url) handleDeepLink(url);
    });

    // onAuthStateChange fires INITIAL_SESSION on mount — no need for a separate
    // getSession() call. Using both causes a race where getSession() can
    // overwrite a fresher session set by onAuthStateChange.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(prev => {
        // INITIAL_SESSION fires synchronously; only update if value changed
        if (prev === undefined || prev?.access_token !== session?.access_token) {
          return session;
        }
        return prev;
      });

      if (_event === 'PASSWORD_RECOVERY') {
        navigationRef.current?.navigate('ResetPassword');
      }

      if (_event === 'TOKEN_REFRESHED' && session?.user?.email && session?.refresh_token) {
        updateStoredGoogleToken(session.user.email, session.refresh_token);
      }

      // Recreate missing profile rows (e.g. after admin deletion)
      if ((_event === 'SIGNED_IN' || _event === 'INITIAL_SESSION') && session?.user) {
        ensureProfileExists(session.user);
      }
    });

    return () => {
      subscription.unsubscribe();
      linkingSub.remove();
    };
  }, []);

  async function ensureProfileExists(user) {
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', user.id)
        .maybeSingle();

      if (!profile) {
        const rawUsername = user.email?.split('@')[0] ?? `user_${user.id.slice(0, 8)}`;
        const username = rawUsername.replace(/[^a-zA-Z0-9._]/g, '').slice(0, 30) || `user_${user.id.slice(0, 8)}`;
        await supabase.from('profiles').insert({
          id: user.id,
          username,
          full_name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
          avatar_url: user.user_metadata?.avatar_url ?? null,
        });
        __DEV__ && console.log('[App] Profile auto-created for:', user.email);
      }
    } catch (e) {
      __DEV__ && console.warn('[App] ensureProfileExists error:', e.message);
    }
  }

  // ADD THIS HELPER FUNCTION
  async function handleDeepLink(url) {
    console.log('[DEEP LINK] handleDeepLink called with:', url);
    if (!url || !url.startsWith('bushrann://')) return;
    
    // Check if it's a recovery link
    if (url.includes('type=recovery')) {
      __DEV__ && console.log('✅ Recovery link detected!');
      
      // Extract tokens from URL hash or query
      const hashIndex = url.indexOf('#');
      const queryIndex = url.indexOf('?');
      const paramStart = hashIndex !== -1 ? hashIndex + 1 : (queryIndex !== -1 ? queryIndex + 1 : null);
      
      if (paramStart) {
        const params = new URLSearchParams(url.substring(paramStart));
        const access_token = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        
        __DEV__ && console.log('Access token found:', !!access_token);
        
        if (access_token) {
          // Set session manually
          const { data, error } = await supabase.auth.setSession({
            access_token,
            refresh_token: refresh_token || '',
          });
          
          if (error) {
            __DEV__ && console.log('❌ Session error:', error.message);
          } else {
            __DEV__ && console.log('✅ Session set!');
            // Navigate to ResetPassword
            setTimeout(() => {
              navigationRef.current?.navigate('ResetPassword');
            }, 500);
          }
        }
      }
    }
  }

  if (ageVerified === null) {
    return (
      <View style={{flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center'}}>
        <ActivityIndicator size="large" color="#FFD700" />
      </View>
    );
  }

  if (!ageVerified) {
    return <AgeGateScreen onVerified={() => setAgeVerified(true)} />;
  }

  if (session === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0f0f0f', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={COLORS.gold} size="large" />
      </View>
    );
  }

  return (
    <ErrorBoundary>
    <UserProvider>
      <DownloadProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <SafeAreaProvider>
            <BottomSheetModalProvider>
              <NavigationContainer ref={navigationRef} linking={linking}>
                <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
                  <Stack.Screen name="Main">
                    {() => <MainTabs session={session} />}
                  </Stack.Screen>
                  <Stack.Screen name="Login" component={LoginScreen} />
                  <Stack.Screen name="Signup" component={SignupScreen} />
                  <Stack.Screen name="CommentsModal" component={CommentsModal} options={{ presentation: 'modal' }} />
                  <Stack.Screen name="EditProfile" component={EditProfileScreen} />
                  <Stack.Screen name="ApplyScholar" component={ApplyScholarScreen} />
                  <Stack.Screen name="Search" component={SearchScreen} />
                  <Stack.Screen name="ProfileVideos" component={ProfileVideosScreen} />
                  <Stack.Screen name="LiveStream" component={LiveStreamScreen} />
                  <Stack.Screen name="WatchLive" component={WatchLiveScreen} />
                  <Stack.Screen name="FollowList" component={FollowListScreen} />
                  <Stack.Screen name="Settings" component={SettingsScreen} />
                  <Stack.Screen name="UserProfile" component={ProfileScreen} />
                  <Stack.Screen name="AvatarCrop" component={AvatarCropScreen} />
                  <Stack.Screen name="VideoDetail" component={VideoDetailScreen} />
                  <Stack.Screen name="ResetPassword" component={ResetPasswordScreen} />
                  <Stack.Screen name="Admin" component={AdminScreen} />
                </Stack.Navigator>
                <GlobalVideoOptionsSheet />
              </NavigationContainer>
            </BottomSheetModalProvider>
          </SafeAreaProvider>
        </GestureHandlerRootView>
      </DownloadProvider>
    </UserProvider>
    </ErrorBoundary>
  );
}

// Wrap App with Sentry
export default Sentry.wrap(App);

const styles = StyleSheet.create({
});