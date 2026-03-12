import { View, Text, StyleSheet, TextInput, ScrollView, Alert } from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';

const CATEGORIES = ['Quran', 'Hadith', 'Reminder', 'Lecture', 'Nasheeds', 'Dua', 'Other'];

export default function UploadScreen({ navigation }) {
  const [video, setVideo]         = useState(null);
  const [caption, setCaption]     = useState('');
  const [category, setCategory]   = useState('');
  const [uploading, setUploading] = useState(false);
  const [isScholar, setIsScholar] = useState(false);
  const [scholarChecked, setScholarChecked] = useState(true);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');

  // ── Go Live setup state ────────────────────────────────────────────────────
  const [showLiveSetup, setShowLiveSetup] = useState(false);
  const [liveTitle, setLiveTitle]         = useState('');
  const [maxQuestions, setMaxQuestions]   = useState('5');

  const scrollRef = useRef(null);
  useFocusEffect(
    useCallback(() => {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [])
  );

  useEffect(() => { checkIfScholar(); }, []);

  async function checkIfScholar() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from('profiles').select('is_scholar').eq('id', user.id).single();
    setIsScholar(data?.is_scholar ?? false);
    setScholarChecked(true);
  }

  async function pickVideo() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Permission Required',
        'Please go to your phone Settings → Apps → Expo Go → Permissions → Storage and enable it.',
        [{ text: 'OK' }]
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      allowsEditing: false,
      quality: 1,
    });
    if (!result.canceled) setVideo(result.assets[0]);
  }

  async function uploadVideo() {
    if (!video)          { Alert.alert('No video', 'Please pick a video first.'); return; }
    if (!caption.trim()) { Alert.alert('No caption', 'Please add a caption.'); return; }
    if (!category)       { Alert.alert('No category', 'Please select a category.'); return; }

    setUploading(true);
    setProgressPercent(0);
    setProgressLabel('Uploading...');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { Alert.alert('Not logged in'); setUploading(false); return; }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { Alert.alert('Session expired', 'Please log in again.'); setUploading(false); return; }

    try {
      const ext      = video.uri.split('.').pop() || 'mp4';
      const fileName = `${user.id}/${Date.now()}.${ext}`;

      const SUPABASE_URL = 'https://waurtjtnyinncbdhfydu.supabase.co';

      const formData = new FormData();
      formData.append('', {
        uri:  video.uri,
        type: 'video/mp4',
        name: fileName.split('/').pop(),
      });

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
          if (xhr.status === 200 || xhr.status === 201) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network request failed'));
        xhr.send(formData);
      });

      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/videos/${fileName}`;

      setProgressPercent(100);
      setProgressLabel('Saving...');

      const { error: dbError } = await supabase.from('videos').insert({
        user_id:       user.id,
        caption:       caption.trim(),
        category,
        video_url:     publicUrl,
        thumbnail_url: null,
      });

      if (dbError) throw dbError;

      setProgressPercent(0);
      setProgressLabel('');
      setUploading(false);
      setVideo(null);
      setCaption('');
      setCategory('');
      Alert.alert('Success! 🎉', 'Your video has been uploaded to Bushrann!');

    } catch (error) {
      setUploading(false);
      setProgressPercent(0);
      setProgressLabel('');
      console.error('Upload error:', error);
      Alert.alert('Upload failed', error.message);
    }
  }

  function handleGoLive() { setShowLiveSetup(true); }

  function startLiveStream() {
    if (!liveTitle.trim()) {
      Alert.alert('Title required', 'Please enter a title for your live stream.');
      return;
    }
    const max = parseInt(maxQuestions) || 5;
    setShowLiveSetup(false);
    setLiveTitle('');
    setMaxQuestions('5');
    navigation.navigate('LiveStream', { title: liveTitle.trim(), maxQuestions: max });
  }

  if (showLiveSetup) {
    return (
      <ScrollView ref={scrollRef} style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>🔴 Go Live</Text>
        <Text style={styles.subtitle}>Set up your live stream</Text>

        <Text style={styles.label}>Stream Title *</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Friday Tafsir Lesson"
          placeholderTextColor="#4b5563"
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
      </ScrollView>
    );
  }

  return (
    <ScrollView ref={scrollRef} style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Upload Video</Text>
      <Text style={styles.subtitle}>Share your dawah with the ummah ☪️</Text>

      {isScholar && (
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
      <TextInput
        style={styles.input}
        placeholder="What is this video about?"
        placeholderTextColor="#4b5563"
        value={caption}
        onChangeText={setCaption}
        multiline
        maxLength={200}
        editable={!uploading}
      />
      <Text style={styles.charCount}>{caption.length}/200</Text>

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

      {/* ── TikTok Style Upload Button ── */}
      <AnimatedButton
        style={[styles.uploadBtn, uploading && styles.uploadBtnDisabled]}
        onPress={uploadVideo}
        disabled={uploading}
      >
        {/* Thin progress bar at the very bottom of the button */}
        {uploading && (
          <View style={styles.tiktokBarBg}>
            <View style={[styles.tiktokBarFill, { width: `${progressPercent}%` }]} />
          </View>
        )}

        {/* Button content */}
        <View style={styles.uploadBtnContent}>
          <Text style={styles.uploadBtnText}>
            {uploading ? progressLabel : 'Upload to Bushrann ☪️'}
          </Text>
          {uploading && (
            <Text style={styles.uploadBtnPct}>{progressPercent}%</Text>
          )}
        </View>
      </AnimatedButton>

      {scholarChecked && !isScholar && (
          <View style={styles.scholarInfo}>
          <Text style={styles.scholarInfoIcon}>🎓</Text>
          <Text style={styles.scholarInfoText}>
            Are you a verified Islamic scholar? Contact us to get your Scholar badge and unlock live streaming.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:              { flex: 1, backgroundColor: '#0f0f0f' },
  content:                { padding: 24, paddingTop: 60 },
  title:                  { fontSize: 24, fontWeight: '700', color: '#ffffff', marginBottom: 4 },
  subtitle:               { fontSize: 14, color: '#64748b', marginBottom: 28 },
  hint:                   { color: '#64748b', fontSize: 12, marginBottom: 10 },
  liveBtn:                { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#ef4444', borderRadius: 14, padding: 16, marginBottom: 20, gap: 10 },
  liveDot:                { fontSize: 18 },
  liveBtnText:            { color: '#ef4444', fontSize: 16, fontWeight: '700', flex: 1 },
  scholarBadge:           { backgroundColor: '#ef4444', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  scholarBadgeText:       { color: '#fff', fontSize: 11, fontWeight: '700' },
  videoPicker:            { backgroundColor: '#1a1d27', borderRadius: 16, borderWidth: 2, borderColor: '#2d3148', borderStyle: 'dashed', marginBottom: 24, overflow: 'hidden' },
  videoPlaceholder:       { padding: 40, alignItems: 'center' },
  videoPlaceholderIcon:   { fontSize: 48, marginBottom: 12 },
  videoPlaceholderText:   { color: '#ffffff', fontSize: 16, fontWeight: '600', marginBottom: 4 },
  videoPlaceholderSub:    { color: '#64748b', fontSize: 13 },
  videoSelected:          { padding: 24, alignItems: 'center' },
  videoSelectedIcon:      { fontSize: 40, marginBottom: 8 },
  videoSelectedText:      { color: '#10b981', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  videoSelectedName:      { color: '#94a3b8', fontSize: 12, marginBottom: 8 },
  tapToChange:            { color: '#4b5563', fontSize: 12 },
  label:                  { color: '#94a3b8', fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 },
  input:                  { backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#2d3148', borderRadius: 12, padding: 16, color: '#ffffff', fontSize: 15, minHeight: 80, textAlignVertical: 'top' },
  charCount:              { color: '#4b5563', fontSize: 12, textAlign: 'right', marginTop: 4, marginBottom: 20 },
  categories:             { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 32 },
  categoryChip:           { backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#2d3148', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  categoryChipActive:     { backgroundColor: '#4c1d95', borderColor: '#7c3aed' },
  categoryChipText:       { color: '#64748b', fontSize: 13, fontWeight: '600' },
  categoryChipTextActive: { color: '#ffffff' },

  // ── TikTok Style Button ────────────────────────────────────────────────────
  uploadBtn:              { backgroundColor: '#7c3aed', borderRadius: 14, paddingVertical: 18, paddingHorizontal: 65, marginBottom: 20, overflow: 'hidden' },
  uploadBtnDisabled:      { backgroundColor: '#4c1d95' },
  uploadBtnContent:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  uploadBtnText:          { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  uploadBtnPct:           { color: '#ffffff', fontSize: 16, fontWeight: '800' },
  tiktokBarBg:            { position: 'absolute', bottom: -15, left: -30, right: -30, height: 4, backgroundColor: 'rgba(255,255,255,0.2)' },
  tiktokBarFill:          { height: 4, backgroundColor: '#ffffff' },

  scholarInfo:            { flexDirection: 'row', backgroundColor: '#1a1d27', borderRadius: 12, padding: 14, gap: 10, marginBottom: 40, alignItems: 'flex-start' },
  scholarInfoIcon:        { fontSize: 20 },
  scholarInfoText:        { color: '#64748b', fontSize: 13, lineHeight: 20, flex: 1 },
  maxQuestionsRow:        { flexDirection: 'row', gap: 10, marginBottom: 28, flexWrap: 'wrap' },
  qChip:                  { backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#2d3148', borderRadius: 999, paddingHorizontal: 20, paddingVertical: 10 },
  qChipActive:            { backgroundColor: '#4c1d95', borderColor: '#7c3aed' },
  qChipText:              { color: '#64748b', fontSize: 15, fontWeight: '600' },
  qChipTextActive:        { color: '#ffffff' },
  goLiveConfirmBtn:       { backgroundColor: '#ef4444', borderRadius: 14, padding: 18, alignItems: 'center', marginBottom: 12 },
  goLiveConfirmBtnText:   { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  cancelBtn:              { borderWidth: 1, borderColor: '#2d3148', borderRadius: 14, padding: 16, alignItems: 'center', marginBottom: 40 },
  cancelBtnText:          { color: '#64748b', fontSize: 15 },
});