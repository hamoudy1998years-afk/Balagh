import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { Platform, Vibration } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { getPrayerTimes, getNextPrayer, formatTime, getPrayerEmoji, loadPrayerCache, savePrayerCache, loadMonthlyCache, saveMonthlyCache, getTodayTimingsFromMonthly, getMonthlyTimetable } from './prayerApi';

const BACKGROUND_NOTIFICATION_TASK = 'BACKGROUND-NOTIFICATION-TASK';

// Holds all currently playing Adhan audio player instances
let adhanPlayers = [];
let audioModeSetupDone = false;

async function ensureAudioModeReady() {
  if (audioModeSetupDone) return;
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'duckOthers',
  });
  audioModeSetupDone = true;
}

async function playAdhanTrack(source, prayer) {
  await ensureAudioModeReady();

  const player = createAudioPlayer(source);
  adhanPlayers.push(player);
  let halfDurationTimer = null;
  let halfPointSet = false;

  player.addListener('playbackStatusUpdate', (status) => {
    if (!halfPointSet && status.duration) {
      halfPointSet = true;
      const halfMs = (status.duration / 2) * 1000;
      halfDurationTimer = setTimeout(() => {
        Vibration.cancel();
      }, halfMs);
    }
    if (status.didJustFinish) {
      Vibration.cancel();
      if (halfDurationTimer) clearTimeout(halfDurationTimer);
      adhanPlayers = adhanPlayers.filter(p => p !== player);
    }
  });
  player.play();
}

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
  if (error) return;
  if (data?.notification?.request?.content?.data?.type === 'daily-summary-check') {
    try {
      const reliableTimings = await getReliableTodayTimings();
      if (reliableTimings) {
        await checkAndRestoreDailySummary(reliableTimings); // only touches it if it's missing
        await scheduleSwipeCheck(reliableTimings); // arms the next check, 30 min before the following prayer
      }
    } catch (e) {
      __DEV__ && console.warn('[PrayerNotif] Swipe check error:', e.message);
    }
  }
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
            channelId: STATUS_CHANNEL,
            data: { type: 'daily-summary', hours: freshHours, minutes: freshMinutes },
            android: {
              style: { type: 'bigText', text: freshLines, summaryText: 'Tap to expand all prayer times' },
              ongoing: false,
              priority: 'high',
            },
          },
          trigger: { type: 'date', date: nextDay, channelId: STATUS_CHANNEL },
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

      // Dismiss any previous un-stopped Adhan notification before this one takes over
      try {
        const presented = await Notifications.getPresentedNotificationsAsync();
        for (const n of presented) {
          if (n.request.content.data?.type === 'prayer' && n.request.identifier !== data.notification.request.identifier) {
            await Notifications.dismissNotificationAsync(n.request.identifier);
          }
        }
      } catch (e) {}

      Vibration.vibrate([0, 1000, 500, 1000, 500, 1000], true);
      await playAdhanTrack(source, prayer);

      // Refresh the persistent notification right at this prayer's exact time
      const reliableTimingsForRefresh = await getReliableTodayTimings();
      if (reliableTimingsForRefresh) {
        await showPersistentNotification(reliableTimingsForRefresh);
      }

      // Reschedule this prayer for tomorrow (same clock time), exact trigger
      // Skip for test notifications so they don't overwrite the real prayer's schedule
      const { hours, minutes, test } = data.notification.request.content.data;
      if (!test && hours != null && minutes != null) {
        const nextDay = new Date();
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(hours, minutes, 0, 0);
        await Notifications.scheduleNotificationAsync({
          identifier: `prayer-${prayer}`,
          content: {
            ...data.notification.request.content,
            categoryIdentifier: 'prayer-actions',
          },
          trigger: { type: 'date', date: nextDay, channelId: PRAYER_CHANNEL },
        });
      }
    } catch (e) {
      __DEV__ && console.warn('[PrayerNotif] Background task error:', e.message);
    }
  }
});

async function handlePrayerEvent(content, notifId) {
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

    // Dismiss any previous un-stopped Adhan notification before this one takes over
    try {
      const presented = await Notifications.getPresentedNotificationsAsync();
      for (const n of presented) {
        if (n.request.content.data?.type === 'prayer' && n.request.identifier !== notifId) {
          await Notifications.dismissNotificationAsync(n.request.identifier);
        }
      }
    } catch (e) {}

    Vibration.vibrate([0, 1000, 500, 1000, 500, 1000], true);
    await playAdhanTrack(source, prayer);
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] handlePrayerEvent error:', e.message);
  }
}

const PRAYER_TASK = 'PRAYER_NOTIFICATION_TASK';
const PRAYER_CHANNEL = 'prayer-times-v5';
const STATUS_CHANNEL = 'prayer-status-v1'; // silent channel — persistent + daily summary live here now
const PERSISTENT_ID = 'prayer-persistent';
const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const DISPLAY_PRAYERS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

// ── Setup notification channel (Android) ──────────────────────────────────────
const ADHAN_ALERT_SOUND = 'adhan_silent.wav';

export async function setupNotificationChannel(withSound = true) {
  await Notifications.setNotificationChannelAsync(PRAYER_CHANNEL, {
    name: 'Prayer Times',
    importance: Notifications.AndroidImportance.MAX,
    sound: withSound ? ADHAN_ALERT_SOUND : null,
    vibrationPattern: withSound ? [0, 250, 250, 250] : null,
    enableVibrate: withSound,
    bypassDnd: true,
  });

  // Separate, always-silent channel — sound:false on a PRAYER_CHANNEL
  // notification gets ignored, the channel's own Adhan sound fires anyway.
  await Notifications.setNotificationChannelAsync(STATUS_CHANNEL, {
    name: 'Prayer Status',
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: null,
    enableVibrate: false,
  });
}

// ── Schedule all 5 prayer notifications ───────────────────────────────────────
function getNextPrayerNameAndTime(timings) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const prayer of PRAYERS) {
    const [h, m] = timings[prayer].split(':').map(Number);
    if (h * 60 + m > nowMinutes) return { hours: h, minutes: m };
  }
  const [h, m] = timings['Fajr'].split(':').map(Number);
  return { hours: h, minutes: m }; // tomorrow's Fajr
}

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
        body: `Allahu Akbar!`,
        sound: withSound ? ADHAN_ALERT_SOUND : false,
        channelId: PRAYER_CHANNEL,
        categoryIdentifier: 'prayer-actions',
        data: { type: 'prayer', prayer, hours, minutes },
        sticky: true,
        android: { ongoing: true },
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
        channelId: STATUS_CHANNEL,
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
        sound: false,
        channelId: STATUS_CHANNEL,
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
        channelId: STATUS_CHANNEL,
      },
    });
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] scheduleDailySummary error:', e.message);
  }
}

// Silent, invisible trigger — its only job is to wake the background task
// 30 minutes before the next prayer to check if the daily summary was swiped away.
export async function scheduleSwipeCheck(timings) {
  try {
    await Notifications.cancelScheduledNotificationAsync('daily-summary-check');

    const { hours: nextH, minutes: nextM } = getNextPrayerNameAndTime(timings);
    const rawTrigger = getNextOccurrence(nextH, nextM);
    const triggerDate = new Date(rawTrigger.getTime() - 30 * 60 * 1000);

    if (triggerDate.getTime() <= Date.now()) {
      // Already inside the 30-min window — run the check right now instead
      await checkAndRestoreDailySummary(timings);
      return;
    }

    await Notifications.scheduleNotificationAsync({
      identifier: 'daily-summary-check',
      content: {
        title: '',
        body: '',
        sound: false,
        data: { type: 'daily-summary-check' },
      },
      trigger: {
        type: 'date',
        date: triggerDate,
        channelId: STATUS_CHANNEL,
      },
    });
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] scheduleSwipeCheck error:', e.message);
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
        channelId: STATUS_CHANNEL,
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
      await scheduleSwipeCheck(cached.data.timings);
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
      await scheduleSwipeCheck(data.timings);
      await showPersistentNotification(data.timings);
    }
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);

    Notifications.addNotificationReceivedListener((notification) => {
      const content = notification.request.content;
      if (content?.data?.type === 'prayer') {
        handlePrayerEvent(content, notification.request.identifier);
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
    const presented = await Notifications.getPresentedNotificationsAsync();
    const isVisible = presented.some(n => n.request.identifier === 'prayer-daily-summary');

    if (!isVisible) {
      // Swiped away — restore it, no daily limit
      await scheduleDailySummaryNow(timings);
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
  try {
    for (const player of adhanPlayers) {
      try {
        player.pause();
        player.remove();
      } catch (e) {}
    }
    adhanPlayers = [];
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] stopCurrentAdhan error:', e.message);
  }
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented) {
      if (n.request.content.data?.type === 'prayer') {
        await Notifications.dismissNotificationAsync(n.request.identifier);
      }
    }
  } catch (e) {
    __DEV__ && console.warn('[PrayerNotif] dismiss error:', e.message);
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

// TEMPORARY — fires a real prayer-type Adhan 5 sec from now, using the currently
// selected Adhan style, so it goes through the exact same path (sound, channel,
// banner, Stop button) as a real prayer notification. test:true stops it from
// overwriting the real Dhuhr schedule. Remove once banner testing is done.
export async function scheduleTestAdhanNotification() {
  const fireDate = new Date(Date.now() + 5000);
  await Notifications.scheduleNotificationAsync({
    identifier: 'prayer-test-adhan-' + Date.now(),
    content: {
      title: '🕌 🧪 Dhuhr Prayer Time',
      body: `Allahu Akbar!`,
      sound: ADHAN_ALERT_SOUND,
      channelId: PRAYER_CHANNEL,
      categoryIdentifier: 'prayer-actions',
      data: { type: 'prayer', prayer: 'Dhuhr', test: true, hours: fireDate.getHours(), minutes: fireDate.getMinutes() },
      sticky: true,
      android: { ongoing: true },
    },
    trigger: { type: 'date', date: fireDate, channelId: PRAYER_CHANNEL },
  });
}