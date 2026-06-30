import { View, Text, StyleSheet } from 'react-native';
import { useCallback } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { SystemBars } from 'react-native-edge-to-edge';
import { COLORS } from '../constants/theme';

export default function ComingSoonScreen({ route }) {
  const insets = useSafeAreaInsets();
  const name = route?.name ?? 'This feature';

  useFocusEffect(
    useCallback(() => {
      const entry = SystemBars.pushStackEntry({ style: 'dark' });
      return () => SystemBars.popStackEntry(entry);
    }, [])
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top + 60 }]}>
      <Text style={styles.emoji}>🚧</Text>
      <Text style={styles.title}>{name} — Coming Soon</Text>
      <Text style={styles.subtitle}>
        We're focusing on Prayer Times & Quran first. This feature is on the way, in shaa Allah.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#f0f2f5',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32,
  },
  emoji: { fontSize: 56, marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '800', color: '#1a2e44', marginBottom: 10, textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#666', textAlign: 'center', lineHeight: 22 },
});