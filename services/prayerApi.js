import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_URL = 'https://api.aladhan.com/v1';

export async function getCoordinates() {
  const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') {
    if (!canAskAgain) {
      throw new Error('PERMISSION_PERMANENTLY_DENIED');
    }
    throw new Error('PERMISSION_DENIED');
  }

  const enabled = await Location.hasServicesEnabledAsync();
  if (!enabled) throw new Error('Please enable location services');

  // ── Fast path: try last known position first (instant, no GPS wait) ──
  // Android caches the last GPS fix from any app (Maps, weather, etc.)
  // If it's recent enough and accurate enough, use it directly.
  try {
    const last = await Location.getLastKnownPositionAsync({
      maxAge: 5 * 60 * 1000,       // must be less than 5 minutes old
      requiredAccuracy: 5000,       // within 5km is fine for prayer times
    });
    if (last) {
      const { latitude, longitude } = last.coords;
      console.log('[PrayerApi] Using last known position (fast path):', latitude, longitude);
      return { latitude, longitude };
    }
  } catch (e) {
    // Last known position unavailable — fall through to fresh GPS
  }

  // ── Slow path: fresh GPS fix (first ever launch, or last position too old) ──
  const location = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });

  const { latitude, longitude } = location.coords;
  console.log('[PrayerApi] GPS coords (fresh):', latitude, longitude);
  return { latitude, longitude };
}

// ── Permanent saved coordinates (no GPS needed after first save) ───────────
const SAVED_COORDS_KEY = 'savedCoordinates';

export async function saveCoordinatesPermanently(coords) {
  try {
    await AsyncStorage.setItem(SAVED_COORDS_KEY, JSON.stringify(coords));
  } catch (e) {}
}

export async function loadSavedCoordinates() {
  try {
    const raw = await AsyncStorage.getItem(SAVED_COORDS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function reverseGeocode(latitude, longitude) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&addressdetails=1`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Bushrann Prayer App' }
  });
  const data = await response.json();
  const shortName = [
    data.address?.city ||
    data.address?.town ||
    data.address?.village ||
    data.address?.municipality ||
    data.address?.county,
    data.address?.country
  ].filter(Boolean).join(', ');
  return shortName || null;
}

export async function searchCity(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Bushrann Prayer App' }
  });
  const data = await response.json();
  return data.map(item => ({
    name: item.display_name,
    shortName: [
      item.address?.city ||
      item.address?.town ||
      item.address?.village ||
      item.address?.county,
      item.address?.country
    ].filter(Boolean).join(', '),
    latitude: parseFloat(item.lat),
    longitude: parseFloat(item.lon),
  }));
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
    tune: '0,0,0,0,-1,0,0,0,0',
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
    tune: '0,0,0,0,-1,0,0,0,0',
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
const CACHE_TTL = 10 * 60 * 1000;

const MONTHLY_CACHE_KEY = 'monthlyPrayerCache';

export async function saveMonthlyCache(monthlyData, coords, month, year) {
  try {
    await AsyncStorage.setItem(MONTHLY_CACHE_KEY, JSON.stringify({
      monthlyData,
      coords,
      month,
      year,
    }));
  } catch (e) {}
}

export async function loadMonthlyCache() {
  try {
    const raw = await AsyncStorage.getItem(MONTHLY_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Finds today's exact timings from a saved month's data, using the real device date
export function getTodayTimingsFromMonthly(monthlyData) {
  if (!monthlyData) return null;
  const today = new Date();
  const dayNum = String(today.getDate()).padStart(2, '0');
  const dayEntry = monthlyData.find(d => d.date.gregorian.day === dayNum);
  return dayEntry ? dayEntry.timings : null;
}

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