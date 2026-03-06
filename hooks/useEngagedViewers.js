import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export const useEngagedViewers = (streamId) => {
  const [engagedViewers, setEngagedViewers] = useState([]);

  useEffect(() => {
    if (!streamId) return;

    // Fetch viewers who asked questions or sent reactions
    const fetchEngagedViewers = async () => {
      // Get question askers
      const { data: questionAskers } = await supabase
        .from('live_questions')
        .select('user_id, profiles:profiles!inner(username, avatar_url)')
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false });

      // Get reaction senders
      const { data: reactionSenders } = await supabase
        .from('live_reactions')
        .select('user_id, reaction, profiles:profiles!inner(username, avatar_url)')
        .eq('stream_id', streamId)
        .order('created_at', { ascending: false })
        .limit(50);

      // Combine and deduplicate
      const engaged = new Map();

      questionAskers?.forEach(q => {
        engaged.set(q.user_id, {
          userId: q.user_id,
          username: q.profiles?.username || 'Anonymous',
          avatarUrl: q.profiles?.avatar_url,
          type: 'question',
          badge: '❓',
        });
      });

      reactionSenders?.forEach(r => {
        if (!engaged.has(r.user_id)) {
          engaged.set(r.user_id, {
            userId: r.user_id,
            username: r.profiles?.username || 'Anonymous',
            avatarUrl: r.profiles?.avatar_url,
            type: 'reaction',
            badge: r.reaction,
          });
        }
      });

      setEngagedViewers(Array.from(engaged.values()));
    };

    fetchEngagedViewers();

    // Subscribe to new questions
    const questionSubscription = supabase
      .channel(`engaged-questions:${streamId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'live_questions', filter: `stream_id=eq.${streamId}` },
        async (payload) => {
          const { data: profile } = await supabase
            .from('profiles')
            .select('username, avatar_url')
            .eq('id', payload.new.user_id)
            .single();

          setEngagedViewers(prev => {
            const filtered = prev.filter(v => v.userId !== payload.new.user_id);
            return [{
              userId: payload.new.user_id,
              username: profile?.username || 'Anonymous',
              avatarUrl: profile?.avatar_url,
              type: 'question',
              badge: '❓',
            }, ...filtered];
          });
        }
      )
      .subscribe();

    // Subscribe to new reactions
    const reactionSubscription = supabase
      .channel(`engaged-reactions:${streamId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'live_reactions', filter: `stream_id=eq.${streamId}` },
        async (payload) => {
          const { data: profile } = await supabase
            .from('profiles')
            .select('username, avatar_url')
            .eq('id', payload.new.user_id)
            .single();

          setEngagedViewers(prev => {
            const filtered = prev.filter(v => v.userId !== payload.new.user_id);
            return [{
              userId: payload.new.user_id,
              username: profile?.username || 'Anonymous',
              avatarUrl: profile?.avatar_url,
              type: 'reaction',
              badge: payload.new.reaction,
            }, ...filtered];
          });
        }
      )
      .subscribe();

    return () => {
      questionSubscription.unsubscribe();
      reactionSubscription.unsubscribe();
    };
  }, [streamId]);

  return { engagedViewers };
};