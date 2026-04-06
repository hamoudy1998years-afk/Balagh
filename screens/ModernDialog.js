import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  Animated,
  TouchableWithoutFeedback,
} from 'react-native';
import { COLORS } from '../constants/theme';
import { s, ms } from '../utils/responsive';

export default function ModernDialog({
  visible,
  title,
  message,
  type = 'info', // 'info', 'success', 'error', 'warning', 'confirm'
  buttons = [],
  onDismiss,
}) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 65,
          friction: 11,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 0.8,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  const getIcon = () => {
    switch (type) {
      case 'success': return '✅';
      case 'error': return '❌';
      case 'warning': return '⚠️';
      case 'confirm': return '❓';
      default: return 'ℹ️';
    }
  };

  const getTitleColor = () => {
    switch (type) {
      case 'success': return '#00C896';
      case 'error': return '#FF4458';
      case 'warning': return '#B76E79';
      case 'confirm': return '#B76E79';
      default: return '#ffffff';
    }
  };

  if (!visible) return null;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      onRequestClose={onDismiss}
    >
      <TouchableWithoutFeedback onPress={onDismiss}>
        <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
          <TouchableWithoutFeedback>
            <Animated.View style={[styles.container, { transform: [{ scale: scaleAnim }] }]}>
              <Text style={styles.icon}>{getIcon()}</Text>
              <Text style={[styles.title, { color: getTitleColor() }]}>{title}</Text>
              {message ? <Text style={styles.message}>{message}</Text> : null}
              
              <View style={styles.buttonContainer}>
                {buttons.map((button, index) => (
                  <TouchableOpacity
                    key={index}
                    style={[
                      styles.button,
                      button.style === 'cancel' && styles.cancelButton,
                      button.style === 'destructive' && styles.destructiveButton,
                      buttons.length === 1 && styles.singleButton,
                      buttons.length === 2 && styles.halfButton,
                    ]}
                    onPress={() => {
                      onDismiss();
                      button.onPress?.();
                    }}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.buttonText,
                        button.style === 'cancel' && styles.cancelButtonText,
                        button.style === 'destructive' && styles.destructiveButtonText,
                      ]}
                    >
                      {button.text}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Animated.View>
          </TouchableWithoutFeedback>
        </Animated.View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: s(24),
  },
  container: {
    backgroundColor: '#1a2e44',
    borderRadius: s(20),
    padding: s(28),
    width: '100%',
    maxWidth: s(320),
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2a3a5c',
  },
  icon: {
    fontSize: ms(48),
    marginBottom: s(16),
  },
  title: {
    fontSize: ms(20),
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: s(12),
  },
  message: {
    fontSize: ms(14),
    color: '#94a3b8',
    textAlign: 'center',
    lineHeight: ms(20),
    marginBottom: s(24),
  },
  buttonContainer: {
    flexDirection: 'column',
    gap: s(10),
    width: '100%',
  },
  button: {
    width: '100%',
    backgroundColor: COLORS.gold,
    borderRadius: s(12),
    paddingVertical: s(14),
    paddingHorizontal: s(20),
    alignItems: 'center',
    justifyContent: 'center',
  },
  singleButton: {
    width: '100%',
  },
  halfButton: {
    width: '100%',
  },
  cancelButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#4b5563',
  },
  destructiveButton: {
    backgroundColor: '#dc2626',
  },
  buttonText: {
    color: '#1a2e44',
    fontSize: ms(16),
    fontWeight: '700',
    textAlign: 'center',
  },
  cancelButtonText: {
    color: '#94a3b8',
  },
  destructiveButtonText: {
    color: '#ffffff',
  },
});