import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from '../constants/storage';

const USER_CACHE_KEY = STORAGE_KEYS.USER_CACHE;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

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
        const raw = await AsyncStorage.getItem('bushrann_saved_accounts');
        return raw ? JSON.parse(raw) : [];
      } catch { return []; }
    },
    add: async (account) => {
      try {
        const raw = await AsyncStorage.getItem('bushrann_saved_accounts');
        const list = raw ? JSON.parse(raw) : [];
        const filtered = list.filter(a => a.id !== account.id);
        filtered.unshift(account);
        await AsyncStorage.setItem('bushrann_saved_accounts', JSON.stringify(filtered));
      } catch (e) { __DEV__ && console.log('savedAccounts.add error:', e); }
    },
    remove: async (id) => {
      try {
        const raw = await AsyncStorage.getItem('bushrann_saved_accounts');
        const list = raw ? JSON.parse(raw) : [];
        await AsyncStorage.setItem('bushrann_saved_accounts', JSON.stringify(list.filter(a => a.id !== id)));
      } catch (e) { __DEV__ && console.log('savedAccounts.remove error:', e); }
    },
    clear: async () => {
      try { await AsyncStorage.removeItem('bushrann_saved_accounts'); } catch {}
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