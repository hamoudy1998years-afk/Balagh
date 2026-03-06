import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export const useRecentViewers = (streamId, limit = 20) => {
  const [recentViewers, setRecentViewers] = useState([]);

  useEffect(() => {
    if (!streamId) return;

    // Fetch recent viewers with profile info
    const fetchRecentViewers = async () => {
      const { data, error } = await supabase
        .from('stream_viewers')
        .select(`
          user_id,
          joined_at,
          profiles:profiles!left(username, avatar_url)
        `)
        .eq('stream_id', streamId)
        .order('joined_at', { ascending: false })
        .limit(limit);

      if (error) {
        console.error('Error fetching recent viewers:', error);
        return;
      }

      // Format the data
      const formatted = data.map(viewer => ({
        userId: viewer.user_id,
        username: viewer.profiles?.username || 'Anonymous',
        avatarUrl: viewer.profiles?.avatar_url,
        joinedAt: viewer.joined_at,
      }));

      setRecentViewers(formatted);
    };

    fetchRecentViewers();

    // Subscribe to new viewers joining
    const subscription = supabase
      .channel(`recent-viewers:${streamId}`)
      .on('postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'stream_viewers',
          filter: `stream_id=eq.${streamId}`
        },
        async (payload) => {
          // Fetch the new viewer's profile
          const { data: profile } = await supabase
            .from('profiles')
            .select('username, avatar_url')
            .eq('id', payload.new.user_id)
            .single();

          const newViewer = {
            userId: payload.new.user_id,
            username: profile?.username || 'Anonymous',
            avatarUrl: profile?.avatar_url,
            joinedAt: payload.new.joined_at,
          };

          setRecentViewers(prev => {
            // Add to top, remove duplicates, keep limit
            const filtered = prev.filter(v => v.userId !== newViewer.userId);
            return [newViewer, ...filtered].slice(0, limit);
          });
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [streamId, limit]);

  return { recentViewers };
};