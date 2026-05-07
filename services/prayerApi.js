import * as Location from 'expo-location';

const BASE_URL = 'https://api.aladhan.com/v1';

export async function getCoordinates() {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') throw new Error('Location permission denied');
  const location = await Location.getCurrentPositionAsync({});
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
  };
}

export async function getPrayerTimes(latitude, longitude) {
  const date = new Date();
  const timestamp = Math.floor(date.getTime() / 1000);
  const response = await fetch(
    `${BASE_URL}/timings/${timestamp}?latitude=${latitude}&longitude=${longitude}&method=16&school=1`
  );
  const data = await response.json();
  if (data.code !== 200) throw new Error('Failed to fetch prayer times');
  return data.data;
}

export async function getMonthlyTimetable(latitude, longitude) {
  const date = new Date();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const response = await fetch(
    `${BASE_URL}/calendar/${year}/${month}?latitude=${latitude}&longitude=${longitude}&method=16&school=1`
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
    Dhuhr: '☀️',
    Asr: '🌤',
    Maghrib: '🌇',
    Isha: '🌙',
  };
  return emojis[prayer] || '🕌';
}