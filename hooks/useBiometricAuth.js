import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { supabase } from '../lib/supabase';

const ACCOUNTS_LIST_KEY = 'bushrann_saved_accounts';
const CREDS_PREFIX = 'bushrann_creds_';
const CREDS_VERSION_KEY = 'bushrann_creds_version';
const CURRENT_VERSION = '2';
const PIN_KEY_SUFFIX = '_pin';

const makeCredKey = (email) =>
  CREDS_PREFIX + email.toLowerCase().replace(/[^a-z0-9]/g, '_');

export function useBiometricAuth() {

  const runMigrationIfNeeded = async () => {
    try {
      const version = await SecureStore.getItemAsync(CREDS_VERSION_KEY);
      if (version === CURRENT_VERSION) return;

      const accounts = await getSavedAccounts();
      for (const acc of accounts) {
        if (acc.provider === 'google') {
          await SecureStore.deleteItemAsync(makeCredKey(acc.email));
        }
      }

      await SecureStore.setItemAsync(CREDS_VERSION_KEY, CURRENT_VERSION);
      __DEV__ && console.log('[BiometricAuth] Migration complete — old Google tokens cleared');
    } catch (e) {
      __DEV__ && console.log('Migration error:', e);
    }
  };

  const isBiometricAvailable = async () => {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return compatible && enrolled;
  };

  const getSavedAccounts = async () => {
    try {
      const raw = await SecureStore.getItemAsync(ACCOUNTS_LIST_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };

  const hasCredentials = async (email) => {
    try {
      const raw = await SecureStore.getItemAsync(makeCredKey(email));
      if (!raw) return false;
      const creds = JSON.parse(raw);
      // For Google: need appPassword (new) OR refreshToken (old fallback)
      if (creds.type === 'google' && !creds.appPassword && !creds.refreshToken) return false;
      return true;
    } catch {
      return false;
    }
  };

  const saveCredentials = async (identifier, email, password) => {
    try {
      await SecureStore.setItemAsync(
        makeCredKey(email),
        JSON.stringify({ type: 'password', email, password })
      );
      const accounts = await getSavedAccounts();
      const exists = accounts.find((a) => a.email === email);
      if (!exists) {
        accounts.push({ identifier, email, provider: 'email' });
      } else {
        const idx = accounts.findIndex((a) => a.email === email);
        accounts[idx] = { ...accounts[idx], provider: 'email' };
      }
      await SecureStore.setItemAsync(ACCOUNTS_LIST_KEY, JSON.stringify(accounts));
    } catch (e) {
      __DEV__ && console.log('saveCredentials error:', e);
    }
  };

  const saveGoogleCredentials = async (identifier, email, refreshToken) => {
    try {
      // Note: refreshToken is kept for backward compatibility but not used in new flow
      const credKey = makeCredKey(email);
      const existingRaw = await SecureStore.getItemAsync(credKey);
      const existing = existingRaw ? JSON.parse(existingRaw) : {};
      
      await SecureStore.setItemAsync(
        credKey,
        JSON.stringify({ 
          type: 'google', 
          email, 
          refreshToken, // Keep for old accounts
          appPassword: existing.appPassword || null, // Preserve if exists
          hasPin: existing.hasPin || false, // Preserve if exists
        })
      );
      
      const accounts = await getSavedAccounts();
      const exists = accounts.find((a) => a.email === email);
      if (!exists) {
        accounts.push({ identifier, email, provider: 'google' });
      } else {
        const idx = accounts.findIndex((a) => a.email === email);
        accounts[idx] = { ...accounts[idx], provider: 'google', identifier };
      }
      await SecureStore.setItemAsync(ACCOUNTS_LIST_KEY, JSON.stringify(accounts));
      __DEV__ && console.log('[BiometricAuth] Google credentials saved for:', email);
      return true;
    } catch (e) {
      __DEV__ && console.log('saveGoogleCredentials error:', e);
      return false;
    }
  };

  const updateStoredGoogleToken = async (email, newRefreshToken) => {
    try {
      if (!email || !newRefreshToken) return;
      const credKey = makeCredKey(email);
      const raw = await SecureStore.getItemAsync(credKey);
      if (!raw) return;
      const creds = JSON.parse(raw);
      if (creds.type !== 'google') return;
      await SecureStore.setItemAsync(
        credKey,
        JSON.stringify({ ...creds, refreshToken: newRefreshToken })
      );
      __DEV__ && console.log('[BiometricAuth] Token auto-updated for:', email);
    } catch (e) {
      __DEV__ && console.log('updateStoredGoogleToken error:', e);
    }
  };

  const saveAccount = async (identifier, email, provider = 'email') => {
    try {
      const accounts = await getSavedAccounts();
      const exists = accounts.find((a) => a.email === email);
      if (!exists) {
        accounts.push({ identifier, email, provider });
        await SecureStore.setItemAsync(ACCOUNTS_LIST_KEY, JSON.stringify(accounts));
      }
    } catch (e) {
      __DEV__ && console.log('saveAccount error:', e);
    }
  };

  // ========== FIXED: loginWithBiometrics - Use appPassword for Google accounts ==========
  const loginWithBiometrics = async (email) => {
    __DEV__ && console.log('[BIOMETRIC] ========== START ==========');
    __DEV__ && console.log('[BIOMETRIC] Email:', email);
    
    const available = await isBiometricAvailable();
    __DEV__ && console.log('[BIOMETRIC] Biometric available:', available);
    
    if (!available) throw new Error('Biometrics not available on this device');

    const savedRaw = await SecureStore.getItemAsync(makeCredKey(email));
    __DEV__ && console.log('[BIOMETRIC] Saved credentials found:', !!savedRaw);
    
    if (!savedRaw) {
      __DEV__ && console.log('[BIOMETRIC] NO CREDENTIALS - throwing error');
      throw new Error('NO_CREDENTIALS');
    }

    const creds = JSON.parse(savedRaw);
    __DEV__ && console.log('[BIOMETRIC] Credential type:', creds.type);
    __DEV__ && console.log('[BIOMETRIC] Has appPassword:', !!creds.appPassword);
    __DEV__ && console.log('[BIOMETRIC] Has refresh token:', !!creds.refreshToken);

    __DEV__ && console.log('[BIOMETRIC] Showing biometric prompt...');
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Verify with Face ID or fingerprint',
      cancelLabel: 'Cancel',
      disableDeviceFallback: true,
    });

    __DEV__ && console.log('[BIOMETRIC] Biometric result:', result.success);
    
    if (!result.success) {
      __DEV__ && console.log('[BIOMETRIC] Biometric cancelled/failed');
      throw new Error('BIOMETRIC_CANCELLED');
    }

    if (creds.type === 'google') {
      // ========== NEW FLOW: Use appPassword if available ==========
      if (creds.appPassword) {
        __DEV__ && console.log('[BIOMETRIC] Using appPassword to create session...');
        const { data, error } = await supabase.auth.signInWithPassword({
          email: creds.email,
          password: creds.appPassword,
        });
        
        __DEV__ && console.log('[BIOMETRIC] signInWithPassword error:', error?.message || 'none');
        __DEV__ && console.log('[BIOMETRIC] Session returned:', !!data?.session);
        
        if (error || !data?.session) {
          __DEV__ && console.log('[BIOMETRIC] AppPassword login failed');
          throw new Error('SESSION_EXPIRED');
        }
        
        __DEV__ && console.log('[BIOMETRIC] Session created with appPassword');
      } 
      // ========== FALLBACK: Old refresh token flow ==========
      else if (creds.refreshToken) {
        __DEV__ && console.log('[BIOMETRIC] No appPassword, falling back to refresh token...');
        const { data, error } = await supabase.auth.refreshSession({
          refresh_token: creds.refreshToken,
        });

        __DEV__ && console.log('[BIOMETRIC] Refresh error:', error?.message || 'none');
        __DEV__ && console.log('[BIOMETRIC] Session returned:', !!data?.session);

        if (error || !data?.session) {
          __DEV__ && console.log('[BIOMETRIC] Session refresh FAILED - deleting credentials');
          await SecureStore.deleteItemAsync(makeCredKey(email));
          throw new Error('SESSION_EXPIRED');
        }

        if (data.session.refresh_token) {
          __DEV__ && console.log('[BIOMETRIC] Saving new refresh token...');
          await SecureStore.setItemAsync(
            makeCredKey(email),
            JSON.stringify({
              ...creds,
              refreshToken: data.session.refresh_token,
            })
          );
        }

        __DEV__ && console.log('[BIOMETRIC] Setting Supabase session globally...');
        await supabase.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
      } else {
        __DEV__ && console.log('[BIOMETRIC] No appPassword or refreshToken available');
        throw new Error('NO_CREDENTIALS');
      }

    } else {
      __DEV__ && console.log('[BIOMETRIC] Logging in with password...');
      const { error } = await supabase.auth.signInWithPassword({
        email: creds.email,
        password: creds.password,
      });
      __DEV__ && console.log('[BIOMETRIC] Password login error:', error?.message || 'none');
      if (error) throw error;
    }

    __DEV__ && console.log('[BIOMETRIC] ========== SUCCESS ==========');
    return true;
  };

  const clearCredentials = async (email = null) => {
    try {
      if (email) {
        await SecureStore.deleteItemAsync(makeCredKey(email));
        await SecureStore.deleteItemAsync(makeCredKey(email) + PIN_KEY_SUFFIX);
        const accounts = await getSavedAccounts();
        const updated = accounts.filter((a) => a.email !== email);
        await SecureStore.setItemAsync(ACCOUNTS_LIST_KEY, JSON.stringify(updated));
      } else {
        const accounts = await getSavedAccounts();
        for (const acc of accounts) {
          await SecureStore.deleteItemAsync(makeCredKey(acc.email));
          await SecureStore.deleteItemAsync(makeCredKey(acc.email) + PIN_KEY_SUFFIX);
        }
        await SecureStore.deleteItemAsync(ACCOUNTS_LIST_KEY);
      }
    } catch (e) {
      __DEV__ && console.log('clearCredentials error:', e);
    }
  };

  const hasQuickPin = async (email) => {
    try {
      const pinData = await SecureStore.getItemAsync(makeCredKey(email) + PIN_KEY_SUFFIX);
      return !!pinData;
    } catch {
      return false;
    }
  };

  const saveQuickPin = async (email, pin) => {
    try {
      const hashedPin = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        pin
      );
      await SecureStore.setItemAsync(
        makeCredKey(email) + PIN_KEY_SUFFIX,
        JSON.stringify({
          pinHash: hashedPin,
          createdAt: Date.now()
        })
      );
      return true;
    } catch (e) {
      __DEV__ && console.log('saveQuickPin error:', e);
      return false;
    }
  };

  const validateQuickPin = async (email, enteredPin) => {
    try {
      const savedRaw = await SecureStore.getItemAsync(makeCredKey(email) + PIN_KEY_SUFFIX);
      if (!savedRaw) throw new Error('NO_PIN');

      const pinData = JSON.parse(savedRaw);
      const enteredHash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        enteredPin
      );
      
      if (enteredHash !== pinData.pinHash) {
        throw new Error('INVALID_PIN');
      }

      return true;
    } catch (e) {
      throw e;
    }
  };

  return {
    isBiometricAvailable,
    runMigrationIfNeeded,
    getSavedAccounts,
    hasCredentials,
    saveCredentials,
    saveGoogleCredentials,
    updateStoredGoogleToken,
    saveAccount,
    loginWithBiometrics,
    clearCredentials,
    hasQuickPin,
    saveQuickPin,
    validateQuickPin,
  };
}