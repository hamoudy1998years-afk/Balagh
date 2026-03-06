import {
  View,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useState, useEffect, useRef } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { supabase } from '../lib/supabase';
import { useBiometricAuth } from '../hooks/useBiometricAuth';
import * as LocalAuthentication from 'expo-local-authentication';
import AnimatedButton from './AnimatedButton';
import AsyncStorage from '@react-native-async-storage/async-storage';

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen({ navigation }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [biometricType, setBiometricType] = useState(null);
  const [savedAccounts, setSavedAccounts] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);

  const suppressDropdown = useRef(false);
  const silentReAuth = useRef(false);

  const {
    isBiometricAvailable,
    getSavedAccounts,
    hasCredentials,
    saveCredentials,
    saveGoogleCredentials,
    saveAccount,
    loginWithBiometrics,
  } = useBiometricAuth();

  useEffect(() => {
    (async () => {
      await AsyncStorage.clear();
      const available = await isBiometricAvailable();
      if (available) {
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        setBiometricType(types.includes(2) ? 'face' : 'fingerprint');
      }
      const accounts = await getSavedAccounts();
      setSavedAccounts(accounts);
    })();
  }, []);

  const refreshAccountsList = async () => {
    const accounts = await getSavedAccounts();
    setSavedAccounts(accounts);
  };

  const closeDropdown = () => setShowDropdown(false);

  const handleAccountSelect = async (account) => {
    suppressDropdown.current = true;
    setShowDropdown(false);
    setIdentifier(account.identifier || account.email);

    const bioAvailable = await isBiometricAvailable();
    const credsSaved = await hasCredentials(account.email);

    if (bioAvailable && credsSaved) {
      try {
        setLoading(true);
        await loginWithBiometrics(account.email);
      } catch (e) {
        setLoading(false);
        if (e.message === 'BIOMETRIC_CANCELLED') {
          // User cancelled — do nothing
        } else if (e.message === 'SESSION_EXPIRED') {
          silentReAuth.current = true;
          await handleGoogleLogin();
        } else if (e.message !== 'NO_CREDENTIALS') {
          Alert.alert('Login Failed', e.message);
        }
      }
    } else if (account.provider === 'google') {
      handleGoogleLogin();
    }
  };

  const resolveEmail = async (raw) => {
    let email = raw.trim();
    if (!email.includes('@')) {
      const isPhone = /^\+?[\d\s\-]{7,}$/.test(email);
      const { data, error } = await supabase
        .from('profiles')
        .select('id')
        .eq(isPhone ? 'phone' : 'username', email)
        .single();

      if (error || !data) {
        throw new Error(`No account found with that ${isPhone ? 'phone number' : 'username'}.`);
      }

      const { data: userData, error: userError } = await supabase.rpc('get_email_by_id', { user_id: data.id });

      if (userError || !userData) {
        throw new Error('Could not find account. Please use your email instead.');
      }

      email = userData;
    }
    return email;
  };

  async function handleLogin() {
    if (!identifier.trim() || !password.trim()) {
      Alert.alert('Missing Fields', 'Please enter your email/username and password.');
      return;
    }

    setLoading(true);
    let email;

    try {
      email = await resolveEmail(identifier);
    } catch (e) {
      setLoading(false);
      Alert.alert('Login Failed', e.message);
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);

    if (error) {
      Alert.alert('Login Failed', error.message);
      return;
    }

    const bioAvailable = await isBiometricAvailable();
    if (bioAvailable) {
      const alreadySaved = await hasCredentials(email);
      if (!alreadySaved) {
        const label = biometricType === 'face' ? 'Face ID' : 'Fingerprint';
        Alert.alert(
          `Enable ${label} Sign-In?`,
          `Next time, just tap your account and use your ${label.toLowerCase()} — no typing needed.`,
          [
            {
              text: 'Not now',
              style: 'cancel',
              onPress: async () => {
                await saveAccount(identifier.trim(), email, 'email');
                await refreshAccountsList();
              },
            },
            {
              text: 'Enable',
              onPress: async () => {
                await saveCredentials(identifier.trim(), email, password);
                await refreshAccountsList();
              },
            },
          ]
        );
      } else {
        await refreshAccountsList();
      }
    } else {
      await saveAccount(identifier.trim(), email, 'email');
      await refreshAccountsList();
    }
  }

  async function handleGoogleLogin() {
    setGoogleLoading(true);

    const redirectUrl = makeRedirectUri({ native: 'bushrann://auth/callback' });

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectUrl, skipBrowserRedirect: true },
    });

    if (error) {
      setGoogleLoading(false);
      silentReAuth.current = false;
      Alert.alert('Google Login Failed', error.message);
      return;
    }

    const result = await WebBrowser.openAuthSessionAsync(data?.url, redirectUrl);

    if (result.type === 'success') {
      const { url } = result;

      const hashPart = url.includes('#') ? url.split('#')[1] : null;
      const queryPart = url.includes('?') ? url.split('?')[1]?.split('#')[0] : null;
      const paramStr = hashPart || queryPart || '';
      const params = new URLSearchParams(paramStr);

      const access_token = params.get('access_token');
      const refresh_token = params.get('refresh_token');

      if (!access_token) {
        setGoogleLoading(false);
        silentReAuth.current = false;
        Alert.alert('Google Login Failed', 'Could not retrieve session. Please try again.');
        return;
      }

      await supabase.auth.setSession({ access_token, refresh_token });

      const { data: sessionData } = await supabase.auth.getSession();
      const userEmail = sessionData?.session?.user?.email;
      const userMeta = sessionData?.session?.user?.user_metadata;
      const tokenToStore = sessionData?.session?.refresh_token;

      if (userEmail && tokenToStore) {
        const displayName = userMeta?.full_name || userMeta?.name || userEmail;
        await saveGoogleCredentials(displayName, userEmail, tokenToStore);
        await refreshAccountsList();
      }
    }

    silentReAuth.current = false;
    setGoogleLoading(false);
  }

  const handleIdentifierFocus = () => {
    if (suppressDropdown.current) {
      suppressDropdown.current = false;
      return;
    }
    if (savedAccounts.length > 0) setShowDropdown(true);
  };

  const handleIdentifierBlur = () => {
    setTimeout(() => setShowDropdown(false), 200);
  };

  const handleIdentifierChange = (text) => {
    setIdentifier(text);
    if (text.length === 0) {
      suppressDropdown.current = false;
      if (savedAccounts.length > 0) setShowDropdown(true);
    } else {
      setShowDropdown(false);
    }
  };

  const biometricIcon = biometricType === 'face' ? '🔒' : '👆';

  return (
    <TouchableWithoutFeedback onPress={closeDropdown}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Text style={styles.arabic}>بَلِّغُوا عَنِّي</Text>
          <Text style={styles.title}>Bushrann</Text>
          <Text style={styles.subtitle}>Welcome back</Text>

          <View style={styles.inputWrapper}>
            <TextInput
              style={styles.input}
              placeholder="Email, Username or Phone"
              placeholderTextColor="#4b5563"
              value={identifier}
              onChangeText={handleIdentifierChange}
              onFocus={handleIdentifierFocus}
              onBlur={handleIdentifierBlur}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              importantForAutofill="no"
              textContentType="none"
              keyboardType="default"
            />

            {showDropdown && savedAccounts.length > 0 && (
              <View style={styles.dropdown}>
                {savedAccounts.map((account, idx) => (
                  <AnimatedButton
                    key={idx}
                    style={[styles.dropdownItem, idx < savedAccounts.length - 1 && styles.dropdownItemBorder]}
                    onPress={() => handleAccountSelect(account)}
                  >
                    <View style={[styles.dropdownAvatar, account.provider === 'google' && styles.dropdownAvatarGoogle]}>
                      <Text style={styles.dropdownAvatarText}>
                        {account.provider === 'google' ? 'G' : (account.identifier || account.email)[0].toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.dropdownInfo}>
                      <Text style={styles.dropdownIdentifier}>{account.identifier || account.email}</Text>
                      {account.identifier && account.identifier !== account.email && (
                        <Text style={styles.dropdownEmail}>{account.email}</Text>
                      )}
                    </View>
                    <Text style={styles.dropdownAction}>{biometricIcon}</Text>
                  </AnimatedButton>
                ))}
              </View>
            )}
          </View>

          <TouchableWithoutFeedback onPress={closeDropdown}>
            <View style={styles.passwordContainer}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Password"
                placeholderTextColor="#4b5563"
                value={password}
                onChangeText={setPassword}
                onFocus={closeDropdown}
                secureTextEntry={!showPassword}
                autoComplete="off"
                textContentType="none"
              />
              <AnimatedButton onPress={() => setShowPassword((prev) => !prev)}>
                <Text style={styles.eyeBtn}>{showPassword ? '🙈' : '👁️'}</Text>
              </AnimatedButton>
            </View>
          </TouchableWithoutFeedback>

          <AnimatedButton style={styles.button} onPress={handleLogin} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Login</Text>}
          </AnimatedButton>

          <View style={styles.dividerContainer}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <AnimatedButton style={styles.googleButton} onPress={handleGoogleLogin} disabled={googleLoading}>
            {googleLoading ? <ActivityIndicator color="#a78bfa" /> : <Text style={styles.googleButtonText}>🔵  Continue with Google</Text>}
          </AnimatedButton>

          <AnimatedButton onPress={() => navigation.navigate('Signup')}>
            <Text style={styles.link}>
              Don't have an account?{' '}
              <Text style={styles.linkBold}>Sign up</Text>
            </Text>
          </AnimatedButton>
        </ScrollView>
      </KeyboardAvoidingView>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1, backgroundColor: '#0f0f0f', alignItems: 'center',
    justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 40,
  },
  arabic: { fontSize: 24, color: '#a78bfa', marginBottom: 8 },
  title: { fontSize: 36, fontWeight: 'bold', color: '#ffffff', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', marginBottom: 36 },
  inputWrapper: { width: '100%', zIndex: 10, marginBottom: 14 },
  input: {
    width: '100%', backgroundColor: '#1a1d27', borderWidth: 1,
    borderColor: '#2d3148', borderRadius: 12, padding: 16, color: '#ffffff', fontSize: 15,
  },
  dropdown: {
    position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6,
    backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#2d3148',
    borderRadius: 12, overflow: 'hidden', zIndex: 999, elevation: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.5, shadowRadius: 10,
  },
  dropdownItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14 },
  dropdownItemBorder: { borderBottomWidth: 1, borderBottomColor: '#2d3148' },
  dropdownAvatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#7c3aed', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  dropdownAvatarGoogle: { backgroundColor: '#1a73e8' },
  dropdownAvatarText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  dropdownInfo: { flex: 1 },
  dropdownIdentifier: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  dropdownEmail: { color: '#64748b', fontSize: 12, marginTop: 2 },
  dropdownAction: { fontSize: 18, marginLeft: 8 },
  passwordContainer: {
    width: '100%', flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#2d3148',
    borderRadius: 12, paddingHorizontal: 16, marginBottom: 14, zIndex: 1,
  },
  passwordInput: { flex: 1, paddingVertical: 16, color: '#ffffff', fontSize: 15 },
  eyeBtn: { fontSize: 20, paddingLeft: 8 },
  button: {
    width: '100%', backgroundColor: '#7c3aed', borderRadius: 12, padding: 16,
    alignItems: 'center', marginTop: 6, marginBottom: 20, zIndex: 1, minHeight: 52, justifyContent: 'center',
  },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  dividerContainer: { width: '100%', flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#2d3148' },
  dividerText: { color: '#64748b', marginHorizontal: 12, fontSize: 13 },
  googleButton: {
    width: '100%', backgroundColor: '#1a1d27', borderWidth: 1, borderColor: '#2d3148',
    borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 20, minHeight: 52, justifyContent: 'center',
  },
  googleButtonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  link: { color: '#64748b', fontSize: 14, marginTop: 4 },
  linkBold: { color: '#a78bfa', fontWeight: '700' },
});