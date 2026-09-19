import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { supabase } from '../lib/supabase';
import { STORAGE_KEYS, STORAGE_PREFIXES, getCredentialKey } from '../constants/storage';

const ACCOUNTS_LIST_KEY = STORAGE_KEYS.SAVED_ACCOUNTS;
const CREDS_VERSION_KEY = STORAGE_PREFIXES.CREDS + 'version';
const CURRENT_VERSION = '2';
const PIN_KEY_SUFFIX = '_pin';
const PIN_LOCKOUT_SUFFIX = '_pin_lockout';
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 30000; // 30 seconds

const makeCredKey = (email) => getCredentialKey(email);

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
      // For Google: need appPassword
      if (creds.type === 'google' && !creds.appPassword) return false;
      return true;
    } catch {
      return false;
    }
  };

  // ========== NEW: reconcileAccountEmail ==========
  // Given a saved_accounts entry (which may carry a stable Supabase `id`),
  // resolves the account's CURRENT email via the existing get_email_by_id RPC.
  // If it differs from the saved email (i.e. the user changed their email
  // since this device last saved credentials), migrates the SecureStore
  // credential + PIN blobs from the old email-key to the new one, and
  // updates the saved_accounts entry in place (matched by id, not email,
  // so the update survives the email change). Returns the email that should
  // actually be used for authentication.
  //
  // No-op (returns account.email unchanged) if:
  //  - account has no id yet (legacy entry, pre-dates this fix)
  //  - the RPC fails or returns nothing
  //  - the email hasn't actually changed
  const reconcileAccountEmail = async (account) => {
    if (!account?.id || !account?.email) return account?.email ?? null;

    try {
      const { data: currentEmail, error } = await supabase.rpc('get_email_by_id', {
        user_id: account.id,
      });

      if (error || !currentEmail || currentEmail === account.email) {
        return account.email;
      }

      __DEV__ && console.log('[BiometricAuth] Email changed, reconciling:', account.email, '->', currentEmail);

      const oldCredKey = makeCredKey(account.email);
      const newCredKey = makeCredKey(currentEmail);
      const oldPinKey = oldCredKey + PIN_KEY_SUFFIX;
      const newPinKey = newCredKey + PIN_KEY_SUFFIX;

      // --- Credential blob ---
      // If a credential already exists under the CURRENT email, it's the
      // authoritative one (e.g. the user already re-authenticated under the
      // new email through some other path and a fresh record was created).
      // Never overwrite it with a possibly-stale copy from the old email —
      // just clean up the now-redundant old key.
      const newCredExistingRaw = await SecureStore.getItemAsync(newCredKey);
      if (newCredExistingRaw) {
        __DEV__ && console.log('[BiometricAuth] Newer credential already exists at target key — not overwriting, cleaning up old key');
        await SecureStore.deleteItemAsync(oldCredKey);
      } else {
        const credRaw = await SecureStore.getItemAsync(oldCredKey);
        if (credRaw) {
          const migrated = JSON.stringify({ ...JSON.parse(credRaw), email: currentEmail });
          // Write-then-verify-then-delete: if the write or the read-back
          // fails, the old key is left untouched — safe and retryable, the
          // next reconcile call just tries again from the same state.
          await SecureStore.setItemAsync(newCredKey, migrated);
          const verify = await SecureStore.getItemAsync(newCredKey);
          if (verify) {
            await SecureStore.deleteItemAsync(oldCredKey);
          } else {
            __DEV__ && console.log('[BiometricAuth] Credential migration did not verify — leaving old key intact for retry');
          }
        }
      }

      // --- PIN blob (same skip-if-exists, write-verify-delete pattern) ---
      const newPinExistingRaw = await SecureStore.getItemAsync(newPinKey);
      if (newPinExistingRaw) {
        await SecureStore.deleteItemAsync(oldPinKey);
      } else {
        const pinRaw = await SecureStore.getItemAsync(oldPinKey);
        if (pinRaw) {
          await SecureStore.setItemAsync(newPinKey, pinRaw);
          const verifyPin = await SecureStore.getItemAsync(newPinKey);
          if (verifyPin) {
            await SecureStore.deleteItemAsync(oldPinKey);
          } else {
            __DEV__ && console.log('[BiometricAuth] PIN migration did not verify — leaving old key intact for retry');
          }
        }
      }

      // Update the saved_accounts entry IN PLACE, matched by id — this is
      // what makes it safe even though the email (the old lookup key) changed.
      const accounts = await getSavedAccounts();
      const idx = accounts.findIndex((a) => a.id === account.id);
      if (idx !== -1) {
        accounts[idx] = { ...accounts[idx], email: currentEmail };
        await SecureStore.setItemAsync(ACCOUNTS_LIST_KEY, JSON.stringify(accounts));
      }

      return currentEmail;
    } catch (e) {
      __DEV__ && console.log('reconcileAccountEmail error:', e);
      return account.email;
    }
  };

  // ========== NEW: backfillAccountId ==========
  // Self-heals legacy saved_accounts entries (saved before this fix) that
  // have no `id` yet. Called after any successful authentication where we
  // now know the Supabase user id — cheap, idempotent, no-op if already set.
  // This is what lets old accounts start benefiting from reconcileAccountEmail
  // going forward, without a dedicated migration pass.
  const backfillAccountId = async (email, userId) => {
    try {
      if (!email || !userId) return;
      const accounts = await getSavedAccounts();
      const idx = accounts.findIndex((a) => a.email === email);
      if (idx !== -1 && !accounts[idx].id) {
        accounts[idx] = { ...accounts[idx], id: userId };
        await SecureStore.setItemAsync(ACCOUNTS_LIST_KEY, JSON.stringify(accounts));
        __DEV__ && console.log('[BiometricAuth] Backfilled id for:', email);
      }

      // Keep the credential blob's userId in sync too, now that new
      // credentials carry it — no-op if already present.
      const credKey = makeCredKey(email);
      const credRaw = await SecureStore.getItemAsync(credKey);
      if (credRaw) {
        const creds = JSON.parse(credRaw);
        if (!creds.userId) {
          await SecureStore.setItemAsync(credKey, JSON.stringify({ ...creds, userId }));
        }
      }
    } catch (e) {
      __DEV__ && console.log('backfillAccountId error:', e);
    }
  };

  // ========== createGoogleSession (internal, shared) ==========
  // Single authoritative implementation of "turn a stored Google
  // appPassword into a verified Supabase session." Used by both
  // loginWithBiometrics()'s Google branch and loginGoogleAccount() below,
  // so there is exactly one place that creates the session, checks it
  // actually came back, verifies it belongs to the expected account id,
  // and backfills a missing id.
  const createGoogleSession = async (account, appPassword) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: account.email,
      password: appPassword,
    });

    if (error || !data?.session) {
      throw error || new Error('SESSION_EXPIRED');
    }

    const signedInUserId = data.user?.id ?? null;

    if (account.id && signedInUserId && account.id !== signedInUserId) {
      __DEV__ && console.log('[BiometricAuth] Account ID mismatch — rejecting');
      try {
        await supabase.auth.signOut();
      } catch (signOutErr) {
        __DEV__ && console.log('[BiometricAuth] signOut after ACCOUNT_MISMATCH error:', signOutErr);
      }
      throw new Error('ACCOUNT_MISMATCH');
    }

    if (!account.id && signedInUserId) {
      await backfillAccountId(account.email, signedInUserId);
    }

    return data;
  };

  // ========== loginGoogleAccount ==========
  // Consolidated entry point for "saved Google account -> verified
  // session," used by LoginScreen's Google saved-account biometric flow.
  // Looks up the stored credential, enforces appPassword, then delegates
  // to createGoogleSession() — the same logic loginWithBiometrics() uses
  // internally — so there is one authoritative implementation instead of two.
  const loginGoogleAccount = async (account) => {
    const targetEmail = account?.id
      ? await reconcileAccountEmail(account)
      : account?.email;

    const resolvedAccount =
      targetEmail && targetEmail !== account?.email
        ? { ...account, email: targetEmail }
        : account;

    const credKey = makeCredKey(resolvedAccount.email);
    const savedRaw = await SecureStore.getItemAsync(credKey);

    if (!savedRaw) throw new Error('NO_CREDENTIALS');

    const creds = JSON.parse(savedRaw);

    if (!creds.appPassword) {
      throw new Error('NO_APP_PASSWORD');
    }

    return await createGoogleSession(
      resolvedAccount,
      creds.appPassword
    );
  };

  // ========== loginWithPin ==========
  // Validates the PIN, then delegates to loginGoogleAccount() for the
  // actual session creation. Keeps PIN entry/validation UI-facing while
  // ensuring PIN logins get the exact same appPassword enforcement and
  // account-id verification as the biometric path.
  const loginWithPin = async (account, pin) => {
    const targetEmail = account.id ? await reconcileAccountEmail(account) : account.email;
    const resolvedAccount =
      targetEmail && targetEmail !== account.email
        ? { ...account, email: targetEmail }
        : account;

    await validateQuickPin(resolvedAccount.email, pin); // throws NO_PIN / INVALID_PIN / PIN_LOCKED
    return await loginGoogleAccount(resolvedAccount);
  };

  const saveCredentials = async (identifier, email, password, userId = null) => {
    try {
      await SecureStore.setItemAsync(
        makeCredKey(email),
        JSON.stringify({ type: 'password', email, password, userId })
      );
      const accounts = await getSavedAccounts();
      const exists = accounts.find((a) => a.email === email);
      if (!exists) {
        accounts.push({ identifier, email, provider: 'email', id: userId });
      } else {
        const idx = accounts.findIndex((a) => a.email === email);
        accounts[idx] = { ...accounts[idx], provider: 'email', id: userId ?? accounts[idx].id ?? null };
      }
      await SecureStore.setItemAsync(ACCOUNTS_LIST_KEY, JSON.stringify(accounts));
    } catch (e) {
      __DEV__ && console.log('saveCredentials error:', e);
    }
  };

  const saveGoogleCredentials = async (identifier, email, refreshToken, userId = null) => {
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
          userId: userId ?? existing.userId ?? null, // Preserve if exists
        })
      );

      const accounts = await getSavedAccounts();
      const exists = accounts.find((a) => a.email === email);
      if (!exists) {
        accounts.push({ identifier, email, provider: 'google', id: userId });
      } else {
        const idx = accounts.findIndex((a) => a.email === email);
        accounts[idx] = { ...accounts[idx], provider: 'google', identifier, id: userId ?? accounts[idx].id ?? null };
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

  const saveAccount = async (identifier, email, provider = 'email', userId = null) => {
    try {
      const accounts = await getSavedAccounts();
      const exists = accounts.find((a) => a.email === email);
      if (!exists) {
        accounts.push({ identifier, email, provider, id: userId });
        await SecureStore.setItemAsync(ACCOUNTS_LIST_KEY, JSON.stringify(accounts));
      } else if (userId && !exists.id) {
        const idx = accounts.findIndex((a) => a.email === email);
        accounts[idx] = { ...accounts[idx], id: userId };
        await SecureStore.setItemAsync(ACCOUNTS_LIST_KEY, JSON.stringify(accounts));
      }
    } catch (e) {
      __DEV__ && console.log('saveAccount error:', e);
    }
  };

  // ========== loginWithBiometrics — now reconciles email-by-id BEFORE touching credentials ==========
  // Accepts the full saved-account object (needs .email, and .id if available)
  // instead of a bare email string, so it can resolve the current email first
  // rather than knowingly attempting sign-in with a potentially stale one.
  const loginWithBiometrics = async (account) => {
    const rawEmail = typeof account === 'string' ? account : account?.email;
    const accountObj = typeof account === 'string' ? { email: account, id: null } : account;

    __DEV__ && console.log('[BIOMETRIC] ========== START ==========');
    __DEV__ && console.log('[BIOMETRIC] Email (saved):', rawEmail);

    const available = await isBiometricAvailable();
    __DEV__ && console.log('[BIOMETRIC] Biometric available:', available);

    if (!available) throw new Error('Biometrics not available on this device');

    // Preferred flow: id -> resolve current email -> migrate -> use resolved email.
    // Falls back to rawEmail unchanged if no id is stored yet (legacy account).
    const targetEmail = accountObj.id ? await reconcileAccountEmail(accountObj) : rawEmail;

    const savedRaw = await SecureStore.getItemAsync(makeCredKey(targetEmail));
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

    let signedInUserId = null;

    if (creds.type === 'google') {
      if (creds.appPassword) {
        __DEV__ && console.log('[BIOMETRIC] Using appPassword to create session...');
        let data;
        try {
          data = await createGoogleSession({ email: creds.email, id: accountObj.id }, creds.appPassword);
        } catch (sessionErr) {
          // NOTE: this is NOT a second reconciliation attempt. If this
          // account has no stored id, we have no safe way to recover here —
          // get_email_by_id needs the id, and the old (possibly stale) email
          // may no longer resolve to anything in auth.users. We just log the
          // fact for diagnostics. The account self-heals its id the next
          // time it authenticates successfully via a different path (e.g.
          // manual login, see backfillAccountId), after which
          // reconcileAccountEmail will work correctly on future attempts.
          if (!accountObj.id) {
            __DEV__ && console.log('[BIOMETRIC] AppPassword login failed and no id was available to reconcile — cannot recover a stale email without one');
          }
          throw sessionErr;
        }
        signedInUserId = data.user?.id ?? null;
        __DEV__ && console.log('[BIOMETRIC] Session created with appPassword');
      } else {
        __DEV__ && console.log('[BIOMETRIC] No appPassword available');
        throw new Error('NO_CREDENTIALS');
      }
    } else {
      __DEV__ && console.log('[BIOMETRIC] Logging in with password...');
      const { data, error } = await supabase.auth.signInWithPassword({
        email: creds.email,
        password: creds.password,
      });
      __DEV__ && console.log('[BIOMETRIC] Password login error:', error?.message || 'none');
      __DEV__ && console.log('[BIOMETRIC] Session returned:', !!data?.session);

      if (error || !data?.session) {
        throw error || new Error('SESSION_EXPIRED');
      }
      signedInUserId = data?.user?.id ?? null;
    }

    // Defensive identity check: if this saved account carries a stable id,
    // the session we just created must belong to that same user. A mismatch
    // here means the credential/session doesn't actually correspond to the
    // account the person selected — never treat that as a successful login.
    if (accountObj.id && signedInUserId && accountObj.id !== signedInUserId) {
      __DEV__ && console.log('[BIOMETRIC] Account ID mismatch — rejecting');
      try {
        await supabase.auth.signOut();
      } catch (signOutErr) {
        __DEV__ && console.log('[BIOMETRIC] signOut after ACCOUNT_MISMATCH error:', signOutErr);
      }
      throw new Error('ACCOUNT_MISMATCH');
    }

    // Self-heal: if this account didn't have an id stored yet, backfill it now
    // that we know it from the session — enables reconciliation next time.
    if (!accountObj.id && signedInUserId) {
      await backfillAccountId(targetEmail, signedInUserId);
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
    const lockoutKey = makeCredKey(email) + PIN_LOCKOUT_SUFFIX;

    try {
      const lockoutRaw = await SecureStore.getItemAsync(lockoutKey);
      if (lockoutRaw) {
        const lockout = JSON.parse(lockoutRaw);
        if (lockout.lockedUntil && lockout.lockedUntil > Date.now()) {
          const err = new Error('PIN_LOCKED');
          err.retryAfterMs = lockout.lockedUntil - Date.now();
          throw err;
        }
      }

      const savedRaw = await SecureStore.getItemAsync(makeCredKey(email) + PIN_KEY_SUFFIX);
      if (!savedRaw) throw new Error('NO_PIN');

      const pinData = JSON.parse(savedRaw);
      const enteredHash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        enteredPin
      );

      if (enteredHash !== pinData.pinHash) {
        const existingRaw = await SecureStore.getItemAsync(lockoutKey);
        const existing = existingRaw ? JSON.parse(existingRaw) : { count: 0 };
        const nextCount = (existing.count || 0) + 1;

        if (nextCount >= MAX_PIN_ATTEMPTS) {
          await SecureStore.setItemAsync(lockoutKey, JSON.stringify({
            count: 0,
            lockedUntil: Date.now() + PIN_LOCKOUT_MS,
          }));
        } else {
          await SecureStore.setItemAsync(lockoutKey, JSON.stringify({ count: nextCount }));
        }

        throw new Error('INVALID_PIN');
      }

      // Correct PIN — clear any attempt/lockout record.
      await SecureStore.deleteItemAsync(lockoutKey);

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
    loginGoogleAccount,
    loginWithPin,
    clearCredentials,
    hasQuickPin,
    saveQuickPin,
    validateQuickPin,
    reconcileAccountEmail,
    backfillAccountId,
  };
}