import { supabase } from '../lib/supabase';

// Default fallback words (used if Supabase fetch fails)
const DEFAULT_BANNED_WORDS = [
  'spam', 'scam', 'fake', 'fuck', 'shit', 'bitch', 'asshole'
];

let dynamicBannedWords = [];
let wordsLoaded = false;

// Load banned words from Supabase on app start
export async function loadBannedWords() {
  try {
    const { data, error } = await supabase
      .from('banned_words')
      .select('word, severity')
      .order('severity', { ascending: false });
    
    if (error) throw error;
    
    dynamicBannedWords = data?.map(item => item.word.toLowerCase()) || DEFAULT_BANNED_WORDS;
    wordsLoaded = true;
    console.log('[MODERATION] Loaded', dynamicBannedWords.length, 'banned words');
  } catch (error) {
    console.error('[MODERATION] Failed to load words:', error);
    dynamicBannedWords = DEFAULT_BANNED_WORDS;
    wordsLoaded = true;
  }
}

const BANNED_PATTERNS = [
  /https?:\/\/\S+/gi,
  /www\.\S+/gi,
  /\b[a-z0-9-]+\.(com|net|org|ph|io|app|dev|co|me|biz|info|xyz)\b/gi,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
];

export function filterMessage(text, username = 'User') {
  if (!text) return { allowed: false, reason: 'empty' };
  
  // Use fallback if words not loaded yet
  const bannedWords = wordsLoaded ? dynamicBannedWords : DEFAULT_BANNED_WORDS;
  const lowerText = text.toLowerCase();
  
  // Check banned words
  for (const word of bannedWords) {
    if (lowerText.includes(word)) {
      return { 
        allowed: false, 
        reason: 'inappropriate_content',
        filteredText: '[Message removed - violates community guidelines]'
      };
    }
  }
  
  // Check patterns (links, etc)
  let filteredText = text;
  for (const pattern of BANNED_PATTERNS) {
    filteredText = filteredText.replace(pattern, '[removed]');
  }
  
  return { 
    allowed: true, 
    filteredText: filteredText !== text ? filteredText : text 
  };
}

export function isUserBanned(userId, bannedList = []) {
  return bannedList.includes(userId);
}

// Auto-load on import (call this in App.js on startup)
loadBannedWords();
