// ─────────────────────────────────────────────
//  QuranScreen.js — Surah List Browser
//  Performance: surah list cached in AsyncStorage
//  after first load — instant on all subsequent opens.
// ─────────────────────────────────────────────

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  StatusBar,
  AppState,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { SystemBars } from 'react-native-edge-to-edge';
import { fetchSurahs, fetchVerses, fetchVerseAudioUrl } from '../services/quranApi';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS } from '../constants/theme';
import { isLowEndDevice } from '../utils/deviceInfo';
import PlaybackModeDialog from '../components/PlaybackModeDialog';

const REVELATION_COLORS = {
  Makkah: '#c9a84c',
  Madinah: '#4c9ac9',
};

const SURAHS_CACHE_KEY = 'quran_surahs_cache';
const SURAHS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week — Quran doesn't change

export default function QuranScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [surahs, setSurahs] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isPlayingQuran, setIsPlayingQuran] = useState(false);
  const [resumePosition, setResumePosition] = useState(null);
  const [playbackDialogVisible, setPlaybackDialogVisible] = useState(false);
  const [pendingPlayParams, setPendingPlayParams] = useState({ si: 0, vi: 0 });
  const quranPlayingRef = useRef(false);
  const soundRef = useRef(null);
  const surahsRef = useRef([]);

  useFocusEffect(
    useCallback(() => {
      const entry = SystemBars.pushStackEntry({ style: 'dark' });
      const { DeviceEventEmitter } = require('react-native');
      DeviceEventEmitter.emit('pauseAllVideos');
      return () => SystemBars.popStackEntry(entry);
    }, [])
  );

  useEffect(() => {
    async function loadResumePosition() {
      try {
        const saved = await AsyncStorage.getItem('quran_resume_position');
        if (saved) setResumePosition(JSON.parse(saved));
      } catch (_) {}
    }
    loadResumePosition();
  }, []);

  useEffect(() => {
    loadSurahs();
  }, []);

    async function loadSurahs() {
    try {
      setError(null);

      // Fast path: load from cache first
      const raw = await AsyncStorage.getItem(SURAHS_CACHE_KEY);
      if (raw) {
        const { data, timestamp } = JSON.parse(raw);
        const isExpired = Date.now() - timestamp > SURAHS_CACHE_TTL;
        if (!isExpired && data?.length > 0) {
          setSurahs(data);
          surahsRef.current = data;
          setFiltered(data);
          setLoading(false);
          // Don't refresh in background — Quran list never changes
          return;
        }
      }

      // Slow path: no cache — fetch from API
      setLoading(true);
      const data = await fetchSurahs();
      setSurahs(data);
      surahsRef.current = data;
      setFiltered(data);

      await AsyncStorage.setItem(SURAHS_CACHE_KEY, JSON.stringify({
        data,
        timestamp: Date.now(),
      }));

    } catch (e) {
      setError('Could not load surahs. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  async function playAudioUntilDone(sound) {
    return new Promise((resolve) => {
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.didJustFinish) {
          resolve('finished');
          return;
        }
        if (st.isLoaded && !st.isPlaying && st.positionMillis > 0) {
          resolve('stopped');
          return;
        }
      });
    });
  }

  async function runPlay(startSurahIndex, startVerseIndex, mode) {
    console.log('runPlay START, mode:', mode, 'from surah:', startSurahIndex, 'verse:', startVerseIndex);
    let appStateSubscription = null;
    try {
      quranPlayingRef.current = true;

      if (mode === 'background') {
        appStateSubscription = AppState.addEventListener('change', (state) => {
          console.log('AppState:', state, '- background mode keeps playing');
        });
      } else if (mode === 'lock') {
        appStateSubscription = AppState.addEventListener('change', (state) => {
          console.log('AppState:', state, '- lock mode keeps playing');
        });
      }

      setIsPlayingQuran(true);

      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: mode === 'lock' || mode === 'background',
        shouldDuckAndroid: true,
      });

      const allSurahs = surahsRef.current;

      for (let s = startSurahIndex; s < allSurahs.length; s++) {
        if (!quranPlayingRef.current) break;
        const surah = allSurahs[s];

        let verses;
        try {
          verses = await fetchVerses(surah.id);
          console.log('Surah', surah.id, 'verses:', verses?.length);
        } catch (e) {
          console.log('fetchVerses failed:', e.message);
          continue;
        }

        const startV = s === startSurahIndex ? startVerseIndex : 0;

        if (startV === 0 && surah.id !== 1 && surah.id !== 9) {
          try {
            const bismillahUrl = await fetchVerseAudioUrl('1:1');
            const { sound: bSound } = await Audio.Sound.createAsync(
              { uri: bismillahUrl },
              { shouldPlay: true }
            );
            soundRef.current = bSound;
            await playAudioUntilDone(bSound);
            await bSound.unloadAsync();
            soundRef.current = null;
          } catch (e) {
            console.log('Bismillah error:', e.message);
          }
          if (!quranPlayingRef.current) {
            await AsyncStorage.setItem('quran_resume_position', JSON.stringify({
              surahIndex: s,
              verseIndex: 0,
              surahName: surah.name_simple,
            }));
            setResumePosition({ surahIndex: s, verseIndex: 0, surahName: surah.name_simple });
            break;
          }
        }

        for (let i = startV; i < verses.length; i++) {
          if (!quranPlayingRef.current) {
            await AsyncStorage.setItem('quran_resume_position', JSON.stringify({
              surahIndex: s,
              verseIndex: i,
              surahName: surah.name_simple,
            }));
            setResumePosition({ surahIndex: s, verseIndex: i, surahName: surah.name_simple });
            break;
          }

          const verseKey = verses[i].verse_key;
          const url = await fetchVerseAudioUrl(verseKey);
          console.log('Playing verse:', verseKey, 'URL:', url);

          try {
            const { sound } = await Audio.Sound.createAsync(
              { uri: url },
              { shouldPlay: true }
            );
            soundRef.current = sound;
            const reason = await playAudioUntilDone(sound);
            console.log('Audio ended:', reason, 'for verse', verseKey);
            await sound.unloadAsync();
            soundRef.current = null;

            if (!quranPlayingRef.current) {
              await AsyncStorage.setItem('quran_resume_position', JSON.stringify({
                surahIndex: s,
                verseIndex: i,
                surahName: surah.name_simple,
              }));
              setResumePosition({ surahIndex: s, verseIndex: i, surahName: surah.name_simple });
              break;
            }
          } catch (audioError) {
            console.log('Audio error:', audioError.message);
            continue;
          }
        }

        if (!quranPlayingRef.current) break;
      }

      if (appStateSubscription) appStateSubscription.remove();
      setIsPlayingQuran(false);
      quranPlayingRef.current = false;
    } catch (e) {
      if (appStateSubscription) appStateSubscription.remove();
      console.log('runPlay error:', e.message);
      setIsPlayingQuran(false);
      quranPlayingRef.current = false;
    }
  }

  function playEntireQuran(startSurahIndex = 0, startVerseIndex = 0) {
    if (surahs.length === 0) return;

    if (isPlayingQuran) {
      quranPlayingRef.current = false;
      if (soundRef.current) {
        soundRef.current.stopAsync();
      }
      return;
    }

    const si = typeof startSurahIndex === 'number' ? startSurahIndex : 0;
    const vi = typeof startVerseIndex === 'number' ? startVerseIndex : 0;

    setPendingPlayParams({ si, vi });
    setPlaybackDialogVisible(true);
  }

  function handleModeSelect(mode) {
    const { si, vi } = pendingPlayParams;
    runPlay(si, vi, mode);
  }

  const handleSearch = useCallback(
    (text) => {
      setSearch(text);
      if (!text.trim()) {
        setFiltered(surahs);
        return;
      }
      const q = text.toLowerCase();
      setFiltered(
        surahs.filter(
          (s) =>
            s.name_simple.toLowerCase().includes(q) ||
            s.translated_name?.name?.toLowerCase().includes(q) ||
            String(s.id).includes(q)
        )
      );
    },
    [surahs]
  );

  const renderSurah = useCallback(({ item }) => (
    <TouchableOpacity
      style={styles.surahRow}
      onPress={() => navigation.navigate('QuranReader', { surah: item })}
      activeOpacity={0.75}
    >
      <View style={styles.numberBadge}>
        <Text style={styles.numberText}>{item.id}</Text>
      </View>
      <View style={styles.surahInfo}>
        <Text style={styles.surahName}>{item.name_simple}</Text>
        <Text style={styles.surahMeta}>
          {item.translated_name?.name} · {item.verses_count} verses
        </Text>
      </View>
      <View style={styles.surahRight}>
        <Text style={styles.arabicName}>{item.name_arabic}</Text>
        <Text style={[styles.revelationType, { color: REVELATION_COLORS[item.revelation_place] ?? '#888' }]}>
          {item.revelation_place}
        </Text>
      </View>
    </TouchableOpacity>
  ), []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#000" />
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>Al-Quran</Text>
          <Text style={styles.headerSub}>Read · Memorize · Recite</Text>
        </View>
        <TouchableOpacity
          onPress={() => playEntireQuran()}
          disabled={loading || surahs.length === 0}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: isPlayingQuran ? '#e53935' : COLORS.gold,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 16,
            opacity: (loading || surahs.length === 0) ? 0.5 : 1,
          }}
        >
          <Ionicons name={isPlayingQuran ? 'stop' : 'play'} size={14} color="#000" />
          <Text style={{ color: '#000', fontWeight: '700', fontSize: 12, marginLeft: 4 }}>
            {isPlayingQuran ? 'Stop' : 'Play All'}
          </Text>
        </TouchableOpacity>
      </View>

      {resumePosition && !isPlayingQuran && (
        <TouchableOpacity
          onPress={() => playEntireQuran(resumePosition.surahIndex, resumePosition.verseIndex)}
          style={styles.resumeBanner}
        >
          <Ionicons name="play-circle" size={20} color="#000" />
          <Text style={styles.resumeText}>Continue from {resumePosition.surahName}</Text>
          <TouchableOpacity onPress={async () => {
            await AsyncStorage.removeItem('quran_resume_position');
            setResumePosition(null);
          }}>
            <Ionicons name="close-circle" size={18} color="#666" />
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color="#aaa" style={{ marginRight: 8 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search surah name or number..."
          placeholderTextColor="#888"
          value={search}
          onChangeText={handleSearch}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => handleSearch('')}>
            <Ionicons name="close-circle" size={18} color="#aaa" />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.gold} size="large" />
          <Text style={styles.loadingText}>Loading surahs...</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="wifi-outline" size={48} color="#555" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={loadSurahs}>
            <Text style={styles.retryText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderSurah}
          contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={isLowEndDevice ? 8 : 15}
          maxToRenderPerBatch={isLowEndDevice ? 8 : 15}
          windowSize={isLowEndDevice ? 5 : 21}
        />
      )}

      <PlaybackModeDialog
        visible={playbackDialogVisible}
        onSelect={handleModeSelect}
        onDismiss={() => setPlaybackDialogVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#000', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  headerSub: { color: '#666', fontSize: 12, textAlign: 'center', marginTop: 2 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#f5f5f5',
    margin: 12, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
  },
  searchInput: { flex: 1, color: '#000', fontSize: 14, padding: 0 },
  surahRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  numberBadge: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: '#f5f5f5',
    alignItems: 'center', justifyContent: 'center', marginRight: 14,
  },
  numberText: { color: COLORS.gold ?? '#c9a84c', fontSize: 13, fontWeight: '700' },
  surahInfo: { flex: 1 },
  surahName: { color: '#000', fontSize: 15, fontWeight: '600' },
  surahMeta: { color: '#666', fontSize: 12, marginTop: 3 },
  surahRight: { alignItems: 'flex-end' },
  arabicName: { color: '#000', fontSize: 18, fontWeight: '500' },
  revelationType: { fontSize: 11, marginTop: 4, fontWeight: '500' },
  separator: { height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginHorizontal: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#666', fontSize: 14, marginTop: 12 },
  errorText: { color: '#666', fontSize: 14, textAlign: 'center', paddingHorizontal: 32, marginBottom: 12 },
  retryBtn: { marginTop: 12, backgroundColor: COLORS.gold ?? '#c9a84c', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20 },
  retryText: { color: '#000', fontWeight: '700', fontSize: 14 },
  resumeBanner: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.gold ?? '#c9a84c',
    marginHorizontal: 12, marginBottom: 4, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
  },
  resumeText: { flex: 1, color: '#000', fontWeight: '600', fontSize: 13, marginLeft: 8 },
});