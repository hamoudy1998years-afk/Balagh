import { View, Text, TextInput, StyleSheet, Alert, ActivityIndicator, Animated, TouchableOpacity, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { COLORS } from '../constants/theme';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ResetPasswordScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  
  // Password visibility states
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  
  // Animation values
  const passwordOpacity = useRef(new Animated.Value(0)).current;
  const confirmOpacity = useRef(new Animated.Value(0)).current;

  // Toggle functions with animation
  const togglePassword = () => {
    setShowPassword(!showPassword);
    Animated.timing(passwordOpacity, {
      toValue: showPassword ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  const toggleConfirm = () => {
    setShowConfirm(!showConfirm);
    Animated.timing(confirmOpacity, {
      toValue: showConfirm ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  async function handleReset() {
    if (!password.trim() || !confirm.trim()) {
      Alert.alert('Missing Fields', 'Please enter and confirm your new password.');
      return;
    }
    if (password !== confirm) {
      Alert.alert('Mismatch', 'Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Too Short', 'Password must be at least 6 characters.');
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      Alert.alert('Error', error.message);
      return;
    }
    Alert.alert('Success! ✅', 'Your password has been reset.', [
      { text: 'Login', onPress: () => navigation.navigate('Login') }
    ]);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <ScrollView
      contentContainerStyle={[styles.container, { paddingTop: Math.max(28, insets.top + 16), paddingBottom: Math.max(28, insets.bottom + 16) }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Reset Password</Text>
      <Text style={styles.subtitle}>Enter your new password below</Text>
      
      {/* Password Input with Eye Icon */}
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          placeholder="New Password"
          placeholderTextColor="#4b5563"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
        />
        <TouchableOpacity 
          style={styles.eyeButton} 
          onPress={togglePassword}
          activeOpacity={0.7}
        >
          <Animated.View style={{ opacity: passwordOpacity.interpolate({
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

      {/* Confirm Password Input with Eye Icon */}
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          placeholder="Confirm New Password"
          placeholderTextColor="#4b5563"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry={!showConfirm}
          autoCapitalize="none"
        />
        <TouchableOpacity 
          style={styles.eyeButton} 
          onPress={toggleConfirm}
          activeOpacity={0.7}
        >
          <Animated.View style={{ opacity: confirmOpacity.interpolate({
            inputRange: [0, 1],
            outputRange: [0.6, 1]
          })}}>
            <MaterialCommunityIcons 
              name={showConfirm ? 'eye-off-outline' : 'eye-outline'} 
              size={22} 
              color={showConfirm ? COLORS.gold : '#6b7280'} 
            />
          </Animated.View>
        </TouchableOpacity>
      </View>

      <AnimatedButton style={styles.button} onPress={handleReset} disabled={loading}>
        {loading
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>Save New Password</Text>
        }
      </AnimatedButton>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: COLORS.bgDark,
    paddingHorizontal: 28,
    justifyContent: 'center',
  },
  title: { 
    fontSize: 28, 
    fontWeight: '700', 
    color: '#fff', 
    marginBottom: 8 
  },
  subtitle: { 
    fontSize: 14, 
    color: '#64748b', 
    marginBottom: 32 
  },
  inputContainer: {
    position: 'relative',
    marginBottom: 14,
  },
  input: {
    backgroundColor: '#1a1d27', 
    borderWidth: 1, 
    borderColor: '#2d3148',
    borderRadius: 12, 
    padding: 16, 
    paddingRight: 50, // Space for eye icon
    color: '#fff', 
    fontSize: 15,
  },
  eyeButton: {
    position: 'absolute',
    right: 16,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    width: 40,
  },
  button: {
    backgroundColor: COLORS.gold, 
    borderRadius: 12, 
    padding: 16,
    alignItems: 'center', 
    marginTop: 6,
  },
  buttonText: { 
    color: '#000', 
    fontSize: 16, 
    fontWeight: '700' 
  },
});