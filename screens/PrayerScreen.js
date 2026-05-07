import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Switch, ActivityIndicator, Animated, Platform, Dimensions
} from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { SystemBars } from 'react-native-edge-to-edge';
import { Magnetometer } from 'expo-sensors';
import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS } from '../constants/theme';
import {
  getCoordinates, getPrayerTimes, getMonthlyTimetable,
  getNextPrayer, formatTime, getPrayerEmoji,
  savePrayerCache, loadPrayerCache,
} from '../services/prayerApi';

const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const MECCA = { lat: 21.3891, lng: 39.8579 };
const ADHAN_STYLES = [
  { label: 'Makkah', url: 'https://www.islamicfinder.org/prayer-times/adhan/makkah.mp3' },
  { label: 'Madinah', url: 'https://www.islamicfinder.org/prayer-times/adhan/madinah.mp3' },
  { label: 'Al-Aqsa', url: 'https://www.islamicfinder.org/prayer-times/adhan/aqsa.mp3' },
];

function calculateQibla(lat, lng) {
  const φ1 = (lat * Math.PI) / 180;
  const φ2 = (MECCA.lat * Math.PI) / 180;
  const Δλ = ((MECCA.lng - lng) * Math.PI) / 180;
  const θ = Math.atan2(
    Math.sin(Δλ) * Math.cos(φ2),
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  );
  return ((θ * 180) / Math.PI + 360) % 360;
}

function getCardinalDirection(degrees) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(degrees / 45) % 8];
}

export default function PrayerScreen() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [coords, setCoords] = useState(null);
  const [prayerData, setPrayerData] = useState(null);
  const [nextPrayer, setNextPrayer] = useState(null);
  const [monthlyData, setMonthlyData] = useState(null);
  const [showMonthly, setShowMonthly] = useState(false);
  const [notifications, setNotifications] = useState({});
  const [adhanStyle, setAdhanStyle] = useState(0);
  const [adhanEnabled, setAdhanEnabled] = useState(true);
  const [compassHeading, setCompassHeading] = useState(0);
  const [qiblaAngle, setQiblaAngle] = useState(null);
  const [sound, setSound] = useState(null);
  const [playingAdhan, setPlayingAdhan] = useState(false);
  const countdownRef = useRef(null);
  const needleAnim = useRef(new Animated.Value(0)).current;
  const magnetometerSub = useRef(null);

  useFocusEffect(
    useCallback(() => {
        const entry = SystemBars.pushStackEntry({ style: 'light' });
        startMagnetometer();
        return () => {
        SystemBars.popStackEntry(entry);
        stopMagnetometer();
        };
    }, [])
    );

  useEffect(() => {
    loadSavedSettings();
    loadPrayerData();
    return () => {
      stopMagnetometer();
      clearInterval(countdownRef.current);
      if (sound) sound.unloadAsync();
    };
  }, []);

  useEffect(() => {
    if (prayerData) {
      countdownRef.current = setInterval(() => {
        setNextPrayer(getNextPrayer(prayerData.timings));
      }, 60000);
    }
    return () => clearInterval(countdownRef.current);
  }, [prayerData]);

  useEffect(() => {
    if (qiblaAngle !== null) {
      const needleRotation = qiblaAngle - compassHeading;
      Animated.spring(needleAnim, {
        toValue: needleRotation,
        useNativeDriver: true,
        friction: 6,
      }).start();
    }
  }, [compassHeading, qiblaAngle]);

  async function loadSavedSettings() {
    try {
      const saved = await AsyncStorage.getItem('prayerNotifications');
      if (saved) setNotifications(JSON.parse(saved));
      const savedAdhan = await AsyncStorage.getItem('adhanStyle');
      if (savedAdhan !== null) setAdhanStyle(parseInt(savedAdhan));
      const savedAdhanEnabled = await AsyncStorage.getItem('adhanEnabled');
      if (savedAdhanEnabled !== null) setAdhanEnabled(savedAdhanEnabled === 'true');
    } catch (e) {}
  }

  async function loadPrayerData() {
    try {
      setError(null);

      // Load from cache instantly first
      const cached = await loadPrayerCache();
      if (cached) {
        setPrayerData(cached.data);
        setNextPrayer(getNextPrayer(cached.data.timings));
        setCoords(cached.coords);
        setQiblaAngle(calculateQibla(cached.coords.latitude, cached.coords.longitude));
        setLoading(false);
      } else {
        setLoading(true);
      }

      // Fetch fresh data in background
      const location = await getCoordinates();
      setCoords(location);
      const qibla = calculateQibla(location.latitude, location.longitude);
      setQiblaAngle(qibla);
      const data = await getPrayerTimes(location.latitude, location.longitude);
      setPrayerData(data);
      setNextPrayer(getNextPrayer(data.timings));

      // Save fresh data to cache
      await savePrayerCache(data, location);
    } catch (e) {
      if (!prayerData) setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadMonthly() {
    if (monthlyData) { setShowMonthly(true); return; }
    try {
      const data = await getMonthlyTimetable(coords.latitude, coords.longitude);
      setMonthlyData(data);
      setShowMonthly(true);
    } catch (e) {}
  }

  function startMagnetometer() {
    Magnetometer.setUpdateInterval(300);
    magnetometerSub.current = Magnetometer.addListener(({ x, y }) => {
      let angle = Math.atan2(y, x) * (180 / Math.PI);
      angle = (angle + 360) % 360;
      setCompassHeading(angle);
    });
  }

  function stopMagnetometer() {
    if (magnetometerSub.current) {
      magnetometerSub.current.remove();
      magnetometerSub.current = null;
    }
  }

  async function toggleNotification(prayer) {
    const updated = { ...notifications, [prayer]: !notifications[prayer] };
    setNotifications(updated);
    await AsyncStorage.setItem('prayerNotifications', JSON.stringify(updated));
    if (updated[prayer] && prayerData) {
      await schedulePrayerNotification(prayer, prayerData.timings[prayer]);
    } else {
      await Notifications.cancelScheduledNotificationAsync(`prayer-${prayer}`);
    }
  }

  async function schedulePrayerNotification(prayer, time24) {
    const [hours, minutes] = time24.split(':').map(Number);
    await Notifications.scheduleNotificationAsync({
      identifier: `prayer-${prayer}`,
      content: {
        title: `🕌 ${prayer} Prayer Time`,
        body: `It's time for ${prayer} prayer. Allahu Akbar!`,
        sound: true,
      },
      trigger: { hour: hours, minute: minutes, repeats: true },
    });
  }

  async function playAdhan() {
    try {
      if (playingAdhan) {
        await sound?.stopAsync();
        setPlayingAdhan(false);
        return;
      }
      if (sound) await sound.unloadAsync();
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: ADHAN_STYLES[adhanStyle].url },
        { shouldPlay: true }
      );
      setSound(newSound);
      setPlayingAdhan(true);
      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) setPlayingAdhan(false);
      });
    } catch (e) {
      setPlayingAdhan(false);
    }
  }

  async function selectAdhan(index) {
    setAdhanStyle(index);
    await AsyncStorage.setItem('adhanStyle', String(index));
  }

  async function toggleAdhan(val) {
    setAdhanEnabled(val);
    await AsyncStorage.setItem('adhanEnabled', String(val));
  }

  const needleRotation = needleAnim.interpolate({
    inputRange: [-360, 360],
    outputRange: ['-360deg', '360deg'],
  });

  if (loading) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={COLORS.gold} size="large" />
        <Text style={styles.loadingText}>Getting prayer times...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.errorIcon}>⚠️</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={loadPrayerData}>
          <Text style={styles.retryText}>Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const hijriDate = prayerData?.date?.hijri;
  const gregorianDate = prayerData?.date?.readable;

  return (
    <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
          <Text style={styles.headerSub}>BISMILLAH</Text>
          <Text style={styles.screenTitle}>Prayer Times</Text>
          <View style={styles.headerRow}>
            <View style={styles.hijriPill}>
              <Text style={styles.hijriText}>
                {hijriDate?.day} {hijriDate?.month?.en} {hijriDate?.year} AH
              </Text>
            </View>
            <Text style={styles.locationText}>
              📍 {prayerData?.meta?.timezone?.split('/')[1]?.replace('_', ' ') ?? 'Your Location'}
            </Text>
          </View>
        </View>

        {/* Next Prayer Hero */}
        {nextPrayer && (
          <View style={styles.heroCard}>
            <Text style={styles.heroLabel}>NEXT PRAYER</Text>
            <View style={styles.heroRow}>
              <View>
                <Text style={styles.heroName}>
                  {getPrayerEmoji(nextPrayer.name)} {nextPrayer.name}
                </Text>
                <Text style={styles.heroTime}>{nextPrayer.time}</Text>
              </View>
              <View style={styles.countdownBadge}>
                <Text style={styles.countdownLabel}>in</Text>
                <Text style={styles.countdownValue}>{nextPrayer.countdown}</Text>
              </View>
            </View>
          </View>
        )}

        {/* Prayer Times List */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>TODAY'S PRAYERS</Text>
          {PRAYERS.map((prayer) => {
            const isNext = nextPrayer?.name === prayer;
            const isPast = !isNext && (() => {
              if (!prayerData?.timings) return false;
              const [h, m] = prayerData.timings[prayer].split(':').map(Number);
              const now = new Date();
              return h * 60 + m < now.getHours() * 60 + now.getMinutes();
            })();
            return (
              <View
                key={prayer}
                style={[
                  styles.prayerRow,
                  isNext && styles.prayerRowActive,
                  isPast && styles.prayerRowPast,
                ]}
              >
                <Text style={styles.prayerEmoji}>{getPrayerEmoji(prayer)}</Text>
                <Text style={[styles.prayerName, isNext && styles.prayerNameActive]}>
                  {prayer}
                </Text>
                <Text style={[styles.prayerTime, isNext && styles.prayerTimeActive]}>
                  {formatTime(prayerData?.timings?.[prayer] ?? '00:00')}
                </Text>
                <Switch
                  value={!!notifications[prayer]}
                  onValueChange={() => toggleNotification(prayer)}
                  trackColor={{ false: 'rgba(0,0,0,0.1)', true: COLORS.gold + '80' }}
                  thumbColor={notifications[prayer] ? COLORS.gold : 'rgba(0,0,0,0.3)'}
                  style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                />
              </View>
            );
          })}
        </View>

        {/* Qibla + Adhan */}
        <View style={styles.twoCol}>
          {/* Qibla */}
          <View style={[styles.card, styles.halfCard]}>
            <View style={styles.iconRing}>
              <Text style={{ fontSize: 22 }}>🧭</Text>
            </View>
            <Text style={styles.cardTitle}>Qibla</Text>
            <Text style={styles.cardValue}>
              {qiblaAngle !== null ? `${Math.round(qiblaAngle)}°` : '--'}
            </Text>
            <Text style={styles.cardSub}>
              {qiblaAngle !== null ? `${getCardinalDirection(qiblaAngle)} toward Mecca` : ''}
            </Text>
            <View style={styles.compassRing}>
              {['N', 'E', 'S', 'W'].map((dir, i) => (
                <Text
                  key={dir}
                  style={[styles.compassDir, {
                    position: 'absolute',
                    top: i === 0 ? 4 : i === 2 ? null : '40%',
                    bottom: i === 2 ? 4 : null,
                    left: i === 3 ? 4 : i === 1 ? null : '44%',
                    right: i === 1 ? 4 : null,
                    color: i === 0 ? '#e74c3c' : '#1a2e44',
                  }]}
                >
                  {dir}
                </Text>
              ))}
              <Animated.View style={[styles.needle, { transform: [{ rotate: needleRotation }] }]}>
                <View style={styles.needleTip} />
                <View style={styles.needleBase} />
              </Animated.View>
              <View style={styles.compassCenter} />
            </View>
          </View>

          {/* Adhan */}
          <View style={[styles.card, styles.halfCard]}>
            <View style={styles.iconRing}>
              <Text style={{ fontSize: 22 }}>🔊</Text>
            </View>
            <Text style={styles.cardTitle}>Adhan</Text>
            <Switch
              value={adhanEnabled}
              onValueChange={toggleAdhan}
              trackColor={{ false: 'rgba(0,0,0,0.1)', true: COLORS.gold + '80' }}
              thumbColor={adhanEnabled ? COLORS.gold : 'rgba(0,0,0,0.3)'}
              style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
            />
            <View style={styles.adhanStyles}>
              {ADHAN_STYLES.map((s, i) => (
                <TouchableOpacity
                  key={s.label}
                  style={[styles.adhanChip, adhanStyle === i && styles.adhanChipActive]}
                  onPress={() => selectAdhan(i)}
                >
                  <Text style={[styles.adhanChipText, adhanStyle === i && styles.adhanChipTextActive]}>
                    {s.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.playBtn} onPress={playAdhan}>
              <Text style={styles.playBtnText}>
                {playingAdhan ? '⏹ Stop' : '▶️ Preview'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Monthly Timetable */}
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.monthlyBtn}
            onPress={showMonthly ? () => setShowMonthly(false) : loadMonthly}
          >
            <View>
              <Text style={styles.monthlyTitle}>📆 Monthly Timetable</Text>
              <Text style={styles.monthlySub}>{gregorianDate?.split(' ').slice(1).join(' ')}</Text>
            </View>
            <View style={styles.viewBadge}>
              <Text style={styles.viewBadgeText}>{showMonthly ? 'Hide' : 'View'}</Text>
            </View>
          </TouchableOpacity>

          {showMonthly && monthlyData && (
            <View style={styles.timetable}>
              <View style={styles.timetableHeader}>
                <Text style={[styles.timetableCell, styles.timetableHead]}>Date</Text>
                {PRAYERS.map(p => (
                  <Text key={p} style={[styles.timetableCell, styles.timetableHead]}>{p.slice(0, 3)}</Text>
                ))}
              </View>
              {monthlyData.map((day) => {
                const isToday = day.date.gregorian.day === String(new Date().getDate()).padStart(2, '0');
                return (
                  <View key={day.date.gregorian.date} style={[styles.timetableRow, isToday && styles.timetableRowToday]}>
                    <Text style={[styles.timetableCell, isToday && styles.timetableCellToday]}>
                      {parseInt(day.date.gregorian.day)}
                    </Text>
                    {PRAYERS.map(p => (
                      <Text key={p} style={[styles.timetableCell, styles.timetableTime, isToday && styles.timetableCellToday]}>
                        {day.timings[p].split(' ')[0].slice(0, 5)}
                      </Text>
                    ))}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: '#666', fontSize: 14, marginTop: 8 },
  errorIcon: { fontSize: 40 },
  errorText: { color: '#dc2626', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  retryBtn: { backgroundColor: COLORS.gold, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 10, marginTop: 12 },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  header: { backgroundColor: '#1a2e44', borderBottomLeftRadius: 24, borderBottomRightRadius: 24, padding: 16, paddingBottom: 16, marginBottom: 12 },
  headerSub: { fontSize: 11, color: 'rgba(255,255,255,0.6)', letterSpacing: 1.5, marginBottom: 4 },
  screenTitle: { fontSize: 24, fontWeight: '700', color: '#ffffff', marginBottom: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hijriPill: { backgroundColor: 'rgba(201,168,76,0.25)', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5 },
  hijriText: { color: '#f0c96a', fontSize: 11, fontWeight: '700' },
  locationText: { color: 'rgba(255,255,255,0.6)', fontSize: 11 },

  heroCard: { backgroundColor: '#1a2e44', borderRadius: 16, padding: 18, marginHorizontal: 12, marginBottom: 10 },
  heroLabel: { color: '#f0c96a', fontSize: 9, letterSpacing: 2, fontWeight: '700', marginBottom: 10 },
  heroRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heroName: { fontSize: 30, fontWeight: '700', color: '#ffffff' },
  heroTime: { fontSize: 14, color: 'rgba(255,255,255,0.65)', marginTop: 4 },
  countdownBadge: { backgroundColor: 'rgba(201,168,76,0.2)', borderRadius: 14, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(201,168,76,0.4)' },
  countdownLabel: { color: '#f0c96a', fontSize: 10, fontWeight: '700' },
  countdownValue: { color: '#f0c96a', fontSize: 20, fontWeight: '700' },

  card: { backgroundColor: '#ffffff', borderRadius: 16, padding: 14, marginHorizontal: 12, marginBottom: 10, borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.08)' },
  twoCol: { flexDirection: 'row', gap: 10, marginHorizontal: 12, marginBottom: 10 },
  halfCard: { flex: 1, marginHorizontal: 0, alignItems: 'center' },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: '#888', letterSpacing: 0.8, marginBottom: 10 },

  prayerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 10, borderRadius: 10, marginBottom: 2 },
  prayerRowActive: { backgroundColor: 'rgba(201,168,76,0.12)', borderWidth: 1, borderColor: 'rgba(201,168,76,0.25)' },
  prayerRowPast: { opacity: 0.45 },
  prayerEmoji: { fontSize: 18, width: 28 },
  prayerName: { flex: 1, color: '#1a2e44', fontSize: 15, fontWeight: '600' },
  prayerNameActive: { color: '#b8860b' },
  prayerTime: { color: '#555', fontSize: 14, fontWeight: '500', marginRight: 8 },
  prayerTimeActive: { color: '#b8860b', fontWeight: '700' },

  iconRing: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: 'rgba(201,168,76,0.4)', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#1a2e44', marginBottom: 4 },
  cardValue: { fontSize: 22, fontWeight: '700', color: '#b8860b' },
  cardSub: { fontSize: 11, color: '#666', textAlign: 'center', marginBottom: 8 },

  compassRing: { width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: 'rgba(201,168,76,0.3)', backgroundColor: '#f8f8f8', alignItems: 'center', justifyContent: 'center', position: 'relative', marginTop: 8 },
  compassDir: { fontSize: 11, fontWeight: '700' },
  needle: { width: 4, height: 90, alignItems: 'center', position: 'absolute' },
  needleTip: { width: 4, height: 45, backgroundColor: COLORS.gold, borderRadius: 2 },
  needleBase: { width: 4, height: 45, backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: 2 },
  compassCenter: { width: 10, height: 10, borderRadius: 5, backgroundColor: COLORS.gold, position: 'absolute' },

  adhanStyles: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: 'center', marginVertical: 8 },
  adhanChip: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  adhanChipActive: { backgroundColor: 'rgba(201,168,76,0.15)', borderColor: COLORS.gold },
  adhanChipText: { color: '#555', fontSize: 12, fontWeight: '600' },
  adhanChipTextActive: { color: '#b8860b', fontWeight: '700' },
  playBtn: { backgroundColor: 'rgba(201,168,76,0.1)', borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16, marginTop: 4 },
  playBtnText: { color: '#b8860b', fontSize: 13, fontWeight: '700' },

  monthlyBtn: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  monthlyTitle: { fontSize: 15, fontWeight: '700', color: '#1a2e44' },
  monthlySub: { fontSize: 12, color: '#666', fontWeight: '500', marginTop: 2 },
  viewBadge: { backgroundColor: 'rgba(201,168,76,0.12)', borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
  viewBadgeText: { color: '#b8860b', fontSize: 12, fontWeight: '700' },

  timetable: { marginTop: 14 },
  timetableHeader: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.08)' },
  timetableRow: { flexDirection: 'row', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.04)' },
  timetableRowToday: { backgroundColor: 'rgba(201,168,76,0.08)', borderRadius: 6 },
  timetableCell: { flex: 1, color: '#555', fontSize: 11, textAlign: 'center', fontWeight: '500' },
  timetableHead: { color: '#b8860b', fontWeight: '700', fontSize: 11 },
  timetableTime: { fontSize: 10 },
  timetableCellToday: { color: '#b8860b', fontWeight: '700' },
});