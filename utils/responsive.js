import { Dimensions, PixelRatio, Platform } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Base screen size (designed on)
const BASE_WIDTH = 390;  // iPhone 14 base
const BASE_HEIGHT = 844;

// Scale based on screen width
const scale = SCREEN_WIDTH / BASE_WIDTH;
const verticalScale = SCREEN_HEIGHT / BASE_HEIGHT;

// Use this for font sizes
export function fontSize(size) {
  const scaled = size * scale;
  return Math.round(PixelRatio.roundToNearestPixel(scaled));
}

// Use this for widths, paddings, margins (horizontal)
export function s(size) {
  return Math.round(PixelRatio.roundToNearestPixel(size * scale));
}

// Use this for heights, vertical paddings (vertical)
export function vs(size) {
  return Math.round(PixelRatio.roundToNearestPixel(size * verticalScale));
}

// Use this for things that need moderate scaling (not too much)
export function ms(size, factor = 0.5) {
  return Math.round(PixelRatio.roundToNearestPixel(size + (size * scale - size) * factor));
}

export const screen = {
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
  isSmall: SCREEN_WIDTH < 375,       // iPhone SE, small Androids
  isMedium: SCREEN_WIDTH >= 375 && SCREEN_WIDTH < 414, // iPhone 14, Pixel
  isLarge: SCREEN_WIDTH >= 414,      // iPhone Plus, Pro Max, large Androids
  isIOS: Platform.OS === 'ios',
  isAndroid: Platform.OS === 'android',
};