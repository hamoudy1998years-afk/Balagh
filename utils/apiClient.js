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
  const { signal: callerSignal, ...restOptions } = options;
  const controller = new AbortController();
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Merge the caller's signal (if any) into our internal controller,
  // without letting it be silently overwritten.
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort);
    }
  }

  try {
    const response = await fetch(url, {
      ...restOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      // Only rewrite the error as a timeout if our timeout actually fired.
      // A caller-initiated abort should surface as a normal AbortError.
      if (timedOut) {
        throw new Error(ERROR_MESSAGES.TIMEOUT_ERROR);
      }
      throw error;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (callerSignal) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}

// Token server API
export async function fetchStreamToken(channelName, role = 'publisher') {
  try {
    const url = `${API_BASE_URLS.TOKEN_SERVER}${ENDPOINTS.TOKEN}?channelName=${encodeURIComponent(channelName)}&role=${encodeURIComponent(role)}`;
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

// Delete a normal uploaded video via the token server
// (DELETE /api/videos/:videoId). The server removes the storage objects
// and the videos row (child rows cascade). Requires an active session.
export async function deleteVideoOnServer(videoId) {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      return { success: false, error: 'Session expired. Please log in again.' };
    }

    const response = await fetchWithTimeout(
      `${API_BASE_URLS.TOKEN_SERVER}/api/videos/${videoId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      },
      30000
    );

    if (!response.ok) {
      let message = ERROR_MESSAGES.SOMETHING_WENT_WRONG;
      try {
        const data = await response.json();
        if (data?.error) message = data.error;
      } catch (parseError) {
        // Keep the generic message.
      }
      return { success: false, error: message };
    }

    return { success: true, error: null };
  } catch (error) {
    if (__DEV__) {
      console.error('Delete video error:', error);
    }
    return { success: false, error: error.message || ERROR_MESSAGES.SOMETHING_WENT_WRONG };
  }
}

// Trigger background preparation of a video's v8 watermarked share copy.
// Admin-only server endpoint. This request returns as soon as Railway
// accepts the background warm job; it does not wait for FFmpeg to finish.
export async function warmWatermarkOnServer(videoId) {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      return {
        success: false,
        error: 'Session expired. Please log in again.',
      };
    }

    const response = await fetchWithTimeout(
      `${API_BASE_URLS.TOKEN_SERVER}/api/videos/${videoId}/warm-watermark`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      },
      30000
    );

    if (!response.ok) {
      let message = 'Failed to start watermark preparation.';

      try {
        const data = await response.json();
        if (data?.error) message = data.error;
      } catch (parseError) {
        // Keep the generic message.
      }

      return {
        success: false,
        error: message,
      };
    }

    return {
      success: true,
      error: null,
    };
  } catch (error) {
    if (__DEV__) {
      console.error('Watermark pre-warm error:', error);
    }

    return {
      success: false,
      error:
        error.message ||
        ERROR_MESSAGES.SOMETHING_WENT_WRONG,
    };
  }
}

// Request a watermarked version of a public video for external sharing
// (POST /api/videos/:videoId/watermark). Guest-accessible: no session is
// required, but an active session token is attached when available.
// Uses a dedicated long timeout because server-side FFmpeg work can take
// much longer than the default 30-second fetch timeout.
export async function requestWatermarkedVideo(videoId) {
  const WATERMARK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

  try {
    let headers = {};

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`;
      }
    } catch (sessionError) {
      // Guests share without a session; continue unauthenticated.
    }

    const response = await fetchWithTimeout(
      `${API_BASE_URLS.TOKEN_SERVER}/api/videos/${videoId}/watermark`,
      {
        method: 'POST',
        headers,
      },
      WATERMARK_TIMEOUT_MS
    );

    if (!response.ok) {
      let message = 'Failed to prepare video for sharing.';
      try {
        const data = await response.json();
        if (data?.error) message = data.error;
      } catch (parseError) {
        // Keep the generic message.
      }
      return { success: false, watermarkedUrl: null, error: message };
    }

    const data = await response.json();

    if (!data?.success || !data?.watermarkedUrl) {
      return {
        success: false,
        watermarkedUrl: null,
        error: 'Failed to prepare video for sharing.',
      };
    }

    return { success: true, watermarkedUrl: data.watermarkedUrl, error: null };
  } catch (error) {
    if (__DEV__) {
      console.error('Watermark request error:', error);
    }
    return {
      success: false,
      watermarkedUrl: null,
      error: error.message || ERROR_MESSAGES.SOMETHING_WENT_WRONG,
    };
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