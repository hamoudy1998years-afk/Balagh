import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { userCache } from '../utils/userCache';
import { supabase } from '../lib/supabase';

const UserContext = createContext();

export function UserProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [availableAccounts, setAvailableAccounts] = useState([]);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [following, setFollowing] = useState(new Set());
  const [blockedUsers, setBlockedUsers] = useState(new Set());

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
        await userCache.savedAccounts.add({
          id: mergedUser.id,
          email: mergedUser.email,
          username: mergedUser.username ?? mergedUser.user_metadata?.username,
          full_name: mergedUser.full_name ?? mergedUser.user_metadata?.full_name,
          avatar_url: mergedUser.avatar_url,
          refresh_token: (await supabase.auth.getSession()).data.session?.refresh_token,
        });
        const accounts = await userCache.savedAccounts.getAll();
        setAvailableAccounts(accounts);
        
        // Load blocked users from database
        const { data: blockedData } = await supabase
          .from('blocks')
          .select('blocked_id')
          .eq('blocker_id', freshUser.id);
        if (blockedData) {
          // Filter out own ID (can't block yourself) and nulls
          const blockedIds = blockedData
            .map(b => b.blocked_id)
            .filter(id => id && id !== freshUser.id);
          setBlockedUsers(new Set(blockedIds));
        }
      }
    } catch (e) {
      // Don't clear user - keep cached data when offline
    } finally {
      setLoading(false);
    }
  }

  const switchToAccount = useCallback(async (account) => {
    if (!account?.refresh_token) return { success: false, error: 'No saved session for this account.' };
    setSwitchingAccount(true);
    try {
      const { data, error } = await supabase.auth.refreshSession({ refresh_token: account.refresh_token });
      if (error || !data?.session) return { success: false, error: error?.message ?? 'Session expired. Please log in again.' };
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', data.user.id)
        .single();
      const mergedUser = { ...data.user, ...profile };
      setUser(mergedUser);
      await userCache.set(mergedUser);
      await userCache.savedAccounts.add({
        id: mergedUser.id,
        email: mergedUser.email,
        username: mergedUser.username ?? mergedUser.user_metadata?.username,
        full_name: mergedUser.full_name ?? mergedUser.user_metadata?.full_name,
        avatar_url: mergedUser.avatar_url,
        refresh_token: data.session.refresh_token,
      });
      const accounts = await userCache.savedAccounts.getAll();
      setAvailableAccounts(accounts);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      setSwitchingAccount(false);
    }
  }, []);

  const isFollowing = useCallback((userId) => {
    return following.has(userId);
  }, [following]);

  const toggleFollow = useCallback(async (userIdToFollow) => {
    if (!user || !user.id) return;
    
    const isCurrentlyFollowing = following.has(userIdToFollow);
    
    // Optimistic update
    setFollowing(prev => {
      const next = new Set(prev);
      if (isCurrentlyFollowing) {
        next.delete(userIdToFollow);
      } else {
        next.add(userIdToFollow);
      }
      return next;
    });
    
    try {
      if (isCurrentlyFollowing) {
        await supabase
          .from('follows')
          .delete()
          .eq('follower_id', user.id)
          .eq('following_id', userIdToFollow);
      } else {
        await supabase
          .from('follows')
          .insert({ follower_id: user.id, following_id: userIdToFollow });
      }
    } catch (err) {
      // Revert on error
      setFollowing(prev => {
        const next = new Set(prev);
        if (isCurrentlyFollowing) {
          next.add(userIdToFollow);
        } else {
          next.delete(userIdToFollow);
        }
        return next;
      });
    }
  }, [user, following]);

  const blockUser = useCallback(async (userIdToBlock) => {
    if (!user || !user.id) return;
    
    console.log('🚫 Blocking user:', userIdToBlock);
    
    // Add to blocked list locally (instant UI update)
    setBlockedUsers(prev => new Set([...prev, userIdToBlock]));
    
    // If following them, unfollow automatically
    if (following.has(userIdToBlock)) {
      console.log('📤 Auto-unfollowing blocked user');
      try {
        await supabase
          .from('follows')
          .delete()
          .eq('follower_id', user.id)
          .eq('following_id', userIdToBlock);
        
        setFollowing(prev => {
          const next = new Set(prev);
          next.delete(userIdToBlock);
          return next;
        });
      } catch (err) {
        console.error('Failed to unfollow blocked user:', err);
      }
    }
    
    // Save to Supabase for persistence
    try {
      await supabase
        .from('blocks')
        .insert([{ blocker_id: user.id, blocked_id: userIdToBlock }]);
    } catch (err) {
      console.error('Failed to save block to DB:', err);
    }
  }, [user, following]);

  const unblockUser = useCallback(async (userIdToUnblock) => {
    if (!user || !user.id) return;
    
    setBlockedUsers(prev => {
      const next = new Set(prev);
      next.delete(userIdToUnblock);
      return next;
    });
    
    try {
      await supabase
        .from('blocks')
        .delete()
        .eq('blocker_id', user.id)
        .eq('blocked_id', userIdToUnblock);
    } catch (err) {
      console.error('Failed to unblock:', err);
    }
  }, [user]);

  return (
    <UserContext.Provider value={{ 
      user, 
      setUser, 
      loading, 
      refreshUser: loadUser,
      availableAccounts,
      switchToAccount,
      switchingAccount,
      following,
      setFollowing,
      isFollowing,
      toggleFollow,
      blockedUsers,
      blockUser,
      unblockUser 
    }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  return useContext(UserContext);
}
