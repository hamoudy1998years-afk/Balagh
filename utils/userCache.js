import AsyncStorage from '@react-native-async-storage/async-storage';

const USER_CACHE_KEY = 'bushrann_cached_user';
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

  update: async (updates) => {
    try {
      const current = await userCache.get();
      if (current) await userCache.set({ ...current, ...updates });
    } catch (e) {
      __DEV__ && console.log('Cache update error:', e);
    }
  },
};