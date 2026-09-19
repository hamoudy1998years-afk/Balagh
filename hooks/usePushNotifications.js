import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { supabase } from '../lib/supabase';


Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

let isRegistering = false;
let registerPending = false;

export function usePushNotifications() {
  useEffect(() => {
    registerForPushNotifications();

    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        registerForPushNotifications();
      }
    });

    return () => {
      authListener?.subscription?.unsubscribe();
    };
  }, []);
}

async function registerForPushNotifications() {
  if (isRegistering) {
    registerPending = true;
    return;
  }
  isRegistering = true;

  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;

    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') return;

    const token = (await Notifications.getExpoPushTokenAsync({
      projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID,
    })).data;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase
      .from('profiles')
      .update({ push_token: token })
      .eq('id', user.id);

    if (error) {
      __DEV__ && console.error('Push token save error:', error);
    }

  } catch (e) {
    __DEV__ && console.log('Push token error:', e);
  } finally {
    isRegistering = false;
    if (registerPending) {
      registerPending = false;
      registerForPushNotifications();
    }
  }
}