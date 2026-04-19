import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useUser } from '../context/UserContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { s, ms } from '../utils/responsive';
import { COLORS } from '../constants/theme';
import ModernDialog from './ModernDialog';
import { SystemBars } from 'react-native-edge-to-edge';
import { useFocusEffect } from '@react-navigation/native';
import Video from 'react-native-video';

const VideoPlayer = React.memo(({ videoUrl, style }) => {
  return (
    <Video
      source={{ uri: videoUrl }}
      style={style}
      controls={true}
      resizeMode="contain"
      paused={false}
      repeat={true}
    />
  );
});

export default function AdminScreen({ navigation }) {
  const { user: authUser } = useUser();
  const insets = useSafeAreaInsets();
  const [reports, setReports] = useState([]);
  const [scholarApps, setScholarApps] = useState([]);
  const [activeTab, setActiveTab] = useState('pending');
  const [pendingVideos, setPendingVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [messages, setMessages] = useState([]);
  const [appeals, setAppeals] = useState([]);
  const [stats, setStats] = useState({ totalReviewed: 0, approved: 0, rejected: 0, pending: 0, appeals: 0, approvalRate: 0 });
  const [playingVideoId, setPlayingVideoId] = useState(null);
  const TABS = ['pending', 'reports', 'scholars', 'messages', 'appeals', 'stats'];
  const touchStartX = useRef(0);
  const tabScrollRef = useRef(null);
  const tabWidths = useRef({});
  const [dialog, setDialog] = useState({
    visible: false, 
    title: '', 
    message: '', 
    type: 'info', 
    buttons: [] 
  });

  useEffect(() => {
    const checkAdmin = async () => {
      if (!authUser?.id) return;
      
      const { data: adminData } = await supabase
        .from('admins')
        .select('id, role')
        .eq('user_id', authUser.id)
        .maybeSingle();
      
      if (!adminData) {
        setDialog({ visible: true, title: 'Access Denied', message: 'You do not have admin privileges.', type: 'error', buttons: [{ text: 'OK', onPress: () => navigation.goBack() }] });
      } else {
        setIsAdmin(true);
        setIsSuperAdmin(adminData.role === 'super_admin');
      }
    };
    
    checkAdmin();
  }, [authUser]);

  const loadScholarApplications = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('scholar_applications')
        .select('*')
        .eq('status', 'pending')
        .order('submitted_at', { ascending: false });

      if (error) throw error;
      setScholarApps(data || []);
    } catch (error) {
      console.error('Error loading scholar applications:', error);
      setDialog({ visible: true, title: 'Error', message: 'Failed to load scholar applications', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    }
  }, []);

  const loadAppeals = useCallback(async () => {
    try {
      const { data: adminData } = await supabase
        .from('admins')
        .select('id')
        .eq('user_id', authUser.id)
        .single();

      const { data, error } = await supabase
        .from('appeals')
        .select('*, video:videos!video_id(caption, thumbnail_url, user_id, rejection_reason), sender:profiles!user_id(username)')
        .eq('status', 'pending')
        .neq('reviewed_by', adminData?.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setAppeals(data || []);
    } catch (error) {
      setDialog({ visible: true, title: 'Error', message: 'Failed to load appeals', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authUser]);

  const loadMessages = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('user_messages')
        .select('*, sender:profiles!user_id(username, avatar_url)')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setMessages(data || []);
    } catch (error) {
      setDialog({ visible: true, title: 'Error', message: 'Failed to load messages', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const { count: approvedCount } = await supabase.from('videos').select('*', { count: 'exact', head: true }).eq('status', 'approved');
      const { count: rejectedCount } = await supabase.from('videos').select('*', { count: 'exact', head: true }).eq('status', 'rejected');
      const { count: pendingCount } = await supabase.from('videos').select('*', { count: 'exact', head: true }).eq('status', 'pending');
      const { count: appealsCount } = await supabase.from('appeals').select('*', { count: 'exact', head: true });
      const totalReviewed = (approvedCount || 0) + (rejectedCount || 0);
      const approvalRate = totalReviewed > 0 ? Math.round((approvedCount / totalReviewed) * 100) : 0;
      setStats({ totalReviewed, approved: approvedCount || 0, rejected: rejectedCount || 0, pending: pendingCount || 0, appeals: appealsCount || 0, approvalRate });
    } catch (error) {
      setDialog({ visible: true, title: 'Error', message: 'Failed to load stats', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    }
  }, []);

  const loadPendingVideos = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('videos')
        .select('id, caption, thumbnail_url, video_url, user_id, created_at, category, duration, uploader:profiles!user_id(username, avatar_url, rejection_count)')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setPendingVideos(data || []);
    } catch (error) {
      setDialog({ visible: true, title: 'Error', message: 'Failed to load pending videos', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadReports = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('reports')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      setReports(data || []);
    } catch (error) {
      setDialog({ visible: true, title: 'Error', message: 'Failed to load reports', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    Promise.all([
      loadPendingVideos(),
      loadReports(),
      loadScholarApplications(),
      loadMessages(),
      loadAppeals(),
      loadStats(),
    ]).finally(() => {
      setLoading(false);
    });
  }, [isAdmin]);

  useEffect(() => {
    setPlayingVideoId(null);
    const index = TABS.indexOf(activeTab);
    let offset = 0;
    for (let i = 0; i < index; i++) {
      offset += (tabWidths.current[i] || 116) + 8;
    }
    tabScrollRef.current?.scrollTo({ x: Math.max(0, offset - 16), animated: true });
  }, [activeTab]);

  const handleDismiss = async (reportId) => {
    try {
      const { error } = await supabase
        .from('reports')
        .delete()
        .eq('id', reportId);

      if (error) {
        setDialog({ visible: true, title: 'Error', message: 'Failed to dismiss report: ' + error.message, type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
        return;
      }

      setReports(prev => prev.filter(r => r.id !== reportId));
      setDialog({ visible: true, title: 'Success', message: 'Report dismissed', type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    } catch (error) {
      setDialog({ visible: true, title: 'Error', message: 'Failed to dismiss report', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
    }
  };

  const handleBanUser = async (userId, reportId) => {
    setDialog({
      visible: true,
      title: 'Ban User',
      message: 'Are you sure you want to ban this user?',
      type: 'warning',
      buttons: [
        { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
        {
          text: 'Ban',
          style: 'destructive',
          onPress: async () => {
            setDialog(d => ({ ...d, visible: false }));
            try {
              await supabase
                .from('profiles')
                .update({ is_banned: true })
                .eq('id', userId);

              await supabase
                .from('videos')
                .update({ status: 'rejected', rejection_reason: 'User banned' })
                .eq('user_id', userId)
                .eq('status', 'pending');
              
              await supabase.from('reports').delete().eq('id', reportId);
              setReports(prev => prev.filter(r => r.id !== reportId));
              setDialog({ visible: true, title: 'Success', message: 'User banned and pending videos rejected.', type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            } catch (error) {
              setDialog({ visible: true, title: 'Error', message: 'Failed to ban user', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            }
          }
        }
      ]
    });
  };

  const handleDeleteVideo = async (videoId, reportId) => {
    setDialog({
      visible: true,
      title: 'Delete Video',
      message: 'Are you sure you want to delete this video?',
      type: 'warning',
      buttons: [
        { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDialog(d => ({ ...d, visible: false }));
            try {
              await supabase.from('videos').delete().eq('id', videoId);
              await supabase.from('reports').delete().eq('id', reportId);
              setReports(prev => prev.filter(r => r.id !== reportId));
              setDialog({ visible: true, title: 'Success', message: 'Video deleted', type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            } catch (error) {
              setDialog({ visible: true, title: 'Error', message: 'Failed to delete video', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            }
          }
        }
      ]
    });
  };

  const handleApproveScholar = async (application) => {
    setDialog({
      visible: true,
      title: 'Approve Scholar',
      message: `Approve ${application.full_name} as a verified scholar?`,
      type: 'confirm',
      buttons: [
        { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
        {
          text: 'Approve',
          onPress: async () => {
            setDialog(d => ({ ...d, visible: false }));
            try {
              await supabase
                .from('scholar_applications')
                .update({ status: 'approved', reviewed_at: new Date().toISOString() })
                .eq('id', application.id);
              
              await supabase
                .from('profiles')
                .update({ is_scholar: true })
                .eq('id', application.user_id);
              
              setScholarApps(prev => prev.filter(app => app.id !== application.id));
              setDialog({ visible: true, title: 'Success', message: 'Scholar approved!', type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            } catch (error) {
              setDialog({ visible: true, title: 'Error', message: 'Failed to approve scholar', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            }
          }
        }
      ]
    });
  };

  const handleRejectScholar = async (application) => {
    setDialog({
      visible: true,
      title: 'Reject Application',
      message: `Reject ${application.full_name}'s scholar application?`,
      type: 'warning',
      buttons: [
        { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            setDialog(d => ({ ...d, visible: false }));
            try {
              await supabase
                .from('scholar_applications')
                .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
                .eq('id', application.id);
              
              setScholarApps(prev => prev.filter(app => app.id !== application.id));
              setDialog({ visible: true, title: 'Rejected', message: 'Application rejected', type: 'info', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            } catch (error) {
              setDialog({ visible: true, title: 'Error', message: 'Failed to reject application', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            }
          }
        }
      ]
    });
  };

  const handleApproveVideo = async (video) => {
    setDialog({
      visible: true,
      title: 'Approve Video',
      message: `Approve this video by @${video.uploader?.username || 'Unknown'}?`,
      type: 'confirm',
      buttons: [
        { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
        {
          text: 'Approve',
          onPress: async () => {
            setDialog(d => ({ ...d, visible: false }));
            try {
              await supabase
                .from('videos')
                .update({ status: 'approved', reviewed_at: new Date().toISOString() })
                .eq('id', video.id);
              
              setPendingVideos(prev => prev.filter(v => v.id !== video.id));
              await supabase.from('profiles').update({ rejection_count: 0 }).eq('id', video.user_id);
              await supabase.from('notifications').insert({ user_id: video.user_id, actor_id: authUser.id, video_id: video.id, type: 'video_approved' });
              setDialog({ visible: true, title: 'Success', message: 'Video approved!', type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            } catch (error) {
              setDialog({ visible: true, title: 'Error', message: 'Failed to approve video', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            }
          }
        }
      ]
    });
  };

  const handleRejectVideo = async (video) => {
    setDialog({
      visible: true,
      title: 'Reject Video',
      message: `Reject this video by @${video.uploader?.username || 'Unknown'}?\n\nReason:`,
      type: 'confirm',
      buttons: [
        { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            setDialog(d => ({ ...d, visible: false }));
            try {
              const reasons = ['Inappropriate content', 'Not a verified scholar', 'Wrong sect/content', 'Poor video quality', 'Copyright issue', 'Other'];
              setDialog({
                visible: true,
                title: 'Select Rejection Reason',
                message: 'Choose a reason:',
                type: 'confirm',
                buttons: reasons.map(reason => ({
                  text: reason,
                  onPress: async () => {
                    setDialog(d => ({ ...d, visible: false }));
                    await supabase
                      .from('videos')
                      .update({ status: 'rejected', reviewed_at: new Date().toISOString(), rejection_reason: reason })
                      .eq('id', video.id);
                    setPendingVideos(prev => prev.filter(v => v.id !== video.id));
                    const { data: profileData } = await supabase.from('profiles').select('rejection_count').eq('id', video.user_id).single();
                    const newCount = (profileData?.rejection_count || 0) + 1;
                    await supabase.from('profiles').update({ rejection_count: newCount }).eq('id', video.user_id);
                    await supabase.from('notifications').insert({ user_id: video.user_id, actor_id: authUser.id, video_id: video.id, type: 'video_rejected' });
                    if (newCount >= 5) {
                      setDialog({ visible: true, title: '⚠️ 5 Rejections Reached', message: `This user has ${newCount} rejections. Their next upload will require admin review. Ban them now?`, type: 'warning', buttons: [
                        { text: 'Not Now', onPress: () => setDialog(d => ({ ...d, visible: false })) },
                        { text: 'Ban User', style: 'destructive', onPress: async () => {
                          setDialog(d => ({ ...d, visible: false }));
                          await supabase.from('profiles').update({ is_banned: true }).eq('id', video.user_id);
                          await supabase.from('videos').update({ status: 'rejected', rejection_reason: 'User banned' }).eq('user_id', video.user_id).eq('status', 'pending');
                          setDialog({ visible: true, title: 'User Banned', message: 'User has been banned and all pending videos rejected.', type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
                        }}
                      ]});
                    } else {
                      setDialog({ visible: true, title: 'Rejected', message: `Video rejected: ${reason}`, type: 'info', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
                    }
                  }
                }))
              });
            } catch (error) {
              setDialog({ visible: true, title: 'Error', message: 'Failed to reject video', type: 'error', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
            }
          }
        }
      ]
    });
  };

  const renderAppeal = useCallback(({ item }) => (
    <View style={styles.reportCard}>
      <View style={styles.reportHeader}>
        <View style={styles.userInfo}>
          <Text style={styles.label}>From:</Text>
          <Text style={styles.username}>@{item.sender?.username || 'Unknown'}</Text>
        </View>
        <Text style={styles.date}>{new Date(item.created_at).toLocaleDateString()}</Text>
      </View>
      {item.video?.thumbnail_url && (
        <Image source={{ uri: item.video.thumbnail_url }} style={styles.thumbnail} />
      )}
      <View style={styles.reasonContainer}>
        <Text style={styles.label}>Original Rejection Reason:</Text>
        <Text style={styles.reason}>{item.video?.rejection_reason || 'No reason given'}</Text>
      </View>
      <View style={styles.bioContainer}>
        <Text style={styles.label}>User's Appeal:</Text>
        <Text style={styles.bioText}>{item.reason}</Text>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, styles.rejectButton]}
          onPress={async () => {
            setDialog({ visible: true, title: 'Reject Appeal', message: 'Reject this appeal? Decision will be final.', type: 'warning', buttons: [
              { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
              { text: 'Reject', style: 'destructive', onPress: async () => {
                setDialog(d => ({ ...d, visible: false }));
                const { data: adminInfo2 } = await supabase.from('admins').select('id').eq('user_id', authUser.id).single();
                await supabase.from('appeals').update({ status: 'rejected', reviewed_by: adminInfo2?.id }).eq('id', item.id);
                await supabase.from('notifications').insert({ user_id: item.user_id, actor_id: authUser.id, video_id: item.video_id, type: 'appeal_rejected' });
                setAppeals(prev => prev.filter(a => a.id !== item.id));
                setDialog({ visible: true, title: 'Appeal Rejected', message: 'Decision is final.', type: 'info', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
              }}
            ]});
          }}
        >
          <Text style={styles.rejectText}>Reject Appeal</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.approveButton]}
          onPress={async () => {
            setDialog({ visible: true, title: 'Approve Appeal', message: 'Approve this appeal? Video will go live.', type: 'confirm', buttons: [
              { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
              { text: 'Approve', onPress: async () => {
                setDialog(d => ({ ...d, visible: false }));
                await supabase.from('videos').update({ status: 'approved' }).eq('id', item.video_id);
                const { data: adminInfo } = await supabase.from('admins').select('id').eq('user_id', authUser.id).single();
                await supabase.from('appeals').update({ status: 'approved', reviewed_by: adminInfo?.id }).eq('id', item.id);
                await supabase.from('notifications').insert({ user_id: item.user_id, actor_id: authUser.id, video_id: item.video_id, type: 'appeal_approved' });
                setAppeals(prev => prev.filter(a => a.id !== item.id));
                setDialog({ visible: true, title: 'Appeal Approved', message: 'Video is now live!', type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
              }}
            ]});
          }}
        >
          <Text style={styles.approveText}>Approve Appeal</Text>
        </TouchableOpacity>
      </View>
    </View>
  ), []);

  const renderMessage = useCallback(({ item }) => (
    <View style={styles.reportCard}>
      <View style={styles.reportHeader}>
        <View style={styles.userInfo}>
          <Text style={styles.label}>From:</Text>
          <Text style={styles.username}>@{item.sender?.username || 'Unknown'}</Text>
        </View>
        <Text style={styles.date}>{new Date(item.created_at).toLocaleDateString()}</Text>
      </View>
      <View style={styles.reasonContainer}>
        <Text style={styles.label}>Subject:</Text>
        <Text style={styles.reason}>{item.subject}</Text>
      </View>
      <View style={styles.bioContainer}>
        <Text style={styles.label}>Message:</Text>
        <Text style={styles.bioText}>{item.message}</Text>
      </View>
      {item.status === 'escalated' && item.escalated_note && (
        <View style={[styles.reasonContainer, { backgroundColor: '#fff7ed', borderColor: '#fed7aa' }]}>
          <Text style={styles.label}>Escalation Note:</Text>
          <Text style={styles.reason}>{item.escalated_note}</Text>
        </View>
      )}
      <View style={styles.actions}>
        {item.status !== 'resolved' && (
          <>
            <TouchableOpacity
              style={[styles.button, styles.approveButton]}
              onPress={() => {
                setDialog({
                  visible: true,
                  title: 'Reply to User',
                  message: `Reply to @${item.sender?.username}:`,
                  type: 'confirm',
                  buttons: [
                    { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
                    { text: 'Mark Resolved', onPress: async () => {
                      setDialog(d => ({ ...d, visible: false }));
                      await supabase.from('user_messages').update({ status: 'resolved' }).eq('id', item.id);
                      setMessages(prev => prev.map(m => m.id === item.id ? { ...m, status: 'resolved' } : m));
                    }},
                    { text: 'Send Reply', onPress: async () => {
                      setDialog(d => ({ ...d, visible: false }));
                      await supabase.from('user_messages').insert({
                        user_id: item.user_id,
                        subject: 'Re: ' + item.subject,
                        message: `Admin replied to your message. Please check your contact admin screen.`,
                        status: 'resolved',
                      });
                      await supabase.from('user_messages').update({ status: 'resolved' }).eq('id', item.id);
                      setMessages(prev => prev.map(m => m.id === item.id ? { ...m, status: 'resolved' } : m));
                      setDialog({ visible: true, title: 'Reply Sent', message: 'User has been notified.', type: 'success', buttons: [{ text: 'OK', onPress: () => setDialog(d => ({ ...d, visible: false })) }] });
                    }}
                  ]
                });
              }}
            >
              <Text style={styles.approveText}>Reply / Resolve</Text>
            </TouchableOpacity>
            {!isSuperAdmin && (
              <TouchableOpacity
                style={[styles.button, { backgroundColor: '#fff7ed', borderWidth: 1, borderColor: '#fed7aa' }]}
                onPress={() => {
                  setDialog({
                    visible: true,
                    title: 'Escalate to Super Admin',
                    message: 'Add a note for the super admin:',
                    type: 'confirm',
                    buttons: [
                      { text: 'Cancel', style: 'cancel', onPress: () => setDialog(d => ({ ...d, visible: false })) },
                      { text: 'Escalate', onPress: async () => {
                        setDialog(d => ({ ...d, visible: false }));
                        await supabase.from('user_messages').update({ status: 'escalated', escalated_by: authUser.id }).eq('id', item.id);
                        setMessages(prev => prev.map(m => m.id === item.id ? { ...m, status: 'escalated' } : m));
                      }}
                    ]
                  });
                }}
              >
                <Text style={{ fontWeight: '700', fontSize: 12, color: '#ea580c' }}>Escalate</Text>
              </TouchableOpacity>
            )}
          </>
        )}
        {item.status === 'resolved' && (
          <Text style={{ color: '#16a34a', fontWeight: '700', fontSize: 13 }}>✓ Resolved</Text>
        )}
        {item.status === 'escalated' && (
          <Text style={{ color: '#ea580c', fontWeight: '700', fontSize: 13 }}>⬆ Escalated</Text>
        )}
      </View>
    </View>
  ), []);

  const renderPendingVideo = useCallback(({ item }) => (
    <Swipeable
      renderRightActions={() => (
        <TouchableOpacity
          style={{ backgroundColor: '#dc2626', justifyContent: 'center', alignItems: 'center', width: s(80), borderRadius: s(16), marginBottom: s(14) }}
          onPress={() => handleRejectVideo(item)}
        >
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>Reject</Text>
        </TouchableOpacity>
      )}
      renderLeftActions={() => (
        <TouchableOpacity
          style={{ backgroundColor: '#16a34a', justifyContent: 'center', alignItems: 'center', width: s(80), borderRadius: s(16), marginBottom: s(14) }}
          onPress={() => handleApproveVideo(item)}
        >
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>Approve</Text>
        </TouchableOpacity>
      )}
    >
      <View style={styles.reportCard}>
        <View style={styles.reportHeader}>
          <View style={styles.userInfo}>
            <Text style={styles.label}>Uploader:</Text>
            <Text style={styles.username}>@{item.uploader?.username || 'Unknown'}</Text>
          </View>
          <Text style={styles.date}>
            {new Date(item.created_at).toLocaleDateString()}
          </Text>
          {item.uploader?.rejection_count >= 5 && (
            <View style={{ backgroundColor: '#fef2f2', borderRadius: s(8), paddingHorizontal: s(8), paddingVertical: s(4), borderWidth: 1, borderColor: '#fecaca', marginLeft: s(8) }}>
              <Text style={{ fontSize: ms(11), fontWeight: '800', color: '#dc2626' }}>⚠️ {item.uploader.rejection_count} rejections</Text>
            </View>
          )}
        </View>

        <View style={styles.videoInfo}>
          <Text style={styles.label}>Caption:</Text>
          <Text style={styles.caption} numberOfLines={2}>
            {item.caption || 'No caption'}
          </Text>
          {playingVideoId === item.id ? (
            <>
              {console.log('VIDEO DEBUG - ID:', item.id, 'URL:', item.video_url)}
              <VideoPlayer videoUrl={item.video_url} style={styles.thumbnail} />
            </>
          ) : (
            <TouchableOpacity onPress={() => setPlayingVideoId(item.id)}>
              {item.thumbnail_url ? (
                <Image source={{ uri: item.thumbnail_url }} style={styles.thumbnail} />
              ) : (
                <View style={[styles.thumbnail, { backgroundColor: '#e2e8f0', justifyContent: 'center', alignItems: 'center' }]}>
                  <Text style={{ fontSize: 40 }}>▶</Text>
                </View>
              )}
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' }}>
                <View style={{ backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: s(30), width: s(50), height: s(50), justifyContent: 'center', alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontSize: ms(20) }}>▶</Text>
                  <Text style={{ color: '#fff', fontSize: 20 }}>▶</Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
          <Text style={styles.metaText}>Category: {item.category || 'None'}</Text>
          <Text style={styles.metaText}>Duration: {Math.round(item.duration / 1000)}s</Text>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity 
            style={[styles.button, styles.rejectButton]}
            onPress={() => handleRejectVideo(item)}
          >
            <Text style={styles.rejectText}>Reject</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={[styles.button, styles.approveButton]}
            onPress={() => handleApproveVideo(item)}
          >
            <Text style={styles.approveText}>Approve</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Swipeable>
  ), [playingVideoId]);

  const renderScholarApplication = ({ item }) => (
    <View style={styles.reportCard}>
      <View style={styles.reportHeader}>
        <View style={styles.userInfo}>
          <Text style={styles.label}>Applicant:</Text>
          <Text style={styles.username}>{item.full_name}</Text>
        </View>
        <Text style={styles.date}>
          {new Date(item.submitted_at).toLocaleDateString()}
        </Text>
      </View>

      <View style={styles.scholarInfo}>
        <Text style={styles.scholarLabel}>Age: <Text style={styles.scholarValue}>{item.age}</Text></Text>
        <Text style={styles.scholarLabel}>Location: <Text style={styles.scholarValue}>{item.location}</Text></Text>
        <Text style={styles.scholarLabel}>Education: <Text style={styles.scholarValue}>{item.education}</Text></Text>
        <Text style={styles.scholarLabel}>Expertise: <Text style={styles.scholarValue}>{item.expertise}</Text></Text>
      </View>

      <View style={styles.bioContainer}>
        <Text style={styles.label}>Bio:</Text>
        <Text style={styles.bioText}>{item.bio}</Text>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity 
          style={[styles.button, styles.rejectButton]}
          onPress={() => handleRejectScholar(item)}
        >
          <Text style={styles.rejectText}>Reject</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.button, styles.approveButton]}
          onPress={() => handleApproveScholar(item)}
        >
          <Text style={styles.approveText}>Approve</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderStats = () => (
    <View style={{ padding: s(8) }}>
      <View style={{ flexDirection: 'row', gap: s(12), marginBottom: s(12) }}>
        <View style={{ flex: 1, backgroundColor: '#f0fdf4', borderRadius: s(16), padding: s(16), borderWidth: 1, borderColor: '#bbf7d0' }}>
          <Text style={{ fontSize: ms(28), fontWeight: '800', color: '#16a34a' }}>{stats.approved}</Text>
          <Text style={{ fontSize: ms(12), color: '#16a34a', fontWeight: '600', marginTop: s(4) }}>Approved</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: '#fef2f2', borderRadius: s(16), padding: s(16), borderWidth: 1, borderColor: '#fecaca' }}>
          <Text style={{ fontSize: ms(28), fontWeight: '800', color: '#dc2626' }}>{stats.rejected}</Text>
          <Text style={{ fontSize: ms(12), color: '#dc2626', fontWeight: '600', marginTop: s(4) }}>Rejected</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: s(12), marginBottom: s(12) }}>
        <View style={{ flex: 1, backgroundColor: '#fff7ed', borderRadius: s(16), padding: s(16), borderWidth: 1, borderColor: '#fed7aa' }}>
          <Text style={{ fontSize: ms(28), fontWeight: '800', color: '#ea580c' }}>{stats.pending}</Text>
          <Text style={{ fontSize: ms(12), color: '#ea580c', fontWeight: '600', marginTop: s(4) }}>Pending</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: '#f0f9ff', borderRadius: s(16), padding: s(16), borderWidth: 1, borderColor: '#bae6fd' }}>
          <Text style={{ fontSize: ms(28), fontWeight: '800', color: '#0284c7' }}>{stats.appeals}</Text>
          <Text style={{ fontSize: ms(12), color: '#0284c7', fontWeight: '600', marginTop: s(4) }}>Appeals</Text>
        </View>
      </View>
      <View style={{ backgroundColor: '#fafafa', borderRadius: s(16), padding: s(16), borderWidth: 1, borderColor: '#e2e8f0' }}>
        <Text style={{ fontSize: ms(13), color: '#94a3b8', fontWeight: '600', marginBottom: s(4) }}>TOTAL REVIEWED</Text>
        <Text style={{ fontSize: ms(32), fontWeight: '800', color: '#1a2e44' }}>{stats.totalReviewed}</Text>
        <Text style={{ fontSize: ms(13), color: '#94a3b8', fontWeight: '600', marginTop: s(12), marginBottom: s(4) }}>APPROVAL RATE</Text>
        <Text style={{ fontSize: ms(32), fontWeight: '800', color: COLORS.gold }}>{stats.approvalRate}%</Text>
      </View>
    </View>
  );

  const renderReport = useCallback(({ item }) => (
    <View style={styles.reportCard}>
      <View style={styles.reportHeader}>
        <View style={styles.userInfo}>
          <Text style={styles.label}>Reported by:</Text>
          <Text style={styles.username}>@{item.reporter?.username || 'Unknown'}</Text>
        </View>
        <Text style={styles.date}>
          {new Date(item.created_at).toLocaleDateString()}
        </Text>
        {item.uploader?.rejection_count >= 5 && (
          <View style={{ backgroundColor: '#fef2f2', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: '#fecaca' }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: '#dc2626' }}>⚠️ {item.uploader.rejection_count} rejections</Text>
          </View>
        )}
      </View>

      <View style={styles.reportedUserInfo}>
        <Text style={styles.label}>Reported User:</Text>
        <Text style={styles.username}>@{item.reported_user?.username || 'Unknown'}</Text>
      </View>

      <View style={styles.reasonContainer}>
        <Text style={styles.label}>Reason:</Text>
        <Text style={styles.reason}>{item.reason}</Text>
      </View>

      {item.video && (
        <View style={styles.videoInfo}>
          <Text style={styles.label}>Video:</Text>
          {item.video.thumbnail_url && (
            <Image 
              source={{ uri: item.video.thumbnail_url }} 
              style={styles.thumbnail}
            />
          )}
          <Text style={styles.caption} numberOfLines={2}>
            {item.video.caption || 'No caption'}
          </Text>
        </View>
      )}

      <View style={styles.actions}>
        <TouchableOpacity 
          style={[styles.button, styles.dismissButton]}
          onPress={() => handleDismiss(item.id)}
        >
          <Text style={styles.dismissText}>Dismiss</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.button, styles.banButton]}
          onPress={() => handleBanUser(item.reported_user_id, item.id)}
        >
          <Text style={styles.banText}>Ban User</Text>
        </TouchableOpacity>

        {item.video_id && (
          <TouchableOpacity 
            style={[styles.button, styles.deleteButton]}
            onPress={() => handleDeleteVideo(item.video_id, item.id)}
          >
            <Text style={styles.deleteText}>Delete Video</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  ), []);

  useFocusEffect(
    useCallback(() => {
      const entry = SystemBars.pushStackEntry({ style: 'dark' });
      return () => SystemBars.popStackEntry(entry);
    }, [])
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color={COLORS.gold} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Text style={styles.title}>Admin Panel</Text>
        
        <ScrollView ref={tabScrollRef} horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16, flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingLeft: 16, paddingRight: 40, paddingVertical: 8 }}>
          <TouchableOpacity 
            style={[styles.tab, activeTab === 'pending' && styles.activeTab]}
            onPress={() => setActiveTab('pending')}
            onLayout={e => { tabWidths.current[0] = e.nativeEvent.layout.width; }}
          >
            <Text style={[styles.tabText, activeTab === 'pending' && styles.activeTabText]}>
              Pending ({pendingVideos.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.tab, activeTab === 'reports' && styles.activeTab]}
            onPress={() => setActiveTab('reports')}
            onLayout={e => { tabWidths.current[1] = e.nativeEvent.layout.width; }}
          >
            <Text style={[styles.tabText, activeTab === 'reports' && styles.activeTabText]}>
              Reports ({reports.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.tab, activeTab === 'scholars' && styles.activeTab]}
            onPress={() => setActiveTab('scholars')}
            onLayout={e => { tabWidths.current[2] = e.nativeEvent.layout.width; }}
          >
            <Text style={[styles.tabText, activeTab === 'scholars' && styles.activeTabText]}>
              Scholars ({scholarApps.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.tab, activeTab === 'messages' && styles.activeTab]}
            onPress={() => setActiveTab('messages')}
            onLayout={e => { tabWidths.current[3] = e.nativeEvent.layout.width; }}
          >
            <Text style={[styles.tabText, activeTab === 'messages' && styles.activeTabText]}>
              Messages ({messages.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.tab, activeTab === 'appeals' && styles.activeTab]}
            onPress={() => setActiveTab('appeals')}
            onLayout={e => { tabWidths.current[4] = e.nativeEvent.layout.width; }}
          >
            <Text style={[styles.tabText, activeTab === 'appeals' && styles.activeTabText]}>
              Appeals ({appeals.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.tab, activeTab === 'stats' && styles.activeTab]}
            onPress={() => setActiveTab('stats')}
            onLayout={e => { tabWidths.current[5] = e.nativeEvent.layout.width; }}
          >
            <Text style={[styles.tabText, activeTab === 'stats' && styles.activeTabText]}>
              Stats
            </Text>
          </TouchableOpacity>
        </ScrollView>
        
        <View
          style={{ flex: 1 }}
          onTouchStart={e => { touchStartX.current = e.nativeEvent.pageX; }}
          onTouchEnd={e => {
            if (activeTab === 'pending') return;
            const diff = touchStartX.current - e.nativeEvent.pageX;
            if (Math.abs(diff) < 50) return;
            const currentIndex = TABS.indexOf(activeTab);
            if (diff > 0 && currentIndex < TABS.length - 1) setActiveTab(TABS[currentIndex + 1]);
            if (diff < 0 && currentIndex > 0) setActiveTab(TABS[currentIndex - 1]);
          }}
        >
        {activeTab === 'stats' ? (
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {renderStats()}
          </ScrollView>
        ) : null}
        
        {activeTab !== 'stats' ? (
          <FlatList
            data={activeTab === 'reports' ? reports : activeTab === 'scholars' ? scholarApps : activeTab === 'messages' ? messages : activeTab === 'appeals' ? appeals : pendingVideos}
            renderItem={activeTab === 'reports' ? renderReport : activeTab === 'scholars' ? renderScholarApplication : activeTab === 'messages' ? renderMessage : activeTab === 'appeals' ? renderAppeal : renderPendingVideo}
            keyExtractor={item => item.id}
            contentContainerStyle={styles.list}
            refreshing={refreshing}
            initialNumToRender={5}
            maxToRenderPerBatch={5}
            windowSize={5}
            removeClippedSubviews={true}
            updateCellsBatchingPeriod={10}
            onRefresh={() => {
              setRefreshing(true);
              if (activeTab === 'reports') {
                loadReports();
              } else if (activeTab === 'scholars') {
                loadScholarApplications();
              } else if (activeTab === 'messages') {
                loadMessages();
              } else if (activeTab === 'appeals') {
                loadAppeals();
              } else {
                loadPendingVideos();
              }
            }}
            ListEmptyComponent={
              <Text style={styles.empty}>
                {activeTab === 'reports' ? 'No reports to review' : activeTab === 'scholars' ? 'No pending scholar applications' : activeTab === 'messages' ? 'No messages yet' : activeTab === 'appeals' ? 'No pending appeals' : 'No pending videos'}
              </Text>
            }
          />
        ) : null}

        </View>
        <ModernDialog
          visible={dialog.visible}
          title={dialog.title}
          message={dialog.message}
          type={dialog.type}
          buttons={dialog.buttons}
          onDismiss={() => setDialog({ ...dialog, visible: false })}
        />
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#1a2e44',
    padding: 20,
    paddingBottom: 4,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: '#94a3b8',
    fontWeight: '600',
    paddingHorizontal: 20,
    marginBottom: 16,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  list: {
    padding: 16,
    paddingBottom: 40,
  },
  reportCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#f1f5f9',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  reportHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  userInfo: {
    flex: 1,
  },
  reportedUserInfo: {
    marginBottom: 12,
    padding: 12,
    backgroundColor: '#fff7ed',
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#f97316',
  },
  label: {
    fontSize: 11,
    color: '#94a3b8',
    marginBottom: 3,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  username: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1a2e44',
  },
  date: {
    fontSize: 12,
    color: '#94a3b8',
    fontWeight: '500',
  },
  reasonContainer: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  reason: {
    fontSize: 14,
    color: '#475569',
    fontWeight: '500',
    lineHeight: 20,
  },
  videoInfo: {
    marginBottom: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  thumbnail: {
    width: '100%',
    height: 150,
    borderRadius: 10,
    marginTop: 8,
    marginBottom: 8,
    backgroundColor: '#e2e8f0',
  },
  caption: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  button: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissButton: {
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  banButton: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  deleteButton: {
    backgroundColor: '#fff7ed',
    borderWidth: 1,
    borderColor: '#fed7aa',
  },
  buttonText: {
    fontWeight: '700',
    fontSize: 12,
    color: '#1a2e44',
  },
  empty: {
    textAlign: 'center',
    color: '#94a3b8',
    fontSize: 16,
    marginTop: 60,
    fontWeight: '600',
  },
  dismissText: {
    fontWeight: '700',
    fontSize: 12,
    color: '#64748b',
  },
  banText: {
    fontWeight: '700',
    fontSize: 12,
    color: '#dc2626',
  },
  deleteText: {
    fontWeight: '700',
    fontSize: 12,
    color: '#ea580c',
  },
    tab: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    height: 36,
    minWidth: 100,
  },
  activeTab: {
    backgroundColor: COLORS.gold,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748b',
  },
  activeTabText: {
    color: '#1a2e44',
  },
  scholarInfo: {
    backgroundColor: '#f0fdf4',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  scholarLabel: {
    fontSize: 13,
    color: '#166534',
    fontWeight: '600',
    marginBottom: 4,
  },
  scholarValue: {
    fontWeight: '500',
    color: '#15803d',
  },
  bioContainer: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  bioText: {
    fontSize: 14,
    color: '#475569',
    lineHeight: 20,
  },
  rejectButton: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  approveButton: {
    backgroundColor: '#dcfce7',
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  rejectText: {
    fontWeight: '700',
    fontSize: 12,
    color: '#dc2626',
  },
  approveText: {
    fontWeight: '700',
    fontSize: 12,
    color: '#16a34a',
  },
  metaText: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 4,
  },
});