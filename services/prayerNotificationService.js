import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { getPrayerTimes, getNextPrayer, formatTime, getPrayerEmoji, loadPrayerCache, savePrayerCache } from './prayerApi';

const BACKGROUND_NOTIFICATION_TASK = 'BACKGROUND-NOTIFICATION-TASK';

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
  if (error) return;
  if (data?.notification?.request?.content?.data?.type === 'prayer') {
    try {
      const prayer = data.notification.request.content.data.prayer;
      const savedAdhanStyle = await AsyncStorage.getItem('adhanStyle');
      const adhanIndex = savedAdhanStyle ? parseInt(savedAdhanStyle) : 0;
      
      const ADHAN_SOURCES = [
        require('../assets/audio/adhan_makkah.mp3'),
        require('../assets/audio/adhan_madinah.mp3'),
        require('../assets/audio/adhan_aqsa.mp3'),
        require('../assets/audio/adhan_fajr.mp3'),
      ];

      // Fajr uses special adhan
      const source = prayer === 'Fajr' ? ADHAN_SOURCES[3] : ADHAN_SOURCES[adhanIndex];

      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: true });
      const { sound } = await Audio.Sound.createAsync(source, { shouldPlay: true });
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) sound.unloadAsync();
      });
    } catch (e) {
      __DEV__ && console.warn('[PrayerNotif] Background task error:', e.message);
    }
  }
});

const PRAYER_TASK = 'PRAYER_NOTIFICATION_TASK';
const PRAYER_CHANNEL = 'prayer-times';
const PERSISTENT_ID = 'prayer-persistent';
const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const DISPLAY_PRAYERS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

// ── Setup notification channel (Android) ──────────────────────────────────────
const ADHAN_ALERT_SOUND = 'adhan_alert.wav';

export async function setupNotificationChannel(withSound = true) {
  await Notifications.setNotificationChannelAsync(PRAYER_CHANNEL, {
    name: 'Prayer Times',
    importance: Notifications.AndroidImportance.MAX,
    sound: withSound ? ADHAN_ALERT_SOUND : null,
    vibrationPattern: withSound ? [0, 250, 250, 250] : null,
    enableVibrate: withSound,
    bypassDnd: true,
  });
}

// ── Schedule all 5 prayer notifications ───────────────────────────────────────
export async function schedulePrayerNotifications(timings, withSound = true) {
  await cancelPrayerNotifications();

  for (const prayer of PRAYERS) {
    const time = timings[prayer];
    if (!time) continue;
    const [hours, minutes] = time.split(':').map(Number);

    await Notifications.scheduleNotificationAsync({
      identifier: `prayer-${prayer}`,
      content: {
        title: `🕌 ${getPrayerEmoji(prayer)} ${prayer} Prayer Time`,
        body: `It's time for ${prayer} prayer. Allahu Akbar!`,
        sound: withSound ? ADHAN_ALERT_SOUND : false,
        channelId: PRAYER_CHANNEL,
        data: { type: 'prayer', prayer },
      },
      trigger: {
        type: 'daily',
        hour: hours,
        minute: minutes,
      },
    });
  }
}

export async function scheduleDailySummary(timings, withSound = true) {
  try {
    await Notifications.cancelScheduledNotificationAsync('prayer-daily-summary');

    const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
    
    const lines = PRAYERS.map(prayer => {
      const time = formatTime(timings[prayer]);
      return `${getPrayerEmoji(prayer)} ${prayer.padEnd(8)} ${time}`;
    }).join('\n');

    const [hours, minutes] = timings['Fajr'].split(':').map(Number);

    await Notifications.scheduleNotificationAsync({
      identifier: 'prayer-daily-summary',
      content: {
        title: '🕌 Today\'s Prayer Times',
        body: lines,
        sound: withSound,
        channelId: PRAYER_CHANNEL,
        data: { type: 'daily-summary' },
        android: {
          style: {
            type: 'bigText',
            text: lines,
            summaryText: 'Tap to expand all prayer times',
          },
          ongoing: false,
          priority: 'high',
        },
      },
      trigger: {
        type: 'daily',
        hour: hours,
        minute: minutes,
      },
    });
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] scheduleDailySummary error:', e.message);
  }
}

// ── Cancel all prayer notifications ───────────────────────────────────────────
export async function cancelPrayerNotifications() {
  for (const prayer of PRAYERS) {
    await Notifications.cancelScheduledNotificationAsync(`prayer-${prayer}`);
  }
}

// ── Show persistent notification with all prayer times ────────────────────────
export async function showPersistentNotification(timings) {
  if (!timings) return;

  const nextPrayer = getNextPrayer(timings);

  // Build lines using DISPLAY_PRAYERS (includes Sunrise)
  const lines = DISPLAY_PRAYERS.map(prayer => {
    const isSunrise = prayer === 'Sunrise';
    const time = formatTime(timings[prayer] ?? '00:00');
    if (isSunrise) {
      return `🌄 ${prayer}: ${time}`;
    }
    const isNext = prayer === nextPrayer.name;
    const isPast = (() => {
      if (!timings[prayer]) return false;
      const [h, m] = timings[prayer].split(':').map(Number);
      const now = new Date();
      return h * 60 + m < now.getHours() * 60 + now.getMinutes();
    })();
    const status = isNext ? '⏰' : isPast ? '✅' : '🔲';
    return `${status} ${getPrayerEmoji(prayer)} ${prayer}: ${time}`;
  }).join('\n');

  try {
    await Notifications.dismissNotificationAsync(PERSISTENT_ID);
    await Notifications.scheduleNotificationAsync({
      identifier: PERSISTENT_ID,
      content: {
        title: `🕌 Next: ${nextPrayer.name} at ${nextPrayer.time}`,
        body: lines,
        sticky: true,
        sound: false,
        channelId: PRAYER_CHANNEL,
        data: { type: 'persistent' },
        android: {
          ongoing: true,
          priority: 'max',
          style: {
            type: 'bigText',
            text: lines,
            summaryText: `Next: ${nextPrayer.name} in ${nextPrayer.countdown}`,
          },
        },
      },
      trigger: null,
    });
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] showPersistentNotification error:', e.message);
  }
}

// ── Update persistent notification every minute ───────────────────────────────
export async function updatePersistentNotification(timings) {
  await showPersistentNotification(timings);
}

// ── Initialize prayer notifications on app start ──────────────────────────────
export async function initPrayerNotifications(withSound = true) {
  try {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') {
      __DEV__ && console.warn('[PrayerNotif] Permission not granted');
      return;
    }

    await setupNotificationChannel(withSound);

    // Load cached prayer data
    const cached = await loadPrayerCache();
    if (cached?.data?.timings) {
      await schedulePrayerNotifications(cached.data.timings, withSound);
      await scheduleDailySummary(cached.data.timings, withSound);
      await showPersistentNotification(cached.data.timings);
    }

    // Fetch fresh data in background
    const { status: locationStatus } = await Location.getForegroundPermissionsAsync();
    if (locationStatus === 'granted') {
      const location = await Location.getCurrentPositionAsync({});
      const data = await getPrayerTimes(location.coords.latitude, location.coords.longitude);
      await savePrayerCache(data, location.coords);
      await schedulePrayerNotifications(data.timings, withSound);
      await scheduleDailySummary(data.timings, withSound);
      await showPersistentNotification(data.timings);
    }
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] init error:', e.message);
  }
}

// ── Check if user has made a choice ───────────────────────────────────────────
export async function getPrayerNotifChoice() {
  const choice = await AsyncStorage.getItem('prayerNotifChoice');
  return choice;
}

export async function setPrayerNotifChoice(choice) {
  await AsyncStorage.setItem('prayerNotifChoice', choice);
}

// TEMPORARY — for testing the adhan sound only. Remove once confirmed working.
export async function scheduleTestNotification() {
  await setupNotificationChannel(true);
  await Notifications.scheduleNotificationAsync({
    identifier: 'prayer-test',
    content: {
      title: '🕌 Test Adhan Notification',
      body: 'If you hear the short Adhan clip, it worked!',
      sound: ADHAN_ALERT_SOUND,
      channelId: PRAYER_CHANNEL,
      data: { type: 'test' },
    },
    trigger: { type: 'timeInterval', seconds: 10, repeats: false },
  });
}