import React, { useState, useRef } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  Alert, 
  TextInput,
  Animated,
  Vibration,
  Platform
} from 'react-native';
import UserAvatar from '../common/UserAvatar';
import { TouchableOpacity } from 'react-native-gesture-handler';
import { COLORS } from '../../constants/theme';

export default function CommentItem({ 
  comment, 
  onReply, 
  onLike, 
  onEdit, 
  onDelete,
  onUserPress,
  onPin,
  currentUserId,
  isReply = false,
  isCreator = false,
  activeMenuId,
  setActiveMenuId
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(comment.text);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const isOwner = comment.user_id === currentUserId;
  const isMenuOpen = activeMenuId === comment.id;

  const formatTime = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return 'Just now';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}-${day}`;
  };

  const formatLikesCount = (count) => {
    if (!count || count === 0) return '';
    if (count < 1000) return count.toString();
    if (count < 1000000) return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return (count / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  };

  const animateHeart = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 1.3, duration: 100, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1, duration: 100, useNativeDriver: true }),
    ]).start();
  };

  const handleLike = () => {
    animateHeart();
    if (Platform.OS === 'ios') Vibration.vibrate(10);
    if (onLike) onLike(comment.id, comment.isLiked);
  };

  const handleEdit = () => {
    if (editText.trim() && editText !== comment.text) {
      if (onEdit) onEdit(comment.id, editText);
    }
    setIsEditing(false);
    setActiveMenuId(null);
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Comment',
      'Are you sure you want to delete this comment?',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => setActiveMenuId(null) },
        { 
          text: 'Delete', 
          style: 'destructive',
          onPress: () => { 
            if (onDelete) onDelete(comment.id); 
            setActiveMenuId(null);
          }
        }
      ]
    );
  };

  const handleReply = () => {
    setActiveMenuId(null);
    if (onReply) onReply(comment);
  };

  const handleUserPress = () => {
    setActiveMenuId(null);
    if (onUserPress) onUserPress(comment.user_id);
  };

  const toggleMenu = () => {
    if (isMenuOpen) {
      setActiveMenuId(null);
    } else {
      setActiveMenuId(comment.id);
    }
  };

  const handleLongPress = () => {
    setActiveMenuId(comment.id);
  };

  const handleMenuAction = (action) => {
    switch(action) {
      case 'edit':
        setIsEditing(true);
        break;
      case 'delete':
        handleDelete();
        return;
      case 'pin':
        if (onPin) onPin(comment.id, !comment.is_pinned);
        break;
      case 'report':
        Alert.alert('Report', 'Comment reported');
        break;
      case 'copy':
        Alert.alert('Copied', 'Text copied to clipboard');
        break;
    }
    setActiveMenuId(null);
  };

  return (
    <View style={[styles.container, isReply && styles.replyContainer]}>
      {comment.is_pinned && !isReply && (
        <View style={styles.pinnedBadge}>
          <Text style={styles.pinnedText}>📌 Pinned</Text>
        </View>
      )}

      <View style={styles.mainRow}>
        <TouchableOpacity onPress={handleUserPress} activeOpacity={0.8}>
          <UserAvatar 
            uri={comment.user?.avatar_url} 
            size={isReply ? 32 : 40}
            username={comment.user?.username}
          />
        </TouchableOpacity>

        <View style={styles.content}>
          <TouchableOpacity onPress={handleUserPress}>
            <View style={styles.header}>
              <Text style={styles.username}>{comment.user?.username || 'User'}</Text>
              <Text style={styles.time}>{formatTime(comment.created_at)}</Text>
              {comment.edited_at && <Text style={styles.edited}> (edited)</Text>}
            </View>
          </TouchableOpacity>

          {isEditing ? (
            <View style={styles.editContainer}>
              <TextInput
                style={styles.editInput}
                value={editText}
                onChangeText={setEditText}
                multiline
                autoFocus
                placeholder="Edit your comment..."
              />
              <View style={styles.editButtons}>
                <TouchableOpacity onPress={() => { setIsEditing(false); setActiveMenuId(null); }}>
                  <Text style={styles.cancelBtn}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleEdit}>
                  <Text style={styles.saveBtn}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity 
              onLongPress={handleLongPress}
              delayLongPress={400}
              activeOpacity={0.9}
            >
              <Text style={styles.text}>{comment.text}</Text>
            </TouchableOpacity>
          )}

          <View style={styles.actionsRow}>
            <View style={styles.leftActions}>
            {!isReply && (
              <TouchableOpacity style={styles.actionBtn} onPress={handleReply}>
                <Text style={styles.actionText}>Reply</Text>
              </TouchableOpacity>
            )}
            
              {!isEditing && (
                <TouchableOpacity style={styles.actionBtn} onPress={toggleMenu}>
                  <Text style={[styles.actionText, isMenuOpen && styles.actionTextActive]}>•••</Text>
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity 
              style={styles.likeBtn} 
              onPress={handleLike}
              activeOpacity={0.7}
            >
              <Animated.Text style={[styles.heartIcon, { transform: [{ scale: scaleAnim }] }, comment.isLiked && styles.heartIconActive]}>
                {comment.isLiked ? '❤️' : '🤍'}
              </Animated.Text>
              <Text style={styles.likeCount}>
                {formatLikesCount(comment.likesCount || comment.likes_count)}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Menu Overlay */}
          {isMenuOpen && (
            <View style={styles.menuOverlay}>
              {isOwner && (
                <>
                  <TouchableOpacity 
                    style={styles.menuItem} 
                    onPress={() => handleMenuAction('edit')}
                  >
                    <Text style={styles.menuText}>✏️ Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.menuItem} 
                    onPress={() => handleMenuAction('delete')}
                  >
                    <Text style={[styles.menuText, styles.deleteText]}>🗑️ Delete</Text>
                  </TouchableOpacity>
                </>
              )}
              {isCreator && !isReply && (
                <TouchableOpacity 
                  style={styles.menuItem}
                  onPress={() => handleMenuAction('pin')}
                >
                  <Text style={styles.menuText}>
                    {comment.is_pinned ? '📌 Unpin' : '📌 Pin'}
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity 
                style={styles.menuItem}
                onPress={() => handleMenuAction('report')}
              >
                <Text style={styles.menuText}>🚩 Report</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.menuItem}
                onPress={() => handleMenuAction('copy')}
              >
                <Text style={styles.menuText}>📋 Copy</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff' },
  replyContainer: { paddingLeft: 72, paddingVertical: 8, backgroundColor: '#fafafa' },
  pinnedBadge: { marginBottom: 8 },
  pinnedText: { fontSize: 12, color: COLORS.gold, fontWeight: '600' },
  mainRow: { flexDirection: 'row' },
  content: { flex: 1, marginLeft: 12 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' },
  username: { fontSize: 14, fontWeight: '700', color: '#000', marginRight: 6 },
  time: { fontSize: 12, color: '#999' },
  edited: { fontSize: 11, color: '#999', marginLeft: 4 },
  text: { fontSize: 15, color: '#000', lineHeight: 22, marginBottom: 8 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  leftActions: { flexDirection: 'row', alignItems: 'center' },
  actionBtn: { marginRight: 16, paddingVertical: 4 },
  actionText: { fontSize: 13, color: '#666', fontWeight: '600' },
  actionTextActive: { color: COLORS.gold },
  likeBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingHorizontal: 8 },
  heartIcon: { fontSize: 16, marginRight: 4 },
  heartIconActive: { color: COLORS.live },
  likeCount: { fontSize: 13, color: '#666', fontWeight: '600', minWidth: 20 },
  editContainer: { marginBottom: 8 },
  editInput: { backgroundColor: '#f5f5f5', borderRadius: 12, padding: 12, fontSize: 15, color: '#000', minHeight: 44, borderWidth: 1, borderColor: '#e0e0e0' },
  editButtons: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8, gap: 16 },
  cancelBtn: { color: '#666', fontSize: 14, fontWeight: '600' },
  saveBtn: { color: COLORS.gold, fontSize: 14, fontWeight: '700' },
  menuOverlay: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, gap: 8, backgroundColor: '#f8f8f8', padding: 8, borderRadius: 12 },
  menuItem: { paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: '#e0e0e0' },
  menuText: { fontSize: 12, color: '#333', fontWeight: '500' },
  deleteText: { color: COLORS.live },
});