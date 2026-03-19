import { supabase } from '../lib/supabase';
import { ERROR_MESSAGES } from '../constants/errors';
import { API_BASE_URLS, ENDPOINTS } from '../constants/api';

// Generic error handler for Supabase calls
export function handleSupabaseError(error, defaultMessage = ERROR_MESSAGES.SOMETHING_WENT_WRONG) {
  if (__DEV__) {
    console.error('Supabase error:', error);
  }
  return {
    data: null,
    error: error?.message || defaultMessage,
  };
}

// Fetch with timeout
export async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(ERROR_MESSAGES.TIMEOUT_ERROR);
    }
    throw error;
  }
}

// Token server API
export async function fetchStreamToken(channelName, role = 'publisher') {
  try {
    const url = `${API_BASE_URLS.TOKEN_SERVER}${ENDPOINTS.TOKEN}?channelName=${encodeURIComponent(channelName)}&role=${role}`;
    const response = await fetchWithTimeout(url);
    
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token server ${response.status}: ${text.slice(0, 200)}`);
    }
    
    const data = await response.json();
    return { token: data?.token || null, error: null };
  } catch (error) {
    if (__DEV__) {
      console.error('Token fetch error:', error);
    }
    return { token: null, error: error.message || ERROR_MESSAGES.TOKEN_ERROR };
  }
}

// Supabase query helpers
export async function fetchProfile(userId) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    
    if (error) throw error;
    return { data, error: null };
  } catch (error) {
    return handleSupabaseError(error);
  }
}

export async function fetchVideos(userId, options = {}) {
  const { isPrivate = false, limit = 30, offset = 0 } = options;
  
  try {
    let query = supabase
      .from('videos')
      .select('*')
      .eq('user_id', userId)
      .eq('is_private', isPrivate)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    const { data, error } = await query;
    if (error) throw error;
    return { data: data || [], error: null };
  } catch (error) {
    return handleSupabaseError(error);
  }
}

export async function fetchPublicVideos(limit = 30) {
  try {
    const { data, error } = await supabase
      .from('videos')
      .select('*, profiles(username, avatar_url)')
      .eq('is_private', false)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) throw error;
    return { data: data || [], error: null };
  } catch (error) {
    return handleSupabaseError(error);
  }
}

export async function toggleFollow(followerId, followingId, isFollowing) {
  try {
    if (isFollowing) {
      const { error } = await supabase
        .from('follows')
        .delete()
        .eq('follower_id', followerId)
        .eq('following_id', followingId);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('follows')
        .insert({ follower_id: followerId, following_id: followingId });
      if (error) throw error;
    }
    return { success: true, error: null };
  } catch (error) {
    return { success: false, ...handleSupabaseError(error) };
  }
}

export async function toggleLike(userId, videoId, isLiked) {
  try {
    if (isLiked) {
      const { error } = await supabase
        .from('likes')
        .delete()
        .match({ user_id: userId, video_id: videoId });
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('likes')
        .insert({ user_id: userId, video_id: videoId });
      if (error) throw error;
    }
    return { success: true, error: null };
  } catch (error) {
    return { success: false, ...handleSupabaseError(error) };
  }
}

export async function incrementViews(videoId) {
  try {
    const { error } = await supabase.rpc('increment_views', { video_id: videoId });
    if (error) throw error;
    return { success: true, error: null };
  } catch (error) {
    return { success: false, ...handleSupabaseError(error) };
  }
}

// Upload helpers
export async function uploadToStorage(bucket, path, file, options = {}) {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(path, file, options);
    
    if (error) throw error;
    return { data, error: null };
  } catch (error) {
    return handleSupabaseError(error, ERROR_MESSAGES.UPLOAD_FAILED);
  }
}

export function getPublicUrl(bucket, path) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}

// Realtime subscription helpers
export function createChannel(channelName) {
  return supabase.channel(channelName);
}

export function subscribeToTable(channel, table, callback, event = '*') {
  return channel
    .on('postgres_changes', { event, schema: 'public', table }, callback)
    .subscribe();
}

export async function removeChannel(channel) {
  await supabase.removeChannel(channel);
}
