import { Alert } from 'react-native';
import { ERROR_TITLES, ERROR_MESSAGES, SUCCESS_TITLES, SUCCESS_MESSAGES, CONFIRM_TITLES, CONFIRM_MESSAGES } from '../constants/errors';
import { ROUTES } from '../constants/routes';

// Error alerts
export function showErrorAlert(message, title = ERROR_TITLES.ERROR) {
  Alert.alert(title, message, [{ text: 'OK' }]);
}

export function showNetworkError(navigation) {
  Alert.alert(
    ERROR_TITLES.NETWORK_ERROR,
    ERROR_MESSAGES.NETWORK_ERROR,
    [{ text: 'OK' }]
  );
}

export function showAuthError(navigation) {
  Alert.alert(
    ERROR_TITLES.AUTH_ERROR,
    ERROR_MESSAGES.NOT_LOGGED_IN,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Login', onPress: () => navigation?.navigate(ROUTES.LOGIN) },
    ]
  );
}

export function showPermissionAlert(permissionType, message) {
  Alert.alert(
    ERROR_TITLES.PERMISSION_DENIED,
    message,
    [{ text: 'OK' }]
  );
}

// Success alerts
export function showSuccessAlert(message, title = SUCCESS_TITLES.SUCCESS) {
  Alert.alert(title, message, [{ text: 'OK' }]);
}

export function showSuccessWithAction(message, actionText, action, title = SUCCESS_TITLES.SUCCESS) {
  Alert.alert(
    title,
    message,
    [
      { text: 'OK', onPress: action },
    ]
  );
}

// Confirmation dialogs
export function showDeleteConfirmation(itemName, onDelete) {
  Alert.alert(
    `${CONFIRM_TITLES.DELETE} ${itemName}?`,
    CONFIRM_MESSAGES.DELETE_VIDEO,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: CONFIRM_TITLES.DELETE, style: 'destructive', onPress: onDelete },
    ]
  );
}

export function showUnpinConfirmation(onUnpin) {
  Alert.alert(
    CONFIRM_TITLES.UNPIN_VIDEO,
    CONFIRM_MESSAGES.UNPIN_VIDEO,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: CONFIRM_TITLES.UNPIN, onPress: onUnpin },
    ]
  );
}

export function showUnblockConfirmation(username, onUnblock) {
  Alert.alert(
    `${CONFIRM_TITLES.UNBLOCK} @${username}?`,
    CONFIRM_MESSAGES.UNBLOCK_USER,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: CONFIRM_TITLES.UNBLOCK, onPress: onUnblock },
    ]
  );
}

export function showLogoutConfirmation(onLogout) {
  Alert.alert(
    CONFIRM_TITLES.LOG_OUT,
    CONFIRM_MESSAGES.LOG_OUT,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: CONFIRM_TITLES.LOG_OUT, style: 'destructive', onPress: onLogout },
    ]
  );
}

export function showDeleteAccountConfirmation(onDelete) {
  Alert.alert(
    CONFIRM_TITLES.DELETE_ACCOUNT,
    CONFIRM_MESSAGES.DELETE_ACCOUNT,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete Forever', style: 'destructive', onPress: onDelete },
    ]
  );
}

export function showClearNotificationsConfirmation(onClear) {
  Alert.alert(
    CONFIRM_TITLES.CLEAR_ALL,
    CONFIRM_MESSAGES.CLEAR_NOTIFICATIONS,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: CONFIRM_TITLES.CLEAR_ALL, style: 'destructive', onPress: onClear },
    ]
  );
}

// Field validation alerts
export function showMissingFieldAlert(fieldName) {
  Alert.alert(ERROR_TITLES.MISSING_FIELD, `${fieldName} is required.`);
}

export function showTooShortAlert(fieldName, minLength) {
  Alert.alert(
    ERROR_TITLES.TOO_SHORT,
    `${fieldName} must be at least ${minLength} characters.`
  );
}

export function showInvalidInputAlert(message) {
  Alert.alert(ERROR_TITLES.INVALID_INPUT, message);
}
