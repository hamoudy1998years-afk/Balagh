import {
  View,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  StyleSheet,
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
import ModernDialog from './ModernDialog';

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
  const [pinStep, setPinStep] = useState('create');
  const [visiblePin, setVisiblePin] = useState('');
  const [visibleConfirmPin, setVisibleConfirmPin] = useState('');

  const [dialog, setDialog] = useState({ 
    visible: false, 
    title: '', 
    message: '', 
    type: 'info', 
    buttons: [] 
  });

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
        setDialog({
          visible: true,
          title: '⚡ Enable Instant Login',
          message: 'Create a 4-digit PIN to skip Google sign-in next time. Takes 10 seconds.',
          type: 'info',
          buttons: [
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
              style: 'cancel',
              onPress: () => handleGoogleLogin(),
            }
          ]
        });
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
      setDialog({
        visible: true,
        title: 'Missing Fields',
        message: 'Please enter your email/username and password.',
        type: 'warning',
        buttons: [{ text: 'OK' }]
      });
      return;
    }

    setLoading(true);
    let email;

    try {
      email = await resolveEmail(identifier);
    } catch (e) {
      setLoading(false);
      setDialog({
        visible: true,
        title: 'Login Failed',
        message: e.message,
        type: 'error',
        buttons: [{ text: 'OK' }]
      });
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);

    if (error) {
      setDialog({
        visible: true,
        title: 'Login Failed',
        message: error.message,
        type: 'error',
        buttons: [{ text: 'OK' }]
      });
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
        setDialog({
          visible: true,
          title: `Enable ${label} Sign-In?`,
          message: `Next time, just tap your account and use your ${label.toLowerCase()} — no typing needed.`,
          type: 'info',
          buttons: [
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
        });
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
      setDialog({
        visible: true,
        title: 'Google Login Failed',
        message: error.message,
        type: 'error',
        buttons: [{ text: 'OK' }]
      });
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
        setDialog({
          visible: true,
          title: 'Google Login Failed',
          message: 'Could not retrieve session. Please try again.',
          type: 'error',
          buttons: [{ text: 'OK' }]
        });
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

        setDialog({
          visible: true,
          title: '⚡ Enable Instant Login?',
          message: bioAvailable
            ? 'Create a 4-digit PIN to skip Google sign-in next time. Just tap your account and use Face ID or fingerprint.'
            : 'Create a 4-digit PIN to skip Google sign-in next time.',
          type: 'info',
          buttons: [
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
              style: 'cancel',
              onPress: () => navigation.navigate('Main'),
            }
          ]
        });
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
      setDialog({
        visible: true,
        title: 'Facebook Login Failed',
        message: e.message,
        type: 'error',
        buttons: [{ text: 'OK' }]
      });
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
      if (pinStep === 'create') {
        if (key === 'back') {
          if (newPin.length > 0) {
            const deletedDigit = newPin[newPin.length - 1];
            const updated = newPin.slice(0, -1);
            setNewPin(updated);
            setVisiblePin(deletedDigit);
            
            setTimeout(() => {
              setVisiblePin('');
            }, 500);
          }
        } else if (key === 'enter') {
          if (newPin.length !== 4) {
            setPinError('Enter 4 digits');
            return;
          }
          setPinStep('confirm');
          setPinError('');
          setVisiblePin('');
        } else {
          if (newPin.length < 4) {
            const updated = newPin + key;
            setNewPin(updated);
            setVisiblePin(key);
            
            setTimeout(() => {
              setVisiblePin('');
            }, 500);
          }
        }
      } else if (pinStep === 'confirm') {
        if (key === 'back') {
          if (confirmPin.length > 0) {
            const deletedDigit = confirmPin[confirmPin.length - 1];
            const updated = confirmPin.slice(0, -1);
            setConfirmPin(updated);
            setVisibleConfirmPin(deletedDigit);
            
            setTimeout(() => {
              setVisibleConfirmPin('');
            }, 500);
          }
        } else if (key === 'enter') {
          if (confirmPin.length !== 4) {
            setPinError('Enter 4 digits');
            return;
          }
          if (newPin !== confirmPin) {
            setPinError('PINs do not match');
            setConfirmPin('');
            setVisibleConfirmPin('');
            return;
          }

          const saved = await saveQuickPin(selectedAccount.email, newPin);
          if (saved) {
            setPinModalVisible(false);
            setNewPin('');
            setConfirmPin('');
            setPinStep('create');
            navigation.navigate('Main');
          } else {
            setPinError('Failed to save PIN');
          }
        } else {
          if (confirmPin.length < 4) {
            const updated = confirmPin + key;
            setConfirmPin(updated);
            setVisibleConfirmPin(key);
            
            setTimeout(() => {
              setVisibleConfirmPin('');
            }, 500);
          }
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

  const showResetPasswordDialog = () => {
    setDialog({
      visible: true,
      title: 'Reset Password',
      message: 'Enter your email to receive a reset link.',
      type: 'info',
      buttons: [
        { 
          text: 'Cancel', 
          style: 'cancel'
        },
        { 
          text: 'Send', 
          onPress: async () => {
            if (!identifier.trim()) { 
              setDialog({
                visible: true,
                title: 'Error',
                message: 'Enter your email first',
                type: 'warning',
                buttons: [{ text: 'OK' }]
              });
              return; 
            }
            const { error } = await supabase.auth.resetPasswordForEmail(identifier.trim());
            if (error) {
              setDialog({
                visible: true,
                title: 'Error',
                message: error.message,
                type: 'error',
                buttons: [{ text: 'OK' }]
              });
            } else {
              setDialog({
                visible: true,
                title: 'Sent! ✉️',
                message: 'Check your email for the reset link.',
                type: 'success',
                buttons: [{ text: 'OK' }]
              });
            }
          }
        },
      ]
    });
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
              <Text style={{ color: COLORS.gold, fontSize: 16 }}>← Back</Text>
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
                onPressIn={handleIdentifierFocus}
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
              {googleLoading ? <ActivityIndicator color="#4285F4" /> : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={styles.googleIconContainer}>
                    <Text style={styles.googleG}>G</Text>
                  </View>
                  <Text style={styles.googleButtonText}>Continue with Google</Text>
                </View>
              )}
            </AnimatedButton>

            <AnimatedButton style={styles.facebookButton} onPress={handleFacebookLogin} disabled={facebookLoading}>
              {facebookLoading ? <ActivityIndicator color="#fff" /> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <MaterialCommunityIcons name="facebook" size={22} color="#fff" />
              <Text style={styles.facebookButtonText}>Continue with Facebook</Text>
            </View>}
            </AnimatedButton>

            <AnimatedButton onPress={showResetPasswordDialog}>
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
                setPinStep('create');
                setVisiblePin('');
                setVisibleConfirmPin('');
              }}
            >
              <View style={styles.modalOverlay}>
                <View style={styles.modalContent}>
                  <Text style={styles.modalTitle}>
                    {isCreatingPin 
                      ? (pinStep === 'confirm' ? 'Confirm your PIN' : 'Create Quick PIN')
                      : 'Enter PIN'
                    }
                  </Text>

                  {isCreatingPin && pinStep === 'confirm' ? (
                    <Text style={styles.modalSubtitleHighlight}>
                      Re-enter your PIN to confirm
                    </Text>
                  ) : (
                    <Text style={styles.modalSubtitle}>
                      {isCreatingPin
                        ? 'This PIN is only stored on your device'
                        : selectedAccount?.email
                      }
                    </Text>
                  )}
                  
                  <View style={styles.pinDisplay}>
                    {[0, 1, 2, 3].map((index) => {
                      let isFilled = false;
                      let showNumber = null;
                      
                      if (isCreatingPin) {
                        if (pinStep === 'create') {
                          isFilled = newPin.length > index;
                          if (index === newPin.length - 1 && visiblePin && visiblePin !== '') {
                            showNumber = visiblePin;
                          }
                        } else {
                          isFilled = confirmPin.length > index;
                          if (index === confirmPin.length - 1 && visibleConfirmPin && visibleConfirmPin !== '') {
                            showNumber = visibleConfirmPin;
                          }
                        }
                      } else {
                        isFilled = enteredPin.length > index;
                      }
                      
                      return (
                        <View
                          key={index}
                          style={[
                            styles.pinDot,
                            isFilled && styles.pinDotFilled,
                            showNumber && styles.pinDotWithNumber
                          ]}
                        >
                          {showNumber && <Text style={styles.pinNumber}>{showNumber}</Text>}
                        </View>
                      );
                    })}
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
                      setPinStep('create');
                      setVisiblePin('');
                      setVisibleConfirmPin('');
                    }}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </Modal>

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
    paddingRight: 40,
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
    width: '100%', 
    backgroundColor: '#ffffff', 
    borderWidth: 1, 
    borderColor: '#dadce0',
    borderRadius: 12, 
    padding: 14, 
    alignItems: 'center', 
    marginBottom: 20, 
    minHeight: 52, 
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  googleButtonText: { 
    color: '#3c4043', 
    fontSize: 15, 
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  googleIconContainer: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleG: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#EA4335',
  },
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
    backgroundColor: COLORS.bgCard || '#1a1d27', 
    borderRadius: 24,
    padding: 32, 
    width: '85%', 
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(212, 175, 55, 0.2)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.4,
    shadowRadius: 40,
    elevation: 10,
  },
  modalTitle: { 
    fontSize: 24, 
    fontWeight: '800', 
    marginBottom: 8, 
    color: '#ffffff',
    letterSpacing: -0.5,
  },
  modalSubtitle: { 
    fontSize: 14, 
    color: 'rgba(255,255,255,0.6)', 
    marginBottom: 32, 
    textAlign: 'center',
    lineHeight: 20,
  },
  modalSubtitleHighlight: {
    fontSize: 15,
    color: COLORS.gold,
    marginBottom: 32,
    textAlign: 'center',
    fontWeight: '700',
    backgroundColor: 'rgba(212, 175, 55, 0.15)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
    overflow: 'hidden',
  },
  pinDisplay: { 
    flexDirection: 'row', 
    marginBottom: 32, 
    gap: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinDot: {
    width: 20, 
    height: 20, 
    borderRadius: 10,
    borderWidth: 2, 
    borderColor: 'rgba(212, 175, 55, 0.4)',
    backgroundColor: 'transparent',
  },
  pinDotFilled: { 
    backgroundColor: COLORS.gold, 
    borderColor: COLORS.gold,
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 4,
  },
  pinDotWithNumber: {
    backgroundColor: '#ffffff',
    borderColor: COLORS.gold,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 15,
    elevation: 6,
    transform: [{ scale: 1.15 }],
  },
  pinNumber: {
    color: '#1a1d27',
    fontSize: 14,
    fontWeight: '800',
  },
  pinError: { 
    color: '#ef4444', 
    marginBottom: 20, 
    fontSize: 14,
    fontWeight: '600',
  },
  keypad: {
    flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'center', width: s(240), gap: 10, marginBottom: 20,
  },
  keypadButton: {
    width: s(72), 
    height: s(72), 
    borderRadius: s(36),
    backgroundColor: 'rgba(255,255,255,0.05)', 
    justifyContent: 'center', 
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(212, 175, 55, 0.3)',
  },
  keypadButtonText: { 
    fontSize: ms(26), 
    color: '#ffffff', 
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  cancelButton: { 
    paddingVertical: 12, 
    paddingHorizontal: 30,
    marginTop: 8,
  },
  cancelButtonText: { 
    color: 'rgba(255,255,255,0.6)', 
    fontSize: 16,
    fontWeight: '600',
  },
});