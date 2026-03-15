import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// 🔧 FIXED: Removed trailing space
const SUPABASE_URL = 'https://waurtjtnyinncbdhfydu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhdXJ0anRueWlubmNiZGhmeWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0ODIyMzMsImV4cCI6MjA4NzA1ODIzM30.ylb3TuRwCQi3uH-OcbJrjRsIJ7fwhTtzth07rPvRaBM';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});