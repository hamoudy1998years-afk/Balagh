import { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';

export const useViewerCount = (streamId) => {
  const [viewerCount, setViewerCount] = useState(0);
  const refreshInterval = useRef(null);

  useEffect(() => {
    if (!streamId) return;

    const getViewerCount = async () => {
      const { count, error } = await supabase
        .from('stream_viewers')
        .select('*', { count: 'exact', head: true })
        .eq('stream_id', streamId);
      
      setViewerCount(count || 0);
    };

    getViewerCount();

    const subscription = supabase
      .channel(`stream:${streamId}:viewers`)
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'stream_viewers', filter: `stream_id=eq.${streamId}` },
        () => getViewerCount()
      )
      .subscribe();

    // Refresh every 5 seconds as backup
    refreshInterval.current = setInterval(() => {
      getViewerCount();
    }, 5000);

    return () => {
      subscription.unsubscribe();
      clearInterval(refreshInterval.current);
    };
  }, [streamId]);

  return { viewerCount };
};