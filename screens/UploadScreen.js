import { View, Text, StyleSheet, TextInput, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { useState, useEffect } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';

const CLOUD_NAME = 'dgmurkssa';
const UPLOAD_PRESET = 'balagh_videos';
const CATEGORIES = ['Quran', 'Hadith', 'Reminder', 'Lecture', 'Nasheeds', 'Dua', 'Other'];

export default function UploadScreen({ navigation }) {
  const [video, setVideo]         = useState(null);
  const [caption, setCaption]     = useState('');
  const [category, setCategory]   = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress]   = useState('');
  const [isScholar, setIsScholar] = useState(false);

  // ── Go Live setup state ────────────────────────────────────────────────────
  const [showLiveSetup, setShowLiveSetup] = useState(false);
  const [liveTitle, setLiveTitle]         = useState('');
  const [maxQuestions, setMaxQuestions]   = useState('5');

  useEffect(() => { checkIfScholar(); }, []);

  async function checkIfScholar() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from('profiles').select('is_scholar').eq('id', user.id).single();
    setIsScholar(data?.is_scholar ?? false);
  }

  async function pickVideo() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please go to your phone Settings → Apps → Expo Go → Permissions → Storage and enable it.', [{ text: 'OK' }]);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaType.Videos, allowsEditing: false, quality: 1 });
    if (!result.canceled) { setVideo(result.assets[0]); }
  }

  async function uploadVideo() {
    if (!video) { Alert.alert('No video', 'Please pick a video first.'); return; }
    if (!caption.trim()) { Alert.alert('No caption', 'Please add a caption.'); return; }
    if (!category) { Alert.alert('No category', 'Please select a category.'); return; }

    setUploading(true);
    setProgress('Getting your account...');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { Alert.alert('Not logged in'); setUploading(false); return; }

    try {
      setProgress('Uploading video... 0%');
      const formData = new FormData();
      formData.append('file', { uri: video.uri, type: 'video/mp4', name: 'upload.mp4' });
      formData.append('upload_preset', UPLOAD_PRESET);
      formData.append('resource_type', 'video');
      formData.append('quality', 'auto:best');
      formData.append('fetch_format', 'auto');

      const cloudinaryData = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setProgress(`Uploading video... ${pct}%`);
          }
        };
        xhr.onload = () => {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { reject(new Error('Failed to parse response')); }
        };
        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.send(formData);
      });

      if (!cloudinaryData.secure_url) throw new Error('Upload failed');

      setProgress('Saving to database...');
      const { error } = await supabase.from('videos').insert({
        user_id: user.id,
        caption: caption.trim(),
        category,
        video_url: cloudinaryData.secure_url,
        thumbnail_url: cloudinaryData.secure_url.replace('/upload/', '/upload/so_0/').replace('.mp4', '.jpg'),
      });

      if (error) throw error;

      setProgress('');
      setUploading(false);
      setVideo(null);
      setCaption('');
      setCategory('');
      Alert.alert('Success! 🎉', 'Your video has been uploaded to Bushrann!');
    } catch (error) {
      setUploading(false);
      setProgress('');
      Alert.alert('Upload failed', error.message);
    }
  }

  // ── Go Live handlers ───────────────────────────────────────────────────────
  function handleGoLive() {
    setShowLiveSetup(true);
  }

  function startLiveStream() {
    if (!liveTitle.trim()) {
      Alert.alert('Title required', 'Please enter a title for your live stream.');
      return;
    }
    const max = parseInt(maxQuestions) || 5;
    setShowLiveSetup(false);
    setLiveTitle('');
    setMaxQuestions('5');
    navigation.navigate('LiveStream', {
      title: liveTitle.trim(),
      maxQuestions: max,
    });
  }

  // ── Go Live Setup Screen ───────────────────────────────────────────────────
  if (showLiveSetup) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
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

  // ── Main Upload Screen ─────────────────────────────────────────────────────
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Upload Video</Text>
      <Text style={styles.subtitle}>Share your dawah with the ummah ☪️</Text>

      {isScholar && (
        <AnimatedButton style={styles.liveBtn} onPress={handleGoLive}>
          <Text style={styles.liveDot}>🔴</Text>
          <Text style={styles.liveBtnText}>Go Live</Text>
          <View style={styles.scholarBadge}><Text style={styles.scholarBadgeText}>Scholar</Text></View>
        </AnimatedButton>
      )}

      <AnimatedButton style={styles.videoPicker} onPress={pickVideo}>
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
      <TextInput style={styles.input} placeholder="What is this video about?" placeholderTextColor="#4b5563" value={caption} onChangeText={setCaption} multiline maxLength={200} />
      <Text style={styles.charCount}>{caption.length}/200</Text>

      <Text style={styles.label}>Category</Text>
      <View style={styles.categories}>
        {CATEGORIES.map(cat => (
          <AnimatedButton
            key={cat}
            style={[styles.categoryChip, category === cat && styles.categoryChipActive]}
            onPress={() => setCategory(cat)}
          >
            <Text style={[styles.categoryChipText, category === cat && styles.categoryChipTextActive]}>{cat}</Text>
          </AnimatedButton>
        ))}
      </View>

      <AnimatedButton
        style={[styles.uploadBtn, uploading && styles.uploadBtnDisabled]}
        onPress={uploadVideo}
        disabled={uploading}
      >
        {uploading ? (
          <View style={styles.uploadingRow}>
            <ActivityIndicator color="#fff" size="small" />
            <Text style={styles.uploadBtnText}>{progress}</Text>
          </View>
        ) : (
          <Text style={styles.uploadBtnText}>Upload to Bushrann ☪️</Text>
        )}
      </AnimatedButton>

      {!isScholar && (
        <View style={styles.scholarInfo}>
          <Text style={styles.scholarInfoIcon}>🎓</Text>
          <Text style={styles.scholarInfoText}>Are you a verified Islamic scholar? Contact us to get your Scholar badge and unlock live streaming.</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:            { flex: 1, backgroundColor: '#0f0f0f' },
  content:              { padding: 24, paddingTop: 60 },
  title:                { fontSize: 24, fontWeight: '700', color: '#ffffff', marginBottom: 4 },
  subtitle:             { fontSize: 14, color: '#64748b', marginBottom: 28 },
  hint:                 { color: '#64748b', fontSize: 12, marginBottom: 10 },
  liveBtn:              { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#ef4444', borderRadius: 14, padding: 16, marginBottom: 20, gap: 10 },
  liveDot:              { fontSize: 18 },
  liveBtnText:          { color: '#ef4444', fontSize: 16, fontWeight: '700', flex: 1 },
  scholarBadge:         { backgroundColor: '#ef4444', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  scholarBadgeText:     { color: '#fff', fontSize: 11, fontWeight: '700' },
  videoPicker:          { backgroundColor: '#1a1d27', borderRadius: 16, borderWidth: 2, borderColor: '#2d3148', borderStyle: 'dashed', marginBottom: 24, overflow: 'hidden' },
  videoPlaceholder:     { padding: 40, alignItems: 'center' },
  videoPlaceholderIcon: { fontSize: 48, marginBottom: 12 },
  videoPlaceholderText: { color: '#ffffff', fontSize: 16, fontWeight: '600', marginBottom: 4 },
  videoPlaceholderSub:  { color: '#64748b', fontSize: 13 },
  videoSelected:        { padding: 24, alignItems: 'center' },
  videoSelectedIcon:    { fontSize: 40, marginBottom: 8 },
  videoSelectedText:    { color: '#10b981', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  videoSelectedName:    { color: '#94a3b8', fontSize: 12, marginBottom: 8 },
  tapToChange:          { color: '#4b5563', fontSize: 12 },
  label:                { color: '#94a3b8', fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 },
  input:                { backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#2d3148', borderRadius: 12, padding: 16, color: '#ffffff', fontSize: 15, minHeight: 80, textAlignVertical: 'top' },
  charCount:            { color: '#4b5563', fontSize: 12, textAlign: 'right', marginTop: 4, marginBottom: 20 },
  categories:           { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 32 },
  categoryChip:         { backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#2d3148', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  categoryChipActive:   { backgroundColor: '#4c1d95', borderColor: '#7c3aed' },
  categoryChipText:     { color: '#64748b', fontSize: 13, fontWeight: '600' },
  categoryChipTextActive: { color: '#ffffff' },
  uploadBtn:            { backgroundColor: '#7c3aed', borderRadius: 14, padding: 18, alignItems: 'center', marginBottom: 20 },
  uploadBtnDisabled:    { backgroundColor: '#4c1d95' },
  uploadBtnText:        { color: '#ffffff', fontSize: 16, fontWeight: '700', marginLeft: 8 },
  uploadingRow:         { flexDirection: 'row', alignItems: 'center', gap: 10 },
  scholarInfo:          { flexDirection: 'row', backgroundColor: '#1a1d27', borderRadius: 12, padding: 14, gap: 10, marginBottom: 40, alignItems: 'flex-start' },
  scholarInfoIcon:      { fontSize: 20 },
  scholarInfoText:      { color: '#64748b', fontSize: 13, lineHeight: 20, flex: 1 },
  // ── Go Live setup styles ──
  maxQuestionsRow:      { flexDirection: 'row', gap: 10, marginBottom: 28, flexWrap: 'wrap' },
  qChip:                { backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#2d3148', borderRadius: 999, paddingHorizontal: 20, paddingVertical: 10 },
  qChipActive:          { backgroundColor: '#4c1d95', borderColor: '#7c3aed' },
  qChipText:            { color: '#64748b', fontSize: 15, fontWeight: '600' },
  qChipTextActive:      { color: '#ffffff' },
  goLiveConfirmBtn:     { backgroundColor: '#ef4444', borderRadius: 14, padding: 18, alignItems: 'center', marginBottom: 12 },
  goLiveConfirmBtnText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  cancelBtn:            { borderWidth: 1, borderColor: '#2d3148', borderRadius: 14, padding: 16, alignItems: 'center', marginBottom: 40 },
  cancelBtnText:        { color: '#64748b', fontSize: 15 },
});