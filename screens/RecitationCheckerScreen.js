// ─────────────────────────────────────────────
//  RecitationCheckerScreen.js
//  Features:
//    • Shows the verse to recite
//    • Records user's voice via expo-av
//    • Sends audio to OpenAI Whisper API
//    • Compares transcription with correct Arabic
//    • Shows word-by-word feedback (correct / wrong / missing)
//
//  Requires: EXPO_PUBLIC_OPENAI_KEY in your .env
// ─────────────────────────────────────────────

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { COLORS } from '../constants/theme';
import { isLowEndDevice } from '../utils/deviceInfo';

const GOLD = COLORS.gold ?? '#c9a84c';
const OPENAI_KEY = process.env.EXPO_PUBLIC_OPENAI_KEY;

// ── Scoring helpers ────────────────────────────────────────────────────────

function tokenize(text) {
  // Remove diacritics (tashkeel) and split to words
  return text
    .replace(/[\u064B-\u065F\u0670]/g, '') // strip diacritics
    .replace(/[^\u0600-\u06FF\s]/g, '')     // keep Arabic letters + spaces
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function scoreRecitation(expected, transcribed) {
  const expWords = tokenize(expected);
  const transWords = tokenize(transcribed);

  // Simple word-matching (order-sensitive)
  const results = expWords.map((word, i) => ({
    word,
    status: transWords[i] === word ? 'correct' : transWords[i] ? 'wrong' : 'missing',
    heard: transWords[i] ?? null,
  }));

  const correct = results.filter((r) => r.status === 'correct').length;
  const score = expWords.length > 0 ? Math.round((correct / expWords.length) * 100) : 0;

  return { results, score, correct, total: expWords.length };
}

function getScoreColor(score) {
  if (score >= 90) return '#4caf50';
  if (score >= 70) return GOLD;
  return '#e57373';
}

function getScoreLabel(score) {
  if (score === 100) return 'Perfect! MashaAllah! 🌟';
  if (score >= 90) return 'Excellent! Keep it up!';
  if (score >= 70) return 'Good effort! Practice more.';
  if (score >= 50) return 'Keep practicing, you\'ll get there.';
  return 'Review this verse and try again.';
}

// ── Main Screen ────────────────────────────────────────────────────────────

export default function RecitationCheckerScreen({ navigation, route }) {
  const { verseKey, arabicText, translation, surahName } = route.params;
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState('ready'); // ready | countdown | recording | processing | result
  const [countdown, setCountdown] = useState(3);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [result, setResult] = useState(null);

  const recordingRef = useRef(null);
  const durationInterval = useRef(null);
  const pulseAnim = useRef(isLowEndDevice ? null : new Animated.Value(1)).current;

  useEffect(() => {
    return () => {
      // Cleanup
      clearInterval(durationInterval.current);
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, []);

  // Pulsing animation for recording
  useEffect(() => {
    if (phase === 'recording' && !isLowEndDevice) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.2, duration: 700, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
        ])
      ).start();
    } else {
      if (pulseAnim) {
        pulseAnim.stopAnimation();
        pulseAnim.setValue(1);
      }
    }
  }, [phase]);

  async function startCountdown() {
    if (!OPENAI_KEY) {
      Alert.alert(
        'API Key Missing',
        'Add EXPO_PUBLIC_OPENAI_KEY to your .env file to use the recitation checker.',
        [{ text: 'OK' }]
      );
      return;
    }
    setPhase('countdown');
    setCountdown(3);
    let count = 3;
    const interval = setInterval(() => {
      count -= 1;
      setCountdown(count);
      if (count === 0) {
        clearInterval(interval);
        startRecording();
      }
    }, 1000);
  }

  async function startRecording() {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Microphone access is required to check your recitation.');
        setPhase('ready');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      recordingRef.current = recording;
      setPhase('recording');
      setRecordingDuration(0);

      durationInterval.current = setInterval(() => {
        setRecordingDuration((d) => d + 1);
      }, 1000);
    } catch (e) {
      Alert.alert('Error', 'Could not start recording. Please try again.');
      setPhase('ready');
    }
  }

  async function stopRecording() {
    clearInterval(durationInterval.current);
    setPhase('processing');

    try {
      const recording = recordingRef.current;
      if (!recording) return;

      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      recordingRef.current = null;

      // Reset audio mode
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

      await sendToWhisper(uri);
    } catch (e) {
      Alert.alert('Error', 'Recording failed. Please try again.');
      setPhase('ready');
    }
  }

  async function sendToWhisper(audioUri) {
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: audioUri,
        type: 'audio/m4a',
        name: 'recitation.m4a',
      });
      formData.append('model', 'whisper-1');
      formData.append('language', 'ar'); // Force Arabic for accuracy

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message ?? 'Whisper API error');
      }

      const data = await response.json();
      const transcribed = data.text ?? '';

      const scored = scoreRecitation(arabicText, transcribed);
      setResult({ ...scored, transcribed });
      setPhase('result');
    } catch (e) {
      Alert.alert('AI Error', e.message || 'Could not analyze your recitation.');
      setPhase('ready');
    }
  }

  function reset() {
    setResult(null);
    setPhase('ready');
    setRecordingDuration(0);
  }

  // ── Render phases ──────────────────────────────────────────────────────

  const renderReady = () => (
    <View style={styles.center}>
      <TouchableOpacity style={styles.micBtn} onPress={startCountdown}>
        <Ionicons name="mic" size={40} color="#fff" />
      </TouchableOpacity>
      <Text style={styles.tapToRecord}>Tap to start reciting</Text>
      <Text style={styles.tapSubtext}>You'll get a 3-second countdown</Text>
    </View>
  );

  const renderCountdown = () => (
    <View style={styles.center}>
      <Text style={styles.countdownNumber}>{countdown}</Text>
      <Text style={styles.countdownText}>Get ready to recite...</Text>
    </View>
  );

  const renderRecording = () => (
    <View style={styles.center}>
      <Animated.View style={[styles.recordingOrb, isLowEndDevice ? null : { transform: [{ scale: pulseAnim }] }]}>
        <Ionicons name="mic" size={40} color="#fff" />
      </Animated.View>
      <Text style={styles.recordingLabel}>Recording... {recordingDuration}s</Text>
      {/* ADDED: Stop button */}
      <TouchableOpacity style={styles.stopBtn} onPress={stopRecording}>
        <Ionicons name="stop" size={20} color="#fff" />
        <Text style={styles.stopBtnText}>Stop & Analyze</Text>
      </TouchableOpacity>
    </View>
  );

  const renderProcessing = () => (
    <View style={styles.center}>
      <ActivityIndicator color={GOLD} size="large" />
      <Text style={styles.processingText}>Analyzing your recitation with AI...</Text>
    </View>
  );

  const renderResult = () => {
    if (!result) return null;
    const scoreColor = getScoreColor(result.score);

    return (
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Score ring */}
        <View style={styles.scoreSection}>
          <View style={[styles.scoreRing, { borderColor: scoreColor }]}>
            <Text style={[styles.scoreNumber, { color: scoreColor }]}>{result.score}%</Text>
            <Text style={styles.scoreUnit}>score</Text>
          </View>
          <Text style={[styles.scoreLabel, { color: scoreColor }]}>
            {getScoreLabel(result.score)}
          </Text>
          <Text style={styles.scoreStats}>
            {result.correct} of {result.total} words correct
          </Text>
        </View>

        {/* Word-by-word breakdown */}
        <View style={styles.breakdownCard}>
          <Text style={styles.breakdownTitle}>Word-by-Word Breakdown</Text>
          <View style={styles.wordsRow}>
            {result.results.map((r, i) => (
              <View key={i} style={[styles.wordItem, { margin: 5 }]}>
                <Text
                  style={[
                    styles.wordArabic,
                    r.status === 'correct' && styles.wordCorrect,
                    r.status === 'wrong' && styles.wordWrong,
                    r.status === 'missing' && styles.wordMissing,
                  ]}
                >
                  {r.word}
                </Text>
                <Ionicons
                  name={
                    r.status === 'correct'
                      ? 'checkmark-circle'
                      : r.status === 'wrong'
                      ? 'close-circle'
                      : 'ellipse-outline'
                  }
                  size={14}
                  color={
                    r.status === 'correct' ? '#4caf50' : r.status === 'wrong' ? '#e57373' : '#555'
                  }
                  style={{ marginTop: 4 }}
                />
              </View>
            ))}
          </View>
        </View>

        {/* What Whisper heard */}
        {result.transcribed ? (
          <View style={styles.transcribedCard}>
            <Text style={styles.transcribedLabel}>What AI heard:</Text>
            <Text style={styles.transcribedText}>{result.transcribed}</Text>
          </View>
        ) : null}

        {/* Try again */}
        <TouchableOpacity style={styles.tryAgainBtn} onPress={reset}>
          <Ionicons name="refresh" size={18} color="#000" />
          <Text style={styles.tryAgainText}>Try Again</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Recitation Check</Text>
          <Text style={styles.headerSub}>{surahName} · {verseKey}</Text>
        </View>
      </View>

      {/* Verse display */}
      <View style={styles.verseCard}>
        <Text style={styles.verseArabic}>{arabicText}</Text>
        <Text style={styles.verseTranslation} numberOfLines={3}>{translation}</Text>
      </View>

      {/* Legend */}
      {phase === 'result' && (
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#4caf50' }]} />
            <Text style={styles.legendText}>Correct</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#e57373' }]} />
            <Text style={styles.legendText}>Wrong</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#555' }]} />
            <Text style={styles.legendText}>Missing</Text>
          </View>
        </View>
      )}

      {/* Phase content */}
      <View style={styles.phaseContainer}>
        {phase === 'ready' && renderReady()}
        {phase === 'countdown' && renderCountdown()}
        {phase === 'recording' && renderRecording()}
        {phase === 'processing' && renderProcessing()}
        {phase === 'result' && renderResult()}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#000', fontSize: 16, fontWeight: '700' },
  headerSub: { color: '#666', fontSize: 12, marginTop: 2 },
  verseCard: {
    backgroundColor: '#f5f5f5',
    margin: 12,
    borderRadius: 14,
    padding: 16,
  },
  verseArabic: {
    color: '#000',
    fontSize: 22,
    textAlign: 'right',
    lineHeight: 40,
    marginBottom: 10,
  },
  verseTranslation: {
    color: '#444',
    fontSize: 13,
    lineHeight: 20,
  },
  legend: {
    flexDirection: 'row',
    justifyContent: 'center',
    // gap: 20, // REMOVED
    paddingBottom: 8,
  },
  legendItem: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    // gap: 6, // REMOVED
    marginHorizontal: 10, // ADDED — replaces legend gap
  },
  legendDot: { 
    width: 10, 
    height: 10, 
    borderRadius: 5,
    marginRight: 6, // ADDED — replaces legendItem gap
  },
  legendText: { color: '#666', fontSize: 12 },
  phaseContainer: { flex: 1, padding: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  micBtn: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: COLORS.gold ?? '#c9a84c',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
    shadowColor: COLORS.gold ?? '#c9a84c',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    marginBottom: 16, // ADDED
  },
  tapToRecord: { color: '#000', fontSize: 18, fontWeight: '600', marginTop: 16, marginBottom: 4 },
  tapSubtext: { color: '#666', fontSize: 13 },
  countdownNumber: {
    color: COLORS.gold ?? '#c9a84c',
    fontSize: 80,
    fontWeight: '800',
    marginBottom: 12,
  },
  countdownText: { color: '#444', fontSize: 16 },
  recordingOrb: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#e53935',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingLabel: { color: '#e53935', fontSize: 16, fontWeight: '600', marginTop: 12, marginBottom: 16 },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    // gap: 8, // REMOVED
    backgroundColor: '#f5f5f5',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 28,
  },
  stopBtnText: { 
    color: '#000', 
    fontSize: 15, 
    fontWeight: '600',
    marginLeft: 8, // ADDED — replaces gap
  },
  processingText: { color: '#444', fontSize: 15, textAlign: 'center', marginTop: 12 },

  // Result styles
  scoreSection: { 
    alignItems: 'center', 
    paddingVertical: 20,
    // gap: 8, // REMOVED
  },
  scoreRing: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8, // ADDED — replaces gap
  },
  scoreNumber: { fontSize: 32, fontWeight: '800' },
  scoreUnit: { color: '#666', fontSize: 12 },
  scoreLabel: { 
    fontSize: 16, 
    fontWeight: '700', 
    textAlign: 'center',
    marginTop: 8, // ADDED — replaces gap
  },
  scoreStats: { 
    color: '#666', 
    fontSize: 13,
    marginTop: 8, // ADDED — replaces gap
  },
  breakdownCard: {
    backgroundColor: '#f5f5f5',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
  },
  breakdownTitle: {
    color: '#444',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 14,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  wordsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end', // RTL
  },
  wordItem: { alignItems: 'center', margin: 5 },
  wordArabic: { fontSize: 18, color: '#555' },
  wordCorrect: { color: '#4caf50' },
  wordWrong: { color: '#e57373' },
  wordMissing: { color: '#555' },
  transcribedCard: {
    backgroundColor: '#f5f5f5',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
  },
  transcribedLabel: { color: '#666', fontSize: 12, marginBottom: 8, fontWeight: '600' },
  transcribedText: { color: '#ccc', fontSize: 16, textAlign: 'right', lineHeight: 28 },
  tryAgainBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    // gap: 8, // REMOVED
    backgroundColor: COLORS.gold ?? '#c9a84c',
    paddingVertical: 16,
    borderRadius: 28,
    marginBottom: 20,
  },
  tryAgainText: { 
    color: '#000', 
    fontSize: 16, 
    fontWeight: '700',
    marginLeft: 8, // ADDED — replaces gap
  },
});
