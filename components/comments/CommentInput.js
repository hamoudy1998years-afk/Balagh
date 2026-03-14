import React from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/theme';

export default function CommentInput({ value, onChangeText, onSubmit, keyboardHeight }) {
  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Add comment..."
        placeholderTextColor="#999"
        value={value}
        onChangeText={onChangeText}
        multiline
        maxLength={500}
      />
      <TouchableOpacity
        style={[styles.sendBtn, !value.trim() && styles.disabled]}
        onPress={onSubmit}
        disabled={!value.trim()}
      >
        <Text style={styles.sendIcon}>➤</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 15, paddingVertical: 10,
    backgroundColor: '#fff',
  },
  input: {
    flex: 1, minHeight: 40, maxHeight: 100,
    backgroundColor: '#f1f1f2',
    borderRadius: 20, paddingHorizontal: 15, paddingVertical: 10,
    fontSize: 14, color: '#000',
  },
  sendBtn: {
    marginLeft: 10, width: 36, height: 36, borderRadius: 18,
    backgroundColor: COLORS.gold, justifyContent: 'center', alignItems: 'center',
  },
  disabled: { backgroundColor: '#ddd' },
  sendIcon: { color: COLORS.navy, fontSize: 14, marginLeft: 2 },
});