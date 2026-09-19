import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { STORAGE_KEYS } from '../constants/storage';

const USER_CACHE_KEY = STORAGE_KEYS.USER_CACHE;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

const SAVED_ACCOUNTS_KEY = 'bushrann_saved_accounts';
const REFRESH_TOKEN_PREFIX = 'bushrann_rt_';
const ACCOUNTS_MIGRATION_FLAG = 'bushrann_accounts_migrated_v1';

const refreshTokenKey = (id) => `${REFRESH_TOKEN_PREFIX}${id}`;

let migrationPromise = null;

// One-time migration: move refresh_token out of AsyncStorage and into SecureStore,
// one key per account (avoids SecureStore's ~2KB per-value limit as the saved-account
// list grows — a single combined-list key would eventually break).
// Never deletes the old AsyncStorage data until every token is verified written.
async function ensureAccountsMigrated() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      try {
        const alreadyMigrated = await SecureStore.getItemAsync(ACCOUNTS_MIGRATION_FLAG);
        if (alreadyMigrated === 'true') return;

        const raw = await AsyncStorage.getItem(SAVED_ACCOUNTS_KEY);
        if (!raw) {
          await SecureStore.setItemAsync(ACCOUNTS_MIGRATION_FLAG, 'true');
          return;
        }

        const oldList = JSON.parse(raw);
        const strippedList = [];

        for (const acc of oldList) {
          const { refresh_token, ...meta } = acc;
          if (refresh_token && acc.id) {
            await SecureStore.setItemAsync(refreshTokenKey(acc.id), refresh_token);
            const check = await SecureStore.getItemAsync(refreshTokenKey(acc.id));
            if (check !== refresh_token) {
              throw new Error(`SecureStore verification failed for account ${acc.id}`);
            }
          } else if (refresh_token && !acc.id) {
            __DEV__ && console.log('[userCache] Skipping refresh_token migration for account with no id — token dropped safely');
          }
          strippedList.push(meta);
        }

        // Only strip tokens from AsyncStorage after every token is verified in SecureStore.
        await AsyncStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(strippedList));
        await SecureStore.setItemAsync(ACCOUNTS_MIGRATION_FLAG, 'true');
        __DEV__ && console.log('[userCache] savedAccounts migration to SecureStore complete');
      } catch (e) {
        // Do NOT set the flag, do NOT touch the AsyncStorage copy — safe to retry next call.
        __DEV__ && console.log('[userCache] savedAccounts migration failed, will retry next time:', e);
      } finally {
        migrationPromise = null; // allow a future retry attempt
      }
    })();
  }
  return migrationPromise;
}

export const userCache = {
  set: async (user) => {
    try {
      const data = { user, timestamp: Date.now() };
      await AsyncStorage.setItem(USER_CACHE_KEY, JSON.stringify(data));
    } catch (e) {
      __DEV__ && console.log('Cache save error:', e);
    }
  },

  get: async () => {
    try {
      const raw = await AsyncStorage.getItem(USER_CACHE_KEY);
      if (!raw) return null;
      const { user, timestamp } = JSON.parse(raw);
      if (Date.now() - timestamp > CACHE_TTL) return null;
      return user;
    } catch (e) {
      return null;
    }
  },

  clear: async () => {
    try {
      await AsyncStorage.removeItem(USER_CACHE_KEY);
    } catch (e) {
      __DEV__ && console.log('Cache clear error:', e);
    }
  },

  savedAccounts: {
    getAll: async () => {
      try {
        await ensureAccountsMigrated();
        const raw = await AsyncStorage.getItem(SAVED_ACCOUNTS_KEY);
        const list = raw ? JSON.parse(raw) : [];

        // Reattach refresh_token from SecureStore. Falls back to an inline
        // token if present (pre-migration shape) so switching still works
        // even if migration hasn't completed yet this session.
        const withTokens = await Promise.all(
          list.map(async (acc) => {
            if (acc.refresh_token) return acc;
            if (!acc.id) return { ...acc, refresh_token: null };
            try {
              const token = await SecureStore.getItemAsync(refreshTokenKey(acc.id));
              return { ...acc, refresh_token: token || null };
            } catch {
              return { ...acc, refresh_token: null };
            }
          })
        );
        return withTokens;
      } catch {
        return [];
      }
    },

    add: async (account) => {
      try {
        await ensureAccountsMigrated();
        const { refresh_token, ...meta } = account;

        const raw = await AsyncStorage.getItem(SAVED_ACCOUNTS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        const filtered = list.filter((a) => a.id !== meta.id);
        filtered.unshift(meta); // metadata only — refresh_token never touches AsyncStorage
        await AsyncStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(filtered));

        if (refresh_token && meta.id) {
          await SecureStore.setItemAsync(refreshTokenKey(meta.id), refresh_token);
        }
      } catch (e) {
        __DEV__ && console.log('savedAccounts.add error:', e);
      }
    },

    remove: async (id) => {
      try {
        const raw = await AsyncStorage.getItem(SAVED_ACCOUNTS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        await AsyncStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(list.filter((a) => a.id !== id)));
        if (id) {
          await SecureStore.deleteItemAsync(refreshTokenKey(id));
        }
      } catch (e) {
        __DEV__ && console.log('savedAccounts.remove error:', e);
      }
    },

    clear: async () => {
      try {
        const raw = await AsyncStorage.getItem(SAVED_ACCOUNTS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        for (const acc of list) {
          if (acc.id) {
            await SecureStore.deleteItemAsync(refreshTokenKey(acc.id));
          }
        }
        await AsyncStorage.removeItem(SAVED_ACCOUNTS_KEY);
      } catch (e) {
        __DEV__ && console.log('savedAccounts.clear error:', e);
      }
    },
  },

  update: async (updates) => {
    try {
      const current = await userCache.get();
      if (current) await userCache.set({ ...current, ...updates });
    } catch (e) {
      __DEV__ && console.log('Cache update error:', e);
    }
  },
};