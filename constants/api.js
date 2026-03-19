// API Configuration
export const API_BASE_URLS = {
  SUPABASE: process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://waurtjtnyinncbdhfydu.supabase.co',
  TOKEN_SERVER: process.env.EXPO_PUBLIC_SERVER_URL,
};

// Supabase Edge Functions
export const EDGE_FUNCTIONS = {
  DELETE_USER: `${API_BASE_URLS.SUPABASE}/functions/v1/delete-user`,
};

// API Endpoints (relative to base URL)
export const ENDPOINTS = {
  TOKEN: '/token',
};

// Supabase table names
export const TABLES = {
  PROFILES: 'profiles',
  VIDEOS: 'videos',
  LIKES: 'likes',
  FOLLOWS: 'follows',
  BLOCKS: 'blocks',
  COMMENTS: 'comments',
  NOTIFICATIONS: 'notifications',
  LIVE_STREAMS: 'live_streams',
  LIVE_MESSAGES: 'live_messages',
  LIVE_QUESTIONS: 'live_questions',
  LIVE_REACTIONS: 'live_reactions',
  SCHOLAR_APPLICATIONS: 'scholar_applications',
  REPORTS: 'reports',
  STREAM_VIEWERS: 'stream_viewers',
};

// Supabase storage buckets
export const STORAGE_BUCKETS = {
  AVATARS: 'avatars',
  VIDEOS: 'videos',
};

// Realtime channels
export function getStreamChannel(streamId) {
  return `stream_${streamId}`;
}

export function getChatChannel(streamId) {
  return `chat_${streamId}`;
}

export function getQuestionsChannel(streamId) {
  return `questions_${streamId}`;
}

export function getViewerChannel(userId) {
  return `bushrann_${userId}_${Date.now()}`;
}
