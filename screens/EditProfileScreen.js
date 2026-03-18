import {
  View, Text, TextInput, StyleSheet,
  ActivityIndicator, ScrollView, Keyboard
} from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AnimatedButton from './AnimatedButton';
import { COLORS } from '../constants/theme';
import ModernDialog from './ModernDialog';

export default function EditProfileScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [isScholar,    setIsScholar]    = useState(false);
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [username,     setUsername]     = useState('');
  const [fullName,     setFullName]     = useState('');
  const [bio,          setBio]          = useState('');
  const [scholarId,    setScholarId]    = useState(null);
  const [realName,     setRealName]     = useState('');
  const [age,          setAge]          = useState('');
  const [location,     setLocation]     = useState('');
  const [education,    setEducation]    = useState('');
  const [expertise,    setExpertise]    = useState('');
  const [extraPadding, setExtraPadding] = useState(0);
  const [dialog, setDialog] = useState({ visible: false, title: '', message: '', type: 'info', buttons: [] });

  const scrollRef = useRef(null);

  useFocusEffect(
    useCallback(() => {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [])
  );

  useEffect(() => {
    loadProfile();
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setExtraPadding(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setExtraPadding(0);
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    if (profile) {
      setUsername(profile.username ?? '');
      setFullName(profile.full_name ?? '');
      setBio(profile.bio ?? '');
      setIsScholar(profile.is_scholar === true);
    }
    if (profile?.is_scholar) {
      const { data: scholarData } = await supabase
        .from('scholar_applications')
        .select('*')
        .eq('user_id', user.id)
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (scholarData) {
        setScholarId(scholarData.id);
        setRealName(scholarData.full_name ?? '');
        setAge(scholarData.age?.toString() ?? '');
        setLocation(scholarData.location ?? '');
        setEducation(scholarData.education ?? '');
        setExpertise(scholarData.expertise ?? '');
      }
    }
    setLoading(false);
  }

  async function handleSave() {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      setDialog({ visible: true, title: 'Invalid Username', message: 'Username cannot be empty.', type: 'warning', buttons: [{ text: 'OK' }] });
      return;
    }
    if (trimmedUsername.length < 3) {
      setDialog({ visible: true, title: 'Invalid Username', message: 'Username must be at least 3 characters.', type: 'warning', buttons: [{ text: 'OK' }] });
      return;
    }
    if (!/^[a-zA-Z0-9._]+$/.test(trimmedUsername)) {
      setDialog({ visible: true, title: 'Invalid Username', message: 'No spaces allowed! Use letters, numbers, dots (.) or underscores (_) only.', type: 'warning', buttons: [{ text: 'OK' }] });
      return;
    }

    setSaving(true);
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (!user || userError) {
      setSaving(false);
      setDialog({ visible: true, title: 'Error', message: 'Could not verify your session. Please try again.', type: 'error', buttons: [{ text: 'OK' }] });
      return;
    }
    try {
      if (isScholar) {
        const { error: profileError } = await supabase.from('profiles').update({ username: username.trim() }).eq('id', user.id);
        if (profileError) throw profileError;
        if (scholarId) {
          const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').trim();
          const { error: scholarError } = await supabase.from('scholar_applications').update({
            full_name: stripHtml(realName),
            age: age ? parseInt(age) : null,
            location: stripHtml(location),
            education: stripHtml(education),
            expertise: stripHtml(expertise),
          }).eq('id', scholarId);
          if (scholarError) throw scholarError;
        }
      } else {
        const { error } = await supabase.from('profiles').update({
          username: username.trim(),
          full_name: fullName.trim(),
          bio: bio.trim(),
        }).eq('id', user.id);
        if (error) throw error;
      }
      setDialog({ visible: true, title: 'Success! 🎉', message: 'Profile updated!', type: 'success', buttons: [{ text: 'OK', onPress: () => navigation.goBack() }] });
    } catch (e) {
      setDialog({ visible: true, title: 'Error', message: e.message, type: 'error', buttons: [{ text: 'OK' }] });
    } finally {
      setSaving(false);
    }
  }

  function scrollToField(y) {
    setTimeout(() => {
      scrollRef.current?.scrollTo({ y: y, animated: true });
    }, 150);
  }

  if (loading) {
    return <View style={epStyles.loadingContainer}><ActivityIndicator color={COLORS.gold} size="large" /></View>;
  }

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.bgDark }}>
      <ScrollView
        ref={scrollRef}
        style={epStyles.container}
        contentContainerStyle={{ paddingTop: insets.top + 5, paddingBottom: insets.bottom + 120 + extraPadding }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={true}
      >
        <View style={epStyles.headerRow}>
          <AnimatedButton onPress={() => navigation.goBack()} style={epStyles.backBtn}>
            <Text style={epStyles.backBtnText}>←</Text>
          </AnimatedButton>
          <Text style={epStyles.title}>Edit Profile</Text>
          <View style={{ width: 40 }} />
        </View>

        {isScholar && (
          <View style={epStyles.scholarNotice}>
            <Text style={epStyles.scholarNoticeText}>🎓 Scholar Profile</Text>
          </View>
        )}

        <Text style={epStyles.label}>Username</Text>
        <TextInput
          style={epStyles.input}
          value={username}
          onChangeText={setUsername}
          placeholderTextColor="#4b5563"
          autoCapitalize="none"
          placeholder="@username"
          onFocus={() => scrollToField(0)}
        />
        <Text style={{ color: '#4b5563', fontSize: 12, marginTop: -10, marginBottom: 14 }}>
          No spaces allowed. Use letters, numbers, dots (.) or underscores (_) only.
        </Text>

        {isScholar ? (
          <>
            <Text style={epStyles.sectionTitle}>Scholar Information</Text>

            <Text style={epStyles.label}>Real Name</Text>
            <TextInput
              style={epStyles.input}
              value={realName}
              onChangeText={setRealName}
              placeholderTextColor="#4b5563"
              placeholder="Your real full name"
              onFocus={() => scrollToField(0)}
            />

            <Text style={epStyles.label}>Age (Optional)</Text>
            <TextInput
              style={epStyles.input}
              value={age}
              onChangeText={setAge}
              placeholderTextColor="#4b5563"
              placeholder="Your age"
              keyboardType="numeric"
              maxLength={3}
              onFocus={() => scrollToField(0)}
            />

            <Text style={epStyles.label}>Location / Town / Province</Text>
            <TextInput
              style={epStyles.input}
              value={location}
              onChangeText={setLocation}
              placeholderTextColor="#4b5563"
              placeholder="e.g. Davao City, Davao del Sur"
              onFocus={() => scrollToField(85)}
            />

            <Text style={epStyles.label}>Education</Text>
            <TextInput
              style={epStyles.input}
              value={education}
              onChangeText={setEducation}
              placeholderTextColor="#4b5563"
              placeholder="e.g. Bachelor of Islamic Studies"
              onFocus={() => scrollToField(170)}
            />

            <Text style={epStyles.label}>Expertise</Text>
            <TextInput
              style={[epStyles.input, epStyles.multilineInput]}
              value={expertise}
              onChangeText={setExpertise}
              placeholderTextColor="#4b5563"
              placeholder="e.g. Fiqh, Hadith, Quran Tafsir"
              multiline
              onFocus={() => scrollToField(285)}
            />
          </>
        ) : (
          <>
            <Text style={epStyles.label}>Display Name</Text>
            <TextInput
              style={epStyles.input}
              value={fullName}
              onChangeText={setFullName}
              placeholderTextColor="#4b5563"
              placeholder="Your display name"
              onFocus={() => scrollToField(100)}
            />

            <Text style={epStyles.label}>Bio</Text>
            <TextInput
              style={[epStyles.input, epStyles.multilineInput]}
              value={bio}
              onChangeText={(text) => { if (text.length <= 150) setBio(text); }}
              placeholderTextColor="#4b5563"
              placeholder="Tell the world about yourself..."
              multiline
              maxLength={150}
              onFocus={() => scrollToField(200)}
            />
            <Text style={{ color: COLORS.textGray, fontSize: 12, textAlign: 'right', marginTop: -10, marginBottom: 14 }}>{bio.length}/150</Text>
          </>
        )}

        <AnimatedButton style={epStyles.saveBtn} onPress={handleSave} disabled={saving}>
          <Text style={epStyles.saveBtnText}>{saving ? 'Saving...' : 'Save Changes'}</Text>
        </AnimatedButton>

        <AnimatedButton style={epStyles.cancelBtn} onPress={() => navigation.goBack()}>
          <Text style={epStyles.cancelBtnText}>Cancel</Text>
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
    </View>
  );
}

const epStyles = StyleSheet.create({
  loadingContainer: { flex: 1, backgroundColor: COLORS.bgDark, alignItems: 'center', justifyContent: 'center' },
  container: { flex: 1, backgroundColor: COLORS.bgDark, paddingHorizontal: 24 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  backBtn: { padding: 4 },
  backBtnText: { color: COLORS.textWhite, fontSize: 24, fontWeight: '700' },
  title: { fontSize: 20, fontWeight: '800', color: COLORS.textWhite },
  scholarNotice: { backgroundColor: `${COLORS.gold}22`, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 16, marginBottom: 16, alignItems: 'center' },
  scholarNoticeText: { color: COLORS.gold, fontSize: 14, fontWeight: '700' },
  sectionTitle: { color: COLORS.gold, fontSize: 13, fontWeight: '700', marginBottom: 10, marginTop: 4, textTransform: 'uppercase', letterSpacing: 1 },
  label: { color: COLORS.textGray, fontSize: 13, fontWeight: '600', marginBottom: 4 },
  input: { width: '100%', backgroundColor: COLORS.bgCard, borderWidth: 1, borderColor: COLORS.borderDark, borderRadius: 12, padding: 14, color: COLORS.textWhite, fontSize: 15, marginBottom: 14 },
  multilineInput: { height: 80, textAlignVertical: 'top' },
  saveBtn: { width: '100%', backgroundColor: COLORS.gold, borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 10, marginTop: 6 },
  saveBtnText: { color: COLORS.navy, fontSize: 16, fontWeight: '700' },
  cancelBtn: { width: '100%', borderWidth: 1, borderColor: COLORS.borderDark, borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 20 },
  cancelBtnText: { color: COLORS.textGray, fontSize: 16 },
});