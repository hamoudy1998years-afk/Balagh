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
    const cached = await userCache.get();
    if (cached) {
      setUser(cached);
      setLoading(false);
    }

    const { data: { user: freshUser } } = await supabase.auth.getUser();
    if (freshUser) {
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