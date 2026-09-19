import { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';

export const useViewerCount = (streamId) => {
  const [viewerCount, setViewerCount] = useState(0);
  const refreshInterval = useRef(null);

  useEffect(() => {
    if (!streamId) return;

    let isActive = true;

    const getViewerCount = async () => {
      // 90s freshness window (3x the 30s viewer heartbeat): recalculated on
      // every query so stale/zombie rows (crashes, kills, network loss)
      // drop out of the count instead of lingering forever.
      const freshCutoff = new Date(Date.now() - 90_000).toISOString();
      const { count } = await supabase
        .from('stream_viewers')
        .select('*', { count: 'exact', head: true })
        .eq('stream_id', streamId)
        .gt('last_seen_at', freshCutoff);

      if (!isActive) return;

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

    refreshInterval.current = setInterval(getViewerCount, 5000);

    return () => {
      isActive = false;
      supabase.removeChannel(subscription);
      clearInterval(refreshInterval.current);
    };
  }, [streamId]);

  return { viewerCount };
};