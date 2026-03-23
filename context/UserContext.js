import { createContext, useContext, useState, useEffect } from 'react';
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
    }

    try {
      // Try to fetch fresh data from Supabase
      const { data: { user: freshUser }, error } = await supabase.auth.getUser();
      
      if (error) {
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
      }
    } catch (e) {
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