import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import { userCache } from '../utils/userCache';
import { supabase } from '../lib/supabase';

const UserContext = createContext();

export function UserProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [availableAccounts, setAvailableAccounts] = useState([]);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  // UI-facing only: preserves the switch failure message for screens that are no
  // longer mounted/focused when a post-biometric failure occurs. Never touches
  // auth/session state.
  const [switchError, setSwitchError] = useState(null);
  const [following, setFollowing] = useState(new Set());
  const [blockedUsers, setBlockedUsers] = useState(new Set());

  // Auth-state version counter. Bumped every time onAuthStateChange fires
  // (including SIGNED_OUT). loadUser() captures the version it started with
  // and checks it's still current before each setUser/cache write — so a
  // slow, older loadUser() run can never clobber a newer auth-state result,
  // and SIGNED_OUT always wins over anything still in flight from before it.
  const authVersion = useRef(0);

  // Serializes every persistent userCache.set()/clear() call so they execute
  // in the order they were *requested*, not the order the underlying storage
  // I/O happens to finish in. Without this, an older in-flight set() can
  // physically complete after a newer clear() and silently repopulate the
  // cache with stale (e.g. logged-out) data — the authVersion check alone
  // only protects React state, not the disk write itself.
  const cacheWriteQueue = useRef(Promise.resolve());

  // Re-checks authVersion at the moment this write actually runs (not when
  // it was requested) — if a newer auth event has superseded it by then,
  // the write is skipped instead of executing after that event's own write.
  function queueCacheSet(expectedVersion, userToCache) {
    cacheWriteQueue.current = cacheWriteQueue.current.then(async () => {
      if (expectedVersion !== authVersion.current) return; // superseded — skip
      await userCache.set(userToCache);
    });
    return cacheWriteQueue.current;
  }

  // Serializes saved-account writes and prevents a stale auth operation
  // from modifying saved accounts after a newer auth event wins.
  const savedAccountWriteQueue = useRef(Promise.resolve());

  function queueSavedAccountAdd(expectedVersion, account) {
    savedAccountWriteQueue.current = savedAccountWriteQueue.current.then(async () => {
      if (expectedVersion !== authVersion.current) return false;

      await userCache.savedAccounts.add(account);

      if (expectedVersion !== authVersion.current) return false;

      return true;
    });

    return savedAccountWriteQueue.current;
  }

  // Clears unconditionally — a clear is always allowed to run when it's
  // this operation's turn in the queue. It doesn't need a version check
  // because the queue's FIFO ordering already guarantees any set() that was
  // requested before it has been resolved (and skipped, if by then stale)
  // ahead of it.
  function queueCacheClear() {
    cacheWriteQueue.current = cacheWriteQueue.current.then(async () => {
      await userCache.clear();
    });
    return cacheWriteQueue.current;
  }

  useEffect(() => {
    loadUser();
  }, []);

  // Keep user state synchronized with Supabase's own auth state, in addition
  // to the one-time loadUser() check above. Single subscription per provider
  // mount (empty deps), properly unsubscribed on cleanup — not a duplicate
  // listener and not re-created on re-render.
  useEffect(() => {
        const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      const versionBeforeIncrement = authVersion.current;
      __DEV__ && console.log('[UserContext] onAuthStateChange event:', event, 'authVersion before:', versionBeforeIncrement);

      // Bump immediately, before any async work — this is what makes this
      // event authoritative over any loadUser() run already in flight,
      // regardless of which finishes its own async work first.
      authVersion.current += 1;
      const myVersion = authVersion.current;
      __DEV__ && console.log('[UserContext] onAuthStateChange authVersion after:', myVersion);

      if (event === 'SIGNED_OUT') {
        setUser(null);
        __DEV__ && console.log('[UserContext] SET_USER_NULL (SIGNED_OUT)');
        await queueCacheClear();
        setLoading(false);
        return;
      }

      if (event === 'INITIAL_SESSION' && !session) {
        // No session on cold start (logged out / never logged in). loadUser()'s
        // own getUser() call may still be in flight and could get superseded by
        // this same event bump — so this is the only place left that will ever
        // clear loading in that case.
        setLoading(false);
        return;
      }

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') {
        const sessionUser = session?.user;
        if (!sessionUser) {
          __DEV__ && console.log('[UserContext] onAuthStateChange: no sessionUser, early return');
          setLoading(false);
          return;
        }

        try {
          // Apply session-only user state immediately. The profiles query and
          // cache write are deliberately DETACHED from this callback: awaiting
          // them here blocks supabase's own auth promise (setSession/signIn
          // wait on listeners), which froze sign-in indefinitely whenever the
          // query hung. The detached task keeps every authVersion stale-write
          // guard and handles its own errors, so it can never surface as an
          // unhandled rejection.
          setUser(sessionUser);
          __DEV__ && console.log('[UserContext] SET_USER_PRESENT (session-only, onAuthStateChange)');

          Promise.resolve()
            .then(async () => {
              try {
                const { data: profile } = await supabase
                  .from('profiles')
                  .select('*')
                  .eq('id', sessionUser.id)
                  .single();
                __DEV__ && console.log('[UserContext] background profile refresh done. data present:', !!profile);

                // A newer auth event superseded this one while the profile
                // fetch was in flight — don't apply a now-stale result.
                if (myVersion !== authVersion.current) {
                  __DEV__ && console.log('[UserContext] background profile refresh SKIPPED (stale version). myVersion:', myVersion, 'current authVersion:', authVersion.current);
                  return;
                }

                const mergedUser = { ...sessionUser, ...profile };
                setUser(mergedUser);
                __DEV__ && console.log('[UserContext] SET_USER_PRESENT (profile-merged, onAuthStateChange)');
                await queueCacheSet(myVersion, mergedUser);
              } catch (profileErr) {
                // Keep session-only user state; never propagate.
                __DEV__ && console.log('[UserContext] background profile refresh error:', profileErr?.message ?? profileErr);
              }
            })
            .catch((profileErr) => {
              __DEV__ && console.log('[UserContext] background profile refresh error:', profileErr?.message ?? profileErr);
            });
        } catch (e) {
          __DEV__ && console.log('[UserContext] Auth state sync error:', e);
        } finally {
          if (myVersion === authVersion.current) {
            setLoading(false);
          }
        }
      }
      // Other events (PASSWORD_RECOVERY, MFA_CHALLENGE_VERIFIED, etc.) are
      // intentionally not handled here — no user-state implication for this app.
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, []);

    async function loadUser() {
    // Snapshot the version at the start of this run. If onAuthStateChange
    // bumps it before this function's async work finishes, this run is
    // stale and must not write any state — a newer auth event has already
    // decided the truth.
    const versionAtStart = authVersion.current;
    __DEV__ && console.log('[UserContext] loadUser START. versionAtStart:', versionAtStart, 'current authVersion:', authVersion.current);

    // Always try to show cached data first (for offline support)
    const cached = await userCache.get();
    __DEV__ && console.log('[UserContext] loadUser: userCache.get() done. cached present:', !!cached);
    if (versionAtStart !== authVersion.current) {
      __DEV__ && console.log('[UserContext] loadUser SKIPPED after userCache.get() (stale version). versionAtStart:', versionAtStart, 'current authVersion:', authVersion.current);
      return; // superseded already
    }
    if (cached) {
      setUser(cached);
      __DEV__ && console.log('[UserContext] SET_USER_PRESENT (cached, loadUser)');
      setLoading(false);
    }

    try {
      // Try to fetch fresh data from Supabase
      const { data: { user: freshUser }, error } = await supabase.auth.getUser();
      __DEV__ && console.log('[UserContext] loadUser: supabase.auth.getUser() done. freshUser present:', !!freshUser, 'error present:', !!error);

      if (versionAtStart !== authVersion.current) {
        __DEV__ && console.log('[UserContext] loadUser SKIPPED after getUser() (stale version). versionAtStart:', versionAtStart, 'current authVersion:', authVersion.current);
        return; // superseded
      }

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
        __DEV__ && console.log('[UserContext] loadUser: profiles query done. data present:', !!profile);

        if (versionAtStart !== authVersion.current) {
          __DEV__ && console.log('[UserContext] loadUser SKIPPED after profiles query (stale version). versionAtStart:', versionAtStart, 'current authVersion:', authVersion.current);
          return; // superseded
        }

        const mergedUser = { ...cached, ...freshUser, ...profile };
        setUser(mergedUser);
        __DEV__ && console.log('[UserContext] SET_USER_PRESENT (fresh, loadUser)');
        await queueCacheSet(versionAtStart, mergedUser);

        if (versionAtStart !== authVersion.current) {
          __DEV__ && console.log('[UserContext] loadUser SKIPPED after queueCacheSet (stale version). versionAtStart:', versionAtStart, 'current authVersion:', authVersion.current);
          return; // superseded
        }

        // getSession() is itself an async boundary — re-check immediately
        // before using its result, since a newer auth event could have
        // landed during this call too.
        const { data: sessionForSave } = await supabase.auth.getSession();
        __DEV__ && console.log('[UserContext] loadUser: supabase.auth.getSession() done. session present:', !!sessionForSave?.session);

        if (versionAtStart !== authVersion.current) {
          __DEV__ && console.log('[UserContext] loadUser SKIPPED after getSession() (stale version). versionAtStart:', versionAtStart, 'current authVersion:', authVersion.current);
          return; // superseded
        }

        const savedAccountOk = await queueSavedAccountAdd(versionAtStart, {
          id: mergedUser.id,
          email: mergedUser.email,
          username: mergedUser.username ?? mergedUser.user_metadata?.username,
          full_name: mergedUser.full_name ?? mergedUser.user_metadata?.full_name,
          avatar_url: mergedUser.avatar_url,
          refresh_token: sessionForSave?.session?.refresh_token,
        });

        if (!savedAccountOk) {
          __DEV__ && console.log('[UserContext] loadUser SKIPPED after queueSavedAccountAdd (stale version)');
          return; // superseded
        }

        const accounts = await userCache.savedAccounts.getAll();
        setAvailableAccounts(accounts);

        // Load blocked users from database
        const { data: blockedData } = await supabase
          .from('blocks')
          .select('blocked_id')
          .eq('blocker_id', freshUser.id);

        if (versionAtStart !== authVersion.current) {
          __DEV__ && console.log('[UserContext] loadUser SKIPPED after blocks query (stale version). versionAtStart:', versionAtStart, 'current authVersion:', authVersion.current);
          return; // superseded
        }

        if (blockedData) {
          // Filter out own ID (can't block yourself) and nulls
          const blockedIds = blockedData
            .map(b => b.blocked_id)
            .filter(id => id && id !== freshUser.id);
          setBlockedUsers(new Set(blockedIds));
        }
      } else {
        // Supabase successfully confirmed there is no authenticated user
        // (no error, but freshUser is null) — any cached user is stale.
        // This is distinct from a network/error case above, which
        // deliberately keeps the cached user for offline support.
        setUser(null);
        __DEV__ && console.log('[UserContext] SET_USER_NULL (loadUser, no freshUser)');
        await queueCacheClear();
      }
    } catch (e) {
      // Don't clear user - keep cached data when offline
    } finally {
      if (versionAtStart === authVersion.current) {
        __DEV__ && console.log('[UserContext] loadUser setLoading(false)');
        setLoading(false);
      } else {
        __DEV__ && console.log('[UserContext] loadUser setLoading(false) SKIPPED due to version mismatch. versionAtStart:', versionAtStart, 'current authVersion:', authVersion.current);
      }
    }
  }

  const switchToAccount = useCallback(async (account) => {
    if (!account?.refresh_token) return { success: false, error: 'No saved session for this account.' };

    // A new switch begins — clear any stale UI-facing error from a prior switch.
    setSwitchError(null);
    const switchFail = (error, extra = {}) => {
      setSwitchError(error);
      return { success: false, error, ...extra };
    };

    // Enforce the same local-authentication gate LoginScreen requires before using
    // any stored secret (password / appPassword). A refresh_token grants an equally
    // live session, so it must be gated the same way — device biometrics, checked
    // fresh here rather than assumed from a prior login elsewhere in the app.
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = hasHardware ? await LocalAuthentication.isEnrolledAsync() : false;

      if (!hasHardware || !isEnrolled) {
        // No biometric gate available on this device — do not silently allow
        // the switch. Matches LoginScreen's own fallback behavior.
        return switchFail('Please log in with password first.', { reason: 'NO_PASSWORD' });
      }

      const bioResult = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Verify to switch account',
        cancelLabel: 'Cancel',
        disableDeviceFallback: true,
      });

      if (!bioResult.success) {
        return switchFail('Authentication cancelled.');
      }
    } catch (e) {
      return switchFail('Could not verify identity.');
    }

    setSwitchingAccount(true);
    try {
      const { data, error } = await supabase.auth.refreshSession({ refresh_token: account.refresh_token });
      if (error || !data?.session) return switchFail(error?.message ?? 'Session expired. Please log in again.');
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', data.user.id)
        .single();
      const mergedUser = { ...data.user, ...profile };
      authVersion.current += 1;
      const myVersion = authVersion.current;
      setUser(mergedUser);
      await queueCacheSet(myVersion, mergedUser);

      if (myVersion !== authVersion.current) {
        // A newer auth event (e.g. SIGNED_OUT) superseded this switch while
        // the cache write was in flight — don't persist this account's
        // refresh token as if the switch were still the current truth.
        return switchFail('Session changed during switch. Please try again.');
      }

      const savedAccountOk = await queueSavedAccountAdd(myVersion, {
        id: mergedUser.id,
        email: mergedUser.email,
        username: mergedUser.username ?? mergedUser.user_metadata?.username,
        full_name: mergedUser.full_name ?? mergedUser.user_metadata?.full_name,
        avatar_url: mergedUser.avatar_url,
        refresh_token: data.session.refresh_token,
      });

      if (!savedAccountOk) {
        return switchFail('Session changed during switch. Please try again.');
      }

      const accounts = await userCache.savedAccounts.getAll();
      setAvailableAccounts(accounts);

      // Account-scoped state must belong to the newly switched account —
      // never leave the previous account's sets behind. `following` is only
      // ever built incrementally (toggleFollow/FollowListScreen), so reset it;
      // blockedUsers is loaded from the DB for the new account, with the same
      // authVersion stale-write guard so a query started for this switch
      // cannot land after a newer auth event and clobber it.
      setFollowing(new Set());

      const { data: blockedData } = await supabase
        .from('blocks')
        .select('blocked_id')
        .eq('blocker_id', data.user.id);

      if (myVersion !== authVersion.current) {
        return switchFail('Session changed during switch. Please try again.');
      }

      if (blockedData) {
        const blockedIds = blockedData
          .map(b => b.blocked_id)
          .filter(id => id && id !== data.user.id);
        setBlockedUsers(new Set(blockedIds));
      }

      return { success: true };
    } catch (e) {
      return switchFail(e.message);
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
      let error;
      if (isCurrentlyFollowing) {
        ({ error } = await supabase
          .from('follows')
          .delete()
          .eq('follower_id', user.id)
          .eq('following_id', userIdToFollow));
      } else {
        ({ error } = await supabase
          .from('follows')
          .insert({ follower_id: user.id, following_id: userIdToFollow }));
      }
      if (error) throw error;
    } catch (err) {
      // Revert on error — Supabase errors are returned, not thrown, so we check
      // `error` explicitly above rather than relying on try/catch alone.
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

    const wasFollowing = following.has(userIdToBlock);

    // Optimistic: mark as blocked immediately
    setBlockedUsers(prev => new Set([...prev, userIdToBlock]));

    // If following them, unfollow automatically (optimistic + verified)
    if (wasFollowing) {
      setFollowing(prev => {
        const next = new Set(prev);
        next.delete(userIdToBlock);
        return next;
      });
      try {
        const { error } = await supabase
          .from('follows')
          .delete()
          .eq('follower_id', user.id)
          .eq('following_id', userIdToBlock);
        if (error) throw error;
      } catch (err) {
        // Revert the unfollow only — the block attempt below is independent.
        setFollowing(prev => new Set([...prev, userIdToBlock]));
      }
    }

    // Save the block to Supabase
    try {
      const { error } = await supabase
        .from('blocks')
        .insert([{ blocker_id: user.id, blocked_id: userIdToBlock }]);
      if (error) throw error;
    } catch (err) {
      // Revert the optimistic block — DB rejected it, UI must not claim success.
      setBlockedUsers(prev => {
        const next = new Set(prev);
        next.delete(userIdToBlock);
        return next;
      });
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
      const { error } = await supabase
        .from('blocks')
        .delete()
        .eq('blocker_id', user.id)
        .eq('blocked_id', userIdToUnblock);
      if (error) throw error;
    } catch (err) {
      // Revert — the block is still active in the DB, UI must reflect that.
      setBlockedUsers(prev => new Set([...prev, userIdToUnblock]));
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
      switchError,
      clearSwitchError: () => setSwitchError(null),
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