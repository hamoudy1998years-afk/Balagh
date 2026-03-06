import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

export const useViewerTracking = (streamId, isStreamer = false, user, retryCount = 0) => {
  const heartbeatInterval = useRef(null);

  useEffect(() => {
    console.log('🔍 useViewerTracking called:', { streamId, isStreamer, hasUser: !!user, userId: user?.id });
    
    if (!streamId || !user || isStreamer) {
      console.log('⚠️ Early return - missing:', { streamId: !!streamId, user: !!user, isStreamer });
      return;
    }

    const userId = user.id;
    console.log('✅ Starting viewer tracking for user:', userId);

    // Join stream
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
        
        if (error) {
          console.error('❌ Error joining stream:', error);
        } else {
          console.log('✅ Successfully joined stream_viewers:', data);
        }
      } catch (e) {
        console.error('❌ Exception in joinStream:', e);
      }
    };

    // Heartbeat to show we're still watching
    const heartbeat = async () => {
      console.log('💓 Heartbeat...');
      await supabase
        .from('stream_viewers')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('stream_id', streamId)
        .eq('user_id', userId);
    };

    // Leave stream
    const leaveStream = async () => {
      console.log('👋 Leaving stream...');
      await supabase
        .from('stream_viewers')
        .delete()
        .eq('stream_id', streamId)
        .eq('user_id', userId);
    };

    // Join immediately
    joinStream();

    // Heartbeat every 30 seconds
    heartbeatInterval.current = setInterval(heartbeat, 30000);

    // Cleanup on unmount
    return () => {
      console.log('🧹 Cleanup called');
      clearInterval(heartbeatInterval.current);
      leaveStream();
    };
  }, [streamId, user, isStreamer]);
};