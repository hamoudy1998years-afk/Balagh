import { View, ActivityIndicator, TouchableOpacity, StyleSheet, Image, Pressable, Text } from 'react-native';
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
import { useEffect, useState } from 'react';
import React from 'react';
import CommentsModal from './screens/CommentsModal';

// Global Sheet Imports
import { DownloadProvider } from './context/DownloadContext';
import GlobalVideoOptionsSheet from './components/GlobalVideoOptionsSheet';

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
          borderColor: '#a78bfa',
        }}
        onError={() => setImageError(true)}
      />
    );
  }

  return <Text style={{ fontSize: size, color: color }}>👤</Text>;
}

function MainTabs() {
  const [homeKey, setHomeKey] = useState(0);
  const navigation = useNavigation();

  const handleHomePress = () => {
    const currentRoute = navigation.getState().routes[navigation.getState().index].name;

    if (currentRoute === 'Main') {
      const mainState = navigation.getState().routes.find(r => r.name === 'Main')?.state;
      const currentTab = mainState?.routes[mainState.index]?.name;

      if (currentTab === 'Home') {
        setHomeKey(prev => prev + 1);
        if (homeRefreshRef.current) homeRefreshRef.current();
      } else {
        navigation.navigate('Main', { screen: 'Home', params: { resetToForYou: true } });
      }
    } else {
      navigation.navigate('Main', { screen: 'Home', params: { resetToForYou: true } });
    }
  };

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0f0f0f',
          borderTopColor: '#1e1e1e',
          height: 57,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: '#a78bfa',
        tabBarInactiveTintColor: '#4b5563',
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Text style={{ fontSize: size, color: color }}>🏠</Text>
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
          tabBarIcon: ({ color, size }) => (
            <Text style={{ fontSize: size, color: color }}>➕</Text>
          ),
        }}
      />
      <Tab.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Text style={{ fontSize: size, color: color }}>🔔</Text>
          ),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarIcon: ({ color, size, focused }) => <ProfileTabIcon color={color} size={size} focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const { runMigrationIfNeeded, updateStoredGoogleToken } = useBiometricAuth();

  useEffect(() => {
    runMigrationIfNeeded();

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);

      if (_event === 'TOKEN_REFRESHED' && session?.user?.email && session?.refresh_token) {
        updateStoredGoogleToken(session.user.email, session.refresh_token);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0f0f0f', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#7c3aed" size="large" />
      </View>
    );
  }

  return (
    <DownloadProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <StatusBar style="light" translucent backgroundColor="transparent" />
          <BottomSheetModalProvider>
            <NavigationContainer>
              <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
                {session ? (
                  <>
                    <Stack.Screen name="Main" component={MainTabs} />
                    <Stack.Screen name="CommentsModal" component={CommentsModal} options={{ presentation: 'modal' }} />
                    <Stack.Screen name="EditProfile" component={EditProfileScreen} />
                    <Stack.Screen name="ApplyScholar" component={ApplyScholarScreen} />
                    <Stack.Screen name="Search" component={SearchScreen} />
                    <Stack.Screen name="ProfileVideos" component={ProfileVideosScreen} />
                    <Stack.Screen name="LiveStream" component={LiveStreamScreen} />
                    <Stack.Screen name="WatchLive" component={WatchLiveScreen} />
                    <Stack.Screen name="FollowList" component={FollowListScreen} />
                    <Stack.Screen name="Settings" component={SettingsScreen} />
                    <Stack.Screen name="AvatarCrop" component={AvatarCropScreen} />
                  </>
                ) : (
                  <>
                    <Stack.Screen name="Login" component={LoginScreen} />
                    <Stack.Screen name="Signup" component={SignupScreen} />
                  </>
                )}
              </Stack.Navigator>
              
              {/* Global Sheets - Always mounted at root level */}
              <GlobalVideoOptionsSheet />
              
            </NavigationContainer>
          </BottomSheetModalProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </DownloadProvider>
  );
}