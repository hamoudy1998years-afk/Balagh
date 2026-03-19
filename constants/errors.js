// Error titles for Alert dialogs
export const ERROR_TITLES = {
  ERROR: 'Error',
  MISSING_FIELD: 'Missing Field',
  INVALID_INPUT: 'Invalid Input',
  TOO_SHORT: 'Too Short',
  PERMISSION_DENIED: 'Permission Denied',
  NETWORK_ERROR: 'Network Error',
  AUTH_ERROR: 'Authentication Error',
  NOT_FOUND: 'Not Found',
  ALREADY_EXISTS: 'Already Exists',
  LIMIT_REACHED: 'Limit Reached',
};

// Error messages
export const ERROR_MESSAGES = {
  // Auth
  NOT_LOGGED_IN: 'You must be logged in to perform this action.',
  SESSION_EXPIRED: 'Your session has expired. Please log in again.',
  INVALID_CREDENTIALS: 'Invalid email or password.',
  
  // Network
  NETWORK_ERROR: 'Network error. Please check your connection and try again.',
  SERVER_ERROR: 'Server error. Please try again later.',
  TIMEOUT_ERROR: 'Request timed out. Please try again.',
  
  // Permissions
  CAMERA_PERMISSION: 'Camera permission is needed to continue.',
  MICROPHONE_PERMISSION: 'Microphone permission is needed to continue.',
  PHOTO_LIBRARY_PERMISSION: 'Please allow access to your photos.',
  MEDIA_LIBRARY_PERMISSION: 'Please allow access to your media library.',
  
  // Video/Stream
  STREAM_START_FAILED: 'Could not start stream. Please try again.',
  TOKEN_ERROR: 'Could not get streaming token. Please try again.',
  UPLOAD_FAILED: 'Could not upload. Please try again.',
  DOWNLOAD_FAILED: 'Could not download. Please try again.',
  
  // Profile
  FOLLOW_FAILED: 'Could not follow. Please try again.',
  UNFOLLOW_FAILED: 'Could not unfollow. Please try again.',
  PROFILE_UPDATE_FAILED: 'Could not update profile. Please try again.',
  AVATAR_UPLOAD_FAILED: 'Could not upload avatar. Please try again.',
  
  // General
  SOMETHING_WENT_WRONG: 'Something went wrong. Please try again.',
  TRY_AGAIN: 'Please try again.',
};

// Success messages
export const SUCCESS_MESSAGES = {
  PROFILE_UPDATED: 'Profile updated successfully!',
  AVATAR_UPDATED: 'Avatar updated successfully!',
  UPLOAD_COMPLETE: 'Upload complete!',
  DOWNLOAD_COMPLETE: 'Downloaded to your gallery!',
  SAVED: 'Saved successfully!',
  DELETED: 'Deleted successfully!',
  REPORT_SUBMITTED: 'Report submitted. We will review it.',
  APPLICATION_SUBMITTED: 'Application submitted! We will review it.',
};

// Success titles
export const SUCCESS_TITLES = {
  SUCCESS: 'Success! 🎉',
  SAVED: 'Saved ✓',
  DELETED: 'Deleted',
  DOWNLOADED: 'Downloaded ✅',
  SUBMITTED: 'Submitted ✅',
};

// Confirmation titles
export const CONFIRM_TITLES = {
  DELETE: 'Delete',
  UNPIN: 'Unpin',
  UNBLOCK: 'Unblock',
  LOG_OUT: 'Log Out',
  DELETE_ACCOUNT: 'Delete Account',
  CLEAR_ALL: 'Clear All',
};

// Confirmation messages
export const CONFIRM_MESSAGES = {
  DELETE_VIDEO: 'Are you sure? This cannot be undone.',
  UNPIN_VIDEO: 'Remove this video from pinned?',
  UNBLOCK_USER: 'They will be able to see your content and follow you again.',
  LOG_OUT: 'Are you sure you want to log out?',
  DELETE_ACCOUNT: 'This will permanently delete your account, videos, comments, and all data. This cannot be undone.',
  CLEAR_NOTIFICATIONS: 'Are you sure you want to delete all notifications?',
};
