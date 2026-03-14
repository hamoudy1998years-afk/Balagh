import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/theme';

export default function CommentHeader({ count, onClose }) {
  return (
    <View style={styles.container}>
      <View style={styles.spacer} />
      
      <Text style={styles.title}>{count} comments</Text>
      
      <TouchableOpacity onPress={onClose} style={styles.closeButton}>
        <Text style={styles.close}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 15, paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
  },
  spacer: { width: 30 },
  title: { fontSize: 15, fontWeight: '700', color: '#000', textAlign: 'center', flex: 1 },
  closeButton: { width: 30, alignItems: 'flex-end', justifyContent: 'center' },
  close: { fontSize: 18, color: '#666', fontWeight: '600' },
});