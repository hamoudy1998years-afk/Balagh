// Centralized notification policy.
//
// Screens should NOT call Notifications.setNotificationHandler() directly —
// doing so overwrites whatever handler any other part of the app installed.
// Instead, call setSuppressNotifications(true) on mount and
// setSuppressNotifications(false) on unmount. A reference count is used so
// multiple screens can independently request suppression without clobbering
// each other.

import * as Notifications from 'expo-notifications';

let suppressCount = 0;

function applyHandler() {
  const suppress = suppressCount > 0;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: !suppress,
      shouldShowList: !suppress,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export function setSuppressNotifications(suppress) {
  suppressCount = Math.max(0, suppressCount + (suppress ? 1 : -1));
  applyHandler();
}

// Call once at app startup (e.g. in App.js) to install the baseline handler.
export function initNotificationPolicy() {
  suppressCount = 0;
  applyHandler();
}