import { View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Switch, ActivityIndicator
} from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle
} from 'react-native-reanimated';
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
import { getPrayerNotifChoice, setPrayerNotifChoice, initPrayerNotifications, cancelPrayerNotifications } from '../services/prayerNotificationService';

const PRAYERS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const MECCA = { lat: 21.4225, lng: 39.8262 };
const ADHAN_STYLES = [
  { label: 'Makkah', url: require('../assets/audio/adhan_makkah.mp3') },
  { label: 'Madinah', url: require('../assets/audio/adhan_madinah.mp3') },
  { label: 'Al-Aqsa', url: require('../assets/audio/adhan_aqsa.mp3') },
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
  const [qiblaAngle, setQiblaAngle] = useState(null);
  const [compassHeading, setCompassHeading] = useState(0);
  const [sound, setSound] = useState(null);
  const [playingAdhan, setPlayingAdhan] = useState(false);
  const [showNotifPrompt, setShowNotifPrompt] = useState(false);
  const [notifsEnabled, setNotifsEnabled] = useState(true);
  const [compassExpanded, setCompassExpanded] = useState(false);

  const countdownRef = useRef(null);
  const magnetometerSub = useRef(null);
  const rafRef = useRef(null);

  const rotation = useSharedValue(0);

  const animatedCompassStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  useFocusEffect(
    useCallback(() => {
      const entry = SystemBars.pushStackEntry({ style: 'light' });
      startMagnetometer();
      const { DeviceEventEmitter } = require('react-native');
      DeviceEventEmitter.emit('pauseAllVideos');
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
    async function checkNotifChoice() {
      const choice = await getPrayerNotifChoice();
      if (!choice) {
        setTimeout(() => setShowNotifPrompt(true), 1000);
      } else if (choice === 'enabled' || choice === 'silent') {
        initPrayerNotifications(choice === 'enabled');
      }
    }
    checkNotifChoice();
  }, []);

  useEffect(() => {
    if (prayerData) {
      countdownRef.current = setInterval(() => {
        setNextPrayer(getNextPrayer(prayerData.timings));
      }, 60000);
    }
    return () => clearInterval(countdownRef.current);
  }, [prayerData]);

  async function loadSavedSettings() {
    try {
      const saved = await AsyncStorage.getItem('prayerNotifications');
      if (saved) setNotifications(JSON.parse(saved));
      const savedAdhan = await AsyncStorage.getItem('adhanStyle');
      if (savedAdhan !== null) setAdhanStyle(parseInt(savedAdhan));
      const savedAdhanEnabled = await AsyncStorage.getItem('adhanEnabled');
      if (savedAdhanEnabled !== null) setAdhanEnabled(savedAdhanEnabled === 'true');
      const savedNotifsEnabled = await AsyncStorage.getItem('notifsEnabled');
      if (savedNotifsEnabled !== null) setNotifsEnabled(savedNotifsEnabled === 'true');
    } catch (e) {}
  }

  async function loadPrayerData() {
    try {
      setError(null);
      const cached = await loadPrayerCache();
      if (cached) {
        setPrayerData(cached.data);
        setNextPrayer(getNextPrayer(cached.data.timings));
        setCoords(cached.coords);
        const qibla = calculateQibla(cached.coords.latitude, cached.coords.longitude);
        setQiblaAngle(qibla);
        setLoading(false);
      } else {
        setLoading(true);
      }
      const location = await getCoordinates();
      setCoords(location);
      const qibla = calculateQibla(location.latitude, location.longitude);
      setQiblaAngle(qibla);
      const data = await getPrayerTimes(location.latitude, location.longitude);
      setPrayerData(data);
      setNextPrayer(getNextPrayer(data.timings));
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
    Magnetometer.setUpdateInterval(16);
    let targetAngle = 0;
    let visualAngle = rotation.value;
    let initialized = false;
    let lastTarget = -1;
    let lastVisual = 0;
    let rejectCount = 0;
    
    magnetometerSub.current = Magnetometer.addListener(({ x, y }) => {
      let rawAngle = Math.atan2(y, x) * (180 / Math.PI) - 90;
      rawAngle = (rawAngle + 360) % 360;
      setCompassHeading(rawAngle);
      
      if (lastTarget === -1) { lastTarget = rawAngle; targetAngle = rawAngle; initialized = true; return; }
      const sensorDelta = rawAngle - lastTarget;
      const sensorShortest = sensorDelta > 180 ? sensorDelta - 360 : sensorDelta < -180 ? sensorDelta + 360 : sensorDelta;
      
      if (Math.abs(sensorShortest) > 90) {
        rejectCount++;
        if (rejectCount > 5) {
          lastTarget = rawAngle;
          targetAngle = rawAngle;
          initialized = true;
          rejectCount = 0;
        } else {
        }
        return;
      }
      rejectCount = 0;
      
      if (Math.abs(sensorShortest) > 45) {
      }
      
      lastTarget = rawAngle;
      targetAngle = rawAngle;
      initialized = true;
    });
    
    function smoothLoop() {
      if (!initialized) {
        rafRef.current = requestAnimationFrame(smoothLoop);
        return;
      }
      
      let delta = targetAngle - visualAngle;
      
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      
      const alpha = 0.08;
      visualAngle += delta * alpha;
      visualAngle = ((visualAngle % 360) + 360) % 360;
      
      const visualDelta = visualAngle - lastVisual;
      const visualShortest = visualDelta > 180 ? visualDelta - 360 : visualDelta < -180 ? visualDelta + 360 : visualDelta;
      if (Math.abs(visualShortest) > 5) {
      }
      
      lastVisual = visualAngle;
      rotation.value = -visualAngle;
      
      rafRef.current = requestAnimationFrame(smoothLoop);
    }
    rafRef.current = requestAnimationFrame(smoothLoop);
  }

  function stopMagnetometer() {
    if (magnetometerSub.current) {
      magnetometerSub.current.remove();
      magnetometerSub.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
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
        channelId: 'prayer-times',
        data: { type: 'prayer', prayer },
      },
      trigger: { type: 'daily', hour: hours, minute: minutes },
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
        ADHAN_STYLES[adhanStyle].url,
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

  const diff = qiblaAngle !== null ? ((qiblaAngle - compassHeading) % 360 + 360) % 360 : 0;
  const shortestDiff = diff > 180 ? 360 - diff : diff;
  const facingMakkah = qiblaAngle !== null && shortestDiff < 15;

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
      {showNotifPrompt && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9999,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <View style={{
            backgroundColor: '#1a2e44', borderRadius: 24, padding: 28,
            width: '85%', alignItems: 'center',
            borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)',
          }}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>🕌</Text>
            <Text style={{ fontSize: 20, fontWeight: '700', color: '#fff', marginBottom: 8, textAlign: 'center' }}>
              Prayer Time Reminders
            </Text>
            <Text style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', textAlign: 'center', lineHeight: 22, marginBottom: 24 }}>
              Would you like to receive daily prayer time notifications with Adhan sound?
            </Text>
            <TouchableOpacity
              style={{ backgroundColor: COLORS.gold, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, width: '100%', alignItems: 'center', marginBottom: 10 }}
              onPress={async () => {
                setShowNotifPrompt(false);
                await setPrayerNotifChoice('enabled');
                await initPrayerNotifications(true);
              }}
            >
              <Text style={{ color: '#1a2e44', fontWeight: '700', fontSize: 15 }}>🔔 Enable with Adhan</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, width: '100%', alignItems: 'center', marginBottom: 10 }}
              onPress={async () => {
                setShowNotifPrompt(false);
                await setPrayerNotifChoice('silent');
                await initPrayerNotifications(false);
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>🔕 Silent Notifications</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, width: '100%', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}
              onPress={async () => {
                setShowNotifPrompt(false);
                await setPrayerNotifChoice('skipped');
              }}
            >
              <Text style={{ color: '#ffffff', fontWeight: '600', fontSize: 15 }}>Not Now</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
        showsVerticalScrollIndicator={false}
      >
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

        <View style={styles.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#1a2e44' }}>🔔 Prayer Notifications</Text>
              <Text style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{notifsEnabled ? 'Enabled' : 'Disabled'}</Text>
            </View>
            <Switch
              value={notifsEnabled}
              onValueChange={async (val) => {
                setNotifsEnabled(val);
                await AsyncStorage.setItem('notifsEnabled', String(val));
                if (val) {
                  await initPrayerNotifications(adhanEnabled);
                } else {
                  await cancelPrayerNotifications();
                  await Notifications.cancelScheduledNotificationAsync('prayer-daily-summary');
                  await Notifications.dismissNotificationAsync('prayer-persistent');
                }
              }}
              trackColor={{ false: 'rgba(0,0,0,0.1)', true: COLORS.gold + '80' }}
              thumbColor={notifsEnabled ? COLORS.gold : 'rgba(0,0,0,0.3)'}
            />
          </View>
        </View>

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

        {compassExpanded && (
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => setCompassExpanded(false)}
            style={[styles.card, { alignItems: 'center' }]}
          >
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

            <Animated.View style={[
              {
                width: 220, height: 220, borderRadius: 110, borderWidth: 2,
                borderColor: 'rgba(201,168,76,0.3)', backgroundColor: '#f8f8f8',
                alignItems: 'center', justifyContent: 'center', position: 'relative', marginTop: 8
              },
              animatedCompassStyle
            ]}>
              {['N', 'E', 'S', 'W'].map((dir, i) => (
                <Text key={dir} style={[styles.compassDir, {
                  position: 'absolute',
                  top: i === 0 ? 4 : i === 2 ? null : '40%',
                  bottom: i === 2 ? 4 : null,
                  left: i === 3 ? 4 : i === 1 ? null : '44%',
                  right: i === 1 ? 4 : null,
                  color: i === 0 ? '#e74c3c' : '#1a2e44',
                }]}>{dir}</Text>
              ))}
              <View style={{ width: 4, height: 180, alignItems: 'center', position: 'absolute', transform: [{ rotate: `${qiblaAngle}deg` }] }}>
                <View style={{ width: 4, height: 90, backgroundColor: COLORS.gold, borderRadius: 2 }} />
                <View style={{ width: 4, height: 90, backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: 2 }} />
              </View>
              <View style={styles.compassCenter} />
              <Text style={{ position: 'absolute', top: 8, fontSize: 28 }}>🕋</Text>
            </Animated.View>

            <Text style={[{ fontSize: 13, fontWeight: '700', marginTop: 8, textAlign: 'center' }, { color: facingMakkah ? '#22c55e' : COLORS.gold }]}>
              {facingMakkah ? '🕋 Facing Makkah!' : '🕋 Heading to Makkah'}
            </Text>

            <Text style={{ fontSize: 10, color: '#aaa', marginTop: 4 }}>Tap to collapse</Text>
          </TouchableOpacity>
        )}

        {!compassExpanded && (
          <View style={styles.twoCol}>
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() => setCompassExpanded(true)}
              style={[styles.card, styles.halfCard]}
            >
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

              <Animated.View style={[styles.compassRing, animatedCompassStyle]}>
                {['N', 'E', 'S', 'W'].map((dir, i) => (
                  <Text key={dir} style={[styles.compassDir, {
                    position: 'absolute',
                    top: i === 0 ? 4 : i === 2 ? null : '40%',
                    bottom: i === 2 ? 4 : null,
                    left: i === 3 ? 4 : i === 1 ? null : '44%',
                    right: i === 1 ? 4 : null,
                    color: i === 0 ? '#e74c3c' : '#1a2e44',
                  }]}>{dir}</Text>
                ))}
                <View style={[styles.needle, { transform: [{ rotate: `${qiblaAngle}deg` }] }]}>
                  <View style={styles.needleTip} />
                  <View style={styles.needleBase} />
                </View>
                <View style={styles.compassCenter} />
                <Text style={{ position: 'absolute', top: 4, fontSize: 18 }}>🕋</Text>
              </Animated.View>

              <Text style={[{ fontSize: 13, fontWeight: '700', marginTop: 8, textAlign: 'center' }, { color: facingMakkah ? '#22c55e' : COLORS.gold }]}>
                {facingMakkah ? '🕋 Facing Makkah!' : '🕋 Heading to Makkah'}
              </Text>

              <Text style={{ fontSize: 10, color: '#aaa', marginTop: 4 }}>Tap to expand</Text>
            </TouchableOpacity>

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
        )}

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