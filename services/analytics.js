// Centralized Firebase Analytics wrapper.
// Fire-and-forget: logging failures must never interrupt app functionality.
import { getAnalytics } from '@react-native-firebase/analytics';

// Keys that could carry personal or sensitive data are rejected outright.
const FORBIDDEN_KEY_PATTERN =
  /email|name|phone|question|answer|text|caption|username|token|password|auth|message/i;

// GA4 limits: event/parameter names <= 40 chars, string values <= 100 chars.
const MAX_NAME_LENGTH = 40;
const MAX_STRING_LENGTH = 100;

function sanitizeParams(params) {
  const clean = {};
  if (!params || typeof params !== 'object') return clean;

  for (const [key, value] of Object.entries(params)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) continue;

    if (typeof value === 'string') {
      clean[key] = value.slice(0, MAX_STRING_LENGTH);
    } else if (typeof value === 'number') {
      // Firebase rejects non-finite numbers; drop them instead of crashing.
      if (Number.isFinite(value)) clean[key] = value;
    } else if (typeof value === 'boolean') {
      clean[key] = value;
    }
    // All other types (objects, arrays, null, undefined) are dropped.
  }

  return clean;
}

export function logAnalyticsEvent(name, params) {
  try {
    if (!name || name.length > MAX_NAME_LENGTH) return;
    const result = getAnalytics().logEvent(name, sanitizeParams(params));
    if (__DEV__) {
      console.log(`[Analytics] logEvent called: ${name}`);
    }
    if (result && typeof result.catch === 'function') {
      result.then(() => {
        if (__DEV__) {
          console.log(`[Analytics] logEvent succeeded: ${name}`);
        }
      }).catch((err) => {
        if (__DEV__) {
          console.warn(`[Analytics] logEvent failed: ${name}`, err?.message ?? err);
        }
      });
    }
  } catch (e) {
    if (__DEV__) {
      console.warn(`[Analytics] logEvent threw: ${name}`, e?.message ?? e);
    }
    // Never let analytics break the caller.
  }
}
