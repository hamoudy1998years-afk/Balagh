import React, { createContext, useContext, useState, useEffect } from 'react';
import { userCache } from '../utils/userCache';
import { supabase } from '../lib/supabase';

const UserContext = createContext();

export function UserProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUser();
  }, []);

  async function loadUser() {
    // Always try to show cached data first (for offline support)
    const cached = await userCache.get();
    if (cached) {
      setUser(cached);
      setLoading(false);
      __DEV__ && console.log('[UserContext] Loaded cached user:', cached.id);
    }

    try {
      // Try to fetch fresh data from Supabase
      const { data: { user: freshUser }, error } = await supabase.auth.getUser();
      
      if (error) {
        __DEV__ && console.log('[UserContext] getUser error (offline?):', error.message);
        // Don't clear user - keep cached data when offline
        return;
      }
      
      if (freshUser) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', freshUser.id)
          .single();
        const mergedUser = { ...cached, ...freshUser, ...profile };
        setUser(mergedUser);
        await userCache.set(mergedUser);
        __DEV__ && console.log('[UserContext] Fresh user data loaded:', mergedUser.id);
      }
    } catch (e) {
      __DEV__ && console.log('[UserContext] Network error (offline?), using cached data:', e.message);
      // Don't clear user - keep cached data when offline
    } finally {
      setLoading(false);
    }
  }

  return (
    <UserContext.Provider value={{ user, setUser, loading, refreshUser: loadUser }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  return useContext(UserContext);
}