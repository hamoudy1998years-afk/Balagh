import React, { useRef, useEffect } from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/theme';

export default function ReplyInput({
  value,
  onChangeText,
  onSubmit,
  onCancel,
  replyingTo,
}) {
  const inputRef = useRef(null);

  useEffect(() => {
    // Delay focus by 150ms — gives the layout time to apply marginBottom
    // before the keyboard fires, so the input is always visible above keyboard
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      {/* "Replying to @username" bar */}
      <View style={styles.header}>
        <Text style={styles.replyingText}>
          Replying to{' '}
          <Text style={styles.username}>@{replyingTo?.user?.username}</Text>
        </Text>
        <TouchableOpacity onPress={onCancel} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.cancelBtn}>Cancel</Text>
        </TouchableOpacity>
      </View>

      {/* Input row */}
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder={`Reply to ${replyingTo?.user?.username}...`}
          placeholderTextColor="#999"
          value={value}
          onChangeText={onChangeText}
          multiline
          maxLength={500}
          // No autoFocus — we use ref + delayed focus above
        />
        <TouchableOpacity
          style={[styles.sendBtn, !value.trim() && styles.disabled]}
          onPress={onSubmit}
          disabled={!value.trim()}
        >
          <Text style={styles.sendIcon}>➤</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 15, paddingVertical: 10, backgroundColor: '#fff' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  replyingText: { fontSize: 13, color: '#666' },
  username: { fontWeight: '600', color: '#333' },
  cancelBtn: { fontSize: 13, color: COLORS.gold, fontWeight: '600' },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1, minHeight: 40, maxHeight: 100, backgroundColor: '#f1f1f2', borderRadius: 20, paddingHorizontal: 15, paddingVertical: 10, fontSize: 14, color: '#000' },
  sendBtn: { marginLeft: 10, width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.gold, justifyContent: 'center', alignItems: 'center' },
  disabled: { backgroundColor: '#ddd' },
  sendIcon: { color: COLORS.navy, fontSize: 14, marginLeft: 2 },
});