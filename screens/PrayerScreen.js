import { View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Switch, ActivityIndicator, Vibration, TextInput, Linking, Platform, AppState
} from 'react-native';
import { useState, useEffect, useRef, useCallback, memo } from 'react';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { SystemBars } from 'react-native-edge-to-edge';
import { Magnetometer } from 'expo-sensors';
import * as Location from 'expo-location';
import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as IntentLauncher from 'expo-intent-launcher';
import { COLORS } from '../constants/theme';
import { isLowEndDevice } from '../utils/deviceInfo';
import {
  getCoordinates, getPrayerTimes, getMonthlyTimetable,
  getNextPrayer, formatTime, getPrayerEmoji,
  savePrayerCache, loadPrayerCache, searchCity, reverseGeocode,
  saveCoordinatesPermanently, loadSavedCoordinates,
  saveMonthlyCache,
} from '../services/prayerApi';
import { getPrayerNotifChoice, setPrayerNotifChoice, initPrayerNotifications, cancelPrayerNotifications, schedulePrayerNotifications, getNextOccurrence, requestExactAlarmPermission, updatePersistentNotification } from '../services/prayerNotificationService';

const PRAYERS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const MECCA = { lat: 21.4225, lng: 39.8262 };
const ADHAN_STYLES = [
  { label: 'Makkah', url: require('../assets/audio/adhan_makkah.mp3') },
  { label: 'Madinah', url: require('../assets/audio/adhan_madinah.mp3') },
  { label: 'Al-Aqsa', url: require('../assets/audio/adhan_aqsa.mp3') },
];

function calculateQibla(lat, lng) {
  const phi1 = (lat * Math.PI) / 180;
  const phi2 = (MECCA.lat * Math.PI) / 180;
  const dl   = ((MECCA.lng - lng) * Math.PI) / 180;
  const th   = Math.atan2(
    Math.sin(dl) * Math.cos(phi2),
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl)
  );
  return ((th * 180) / Math.PI + 360) % 360;
}

function getCardinalDirection(degrees) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(degrees / 45) % 8];
}

function renderCompassTicks(size) {
  const center = size / 2;
  const outerR = size / 2 - 7;
  const ticks  = [];
  for (let i = 0; i < 72; i++) {
    const angle   = i * 5;
    const rad     = (angle * Math.PI) / 180;
    const isMajor = i % 18 === 0;
    const isMid   = i % 6  === 0;
    const tickH   = isMajor ? 13 : isMid ? 9 : 5;
    const tickW   = isMajor ? 2.5 : isMid ? 1.5 : 1;
    const dist    = outerR - tickH / 2;
    const x = center + dist * Math.sin(rad) - tickW / 2;
    const y = center - dist * Math.cos(rad) - tickH / 2;
    ticks.push(
      <View key={i} style={{
        position: 'absolute', left: x, top: y,
        width: tickW, height: tickH,
        backgroundColor: isMajor
          ? '#f0c96a'
          : isMid ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.15)',
        borderRadius: tickW / 2,
        transform: [{ rotate: `${angle}deg` }],
      }} />
    );
  }
  return ticks;
}

// Pre-computed once at module load — avoids regenerating 72 Views on every re-render
const COMPASS_TICKS_118 = renderCompassTicks(118);
const COMPASS_TICKS_234 = renderCompassTicks(234);

function NeedleSmall() {
  return (
    <View style={styles.needleFixedSmall} pointerEvents="none">
      <View style={{
        width: 0, height: 0,
        borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 14,
        borderLeftColor: 'transparent', borderRightColor: 'transparent',
        borderBottomColor: '#ffe082',
      }} />
      <View style={{
        width: 5, height: 22, backgroundColor: '#f0c96a', marginTop: -1,
        shadowColor: '#f0c96a', shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.9, shadowRadius: 5,
      }} />
      <View style={{
        width: 14, height: 14, borderRadius: 7,
        backgroundColor: '#0d1b2a', borderWidth: 2.5, borderColor: '#f0c96a', zIndex: 10,
      }} />
      <View style={{ width: 5, height: 22, backgroundColor: '#e74c3c', marginBottom: -1 }} />
      <View style={{
        width: 0, height: 0,
        borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 12,
        borderLeftColor: 'transparent', borderRightColor: 'transparent',
        borderTopColor: '#c0392b',
      }} />
    </View>
  );
}

function NeedleLarge() {
  return (
    <View style={styles.needleFixedLarge} pointerEvents="none">
      <View style={{
        width: 0, height: 0,
        borderLeftWidth: 9, borderRightWidth: 9, borderBottomWidth: 22,
        borderLeftColor: 'transparent', borderRightColor: 'transparent',
        borderBottomColor: '#ffe082',
      }} />
      <View style={{
        width: 7, height: 48, backgroundColor: '#f0c96a', marginTop: -1,
        shadowColor: '#f0c96a', shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.9, shadowRadius: 8,
      }} />
      <View style={{
        width: 22, height: 22, borderRadius: 11,
        backgroundColor: '#0d1b2a', borderWidth: 3, borderColor: '#f0c96a', zIndex: 10,
      }} />
      <View style={{ width: 7, height: 48, backgroundColor: '#e74c3c', marginBottom: -1 }} />
      <View style={{
        width: 0, height: 0,
        borderLeftWidth: 9, borderRightWidth: 9, borderTopWidth: 18,
        borderLeftColor: 'transparent', borderRightColor: 'transparent',
        borderTopColor: '#c0392b',
      }} />
    </View>
  );
}

const HUAWEI_STEP_DATA = [
  {
    key: 'launchManager',
    title: '1. Launch Manager',
    instructions: [
      'Tap "Open Settings" below.',
      'Go to Apps & services → Launch manager.',
      'Find Bushrann and turn OFF "Manage automatically".',
      'Make sure all 3 toggles underneath are ON.',
    ],
  },
  {
    key: 'exactAlarm',
    title: '2. Exact Alarms',
    instructions: [
      'Tap "Open Settings" below.',
      'You\'ll land on "Alarms & reminders" — find and tap Bushrann.',
      'Turn ON "Set alarms and reminders".',
    ],
  },
  {
    key: 'batteryOpt',
    title: '3. Battery Optimization',
    instructions: [
      'Tap "Open Settings" below, then tap "Allow" (or "Disable") in the dialog. That\'s it!',
    ],
  },
];

const HuaweiStepRow = memo(function HuaweiStepRow({ stepKey, title, instructions, checked, onToggle, onOpen }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
        {stepKey === 'launchManager' ? (
          <TouchableOpacity
            onPress={onToggle}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{
              width: 22, height: 22, borderRadius: 6, marginRight: 8,
              borderWidth: 2, borderColor: checked ? '#1a7a3c' : 'rgba(0,0,0,0.25)',
              backgroundColor: checked ? '#1a7a3c' : 'transparent',
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            {checked && <Text style={{ color: '#fff', fontSize: 13, fontWeight: '900' }}>✓</Text>}
          </TouchableOpacity>
        ) : (
          <Text style={{ fontSize: 13, fontWeight: '600', color: checked ? '#4CAF50' : '#999', marginRight: 8 }}>
            {checked ? '✅ Verified' : '⏳ Pending'}
          </Text>
        )}
        <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a2e44', flex: 1 }}>{title}</Text>
      </View>
      <View style={{ marginLeft: 30, marginBottom: 10 }}>
        {instructions.map((line, i) => (
          <Text key={i} style={{ fontSize: 12, color: '#555', lineHeight: 19 }}>{i + 1}. {line}</Text>
        ))}
      </View>
      <TouchableOpacity
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        style={{
          marginLeft: 30, alignSelf: 'flex-start',
          paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10,
          backgroundColor: 'rgba(201,168,76,0.12)', borderWidth: 1, borderColor: 'rgba(201,168,76,0.35)',
        }}
        onPress={onOpen}
      >
        <Text style={{ color: '#b8860b', fontSize: 12, fontWeight: '700' }}>⚙️ Open Settings</Text>
      </TouchableOpacity>
    </View>
  );
});

const HuaweiSetupCard = memo(function HuaweiSetupCard({
  huaweiSteps, huaweiTipExpanded, onToggleExpanded, onToggleStep,
  onOpenLaunchManager, onOpenExactAlarm, onOpenBatteryOpt, onOpenNotifImportance,
}) {
  const allDone = huaweiSteps.launchManager && huaweiSteps.exactAlarm && huaweiSteps.batteryOpt;
  const doneCount = [huaweiSteps.launchManager, huaweiSteps.exactAlarm, huaweiSteps.batteryOpt].filter(Boolean).length;
  const openFns = { launchManager: onOpenLaunchManager, exactAlarm: onOpenExactAlarm, batteryOpt: onOpenBatteryOpt };

  return (
    <TouchableOpacity
      style={[styles.card, { borderColor: allDone ? 'rgba(201,168,76,0.2)' : 'rgba(201,168,76,0.4)', borderWidth: 1, backgroundColor: allDone ? '#fff' : 'rgba(201,168,76,0.05)' }]}
      onPress={onToggleExpanded}
      activeOpacity={0.9}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: '#1a2e44' }}>
        📱 Huawei Adhan Setup {allDone ? '✓' : `(${doneCount}/3)`}
        </Text>
        <Text style={{ color: COLORS.gold, fontSize: 13, fontWeight: '700' }}>{huaweiTipExpanded ? '▴' : '▾'}</Text>
      </View>
      {huaweiTipExpanded && (
        <View style={{ marginTop: 14 }}>
          <Text style={{ fontSize: 12, color: '#666', lineHeight: 18, marginBottom: 16 }}>
            Huawei/Honor phones need these 3 settings for Adhan to play on time. Check off each step after completing it.
          </Text>
          {HUAWEI_STEP_DATA.map((step) => (
            <HuaweiStepRow
              key={step.key}
              stepKey={step.key}
              title={step.title}
              instructions={step.instructions}
              checked={!!huaweiSteps[step.key]}
              onToggle={() => onToggleStep(step.key)}
              onOpen={(e) => { e.stopPropagation?.(); openFns[step.key](); }}
            />
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
});

export default function PrayerScreen() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading]                   = useState(true);
  const [error, setError]                       = useState(null);
  const [coords, setCoords]                     = useState(null);
  const [prayerData, setPrayerData]             = useState(null);
  const [nextPrayer, setNextPrayer]             = useState(null);
  const [monthlyData, setMonthlyData]           = useState(null);
  const [showMonthly, setShowMonthly]           = useState(false);
  const [notifications, setNotifications]       = useState({});
  const [adhanStyle, setAdhanStyle]             = useState(0);
  const [adhanEnabled, setAdhanEnabled]         = useState(true);
  const [qiblaAngle, setQiblaAngle]             = useState(null);
  const [compassHeading, setCompassHeading]     = useState(0);
  const [sound, setSound]                       = useState(null);
  const [playingAdhan, setPlayingAdhan]         = useState(false);
  const [showNotifPrompt, setShowNotifPrompt]   = useState(false);
  const [notifsEnabled, setNotifsEnabled]       = useState(true);
  const [compassExpanded, setCompassExpanded]   = useState(false);
  const [hijriAdjustment, setHijriAdjustment]   = useState(0);
  const [isOffline, setIsOffline] = useState(false);
  const [exactAlarmGranted, setExactAlarmGranted] = useState(true);

  // Location mode
  const [locationMode, setLocationMode]             = useState(null);
  const [manualCity, setManualCity]                 = useState(null);
  const [showLocationChoice, setShowLocationChoice] = useState(false);
  const [showChangeLocationModal, setShowChangeLocationModal] = useState(false);
  const [showCitySearch, setShowCitySearch]         = useState(false);
  const [citySearch, setCitySearch]                 = useState('');
  const [cityResults, setCityResults]               = useState([]);
  const [citySearchLoading, setCitySearchLoading]   = useState(false);
  const [updatingLocation, setUpdatingLocation]     = useState(false);
  const [locationUpdateMsg, setLocationUpdateMsg]   = useState(null);
  const [gpsCityName, setGpsCityName]               = useState(null);

  // Huawei/Honor setup — 3 steps: launchManager, exactAlarm, batteryOpt
  const [isHuawei, setIsHuawei]                     = useState(false);
  const [huaweiSteps, setHuaweiSteps]               = useState({ launchManager: false, exactAlarm: false, batteryOpt: false });
  const [huaweiTipExpanded, setHuaweiTipExpanded]   = useState(true);
  const [huaweiUndoBanner, setHuaweiUndoBanner]     = useState(false);
  const huaweiUndoTimerRef                           = useRef(null);

  const countdownRef        = useRef(null);
  const magnetometerSub     = useRef(null);
  const rafRef              = useRef(null);
  const prevFacingMakkahRef = useRef(false);
  const lastVibrationRef    = useRef(0);

  const rotation    = useSharedValue(0);
  const pulseScale  = useSharedValue(1);
  const glowOpacity = useSharedValue(0);

  const animatedCompassStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  const pulseRingStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: glowOpacity.value,
  }));

  const diff         = qiblaAngle !== null ? ((qiblaAngle - compassHeading) % 360 + 360) % 360 : 0;
  const shortestDiff = diff > 180 ? 360 - diff : diff;
  const facingMakkah = qiblaAngle !== null && shortestDiff < 15;

  useEffect(() => {
    if (facingMakkah && !prevFacingMakkahRef.current) {
      const now = Date.now();
      if (now - lastVibrationRef.current > 2000) {
        Vibration.vibrate([0, 80, 60, 120]);
        lastVibrationRef.current = now;
      }
    }
    prevFacingMakkahRef.current = facingMakkah;
  }, [facingMakkah]);

  useEffect(() => {
    if (facingMakkah) {
      glowOpacity.value = withTiming(1, { duration: 300 });
      if (!isLowEndDevice) {
        pulseScale.value  = withRepeat(
          withSequence(withTiming(1.08, { duration: 700 }), withTiming(1.0, { duration: 700 })),
          -1, false
        );
      }
    } else {
      glowOpacity.value = withTiming(0, { duration: 400 });
      pulseScale.value  = withTiming(1, { duration: 300 });
    }
    return () => {
      cancelAnimation(pulseScale);
      cancelAnimation(glowOpacity);
    };
  }, [facingMakkah]);

  // Auto-dismiss location update banner after 5 seconds
  useEffect(() => {
    if (locationUpdateMsg) {
      const timer = setTimeout(() => setLocationUpdateMsg(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [locationUpdateMsg]);

  // Huawei/Honor detection
  useEffect(() => {
    async function checkHuaweiTip() {
      try {
        const manufacturer = Platform.OS === 'android'
          ? ((Platform.constants && (Platform.constants.Manufacturer || Platform.constants.Brand)) || '').toLowerCase()
          : '';
        if (!manufacturer.includes('huawei') && !manufacturer.includes('honor')) return;
        setIsHuawei(true);
        const saved = await AsyncStorage.getItem('huaweiSteps');
        if (saved) {
          const parsed = JSON.parse(saved);
          setHuaweiSteps({ launchManager: !!parsed.launchManager, exactAlarm: !!parsed.exactAlarm, batteryOpt: !!parsed.batteryOpt });
          const allDone = parsed.launchManager && parsed.exactAlarm && parsed.batteryOpt;
          setHuaweiTipExpanded(!allDone);
        }
      } catch (e) {}
    }
    checkHuaweiTip();
  }, []);

  const verifyHuaweiSteps = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    try {
      const { NativeModules } = require('react-native');
      const AdhanModule = NativeModules.AdhanModule;
      if (!AdhanModule) return;
      const [exactAlarms, batteryOpt] = await Promise.all([
        AdhanModule.canScheduleExactAlarms ? AdhanModule.canScheduleExactAlarms() : Promise.resolve(true),
        AdhanModule.isBatteryOptIgnored ? AdhanModule.isBatteryOptIgnored() : Promise.resolve(false),
      ]);
      setHuaweiSteps((prev) => {
        const updated = {
          ...prev,
          exactAlarm: exactAlarms,
          batteryOpt: batteryOpt,
        };
        AsyncStorage.setItem('huaweiSteps', JSON.stringify(updated));
        return updated;
      });
    } catch (e) {}
  }, []);

  useEffect(() => {
    verifyHuaweiSteps();
    // Delay permission check so it doesn't block initial render
    const timer = setTimeout(() => checkExactAlarmPermission(), 500);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        verifyHuaweiSteps();
        checkExactAlarmPermission();
      }
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [verifyHuaweiSteps]);

  // (Removed — Huawei setup now uses manual per-step checkboxes instead of AppState detection)

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
    
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOffline(!state.isConnected);
    });
    
    return () => {
      stopMagnetometer();
      clearInterval(countdownRef.current);
      if (sound) sound.unloadAsync();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    async function checkNotifChoice() {
      const choice = await getPrayerNotifChoice();
      if (!choice) {
        setTimeout(() => setShowNotifPrompt(true), 1000);
      } else if (choice === 'enabled' || choice === 'silent') {
        // Delay notification init so it doesn't block render
        setTimeout(() => {
          initPrayerNotifications(choice === 'enabled');
        }, 2000);
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
      const [
        saved,
        savedAdhan,
        savedAdhanEnabled,
        savedNotifsEnabled,
        savedHijriAdj,
      ] = await Promise.all([
        AsyncStorage.getItem('prayerNotifications'),
        AsyncStorage.getItem('adhanStyle'),
        AsyncStorage.getItem('adhanEnabled'),
        AsyncStorage.getItem('notifsEnabled'),
        AsyncStorage.getItem('hijriAdjustment'),
      ]);

      if (saved) setNotifications(JSON.parse(saved));
      if (savedAdhan !== null) setAdhanStyle(parseInt(savedAdhan));
      if (savedAdhanEnabled !== null) setAdhanEnabled(savedAdhanEnabled === 'true');
      if (savedNotifsEnabled !== null) setNotifsEnabled(savedNotifsEnabled === 'true');
      if (savedHijriAdj !== null) setHijriAdjustment(parseInt(savedHijriAdj));
    } catch (e) {}
  }

  async function checkExactAlarmPermission() {
    if (Platform.OS !== 'android' || Platform.Version < 31) return;
    try {
      const { NativeModules } = require('react-native');
      const AdhanModule = NativeModules.AdhanModule;
      if (AdhanModule?.canScheduleExactAlarms) {
        const granted = await AdhanModule.canScheduleExactAlarms();
        setExactAlarmGranted(granted);
      }
    } catch (e) {}
  }

  // ── Core load: Manual city > Saved coordinates (no GPS) > Fresh GPS (first launch only) ──
  async function loadPrayerData() {
    let hadCache = false;
    try {
      setError(null);
      setShowLocationChoice(false);

      const savedMode = await AsyncStorage.getItem('locationMode');
      const savedCity = await AsyncStorage.getItem('manualCity');

      // 1) Manual city mode — never needs GPS
      if (savedMode === 'manual' && savedCity) {
        const city = JSON.parse(savedCity);
        setManualCity(city);
        setLocationMode('manual');
        const cached = await loadPrayerCache();
        if (cached) {
          hadCache = true;
          setPrayerData(cached.data);
          setNextPrayer(getNextPrayer(cached.data.timings));
          setCoords(cached.coords);
          setQiblaAngle(calculateQibla(cached.coords.latitude, cached.coords.longitude));
          setLoading(false);
        } else {
          setLoading(true);
        }
        const data = await getPrayerTimes(city.latitude, city.longitude);
        setPrayerData(data);
        setNextPrayer(getNextPrayer(data.timings));
        setCoords({ latitude: city.latitude, longitude: city.longitude });
        setQiblaAngle(calculateQibla(city.latitude, city.longitude));
        await savePrayerCache(data, { latitude: city.latitude, longitude: city.longitude });
        setTimeout(() => {
          schedulePrayerNotifications(data.timings, adhanEnabled);
        }, 100);
        setError(null);
        setLocationUpdateMsg({ type: 'success', text: `✅ Location set to ${city.shortName}` });
        try {
          const monthly = await getMonthlyTimetable(city.latitude, city.longitude);
          const now = new Date();
          await saveMonthlyCache(monthly, { latitude: city.latitude, longitude: city.longitude }, now.getMonth() + 1, now.getFullYear());
        } catch (e) {}
        return;
      }

      // 2) GPS mode, but we already have saved coordinates — no GPS needed
      const savedCoords = await loadSavedCoordinates();
      if (savedCoords) {
        setLocationMode('gps');
        setCoords(savedCoords);
        setQiblaAngle(calculateQibla(savedCoords.latitude, savedCoords.longitude));
        const savedName = await AsyncStorage.getItem('savedLocationName');
        if (savedName) setGpsCityName(savedName);
        const cached = await loadPrayerCache();
        if (cached) {
          hadCache = true;
          setPrayerData(cached.data);
          setNextPrayer(getNextPrayer(cached.data.timings));
          setLoading(false);
        } else {
          setLoading(true);
        }
        const data = await getPrayerTimes(savedCoords.latitude, savedCoords.longitude);
        setPrayerData(data);
        setNextPrayer(getNextPrayer(data.timings));
        await savePrayerCache(data, savedCoords);
        setTimeout(() => {
          schedulePrayerNotifications(data.timings, adhanEnabled);
        }, 100);

        try {
          const monthly = await getMonthlyTimetable(savedCoords.latitude, savedCoords.longitude);
          const now = new Date();
          await saveMonthlyCache(monthly, savedCoords, now.getMonth() + 1, now.getFullYear());
        } catch (e) {}
        return;
      }

      // 3) First launch ever — no saved coords, no manual city. Need GPS once.
      setLocationMode('gps');
      setLoading(true);
      const location = await getCoordinates();
      setCoords(location);
      setQiblaAngle(calculateQibla(location.latitude, location.longitude));
      await saveCoordinatesPermanently(location);

      // Run reverse geocoding and prayer times fetch in parallel
      const [data] = await Promise.all([
        getPrayerTimes(location.latitude, location.longitude),
        reverseGeocode(location.latitude, location.longitude)
          .then(async (name) => {
            if (name) {
              await AsyncStorage.setItem('savedLocationName', name);
              setGpsCityName(name);
            }
          })
          .catch(() => {}),
      ]);

      setPrayerData(data);
      setNextPrayer(getNextPrayer(data.timings));
      await savePrayerCache(data, location);
      setTimeout(() => {
        schedulePrayerNotifications(data.timings, adhanEnabled);
      }, 100);
      await AsyncStorage.setItem('locationMode', 'gps');

      try {
        const monthly = await getMonthlyTimetable(location.latitude, location.longitude);
        const now = new Date();
        await saveMonthlyCache(monthly, location, now.getMonth() + 1, now.getFullYear());
      } catch (e) {}
    } catch (e) {
      const msg = (e.message || e.toString() || '').toLowerCase();
      if (msg.includes('permission_permanently_denied') || msg.includes('permission_denied')) {
        setShowLocationChoice(true);
      } else if (msg.includes('network') || msg.includes('fetch')) {
        if (!hadCache) setError('OFFLINE_NO_CACHE');
      } else {
        if (!hadCache) setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }

  // ── Manual "Update My Location" — only time GPS is requested again ─────────
  async function updateLocationNow() {
    setShowChangeLocationModal(false);
    setShowCitySearch(false);
    setUpdatingLocation(true);
    setLocationUpdateMsg(null);
    try {
      const location = await getCoordinates();
      await saveCoordinatesPermanently(location);
      try {
        const name = await reverseGeocode(location.latitude, location.longitude);
        if (name) {
          await AsyncStorage.setItem('savedLocationName', name);
          setGpsCityName(name);
        } else {
          await AsyncStorage.removeItem('savedLocationName');
          setGpsCityName(null);
        }
      } catch (e) {}
      await AsyncStorage.setItem('locationMode', 'gps');
      await AsyncStorage.removeItem('manualCity');
      setManualCity(null);
      setLocationMode('gps');
      setCoords(location);
      setQiblaAngle(calculateQibla(location.latitude, location.longitude));
      const data = await getPrayerTimes(location.latitude, location.longitude);
      setPrayerData(data);
      setNextPrayer(getNextPrayer(data.timings));
      await savePrayerCache(data, location);
      setTimeout(() => {
        schedulePrayerNotifications(data.timings, adhanEnabled);
      }, 100);
      setError(null);
      setLocationUpdateMsg({
        type: 'success',
        text: '✅ Location updated! You can turn off GPS now — Bushrann will remember this location.',
      });
    } catch (e) {
      if (e.message === 'PERMISSION_PERMANENTLY_DENIED') {
        setLocationUpdateMsg({
          type: 'error',
          text: '📍 Location permission is off. Please enable it in your phone Settings, then try again.',
        });
      } else if (e.message === 'PERMISSION_DENIED') {
        setLocationUpdateMsg({
          type: 'error',
          text: '📍 Please allow location access when prompted, then try again.',
        });
      } else if (e.message === 'Please enable location services') {
        setLocationUpdateMsg({
          type: 'error',
          text: '📡 Please turn on GPS/Location in your phone settings, then tap Update again.',
        });
      } else {
        setLocationUpdateMsg({ type: 'error', text: 'Something went wrong. Please try again.' });
      }
    } finally {
      setUpdatingLocation(false);
    }
  }

  const toggleHuaweiStep = useCallback(async (stepKey) => {
    const updated = { ...huaweiSteps, [stepKey]: !huaweiSteps[stepKey] };
    setHuaweiSteps(updated);
    await AsyncStorage.setItem('huaweiSteps', JSON.stringify(updated));

    const allDone = updated.launchManager && updated.exactAlarm && updated.batteryOpt;
    if (allDone) {
      setHuaweiUndoBanner(true);
      huaweiUndoTimerRef.current = setTimeout(() => {
        setHuaweiUndoBanner(false);
        setHuaweiTipExpanded(false);
      }, 5000);
    } else {
      clearTimeout(huaweiUndoTimerRef.current);
      setHuaweiUndoBanner(false);
    }
  }, [huaweiSteps]);

  async function undoHuaweiConfirm() {
    clearTimeout(huaweiUndoTimerRef.current);
    setHuaweiUndoBanner(false);
    setHuaweiTipExpanded(true);
  }

  const openHuaweiSettings = useCallback(async () => {
    try {
      await IntentLauncher.startActivityAsync('android.settings.SETTINGS');
    } catch (e) {}
  }, []);

  const openExactAlarmSettings = useCallback(async () => {
    try {
      await requestExactAlarmPermission();
    } catch (e) {
      try { await IntentLauncher.startActivityAsync('android.settings.SETTINGS'); } catch (e2) {}
    }
  }, []);

  const openBatteryOptimizationSettings = useCallback(async () => {
    try {
      await IntentLauncher.startActivityAsync('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', { data: 'package:com.bushrann.app' });
    } catch (e) {
      try { await IntentLauncher.startActivityAsync('android.settings.SETTINGS'); } catch (e2) {}
    }
  }, []);

  async function handleCitySelect(city) {
    setManualCity(city);
    setLocationMode('manual');
    setShowCitySearch(false);
    setShowLocationChoice(false);
    setShowChangeLocationModal(false);
    setCitySearch('');
    setCityResults([]);
    await AsyncStorage.setItem('locationMode', 'manual');
    await AsyncStorage.setItem('manualCity', JSON.stringify(city));
    setLoading(true);
    try {
      const data = await getPrayerTimes(city.latitude, city.longitude);
      setPrayerData(data);
      setNextPrayer(getNextPrayer(data.timings));
      setCoords({ latitude: city.latitude, longitude: city.longitude });
      setQiblaAngle(calculateQibla(city.latitude, city.longitude));
      await savePrayerCache(data, { latitude: city.latitude, longitude: city.longitude });
      setTimeout(() => {
        schedulePrayerNotifications(data.timings, adhanEnabled);
      }, 100);
      setError(null);
      setLocationUpdateMsg({ type: 'success', text: `✅ Location set to ${city.shortName}` });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCitySearch(text) {
    setCitySearch(text);
    if (text.length < 3) { setCityResults([]); return; }
    setCitySearchLoading(true);
    try {
      const results = await searchCity(text);
      setCityResults(results);
    } catch (e) {
      setCityResults([]);
    } finally {
      setCitySearchLoading(false);
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
    Magnetometer.setUpdateInterval(isLowEndDevice ? 32 : 16);

    let targetAngle    = 0;
    let visualAngle    = rotation.value;
    let visualVelocity = 0;
    let initialized    = false;
    let lastTarget     = -1;
    let rejectCount    = 0;

    let filteredX    = 0;
    let filteredY    = 0;
    let lastRawAngle = 0;
    let lastHeadingUpdate = 0;

    magnetometerSub.current = Magnetometer.addListener(({ x, y }) => {
      const instantAngle = (Math.atan2(y, x) * (180 / Math.PI) - 90 + 360) % 360;
      let moveDelta = Math.abs(instantAngle - lastRawAngle);
      if (moveDelta > 180) moveDelta = 360 - moveDelta;

      const ALPHA = Math.min(0.1 + moveDelta * 0.018, 0.45);
      filteredX = filteredX + ALPHA * (x - filteredX);
      filteredY = filteredY + ALPHA * (y - filteredY);

      let rawAngle = (Math.atan2(filteredY, filteredX) * (180 / Math.PI) - 90 + 360) % 360;

      // Throttle React state update — slower on low-end devices to reduce memory pressure
      const now = Date.now();
      const throttleMs = isLowEndDevice ? 700 : 400;
      if (now - lastHeadingUpdate > throttleMs) {
        setCompassHeading(rawAngle);
        lastHeadingUpdate = now;
      }
      lastRawAngle = rawAngle;

      if (lastTarget === -1) { lastTarget = rawAngle; targetAngle = rawAngle; initialized = true; return; }
      const sensorDelta    = rawAngle - lastTarget;
      const sensorShortest = sensorDelta > 180 ? sensorDelta - 360 : sensorDelta < -180 ? sensorDelta + 360 : sensorDelta;
      if (Math.abs(sensorShortest) > 90) {
        rejectCount++;
        if (rejectCount > 5) { lastTarget = rawAngle; targetAngle = rawAngle; initialized = true; rejectCount = 0; }
        return;
      }
      rejectCount = 0; lastTarget = rawAngle; targetAngle = rawAngle; initialized = true;
    });

    function physicsLoop() {
      if (!initialized) { rafRef.current = requestAnimationFrame(physicsLoop); return; }
      let delta = targetAngle - visualAngle;
      if (delta > 180)  delta -= 360;
      if (delta < -180) delta += 360;
      const absDelta = Math.abs(delta);
      const predictedVelocity = visualVelocity;
      const prediction = predictedVelocity * 1.5;
      const predictedDelta = delta + prediction;
      const force = predictedDelta * (absDelta > 40 ? 0.14 : absDelta > 15 ? 0.08 : 0.04);
      const damping = absDelta > 40 ? 0.80 : absDelta > 15 ? 0.86 : 0.92;
      const maxSpeed = absDelta > 40 ? 18 : absDelta > 15 ? 12 : 6;
      visualVelocity += force;
      visualVelocity *= damping;
      if (visualVelocity >  maxSpeed) visualVelocity =  maxSpeed;
      if (visualVelocity < -maxSpeed) visualVelocity = -maxSpeed;
      visualAngle    += visualVelocity;
      rotation.value  = -visualAngle;
      rafRef.current  = requestAnimationFrame(physicsLoop);
    }
    rafRef.current = requestAnimationFrame(physicsLoop);
  }

  function stopMagnetometer() {
    if (magnetometerSub.current) { magnetometerSub.current.remove(); magnetometerSub.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }

  async function toggleNotification(prayer) {
    const currentlyOn = notifications[prayer] !== false; // matches what the Switch displays
    const updated = { ...notifications, [prayer]: !currentlyOn };
    setNotifications(updated);
    await AsyncStorage.setItem('prayerNotifications', JSON.stringify(updated));

    if (prayerData?.timings) {
      await schedulePrayerNotifications(prayerData.timings, adhanEnabled);
    }
  }

  async function playAdhan() {
    try {
      if (playingAdhan) { await sound?.stopAsync(); setPlayingAdhan(false); return; }
      if (sound) await sound.unloadAsync();
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound: newSound } = await Audio.Sound.createAsync(
        ADHAN_STYLES[adhanStyle].url, { shouldPlay: true }
      );
      setSound(newSound);
      setPlayingAdhan(true);
      newSound.setOnPlaybackStatusUpdate((s) => { if (s.didJustFinish) setPlayingAdhan(false); });
    } catch (e) { setPlayingAdhan(false); }
  }

  async function testRealAdhan() {
    if (Platform.OS !== 'android') return;
    try {
      const { NativeModules } = require('react-native');
      const AdhanModule = NativeModules.AdhanModule;
      if (AdhanModule?.startAdhan) {
        await AdhanModule.startAdhan('Fajr', adhanStyle);
      }
    } catch (e) {}
  }

  async function selectAdhan(index) {
    setAdhanStyle(index);
    await AsyncStorage.setItem('adhanStyle', String(index));
  }

  async function toggleAdhan(val) {
    setAdhanEnabled(val);
    await AsyncStorage.setItem('adhanEnabled', String(val));
  }

  if (loading) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={COLORS.gold} size="large" />
        <Text style={styles.loadingText}>Getting prayer times...</Text>
      </View>
    );
  }

  // Location choice screen (first launch / permission denied — no cancel)
  if (showLocationChoice) {
    return (
      <View style={[styles.center, { paddingTop: insets.top, paddingHorizontal: 24 }]}>
        {!showCitySearch ? (
          <>
            <Text style={{ fontSize: 40, marginBottom: 16 }}>📍</Text>
            <Text style={{ fontSize: 20, fontWeight: '700', color: '#1a2e44', marginBottom: 8, textAlign: 'center' }}>
              Location Access Needed
            </Text>
            <Text style={{ fontSize: 14, color: '#666', textAlign: 'center', lineHeight: 22, marginBottom: 32 }}>
              Bushrann needs your location once to calculate accurate prayer times and Qibla direction. After that, you can turn GPS off — we'll remember it.
            </Text>
            <TouchableOpacity
              style={[styles.retryBtn, { width: '100%', alignItems: 'center', marginBottom: 12, paddingVertical: 14 }]}
              onPress={() => Linking.openSettings()}
            >
              <Text style={styles.retryText}>📍 Enable Location in Settings</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ width: '100%', alignItems: 'center', paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: COLORS.gold, backgroundColor: 'rgba(201,168,76,0.08)', marginBottom: 12 }}
              onPress={() => setShowCitySearch(true)}
            >
              <Text style={{ color: '#b8860b', fontWeight: '700', fontSize: 14 }}>🔍 Search City Manually</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => loadPrayerData()}>
              <Text style={{ color: '#888', fontSize: 13 }}>Try Again</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a2e44', marginBottom: 16 }}>🔍 Search Your City</Text>
            <TextInput
              style={{
                width: '100%', borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)',
                borderRadius: 12, padding: 14, fontSize: 15, backgroundColor: '#fff',
                marginBottom: 12, color: '#1a2e44',
              }}
              placeholder="Type city name..."
              placeholderTextColor="#aaa"
              value={citySearch}
              onChangeText={handleCitySearch}
              autoFocus
            />
            {citySearchLoading && <ActivityIndicator color={COLORS.gold} style={{ marginBottom: 12 }} />}
            <ScrollView style={{ width: '100%', maxHeight: 300 }} showsVerticalScrollIndicator={false}>
              {cityResults.map((city, i) => (
                <TouchableOpacity
                  key={i}
                  style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.06)', backgroundColor: '#fff', borderRadius: 8, marginBottom: 4 }}
                  onPress={() => handleCitySelect(city)}
                >
                  <Text style={{ fontSize: 13, color: '#1a2e44', fontWeight: '600' }}>{city.shortName}</Text>
                  <Text style={{ fontSize: 11, color: '#888', marginTop: 2 }} numberOfLines={1}>{city.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity onPress={() => setShowCitySearch(false)} style={{ marginTop: 16 }}>
              <Text style={{ color: '#888', fontSize: 13 }}>← Back</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  if (error) {
    const isGpsOff = error === 'Please enable location services';
    const isOfflineNoCache = error === 'OFFLINE_NO_CACHE';
    return (
      <View style={[styles.center, { paddingTop: insets.top, paddingHorizontal: 24 }]}>
        <Text style={styles.errorIcon}>{isGpsOff ? '📡' : isOfflineNoCache ? '📡' : '⚠️'}</Text>
        <Text style={[styles.errorText, { fontWeight: '700', fontSize: 16, color: '#1a2e44', marginBottom: 8 }]}>
          {isGpsOff ? 'GPS is Turned Off' : isOfflineNoCache ? 'No Internet Connection' : 'Something went wrong'}
        </Text>
        <Text style={styles.errorText}>
          {isGpsOff
            ? 'Please turn on Location/GPS in your phone settings (swipe down notifications and tap the Location icon), then tap Try Again.'
            : isOfflineNoCache
            ? 'Please connect to WiFi or mobile data to get accurate prayer times schedule. After the first load, Bushrann works offline.'
            : error}
        </Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => loadPrayerData()}>
          <Text style={styles.retryText}>{isOfflineNoCache ? 'Retry' : 'Try Again'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const hijriDate     = prayerData?.date?.hijri;
  const gregorianDate = prayerData?.date?.readable;

  const CompactCompass = memo(() => (
    <View pointerEvents="none" style={{ alignItems: 'center', marginTop: 6 }}>
      <View style={styles.triangleSmall} />
      <View pointerEvents="none" style={[
        styles.compassOuter,
        { width: 120, height: 120, borderRadius: 60 },
        facingMakkah && styles.compassOuterAligned,
      ]}>
        <Animated.View pointerEvents="none" style={[styles.compassGlow, pulseRingStyle, { borderRadius: 60 }]} />
        <Animated.View pointerEvents="none" style={[
          styles.compassDisc,
          { width: 118, height: 118, borderRadius: 59, top: '50%', left: '50%', marginTop: -59, marginLeft: -59 },
          animatedCompassStyle,
        ]}>
          {COMPASS_TICKS_118}
          {[
            { label: 'N', deg: 0,   color: '#ff6b6b', topOff: -14, leftOff: -7  },
            { label: 'E', deg: 90,  color: '#ffffff',  topOff: -7,  leftOff:  2  },
            { label: 'S', deg: 180, color: '#ffffff',  topOff:  3,  leftOff: -7  },
            { label: 'W', deg: 270, color: '#f8f8f8',  topOff: -7,  leftOff: -16 },
          ].map(({ label, deg, color, topOff, leftOff }) => {
            const rad    = (deg * Math.PI) / 180;
            const outerR = 118 / 2 - 7;
            const r      = outerR - 1;
            const cx     = 59 + r * Math.sin(rad);
            const cy     = 59 - r * Math.cos(rad);
            return (
              <Text key={label} style={{
                position: 'absolute',
                left: cx + leftOff, top: cy + topOff,
                fontSize: 11, fontWeight: '900', letterSpacing: 0.5,
                color, width: 14, textAlign: 'center', lineHeight: 14,
                textShadowColor: '#000000',
                textShadowOffset: { width: 0, height: 0 },
                textShadowRadius: 8,
              }}>{label}</Text>
            );
          })}
          {(() => {
            const rad = ((qiblaAngle ?? 0) * Math.PI) / 180;
            const r   = 118 / 2 - 8;
            const cx  = 59 + r * Math.sin(rad);
            const cy  = 59 - r * Math.cos(rad);
            return (
              <View style={{
                position: 'absolute', left: cx - 13, top: cy - 11,
                width: 26, height: 26, alignItems: 'center', justifyContent: 'center',
                backgroundColor: 'rgba(240,201,106,0.25)', borderRadius: 13,
                borderWidth: 1.5, borderColor: 'rgba(240,201,106,0.6)',
              }}>
                <Text style={{ fontSize: 14, textShadowColor: 'rgba(240,201,106,0.9)', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 8 }}>🕋</Text>
              </View>
            );
          })()}
        </Animated.View>
        <NeedleSmall />
        <View pointerEvents="none" style={styles.compassCenterDot} />
      </View>
    </View>
  ));

  const FullCompass = memo(() => (
    <View pointerEvents="none" style={{ alignItems: 'center', marginTop: 10 }}>
      <View style={styles.triangleLarge} />
      <View pointerEvents="none" style={[
        styles.compassOuter,
        { width: 280, height: 280, borderRadius: 140 },
        facingMakkah && styles.compassOuterAligned,
      ]}>
        <Animated.View pointerEvents="none" style={[styles.compassGlow, pulseRingStyle, { borderRadius: 140 }]} />
        <Animated.View pointerEvents="none" style={[
          styles.compassDisc,
          { width: 234, height: 234, borderRadius: 117, top: '50%', left: '50%', marginTop: -117, marginLeft: -117 },
          animatedCompassStyle,
        ]}>
          {COMPASS_TICKS_234}
          {[30, 60, 120, 150, 210, 240, 300, 330].map((deg) => {
            const rad = (deg * Math.PI) / 180;
            const r   = 234 / 2 - 28;
            const cx  = 117 + r * Math.sin(rad);
            const cy  = 117 - r * Math.cos(rad);
            return (
              <Text key={deg} style={{
                position: 'absolute', left: cx - 10, top: cy - 7,
                fontSize: 9, fontWeight: '600',
                color: 'rgba(255,255,255,0.35)', width: 20, textAlign: 'center',
              }}>{deg}°</Text>
            );
          })}
          {[
            { label: 'N', deg: 0,   color: '#ff6b6b',               topOff: -21,  leftOff: -9  },
            { label: 'E', deg: 90,  color: 'rgba(255,255,255,0.85)', topOff: -7.5, leftOff:  2  },
            { label: 'S', deg: 180, color: 'rgba(255,255,255,0.85)', topOff:  5,   leftOff: -9  },
            { label: 'W', deg: 270, color: 'rgba(255,255,255,0.85)', topOff: -7.5, leftOff: -20 },
          ].map(({ label, deg, color, topOff, leftOff }) => {
            const rad    = (deg * Math.PI) / 180;
            const outerR = 234 / 2 - 7;
            const r      = outerR - 2;
            const cx     = 117 + r * Math.sin(rad);
            const cy     = 117 - r * Math.cos(rad);
            return (
              <Text key={label} style={{
                position: 'absolute',
                left: cx + leftOff, top: cy + topOff,
                fontSize: 16, fontWeight: '800', letterSpacing: 0.5,
                color, width: 18, textAlign: 'center', lineHeight: 16,
              }}>{label}</Text>
            );
          })}
          {(() => {
            const rad = ((qiblaAngle ?? 0) * Math.PI) / 180;
            const r   = 234 / 2 - 8;
            const cx  = 117 + r * Math.sin(rad);
            const cy  = 117 - r * Math.cos(rad);
            return (
              <View style={{
                position: 'absolute', left: cx - 18, top: cy - 13,
                width: 36, height: 36, alignItems: 'center', justifyContent: 'center',
                backgroundColor: 'rgba(240,201,106,0.15)', borderRadius: 18,
                borderWidth: 1, borderColor: 'rgba(240,201,106,0.4)',
              }}>
                <Text style={{ fontSize: 24, textShadowColor: 'rgba(240,201,106,0.8)', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 8 }}>🕋</Text>
              </View>
            );
          })()}
        </Animated.View>
        <NeedleLarge />
        <View pointerEvents="none" style={styles.compassCenterDotLarge} />
      </View>
      <View style={styles.headingBadge}>
        <Text style={styles.headingDeg}>{Math.round(compassHeading)}°</Text>
        <Text style={styles.headingLabel}>{getCardinalDirection(compassHeading)}</Text>
      </View>
    </View>
  ));

  return (
    <View style={{ flex: 1, backgroundColor: '#f0f2f5' }}>
      {showNotifPrompt && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9999, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ backgroundColor: '#1a2e44', borderRadius: 24, padding: 28, width: '85%', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)' }}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>🕌</Text>
            <Text style={{ fontSize: 20, fontWeight: '700', color: '#fff', marginBottom: 8, textAlign: 'center' }}>Prayer Time Reminders</Text>
            <Text style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', textAlign: 'center', lineHeight: 22, marginBottom: 24 }}>
              Would you like to receive daily prayer time notifications with Adhan sound?
            </Text>
            <TouchableOpacity
              style={{ backgroundColor: COLORS.gold, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, width: '100%', alignItems: 'center', marginBottom: 10 }}
              onPress={async () => { setShowNotifPrompt(false); await setPrayerNotifChoice('enabled'); await initPrayerNotifications(true); }}
            >
              <Text style={{ color: '#1a2e44', fontWeight: '700', fontSize: 15 }}>🔔 Enable with Adhan</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, width: '100%', alignItems: 'center', marginBottom: 10 }}
              onPress={async () => { setShowNotifPrompt(false); await setPrayerNotifChoice('silent'); await initPrayerNotifications(false); }}
            >
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>🔕 Silent Notifications</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, width: '100%', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}
              onPress={async () => { setShowNotifPrompt(false); await setPrayerNotifChoice('skipped'); }}
            >
              <Text style={{ color: '#ffffff', fontWeight: '600', fontSize: 15 }}>Not Now</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {showChangeLocationModal && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9998, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
          <View style={{ backgroundColor: '#fff', borderRadius: 24, padding: 24, width: '100%' }}>
            {!showCitySearch ? (
              <>
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a2e44', marginBottom: 8 }}>📍 Change Location</Text>
                <Text style={{ fontSize: 13, color: '#666', marginBottom: 20, lineHeight: 20 }}>
                  Currently using: {locationMode === 'manual' && manualCity ? `📌 ${manualCity.shortName}` : `🛰 ${gpsCityName ?? 'GPS (saved)'}`}
                </Text>
                <Text style={{ fontSize: 12, color: '#888', marginBottom: 14, lineHeight: 18 }}>
                  Only use "Update My Location" if you've traveled to a different city. Otherwise your saved location already works without GPS.
                </Text>
                <TouchableOpacity
                  style={[styles.retryBtn, { width: '100%', alignItems: 'center', marginBottom: 10, paddingVertical: 14, opacity: updatingLocation ? 0.6 : 1 }]}
                  onPress={updateLocationNow}
                  disabled={updatingLocation}
                >
                  {updatingLocation ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.retryText}>🛰 Update My Location (GPS)</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ width: '100%', alignItems: 'center', paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: COLORS.gold, backgroundColor: 'rgba(201,168,76,0.08)', marginBottom: 10 }}
                  onPress={() => setShowCitySearch(true)}
                >
                  <Text style={{ color: '#b8860b', fontWeight: '700', fontSize: 14 }}>🔍 Search City Manually</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ width: '100%', alignItems: 'center', paddingVertical: 13, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)', backgroundColor: 'rgba(0,0,0,0.03)' }}
                  onPress={() => { setShowChangeLocationModal(false); setShowCitySearch(false); }}
                >
                  <Text style={{ color: '#555', fontSize: 14, fontWeight: '600' }}>Cancel</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a2e44', marginBottom: 16 }}>🔍 Search Your City</Text>
                <TextInput
                  style={{
                    width: '100%', borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)',
                    borderRadius: 12, padding: 14, fontSize: 15, backgroundColor: '#f9f9f9',
                    marginBottom: 12, color: '#1a2e44',
                  }}
                  placeholder="Type city name..."
                  placeholderTextColor="#aaa"
                  value={citySearch}
                  onChangeText={handleCitySearch}
                  autoFocus
                />
                {citySearchLoading && <ActivityIndicator color={COLORS.gold} style={{ marginBottom: 8 }} />}
                <ScrollView style={{ maxHeight: 240 }} showsVerticalScrollIndicator={false}>
                  {cityResults.map((city, i) => (
                    <TouchableOpacity
                      key={i}
                      style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.06)', borderRadius: 8, marginBottom: 4 }}
                      onPress={() => handleCitySelect(city)}
                    >
                      <Text style={{ fontSize: 13, color: '#1a2e44', fontWeight: '600' }}>{city.shortName}</Text>
                      <Text style={{ fontSize: 11, color: '#888', marginTop: 2 }} numberOfLines={1}>{city.name}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                <TouchableOpacity
                  style={{ width: '100%', alignItems: 'center', paddingVertical: 13, marginTop: 8, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)', backgroundColor: 'rgba(0,0,0,0.03)' }}
                  onPress={() => setShowCitySearch(false)}
                >
                  <Text style={{ color: '#555', fontSize: 14, fontWeight: '600' }}>← Back</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      )}

      {/* Location update success/error banner */}
      {locationUpdateMsg && (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => setLocationUpdateMsg(null)}
          style={{
            position: 'absolute', top: insets.top + 10, left: 12, right: 12, zIndex: 9997,
            backgroundColor: locationUpdateMsg.type === 'success' ? '#1a7a3c' : '#b8860b',
            borderRadius: 14, padding: 14,
            shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8, elevation: 6,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', lineHeight: 19 }}>
            {locationUpdateMsg.text}
          </Text>
        </TouchableOpacity>
      )}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 80 }} showsVerticalScrollIndicator={false} delayPressIn={0} directionalLockEnabled={true}>
        <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
          <Text style={styles.headerSub}>BISMILLAH</Text>
          <Text style={styles.screenTitle}>Prayer Times</Text>
          <View style={styles.headerRow}>
            <View style={styles.hijriPill}>
              <Text style={styles.hijriText}>{hijriDate?.day} {hijriDate?.month?.en} {hijriDate?.year} AH</Text>
            </View>
            <TouchableOpacity
              onPress={() => { setShowChangeLocationModal(true); setShowCitySearch(false); }}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 6,
                backgroundColor: 'rgba(201,168,76,0.18)',
                borderWidth: 1, borderColor: 'rgba(201,168,76,0.35)',
                borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7,
              }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={[styles.locationText, { color: '#f0c96a', fontWeight: '700' }]}>
                {locationMode === 'manual' && manualCity
                  ? `📌 ${manualCity.shortName}`
                  : `📍 ${gpsCityName ?? prayerData?.meta?.timezone?.split('/')[1]?.replace('_', ' ') ?? 'Your Location'}`}
              </Text>
              <Text style={{ color: '#f0c96a', fontSize: 11 }}>✎</Text>
            </TouchableOpacity>
          </View>
        </View>
        {isOffline && (
          <View style={{
            backgroundColor: 'rgba(184,134,11,0.12)',
            borderWidth: 1, borderColor: 'rgba(184,134,11,0.3)',
            borderRadius: 12, padding: 12, marginHorizontal: 12, marginBottom: 10,
            flexDirection: 'row', alignItems: 'center',
          }}>
            <Text style={{ fontSize: 16, marginRight: 8 }}>📡</Text>
            <Text style={{ fontSize: 13, color: '#b8860b', fontWeight: '600' }}>
              Offline — showing cached data
            </Text>
          </View>
        )}

        {nextPrayer && (
          <View style={styles.heroCard}>
            <Text style={styles.heroLabel}>NEXT PRAYER</Text>
            <View style={styles.heroRow}>
              <View>
                <Text style={styles.heroName}>{getPrayerEmoji(nextPrayer.name)} {nextPrayer.name}</Text>
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
                if (val) { await initPrayerNotifications(adhanEnabled); }
                else {
                  await cancelPrayerNotifications();
                  await Notifications.dismissNotificationAsync('prayer-persistent');
                }
              }}
              trackColor={{ false: 'rgba(0,0,0,0.1)', true: COLORS.gold + '80' }}
              thumbColor={notifsEnabled ? COLORS.gold : 'rgba(0,0,0,0.3)'}
            />
          </View>
          </View>
        {Platform.OS === 'android' && Platform.Version >= 31 && !exactAlarmGranted && (
          <TouchableOpacity
            style={[styles.card, { backgroundColor: 'rgba(220,38,38,0.06)', borderColor: 'rgba(220,38,38,0.25)', borderWidth: 1 }]}
            onPress={openExactAlarmSettings}
            activeOpacity={0.8}
          >
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <Text style={{ fontSize: 18, marginRight: 10, marginTop: 2 }}>⚠️</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#dc2626' }}>
                  Exact Alarm Permission Needed
                </Text>
                <Text style={{ fontSize: 12, color: '#666', marginTop: 3, lineHeight: 18 }}>
                  Your phone requires this for Adhan to work on time. This is not a bug.
                </Text>
                <Text style={{ fontSize: 11, color: '#888', marginTop: 6, lineHeight: 17 }}>
                  1. Tap here to open Settings{'\n'}
                  2. Tap "Apps" → find "Bushrann"{'\n'}
                  3. Tap "Alarms & reminders"{'\n'}
                  4. Turn ON "Allow setting alarms"{'\n'}
                  5. Return to Bushrann
                </Text>
              </View>
            </View>
          </TouchableOpacity>
        )}

        <View style={styles.card}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: '#1a2e44' }}>🌙 Hijri Date Adjustment</Text>
          <Text style={{ fontSize: 12, color: '#888', marginTop: 2 }}>If the Islamic date doesn't match your local mosque announcement, adjust it here.</Text>
          <View style={styles.adhanStyles}>
            {[-2, -1, 0, 1, 2].map((n) => (
              <TouchableOpacity
                key={n}
                style={[styles.adhanChip, hijriAdjustment === n && styles.adhanChipActive]}
                onPress={async () => {
                  setHijriAdjustment(n);
                  await AsyncStorage.setItem('hijriAdjustment', String(n));
                  loadPrayerData();
                }}
              >
                <Text style={[styles.adhanChipText, hijriAdjustment === n && styles.adhanChipTextActive]}>
                  {n > 0 ? `+${n}` : String(n)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        
        {isHuawei && (
          <HuaweiSetupCard
            huaweiSteps={huaweiSteps}
            huaweiTipExpanded={huaweiTipExpanded}
            onToggleExpanded={() => setHuaweiTipExpanded(prev => !prev)}
            onToggleStep={toggleHuaweiStep}
            onOpenLaunchManager={openHuaweiSettings}
            onOpenExactAlarm={openExactAlarmSettings}
            onOpenBatteryOpt={openBatteryOptimizationSettings}
          />
        )}

        {/* Undo banner — appears for 5 seconds after all 3 steps checked */}
        {huaweiUndoBanner && (
          <TouchableOpacity
            onPress={undoHuaweiConfirm}
            style={{
              marginHorizontal: 12, marginBottom: 10,
              backgroundColor: '#1a7a3c', borderRadius: 14, padding: 14,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>✅ All 4 steps complete</Text>
            <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12 }}>↩ Tap to undo (5s)</Text>
          </TouchableOpacity>
        )}

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
              <View key={prayer} style={[styles.prayerRow, isNext && styles.prayerRowActive, isPast && styles.prayerRowPast]}>
                <Text style={styles.prayerEmoji}>{getPrayerEmoji(prayer)}</Text>
                <Text style={[styles.prayerName, isNext && styles.prayerNameActive]}>{prayer}</Text>
                <Text style={[styles.prayerTime, isNext && styles.prayerTimeActive]}>{formatTime(prayerData?.timings?.[prayer] ?? '00:00')}</Text>
                <Switch
                  value={notifications[prayer] !== false}
                  onValueChange={() => toggleNotification(prayer)}
                  trackColor={{ false: 'rgba(0,0,0,0.1)', true: COLORS.gold + '80' }}
                  thumbColor={notifications[prayer] !== false ? COLORS.gold : 'rgba(0,0,0,0.3)'}
                  style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                />
              </View>
            );
          })}
        </View>

        {compassExpanded && (
          <TouchableOpacity activeOpacity={0.95} onPress={() => { cancelAnimation(pulseScale); cancelAnimation(glowOpacity); setCompassExpanded(false); }} style={styles.compassExpandedCard} delayPressIn={0} pressRetentionOffset={{top: 10, left: 10, right: 10, bottom: 10}}>
            <View style={styles.compassExpandedHeader}>
              <View>
                <Text style={styles.compassExpandedTitle}>🧭 Qibla Compass</Text>
                <Text style={styles.compassExpandedSub}>
                  {qiblaAngle !== null ? `${Math.round(qiblaAngle)}° ${getCardinalDirection(qiblaAngle)} toward Mecca` : 'Calculating...'}
                </Text>
              </View>
              <View style={[styles.alignBadge, facingMakkah && styles.alignBadgeActive]}>
                <Text style={[styles.alignBadgeText, facingMakkah && styles.alignBadgeTextActive]}>
                  {facingMakkah ? '✓ Aligned' : 'Rotate'}
                </Text>
              </View>
            </View>
            <FullCompass />
            <View style={[styles.qiblaStatus, facingMakkah && styles.qiblaStatusAligned]}>
              <Text style={[styles.qiblaStatusText, facingMakkah && styles.qiblaStatusTextAligned]}>
                {facingMakkah ? '🕋  You are facing Makkah!' : `🕋  ${Math.round(shortestDiff)}° away from Makkah`}
              </Text>
            </View>
            <Text style={styles.tapHint}>Tap to collapse</Text>
          </TouchableOpacity>
        )}

        {!compassExpanded && (
          <View style={styles.twoCol}>
            <TouchableOpacity activeOpacity={0.9} onPress={() => { cancelAnimation(pulseScale); cancelAnimation(glowOpacity); setCompassExpanded(true); }} style={[styles.card, styles.halfCard]} delayPressIn={0} pressRetentionOffset={{top: 10, left: 10, right: 10, bottom: 10}}>
              <View style={{ position: 'relative', width: '100%', alignItems: 'center' }}>
                <View style={styles.iconRing}><Text style={{ fontSize: 22 }}>🧭</Text></View>
                <Text style={styles.cardTitle}>Qibla</Text>
                <Text style={styles.cardValue}>{qiblaAngle !== null ? `${Math.round(qiblaAngle)}°` : '--'}</Text>
                <Text style={styles.cardSub}>{qiblaAngle !== null ? `${getCardinalDirection(qiblaAngle)} toward Mecca` : ''}</Text>
                <CompactCompass />
                <Text style={[styles.facingLabel, { color: facingMakkah ? '#22c55e' : COLORS.gold }]}>
                  {facingMakkah ? '✓ Facing Makkah!' : '🕋 Find Makkah'}
                </Text>
                <Text style={styles.tapHint}>Tap to expand</Text>
              </View>
            </TouchableOpacity>

            <View style={[styles.card, styles.halfCard]}>
              <View style={styles.iconRing}><Text style={{ fontSize: 22 }}>🔊</Text></View>
              <Text style={styles.cardTitle}>Adhan</Text>
              <Switch
                value={adhanEnabled} onValueChange={toggleAdhan}
                trackColor={{ false: 'rgba(0,0,0,0.1)', true: COLORS.gold + '80' }}
                thumbColor={adhanEnabled ? COLORS.gold : 'rgba(0,0,0,0.3)'}
                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
              />
              <View style={styles.adhanStyles}>
                {ADHAN_STYLES.map((s, i) => (
                  <TouchableOpacity key={s.label} style={[styles.adhanChip, adhanStyle === i && styles.adhanChipActive]} onPress={() => selectAdhan(i)}>
                    <Text style={[styles.adhanChipText, adhanStyle === i && styles.adhanChipTextActive]}>{s.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={styles.playBtn} onPress={playAdhan}>
                <Text style={styles.playBtnText}>{playingAdhan ? '⏹ Stop' : '▶️ Preview'}</Text>
              </TouchableOpacity>
              {__DEV__ && Platform.OS === 'android' && (
                <TouchableOpacity style={[styles.playBtn, { marginTop: 6, borderColor: '#dc2626' }]} onPress={testRealAdhan}>
                  <Text style={[styles.playBtnText, { color: '#dc2626' }]}>🧪 Test Real Adhan (5s)</Text>
                </TouchableOpacity>
              )}
              {__DEV__ && (
                <TouchableOpacity
                  style={[styles.playBtn, { marginTop: 6, borderColor: '#dc2626' }]}
                  onPress={() => {
                    if (prayerData?.timings) {
                      schedulePrayerNotifications(prayerData.timings, adhanEnabled);
                    }
                    playAdhan();
                  }}
                >
                  <Text style={[styles.playBtnText, { color: '#dc2626' }]}>🧪 Test Adhan (dev)</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        <View style={styles.card}>
          <TouchableOpacity style={styles.monthlyBtn} onPress={showMonthly ? () => setShowMonthly(false) : loadMonthly}>
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
                {PRAYERS.map(p => <Text key={p} style={[styles.timetableCell, styles.timetableHead]}>{p.slice(0, 3)}</Text>)}
              </View>
              {monthlyData.map((day) => {
                const isToday = day.date.gregorian.day === String(new Date().getDate()).padStart(2, '0');
                return (
                  <View key={day.date.gregorian.date} style={[styles.timetableRow, isToday && styles.timetableRowToday]}>
                    <Text style={[styles.timetableCell, isToday && styles.timetableCellToday]}>{parseInt(day.date.gregorian.day)}</Text>
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
  cardSub: { fontSize: 11, color: '#666', textAlign: 'center', marginBottom: 4 },

  triangleSmall: {
    width: 0, height: 0, backgroundColor: 'transparent',
    borderLeftWidth: 10, borderRightWidth: 10, borderBottomWidth: 18,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderBottomColor: '#1db954', zIndex: 20, marginBottom: 4,
  },
  triangleLarge: {
    width: 0, height: 0, backgroundColor: 'transparent',
    borderLeftWidth: 16, borderRightWidth: 16, borderBottomWidth: 28,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderBottomColor: '#1db954', zIndex: 20, marginBottom: 6,
  },

  compassGlow: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(34,197,94,0.45)',
  },
  compassOuter: {
    borderWidth: 3, borderColor: '#c9a84c',
    backgroundColor: '#0d1b2a',
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
    shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4, shadowRadius: 12, elevation: 10,
  },
  compassOuterAligned: {
    borderColor: '#22c55e',
  },
  compassDisc: {
    position: 'absolute', backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'center',
  },

  needleFixedSmall: { position: 'absolute', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  needleFixedLarge: { position: 'absolute', alignItems: 'center', justifyContent: 'center', zIndex: 10 },

  compassCenterDot: {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: '#f0c96a', position: 'absolute', zIndex: 11,
    shadowColor: '#f0c96a', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1, shadowRadius: 4, elevation: 4,
  },
  compassCenterDotLarge: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: '#f0c96a', position: 'absolute', zIndex: 11,
    shadowColor: '#f0c96a', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1, shadowRadius: 6, elevation: 4,
  },

  facingLabel: { fontSize: 12, fontWeight: '700', marginTop: 8, textAlign: 'center' },
  tapHint: { fontSize: 10, color: '#aaa', marginTop: 4, textAlign: 'center' },

  headingBadge: {
    flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 10,
    backgroundColor: 'rgba(13,27,42,0.06)', borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 6,
    borderWidth: 1, borderColor: 'rgba(201,168,76,0.2)',
  },
  headingDeg: { fontSize: 20, fontWeight: '700', color: '#1a2e44' },
  headingLabel: { fontSize: 12, fontWeight: '600', color: '#888' },

  compassExpandedCard: {
    backgroundColor: '#ffffff', borderRadius: 20, padding: 18,
    marginHorizontal: 12, marginBottom: 10,
    borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.08)', alignItems: 'center',
  },
  compassExpandedHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 4 },
  compassExpandedTitle: { fontSize: 16, fontWeight: '700', color: '#1a2e44' },
  compassExpandedSub: { fontSize: 12, color: '#888', marginTop: 2 },

  alignBadge: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5, backgroundColor: 'rgba(201,168,76,0.1)', borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)' },
  alignBadgeActive: { backgroundColor: 'rgba(34,197,94,0.1)', borderColor: 'rgba(34,197,94,0.4)' },
  alignBadgeText: { fontSize: 12, fontWeight: '700', color: '#b8860b' },
  alignBadgeTextActive: { color: '#16a34a' },

  qiblaStatus: { marginTop: 14, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: 'rgba(201,168,76,0.08)', borderWidth: 1, borderColor: 'rgba(201,168,76,0.2)' },
  qiblaStatusAligned: { backgroundColor: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.3)' },
  qiblaStatusText: { fontSize: 13, fontWeight: '700', color: COLORS.gold, textAlign: 'center' },
  qiblaStatusTextAligned: { color: '#16a34a' },

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