// AsyncStorage/SecureStore key prefixes and keys
export const STORAGE_PREFIXES = {
  CREDS: 'bushrann_creds_',
  PIN: 'bushrann_pin_',
  ACCOUNT: 'bushrann_account_',
};

export const STORAGE_KEYS = {
  // User data
  USER_CACHE: 'user_cache',
  SAVED_ACCOUNTS: 'saved_accounts',
  
  // Settings
  THEME: 'theme_preference',
  NOTIFICATION_SETTINGS: 'notification_settings',
  
  // Feed cache
  FEED_CACHE: 'feed_cache',
  FEED_CACHE_TIMESTAMP: 'feed_cache_timestamp',
};

// Helper to build credential key for an email
export function getCredentialKey(email) {
  const normalizedEmail = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `${STORAGE_PREFIXES.CREDS}${normalizedEmail}`;
}

// Helper to build PIN key for an email
export function getPinKey(email) {
  const normalizedEmail = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `${STORAGE_PREFIXES.PIN}${normalizedEmail}`;
}

// Helper to build account key
export function getAccountKey(identifier) {
  return `${STORAGE_PREFIXES.ACCOUNT}${identifier}`;
}
