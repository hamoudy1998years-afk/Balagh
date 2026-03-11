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
    // Show cached data instantly while fetching fresh data
    const cached = await userCache.get();
    if (cached) {
      setUser(cached);
      setLoading(false);
    }

    // Fetch fresh auth user in background
    const { data: { user: freshUser } } = await supabase.auth.getUser();
    if (freshUser) {
      // cached profile data (username, avatar etc) wins over raw auth data
      const mergedUser = { ...freshUser, ...cached };
      setUser(mergedUser);
      await userCache.set(mergedUser);
    }

    setLoading(false);
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