import { View, Text, StyleSheet, TextInput, ScrollView, KeyboardAvoidingView, Platform, Keyboard } from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { userCache } from '../utils/userCache';
import { COLORS } from '../constants/theme';
import { Linking } from 'react-native';
import ModernDialog from './ModernDialog';

const CATEGORIES = ['Quran', 'Hadith', 'Reminder', 'Lecture', 'Nasheeds', 'Dua', 'Other'];
const sanitize = (text) => text.replace(/<[^>]*>/g, '').trim();

export default function UploadScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [video, setVideo]         = useState(null);
  const [caption, setCaption]     = useState('');
  const [category, setCategory]   = useState('');
  const [uploading, setUploading] = useState(false);
  const [isScholar, setIsScholar] = useState(null);
  const [scholarChecked, setScholarChecked] = useState(true);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');

  const [showLiveSetup, setShowLiveSetup] = useState(false);
  const [liveTitle, setLiveTitle]         = useState('');
  const [maxQuestions, setMaxQuestions]   = useState('5');

  // ModernDialog state
  const [dialog, setDialog] = useState({ 
    visible: false, 
    title: '', 
    message: '', 
    type: 'info', 
    buttons: [] 
  });

  const scrollRef = useRef(null);
  useFocusEffect(
    useCallback(() => {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [])
  );

  const inputWrapperY = useRef(0);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => {
      setTimeout(() => {
        scrollRef.current?.scrollTo({ y: inputWrapperY.current - 388 + insets.top, animated: true });
      }, 100);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  useEffect(() => { checkIfScholarInstant(); }, []);

  const checkIfScholarInstant = useCallback(async () => {
    const cached = await userCache.get();
    if (cached?.is_scholar !== undefined) {
      setIsScholar(cached.is_scholar);
      setScholarChecked(true);
    }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from('profiles').select('is_scholar').eq('id', user.id).single();
    setIsScholar(data?.is_scholar ?? false);
    setScholarChecked(true);
  }, []);

  const pickVideo = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      setDialog({
        visible: true,
        title: 'Permission Required',
        message: 'Bushrann needs access to your gallery to upload videos.',
        type: 'warning',
        buttons: [
          { text: 'Not Now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]
      });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsEditing: false,
      quality: 1,
    });
    if (!result.canceled) setVideo(result.assets[0]);
  }, []);

  const uploadVideo = useCallback(async () => {
    if (!video) {
      setDialog({
        visible: true,
        title: 'No video',
        message: 'Please pick a video first.',
        type: 'warning',
        buttons: [{ text: 'OK' }]
      });
      return;
    }
    if (!caption.trim()) {
      setDialog({
        visible: true,
        title: 'No caption',
        message: 'Please add a caption.',
        type: 'warning',
        buttons: [{ text: 'OK' }]
      });
      return;
    }
    if (!category) {
      setDialog({
        visible: true,
        title: 'No category',
        message: 'Please select a category.',
        type: 'warning',
        buttons: [{ text: 'OK' }]
      });
      return;
    }
    const MAX_SIZE = 500 * 1024 * 1024;
    if (video.fileSize && video.fileSize > MAX_SIZE) {
      setDialog({
        visible: true,
        title: 'File Too Large',
        message: 'Please select a video under 500MB.',
        type: 'warning',
        buttons: [{ text: 'OK' }]
      });
      return;
    }

    setUploading(true);
    setProgressPercent(0);
    setProgressLabel('Uploading...');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setDialog({
        visible: true,
        title: 'Not logged in',
        message: 'Please log in to upload videos.',
        type: 'info',
        buttons: [{ text: 'OK' }]
      });
      setUploading(false);
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setDialog({
        visible: true,
        title: 'Session expired',
        message: 'Please log in again.',
        type: 'error',
        buttons: [{ text: 'OK' }]
      });
      setUploading(false);
      return;
    }

    try {
      const ext      = video.uri.split('.').pop() || 'mp4';
      const fileName = `${user.id}/${Date.now()}.${ext}`;
      const SUPABASE_URL = supabase.supabaseUrl;

      const formData = new FormData();
      formData.append('', { uri: video.uri, type: 'video/mp4', name: fileName.split('/').pop() });

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/videos/${fileName}`);
        xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
        xhr.setRequestHeader('x-upsert', 'false');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.min(Math.round((e.loaded / e.total) * 100), 99);
            setProgressPercent(pct);
            setProgressLabel('Uploading...');
          }
        };
        xhr.onload = () => {
          if (xhr.status === 200 || xhr.status === 201) resolve(JSON.parse(xhr.responseText));
          else reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`));
        };
        xhr.onerror = () => reject(new Error('Network request failed'));
        xhr.send(formData);
      });

      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/videos/${fileName}`;
      setProgressPercent(100);
      setProgressLabel('Saving...');

      const { error: dbError } = await supabase.from('videos').insert({
        user_id: user.id, caption: sanitize(caption), category,
        video_url: publicUrl, thumbnail_url: null,
      });
      if (dbError) throw dbError;

      setProgressPercent(0); setProgressLabel(''); setUploading(false);
      setVideo(null); setCaption(''); setCategory('');
      setDialog({
        visible: true,
        title: 'Success! 🎉',
        message: 'Your video has been uploaded to Bushrann!',
        type: 'success',
        buttons: [{ text: 'OK' }]
      });

    } catch (error) {
      setUploading(false); setProgressPercent(0); setProgressLabel('');
      console.error('Upload error:', error);
      setDialog({
        visible: true,
        title: 'Upload failed',
        message: error.message,
        type: 'error',
        buttons: [{ text: 'OK' }]
      });
    }
  }, [video, caption, category]);

  const handleGoLive = useCallback(() => { setShowLiveSetup(true); }, []);

  const startLiveStream = useCallback(() => {
    if (!liveTitle.trim()) {
      setDialog({
        visible: true,
        title: 'Title required',
        message: 'Please enter a title for your live stream.',
        type: 'warning',
        buttons: [{ text: 'OK' }]
      });
      return;
    }
    const max = parseInt(maxQuestions) || 5;
    setShowLiveSetup(false); setLiveTitle(''); setMaxQuestions('5');
    navigation.navigate('LiveStream', { title: liveTitle.trim(), maxQuestions: max });
  }, [liveTitle, maxQuestions, navigation]);

  if (showLiveSetup) {
    return (
      <ScrollView ref={scrollRef} style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}>
        <Text style={styles.title}>🔴 Go Live</Text>
        <Text style={styles.subtitle}>Set up your live stream</Text>

        <Text style={styles.label}>Stream Title *</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Friday Tafsir Lesson"
          placeholderTextColor="#aaaaaa"
          value={liveTitle}
          onChangeText={setLiveTitle}
          maxLength={60}
        />

        <Text style={styles.label}>Max Questions to Answer</Text>
        <Text style={styles.hint}>Viewers can submit questions. How many will you answer?</Text>
        <View style={styles.maxQuestionsRow}>
          {['3', '5', '10', '15', '20'].map(n => (
            <AnimatedButton
              key={n}
              style={[styles.qChip, maxQuestions === n && styles.qChipActive]}
              onPress={() => setMaxQuestions(n)}
            >
              <Text style={[styles.qChipText, maxQuestions === n && styles.qChipTextActive]}>{n}</Text>
            </AnimatedButton>
          ))}
        </View>

        <AnimatedButton style={styles.goLiveConfirmBtn} onPress={startLiveStream}>
          <Text style={styles.goLiveConfirmBtnText}>🔴 Start Live Stream</Text>
        </AnimatedButton>

        <AnimatedButton style={styles.cancelBtn} onPress={() => setShowLiveSetup(false)}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </AnimatedButton>

        <ModernDialog
          visible={dialog.visible}
          title={dialog.title}
          message={dialog.message}
          type={dialog.type}
          buttons={dialog.buttons}
          onDismiss={() => setDialog({ ...dialog, visible: false })}
        />
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
    <ScrollView ref={scrollRef} style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Upload Video</Text>
      <Text style={styles.subtitle}>Share your dawah with the ummah ☪️</Text>

      {isScholar === true && (
        <AnimatedButton style={styles.liveBtn} onPress={handleGoLive}>
          <Text style={styles.liveDot}>🔴</Text>
          <Text style={styles.liveBtnText}>Go Live</Text>
          <View style={styles.scholarBadge}>
            <Text style={styles.scholarBadgeText}>Scholar</Text>
          </View>
        </AnimatedButton>
      )}

      <AnimatedButton style={styles.videoPicker} onPress={pickVideo} disabled={uploading}>
        {video ? (
          <View style={styles.videoSelected}>
            <Text style={styles.videoSelectedIcon}>🎬</Text>
            <Text style={styles.videoSelectedText}>Video selected!</Text>
            <Text style={styles.videoSelectedName} numberOfLines={1}>{video.uri.split('/').pop()}</Text>
            <Text style={styles.tapToChange}>Tap to change</Text>
          </View>
        ) : (
          <View style={styles.videoPlaceholder}>
            <Text style={styles.videoPlaceholderIcon}>📹</Text>
            <Text style={styles.videoPlaceholderText}>Tap to select a video</Text>
            <Text style={styles.videoPlaceholderSub}>from your camera roll</Text>
          </View>
        )}
      </AnimatedButton>

      <Text style={styles.label}>Caption</Text>
      <View style={styles.inputWrapper} onLayout={(e) => { inputWrapperY.current = e.nativeEvent.layout.y; }}>
        <TextInput
          style={styles.input}
          placeholder="What is this video about?"
          placeholderTextColor="#aaaaaa"
          value={caption}
          onChangeText={setCaption}
          multiline
          maxLength={200}
          editable={!uploading}
        />
        <Text style={styles.charCount}>{caption.length}/200</Text>
      </View>

      <Text style={styles.label}>Category</Text>
      <View style={styles.categories}>
        {CATEGORIES.map(cat => (
          <AnimatedButton
            key={cat}
            style={[styles.categoryChip, category === cat && styles.categoryChipActive]}
            onPress={() => !uploading && setCategory(cat)}
          >
            <Text style={[styles.categoryChipText, category === cat && styles.categoryChipTextActive]}>
              {cat}
            </Text>
          </AnimatedButton>
        ))}
      </View>

      <AnimatedButton
        style={[styles.uploadBtn, uploading && styles.uploadBtnDisabled]}
        onPress={uploadVideo}
        disabled={uploading}
      >
        {uploading && (
          <View style={styles.tiktokBarBg}>
            <View style={[styles.tiktokBarFill, { width: `${progressPercent}%` }]} />
          </View>
        )}
        <View style={styles.uploadBtnContent}>
          <Text style={styles.uploadBtnText}>
            {uploading ? progressLabel : 'Upload to Bushrann ☪️'}
          </Text>
          {uploading && <Text style={styles.uploadBtnPct}>{progressPercent}%</Text>}
        </View>
      </AnimatedButton>

      {scholarChecked && isScholar === false && (
        <View style={styles.scholarInfo}>
          <Text style={styles.scholarInfoIcon}>🎓</Text>
          <Text style={styles.scholarInfoText}>
            Are you a verified Islamic scholar? Contact us to get your Scholar badge and unlock live streaming.
          </Text>
        </View>
      )}

      <ModernDialog
        visible={dialog.visible}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        buttons={dialog.buttons}
        onDismiss={() => setDialog({ ...dialog, visible: false })}
      />
    </ScrollView>
  </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:              { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 24 },
  title:                  { fontSize: 24, fontWeight: '700', color: '#111111', marginBottom: 4 },
  subtitle:               { fontSize: 14, color: '#888888', marginBottom: 28 },
  hint:                   { color: '#888888', fontSize: 12, marginBottom: 10 },
  liveBtn:                { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff5f5', borderWidth: 1, borderColor: COLORS.live, borderRadius: 14, padding: 16, marginBottom: 20, gap: 10 },
  liveDot:                { fontSize: 18 },
  liveBtnText:            { color: COLORS.live, fontSize: 16, fontWeight: '700', flex: 1 },
  scholarBadge:           { backgroundColor: COLORS.live, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  scholarBadgeText:       { color: '#fff', fontSize: 11, fontWeight: '700' },
  videoPicker:            { backgroundColor: '#f5f5f5', borderRadius: 16, borderWidth: 2, borderColor: '#e5e5e5', borderStyle: 'dashed', marginBottom: 24, overflow: 'hidden' },
  videoPlaceholder:       { padding: 40, alignItems: 'center' },
  videoPlaceholderIcon:   { fontSize: 48, marginBottom: 12 },
  videoPlaceholderText:   { color: '#111111', fontSize: 16, fontWeight: '600', marginBottom: 4 },
  videoPlaceholderSub:    { color: '#888888', fontSize: 13 },
  videoSelected:          { padding: 24, alignItems: 'center' },
  videoSelectedIcon:      { fontSize: 40, marginBottom: 8 },
  videoSelectedText:      { color: COLORS.success, fontSize: 16, fontWeight: '700', marginBottom: 4 },
  videoSelectedName:      { color: '#888888', fontSize: 12, marginBottom: 8 },
  tapToChange:            { color: '#aaaaaa', fontSize: 12 },
  label:                  { color: '#888888', fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 },
  input:                  { backgroundColor: '#f5f5f5', borderWidth: 0.5, borderColor: '#e5e5e5', borderRadius: 12, padding: 16, color: '#111111', fontSize: 15, minHeight: 80, textAlignVertical: 'top' },
  inputWrapper: { marginBottom: 20 },
  charCount: { color: '#aaaaaa', fontSize: 12, textAlign: 'right', marginTop: 4 },
  categories:             { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 32 },
  categoryChip:           { backgroundColor: '#f5f5f5', borderWidth: 0.5, borderColor: '#e5e5e5', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  categoryChipActive:     { backgroundColor: COLORS.gold, borderColor: COLORS.gold },
  categoryChipText:       { color: '#888888', fontSize: 13, fontWeight: '600' },
  categoryChipTextActive: { color: '#ffffff' },
  uploadBtn:              { backgroundColor: COLORS.gold, borderRadius: 14, paddingVertical: 18, paddingHorizontal: 65, marginBottom: 20, overflow: 'hidden' },
  uploadBtnDisabled:      { backgroundColor: COLORS.goldDark },
  uploadBtnContent:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  uploadBtnText:          { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  uploadBtnPct:           { color: '#ffffff', fontSize: 16, fontWeight: '800' },
  tiktokBarBg:            { position: 'absolute', bottom: -15, left: -30, right: -30, height: 4, backgroundColor: 'rgba(255,255,255,0.3)' },
  tiktokBarFill:          { height: 4, backgroundColor: '#ffffff' },
  scholarInfo:            { flexDirection: 'row', backgroundColor: '#f5f5f5', borderRadius: 12, padding: 14, gap: 10, marginBottom: 40, alignItems: 'flex-start', borderWidth: 0.5, borderColor: '#e5e5e5' },
  scholarInfoIcon:        { fontSize: 20 },
  scholarInfoText:        { color: '#888888', fontSize: 13, lineHeight: 20, flex: 1 },
  maxQuestionsRow:        { flexDirection: 'row', gap: 10, marginBottom: 28, flexWrap: 'wrap' },
  qChip:                  { backgroundColor: '#f5f5f5', borderWidth: 0.5, borderColor: '#e5e5e5', borderRadius: 999, paddingHorizontal: 20, paddingVertical: 10 },
  qChipActive:            { backgroundColor: COLORS.gold, borderColor: COLORS.gold },
  qChipText:              { color: '#888888', fontSize: 15, fontWeight: '600' },
  qChipTextActive:        { color: '#ffffff' },
  goLiveConfirmBtn:       { backgroundColor: COLORS.live, borderRadius: 14, padding: 18, alignItems: 'center', marginBottom: 12 },
  goLiveConfirmBtnText:   { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  cancelBtn:              { borderWidth: 0.5, borderColor: '#e5e5e5', borderRadius: 14, padding: 16, alignItems: 'center', marginBottom: 40 },
  cancelBtnText:          { color: '#888888', fontSize: 15 },
});