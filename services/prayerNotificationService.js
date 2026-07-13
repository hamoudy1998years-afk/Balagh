import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { Platform, Vibration } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { getPrayerTimes, getNextPrayer, formatTime, getPrayerEmoji, loadPrayerCache, savePrayerCache, loadMonthlyCache, saveMonthlyCache, getTodayTimingsFromMonthly, getMonthlyTimetable } from './prayerApi';

const BACKGROUND_NOTIFICATION_TASK = 'BACKGROUND-NOTIFICATION-TASK';

// Keeps a reference to the currently playing Adhan so we can stop it on tap
let currentAdhanSound = null;

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
  if (error) return;
  if (data?.notification?.request?.content?.data?.type === 'daily-summary') {
    try {
      const reliableTimings = await getReliableTodayTimings();
      if (reliableTimings) {
        const freshLines = PRAYERS.map(prayer => {
          const time = formatTime(reliableTimings[prayer]);
          return `${getPrayerEmoji(prayer)} ${prayer.padEnd(8)} ${time}`;
        }).join('\n');

        const [freshHours, freshMinutes] = reliableTimings['Fajr'].split(':').map(Number);
        const nextDay = new Date();
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(freshHours, freshMinutes, 0, 0);

        await Notifications.scheduleNotificationAsync({
          identifier: 'prayer-daily-summary',
          content: {
            title: '🕌 Today\'s Prayer Times',
            body: freshLines,
            sound: false,
            channelId: 'prayer-times-v3',
            data: { type: 'daily-summary', hours: freshHours, minutes: freshMinutes },
            android: {
              style: { type: 'bigText', text: freshLines, summaryText: 'Tap to expand all prayer times' },
              ongoing: false,
              priority: 'high',
            },
          },
          trigger: { type: 'date', date: nextDay, channelId: 'prayer-times-v3' },
        });
      }
    } catch (e) {
      __DEV__ && console.warn('[PrayerNotif] Daily summary reschedule error:', e.message);
    }
  }
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
      Vibration.vibrate([0, 1000, 500, 1000, 500, 1000], true);
      const { sound, status } = await Audio.Sound.createAsync(source, { shouldPlay: true });
      currentAdhanSound = sound;

      if (status?.durationMillis) {
        setTimeout(() => {
          Vibration.cancel();
        }, status.durationMillis / 2);
      }
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          sound.unloadAsync();
          if (currentAdhanSound === sound) currentAdhanSound = null;
          Vibration.cancel();
        }
      });

      // Refresh the persistent notification right at this prayer's exact time
      const reliableTimingsForRefresh = await getReliableTodayTimings();
      if (reliableTimingsForRefresh) {
        await showPersistentNotification(reliableTimingsForRefresh);
        await checkAndRestoreDailySummary(reliableTimingsForRefresh);
      }

      // Reschedule this prayer for tomorrow (same clock time), exact trigger
      const { hours, minutes } = data.notification.request.content.data;
      if (hours != null && minutes != null) {
        const nextDay = new Date();
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(hours, minutes, 0, 0);
        await Notifications.scheduleNotificationAsync({
          identifier: `prayer-${prayer}`,
          content: {
            ...data.notification.request.content,
            categoryIdentifier: 'prayer-actions',
          },
          trigger: { type: 'date', date: nextDay, channelId: 'prayer-times-v3' },
        });
      }
    } catch (e) {
      __DEV__ && console.warn('[PrayerNotif] Background task error:', e.message);
    }
  }
});

async function handlePrayerEvent(content) {
  try {
    const prayer = content.data.prayer;
    const savedAdhanStyle = await AsyncStorage.getItem('adhanStyle');
    const adhanIndex = savedAdhanStyle ? parseInt(savedAdhanStyle) : 0;
    
    const ADHAN_SOURCES = [
      require('../assets/audio/adhan_makkah.mp3'),
      require('../assets/audio/adhan_madinah.mp3'),
      require('../assets/audio/adhan_aqsa.mp3'),
      require('../assets/audio/adhan_fajr.mp3'),
    ];

    const source = prayer === 'Fajr' ? ADHAN_SOURCES[3] : ADHAN_SOURCES[adhanIndex];

    await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: true });
    Vibration.vibrate([0, 1000, 500, 1000, 500, 1000], true);
    const { sound, status } = await Audio.Sound.createAsync(source, { shouldPlay: true });
    currentAdhanSound = sound;

    if (status?.durationMillis) {
      setTimeout(() => { Vibration.cancel(); }, status.durationMillis / 2);
    }
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.didJustFinish) {
        sound.unloadAsync();
        if (currentAdhanSound === sound) currentAdhanSound = null;
        Vibration.cancel();
      }
    });
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] handlePrayerEvent error:', e.message);
  }
}

const PRAYER_TASK = 'PRAYER_NOTIFICATION_TASK';
const PRAYER_CHANNEL = 'prayer-times-v3';
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
export function getNextOccurrence(hours, minutes) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

export async function schedulePrayerNotifications(timings, withSound = true) {
  await cancelPrayerNotifications();

  const savedPrefs = await AsyncStorage.getItem('prayerNotifications');
  const prefs = savedPrefs ? JSON.parse(savedPrefs) : {};

  for (const prayer of PRAYERS) {
    if (prefs[prayer] === false) continue;
    const time = timings[prayer];
    if (!time) continue;
    const [hours, minutes] = time.split(':').map(Number);
    const triggerDate = getNextOccurrence(hours, minutes);

    await Notifications.scheduleNotificationAsync({
      identifier: `prayer-${prayer}`,
      content: {
        title: `🕌 ${getPrayerEmoji(prayer)} ${prayer} Prayer Time`,
        body: `It's time for ${prayer} prayer. Allahu Akbar!`,
        sound: withSound ? ADHAN_ALERT_SOUND : false,
        channelId: PRAYER_CHANNEL,
        categoryIdentifier: 'prayer-actions',
        data: { type: 'prayer', prayer, hours, minutes },
      },
      trigger: {
        type: 'date',
        date: triggerDate,
        channelId: PRAYER_CHANNEL,
      },
    });
  }
}

async function scheduleDailySummaryNow(timings) {
  try {
    const lines = PRAYERS.map(prayer => {
      const time = formatTime(timings[prayer]);
      return `${getPrayerEmoji(prayer)} ${prayer.padEnd(8)} ${time}`;
    }).join('\n');

    await Notifications.scheduleNotificationAsync({
      identifier: 'prayer-daily-summary',
      content: {
        title: '🕌 Today\'s Prayer Times',
        body: lines,
        sound: false,
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
      trigger: null,
    });
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] scheduleDailySummaryNow error:', e.message);
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
    const triggerDate = getNextOccurrence(hours, minutes);

    await Notifications.scheduleNotificationAsync({
      identifier: 'prayer-daily-summary',
      content: {
        title: '🕌 Today\'s Prayer Times',
        body: lines,
        sound: withSound,
        channelId: PRAYER_CHANNEL,
        data: { type: 'daily-summary', hours, minutes },
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
        type: 'date',
        date: triggerDate,
        channelId: PRAYER_CHANNEL,
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
      trigger: {
        channelId: PRAYER_CHANNEL,
      },
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

    await Notifications.setNotificationCategoryAsync('prayer-actions', [
      {
        identifier: 'stop-adhan',
        buttonTitle: 'Stop',
        options: { opensAppToForeground: false },
      },
    ]);

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

    Notifications.addNotificationReceivedListener((notification) => {
      const content = notification.request.content;
      if (content?.data?.type === 'prayer') {
        handlePrayerEvent(content);
      }
    });

    Notifications.addNotificationResponseReceivedListener((response) => {
      if (response.actionIdentifier === 'stop-adhan') {
        stopCurrentAdhan();
      }
    });
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] init error:', e.message);
  }
}

// ── Request exact alarm permission (Android 12+) ──────────────────────────────
async function checkAndRestoreDailySummary(timings) {
  try {
    const today = new Date().toDateString();
    const lastRestore = await AsyncStorage.getItem('dailySummaryRestoredDate');
    if (lastRestore === today) return; // already restored once today

    const presented = await Notifications.getPresentedNotificationsAsync();
    const isVisible = presented.some(n => n.request.identifier === 'prayer-daily-summary');

    if (!isVisible) {
      await scheduleDailySummaryNow(timings);
      await AsyncStorage.setItem('dailySummaryRestoredDate', today);
    }
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] checkAndRestoreDailySummary error:', e.message);
  }
}

async function getReliableTodayTimings() {
  try {
    const monthlyCache = await loadMonthlyCache();
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // If no monthly cache, or it's for a different month/year, fetch fresh
    const needsRefresh = !monthlyCache || monthlyCache.month !== currentMonth || monthlyCache.year !== currentYear;

    if (needsRefresh && monthlyCache?.coords) {
      try {
        const fresh = await getMonthlyTimetable(monthlyCache.coords.latitude, monthlyCache.coords.longitude);
        await saveMonthlyCache(fresh, monthlyCache.coords, currentMonth, currentYear);
        return getTodayTimingsFromMonthly(fresh);
      } catch (e) {
        // Fetch failed (no internet?) — fall back to whatever we have
        return getTodayTimingsFromMonthly(monthlyCache?.monthlyData);
      }
    }

    return getTodayTimingsFromMonthly(monthlyCache?.monthlyData);
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] getReliableTodayTimings error:', e.message);
    return null;
  }
}

async function stopCurrentAdhan() {
  Vibration.cancel();
  if (currentAdhanSound) {
    try {
      await currentAdhanSound.stopAsync();
      await currentAdhanSound.unloadAsync();
    } catch (e) {
      __DEV__ && console.warn('[PrayerNotif] stopCurrentAdhan error:', e.message);
    }
    currentAdhanSound = null;
  }
}

export async function requestExactAlarmPermission() {
  if (Platform.OS === 'android' && Platform.Version >= 31) {
    try {
      await IntentLauncher.startActivityAsync('android.settings.REQUEST_SCHEDULE_EXACT_ALARM');
    } catch (e) {
      __DEV__ && console.warn('[PrayerNotif] exact alarm permission error:', e.message);
    }
  }
}

export async function requestDndAccess() {
  if (Platform.OS === 'android') {
    try {
      await IntentLauncher.startActivityAsync('android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS');
    } catch (e) {
      try {
        await IntentLauncher.startActivityAsync('android.settings.APP_NOTIFICATION_SETTINGS', {
          'android.provider.extra.APP_PACKAGE': 'com.bushrann.app',
        });
      } catch (e2) {
        __DEV__ && console.warn('[PrayerNotif] DND access error:', e2.message);
      }
    }
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