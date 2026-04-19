import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { userCache } from '../utils/userCache';
import { supabase } from '../lib/supabase';

const UserContext = createContext();

export function UserProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
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
