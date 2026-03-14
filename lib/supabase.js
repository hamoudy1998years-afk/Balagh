import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const RATE_LIMIT_KEY = 'api_call_times';
const MAX_CALLS = 100;
const WINDOW_MS = 60 * 1000; // 1 minute

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing Supabase environment variables');
}

// Retry wrapper for Supabase queries
async function retryQuery(operation, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await operation();
      return result;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
}

async function checkRateLimit() {
  const now = Date.now();
  const stored = await AsyncStorage.getItem(RATE_LIMIT_KEY);
  let calls = stored ? JSON.parse(stored) : [];
  
  // Remove old calls outside window
  calls = calls.filter(time => now - time < WINDOW_MS);
  
  if (calls.length >= MAX_CALLS) {
    throw new Error('Rate limit exceeded. Please try again later.');
  }
  
  calls.push(now);
  await AsyncStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(calls));
  return true;
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  global: {
    fetch: async (...args) => {
      return retryQuery(() => fetch(...args), 3, 1000);
    },
  },
});

// Rate-limited wrapper
export const safeSupabase = {
  from: (table) => {
    checkRateLimit();
    return supabase.from(table);
  },
  auth: supabase.auth,
  channel: supabase.channel,
  removeChannel: supabase.removeChannel,
};

export { retryQuery };