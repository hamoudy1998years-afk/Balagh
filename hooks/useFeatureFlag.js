import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export const useFeatureFlag = (flagName) => {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!flagName) {
      setLoading(false);
      return;
    }

    const fetchFlag = async () => {
      const { data, error } = await supabase
        .from('feature_flags')
        .select('enabled')
        .eq('name', flagName)
        .single();

      if (error) {
        __DEV__ && console.error('Feature flag error:', error);
        setEnabled(false);
      } else {
        setEnabled(data?.enabled ?? false);
      }
      
      setLoading(false);
    };

    fetchFlag();

    // Subscribe to real-time changes (optional but cool!)
    const subscription = supabase
      .channel(`feature-flag:${flagName}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'feature_flags',
          filter: `name=eq.${flagName}`,
        },
        (payload) => {
          setEnabled(payload.new.enabled);
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [flagName]);

  return { enabled, loading };
};