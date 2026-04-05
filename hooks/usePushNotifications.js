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

export function usePushNotifications() {
  useEffect(() => {
    registerForPushNotifications();
  }, []);
}

async function registerForPushNotifications() {
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

    await supabase
      .from('profiles')
      .update({ push_token: token })
      .eq('id', user.id);

  } catch (e) {
    __DEV__ && console.log('Push token error:', e);
  }
}