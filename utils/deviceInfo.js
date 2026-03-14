import { Platform, StatusBar, Dimensions } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Device type detection
export const isIOS = Platform.OS === 'ios';
export const isAndroid = Platform.OS === 'android';

// Screen size categories
export const isSmallDevice = SCREEN_WIDTH < 375;
export const isMediumDevice = SCREEN_WIDTH >= 375 && SCREEN_WIDTH < 414;
export const isLargeDevice = SCREEN_WIDTH >= 414;

// Tablet detection
export const isTablet = SCREEN_WIDTH >= 768;

// Notch / punch-hole detection
export const hasNotch = isIOS
  ? SCREEN_HEIGHT >= 812  // iPhone X and above
  : StatusBar.currentHeight > 24; // Android with tall status bar

// Status bar height
export const statusBarHeight = isIOS
  ? hasNotch ? 44 : 20
  : StatusBar.currentHeight ?? 24;

// Bottom home indicator
export const homeIndicatorHeight = isIOS
  ? hasNotch ? 34 : 0
  : 0;

// Safe bottom padding for bottom nav
export const safeBottom = isIOS
  ? hasNotch ? 34 : 16
  : 16;

// Android specific
export const androidRippleColor = 'rgba(245, 166, 35, 0.2)';

// Font scaling guard — prevents system font size from breaking layouts
export const maxFontSizeMultiplier = 1.2;