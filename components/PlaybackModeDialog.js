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
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';
import { s, ms } from '../utils/responsive';

const MODES = [
  {
    key: 'lock',
    icon: 'lock-closed',
    title: 'Lock Screen',
    description: 'Continue playing even when phone is locked',
  },
  {
    key: 'app',
    icon: 'phone-portrait',
    title: 'In App Only',
    description: 'Stops when you leave the app',
  },
  {
    key: 'background',
    icon: 'apps',
    title: 'Background',
    description: 'Keep playing while using other apps',
  },
];

export default function PlaybackModeDialog({ visible, onSelect, onDismiss }) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(50)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.spring(slideAnim, {
          toValue: 0,
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
        Animated.timing(slideAnim, {
          toValue: 50,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

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
            <Animated.View style={[styles.container, { transform: [{ translateY: slideAnim }] }]}>
              <Text style={styles.headerTitle}>Playback Mode</Text>
              <Text style={styles.headerSub}>How would you like to listen?</Text>

              <View style={styles.optionsContainer}>
                {MODES.map((mode) => (
                  <TouchableOpacity
                    key={mode.key}
                    style={styles.optionRow}
                    onPress={() => {
                      onDismiss();
                      onSelect(mode.key);
                    }}
                    activeOpacity={0.7}
                  >
                    <View style={styles.iconContainer}>
                      <Ionicons name={mode.icon} size={22} color={COLORS.gold ?? '#c9a84c'} />
                    </View>
                    <View style={styles.textContainer}>
                      <Text style={styles.optionTitle}>{mode.title}</Text>
                      <Text style={styles.optionDesc}>{mode.description}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#ccc" />
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity
                style={styles.cancelButton}
                onPress={onDismiss}
                activeOpacity={0.8}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
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
    backgroundColor: '#ffffff',
    borderRadius: s(24),
    padding: s(24),
    width: '100%',
    maxWidth: s(340),
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 10,
  },
  headerTitle: {
    fontSize: ms(20),
    fontWeight: '700',
    color: '#1a2e44',
    textAlign: 'center',
  },
  headerSub: {
    fontSize: ms(13),
    color: '#64748b',
    textAlign: 'center',
    marginTop: s(4),
    marginBottom: s(20),
  },
  optionsContainer: {
    width: '100%',
    gap: s(8),
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderRadius: s(14),
    padding: s(14),
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  iconContainer: {
    width: s(40),
    height: s(40),
    borderRadius: s(12),
    backgroundColor: 'rgba(201,168,76,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: s(12),
  },
  textContainer: {
    flex: 1,
  },
  optionTitle: {
    fontSize: ms(15),
    fontWeight: '600',
    color: '#1a2e44',
  },
  optionDesc: {
    fontSize: ms(12),
    color: '#64748b',
    marginTop: s(2),
  },
  cancelButton: {
    marginTop: s(16),
    backgroundColor: '#f1f5f9',
    borderRadius: s(12),
    paddingVertical: s(14),
    paddingHorizontal: s(24),
    width: '100%',
    alignItems: 'center',
  },
  cancelText: {
    fontSize: ms(15),
    fontWeight: '600',
    color: '#64748b',
  },
});