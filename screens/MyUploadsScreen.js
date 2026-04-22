import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useUser } from '../context/UserContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { s, ms } from '../utils/responsive';
import { COLORS } from '../constants/theme';
import { ROUTES } from '../constants/routes';
import ModernDialog from './ModernDialog';
import AnimatedButton from './AnimatedButton';
import { SystemBars } from 'react-native-edge-to-edge';
import { useFocusEffect } from '@react-navigation/native';

export default function MyUploadsScreen({ navigation }) {
  const { user: currentUser } = useUser();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState('pending');
  const [videos, setVideos] = useState([]);
  const [tabCounts, setTabCounts] = useState({ pending: 0, approved: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [appealedVideoIds, setAppealedVideoIds] = useState(new Set());
  const [dialog, setDialog] = useState({
    visible: false,
    title: '',
    message: '',
    type: 'info',
    buttons: [],
  });
  const [appealModal, setAppealModal] = useState({ visible: false, videoId: null });
  const [appealReason, setAppealReason] = useState('');
  const [contactModal, setContactModal] = useState({ visible: false, videoId: null, caption: '' });
  const [contactMessage, setContactMessage] = useState('');

  const fetchData = useCallback(async () => {
    if (!currentUser?.id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // Fetch latest profile data including ban/rejection status
      const { data: profileData } = await supabase
        .from('profiles')
        .select('is_banned, rejection_count')
        .eq('id', currentUser.id)
        .single();
      const isBanned = profileData?.is_banned || false;
      const rejectionCount = profileData?.rejection_count || 0;
      setProfileStatus({ is_banned: isBanned, rejection_count: rejectionCount });
      const { data: videosData, error: videosError } = await supabase
        .from('videos')
        .select('id, caption, category, thumbnail_url, created_at, status, rejection_reason')
        .eq('user_id', currentUser.id)
        .eq('status', activeTab)
        .order('created_at', { ascending: false });

      if (videosError) throw videosError;
      setVideos(videosData || []);

      const statuses = ['pending', 'approved', 'rejected'];
      const counts = {};
      await Promise.all(statuses.map(async (status) => {
        const { count, error: countError } = await supabase
          .from('videos')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', currentUser.id)
          .eq('status', status);
        if (!countError) {
          counts[status] = count || 0;
        }
      }));
      setTabCounts(counts);

      if (activeTab === 'rejected' && videosData && videosData.length > 0) {
        const videoIds = videosData.map((v) => v.id);
        const { data: appealsData, error: appealsError } = await supabase
          .from('appeals')
          .select('video_id')
          .in('video_id', videoIds)
          .eq('user_id', currentUser.id);

        if (!appealsError && appealsData) {
          setAppealedVideoIds(new Set(appealsData.map((a) => a.video_id)));
        }
      } else {
        setAppealedVideoIds(new Set());
      }
    } catch (error) {
      console.error('Error fetching uploads:', error);
      setDialog({
        visible: true,
        title: 'Error',
        message: 'Failed to load uploads',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => setDialog((d) => ({ ...d, visible: false })) }],
      });
    } finally {
      setLoading(false);
    }
  }, [currentUser, activeTab]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useFocusEffect(
    useCallback(() => {
      fetchData();
      const entry = SystemBars.pushStackEntry({ style: 'dark' });
      return () => SystemBars.popStackEntry(entry);
    }, [fetchData])
  );

  const handleAppealPress = useCallback((videoId) => {
    setAppealModal({ visible: true, videoId });
    setAppealReason('');
  }, []);

  const handleSubmitAppeal = useCallback(async () => {
    const reason = appealReason.trim();
    if (!reason) {
      setDialog({
        visible: true,
        title: 'Error',
        message: 'Please enter a reason for your appeal.',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => setDialog((d) => ({ ...d, visible: false })) }],
      });
      return;
    }
    if (!currentUser?.id || !appealModal.videoId) return;

    try {
      const { error } = await supabase
        .from('appeals')
        .insert({
          video_id: appealModal.videoId,
          user_id: currentUser.id,
          reason,
          status: 'pending',
        });

      if (error) throw error;

      setAppealedVideoIds((prev) => {
        const next = new Set(prev);
        next.add(appealModal.videoId);
        return next;
      });
      setAppealModal({ visible: false, videoId: null });
      setAppealReason('');
      setDialog({
        visible: true,
        title: 'Success',
        message: 'Appeal submitted',
        type: 'success',
        buttons: [{ text: 'OK', onPress: () => setDialog((d) => ({ ...d, visible: false })) }],
      });
    } catch (error) {
      console.error('Error submitting appeal:', error);
      setDialog({
        visible: true,
        title: 'Error',
        message: 'Failed to submit appeal',
        type: 'error',
        buttons: [{ text: 'OK', onPress: () => setDialog((d) => ({ ...d, visible: false })) }],
      });
    }
  }, [appealReason, appealModal.videoId, currentUser]);

  const handleSubmitContact = useCallback(async () => {
    const message = contactMessage.trim();
    if (!message) {
      setDialog({ visible: true, title: 'Error', message: 'Please enter a message.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
      return;
    }
    try {
      await supabase.from('user_messages').insert({
        user_id: currentUser.id,
        subject: 'Video Issue: ' + (contactModal.caption || 'My Video'),
        message,
        status: 'pending',
      });
      setContactModal({ visible: false, videoId: null, caption: '' });
      setContactMessage('');
      setDialog({ visible: true, title: 'Sent!', message: 'Your message has been sent to admin.', type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    } catch (error) {
      setDialog({ visible: true, title: 'Error', message: 'Failed to send message.', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    }
  }, [contactMessage, contactModal, currentUser]);

  const handleCloseAppealModal = useCallback(() => {
    setAppealModal({ visible: false, videoId: null });
    setAppealReason('');
  }, []);

  const getStatusStyle = (status) => {
    switch (status) {
      case 'approved':
        return { color: COLORS.success, bg: COLORS.success + '20', text: 'Approved' };
      case 'rejected':
        return { color: COLORS.live, bg: COLORS.live + '20', text: 'Rejected' };
      default:
        return { color: '#f59e0b', bg: '#f59e0b20', text: 'Pending' };
    }
  };

  const renderVideoItem = useCallback(({ item }) => {
    const statusStyle = getStatusStyle(item.status);
    const isAppealed = appealedVideoIds.has(item.id);

    return (
      <View style={styles.videoCard}>
        {item.thumbnail_url ? (
          <Image source={{ uri: item.thumbnail_url }} style={styles.thumbnail} />
        ) : (
          <View style={[styles.thumbnail, styles.thumbnailPlaceholder]}>
            <Text style={styles.thumbnailPlaceholderText}>🎬</Text>
          </View>
        )}
        <View style={styles.videoInfo}>
          <Text style={styles.caption} numberOfLines={2}>
            {item.caption || 'No caption'}
          </Text>
          <Text style={styles.meta}>{item.category || 'Uncategorized'}</Text>
          <Text style={styles.meta}>
            {new Date(item.created_at).toLocaleDateString()}
          </Text>
          <View style={[styles.statusBadge, { backgroundColor: statusStyle.bg, borderColor: statusStyle.color }]}>
            <Text style={[styles.statusText, { color: statusStyle.color }]}>
              {statusStyle.text}
            </Text>
          </View>
          {item.status === 'rejected' && item.rejection_reason ? (
            <Text style={styles.rejectionReason}>
              Reason: {item.rejection_reason}
            </Text>
          ) : null}
          {item.status === 'rejected' && !isAppealed ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                style={styles.appealButton}
                onPress={() => handleAppealPress(item.id)}
              >
                <Text style={styles.appealButtonText}>Appeal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.appealButton, { borderColor: '#94a3b8', backgroundColor: '#f1f5f9', paddingVertical: s(8), paddingHorizontal: s(14) }]}
                onPress={() => setContactModal({ visible: true, videoId: item.id, caption: item.caption })}
              >
                <Text style={[styles.appealButtonText, { color: '#475569' }]}>Contact Admin</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {item.status === 'rejected' && isAppealed ? (
            <Text style={styles.appealedText}>Appeal submitted</Text>
          ) : null}
        </View>
      </View>
    );
  }, [appealedVideoIds, handleAppealPress]);

  const getEmptyMessage = () => {
    switch (activeTab) {
      case 'pending':
        return 'No pending uploads 📤';
      case 'approved':
        return 'No approved uploads yet ✅';
      case 'rejected':
        return 'No rejected uploads ❌';
      default:
        return 'No uploads found';
    }
  };

  const [profileStatus, setProfileStatus] = useState({ is_banned: false, rejection_count: 0 });
  const showBannedBanner = profileStatus.is_banned === true;
  const showRejectionWarning = !showBannedBanner && (profileStatus.rejection_count >= 5);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Text style={styles.title}>My Uploads</Text>

      {showBannedBanner && (
        <View style={styles.bannedBanner}>
          <Text style={styles.bannedBannerText}>
            You are banned from uploading. Contact admin for support.
          </Text>
        </View>
      )}

      {showRejectionWarning && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningBannerText}>
            Warning: Next upload requires admin review.
          </Text>
        </View>
      )}

      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'pending' && styles.activeTab]}
          onPress={() => setActiveTab('pending')}
        >
          <Text style={[styles.tabText, activeTab === 'pending' && styles.activeTabText]}>
            Pending ({tabCounts.pending})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'approved' && styles.activeTab]}
          onPress={() => setActiveTab('approved')}
        >
          <Text style={[styles.tabText, activeTab === 'approved' && styles.activeTabText]}>
            Approved ({tabCounts.approved})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'rejected' && styles.activeTab]}
          onPress={() => setActiveTab('rejected')}
        >
          <Text style={[styles.tabText, activeTab === 'rejected' && styles.activeTabText]}>
            Rejected ({tabCounts.rejected})
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={COLORS.gold} />
        </View>
      ) : (
        <FlatList
          data={videos}
          renderItem={renderVideoItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.empty}>{getEmptyMessage()}</Text>
          }
        />
      )}

      <ModernDialog
        visible={dialog.visible}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        buttons={dialog.buttons}
        onDismiss={() => setDialog((d) => ({ ...d, visible: false }))}
      />

      <Modal
        transparent
        visible={contactModal.visible}
        animationType="fade"
        onRequestClose={() => setContactModal({ visible: false, videoId: null, caption: '' })}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.modalContainer}>
            <Text style={styles.modalTitle}>Contact Admin</Text>
            <Text style={styles.modalMessage}>
              Describe your issue with this video and we'll get back to you.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={contactMessage}
              onChangeText={setContactMessage}
              placeholder="Describe your issue..."
              placeholderTextColor="#94a3b8"
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              maxLength={500}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalCancelButton]}
                onPress={() => { setContactModal({ visible: false, videoId: null, caption: '' }); setContactMessage(''); }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalSubmitButton]}
                onPress={handleSubmitContact}
              >
                <Text style={styles.modalSubmitText}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        transparent
        visible={appealModal.visible}
        animationType="fade"
        onRequestClose={handleCloseAppealModal}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.modalContainer}>
            <Text style={styles.modalTitle}>Submit Appeal</Text>
            <Text style={styles.modalMessage}>
              Please explain why you believe this video should be reviewed.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={appealReason}
              onChangeText={setAppealReason}
              placeholder="Enter your reason..."
              placeholderTextColor="#94a3b8"
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              maxLength={500}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalCancelButton]}
                onPress={handleCloseAppealModal}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalSubmitButton]}
                onPress={handleSubmitAppeal}
              >
                <Text style={styles.modalSubmitText}>Submit</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgWhite,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: COLORS.textDark,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
    letterSpacing: -0.5,
  },
  bannedBanner: {
    backgroundColor: COLORS.live,
    marginHorizontal: 20,
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  bannedBannerText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
    textAlign: 'center',
  },
  warningBanner: {
    backgroundColor: '#fef3c7',
    marginHorizontal: 20,
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#f59e0b',
  },
  warningBannerText: {
    color: '#92400e',
    fontWeight: '700',
    fontSize: 14,
    textAlign: 'center',
  },
  tabContainer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    marginTop: 16,
    marginBottom: 12,
    gap: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
  },
  activeTab: {
    backgroundColor: COLORS.gold,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
  },
  activeTabText: {
    color: COLORS.textDark,
  },
  list: {
    padding: 16,
    paddingBottom: 40,
  },
  videoCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#f1f5f9',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
    flexDirection: 'row',
    gap: 12,
  },
  thumbnail: {
    width: 100,
    height: 100,
    borderRadius: 12,
    backgroundColor: '#e2e8f0',
  },
  thumbnailPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  thumbnailPlaceholderText: {
    fontSize: 32,
  },
  videoInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  caption: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.textDark,
    marginBottom: 4,
    lineHeight: 20,
  },
  meta: {
    fontSize: 13,
    color: '#94a3b8',
    fontWeight: '500',
    marginBottom: 2,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
  },
  rejectionReason: {
    fontSize: 13,
    color: '#dc2626',
    fontWeight: '600',
    marginTop: 8,
    lineHeight: 18,
  },
  appealButton: {
    marginTop: 10,
    backgroundColor: COLORS.gold + '15',
    borderWidth: 1,
    borderColor: COLORS.gold,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  appealButtonText: {
    color: COLORS.goldDark,
    fontWeight: '700',
    fontSize: 13,
  },
  appealedText: {
    marginTop: 10,
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.success,
  },
  empty: {
    textAlign: 'center',
    color: '#94a3b8',
    fontSize: 16,
    marginTop: 60,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: s(24),
  },
  modalContainer: {
    backgroundColor: '#ffffff',
    borderRadius: s(24),
    padding: s(24),
    width: '100%',
    maxWidth: s(320),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 10,
  },
  modalTitle: {
    fontSize: ms(18),
    fontWeight: '700',
    color: COLORS.textDark,
    textAlign: 'center',
    marginBottom: s(8),
  },
  modalMessage: {
    fontSize: ms(14),
    color: '#64748b',
    textAlign: 'center',
    lineHeight: ms(20),
    marginBottom: s(16),
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: COLORS.textDark,
    backgroundColor: '#f8fafc',
    minHeight: 100,
    marginBottom: s(16),
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalCancelButton: {
    backgroundColor: '#f1f5f9',
  },
  modalCancelText: {
    color: '#64748b',
    fontWeight: '700',
    fontSize: 14,
  },
  modalSubmitButton: {
    backgroundColor: COLORS.gold,
  },
  modalSubmitText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
});
