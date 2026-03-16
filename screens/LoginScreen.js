import {
  View,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  ScrollView,
  FlatList,
  Platform,
  ActivityIndicator,
  Modal,
  TouchableOpacity,
  Keyboard,
  Animated,
} from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { supabase } from '../lib/supabase';
import { useBiometricAuth } from '../hooks/useBiometricAuth';
import * as LocalAuthentication from 'expo-local-authentication';
import AnimatedButton from './AnimatedButton';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { userCache } from '../utils/userCache';
import { useUser } from '../context/UserContext';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { LoginManager, AccessToken } from 'react-native-fbsdk-next';
import { COLORS } from '../constants/theme';
import { s, ms } from '../utils/responsive';

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen({ navigation }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [facebookLoading, setFacebookLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [biometricType, setBiometricType] = useState(null);
  const [savedAccounts, setSavedAccounts] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [enteredPin, setEnteredPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [isCreatingPin, setIsCreatingPin] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');

  // Animation value for eye icon
  const eyeOpacity = useRef(new Animated.Value(0)).current;

  const { refreshUser } = useUser();
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
    hasQuickPin,
    validateQuickPin,
    saveQuickPin,
  } = useBiometricAuth();

  useEffect(() => {
    (async () => {
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

  const closeDropdown = () => {
    setShowDropdown(false);
    suppressDropdown.current = false;
  };

  // Toggle password visibility with animation
  const togglePassword = () => {
    setShowPassword(!showPassword);
    Animated.timing(eyeOpacity, {
      toValue: showPassword ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  const handleAccountSelect = async (account) => {
    closeDropdown();
    setLoading(true);
    setSelectedAccount(account);

    try {
      if (account.provider === 'email') {
        const available = await isBiometricAvailable();
        const hasCreds = await hasCredentials(account.email);

        if (available && hasCreds) {
          try {
            await loginWithBiometrics(account.email);
            navigation.navigate('Main');
            return;
          } catch (e) {
            if (e.message === 'BIOMETRIC_CANCELLED') {
              setLoading(false);
              return;
            }
          }
        }

        setIdentifier(account.email);
        setLoading(false);
        return;
      }

      if (account.provider === 'google') {
        const hasPin = await hasQuickPin(account.email);

        if (hasPin) {
          const bioAvailable = await isBiometricAvailable();

          if (bioAvailable) {
            const bioResult = await LocalAuthentication.authenticateAsync({
              promptMessage: 'Verify to login instantly',
              cancelLabel: 'Use PIN',
            });

            if (bioResult.success) {
              setLoading(false);
              navigation.navigate('Main');
              return;
            }
          }

          setLoading(false);
          setPinModalVisible(true);
          setIsCreatingPin(false);
          setEnteredPin('');
          setPinError('');
          return;
        }

        setLoading(false);
        Alert.alert(
          '⚡ Enable Instant Login',
          'Create a 4-digit PIN to skip Google sign-in next time. Takes 10 seconds.',
          [
            {
              text: 'Set Up Now',
              onPress: () => {
                setPinModalVisible(true);
                setIsCreatingPin(true);
                setNewPin('');
                setConfirmPin('');
              }
            },
            {
              text: 'Use Google',
              onPress: () => handleGoogleLogin(),
              style: 'cancel'
            }
          ]
        );
      }
    } catch (e) {
      console.log('handleAccountSelect error:', e);
      setLoading(false);
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

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);

    if (error) {
      Alert.alert('Login Failed', error.message);
      return;
    }

    if (data?.user) {
      await userCache.clear();
      await userCache.set(data.user);
      await refreshUser();
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
                navigation.navigate('Main');
              },
            },
            {
              text: 'Enable',
              onPress: async () => {
                await saveCredentials(identifier.trim(), email, password);
                await refreshAccountsList();
                navigation.navigate('Main');
              },
            },
          ]
        );
      } else {
        await refreshAccountsList();
        navigation.navigate('Main');
      }
    } else {
      await saveAccount(identifier.trim(), email, 'email');
      await refreshAccountsList();
      navigation.navigate('Main');
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

        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

          const userWithProfile = {
            ...user,
            ...profile,
            full_name: profile?.full_name || displayName,
          };

          await userCache.clear();
          await userCache.set(userWithProfile);
          await refreshUser();
        }
      }

      setTimeout(async () => {
        const bioAvailable = await isBiometricAvailable();

        Alert.alert(
          '⚡ Enable Instant Login?',
          bioAvailable
            ? 'Create a 4-digit PIN to skip Google sign-in next time. Just tap your account and use Face ID or fingerprint.'
            : 'Create a 4-digit PIN to skip Google sign-in next time.',
          [
            {
              text: 'Set Up Now',
              onPress: () => {
                setSelectedAccount({ email: userEmail, provider: 'google' });
                setPinModalVisible(true);
                setIsCreatingPin(true);
                setNewPin('');
                setConfirmPin('');
              }
            },
            {
              text: 'Later',
              onPress: () => navigation.navigate('Main'),
              style: 'cancel'
            }
          ]
        );
      }, 500);
    }

    navigation.navigate('Main');
    silentReAuth.current = false;
    setGoogleLoading(false);
  }

  async function handleFacebookLogin() {
    setFacebookLoading(true);
    try {
      const result = await LoginManager.logInWithPermissions(['public_profile', 'email']);
      if (result.isCancelled) { setFacebookLoading(false); return; }
      const data = await AccessToken.getCurrentAccessToken();
      if (!data) throw new Error('No access token');
      const { data: authData, error } = await supabase.auth.signInWithIdToken({
        provider: 'facebook',
        token: data.accessToken,
      });
      if (error) throw error;
      await userCache.clear();
      await userCache.set(authData.user);
      await refreshUser();
      navigation.navigate('Main');
    } catch (e) {
      Alert.alert('Facebook Login Failed', e.message);
    }
    setFacebookLoading(false);
  }

  const handleIdentifierFocus = () => {
    if (suppressDropdown.current) {
      suppressDropdown.current = false;
      return;
    }
    if (savedAccounts.length > 0) {
      setShowDropdown(true);
    }
  };

  const handleIdentifierBlur = () => {
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

  const biometricIcon = biometricType === 'face' ? 'face-recognition' : 'fingerprint';

  const handlePinKeyPress = async (key) => {
    if (isCreatingPin) {
      if (key === 'back') {
        if (confirmPin.length > 0) {
          setConfirmPin(confirmPin.slice(0, -1));
        } else if (newPin.length > 0) {
          setNewPin(newPin.slice(0, -1));
        }
      } else if (key === 'enter') {
        if (newPin.length < 4) {
          setPinError('Enter 4 digits');
          return;
        }
        if (confirmPin.length < 4) {
          setPinError('Confirm your PIN');
          return;
        }
        if (newPin !== confirmPin) {
          setPinError('PINs do not match');
          setConfirmPin('');
          return;
        }

        const saved = await saveQuickPin(selectedAccount.email, newPin);
        if (saved) {
          setPinModalVisible(false);
          setNewPin('');
          setConfirmPin('');
          navigation.navigate('Main');
        } else {
          setPinError('Failed to save PIN');
        }
      } else {
        if (newPin.length < 4) {
          setNewPin(newPin + key);
        } else if (confirmPin.length < 4) {
          setConfirmPin(confirmPin + key);
        }
      }
    } else {
      if (key === 'back') {
        setEnteredPin(enteredPin.slice(0, -1));
        setPinError('');
      } else if (key === 'enter') {
        if (enteredPin.length !== 4) {
          setPinError('Enter 4 digits');
          return;
        }

        try {
          await validateQuickPin(selectedAccount.email, enteredPin);

          const credKey = 'bushrann_creds_' + selectedAccount.email.toLowerCase().replace(/[^a-z0-9]/g, '_');
          const savedRaw = await SecureStore.getItemAsync(credKey);
          if (savedRaw) {
            const creds = JSON.parse(savedRaw);
            if (creds.type === 'google' && creds.refreshToken) {
              const { data, error } = await supabase.auth.refreshSession({
                refresh_token: creds.refreshToken,
              });
              if (error || !data?.session) {
                setPinError('Session expired. Please login with Google again.');
                return;
              }
              await SecureStore.setItemAsync(credKey, JSON.stringify({
                ...creds,
                refreshToken: data.session.refresh_token,
              }));
            }
          }

          setPinModalVisible(false);
          setEnteredPin('');
          navigation.navigate('Main');
        } catch (e) {
          if (e.message === 'INVALID_PIN') {
            setPinError('Wrong PIN');
            setEnteredPin('');
          } else {
            setPinError('Error validating PIN');
          }
        }
      } else {
        if (enteredPin.length < 4) {
          setEnteredPin(enteredPin + key);
          setPinError('');
        }
      }
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.bgDark }}>
      <TouchableWithoutFeedback onPress={closeDropdown}>
        <KeyboardAvoidingView 
          style={{ flex: 1, backgroundColor: COLORS.bgDark }} 
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            style={{ flex: 1, backgroundColor: COLORS.bgDark }}
            contentContainerStyle={styles.container}
            keyboardShouldPersistTaps="handled"
            scrollEnabled={!showDropdown}
            nestedScrollEnabled={true}
          >
            <AnimatedButton onPress={() => navigation.navigate('Main')} style={{ alignSelf: 'flex-start', marginBottom: 16 }}>
              <Text style={{ color: '#a78bfa', fontSize: 16 }}>← Back</Text>
            </AnimatedButton>
            <Text style={styles.arabic}>بَلِّغُوا عَنِّي</Text>
            <Text style={styles.title}>Bushrann</Text>
            <Text style={styles.subtitle}>Welcome back</Text>

            <View style={styles.inputWrapper}>
              <TextInput
                style={[styles.input, showDropdown && { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }]}
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
                <ScrollView
                  style={styles.dropdown}
                  nestedScrollEnabled={true}
                  scrollEnabled={true}
                  keyboardShouldPersistTaps="handled"
                  onStartShouldSetResponder={() => true}
                >
                  {savedAccounts.map((account, idx) => (
                    <TouchableOpacity
                      key={idx}
                      style={[styles.dropdownItem, idx < savedAccounts.length - 1 && styles.dropdownItemBorder]}
                      onPress={() => { closeDropdown(); handleAccountSelect(account); }}
                      activeOpacity={0.7}
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
                      <MaterialCommunityIcons name={biometricIcon} size={22} color="#a78bfa" />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
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
                <TouchableOpacity 
                  style={styles.eyeButton} 
                  onPress={togglePassword}
                  activeOpacity={0.7}
                >
                  <Animated.View style={{ opacity: eyeOpacity.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.6, 1]
                  })}}>
                    <MaterialCommunityIcons 
                      name={showPassword ? 'eye-off-outline' : 'eye-outline'} 
                      size={22} 
                      color={showPassword ? COLORS.gold : '#6b7280'} 
                    />
                  </Animated.View>
                </TouchableOpacity>
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

            <AnimatedButton style={styles.facebookButton} onPress={handleFacebookLogin} disabled={facebookLoading}>
              {facebookLoading ? <ActivityIndicator color="#fff" /> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <MaterialCommunityIcons name="facebook" size={22} color="#fff" />
              <Text style={styles.facebookButtonText}>Continue with Facebook</Text>
            </View>}
            </AnimatedButton>

            <AnimatedButton onPress={() => {
              Alert.alert('Reset Password', 'Enter your email to receive a reset link.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Send', onPress: async () => {
                  if (!identifier.trim()) { Alert.alert('Enter your email first'); return; }
                  const { error } = await supabase.auth.resetPasswordForEmail(identifier.trim());
                  if (error) Alert.alert('Error', error.message);
                  else Alert.alert('Sent! ✉️', 'Check your email for the reset link.');
                }},
              ]);
            }}>
              <Text style={[styles.link, { color: COLORS.gold }]}>Forgot Password?</Text>
            </AnimatedButton>

            <AnimatedButton onPress={() => navigation.navigate('Signup')}>
              <Text style={styles.link}>
                Don't have an account?{' '}
                <Text style={styles.linkBold}>Sign up</Text>
              </Text>
            </AnimatedButton>

            <Modal
              animationType="slide"
              transparent={true}
              visible={pinModalVisible}
              onRequestClose={() => {
                setPinModalVisible(false);
                setEnteredPin('');
                setNewPin('');
                setConfirmPin('');
                setPinError('');
              }}
            >
              <View style={styles.modalOverlay}>
                <View style={styles.modalContent}>
                  <Text style={styles.modalTitle}>
                    {isCreatingPin ? 'Create Quick PIN' : 'Enter PIN'}
                  </Text>

                  <Text style={styles.modalSubtitle}>
                    {isCreatingPin
                      ? 'This PIN is only stored on your device'
                      : selectedAccount?.email
                    }
                  </Text>

                  <View style={styles.pinDisplay}>
                    {[0, 1, 2, 3].map((index) => (
                      <View
                        key={index}
                        style={[
                          styles.pinDot,
                          (isCreatingPin
                            ? (confirmPin.length > index || (confirmPin.length === 0 && newPin.length > index))
                            : enteredPin.length > index
                          ) && styles.pinDotFilled
                        ]}
                      />
                    ))}
                  </View>

                  {pinError ? <Text style={styles.pinError}>{pinError}</Text> : null}

                  <View style={styles.keypad}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 'back', 0, 'enter'].map((key) => (
                      <TouchableOpacity
                        key={key}
                        style={styles.keypadButton}
                        onPress={() => handlePinKeyPress(key)}
                      >
                        <Text style={styles.keypadButtonText}>
                          {key === 'back' ? '⌫' : key === 'enter' ? '→' : key}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => {
                      setPinModalVisible(false);
                      setEnteredPin('');
                      setNewPin('');
                      setConfirmPin('');
                      setPinError('');
                    }}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </Modal>
          </ScrollView>
        </KeyboardAvoidingView>
      </TouchableWithoutFeedback>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1, backgroundColor: COLORS.bgDark, alignItems: 'center',
    justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 40,
  },
  arabic: { fontSize: 24, color: COLORS.gold, marginBottom: 8 },
  title: { fontSize: 36, fontWeight: 'bold', color: '#ffffff', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', marginBottom: 36 },
  inputWrapper: { width: '100%', zIndex: 999, marginBottom: 14 },
  input: {
    width: '100%', backgroundColor: COLORS.bgCard, borderWidth: 1,
    borderColor: COLORS.borderDark, borderRadius: 12,
    padding: 16, color: COLORS.textWhite, fontSize: 15,
  },
  dropdown: {
    width: '100%', height: 200,
    backgroundColor: '#1a1d27',
    borderWidth: 1, borderTopWidth: 0, borderColor: '#2d3148',
    borderBottomLeftRadius: 12, borderBottomRightRadius: 12,
    overflow: 'hidden',
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
  passwordInput: { 
    flex: 1, 
    paddingVertical: 16, 
    color: '#ffffff', 
    fontSize: 15,
    paddingRight: 40, // Space for eye icon
  },
  eyeButton: {
    position: 'absolute',
    right: 12,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    width: 40,
    height: '100%',
  },
  button: {
    width: '100%', backgroundColor: COLORS.gold, borderRadius: 12, padding: 16,
    alignItems: 'center', marginTop: 6, marginBottom: 20, zIndex: 1, minHeight: 52, justifyContent: 'center',
  },
  buttonText: { color: COLORS.navy, fontSize: 16, fontWeight: '700' },
  dividerContainer: { width: '100%', flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: COLORS.borderDark },
  dividerText: { color: COLORS.navyLight, marginHorizontal: 12, fontSize: 13 },
  googleButton: {
    width: '100%', backgroundColor: COLORS.bgCard, borderWidth: 1, borderColor: COLORS.borderDark,
    borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 20, minHeight: 52, justifyContent: 'center',
  },
  googleButtonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  link: { color: COLORS.textGray, fontSize: 14, marginTop: 4 },
  linkBold: { color: COLORS.gold, fontWeight: '700' },
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center',
  },
  facebookButton: {
    width: '100%', backgroundColor: '#1877F2', borderRadius: 12, padding: 16,
    alignItems: 'center', marginBottom: 20, minHeight: 52, justifyContent: 'center',
  },
  facebookButtonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  modalContent: {
    backgroundColor: 'white', borderRadius: 20,
    padding: 30, width: '80%', alignItems: 'center',
  },
  modalTitle: { fontSize: 22, fontWeight: 'bold', marginBottom: 10, color: '#333' },
  modalSubtitle: { fontSize: 14, color: '#666', marginBottom: 30, textAlign: 'center' },
  pinDisplay: { flexDirection: 'row', marginBottom: 20, gap: 15 },
  pinDot: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: '#ccc', backgroundColor: 'transparent',
  },
  pinDotFilled: { backgroundColor: '#333', borderColor: '#333' },
  pinError: { color: '#ff4444', marginBottom: 15, fontSize: 14 },
  keypad: {
    flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'center', width: s(240), gap: 10, marginBottom: 20,
  },
  keypadButton: {
    width: s(70), height: s(70), borderRadius: s(35),
    backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center',
  },
  keypadButtonText: { fontSize: ms(24), color: '#333', fontWeight: '600' },
  cancelButton: { paddingVertical: 12, paddingHorizontal: 30 },
  cancelButtonText: { color: '#666', fontSize: 16 },
  accountModalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-start', alignItems: 'center',
    paddingTop: 350,
  },
  accountModalBox: {
    width: '85%', maxHeight: 200,
    backgroundColor: '#1a1d27', borderRadius: 16,
    borderWidth: 1, borderColor: '#2d3148',
    overflow: 'hidden',
  },
  accountModalTitle: {
    color: '#a78bfa', fontWeight: '700', fontSize: 15,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#2d3148',
  },
});