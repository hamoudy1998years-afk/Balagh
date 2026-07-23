import { View, Text, StyleSheet, TouchableOpacity, TextInput } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useState, useEffect, useCallback } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { SystemBars } from 'react-native-edge-to-edge';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS } from '../constants/theme';
import { submitVideoFeedback, submitBugReport } from '../services/feedbackApi';

export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [feedbackGiven, setFeedbackGiven] = useState(false);
  const [feedbackAnswer, setFeedbackAnswer] = useState(null);
  const [checkingFeedback, setCheckingFeedback] = useState(true);
  const [showBugDialog, setShowBugDialog] = useState(false);
  const [bugText, setBugText] = useState('');
  const [bugSubmitted, setBugSubmitted] = useState(false);

  useFocusEffect(
    useCallback(() => {
      const entry = SystemBars.pushStackEntry({ style: 'light' });
      return () => SystemBars.popStackEntry(entry);
    }, [])
  );

  useEffect(() => {
    checkFeedbackStatus();
  }, []);

  async function checkFeedbackStatus() {
    try {
      const given = await AsyncStorage.getItem('videoFeedbackGiven');
      const answer = await AsyncStorage.getItem('videoFeedbackAnswer');
      if (given === 'true') {
        setFeedbackGiven(true);
        setFeedbackAnswer(answer === 'yes');
      }
    } catch (e) {}
    setCheckingFeedback(false);
  }

  async function handleBugReport() {
    if (!bugText.trim()) return;
    setBugSubmitted(true);
    submitBugReport(bugText.trim());
    setTimeout(() => {
      setShowBugDialog(false);
      setBugText('');
      setBugSubmitted(false);
    }, 1500);
  }
  async function handleFeedback(wantsVideos) {
    setFeedbackGiven(true);
    setFeedbackAnswer(wantsVideos);
    try {
      await AsyncStorage.setItem('videoFeedbackGiven', 'true');
      await AsyncStorage.setItem('videoFeedbackAnswer', wantsVideos ? 'yes' : 'no');
    } catch (e) {}
    submitVideoFeedback(wantsVideos);
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#f0f2f5' }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <View style={[styles.header, { paddingTop: insets.top + 20 }]}>
          <Text style={styles.headerSub}>BISMILLAH</Text>
          <Text style={styles.screenTitle}>Bushrann</Text>
          <Text style={styles.headerTagline}>Your companion for Salah & Quran</Text>
        </View>

        <View style={styles.readyCard}>
          <Text style={styles.readyEmoji}>🤲</Text>
          <Text style={styles.readyTitle}>Prayer Times & Quran, ready for you now</Text>
          <Text style={styles.readySub}>Everything below works fully — no sign-up needed.</Text>

          <View style={styles.quickLinks}>
            <TouchableOpacity style={styles.quickLinkCard} onPress={() => navigation.navigate('Prayer')}>
              <Text style={styles.quickLinkEmoji}>🕌</Text>
              <Text style={styles.quickLinkTitle}>Prayer Times</Text>
              <Text style={styles.quickLinkSub}>Qibla · Adhan · Notifications</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.quickLinkCard} onPress={() => navigation.navigate('Quran')}>
              <Text style={styles.quickLinkEmoji}>📖</Text>
              <Text style={styles.quickLinkTitle}>Quran</Text>
              <Text style={styles.quickLinkSub}>Read · Memorize · Listen</Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={styles.reportBtn}
          onPress={() => setShowBugDialog(true)}
        >
          <Text style={styles.reportEmoji}>🐛</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.reportTitle}>Report a Problem</Text>
            <Text style={styles.reportSub}>Found a bug? Tell us here</Text>
          </View>
          <Text style={styles.reportArrow}>›</Text>
        </TouchableOpacity>

        {!checkingFeedback && (
          <View style={styles.feedbackCard}>
            {!feedbackGiven ? (
              <>
                <Text style={styles.feedbackEmoji}>🎬</Text>
                <Text style={styles.feedbackQuestion}>
                  Would you also like to watch short, beneficial Islamic videos right here — like TikTok, but halal?
                </Text>
                <Text style={styles.feedbackSub}>Tell us and we'll build it next.</Text>
                <TouchableOpacity style={styles.feedbackBtnYes} onPress={() => handleFeedback(true)}>
                  <Text style={styles.feedbackBtnYesText}>✅ Yes, I'd watch that</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.feedbackBtnNo} onPress={() => handleFeedback(false)}>
                  <Text style={styles.feedbackBtnNoText}>Not really interested</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.feedbackEmoji}>{feedbackAnswer ? '🎉' : '🙏'}</Text>
                <Text style={styles.feedbackThanks}>
                  {feedbackAnswer
                    ? "Thank you! We'll let you know when halal short videos launch."
                    : "Thanks for your honest feedback — we'll keep improving Prayer & Quran."}
                </Text>
              </>
            )}
          </View>
        )}

        {showBugDialog && (
          <View style={styles.bugDialogOverlay}>
            <View style={styles.bugDialog}>
              {!bugSubmitted ? (
                <>
                  <Text style={styles.bugDialogTitle}>🐛 Report a Problem</Text>
                  <Text style={styles.bugDialogSub}>Describe what went wrong:</Text>
                  <TextInput
                    style={styles.bugInput}
                    multiline
                    numberOfLines={4}
                    placeholder="e.g. Prayer times not loading..."
                    placeholderTextColor="#aaa"
                    value={bugText}
                    onChangeText={setBugText}
                    autoFocus
                  />
                  <View style={styles.bugDialogButtons}>
                    <TouchableOpacity style={styles.bugDialogCancel} onPress={() => { setShowBugDialog(false); setBugText(''); }}>
                      <Text style={styles.bugDialogCancelText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.bugDialogSend} onPress={handleBugReport}>
                      <Text style={styles.bugDialogSendText}>Send</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <View style={{ alignItems: 'center', padding: 20 }}>
                  <Text style={{ fontSize: 40, marginBottom: 12 }}>✅</Text>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: '#1a2e44' }}>Thank you!</Text>
                  <Text style={{ fontSize: 13, color: '#888', marginTop: 6, textAlign: 'center' }}>The developer has seen your report and is now working on it. 🙏</Text>
                </View>
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: '#1a2e44', borderBottomLeftRadius: 24, borderBottomRightRadius: 24,
    padding: 20, paddingBottom: 28, marginBottom: 16,
  },
  headerSub: { fontSize: 11, color: 'rgba(255,255,255,0.6)', letterSpacing: 1.5, marginBottom: 4 },
  screenTitle: { fontSize: 28, fontWeight: '800', color: '#ffffff', marginBottom: 6 },
  headerTagline: { fontSize: 13, color: 'rgba(255,255,255,0.7)' },

  readyCard: {
    backgroundColor: '#ffffff', borderRadius: 16, padding: 12, marginHorizontal: 16, marginBottom: 12,
    alignItems: 'center', borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.08)',
  },
  readyEmoji: { fontSize: 24, marginBottom: 4 },
  readyTitle: { fontSize: 14, fontWeight: '700', color: '#1a2e44', textAlign: 'center', marginBottom: 3 },
  readySub: { fontSize: 11, color: '#888', textAlign: 'center', marginBottom: 10 },

  quickLinks: { flexDirection: 'row', gap: 12, width: '100%' },
  quickLinkCard: {
    flex: 1, backgroundColor: 'rgba(201,168,76,0.08)', borderRadius: 14, padding: 10,
    alignItems: 'center', borderWidth: 1, borderColor: 'rgba(201,168,76,0.25)',
  },
  quickLinkEmoji: { fontSize: 20, marginBottom: 3 },
  quickLinkTitle: { fontSize: 14, fontWeight: '700', color: '#1a2e44', marginBottom: 2 },
  quickLinkSub: { fontSize: 11, color: '#888', textAlign: 'center' },

  feedbackCard: {
    backgroundColor: '#ffffff', borderRadius: 20, padding: 22, marginHorizontal: 16, marginBottom: 16,
    alignItems: 'center', borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.08)',
  },
  feedbackEmoji: { fontSize: 34, marginBottom: 10 },
  feedbackQuestion: { fontSize: 16, fontWeight: '700', color: '#1a2e44', textAlign: 'center', lineHeight: 23, marginBottom: 6 },
  feedbackSub: { fontSize: 12, color: '#888', textAlign: 'center', marginBottom: 18 },
  feedbackBtnYes: {
    backgroundColor: COLORS.gold, borderRadius: 14, paddingVertical: 14,
    width: '100%', alignItems: 'center', marginBottom: 10,
  },
  feedbackBtnYesText: { color: '#1a2e44', fontWeight: '700', fontSize: 15 },
  feedbackBtnNo: {
    borderRadius: 14, paddingVertical: 14, width: '100%', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)', backgroundColor: 'rgba(0,0,0,0.02)',
  },
  feedbackBtnNoText: { color: '#555', fontWeight: '600', fontSize: 14 },
  feedbackThanks: { fontSize: 15, fontWeight: '600', color: '#1a2e44', textAlign: 'center', lineHeight: 22 },
  reportBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#ffffff', borderRadius: 16,
    padding: 16, marginHorizontal: 16, marginBottom: 16,
    borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.08)',
  },
  reportEmoji: { fontSize: 22, marginRight: 12 },
  reportTitle: { fontSize: 14, fontWeight: '700', color: '#1a2e44' },
  reportSub: { fontSize: 12, color: '#888', marginTop: 2 },
  reportArrow: { fontSize: 18, color: '#ccc', fontWeight: '400' },

  bugDialogOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999,
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  bugDialog: {
    backgroundColor: '#fff', borderRadius: 24, padding: 24, width: '100%',
    borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)',
  },
  bugDialogTitle: { fontSize: 18, fontWeight: '700', color: '#1a2e44', marginBottom: 8 },
  bugDialogSub: { fontSize: 13, color: '#888', marginBottom: 16 },
  bugInput: {
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)', borderRadius: 12,
    padding: 14, fontSize: 14, color: '#1a2e44', minHeight: 100,
    textAlignVertical: 'top', marginBottom: 16, backgroundColor: '#f9f9f9',
  },
  bugDialogButtons: { flexDirection: 'row', gap: 10 },
  bugDialogCancel: {
    flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)', backgroundColor: 'rgba(0,0,0,0.03)',
  },
  bugDialogCancelText: { color: '#555', fontWeight: '600', fontSize: 14 },
  bugDialogSend: {
    flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
    backgroundColor: COLORS.gold,
  },
  bugDialogSendText: { color: '#1a2e44', fontWeight: '700', fontSize: 14 },
});