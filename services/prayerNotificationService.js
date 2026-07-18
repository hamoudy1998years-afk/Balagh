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
      // JS vibration removed here â€” native channel vibration handles it when app is killed
      const { sound, status } = await Audio.Sound.createAsync(source, { shouldPlay: true });
      currentAdhanSound = sound;
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

const PRAYER_CHANNEL = 'prayer-times-v3';
const PERSISTENT_ID = 'prayer-persistent';
const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const DISPLAY_PRAYERS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

// â”€â”€ Setup notification channel (Android) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ADHAN_ALERT_SOUND = 'adhan_alert.wav';
const ADHAN_IOS_SOUNDS = [
  'adhan_ios_makkah.wav',
  'adhan_ios_madinah.wav',
  'adhan_ios_aqsa.wav',
  'adhan_ios_fajr.wav',
];

export async function setupNotificationChannel(withSound = true) {
  await Notifications.setNotificationChannelAsync(PRAYER_CHANNEL, {
    name: 'Prayer Times',
    importance: Notifications.AndroidImportance.MAX,
    sound: withSound ? ADHAN_ALERT_SOUND : null,
    vibrationPattern: withSound ? [0, 1000, 500, 1000, 500, 1000, 500, 1000] : null,
    enableVibrate: withSound,
    bypassDnd: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

// â”€â”€ Schedule all 5 prayer notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // Use native module for reliable scheduling when app is killed
  if (Platform.OS === 'android') {
    try {
      const { NativeModules } = require('react-native');
      const AdhanModule = NativeModules.AdhanModule;
      if (AdhanModule) {
        // Cancel all stale native alarms before rescheduling (handles disabled prayers + time changes)
        AdhanModule.cancelAllAdhans();

        for (let day = 0; day < 30; day++) {
          for (const prayer of PRAYERS) {
            if (prefs[prayer] === false) continue;
            const time = timings[prayer];
            if (!time) continue;
            const [hours, minutes] = time.split(':').map(Number);
            const savedAdhanStyle = await AsyncStorage.getItem('adhanStyle');
            const styleIndex = savedAdhanStyle ? parseInt(savedAdhanStyle) : 0;
            AdhanModule.scheduleAdhan(prayer, hours, minutes, day, styleIndex);
            
            // Save prayer data to native SharedPreferences for boot/update recovery
            if (day === 0) {
              const timingsJson = JSON.stringify(timings);
              const prefsJson = JSON.stringify(prefs);
              AdhanModule.savePrayerData(timingsJson, prefsJson, styleIndex, true);
            }
          }
        }
        return;
      }
    } catch (e) {
      console.warn('Native AdhanModule not available, falling back to JS');
    }
  }

  // JS fallback — schedule 7 days via expo-notifications
  const savedAdhanStyle = await AsyncStorage.getItem('adhanStyle');
  const styleIndex = savedAdhanStyle ? parseInt(savedAdhanStyle) : 0;
  for (let day = 0; day < 7; day++) {
    for (const prayer of PRAYERS) {
      if (prefs[prayer] === false) continue;
      const time = timings[prayer];
      if (!time) continue;
      const [hours, minutes] = time.split(':').map(Number);

      const triggerDate = new Date();
      triggerDate.setDate(triggerDate.getDate() + day);
      triggerDate.setHours(hours, minutes, 0, 0);
      if (day === 0 && triggerDate.getTime() <= Date.now()) continue;

      await Notifications.scheduleNotificationAsync({
        identifier: `prayer-slot-${prayer}-${day}`,
        content: {
          title: `ðŸ•Œ ${getPrayerEmoji(prayer)} ${prayer} Prayer Time`,
          body: `It's time for ${prayer} prayer. Allahu Akbar!`,
          sound: withSound ? (Platform.OS === 'ios' ? ADHAN_IOS_SOUNDS[prayer === 'Fajr' ? 3 : styleIndex] : ADHAN_ALERT_SOUND) : false,
          channelId: PRAYER_CHANNEL,
          categoryIdentifier: 'prayer-actions',
          data: { type: 'prayer', prayer, hours, minutes, day },
        },
        trigger: {
          type: 'date',
          date: triggerDate,
          channelId: PRAYER_CHANNEL,
        },
      });
    }
  }
}

// Pure OS-scheduled refresh â€” fires 30 min before each remaining prayer today,
// re-posts the persistent notification so it comes back even if dismissed via
// the individual trash icon. No background task needed, so it's reliable
// even if the app is killed.
async function schedulePersistentRefreshes(timings) {
  if (Platform.OS === 'android') return; // native alarms handle refreshes

  const nextPrayer = getNextPrayer(timings);
  const lines = DISPLAY_PRAYERS.map(prayer => {
    const isSunrise = prayer === 'Sunrise';
    const time = formatTime(timings[prayer] ?? '00:00');
    if (isSunrise) return `ðŸŒ„ ${prayer}: ${time}`;
    const isNext = prayer === nextPrayer.name;
    const isPast = (() => {
      if (!timings[prayer]) return false;
      const [h, m] = timings[prayer].split(':').map(Number);
      const now = new Date();
      return h * 60 + m < now.getHours() * 60 + now.getMinutes();
    })();
    const status = isNext ? 'â°' : isPast ? 'âœ…' : 'ðŸ”²';
    return `${status} ${getPrayerEmoji(prayer)} ${prayer}: ${time}`;
  }).join('\n');

  for (const prayer of PRAYERS) {
    const [h, m] = timings[prayer].split(':').map(Number);
    const prayerTime = new Date();
    prayerTime.setHours(h, m, 0, 0);
    const refreshTime = new Date(prayerTime.getTime() - 30 * 60 * 1000);
    if (refreshTime.getTime() <= Date.now()) continue;

    await Notifications.scheduleNotificationAsync({
      identifier: PERSISTENT_ID,
      content: {
        title: `ðŸ•Œ Next: ${nextPrayer.name} at ${nextPrayer.time}`,
        body: lines,
        sticky: true,
        sound: false,
        data: { type: 'persistent' },
        android: {
          ongoing: true,
          priority: 'max',
          style: { type: 'bigText', text: lines, summaryText: `Next: ${nextPrayer.name} in ${nextPrayer.countdown}` },
        },
      },
      trigger: { type: 'date', date: refreshTime, channelId: PRAYER_CHANNEL },
    });
  }
}

// â”€â”€ Cancel all prayer notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function cancelPrayerNotifications() {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of scheduled) {
    if (n.identifier.startsWith('prayer-slot-')) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier);
    }
  }
}

// â”€â”€ Show persistent notification with all prayer times â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function showPersistentNotification(timings) {
  if (!timings) return;

  // Android: use native persistent notification (survives app kill)
  if (Platform.OS === 'android') {
    try {
      const { NativeModules } = require('react-native');
      if (NativeModules.AdhanModule) {
        NativeModules.AdhanModule.showPersistent();
        return;
      }
    } catch (e) {
      // fall through to JS path
    }
  }

  const nextPrayer = getNextPrayer(timings);

  // Build lines using DISPLAY_PRAYERS (includes Sunrise)
  const lines = DISPLAY_PRAYERS.map(prayer => {
    const isSunrise = prayer === 'Sunrise';
    const time = formatTime(timings[prayer] ?? '00:00');
    if (isSunrise) {
      return `ðŸŒ„ ${prayer}: ${time}`;
    }
    const isNext = prayer === nextPrayer.name;
    const isPast = (() => {
      if (!timings[prayer]) return false;
      const [h, m] = timings[prayer].split(':').map(Number);
      const now = new Date();
      return h * 60 + m < now.getHours() * 60 + now.getMinutes();
    })();
    const status = isNext ? 'â°' : isPast ? 'âœ…' : 'ðŸ”²';
    return `${status} ${getPrayerEmoji(prayer)} ${prayer}: ${time}`;
  }).join('\n');

  try {
    await Notifications.dismissNotificationAsync(PERSISTENT_ID);
    await Notifications.scheduleNotificationAsync({
      identifier: PERSISTENT_ID,
      content: {
        title: `ðŸ•Œ Next: ${nextPrayer.name} at ${nextPrayer.time}`,
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

// â”€â”€ Update persistent notification every minute â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function updatePersistentNotification(timings) {
  await showPersistentNotification(timings);
}

// â”€â”€ Initialize prayer notifications on app start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // Re-check exact alarm permission on every app open (Android can revoke it silently)
    if (Platform.OS === 'android') {
      try {
        const { NativeModules } = require('react-native');
        const AdhanModule = NativeModules.AdhanModule;
        if (AdhanModule?.canScheduleExactAlarms) {
          const canSchedule = await AdhanModule.canScheduleExactAlarms();
          if (!canSchedule) {
            await requestExactAlarmPermission();
          }
        }
      } catch (e) {
        // non-fatal
      }
    }

    // Load cached prayer data
    const cached = await loadPrayerCache();
    if (cached?.data?.timings) {
      await schedulePrayerNotifications(cached.data.timings, withSound);
      await showPersistentNotification(cached.data.timings);
      await schedulePersistentRefreshes(cached.data.timings);
    }

    // Fetch fresh data in background
    const { status: locationStatus } = await Location.getForegroundPermissionsAsync();
    if (locationStatus === 'granted') {
      const location = await Location.getCurrentPositionAsync({});
      const data = await getPrayerTimes(location.coords.latitude, location.coords.longitude);
      await savePrayerCache(data, location.coords);
      await schedulePrayerNotifications(data.timings, withSound);
      await showPersistentNotification(data.timings);
      await schedulePersistentRefreshes(data.timings);
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

// â”€â”€ Request exact alarm permission (Android 12+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        // Fetch failed (no internet?) â€” fall back to whatever we have
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
// â”€â”€ Check if user has made a choice â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function getPrayerNotifChoice() {
  const choice = await AsyncStorage.getItem('prayerNotifChoice');
  return choice;
}

export async function setPrayerNotifChoice(choice) {
  await AsyncStorage.setItem('prayerNotifChoice', choice);
}


