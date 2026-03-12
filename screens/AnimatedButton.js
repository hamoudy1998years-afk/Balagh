import { useRef } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';

export default function AnimatedButton({ children, style, onPress, onLongPress, delayLongPress, disabled, ...props }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const isLongPress = useRef(false);

  function handlePressIn() {
    isLongPress.current = false;
    Animated.timing(opacity, {
      toValue: 0.55,
      duration: 0,
      useNativeDriver: true,
    }).start();
  }

  function handlePressOut() {
    Animated.timing(opacity, {
      toValue: 1,
      duration: 0,
      useNativeDriver: true,
    }).start();
  }

  function handleLongPress() {
    isLongPress.current = true;
    onLongPress?.();
  }

  function handlePress() {
    if (isLongPress.current) return;
    onPress?.();
  }

  return (
    <Animated.View style={[{ opacity }, style]}>
      {children}
      <Pressable
        onPress={handlePress}
        onLongPress={onLongPress ? handleLongPress : undefined}
        delayLongPress={delayLongPress}
        disabled={disabled}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        unstable_pressDelay={0}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}