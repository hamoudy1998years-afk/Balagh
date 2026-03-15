import {
  View, Text, TextInput, StyleSheet,
  Alert, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useBiometricAuth } from '../hooks/useBiometricAuth';
import AnimatedButton from './AnimatedButton';
import { COLORS } from '../constants/theme';

export default function SignupScreen({ navigation }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');

  const { saveAccount } = useBiometricAuth();

  const generateFakeEmail = (username, phone) => {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    return `${username.toLowerCase().trim()}_${cleanPhone}@balagh.app`;
  };

  async function handleSignup() {
    if (!username.trim()) { Alert.alert('Missing Field', 'Please enter a username.'); return; }
    if (!password.trim()) { Alert.alert('Missing Field', 'Please enter a password.'); return; }
    if (password.trim().length < 6) { Alert.alert('Weak Password', 'Password must be at least 6 characters.'); return; }
    if (password.trim() !== confirmPassword.trim()) { Alert.alert('Password Mismatch', 'Passwords do not match.'); return; }

    const hasRealEmail = email.trim().length > 0 && email.includes('@');
    const hasPhone = phone.trim().length > 0;

    if (!hasRealEmail && !hasPhone) {
      Alert.alert('Missing Field', 'Please enter either your email or phone number to create an account.');
      return;
    }

    setLoading(true);

    const authEmail = hasRealEmail ? email.trim() : generateFakeEmail(username, phone);

    const { data, error } = await supabase.auth.signUp({
      email: authEmail,
      password,
      options: { data: { username: username.trim() } },
    });

    if (error) {
      setLoading(false);
      if (error.message.includes('already registered')) {
        Alert.alert('Account Exists', 'An account with this username and phone number already exists. Try logging in instead.');
      } else {
        Alert.alert('Signup Failed', error.message);
      }
      return;
    }

    if (hasPhone && data?.user) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const { error: phoneError } = await supabase
        .from('profiles')
        .update({ phone: phone.trim() })
        .eq('id', data.user.id);
      if (phoneError) {
        console.warn('Phone save failed:', phoneError.message);
        Alert.alert('Note', 'Account created but phone number could not be saved. You can update it in your profile.');
      }
    }

    await saveAccount(username.trim(), authEmail, 'email');

    setLoading(false);
    Alert.alert('Account Created! 🎉', 'Your account is ready. You can now log in.', [
      { text: 'Go to Login', onPress: () => navigation.navigate('Login') }
    ]);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <AnimatedButton onPress={() => navigation.goBack()} style={{ alignSelf: 'flex-start', marginBottom: 16 }}>
          <Text style={{ color: COLORS.gold, fontSize: 16 }}>← Back</Text>
        </AnimatedButton>

        <Text style={styles.arabic}>بَلِّغُوا عَنِّي</Text>
        <Text style={styles.title}>Bushrann</Text>
        <Text style={styles.subtitle}>Create your account</Text>

        <TextInput
          style={styles.input}
          placeholder="Username *"
          placeholderTextColor={COLORS.textGray}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
        />
        <TextInput
          style={styles.input}
          placeholder="Email (optional)"
          placeholderTextColor={COLORS.textGray}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
        />
        <TextInput
          style={styles.input}
          placeholder="Phone Number (required if no email)"
          placeholderTextColor={COLORS.textGray}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          autoComplete="off"
        />

        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder="Password *"
            placeholderTextColor={COLORS.textGray}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            autoComplete="off"
            textContentType="none"
          />
          <AnimatedButton onPress={() => setShowPassword((prev) => !prev)}>
            <Text style={styles.eyeBtn}>{showPassword ? '🙈' : '👁️'}</Text>
          </AnimatedButton>
        </View>

        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder="Confirm Password *"
            placeholderTextColor={COLORS.textGray}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry={!showPassword}
            autoComplete="off"
            textContentType="none"
          />
        </View>

        <Text style={styles.helperText}>
          * Username and password are required.{'\n'}
          Provide either email or phone number to sign up.
        </Text>

        <AnimatedButton style={styles.button} onPress={handleSignup} disabled={loading}>
          <Text style={styles.buttonText}>{loading ? 'Creating account...' : 'Create Account'}</Text>
        </AnimatedButton>

        <AnimatedButton onPress={() => navigation.navigate('Login')}>
          <Text style={styles.link}>
            Already have an account?{' '}
            <Text style={styles.linkBold}>Login</Text>
          </Text>
        </AnimatedButton>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1, backgroundColor: COLORS.bgDark, alignItems: 'center',
    justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 40,
  },
  arabic: { fontSize: 24, color: COLORS.gold, marginBottom: 8 },
  title: { fontSize: 36, fontWeight: 'bold', color: COLORS.textWhite, marginBottom: 4 },
  subtitle: { fontSize: 14, color: COLORS.textGray, marginBottom: 36 },
  input: {
    width: '100%', backgroundColor: COLORS.bgCard, borderWidth: 1,
    borderColor: COLORS.borderDark, borderRadius: 12,
    padding: 16, color: COLORS.textWhite, fontSize: 15, marginBottom: 14,
  },
  passwordContainer: {
    width: '100%', flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.bgCard, borderWidth: 1, borderColor: COLORS.borderDark,
    borderRadius: 12, paddingHorizontal: 16, marginBottom: 10,
  },
  passwordInput: { flex: 1, paddingVertical: 16, color: COLORS.textWhite, fontSize: 15 },
  eyeBtn: { fontSize: 20, paddingLeft: 8 },
  helperText: { width: '100%', color: COLORS.textGray, fontSize: 12, marginBottom: 20, lineHeight: 18 },
  button: {
    width: '100%', backgroundColor: COLORS.gold, borderRadius: 12, padding: 16,
    alignItems: 'center', marginBottom: 20, minHeight: 52, justifyContent: 'center',
  },
  buttonText: { color: COLORS.navy, fontSize: 16, fontWeight: '700' },
  link: { color: COLORS.textGray, fontSize: 14 },
  linkBold: { color: COLORS.gold, fontWeight: '700' },
});