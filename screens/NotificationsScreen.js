import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useUser } from '../context/UserContext';
import { useFocusEffect } from '@react-navigation/native';
import {
  View, Text, StyleSheet, FlatList, ActivityIndicator,
  Alert, Animated, PanResponder, Vibration, RefreshControl, StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { COLORS } from '../constants/theme';

const NotificationItem = React.memo(function NotificationItem({ item, onDelete, onMarkRead, navigation }) {
  const translateX    = useRef(new Animated.Value(0)).current;
  const deleteOpacity = useRef(new Animated.Value(0)).current;
  const rowScale      = useRef(new Animated.Value(1)).current;
  const isDeleting    = useRef(false);
  const SWIPE_THRESHOLD = 80;

  const panResponder = useRef(
    PanResponder.create({
      // Don't claim on touch start — let taps pass through to the row
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      // Claim in the capture phase once the gesture is clearly horizontal.
      // Using capture (not just bubble) is what makes this work reliably on iOS,
      // where the parent ScrollView/FlatList would otherwise steal the gesture.
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onMoveShouldSetPanResponderCapture: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_, g) => {
        if (isDeleting.current) return;
        translateX.setValue(g.dx);
        deleteOpacity.setValue(Math.min(Math.abs(g.dx) / SWIPE_THRESHOLD, 1));
      },
      onPanResponderRelease: (_, g) => {
        if (isDeleting.current) return;
        if (Math.abs(g.dx) >= SWIPE_THRESHOLD) {
          triggerDelete();
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, tension: 100, friction: 10 }).start();
          Animated.timing(deleteOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start();
        }
      },
      // Don't yield the gesture once claimed — prevents iOS from taking it back
      onPanResponderTerminationRequest: () => false,
      // If iOS does steal the gesture (e.g. Control Centre swipe), snap back cleanly
      onPanResponderTerminate: () => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, tension: 100, friction: 10 }).start();
        Animated.timing(deleteOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      },
    })
  ).current;

  const triggerDelete = () => {
    isDeleting.current = true;
    Vibration.vibrate(30);
    Animated.parallel([
      Animated.timing(translateX, { toValue: 500, duration: 250, useNativeDriver: true }),
      Animated.timing(rowScale,   { toValue: 0,   duration: 300, useNativeDriver: true }),
    ]).start(() => onDelete(item.id));
  };

  const handleLongPress = () => {
    Vibration.vibrate(40);
    Alert.alert('Delete Notification', 'Remove this notification?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: triggerDelete },
    ]);
  };

  const handlePress = () => {
    if (!item.is_read) onMarkRead(item.id);
    if (item.type === 'follow') {
      navigation.navigate('Profile', { userId: item.actor?.id });
    } else if (item.video_id) {
      navigation.navigate('VideoDetail', { video: { id: item.video_id } });
    }
  };

  const getIcon = () => {
    switch (item.type) {
      case 'like': return '❤️'; case 'follow': return '👤';
      case 'comment': return '💬'; case 'reply': return '↩️'; default: return '🔔';
    }
  };

  const getMessage = () => {
    const name = item.actor?.username || 'Someone';
    switch (item.type) {
      case 'like':    return `${name} liked your video`;
      case 'follow':  return `${name} started following you`;
      case 'comment': return `${name} commented on your video`;
      case 'reply':   return `${name} replied to your comment`;
      default:        return `${name} interacted with you`;
    }
  };

  const formatTime = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <Animated.View style={{ transform: [{ scaleY: rowScale }], overflow: 'hidden' }}>
      <Animated.View style={[styles.deleteBackground, { opacity: deleteOpacity }]}>
        <Text style={styles.deleteBackgroundText}>🗑️ Delete</Text>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        <AnimatedButton
          onPress={handlePress}
          onLongPress={handleLongPress}
          delayLongPress={400}
          style={[styles.notificationRow, !item.is_read && styles.unreadRow]}
        >
          {!item.is_read && <View style={styles.unreadDot} />}
          <View style={styles.iconContainer}>
            <Text style={styles.icon}>{getIcon()}</Text>
          </View>
          <View style={styles.textContent}>
            <Text style={[styles.message, !item.is_read && styles.unreadMessage]}>{getMessage()}</Text>
            <Text style={styles.time}>{formatTime(item.created_at)}</Text>
          </View>
          {!item.is_read && <View style={styles.swipeHint}><Text style={styles.swipeHintText}>← →</Text></View>}
        </AnimatedButton>
      </Animated.View>
    </Animated.View>
  );
});

export default function NotificationsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [notifications, setNotifications] = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const { user: authUser } = useUser();
  const currentUserId = authUser?.id ?? null;
  const flatListRef = useRef(null);

  const handleDelete = useCallback(async (id) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
    await supabase.from('notifications').delete().eq('id', id);
  }, []);

  const handleMarkRead = useCallback(async (id) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
  }, []);

  const renderNotificationItem = useCallback(({ item }) => (
    <NotificationItem item={item} onDelete={handleDelete} onMarkRead={handleMarkRead} navigation={navigation} />
  ), [handleDelete, handleMarkRead, navigation]);

  useFocusEffect(
    useCallback(() => {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    }, [])
  );

  useEffect(() => {
    if (!currentUserId) return;
    loadNotifications();

    const channel = supabase
      .channel(`notifications_realtime_${currentUserId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${currentUserId}`,
      }, async (payload) => {
        const { data: actor } = await supabase
          .from('profiles')
          .select('id, username, avatar_url')
          .eq('id', payload.new.actor_id)
          .maybeSingle();
        setNotifications(prev => [{ ...payload.new, actor }, ...prev]);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [currentUserId]);

  const loadNotifications = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select(`*, actor:profiles!notifications_actor_id_fkey(id, username, avatar_url)`)
        .eq('user_id', currentUserId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      setNotifications(data ?? []);
    } catch (e) {
      __DEV__ && console.error('Error loading notifications:', e);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadNotifications();
    setRefreshing(false);
  }, [loadNotifications]);

  const handleMarkAllRead = useCallback(async () => {
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', currentUserId);
  }, [currentUserId]);

  const handleDeleteAll = useCallback(() => {
    Alert.alert('Clear All Notifications', 'Are you sure you want to delete all notifications?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear All', style: 'destructive', onPress: async () => {
        setNotifications([]);
        await supabase.from('notifications').delete().eq('user_id', currentUserId);
      }},
    ]);
  }, [currentUserId]);

  const unreadCount = notifications.filter(n => !n.is_read).length;

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { paddingTop: insets.top }]}>
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
        <ActivityIndicator size="large" color={COLORS.gold} />
        <Text style={styles.loadingText}>Loading notifications...</Text>
      </View>
    );
  }

  return (
    <View style={styles.fullScreen}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <View style={[styles.container, { paddingTop: insets.top }]}>

        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            Notifications{unreadCount > 0 ? <Text style={styles.unreadBadge}>  {unreadCount}</Text> : null}
          </Text>
          <View style={styles.headerActions}>
            {unreadCount > 0 && (
              <AnimatedButton onPress={handleMarkAllRead} style={styles.headerBtn}>
                <Text style={styles.headerBtnText}>Mark all read</Text>
              </AnimatedButton>
            )}
            {notifications.length > 0 && (
              <AnimatedButton onPress={handleDeleteAll} style={styles.headerBtn}>
                <Text style={[styles.headerBtnText, { color: COLORS.live }]}>Clear all</Text>
              </AnimatedButton>
            )}
          </View>
        </View>

        {notifications.length > 0 && (
          <View style={styles.hintBanner}>
            <Text style={styles.hintBannerText}>👈 Swipe left or right to delete · Long press for options</Text>
          </View>
        )}

        {notifications.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyIcon}>🔔</Text>
            <Text style={styles.emptyText}>No notifications yet</Text>
            <Text style={styles.emptySubtext}>When someone likes, follows, or comments — it'll show up here!</Text>
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={notifications}
            keyExtractor={(item) => item.id}
            renderItem={renderNotificationItem}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.gold} colors={[COLORS.gold]} />}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={true}
            maxToRenderPerBatch={10}
            windowSize={5}
            contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fullScreen:        { flex: 1, backgroundColor: '#ffffff' },
  container:         { flex: 1, backgroundColor: '#ffffff' },
  loadingContainer:  { flex: 1, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center', gap: 12 },
  centered:          { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  header:            { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: '#e5e5e5' },
  headerTitle:       { fontSize: 20, fontWeight: '800', color: '#111111' },
  unreadBadge:       { fontSize: 14, fontWeight: '700', color: COLORS.gold },
  headerActions:     { flexDirection: 'row', gap: 12 },
  headerBtn:         { paddingVertical: 10, paddingHorizontal: 8, minHeight: 36, justifyContent: 'center' },
  headerBtnText:     { fontSize: 13, color: '#888888', fontWeight: '600' },
  hintBanner:        { backgroundColor: '#f5f5f5', paddingVertical: 8, paddingHorizontal: 16, borderBottomWidth: 0.5, borderBottomColor: '#e5e5e5' },
  hintBannerText:    { fontSize: 12, color: '#aaaaaa', textAlign: 'center' },
  deleteBackground:  { ...StyleSheet.absoluteFillObject, backgroundColor: COLORS.live, justifyContent: 'center', alignItems: 'center' },
  deleteBackgroundText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  notificationRow:   { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, backgroundColor: '#ffffff' },
  unreadRow:         { backgroundColor: `${COLORS.gold}10` },
  unreadDot:         { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.gold, marginRight: 8 },
  iconContainer:     { width: 44, height: 44, borderRadius: 22, backgroundColor: '#f5f5f5', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  icon:              { fontSize: 20 },
  textContent:       { flex: 1 },
  message:           { fontSize: 14, color: '#888888', fontWeight: '500', lineHeight: 20 },
  unreadMessage:     { fontWeight: '700', color: '#111111' },
  time:              { fontSize: 12, color: '#aaaaaa', marginTop: 3 },
  swipeHint:         { marginLeft: 8 },
  swipeHintText:     { fontSize: 12, color: '#cccccc' },
  separator:         { height: 0.5, backgroundColor: '#e5e5e5', marginLeft: 72 },
  emptyIcon:         { fontSize: 52 },
  emptyText:         { fontSize: 17, fontWeight: '700', color: '#111111' },
  emptySubtext:      { fontSize: 14, color: '#888888', textAlign: 'center', paddingHorizontal: 40, lineHeight: 20 },
  loadingText:       { fontSize: 14, color: '#888888' },
});