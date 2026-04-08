import {
  View, Text, TextInput, StyleSheet,
  TouchableOpacity, Animated,
  Platform, StatusBar,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useBiometricAuth } from '../hooks/useBiometricAuth';
import AnimatedButton from './AnimatedButton';
import ModernDialog from './ModernDialog';
import { COLORS } from '../constants/theme';
import { ROUTES } from '../constants/routes';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUser } from '../context/UserContext';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { SystemBars } from 'react-native-edge-to-edge';

export default function SignupScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { user: authUser, setUser } = useUser();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [focusedField, setFocusedField] = useState(null);
  const [dialog, setDialog] = useState({ 
    visible: false, 
    title: '', 
    message: '', 
    type: 'info', 
    buttons: [] 
  });

  const passwordEyeOpacity = useRef(new Animated.Value(0)).current;
  const confirmEyeOpacity = useRef(new Animated.Value(0)).current;

  const { saveAccount } = useBiometricAuth();

  async function handleAutoLogin(loginEmail, loginPassword) {
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: loginEmail,
      password: loginPassword,
    });
    setLoading(false);
    
    if (error) {
      setDialog({
        visible: true,
        title: 'Login Failed',
        message: error.message || 'Please try logging in manually.',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => navigation.navigate(ROUTES.LOGIN) }]
      });
    } else if (data?.session) {
      // Set session user - App.js ensureProfileExists will create profile
      setUser(data.session.user);
      navigation.navigate(ROUTES.MAIN);
    }
  }

  const togglePassword = () => {
    setShowPassword(prev => !prev);
    Animated.timing(passwordEyeOpacity, {
      toValue: showPassword ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  const toggleConfirmPassword = () => {
    setShowConfirmPassword(prev => !prev);
    Animated.timing(confirmEyeOpacity, {
      toValue: showConfirmPassword ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  async function handleSignup() {
    if (!username.trim()) { 
      setDialog({ 
        visible: true, 
        title: 'Missing Field', 
        message: 'Please enter a username.', 
        type: 'error', 
        buttons: [{ text: 'OK', onPress: () => setDialog({ ...dialog, visible: false }) }] 
      }); 
      return; 
    }
    if (!email.trim() || !email.includes('@')) { 
      setDialog({ 
        visible: true, 
        title: 'Email Required', 
        message: 'Please enter a valid email address.', 
        type: 'error', 
        buttons: [{ text: 'OK', onPress: () => setDialog({ ...dialog, visible: false }) }] 
      }); 
      return; 
    }
    if (!password.trim()) { 
      setDialog({ 
        visible: true, 
        title: 'Missing Field', 
        message: 'Please enter a password.', 
        type: 'error', 
        buttons: [{ text: 'OK', onPress: () => setDialog({ ...dialog, visible: false }) }] 
      }); 
      return; 
    }
    if (password.trim().length < 8) { 
      setDialog({ 
        visible: true, 
        title: 'Weak Password', 
        message: 'Password must be at least 8 characters.', 
        type: 'error', 
        buttons: [{ text: 'OK', onPress: () => setDialog({ ...dialog, visible: false }) }] 
      }); 
      return; 
    }
    if (password.trim() !== confirmPassword.trim()) { 
      setDialog({ 
        visible: true, 
        title: 'Password Mismatch', 
        message: 'Passwords do not match.', 
        type: 'error', 
        buttons: [{ text: 'OK', onPress: () => setDialog({ ...dialog, visible: false }) }] 
      }); 
      return; 
    }

    const hasPhone = phone.trim().length > 0;
    setLoading(true);
    const authEmail = email.trim();

    const { data, error } = await supabase.auth.signUp({
      email: authEmail,
      password,
      options: { data: { username: username.trim() } },
    });

    if (error) {
      setLoading(false);
      if (error.message?.includes('already registered') || error.message?.includes('already exists') || error.code === '23505') {
        setDialog({ 
          visible: true, 
          title: 'Email Already Registered', 
          message: 'This email is already in use. Please login instead.', 
          type: 'error', 
          buttons: [{ text: 'OK', onPress: () => setDialog({ ...dialog, visible: false }) }] 
        });
      } else {
        setDialog({ 
          visible: true, 
          title: 'Signup Failed', 
          message: error.message || 'Please try again later.', 
          type: 'error', 
          buttons: [{ text: 'OK', onPress: () => setDialog({ ...dialog, visible: false }) }] 
        });
      }
      return;
    }

    if (data?.user) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const profileUpdate = { username: username.trim() };
      if (hasPhone) profileUpdate.phone = phone.trim();
      const { error: profileError } = await supabase
        .from('profiles')
        .update(profileUpdate)
        .eq('id', data.user.id);
      if (profileError) {
        __DEV__ && console.warn('Profile save failed:', profileError.message);
      }
    }

    await saveAccount(username.trim(), authEmail, 'email');
    setLoading(false);

    setDialog({
      visible: true,
      title: 'Account Created! 🎉',
      message: 'Your account is ready. Would you like to log in now?',
      type: 'success',
      buttons: [
        { 
          text: 'Yes, Log In', 
          onPress: () => handleAutoLogin(authEmail, password),
          style: 'default'
        },
        { 
          text: 'Later', 
          onPress: () => navigation.navigate(ROUTES.LOGIN),
          style: 'cancel'
        }
      ]
    });
  }

  const handleNavigateLogin = useCallback(() => {
    navigation.navigate(ROUTES.LOGIN);
  }, [navigation]);

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.bgDark }}>
      <SystemBars style="light" />
      <KeyboardAwareScrollView
        style={{ flex: 1, backgroundColor: COLORS.bgDark }}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom + 20,
          },
        ]}
        enableOnAndroid={true}
        enableAutomaticScroll={true}
        extraScrollHeight={Platform.select({ ios: 40, android: 60 })}
        extraHeight={Platform.select({ ios: 40, android: 60 })}
        keyboardOpeningTime={0}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Back Button */}
        <AnimatedButton
          onPress={navigation.goBack}
          style={{ alignSelf: 'flex-start', marginBottom: 24 }}
        >
          <View style={styles.backButton}>
            <MaterialCommunityIcons name="arrow-left" size={20} color={COLORS.gold} />
            <Text style={styles.backText}>Back</Text>
          </View>
        </AnimatedButton>

        {/* Header */}
        <View style={styles.headerContainer}>
          <Text style={styles.arabic}>بَلِّغُوا عَنِّي</Text>
          <Text style={styles.title}>Bushrann</Text>
          <Text style={styles.subtitle}>Create your account</Text>
        </View>

        {/* Form */}
        <View style={styles.formContainer}>

          {/* Username */}
          <View style={styles.inputWrapper}>
            <Text style={styles.label}>Username *</Text>
            {/* FIX: inputFocused moved to inputContainer so border actually changes */}
            <View style={[styles.inputContainer, focusedField === 'username' && styles.inputContainerFocused]}>
              <MaterialCommunityIcons name="account-outline" size={18} color={focusedField === 'username' ? COLORS.gold : '#8B92A8'} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Enter your username"
                placeholderTextColor="#8B92A8"
                value={username}
                onChangeText={setUsername}
                onFocus={() => setFocusedField('username')}
                onBlur={() => setFocusedField(null)}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                accessibilityLabel="Username input field"
                accessibilityHint="Enter your username"
              />
            </View>
          </View>

          {/* Email */}
          <View style={styles.inputWrapper}>
            <Text style={styles.label}>Email *</Text>
            <View style={[styles.inputContainer, focusedField === 'email' && styles.inputContainerFocused]}>
              <MaterialCommunityIcons name="email-outline" size={18} color={focusedField === 'email' ? COLORS.gold : '#8B92A8'} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Enter your email"
                placeholderTextColor="#8B92A8"
                value={email}
                onChangeText={setEmail}
                onFocus={() => setFocusedField('email')}
                onBlur={() => setFocusedField(null)}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                accessibilityLabel="Email input field"
                accessibilityHint="Enter your email address"
              />
            </View>
          </View>

          {/* Phone */}
          <View style={styles.inputWrapper}>
            <Text style={styles.label}>Phone Number <Text style={styles.optional}>(optional)</Text></Text>
            <View style={[styles.inputContainer, focusedField === 'phone' && styles.inputContainerFocused]}>
              <MaterialCommunityIcons name="phone-outline" size={18} color={focusedField === 'phone' ? COLORS.gold : '#8B92A8'} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Enter your phone number"
                placeholderTextColor="#8B92A8"
                value={phone}
                onChangeText={setPhone}
                onFocus={() => setFocusedField('phone')}
                onBlur={() => setFocusedField(null)}
                keyboardType="phone-pad"
                autoCapitalize="none"
                autoComplete="off"
                accessibilityLabel="Phone number input field"
                accessibilityHint="Enter your phone number"
              />
            </View>
          </View>

          {/* Password */}
          <View style={styles.inputWrapper}>
            <Text style={styles.label}>Password *</Text>
            <View style={[styles.inputContainer, focusedField === 'password' && styles.inputContainerFocused]}>
              <MaterialCommunityIcons name="lock-outline" size={18} color={focusedField === 'password' ? COLORS.gold : '#8B92A8'} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Min. 8 characters"
                placeholderTextColor="#8B92A8"
                value={password}
                onChangeText={setPassword}
                onFocus={() => setFocusedField('password')}
                onBlur={() => setFocusedField(null)}
                secureTextEntry={!showPassword}
                autoComplete="off"
                autoCorrect={false}
                autoCapitalize="none"
                textContentType="none"
                accessibilityLabel="Password input field"
                accessibilityHint="Enter your password"
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={togglePassword}
                activeOpacity={0.7}
              >
                <MaterialCommunityIcons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color={showPassword ? COLORS.gold : '#6b7280'}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Confirm Password */}
          <View style={styles.inputWrapper}>
            <Text style={styles.label}>Confirm Password *</Text>
            <View style={[styles.inputContainer, focusedField === 'confirm' && styles.inputContainerFocused]}>
              <MaterialCommunityIcons name="lock-check-outline" size={18} color={focusedField === 'confirm' ? COLORS.gold : '#8B92A8'} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Re-enter your password"
                placeholderTextColor="#8B92A8"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                onFocus={() => setFocusedField('confirm')}
                onBlur={() => setFocusedField(null)}
                secureTextEntry={!showConfirmPassword}
                autoComplete="off"
                autoCorrect={false}
                autoCapitalize="none"
                textContentType="none"
                accessibilityLabel="Confirm password input field"
                accessibilityHint="Re-enter your password"
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={toggleConfirmPassword}
                activeOpacity={0.7}
              >
                <MaterialCommunityIcons
                  name={showConfirmPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color={showConfirmPassword ? COLORS.gold : '#6b7280'}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Helper Text */}
          <Text style={styles.helperText}>
            * Username, email, and password are required.
          </Text>

          {/* Signup Button */}
          <AnimatedButton
            style={[styles.button, loading && { opacity: 0.7 }]}
            onPress={handleSignup}
            disabled={loading}
          >
            <Text style={styles.buttonText}>
              {loading ? 'Creating account...' : 'Create Account'}
            </Text>
          </AnimatedButton>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Login Link */}
          <AnimatedButton onPress={handleNavigateLogin} style={styles.loginLinkContainer}>
            <Text style={styles.link}>
              Already have an account?{' '}
              <Text style={styles.linkBold}>Login</Text>
            </Text>
          </AnimatedButton>

        </View>
      </KeyboardAwareScrollView>

      <ModernDialog
        visible={dialog.visible}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        buttons={dialog.buttons}
        onDismiss={() => setDialog({ ...dialog, visible: false })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
  },

  // Back button
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  backText: {
    color: COLORS.gold,
    fontSize: 15,
    fontWeight: '600',
  },

  // Header
  headerContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  arabic: {
    fontSize: 22,
    color: COLORS.gold,
    marginBottom: 6,
  },
  title: {
    fontSize: 34,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#8B92A8',
  },

  // Form
  formContainer: {
    width: '100%',
  },
  inputWrapper: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 6,
    marginLeft: 2,
  },
  optional: {
    color: '#8B92A8',
    fontWeight: '400',
  },

  // FIX: border is on inputContainer, focused style targets inputContainer too
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#E5E5E5',
    minHeight: 52,
  },
  inputContainerFocused: {
    borderColor: COLORS.gold,
    borderWidth: 2,
  },
  inputIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#1a2e44',
    paddingVertical: 14,
    paddingRight: 8,
  },
  eyeButton: {
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Helper
  helperText: {
    color: '#8B92A8',
    fontSize: 12,
    marginBottom: 20,
    marginTop: 4,
  },

  // Button
  button: {
    width: '100%',
    backgroundColor: COLORS.gold,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    marginBottom: 20,
  },
  buttonText: {
    color: COLORS.navy,
    fontSize: 16,
    fontWeight: '700',
  },

  // Divider
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  dividerText: {
    color: '#8B92A8',
    fontSize: 13,
    marginHorizontal: 12,
  },

  // Login link
  loginLinkContainer: {
    alignItems: 'center',
    paddingBottom: 10,
  },
  link: {
    color: '#8B92A8',
    fontSize: 14,
    textAlign: 'center',
  },
  linkBold: {
    color: COLORS.gold,
    fontWeight: '700',
  },
});