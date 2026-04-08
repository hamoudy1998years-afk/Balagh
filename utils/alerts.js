import { ERROR_TITLES, ERROR_MESSAGES, SUCCESS_TITLES, SUCCESS_MESSAGES, CONFIRM_TITLES, CONFIRM_MESSAGES } from '../constants/errors';
import { ROUTES } from '../constants/routes';

// Error alerts - return dialog configs for ModernDialog
export function showErrorAlert(message, title = ERROR_TITLES.ERROR) {
  return { title, message, type: 'error', buttons: [{ text: 'OK' }] };
}

export function showNetworkError(navigation) {
  return {
    title: ERROR_TITLES.NETWORK_ERROR,
    message: ERROR_MESSAGES.NETWORK_ERROR,
    type: 'error',
    buttons: [{ text: 'OK' }]
  };
}

export function showAuthError(navigation) {
  return {
    title: ERROR_TITLES.AUTH_ERROR,
    message: ERROR_MESSAGES.NOT_LOGGED_IN,
    type: 'error',
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Login', onPress: () => navigation?.navigate(ROUTES.LOGIN) },
    ]
  };
}

export function showPermissionAlert(permissionType, message) {
  return {
    title: ERROR_TITLES.PERMISSION_DENIED,
    message,
    type: 'error',
    buttons: [{ text: 'OK' }]
  };
}

// Success alerts - return dialog configs
export function showSuccessAlert(message, title = SUCCESS_TITLES.SUCCESS) {
  return { title, message, type: 'success', buttons: [{ text: 'OK' }] };
}

export function showSuccessWithAction(message, actionText, action, title = SUCCESS_TITLES.SUCCESS) {
  return {
    title,
    message,
    type: 'success',
    buttons: [{ text: actionText || 'OK', onPress: action }]
  };
}

// Confirmation dialogs - return dialog configs
export function showDeleteConfirmation(itemName, onDelete) {
  return {
    title: `${CONFIRM_TITLES.DELETE} ${itemName}?`,
    message: CONFIRM_MESSAGES.DELETE_VIDEO,
    type: 'warning',
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: CONFIRM_TITLES.DELETE, style: 'destructive', onPress: onDelete },
    ]
  };
}

export function showUnpinConfirmation(onUnpin) {
  return {
    title: CONFIRM_TITLES.UNPIN_VIDEO,
    message: CONFIRM_MESSAGES.UNPIN_VIDEO,
    type: 'confirm',
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: CONFIRM_TITLES.UNPIN, onPress: onUnpin },
    ]
  };
}

export function showUnblockConfirmation(username, onUnblock) {
  return {
    title: `${CONFIRM_TITLES.UNBLOCK} @${username}?`,
    message: CONFIRM_MESSAGES.UNBLOCK_USER,
    type: 'confirm',
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: CONFIRM_TITLES.UNBLOCK, onPress: onUnblock },
    ]
  };
}

export function showLogoutConfirmation(onLogout) {
  return {
    title: CONFIRM_TITLES.LOG_OUT,
    message: CONFIRM_MESSAGES.LOG_OUT,
    type: 'warning',
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: CONFIRM_TITLES.LOG_OUT, style: 'destructive', onPress: onLogout },
    ]
  };
}

export function showDeleteAccountConfirmation(onDelete) {
  return {
    title: CONFIRM_TITLES.DELETE_ACCOUNT,
    message: CONFIRM_MESSAGES.DELETE_ACCOUNT,
    type: 'warning',
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete Forever', style: 'destructive', onPress: onDelete },
    ]
  };
}

export function showClearNotificationsConfirmation(onClear) {
  return {
    title: CONFIRM_TITLES.CLEAR_ALL,
    message: CONFIRM_MESSAGES.CLEAR_NOTIFICATIONS,
    type: 'warning',
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: CONFIRM_TITLES.CLEAR_ALL, style: 'destructive', onPress: onClear },
    ]
  };
}

// Field validation alerts - return dialog configs
export function showMissingFieldAlert(fieldName) {
  return {
    title: ERROR_TITLES.MISSING_FIELD,
    message: `${fieldName} is required.`,
    type: 'error',
    buttons: [{ text: 'OK' }]
  };
}

export function showTooShortAlert(fieldName, minLength) {
  return {
    title: ERROR_TITLES.TOO_SHORT,
    message: `${fieldName} must be at least ${minLength} characters.`,
    type: 'error',
    buttons: [{ text: 'OK' }]
  };
}

export function showInvalidInputAlert(message) {
  return {
    title: ERROR_TITLES.INVALID_INPUT,
    message,
    type: 'error',
    buttons: [{ text: 'OK' }]
  };
}
