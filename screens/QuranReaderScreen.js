// ─────────────────────────────────────────────
//  QuranReaderScreen.js
//  Features:
//    • Read all verses with Arabic + translation
//    • Memorize Mode: hide Arabic → reveal on tap
//    • Audio: play individual verse (Alafasy)
//    • Progress: tracks memorized verses via AsyncStorage
// ─────────────────────────────────────────────

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  Alert,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { useFocusEffect } from '@react-navigation/native';
import { SystemBars } from 'react-native-edge-to-edge';
import { fetchVerses, fetchVerseAudioUrl } from '../services/quranApi';
import { COLORS } from '../constants/theme';

const GOLD = COLORS.gold ?? '#c9a84c';
const STORAGE_KEY = (surahId) => `quran_memorized_${surahId}`;

export default function QuranReaderScreen({ navigation, route }) {
  const { surah } = route.params;
  const insets = useSafeAreaInsets();

  const [verses, setVerses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [memorizeMode, setMemorizeMode] = useState(false);
  const [memorizedKeys, setMemorizedKeys] = useState(new Set());
  const [revealedKeys, setRevealedKeys] = useState(new Set());
  const [playingKey, setPlayingKey] = useState(null);
  const [isPlayingSurah, setIsPlayingSurah] = useState(false);
  const surahPlayingRef = useRef(false);
  const soundRef = useRef(null);

  useFocusEffect(
    useCallback(() => {
      const entry = SystemBars.pushStackEntry({ style: 'dark' });
      return () => SystemBars.popStackEntry(entry);
    }, [])
  );

  // Load verses + saved progress
  useEffect(() => {
    loadAll();
    return () => {
      // Unload audio on unmount
      if (soundRef.current) {
        soundRef.current.unloadAsync();
      }
    };
  }, []);

  async function loadAll() {
    try {
      setLoading(true);
      const [versesData, savedRaw] = await Promise.all([
        fetchVerses(surah.id),
        AsyncStorage.getItem(STORAGE_KEY(surah.id)),
      ]);
      setVerses(versesData);
      if (savedRaw) {
        setMemorizedKeys(new Set(JSON.parse(savedRaw)));
      }
    } catch (e) {
      Alert.alert('Error', 'Could not load verses. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  // Save memorized verses to AsyncStorage
  const saveProgress = useCallback(
    async (newSet) => {
      try {
        await AsyncStorage.setItem(
          STORAGE_KEY(surah.id),
          JSON.stringify([...newSet])
        );
      } catch (_) {}
    },
    [surah.id]
  );

  // Toggle a verse as memorized
  function toggleMemorized(verseKey) {
    setMemorizedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(verseKey)) {
        next.delete(verseKey);
      } else {
        next.add(verseKey);
      }
      saveProgress(next);
      return next;
    });
  }

  // In memorize mode: tap to reveal hidden verse
  function hideVerse(verseKey) {
    setRevealedKeys((prev) => { const next = new Set(prev); next.delete(verseKey); return next; });
  }
  function revealVerse(verseKey) {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      next.add(verseKey);
      return next;
    });
  }

  // Play audio for a verse
  async function playAudio(verseKey) {
    try {
      // Stop any existing audio
      if (soundRef.current) {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
        soundRef.current = null;
        if (playingKey === verseKey) {
          setPlayingKey(null);
          return;
        }
      }

      setPlayingKey(verseKey);
      const url = await fetchVerseAudioUrl(verseKey);
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true }
      );
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          setPlayingKey(null);
          soundRef.current = null;
        }
      });
    } catch (e) {
      setPlayingKey(null);
      Alert.alert('Audio Error', 'Could not play audio for this verse.');
    }
  }

  async function playSurah() {
    if (isPlayingSurah) {
        surahPlayingRef.current = false;
        setIsPlayingSurah(false);
        if (soundRef.current) {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
        soundRef.current = null;
        }
        setPlayingKey(null);
        return;
    }
    surahPlayingRef.current = true;
    setIsPlayingSurah(true);

    // Play Bismillah first (except Surah 1 and 9)
    if (surah.id !== 1 && surah.id !== 9) {
        const bismillahUrl = await fetchVerseAudioUrl('1:1');
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound: bismillahSound } = await Audio.Sound.createAsync({ uri: bismillahUrl }, { shouldPlay: true });
        soundRef.current = bismillahSound;
        await new Promise((resolve) => {
        bismillahSound.setOnPlaybackStatusUpdate((status) => {
            if (status.didJustFinish) resolve();
        });
        });
        await bismillahSound.unloadAsync();
        soundRef.current = null;
    }

    for (let i = 0; i < verses.length; i++) {
        if (!surahPlayingRef.current) break;
        const verseKey = verses[i].verse_key;
        setPlayingKey(verseKey);
        const url = await fetchVerseAudioUrl(verseKey);
        const { sound } = await Audio.Sound.createAsync({ uri: url }, { shouldPlay: true });
        soundRef.current = sound;
        await new Promise((resolve) => {
        sound.setOnPlaybackStatusUpdate((status) => {
            if (status.didJustFinish) resolve();
        });
        });
        await sound.unloadAsync();
        soundRef.current = null;
    }
    setIsPlayingSurah(false);
    setPlayingKey(null);
    surahPlayingRef.current = false;
    }

  const memorizedCount = memorizedKeys.size;
  const totalVerses = surah.verses_count;
  const progressPct = totalVerses > 0 ? (memorizedCount / totalVerses) * 100 : 0;

  const renderVerse = ({ item, index }) => {
    const verseKey = item.verse_key;
    const isMemorized = memorizedKeys.has(verseKey);
    const isRevealed = revealedKeys.has(verseKey);
    const isPlaying = playingKey === verseKey;
    const shouldHide = memorizeMode && !isMemorized && !isRevealed;

    const translation = item.translations?.[0]?.text ?? '';
    // Strip HTML tags from translation
    const cleanTranslation = translation.replace(/<[^>]+>/g, '');

    return (
      <View style={[styles.verseCard, isMemorized && styles.verseCardMemorized]}>
        {/* Verse number + controls */}
        <View style={styles.verseHeader}>
          <View style={styles.verseNumBadge}>
            <Text style={styles.verseNum}>{item.verse_number}</Text>
          </View>
          <View style={styles.verseControls}>
            {/* Audio button */}
            <TouchableOpacity
              onPress={() => playAudio(verseKey)}
              style={styles.controlBtn}
            >
              <Ionicons
                name={isPlaying ? 'pause-circle' : 'play-circle-outline'}
                size={24}
                color={isPlaying ? GOLD : '#888'}
              />
            </TouchableOpacity>

            {/* Recitation check button */}
            <TouchableOpacity
              onPress={() =>
                navigation.navigate('RecitationChecker', {
                  verseKey,
                  arabicText: item.text_uthmani,
                  translation: cleanTranslation,
                  surahName: surah.name_simple,
                })
              }
              style={styles.controlBtn}
            >
              <Ionicons name="mic-outline" size={22} color="#888" />
            </TouchableOpacity>

            {/* Memorized toggle */}
            <TouchableOpacity
              onPress={() => toggleMemorized(verseKey)}
              style={styles.controlBtn}
            >
              <Ionicons
                name={isMemorized ? 'checkmark-circle' : 'checkmark-circle-outline'}
                size={22}
                color={isMemorized ? GOLD : '#888'}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* Arabic text */}
        {shouldHide ? (
          <Pressable onPress={() => revealVerse(verseKey)} style={styles.hiddenArabic}>
            <Ionicons name="eye-off-outline" size={20} color="#555" />
            <Text style={styles.hiddenText}>Tap to reveal</Text>
          </Pressable>
        ) : (
          <View>
            <Text style={styles.arabicText}>{item.text_uthmani}</Text>
            {isRevealed && (
              <TouchableOpacity onPress={() => hideVerse(verseKey)} style={styles.hideBtn}>
                <Ionicons name="eye-off-outline" size={14} color="#888" />
                <Text style={styles.hideBtnText}>Hide again</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Translation */}
        <Text style={styles.translationText}>{cleanTranslation}</Text>
      </View>
    );
  };

  const ListHeader = () => (
    <View>
      {/* Surah title card */}
      <View style={styles.surahHeader}>
        <Text style={styles.surahArabic}>{surah.name_arabic}</Text>
        <Text style={styles.surahEnglish}>{surah.name_simple}</Text>
        <Text style={styles.surahTranslated}>{surah.translated_name?.name}</Text>
        <Text style={styles.surahMeta}>
          {surah.verses_count} verses · {surah.revelation_place}
        </Text>
      </View>

      {/* Progress bar (visible only in memorize mode) */}
      {memorizeMode && (
        <View style={styles.progressContainer}>
          <View style={styles.progressHeader}>
            <Text style={styles.progressLabel}>Memorization Progress</Text>
            <Text style={styles.progressCount}>
              {memorizedCount}/{totalVerses}
            </Text>
          </View>
          <View style={styles.progressBar}>
            <View
              style={[styles.progressFill, { width: `${progressPct}%` }]}
            />
          </View>
        </View>
      )}

      {/* Bismillah (except Surah 1 and 9) */}
      {surah.id !== 1 && surah.id !== 9 && (
        <Text style={styles.bismillah}>بِسۡمِ ٱللَّهِ ٱلرَّحۡمَـٰنِ ٱلرَّحِیمِ</Text>
      )}
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#000" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {surah.name_simple}
        </Text>
        {/* Memorize mode toggle */}
        <TouchableOpacity
          onPress={() => {
            setRevealedKeys(new Set()); // reset revealed when toggling
            setMemorizeMode((v) => !v);
          }}
          style={[styles.modeBtn, memorizeMode && styles.modeBtnActive]}
        >
          <Ionicons
            name={memorizeMode ? 'eye-off' : 'school-outline'}
            size={18}
            color="#000"
          />
          <Text style={[styles.modeBtnText, memorizeMode && { color: '#000' }]}>
            {memorizeMode ? 'Memorize' : 'Read'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={playSurah} style={[styles.modeBtn, isPlayingSurah && styles.modeBtnActive]}>
          <Ionicons name={isPlayingSurah ? 'stop' : 'play'} size={18} color={'#000'} />
          <Text style={[styles.modeBtnText, isPlayingSurah && { color: '#000' }]}>
            {isPlayingSurah ? 'Stop' : 'Play All'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Memorize mode banner */}
      {memorizeMode && (
        <View style={styles.memorizeBanner}>
          <Ionicons name="information-circle-outline" size={16} color={GOLD} />
          <Text style={styles.memorizeBannerText}>
            Tap hidden verses to reveal · ✓ to mark memorized
          </Text>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={GOLD} size="large" />
          <Text style={styles.loadingText}>Loading {surah.name_simple}...</Text>
        </View>
      ) : (
        <FlatList
          data={verses}
          keyExtractor={(item) => item.verse_key}
          renderItem={renderVerse}
          ListHeaderComponent={ListHeader}
          contentContainerStyle={{ paddingBottom: insets.bottom + 80, paddingHorizontal: 16 }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#000',
    fontSize: 17,
    fontWeight: '700',
    flex: 1,
    textAlign: 'center',
  },
  modeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    // gap: 4, // REMOVED — React Native doesn't support gap
    backgroundColor: '#f5f5f5',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
  },
  modeBtnActive: {
    backgroundColor: COLORS.gold ?? '#c9a84c',
  },
  modeBtnText: {
    color: '#000',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 4, // ADDED — replaces gap
  },
  memorizeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    // gap: 6, // REMOVED — React Native doesn't support gap
    backgroundColor: 'rgba(201,168,76,0.12)',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  memorizeBannerText: {
    color: COLORS.gold ?? '#c9a84c',
    fontSize: 12,
    marginLeft: 6, // ADDED — replaces gap
  },
  surahHeader: {
    alignItems: 'center',
    paddingVertical: 28,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    marginBottom: 8,
  },
  surahArabic: {
    color: '#000',
    fontSize: 36,
    fontWeight: '400',
    marginBottom: 6,
  },
  surahEnglish: {
    color: '#000',
    fontSize: 22,
    fontWeight: '700',
  },
  surahTranslated: {
    color: '#444',
    fontSize: 15,
    marginTop: 4,
  },
  surahMeta: {
    color: '#666',
    fontSize: 13,
    marginTop: 6,
  },
  progressContainer: {
    marginVertical: 12,
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 14,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  progressLabel: {
    color: '#444',
    fontSize: 13,
  },
  progressCount: {
    color: COLORS.gold ?? '#c9a84c',
    fontSize: 13,
    fontWeight: '700',
  },
  progressBar: {
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    backgroundColor: COLORS.gold ?? '#c9a84c',
    borderRadius: 3,
  },
  bismillah: {
    color: COLORS.gold ?? '#c9a84c',
    fontSize: 22,
    textAlign: 'center',
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    marginBottom: 8,
  },
  verseCard: {
    backgroundColor: '#f5f5f5',
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
  },
  verseCardMemorized: {
    borderWidth: 1,
    borderColor: 'rgba(201,168,76,0.35)',
  },
  verseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  verseNumBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(201,168,76,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  verseNum: {
    color: COLORS.gold ?? '#c9a84c',
    fontSize: 13,
    fontWeight: '700',
  },
  verseControls: {
    flexDirection: 'row',
    // gap: 4, // REMOVED — React Native doesn't support gap
  },
  controlBtn: {
    padding: 6,
    marginHorizontal: 2, // ADDED — replaces gap between buttons
  },
  arabicText: {
    color: '#000',
    fontSize: 24,
    textAlign: 'right',
    lineHeight: 44,
    fontWeight: '400',
    marginBottom: 12,
  },
  hiddenArabic: {
    height: 60,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    // gap: 8, // REMOVED — React Native doesn't support gap
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderStyle: 'dashed',
  },
  hiddenText: {
    color: '#555',
    fontSize: 14,
    marginLeft: 8, // ADDED — replaces gap
  },
  hideBtn: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  hideBtnText: { color: '#888', fontSize: 12, marginLeft: 4 },
  translationText: {
    color: '#444',
    fontSize: 14,
    lineHeight: 22,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    // gap: 12, // REMOVED — React Native doesn't support gap
  },
  loadingText: {
    color: '#666',
    fontSize: 14,
    marginTop: 12, // ADDED — replaces gap (was marginTop: 8)
  },
});
