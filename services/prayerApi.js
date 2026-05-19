import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_URL = 'https://api.aladhan.com/v1';

export async function getCoordinates() {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') throw new Error('Location permission denied');

  const enabled = await Location.hasServicesEnabledAsync();
  if (!enabled) throw new Error('Please enable location services');

  const location = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });

  const { latitude, longitude } = location.coords;
  
  // Warn if coords look wrong (Manila is ~14.5, 121.0; Zamboanga is ~6.9, 122.0)
  if (latitude > 10) {
    console.warn('[PrayerApi] WARNING: Got coords north of 10°N. If you are in Zamboanga/Mindanao, this is WRONG. Emulator may be set to Manila.');
    console.warn('[PrayerApi] Coords:', latitude, longitude);
  }
  
  console.log('[PrayerApi] GPS coords:', latitude, longitude);
  return { latitude, longitude };
}

export async function getPrayerTimes(latitude, longitude) {
  const date = new Date();
  const timestamp = Math.floor(date.getTime() / 1000);
  
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    method: '3',
    school: '0',
    timezonestring: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tune: '0,0,0,0,-1,0,0,0,0',  // -1 min Asr (format: Imsak,Fajr,Sunrise,Dhuhr,Asr,Maghrib,Sunset,Isha,Midnight)
  });
  
  const url = `${BASE_URL}/timings/${timestamp}?${params.toString()}`;
  console.log('[PrayerApi] Full URL:', url);
  
  const response = await fetch(url);
  const data = await response.json();
  if (data.code !== 200) throw new Error('Failed to fetch prayer times');
  
  console.log('[PrayerApi] Times:', data.data.timings);
  return data.data;
}

export async function getMonthlyTimetable(latitude, longitude) {
  const date = new Date();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    method: '3',
    school: '0',
    timezonestring: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tune: '0,0,0,0,-1,0,0,0,0',  // ← ADD THIS
  });
  
  const response = await fetch(
    `${BASE_URL}/calendar/${year}/${month}?${params.toString()}`
  );
  const data = await response.json();
  if (data.code !== 200) throw new Error('Failed to fetch timetable');
  return data.data;
}

export function getNextPrayer(timings) {
  const prayers = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  for (const prayer of prayers) {
    const [hours, minutes] = timings[prayer].split(':').map(Number);
    const prayerMinutes = hours * 60 + minutes;
    if (prayerMinutes > currentMinutes) {
      const diff = prayerMinutes - currentMinutes;
      const h = Math.floor(diff / 60);
      const m = diff % 60;
      return {
        name: prayer,
        time: formatTime(timings[prayer]),
        countdown: h > 0 ? `${h}h ${m}m` : `${m}m`,
        minutesLeft: diff,
      };
    }
  }
  // All prayers passed, next is Fajr tomorrow
  const [hours, minutes] = timings['Fajr'].split(':').map(Number);
  const fajrMinutes = hours * 60 + minutes + 1440;
  const diff = fajrMinutes - currentMinutes;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return {
    name: 'Fajr',
    time: formatTime(timings['Fajr']),
    countdown: h > 0 ? `${h}h ${m}m` : `${m}m`,
    minutesLeft: diff,
  };
}

export function formatTime(time24) {
  const [hours, minutes] = time24.split(':').map(Number);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  return `${h}:${String(minutes).padStart(2, '0')} ${ampm}`;
}

export function getPrayerEmoji(prayer) {
  const emojis = {
    Fajr: '🌅',
    Sunrise: '🌄',
    Dhuhr: '☀️',
    Asr: '🌤',
    Maghrib: '🌇',
    Isha: '🌙',
  };
  return emojis[prayer] || '🕌';
}

const CACHE_KEY = 'prayerTimesCache';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function savePrayerCache(data, coords) {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({
      data,
      coords,
      timestamp: Date.now(),
    }));
  } catch (e) {}
}

export async function loadPrayerCache() {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const isExpired = Date.now() - parsed.timestamp > CACHE_TTL;
    if (isExpired) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}