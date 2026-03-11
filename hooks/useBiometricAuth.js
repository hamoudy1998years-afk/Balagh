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
      console.log('[BiometricAuth] Migration complete — old Google tokens cleared');
    } catch (e) {
      console.log('Migration error:', e);
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
      if (creds.type === 'google' && !creds.refreshToken) return false;
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
      console.log('saveCredentials error:', e);
    }
  };

  const saveGoogleCredentials = async (identifier, email, refreshToken) => {
    try {
      if (!refreshToken) {
        console.log('saveGoogleCredentials: no refresh token, skipping');
        return false;
      }
      await SecureStore.setItemAsync(
        makeCredKey(email),
        JSON.stringify({ type: 'google', email, refreshToken })
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
      console.log('[BiometricAuth] Google credentials saved for:', email);
      return true;
    } catch (e) {
      console.log('saveGoogleCredentials error:', e);
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
      console.log('[BiometricAuth] Token auto-updated for:', email);
    } catch (e) {
      console.log('updateStoredGoogleToken error:', e);
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
      console.log('saveAccount error:', e);
    }
  };

  const loginWithBiometrics = async (email) => {
    const available = await isBiometricAvailable();
    if (!available) throw new Error('Biometrics not available on this device');

    const savedRaw = await SecureStore.getItemAsync(makeCredKey(email));
    if (!savedRaw) throw new Error('NO_CREDENTIALS');

    const creds = JSON.parse(savedRaw);
    if (creds.type === 'google' && !creds.refreshToken) {
      throw new Error('NO_CREDENTIALS');
    }

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Verify with Face ID or fingerprint',
      cancelLabel: 'Cancel',
      disableDeviceFallback: true,
    });

    if (!result.success) throw new Error('BIOMETRIC_CANCELLED');

    if (creds.type === 'google') {
      const { data, error } = await supabase.auth.refreshSession({
        refresh_token: creds.refreshToken,
      });

      if (error || !data?.session) {
        await SecureStore.deleteItemAsync(makeCredKey(email));
        throw new Error('SESSION_EXPIRED');
      }

      if (data.session.refresh_token) {
        await SecureStore.setItemAsync(
          makeCredKey(email),
          JSON.stringify({
            type: 'google',
            email,
            refreshToken: data.session.refresh_token,
          })
        );
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email: creds.email,
        password: creds.password,
      });
      if (error) throw error;
    }

    return true;
  };

  const clearCredentials = async (email = null) => {
    try {
      if (email) {
        await SecureStore.deleteItemAsync(makeCredKey(email));
        const accounts = await getSavedAccounts();
        const updated = accounts.filter((a) => a.email !== email);
        await SecureStore.setItemAsync(ACCOUNTS_LIST_KEY, JSON.stringify(updated));
      } else {
        const accounts = await getSavedAccounts();
        for (const acc of accounts) {
          await SecureStore.deleteItemAsync(makeCredKey(acc.email));
        }
        await SecureStore.deleteItemAsync(ACCOUNTS_LIST_KEY);
      }
    } catch (e) {
      console.log('clearCredentials error:', e);
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
      console.log('saveQuickPin error:', e);
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