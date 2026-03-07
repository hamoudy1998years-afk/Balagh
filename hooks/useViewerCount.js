import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export const useViewerCount = (streamId) => {
  const [viewerCount, setViewerCount] = useState(0);

  useEffect(() => {
    if (!streamId) return;

    const getViewerCount = async () => {
      try {
        const { count, error } = await supabase
          .from('stream_viewers')
          .select('*', { count: 'exact', head: true })
          .eq('stream_id', streamId);

        if (error) {
          console.error('Viewer count error:', error);
          return;
        }

        setViewerCount(count || 0);
      } catch (e) {
        console.error('Viewer count exception:', e);
      }
    };

    // Initial fetch
    getViewerCount();

    // Real-time subscription only (no polling)
    const subscription = supabase
      .channel(`stream:${streamId}:viewers`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'stream_viewers', filter: `stream_id=eq.${streamId}` },
        () => getViewerCount()
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [streamId]);

  return { viewerCount };
};