import { View, ActivityIndicator, TouchableOpacity, StyleSheet, Image, Text, Linking, Platform } from 'react-native';
import { SystemBars } from 'react-native-edge-to-edge';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
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
import LiveStreamScreen from './screens/LiveStreamScreenLiveKit';
import WatchLiveScreen from './screens/WatchLiveScreen';
import { homeRefreshRef } from './utils/refs';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useBiometricAuth } from './hooks/useBiometricAuth';
import FollowListScreen from './screens/FollowListScreen';
import SettingsScreen from './screens/SettingsScreen';
import VideoDetailScreen from './screens/VideoDetailScreen';
import { useEffect, useState, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import CommentsModal from './screens/CommentsModal';
import * as WebBrowser from 'expo-web-browser';
import * as Notifications from 'expo-notifications';
import { COLORS } from './constants/theme';
import { ROUTES } from './constants/routes';
import { Ionicons } from '@expo/vector-icons';
import { usePushNotifications } from './hooks/usePushNotifications';
import { Settings } from 'react-native-fbsdk-next';
import QuranScreen from './screens/QuranScreen';
import PrayerScreen from './screens/PrayerScreen';
import QuranReaderScreen from './screens/QuranReaderScreen';
import RecitationCheckerScreen from './screens/RecitationCheckerScreen';
import AgeGateScreen from './screens/AgeGateScreen';
import OnboardingScreen from './screens/OnboardingScreen';
import MyUploadsScreen from './screens/MyUploadsScreen';
import ContactAdminScreen from './screens/ContactAdminScreen';
import ErrorBoundary from './components/ErrorBoundary';
import * as Sentry from '@sentry/react-native';
import { loadBannedWords } from './utils/moderation';
import { UserProvider } from './context/UserContext';
import { DownloadProvider } from './context/DownloadContext';
import GlobalVideoOptionsSheet from './components/GlobalVideoOptionsSheet';
import * as SplashScreen from 'expo-splash-screen';
import ResetPasswordScreen from './screens/ResetPasswordScreen';
import AdminScreen from './screens/AdminScreen';

// Prevent splash screen from hiding automatically
SplashScreen.preventAutoHideAsync();

const CURRENT_DATA_VERSION = '1.7.28';

async function migrateOldDataIfNeeded() {
  try {
    const storedVersion = await AsyncStorage.getItem('appDataVersion');

    if (!storedVersion || storedVersion !== CURRENT_DATA_VERSION) {
      await AsyncStorage.setItem('appDataVersion', CURRENT_DATA_VERSION);
    }
  } catch (e) {
    // Silent fail
  }
}

WebBrowser.maybeCompleteAuthSession();

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN || '',
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
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return;

    const { data } = await supabase
      .from('profiles')
      .select('avatar_url')
      .eq('id', user.id)
      .single();

    if (data?.avatar_url) {
      setAvatarUrl(data.avatar_url);
    }
  }

  React.useEffect(() => {
    fetchAvatar();

    const { DeviceEventEmitter } = require('react-native');

    const subscription = DeviceEventEmitter.addListener(
      'avatarUpdated',
      fetchAvatar
    );

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

  return <Text style={{ fontSize: size, color }}>👤</Text>;
}

function MainTabs({ session }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const handleHomePress = () => {
    const state = navigation.getState();

    const mainRoute = state?.routes?.find(
      route => route.name === 'Main'
    );

    const activeTab =
      mainRoute?.state?.routes?.[mainRoute?.state?.index]?.name;

    if (activeTab === 'Home') {
      if (homeRefreshRef.current) {
        homeRefreshRef.current();
      }
    } else {
      navigation.navigate(ROUTES.MAIN, {
        screen: 'Home',
      });
    }
  };

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,

        tabBarStyle: {
          backgroundColor: '#1a2e44',
          borderTopColor: 'rgba(255,255,255,0.06)',
          borderTopWidth: 1,

          marginHorizontal: 0,

          marginBottom: Platform.select({
            ios: insets.bottom > 0 ? insets.bottom : -1,
            android: insets.bottom > 0 ? 0 : -1,
          }),

          borderRadius: 20,

          height: Platform.select({
            ios: 55 + (insets.bottom > 0 ? 8 : 0),
            android: 55 + insets.bottom,
          }),

          paddingBottom: Platform.select({
            ios: insets.bottom > 0 ? insets.bottom : 8,
            android: insets.bottom > 0 ? insets.bottom : 8,
          }),

          paddingTop: 0,
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
            <Ionicons
              name={focused ? 'home' : 'home-outline'}
              size={size}
              color={color}
            />
          ),
        }}
        listeners={{
          tabPress: e => {
            e.preventDefault();
            handleHomePress();
          },
        }}
      />

      <Tab.Screen
        name="Upload"
        component={UploadScreen}
        options={{
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'add-circle' : 'add-circle-outline'}
              size={size}
              color={color}
            />
          ),

          tabBarButton: props => (
            <TouchableOpacity
              {...props}
              onPress={() => {
                if (!session) {
                  navigation.navigate(ROUTES.LOGIN);
                } else {
                  props.onPress?.();
                }
              }}
            />
          ),
        }}
      />

      <Tab.Screen
        name="Quran"
        component={QuranScreen}
        options={{
          tabBarIcon: ({ focused }) => (
            <View
              style={{
                backgroundColor: focused
                  ? '#c9a84c'
                  : 'rgba(201,168,76,0.2)',
                borderRadius: 26,
                padding: 3,
              }}
            >
              <Image
                source={require('./assets/quran.png')}
                style={{
                  width: 28,
                  height: 28,
                }}
              />
            </View>
          ),
        }}
      />

      <Tab.Screen
        name="Prayer"
        component={PrayerScreen}
        options={{
          tabBarIcon: ({ focused }) => (
            <Text
              style={{
                fontSize: focused ? 26 : 22,
              }}
            >
              🕌
            </Text>
          ),

          lazy: true,
          unmountOnBlur: true,
        }}
      />

      <Tab.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{
          tabBarLabel: 'Alerts',

          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={
                focused
                  ? 'notifications'
                  : 'notifications-outline'
              }
              size={size}
              color={color}
            />
          ),

          tabBarButton: props => (
            <TouchableOpacity
              {...props}
              onPress={() => {
                if (!session) {
                  navigation.navigate(ROUTES.LOGIN);
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
          tabBarIcon: ({ color, size, focused }) => (
            <ProfileTabIcon
              color={color}
              size={size}
              focused={focused}
            />
          ),

          tabBarButton: props => (
            <TouchableOpacity
              {...props}
              onPress={() => {
                if (!session) {
                  navigation.navigate(ROUTES.LOGIN);
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

function WatchLiveRoute({ navigation, route }) {
  const routeStream = route.params?.stream ?? null;

  const streamId =
    route.params?.streamId ??
    routeStream?.id ??
    null;

  const hasCompleteStream =
    !!routeStream?.id &&
    !!routeStream?.channel_name &&
    !!routeStream?.user_id;

  const [resolvedStream, setResolvedStream] = useState(
    hasCompleteStream
      ? routeStream
      : null
  );

  const [loading, setLoading] = useState(
    !hasCompleteStream
  );

  const [failed, setFailed] = useState(false);

  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (hasCompleteStream) {
      setResolvedStream(routeStream);
      setLoading(false);
      setFailed(false);
      return;
    }

    if (!streamId) {
      setResolvedStream(null);
      setLoading(false);
      setFailed(true);
      return;
    }

    let active = true;

    async function loadStream() {
      setLoading(true);
      setFailed(false);

      try {
        const { data, error } = await supabase
          .from('live_streams')
          .select('*')
          .eq('id', streamId)
          .eq('is_live', true)
          .maybeSingle();

        if (!active) return;

        if (
          error ||
          !data ||
          !data.channel_name ||
          !data.user_id
        ) {
          setResolvedStream(null);
          setFailed(true);
          return;
        }

        setResolvedStream(data);
      } catch (e) {
        if (!active) return;

        __DEV__ &&
          console.warn(
            '[WatchLiveRoute] Failed to resolve stream:',
            e
          );

        setResolvedStream(null);
        setFailed(true);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadStream();

    return () => {
      active = false;
    };
  }, [
    streamId,
    hasCompleteStream,
    routeStream,
    retryKey,
  ]);

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#000',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SystemBars style="light" />

        <ActivityIndicator
          color={COLORS.gold}
          size="large"
        />

        <Text
          style={{
            color: '#fff',
            marginTop: 14,
            fontSize: 15,
            fontWeight: '600',
          }}
        >
          Joining livestream...
        </Text>
      </View>
    );
  }

  if (failed || !resolvedStream) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#000',
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 32,
        }}
      >
        <SystemBars style="light" />

        <Text
          style={{
            fontSize: 48,
          }}
        >
          🎙️
        </Text>

        <Text
          style={{
            color: '#fff',
            fontSize: 20,
            fontWeight: '700',
            marginTop: 16,
            textAlign: 'center',
          }}
        >
          Livestream unavailable
        </Text>

        <Text
          style={{
            color: '#94a3b8',
            fontSize: 14,
            marginTop: 8,
            textAlign: 'center',
            lineHeight: 20,
          }}
        >
          This livestream may have ended or could not be loaded.
        </Text>

        {streamId && (
          <TouchableOpacity
            onPress={() =>
              setRetryKey(prev => prev + 1)
            }
            style={{
              marginTop: 24,
              backgroundColor: COLORS.gold,
              paddingHorizontal: 28,
              paddingVertical: 13,
              borderRadius: 12,
            }}
          >
            <Text
              style={{
                color: '#fff',
                fontWeight: '700',
                fontSize: 15,
              }}
            >
              Try Again
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          onPress={() =>
            navigation.navigate(
              ROUTES.MAIN,
              {
                screen: 'Home',
              }
            )
          }
          style={{
            marginTop: 12,
            paddingHorizontal: 28,
            paddingVertical: 13,
          }}
        >
          <Text
            style={{
              color: '#fff',
              fontWeight: '600',
              fontSize: 15,
            }}
          >
            Go Home
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <WatchLiveScreen
      navigation={navigation}
      route={{
        ...route,

        params: {
          ...route.params,
          stream: resolvedStream,
        },
      }}
    />
  );
}

const linking = {
  prefixes: [
    'bushrann://',
    'https://bushrann.app',
    'https://balagh-server-production.up.railway.app',
  ],

  config: {
    screens: {
      ResetPassword: 'auth/callback',
      VideoDetail: 'video/:id',
      UserProfile: 'user/:id',
      WatchLive: 'live/:streamId',
    },
  },
};

function App() {
  const [session, setSession] = useState(undefined);

  const [ageVerified, setAgeVerified] =
    useState(null);

  const [
    onboardingCompleted,
    setOnboardingCompleted,
  ] = useState(null);

  const [
    jsSplashVisible,
    setJsSplashVisible,
  ] = useState(true);

  const {
    runMigrationIfNeeded,
    updateStoredGoogleToken,
  } = useBiometricAuth();

  usePushNotifications();

  const navigationRef = useRef(null);

  const pendingResetRef = useRef(false);

  const pendingSignOutRef = useRef(false);

  const pendingNotificationRef = useRef(null);

  useEffect(() => {
    migrateOldDataIfNeeded();
  }, []);

  useEffect(() => {
    const setupFacebook = async () => {
      try {
        Settings.setAdvertiserIDCollectionEnabled(
          false
        );

        Settings.setAutoLogAppEventsEnabled(true);

        await Settings.initializeSDK();
      } catch (error) {
        console.error(
          '[FB SDK] Init failed:',
          error
        );
      }
    };

    setupFacebook();
  }, []);

  useEffect(() => {
    setJsSplashVisible(false);
  }, []);

  useEffect(() => {
    if (
      !jsSplashVisible &&
      ageVerified !== null &&
      onboardingCompleted !== null
    ) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          SplashScreen.hideAsync();
        });
      });
    }
  }, [
    jsSplashVisible,
    ageVerified,
    onboardingCompleted,
  ]);

  useEffect(() => {
    async function checkAge() {
      try {
        const verified =
          await AsyncStorage.getItem(
            'ageVerified'
          );

        setAgeVerified(
          verified === 'true'
        );
      } catch (e) {
        setAgeVerified(false);
      }
    }

    checkAge();
  }, []);

  useEffect(() => {
    async function checkOnboarding() {
      try {
        const completed =
          await AsyncStorage.getItem(
            'onboardingCompleted'
          );

        setOnboardingCompleted(
          completed === 'true'
        );
      } catch (e) {
        setOnboardingCompleted(false);
      }
    }

    if (ageVerified !== null) {
      checkOnboarding();
    }
  }, [ageVerified]);

  useEffect(() => {
    const subscription =
      Notifications.addNotificationResponseReceivedListener(
        response => {
          const data =
            response.notification.request.content.data;

          let action = null;

          if (
            data?.type === 'video' &&
            data?.videoId
          ) {
            action = [
              'VideoDetail',
              {
                id: data.videoId,
              },
            ];
          } else if (
            data?.type === 'live' &&
            data?.streamId
          ) {
            action = [
              'WatchLive',
              {
                streamId: data.streamId,
              },
            ];
          } else if (
            data?.type === 'follow' &&
            data?.userId
          ) {
            action = [
              'UserProfile',
              {
                profileUserId:
                  data.userId,
              },
            ];
          } else if (
            data?.type === 'message'
          ) {
            action = ['Notifications'];
          }

          if (!action) return;

          if (
            navigationRef.current?.isReady()
          ) {
            navigationRef.current.navigate(
              ...action
            );
          } else {
            pendingNotificationRef.current =
              action;
          }
        }
      );

    return () =>
      subscription.remove();
  }, []);

  useEffect(() => {
    loadBannedWords();
  }, []);

  useEffect(() => {
    if (Platform.OS === 'android') {
      AsyncStorage.getItem(
        'prayerNotifications'
      ).then(saved => {
        if (saved) {
          const {
            NativeModules,
          } = require('react-native');

          const {
            AdhanModule,
          } = NativeModules;

          if (
            AdhanModule?.showPersistent
          ) {
            AdhanModule.showPersistent();
          }
        }
      });
    }
  }, []);

  useEffect(() => {
    runMigrationIfNeeded();

    // React Navigation's `linking` prop handles normal app links such as:
    // /video/:id
    // /user/:id
    // /live/:streamId
    //
    // This manual handler is kept only for Supabase password-recovery links,
    // because those require setting the recovered auth session before navigation.
    Linking.getInitialURL().then(url => {
      if (url?.includes('type=recovery')) {
        handleDeepLink(url);
      }
    });

    const linkingSub = Linking.addEventListener(
      'url',
      ({ url }) => {
        if (url?.includes('type=recovery')) {
          handleDeepLink(url);
        }
      }
    );

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(prev => {
          if (
            prev === undefined ||
            prev?.access_token !==
              session?.access_token
          ) {
            return session;
          }

          return prev;
        });

        if (
          _event ===
          'PASSWORD_RECOVERY'
        ) {
          if (
            navigationRef.current?.isReady()
          ) {
            navigationRef.current.navigate(
              'ResetPassword'
            );
          } else {
            pendingResetRef.current = true;
          }
        }

        if (_event === 'SIGNED_OUT') {
          const {
            DeviceEventEmitter,
          } = require('react-native');

          DeviceEventEmitter.emit(
            'pauseAllVideos'
          );

          if (
            navigationRef.current?.isReady()
          ) {
            navigationRef.current.reset({
              index: 0,

              routes: [
                {
                  name: ROUTES.LOGIN,
                },
              ],
            });
          } else {
            pendingSignOutRef.current = true;
          }
        }

        if (
          _event ===
            'TOKEN_REFRESHED' &&
          session?.user?.email &&
          session?.refresh_token
        ) {
          updateStoredGoogleToken(
            session.user.email,
            session.refresh_token
          );
        }

        if (
          (_event === 'SIGNED_IN' ||
            _event ===
              'INITIAL_SESSION') &&
          session?.user
        ) {
          ensureProfileExists(
            session.user
          );
        }
      }
    );

    return () => {
      subscription.unsubscribe();
      linkingSub.remove();
    };
  }, []);

  async function ensureProfileExists(
    user
  ) {
    try {
      const { data: profile } =
        await supabase
          .from('profiles')
          .select('id')
          .eq('id', user.id)
          .maybeSingle();

      if (!profile) {
        const rawUsername =
          user.email?.split('@')[0] ??
          `user_${user.id.slice(
            0,
            8
          )}`;

        const username =
          rawUsername
            .replace(
              /[^a-zA-Z0-9._]/g,
              ''
            )
            .slice(0, 30) ||
          `user_${user.id.slice(
            0,
            8
          )}`;

        await supabase
          .from('profiles')
          .insert({
            id: user.id,

            username,

            full_name:
              user.user_metadata
                ?.full_name ??
              user.user_metadata
                ?.name ??
              null,

            avatar_url:
              user.user_metadata
                ?.avatar_url ??
              null,
          });
      }
    } catch (e) {
      __DEV__ &&
        console.warn(
          '[App] ensureProfileExists error:',
          e.message
        );
    }
  }

  async function handleDeepLink(url) {
    const isBushrannScheme =
      url?.startsWith(
        'bushrann://'
      );

    const isBushrannHttps =
      url?.startsWith(
        'https://bushrann.app/'
      );

    const isBushrannRailwayHttps =
      url?.startsWith(
        'https://balagh-server-production.up.railway.app/'
      );

    if (
      !url ||
      (!isBushrannScheme &&
        !isBushrannHttps &&
        !isBushrannRailwayHttps)
    ) {
      return;
    }
    if (
      url.includes(
        'expo-development-client'
      )
    ) {
      return;
    }

    const validRoutes = [
      'auth/callback',
      'video',
      'user',
      'live',
    ];

    const path =
      isBushrannScheme
        ? url
            .replace(
              'bushrann://',
              ''
            )
            .split('?')[0]
        : isBushrannRailwayHttps
          ? url
              .replace(
                'https://balagh-server-production.up.railway.app/',
                ''
              )
              .split('?')[0]
          : url
              .replace(
                'https://bushrann.app/',
                ''
              )
              .split('?')[0];

    if (
      !validRoutes.some(route =>
        path.startsWith(route)
      )
    ) {
      return;
    }

    if (
      url.includes(
        'type=recovery'
      )
    ) {
      const hashIndex =
        url.indexOf('#');

      const queryIndex =
        url.indexOf('?');

      const paramStart =
        hashIndex !== -1
          ? hashIndex + 1
          : queryIndex !== -1
            ? queryIndex + 1
            : null;

      if (paramStart) {
        const params =
          new URLSearchParams(
            url.substring(paramStart)
          );

        const access_token =
          params.get(
            'access_token'
          );

        const refresh_token =
          params.get(
            'refresh_token'
          );

        if (access_token) {
          const {
            error,
          } =
            await supabase.auth.setSession(
              {
                access_token,

                refresh_token:
                  refresh_token ||
                  '',
              }
            );

          if (!error) {
            setTimeout(() => {
              navigationRef.current?.navigate(
                'ResetPassword'
              );
            }, 500);
          }
        }
      }
    }
  }

  if (
    jsSplashVisible ||
    ageVerified === null ||
    onboardingCompleted === null
  ) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor:
            '#1a2e44',
        }}
      >
        <SystemBars style="light" />

        <Image
          source={require(
            './assets/splash-icon.png'
          )}
          style={{
            flex: 1,
            width: '100%',
            height: '100%',
          }}
          resizeMode="cover"
          fadeDuration={0}
        />
      </View>
    );
  }

  if (
    onboardingCompleted === false
  ) {
    return (
      <SafeAreaProvider>
        <SystemBars style="light" />

        <OnboardingScreen
          onComplete={() =>
            setOnboardingCompleted(
              true
            )
          }
        />
      </SafeAreaProvider>
    );
  }

  if (!ageVerified) {
    return (
      <SafeAreaProvider>
        <SystemBars style="light" />

        <AgeGateScreen
          onVerified={() =>
            setAgeVerified(true)
          }
        />
      </SafeAreaProvider>
    );
  }

  if (session === undefined) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor:
            '#000000',
          alignItems: 'center',
          justifyContent:
            'center',
        }}
      >
        <SystemBars style="light" />

        <ActivityIndicator
          color={COLORS.gold}
          size="large"
        />
      </View>
    );
  }

  return (
    <>
      <SystemBars style="light" />

      <SafeAreaProvider>
        <ErrorBoundary>
          <UserProvider>
            <DownloadProvider>
              <GestureHandlerRootView
                style={{
                  flex: 1,
                }}
              >
                <BottomSheetModalProvider>
                  <NavigationContainer
                    ref={navigationRef}
                    linking={linking}
                    onReady={() => {
                      if (
                        pendingResetRef.current
                      ) {
                        pendingResetRef.current =
                          false;

                        navigationRef.current?.navigate(
                          'ResetPassword'
                        );
                      } else if (
                        pendingSignOutRef.current
                      ) {
                        pendingSignOutRef.current =
                          false;

                        navigationRef.current?.reset(
                          {
                            index: 0,

                            routes: [
                              {
                                name: ROUTES.LOGIN,
                              },
                            ],
                          }
                        );
                      } else if (
                        pendingNotificationRef.current
                      ) {
                        const action =
                          pendingNotificationRef.current;

                        pendingNotificationRef.current =
                          null;

                        navigationRef.current?.navigate(
                          ...action
                        );
                      }
                    }}
                  >
                    <Stack.Navigator
                      screenOptions={{
                        headerShown:
                          false,
                        animation:
                          'none',
                      }}
                    >
                      <Stack.Screen
                        name="Main"
                      >
                        {() => (
                          <MainTabs
                            session={
                              session
                            }
                          />
                        )}
                      </Stack.Screen>

                      <Stack.Screen
                        name="Login"
                        component={
                          LoginScreen
                        }
                      />

                      <Stack.Screen
                        name="Signup"
                        component={
                          SignupScreen
                        }
                      />

                      <Stack.Screen
                        name="CommentsModal"
                        component={
                          CommentsModal
                        }
                        options={{
                          presentation:
                            'modal',
                        }}
                      />

                      <Stack.Screen
                        name="EditProfile"
                        component={
                          EditProfileScreen
                        }
                      />

                      <Stack.Screen
                        name="ApplyScholar"
                        component={
                          ApplyScholarScreen
                        }
                      />

                      <Stack.Screen
                        name="Search"
                        component={
                          SearchScreen
                        }
                      />

                      <Stack.Screen
                        name="ProfileVideos"
                        component={
                          ProfileVideosScreen
                        }
                      />

                      <Stack.Screen
                        name="LiveStream"
                        component={
                          LiveStreamScreen
                        }
                      />

                      <Stack.Screen
                        name="WatchLive"
                        component={
                          WatchLiveRoute
                        }
                      />

                      <Stack.Screen
                        name="FollowList"
                        component={
                          FollowListScreen
                        }
                      />

                      <Stack.Screen
                        name="Settings"
                        component={
                          SettingsScreen
                        }
                      />

                      <Stack.Screen
                        name="UserProfile"
                        component={
                          ProfileScreen
                        }
                      />

                      <Stack.Screen
                        name="VideoDetail"
                        component={
                          VideoDetailScreen
                        }
                      />

                      <Stack.Screen
                        name="ResetPassword"
                        component={
                          ResetPasswordScreen
                        }
                      />

                      <Stack.Screen
                        name="Admin"
                        component={
                          AdminScreen
                        }
                      />

                      <Stack.Screen
                        name="MyUploads"
                        component={
                          MyUploadsScreen
                        }
                      />

                      <Stack.Screen
                        name="ContactAdmin"
                        component={
                          ContactAdminScreen
                        }
                      />

                      <Stack.Screen
                        name="Quran"
                        component={
                          QuranScreen
                        }
                      />

                      <Stack.Screen
                        name="QuranReader"
                        component={
                          QuranReaderScreen
                        }
                      />

                      <Stack.Screen
                        name="RecitationChecker"
                        component={
                          RecitationCheckerScreen
                        }
                      />
                    </Stack.Navigator>

                    <GlobalVideoOptionsSheet />
                  </NavigationContainer>
                </BottomSheetModalProvider>
              </GestureHandlerRootView>
            </DownloadProvider>
          </UserProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </>
  );
}

export default Sentry.wrap(App);

const styles = StyleSheet.create({});