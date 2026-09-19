import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

export const useViewerTracking = (streamId, isStreamer = false, user, retryCount = 0, enabled = true) => {
  const heartbeatInterval = useRef(null);
  const activeTokens = useRef({});
  const userId = user?.id;

  useEffect(() => {
    console.log('🔍 useViewerTracking called:', { streamId, isStreamer, hasUser: !!userId, userId, enabled });

    if (!streamId || !userId || isStreamer || !enabled) {
      console.log('⚠️ Early return - missing:', { streamId: !!streamId, userId: !!userId, isStreamer, enabled });
      return;
    }

    const key = `${streamId}:${userId}`;
    activeTokens.current[key] = (activeTokens.current[key] || 0) + 1;
    const myToken = activeTokens.current[key];
    let stopped = false;

    console.log('✅ Starting viewer tracking for user:', userId);

    const stopTracking = () => {
      if (stopped) return;
      stopped = true;
      if (heartbeatInterval.current) {
        clearInterval(heartbeatInterval.current);
        heartbeatInterval.current = null;
      }
    };

    // 23503 (FK violation on stream_id) means the parent live_streams row
    // no longer exists. That is the authoritative, race-proof stream-ended
    // signal — never keep writing against a dead stream.
    const handleWriteError = (error, context) => {
      if (error?.code === '23503') {
        console.log(`[VIEWER TRACKING] Stream ${streamId} no longer exists (${context}); stopping tracking`);
        stopTracking();
        return true;
      }
      return false;
    };

    const joinStream = async () => {
      console.log('📝 Attempting to join stream_viewers table...');
      try {
        const { data, error } = await supabase
          .from('stream_viewers')
          .upsert({
            stream_id: streamId,
            user_id: userId,
            joined_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString()
          }, {
            onConflict: 'stream_id,user_id'
          });

        if (stopped) return;

        if (error) {
          if (handleWriteError(error, 'join')) return;
          console.error('❌ Error joining stream:', error);
        } else {
          console.log('✅ Successfully joined stream_viewers:', data);
        }
      } catch (e) {
        console.error('❌ Exception in joinStream:', e);
      }
    };

    const heartbeat = async () => {
      console.log('💓 Heartbeat...');
      try {
        // Upsert (not UPDATE): if the (stream_id, user_id) row disappeared
        // while the viewer was connected (another device leaving, a delete
        // race), an UPDATE would silently match zero rows forever. The
        // upsert recreates the row via the existing UNIQUE(stream_id,user_id)
        // and always refreshes last_seen_at.
        const { error } = await supabase
          .from('stream_viewers')
          .upsert({
            stream_id: streamId,
            user_id: userId,
            last_seen_at: new Date().toISOString()
          }, {
            onConflict: 'stream_id,user_id'
          });

        if (stopped) return;

        if (error) {
          if (handleWriteError(error, 'heartbeat')) return;
          console.error('❌ Error in heartbeat:', error);
        }
      } catch (e) {
        console.error('❌ Exception in heartbeat:', e);
      }
    };

    const leaveStream = async () => {
      console.log('👋 Leaving stream...');
      try {
        await supabase
          .from('stream_viewers')
          .delete()
          .eq('stream_id', streamId)
          .eq('user_id', userId);
      } catch (e) {
        console.error('❌ Exception in leaveStream:', e);
      }
    };

    const joinPromise = joinStream();

    // If the join already discovered the stream is gone (23503), never start
    // the heartbeat.
    if (!stopped) {
      heartbeatInterval.current = setInterval(heartbeat, 30000);
    }

    return () => {
      console.log('🧹 Cleanup called');
      stopTracking();
      joinPromise.then(() => {
        if (stopped) return;
        // Only leave if no newer instance has re-claimed this same stream+user key
        if (activeTokens.current[key] === myToken) {
          leaveStream();
        }
      });
    };
  }, [streamId, userId, isStreamer, retryCount, enabled]);
};
