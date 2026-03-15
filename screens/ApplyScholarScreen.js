import { View, Text, TextInput, StyleSheet, Alert, ScrollView } from 'react-native';
import { useState } from 'react';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { COLORS } from '../constants/theme';

export default function ApplyScholarScreen({ navigation }) {
  const [fullName,   setFullName]   = useState('');
  const [age,        setAge]        = useState('');
  const [location,   setLocation]   = useState('');
  const [education,  setEducation]  = useState('');
  const [expertise,  setExpertise]  = useState('');
  const [bio,        setBio]        = useState('');
  const [loading,    setLoading]    = useState(false);

  async function handleApply() {
    if (!fullName || !age || !education || !expertise) {
      Alert.alert('Missing Fields', 'Please fill in all required fields.');
      return;
    }
    const ageNum = parseInt(age);
    if (isNaN(ageNum) || ageNum < 18 || ageNum > 100) {
      Alert.alert('Invalid Age', 'Please enter a valid age between 18 and 100.');
      return;
    }
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); Alert.alert('Error', 'You must be logged in to apply.'); return; }
    const { error } = await supabase.from('scholar_applications').insert({
      user_id: user.id,
      full_name: fullName.trim(),
      age: ageNum,
      location: location.trim(),
      education: education.trim(),
      expertise: expertise.trim(),
      bio: bio.trim(),
    });
    setLoading(false);
    if (error) {
      Alert.alert('Error', error.message);
    } else {
      Alert.alert('Application Submitted!', 'We will review your application and get back to you.', [
        { text: 'OK', onPress: () => navigation.goBack() }
      ]);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <AnimatedButton onPress={() => navigation.goBack()} style={{ alignSelf: 'flex-start', marginBottom: 16 }}>
        <Text style={{ color: COLORS.gold, fontSize: 16 }}>← Back</Text>
      </AnimatedButton>

      <Text style={styles.title}>Apply as Scholar</Text>
      <Text style={styles.subtitle}>Fill in your details to apply for a scholar badge</Text>

      <Text style={styles.label}>Full Name *</Text>
      <TextInput style={styles.input} value={fullName} onChangeText={setFullName} placeholderTextColor="#4b5563" placeholder="Your full name" />

      <Text style={styles.label}>Age *</Text>
      <TextInput style={styles.input} value={age} onChangeText={setAge} placeholderTextColor="#4b5563" placeholder="Your age" keyboardType="number-pad" />

      <Text style={styles.label}>Location</Text>
      <TextInput style={styles.input} value={location} onChangeText={setLocation} placeholderTextColor="#4b5563" placeholder="City, Country" />

      <Text style={styles.label}>Education *</Text>
      <TextInput style={[styles.input, styles.multiline]} value={education} onChangeText={setEducation} placeholderTextColor="#4b5563" placeholder="Your educational background" multiline />

      <Text style={styles.label}>Area of Expertise *</Text>
      <TextInput style={styles.input} value={expertise} onChangeText={setExpertise} placeholderTextColor="#4b5563" placeholder="e.g. Fiqh, Tafsir, Hadith" />

      <Text style={styles.label}>Bio</Text>
      <TextInput style={[styles.input, styles.multiline]} value={bio} onChangeText={setBio} placeholderTextColor="#4b5563" placeholder="Tell us about yourself" multiline />

      <AnimatedButton style={styles.submitBtn} onPress={handleApply} disabled={loading}>
        <Text style={styles.submitBtnText}>{loading ? 'Submitting...' : 'Submit Application'}</Text>
      </AnimatedButton>

      <AnimatedButton style={styles.cancelBtn} onPress={() => navigation.goBack()}>
        <Text style={styles.cancelBtnText}>Cancel</Text>
      </AnimatedButton>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bgDark },
  content: { paddingHorizontal: 24, paddingTop: 80, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: '700', color: COLORS.textWhite, marginBottom: 8 },
  subtitle: { fontSize: 14, color: COLORS.textGray, marginBottom: 32, lineHeight: 20 },
  label: { color: COLORS.textLight, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  input: { width: '100%', backgroundColor: COLORS.bgCard, borderWidth: 1, borderColor: COLORS.borderDark, borderRadius: 12, padding: 16, color: COLORS.textWhite, fontSize: 15, marginBottom: 20 },
  multiline: { height: 100, textAlignVertical: 'top' },
  submitBtn: { width: '100%', backgroundColor: COLORS.gold, borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 12 },
  submitBtnText: { color: COLORS.navy, fontSize: 16, fontWeight: '700' },
  cancelBtn: { width: '100%', borderWidth: 1, borderColor: COLORS.borderDark, borderRadius: 12, padding: 16, alignItems: 'center' },
  cancelBtnText: { color: COLORS.textGray, fontSize: 16 },
});