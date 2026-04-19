import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SystemBars } from 'react-native-edge-to-edge';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { useUser } from '../context/UserContext';
import { COLORS } from '../constants/theme';
import { ROUTES } from '../constants/routes';
import ModernDialog from './ModernDialog';
import AnimatedButton from './AnimatedButton';

const SUBJECTS = ['Upload Issue', 'Account Problem', 'Report Bug', 'Other'];

const STATUS_COLORS = {
  open: '#f59e0b',
  escalated: COLORS.live,
  resolved: COLORS.success,
};

function formatDate(dateString) {
  if (!dateString) return '';
  const d = new Date(dateString);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ContactAdminScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { user: currentUser } = useUser();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [subject, setSubject] = useState(SUBJECTS[0]);
  const [showSubjectDropdown, setShowSubjectDropdown] = useState(false);
  const [messageBody, setMessageBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dialog, setDialog] = useState({
    visible: false,
    title: '',
    message: '',
    type: 'info',
    buttons: [],
  });

  const loadMessages = useCallback(async () => {
    if (!currentUser?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('user_messages')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });
    if (!error && data) {
      setMessages(data);
    }
    setLoading(false);
  }, [currentUser?.id]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  useFocusEffect(
    useCallback(() => {
      const entry = SystemBars.pushStackEntry({ style: 'dark' });
      loadMessages();
      return () => {
        SystemBars.popStackEntry(entry);
      };
    }, [loadMessages])
  );

  const handleSelectSubject = useCallback((s) => {
    setSubject(s);
    setShowSubjectDropdown(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!currentUser?.id) return;
    if (!messageBody.trim()) {
      setDialog({
        visible: true,
        title: 'Error',
        message: 'Please enter a message.',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }],
      });
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from('user_messages').insert({
      user_id: currentUser.id,
      subject,
      message: messageBody.trim(),
      status: 'open',
    });
    setSubmitting(false);
    if (error) {
      setDialog({
        visible: true,
        title: 'Error',
        message: error.message || 'Failed to send message.',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }],
      });
      return;
    }
    setMessageBody('');
    setSubject(SUBJECTS[0]);
    setShowSubjectDropdown(false);
    await loadMessages();
    setDialog({
      visible: true,
      title: 'Success',
      message: 'Message sent! We will respond soon.',
      type: 'success',
      buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }],
    });
  }, [currentUser?.id, subject, messageBody, loadMessages]);

  const renderMessageItem = useCallback(({ item }) => {
    const statusColor = STATUS_COLORS[item.status] || STATUS_COLORS.open;
    const hasUpdate = item.updated_at && item.updated_at !== item.created_at;
    return (
      <View style={styles.messageCard}>
        <View style={styles.messageHeader}>
          <Text style={styles.subjectText}>{item.subject}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '20', borderColor: statusColor + '40' }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>{item.status}</Text>
          </View>
        </View>
        <Text style={styles.messageBody}>{item.message}</Text>
        {item.escalated_note ? (
          <View style={styles.adminReplyBox}>
            <Text style={styles.adminReplyLabel}>Admin Response:</Text>
            <Text style={styles.adminReplyText}>{item.escalated_note}</Text>
          </View>
        ) : null}
        <View style={styles.messageMeta}>
          <Text style={styles.dateText}>{formatDate(item.created_at)}</Text>
          {item.assigned_to ? <Text style={styles.metaTag}>Assigned to admin</Text> : null}
          {item.escalated_by ? <Text style={styles.metaTag}>Escalated</Text> : null}
        </View>
        {hasUpdate ? (
          <Text style={styles.updatedText}>Last updated: {formatDate(item.updated_at)}</Text>
        ) : null}
      </View>
    );
  }, []);

  const renderEmpty = useCallback(() => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyEmoji}>✉️</Text>
      <Text style={styles.emptyTitle}>No messages yet</Text>
      <Text style={styles.emptySubtitle}>Use the form below to contact us.</Text>
    </View>
  ), []);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={navigation.goBack} style={styles.backBtn}>
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Help & Support</Text>
        <View style={{ width: 44 }} />
      </View>

      <FlatList
        data={messages}
        keyExtractor={item => item.id?.toString() || Math.random().toString()}
        renderItem={renderMessageItem}
        contentContainerStyle={[
          styles.listContent,
          messages.length === 0 && styles.emptyList,
          { paddingBottom: insets.bottom + 12 },
        ]}
        ListEmptyComponent={renderEmpty}
        ListHeaderComponent={loading ? <ActivityIndicator style={{ marginVertical: 16 }} color={COLORS.gold} /> : null}
        showsVerticalScrollIndicator={false}
      />

      <View style={[styles.formContainer, { paddingBottom: insets.bottom + 12 }]}>
        <Text style={styles.formLabel}>Subject</Text>
        <TouchableOpacity
          style={styles.dropdownButton}
          onPress={() => setShowSubjectDropdown(v => !v)}
          activeOpacity={0.8}
        >
          <Text style={styles.dropdownButtonText}>{subject}</Text>
          <Text style={styles.dropdownChevron}>{showSubjectDropdown ? '▲' : '▼'}</Text>
        </TouchableOpacity>
        {showSubjectDropdown ? (
          <View style={styles.dropdownMenu}>
            {SUBJECTS.map((s) => (
              <TouchableOpacity
                key={s}
                style={styles.dropdownItem}
                onPress={() => handleSelectSubject(s)}
                activeOpacity={0.7}
              >
                <Text style={[
                  styles.dropdownItemText,
                  subject === s && styles.dropdownItemTextActive,
                ]}>
                  {s}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        <Text style={styles.formLabel}>Message</Text>
        <TextInput
          style={styles.messageInput}
          value={messageBody}
          onChangeText={setMessageBody}
          placeholder="Describe your issue..."
          placeholderTextColor={COLORS.textGray}
          multiline
          maxLength={500}
          numberOfLines={4}
          textAlignVertical="top"
        />
        <Text style={styles.charCount}>{messageBody.length}/500</Text>

        <AnimatedButton style={styles.submitBtn} onPress={handleSubmit}>
          <View style={styles.submitBtnInner}>
            {submitting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.submitBtnText}>Send Message</Text>
            )}
          </View>
        </AnimatedButton>
      </View>

      <ModernDialog
        visible={dialog.visible}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        buttons={dialog.buttons}
        onDismiss={() => setDialog(d => ({ ...d, visible: false }))}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgWhite,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: '#e5e5e5',
  },
  backBtn: {
    width: 44,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 34,
    color: COLORS.textDark,
    lineHeight: 36,
    fontWeight: '200',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.textDark,
    letterSpacing: -0.3,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  emptyList: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyEmoji: {
    fontSize: 40,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.textDark,
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 14,
    color: COLORS.textGray,
  },
  messageCard: {
    backgroundColor: '#f5f5f5',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: '#e5e5e5',
  },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  subjectText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.textDark,
    flex: 1,
    marginRight: 8,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  messageBody: {
    fontSize: 14,
    color: COLORS.textDark,
    lineHeight: 21,
    marginBottom: 10,
  },
  adminReplyBox: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 0.5,
    borderColor: COLORS.gold + '40',
  },
  adminReplyLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.gold,
    marginBottom: 4,
  },
  adminReplyText: {
    fontSize: 13,
    color: COLORS.textDark,
    lineHeight: 19,
  },
  messageMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  dateText: {
    fontSize: 12,
    color: COLORS.textGray,
  },
  metaTag: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.gold,
    backgroundColor: COLORS.gold + '15',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  updatedText: {
    fontSize: 11,
    color: COLORS.textGray,
    marginTop: 6,
    fontStyle: 'italic',
  },
  formContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 0.5,
    borderTopColor: '#e5e5e5',
    backgroundColor: COLORS.bgWhite,
  },
  formLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.textDark,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  dropdownButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f5f5f5',
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: '#e5e5e5',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 14,
  },
  dropdownButtonText: {
    fontSize: 15,
    color: COLORS.textDark,
    fontWeight: '600',
  },
  dropdownChevron: {
    fontSize: 12,
    color: COLORS.textGray,
  },
  dropdownMenu: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: '#e5e5e5',
    marginTop: -10,
    marginBottom: 14,
    overflow: 'hidden',
  },
  dropdownItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: '#f0f0f0',
  },
  dropdownItemText: {
    fontSize: 15,
    color: COLORS.textDark,
  },
  dropdownItemTextActive: {
    fontWeight: '700',
    color: COLORS.gold,
  },
  messageInput: {
    backgroundColor: '#f5f5f5',
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: '#e5e5e5',
    color: COLORS.textDark,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 80,
    maxHeight: 120,
  },
  charCount: {
    fontSize: 11,
    color: COLORS.textGray,
    textAlign: 'right',
    marginTop: 4,
    marginBottom: 10,
  },
  submitBtn: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  submitBtnInner: {
    backgroundColor: COLORS.gold,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
});
