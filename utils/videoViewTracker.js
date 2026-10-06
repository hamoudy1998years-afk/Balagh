import { supabase } from '../lib/supabase';

// Kept for the lifetime of this JS session.
// Identity is part of the key so account switching does not reset counts.
const countedViews = new Set();
const pendingViews = new Set();

function getViewKey(videoId, userId) {
  return `${userId ?? 'guest'}:${videoId}`;
}

export function hasCountedVideoView(videoId, userId) {
  if (!videoId) return true;

  const key = getViewKey(videoId, userId);
  return countedViews.has(key) || pendingViews.has(key);
}

export async function recordVideoView(videoId, userId) {
  if (!videoId) return false;

  const key = getViewKey(videoId, userId);

  if (countedViews.has(key) || pendingViews.has(key)) {
    return false;
  }

  pendingViews.add(key);

  try {
    const { error } = await supabase.rpc('increment_views', {
      p_video_id: videoId,
    });

    if (error) throw error;

    countedViews.add(key);
    return true;
  } catch (error) {
    __DEV__ && console.log('View count error:', error);
    return false;
  } finally {
    pendingViews.delete(key);
  }
}