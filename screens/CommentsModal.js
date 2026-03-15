// CommentsModal.js - TIKTOK-STYLE PULL TO CLOSE
import React, { useRef, useEffect, useCallback, useState } from 'react';
import {
  Modal,
  View,
  Animated,
  PanResponder,
  ScrollView,
  TextInput,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Dimensions,
  BackHandler,
  StyleSheet,
  Text,
  Image,
} from 'react-native';
import { supabase } from '../lib/supabase';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.68;
const DRAG_THRESHOLD = 80;

// ============================================
// HOOK: useComments
// ============================================
export const useComments = (videoId) => {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [replyingTo, setReplyingTo] = useState(null);
  const [page, setPage] = useState(0);

  const fetchComments = useCallback(async (pageNum = 0, isLoadMore = false) => {
    const { data, error } = await supabase
      .from('comments')
      .select('*, profiles:user_id(id, username, avatar_url), replies:replies(count)')
      .eq('video_id', videoId)
      .is('parent_id', null)
      .order('created_at', { ascending: false })
      .range(pageNum * 20, (pageNum + 1) * 20 - 1);

    if (error) return;

    if (isLoadMore) {
      setComments(prev => [...prev, ...(data || [])]);
    } else {
      setComments(data || []);
    }
    setHasMore((data || []).length === 20);
  }, [videoId]);

  useEffect(() => {
    if (videoId) {
      setLoading(true);
      fetchComments(0).finally(() => setLoading(false));
    }
  }, [videoId, fetchComments]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    fetchComments(nextPage, true).finally(() => {
      setPage(nextPage);
      setLoadingMore(false);
    });
  }, [loadingMore, hasMore, page, fetchComments]);

  const postComment = useCallback(async (content, parentId = null) => {
  setPosting(true);
  const { data: { user } } = await supabase.auth.getUser();
  
  // Try insert with just required fields
  const insertData = {
    video_id: videoId,
    user_id: user.id,
  };

  // Try 'content' first, if fails we'll know
  insertData.content = content;

  console.log('Inserting data:', insertData);

  const { data: newComment, error: insertError } = await supabase
    .from('comments')
    .insert(insertData)
    .select()
    .single();

  console.log('Insert error:', insertError);
  console.log('Insert data:', newComment);

  if (insertError) {
    setPosting(false);
    return false;
  }

  // Fetch profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, username, avatar_url')
    .eq('id', user.id)
    .single();

  const commentWithProfile = {
    ...newComment,
    profiles: profile || { id: user.id, username: 'Unknown', avatar_url: null }
  };

  if (parentId) {
    setComments(prev => prev.map(c => 
      c.id === parentId 
        ? { ...c, replies: [...(c.replies || []), commentWithProfile] }
        : c
    ));
  } else {
    setComments(prev => [commentWithProfile, ...prev]);
  }

  setPosting(false);
  return true;
}, [videoId]);

  const editComment = useCallback(async (commentId, newContent) => {
    const { error } = await supabase
      .from('comments')
      .update({ content: newContent, edited_at: new Date().toISOString() })
      .eq('id', commentId);
    
    if (!error) {
      setComments(prev => prev.map(c => 
        c.id === commentId ? { ...c, content: newContent } : c
      ));
    }
    return !error;
  }, []);

  const deleteComment = useCallback(async (commentId) => {
    const { error } = await supabase.from('comments').delete().eq('id', commentId);
    if (!error) {
      setComments(prev => prev.filter(c => c.id !== commentId));
    }
    return !error;
  }, []);

  const toggleLike = useCallback(async (commentId) => {
    const { data: { user } } = await supabase.auth.getUser();
    
    const { data: existing } = await supabase
      .from('comment_likes')
      .select('id')
      .eq('comment_id', commentId)
      .eq('user_id', user.id)
      .single();

    if (existing) {
      await supabase.from('comment_likes').delete().eq('id', existing.id);
    } else {
      await supabase.from('comment_likes').insert({ comment_id: commentId, user_id: user.id });
    }

    setComments(prev => prev.map(c => {
      if (c.id !== commentId) return c;
      const currentLikes = c.likes_count || 0;
      return {
        ...c,
        likes_count: existing ? currentLikes - 1 : currentLikes + 1,
        user_liked: !existing
      };
    }));
  }, []);

  const pinComment = useCallback(async (commentId) => {
    const { error } = await supabase
      .from('comments')
      .update({ is_pinned: true })
      .eq('id', commentId);
    
    if (!error) {
      setComments(prev => prev.map(c => ({ ...c, is_pinned: c.id === commentId })));
    }
    return !error;
  }, []);

  return {
    comments,
    loading,
    posting,
    loadingMore,
    hasMore,
    replyingTo,
    setReplyingTo,
    loadMore,
    postComment,
    editComment,
    deleteComment,
    toggleLike,
    pinComment,
  };
};

// ============================================
// SUB-COMPONENTS
// ============================================

const CommentHeader = ({ count, onClose }) => (
  <View style={styles.header}>
    <View style={styles.handleBar} />
    <View style={styles.headerContent}>
      <View style={styles.headerTitleRow}>
        <Text style={styles.headerTitle}>{count} Comments</Text>
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={styles.closeButton}>
            <Text style={styles.closeIcon}>✕</Text>
          </View>
        </TouchableWithoutFeedback>
      </View>
    </View>
  </View>
);

const CommentInput = ({ value, onChangeText, onSubmit, placeholder }) => (
  <View style={styles.inputContainer}>
    <TextInput
      style={styles.input}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="#999"
      multiline
      maxLength={1000}
    />
    <TouchableWithoutFeedback onPress={onSubmit} disabled={!value.trim()}>
      <View style={[styles.sendButton, !value.trim() && styles.sendButtonDisabled]}>
        <Text style={styles.sendIcon}>➤</Text>
      </View>
    </TouchableWithoutFeedback>
  </View>
);

const ReplyInput = ({ value, onChangeText, onSubmit, onCancel, replyingTo }) => (
  <View style={styles.replyInputWrapper}>
    <View style={styles.replyHeader}>
      <Text style={styles.replyingToText}>Replying to {replyingTo?.username}</Text>
      <TouchableWithoutFeedback onPress={onCancel}>
        <Text style={styles.cancelReply}>Cancel</Text>
      </TouchableWithoutFeedback>
    </View>
    <CommentInput
      value={value}
      onChangeText={onChangeText}
      onSubmit={onSubmit}
      placeholder="Write a reply..."
    />
  </View>
);

const CommentList = ({
  comments,
  onReply,
  onLike,
  onEdit,
  onDelete,
  onUserPress,
  onPin,
  currentUserId,
  isCreator,
  loadingMore,
  onLoadMore,
  hasMore,
  activeMenuId,
  setActiveMenuId,
  visibleReplies,
  onToggleReplies,
  justRepliedTo,
  scrollRef,
  onScroll,
  scrollEnabled,
  onScrollBeginDrag,
  onScrollEndDrag,
}) => {
  const renderComment = (comment, isReply = false) => (
    <View key={comment.id} style={[styles.commentItem, isReply && styles.replyItem]}>
      <TouchableWithoutFeedback onPress={() => onUserPress(comment.profiles)}>
        <View style={styles.avatar}>
          {comment.profiles?.avatar_url ? (
            <Image source={{ uri: comment.profiles.avatar_url }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarText}>
                {comment.profiles?.username?.[0]?.toUpperCase() || '?'}
              </Text>
            </View>
          )}
        </View>
      </TouchableWithoutFeedback>

      <View style={styles.commentContent}>
        <View style={styles.commentHeader}>
          <Text style={styles.username}>{comment.profiles?.username || 'Unknown'}</Text>
          {comment.is_pinned && <Text style={styles.pinnedBadge}>📌 Pinned</Text>}
          <Text style={styles.timestamp}>
            {new Date(comment.created_at).toLocaleDateString()}
          </Text>
        </View>

        <Text style={styles.commentText}>{comment.content}</Text>

        <View style={styles.commentActions}>
          <TouchableWithoutFeedback onPress={() => onLike(comment.id)}>
            <View style={styles.actionButton}>
              <Text style={[styles.actionIcon, comment.user_liked && styles.likedIcon]}>
                {comment.user_liked ? '♥' : '♡'}
              </Text>
              <Text style={styles.actionCount}>{comment.likes_count || 0}</Text>
            </View>
          </TouchableWithoutFeedback>

          {!isReply && (
            <TouchableWithoutFeedback onPress={() => onReply(comment)}>
              <View style={styles.actionButton}>
                <Text style={styles.actionIcon}>💬</Text>
                <Text style={styles.actionText}>Reply</Text>
              </View>
            </TouchableWithoutFeedback>
          )}

          <TouchableWithoutFeedback onPress={() => setActiveMenuId(activeMenuId === comment.id ? null : comment.id)}>
            <View style={styles.actionButton}>
              <Text style={styles.actionIcon}>⋮</Text>
            </View>
          </TouchableWithoutFeedback>
        </View>

        {activeMenuId === comment.id && (
          <View style={styles.menu}>
            {currentUserId === comment.user_id && (
              <>
                <TouchableWithoutFeedback onPress={() => { onEdit(comment); setActiveMenuId(null); }}>
                  <View style={styles.menuItem}><Text>Edit</Text></View>
                </TouchableWithoutFeedback>
                <TouchableWithoutFeedback onPress={() => { onDelete(comment.id); setActiveMenuId(null); }}>
                  <View style={[styles.menuItem, styles.menuItemDanger]}><Text style={styles.dangerText}>Delete</Text></View>
                </TouchableWithoutFeedback>
              </>
            )}
            {isCreator && !isReply && !comment.is_pinned && (
              <TouchableWithoutFeedback onPress={() => { onPin(comment.id); setActiveMenuId(null); }}>
                <View style={styles.menuItem}><Text>Pin</Text></View>
              </TouchableWithoutFeedback>
            )}
          </View>
        )}

        {!isReply && comment.replies?.length > 0 && (
          <>
            <TouchableWithoutFeedback onPress={() => onToggleReplies(comment.id)}>
              <View style={styles.repliesToggle}>
                <Text style={styles.repliesToggleText}>
                  {visibleReplies[comment.id] ? 'Hide' : 'View'} {comment.replies.length} replies
                </Text>
              </View>
            </TouchableWithoutFeedback>
            {visibleReplies[comment.id] && comment.replies.map(reply => renderComment(reply, true))}
          </>
        )}
      </View>
    </View>
  );

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      onScroll={onScroll}
      scrollEventThrottle={16}
      scrollEnabled={scrollEnabled}
      onScrollBeginDrag={onScrollBeginDrag}
      onScrollEndDrag={onScrollEndDrag}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="none"
      showsVerticalScrollIndicator={true}
    >
      {comments.map(comment => renderComment(comment))}
      {loadingMore && <View style={styles.loadingMore}><Text>Loading...</Text></View>}
      {hasMore && !loadingMore && comments.length > 0 && (
        <TouchableWithoutFeedback onPress={onLoadMore}>
          <View style={styles.loadMore}><Text style={styles.loadMoreText}>Load more</Text></View>
        </TouchableWithoutFeedback>
      )}
    </ScrollView>
  );
};

// ============================================
// MAIN COMPONENT: CommentsModal
// ============================================

const CommentsModal = ({ visible, onClose, videoId, navigation, isCreator }) => {
  const {
    comments,
    loading,
    posting,
    loadingMore,
    hasMore,
    replyingTo,
    setReplyingTo,
    loadMore,
    postComment,
    editComment,
    deleteComment,
    toggleLike,
    pinComment,
  } = useComments(videoId);

  const [currentUserId, setCurrentUserId] = useState(null);
  const [activeMenuId, setActiveMenuId] = useState(null);
  const [visibleReplies, setVisibleReplies] = useState({});
  const [justRepliedTo, setJustRepliedTo] = useState(null);
  
  const [inputValue, setInputValue] = useState('');
  const [editValue, setEditValue] = useState('');
  const [editingId, setEditingId] = useState(null);

  // Animation refs
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef(null);
  
  // TikTok-style gesture handling
  const dragY = useRef(new Animated.Value(0)).current;
  const scrollOffsetRef = useRef(0);
  const isDraggingRef = useRef(false);
  const panResponderRef = useRef(null);

  // Get current user
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data?.user?.id);
    });
  }, []);

  // Handle visibility changes
  useEffect(() => {
    if (visible) {
      // Reset position
      dragY.setValue(0);
      translateY.setValue(SCREEN_HEIGHT);
      
      // Open animation
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
          friction: 8,
          tension: 40,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 0.5,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, translateY, backdropOpacity, dragY]);

  // Android back button
  useEffect(() => {
    if (!visible) return;
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      handleClose();
      return true;
    });
    return () => backHandler.remove();
  }, [visible]);

  // Close handler with animation
  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: SCREEN_HEIGHT,
        useNativeDriver: true,
        friction: 8,
        tension: 40,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onClose();
      setReplyingTo(null);
      setEditingId(null);
      setInputValue('');
      setEditValue('');
      dragY.setValue(0);
      scrollOffsetRef.current = 0;
    });
  }, [onClose, translateY, backdropOpacity, setReplyingTo, dragY]);

  // TIKTOK-STYLE PAN RESPONDER - Works everywhere on sheet
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // Only respond to vertical drags
        const isVertical = Math.abs(gestureState.dy) > Math.abs(gestureState.dx);
        const isDraggingDown = gestureState.dy > 0;
        
        if (!isVertical) return false;
        
        // If dragging down and at top of scroll, capture gesture
        if (isDraggingDown && scrollOffsetRef.current <= 0) {
          return true;
        }
        
        // If dragging up, always let scroll view handle it
        if (!isDraggingDown) {
          return false;
        }
        
        return false;
      },
      
      onPanResponderGrant: () => {
        isDraggingRef.current = true;
        // Stop any momentum scrolling
        scrollRef.current?.scrollTo?.({ y: scrollOffsetRef.current, animated: false });
      },
      
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) {
          // Dragging down - move sheet with finger
          dragY.setValue(gestureState.dy);
          // Fade backdrop
          const progress = Math.min(gestureState.dy / SHEET_HEIGHT, 1);
          backdropOpacity.setValue(0.5 * (1 - progress));
        }
      },
      
      onPanResponderRelease: (_, gestureState) => {
        isDraggingRef.current = false;
        
        const draggedFar = gestureState.dy > DRAG_THRESHOLD;
        const fastSwipe = gestureState.vy > 0.5;
        
        if (draggedFar || fastSwipe) {
          // Close sheet
          handleClose();
        } else {
          // Snap back open
          Animated.parallel([
            Animated.spring(dragY, {
              toValue: 0,
              useNativeDriver: true,
              friction: 8,
              tension: 40,
            }),
            Animated.timing(backdropOpacity, {
              toValue: 0.5,
              duration: 200,
              useNativeDriver: true,
            }),
          ]).start();
        }
      },
      
      onPanResponderTerminate: () => {
        isDraggingRef.current = false;
        // Snap back if terminated unexpectedly
        Animated.spring(dragY, {
          toValue: 0,
          useNativeDriver: true,
          friction: 8,
          tension: 40,
        }).start();
      },
    })
  ).current;

  // Combined animation for sheet position
  const sheetTranslateY = Animated.add(translateY, dragY);

  const onScroll = useCallback((event) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const onScrollBeginDrag = useCallback(() => {
    // When user starts scrolling, we track it
  }, []);

  const onScrollEndDrag = useCallback((event) => {
    // Update final scroll position
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const handleReply = useCallback((comment) => {
    setReplyingTo({ id: comment.id, username: comment.profiles?.username });
  }, [setReplyingTo]);

  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
  }, [setReplyingTo]);

  const handleSubmit = useCallback(async () => {
  const value = editingId ? editValue : inputValue;
  console.log('Submit pressed, value:', value);
  if (!value.trim()) {
    console.log('Empty value, returning');
    return;
  }

  Keyboard.dismiss();
  console.log('Keyboard dismissed');
  
  if (editingId) {
    console.log('Editing comment:', editingId);
    await editComment(editingId, value.trim());
    setEditingId(null);
    setEditValue('');
  } else {
    console.log('Posting new comment, replyingTo:', replyingTo);
    const success = await postComment(value.trim(), replyingTo?.id);
    console.log('Post result:', success);
    if (success && replyingTo) {
      setJustRepliedTo(replyingTo.id);
      setTimeout(() => setJustRepliedTo(null), 3000);
    }
    setInputValue('');
    setReplyingTo(null);
  }
}, [inputValue, editValue, editingId, replyingTo, postComment, editComment, setReplyingTo]);

  const handleEdit = useCallback((comment) => {
    setEditingId(comment.id);
    setEditValue(comment.content);
  }, []);

  const handleDelete = useCallback(async (commentId) => {
    await deleteComment(commentId);
  }, [deleteComment]);

  const handleToggleReplies = useCallback((commentId) => {
    setVisibleReplies(prev => ({ ...prev, [commentId]: !prev[commentId] }));
  }, []);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={handleClose}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} />
      </TouchableWithoutFeedback>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardAvoid}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        <Animated.View
          style={[
            styles.sheet,
            { transform: [{ translateY: sheetTranslateY }] }
          ]}
          {...panResponder.panHandlers}
        >
          {/* Header with drag handle - part of draggable area */}
          <CommentHeader count={comments.length} onClose={handleClose} />

          {/* Scrollable Content - also draggable when at top */}
          <View style={styles.content}>
            <CommentList
              comments={comments}
              onReply={handleReply}
              onLike={toggleLike}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onUserPress={(profile) => navigation?.navigate('Profile', { userId: profile.id })}
              onPin={pinComment}
              currentUserId={currentUserId}
              isCreator={isCreator}
              loadingMore={loadingMore}
              onLoadMore={loadMore}
              hasMore={hasMore}
              activeMenuId={activeMenuId}
              setActiveMenuId={setActiveMenuId}
              visibleReplies={visibleReplies}
              onToggleReplies={handleToggleReplies}
              justRepliedTo={justRepliedTo}
              scrollRef={scrollRef}
              onScroll={onScroll}
              scrollEnabled={!isDraggingRef.current}
              onScrollBeginDrag={onScrollBeginDrag}
              onScrollEndDrag={onScrollEndDrag}
            />
          </View>

          {/* Input Area - NOT draggable so typing works */}
          <View style={styles.inputWrapper} pointerEvents="box-none">
            <View style={styles.inputContainerBg} pointerEvents="auto">
              {replyingTo && !editingId ? (
                <ReplyInput
                  value={inputValue}
                  onChangeText={setInputValue}
                  onSubmit={handleSubmit}
                  onCancel={handleCancelReply}
                  replyingTo={replyingTo}
                />
              ) : editingId ? (
                <View style={styles.editWrapper}>
                  <View style={styles.editHeader}>
                    <Text style={styles.editTitle}>Edit comment</Text>
                    <TouchableWithoutFeedback onPress={() => { setEditingId(null); setEditValue(''); }}>
                      <Text style={styles.cancelEdit}>Cancel</Text>
                    </TouchableWithoutFeedback>
                  </View>
                  <CommentInput
                    value={editValue}
                    onChangeText={setEditValue}
                    onSubmit={handleSubmit}
                    placeholder="Edit your comment..."
                  />
                </View>
              ) : (
                <CommentInput
                  value={inputValue}
                  onChangeText={setInputValue}
                  onSubmit={handleSubmit}
                  placeholder="Add a comment..."
                />
              )}
            </View>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  keyboardAvoid: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    height: SHEET_HEIGHT,
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
    ...Platform.select({
      android: { elevation: 24 },
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
    }),
  },
  header: {
    paddingTop: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    backgroundColor: '#fff',
  },
  handleBar: {
    width: 40,
    height: 4,
    backgroundColor: '#ddd',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 8,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000',
  },
  closeButton: {
    padding: 4,
  },
  closeIcon: {
    fontSize: 20,
    color: '#666',
  },
  content: {
    flex: 1,
    backgroundColor: '#fff',
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    paddingBottom: 100, // Space for input
  },
  commentItem: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  replyItem: {
    marginLeft: 40,
    marginTop: 8,
  },
  avatar: {
    marginRight: 12,
  },
  avatarImage: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#e0e0e0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  commentContent: {
    flex: 1,
  },
  commentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    flexWrap: 'wrap',
  },
  username: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000',
    marginRight: 8,
  },
  pinnedBadge: {
    fontSize: 11,
    color: '#666',
    marginRight: 8,
  },
  timestamp: {
    fontSize: 12,
    color: '#999',
  },
  commentText: {
    fontSize: 14,
    color: '#333',
    lineHeight: 20,
    marginBottom: 8,
  },
  commentActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 16,
    paddingVertical: 4,
  },
  actionIcon: {
    fontSize: 14,
    marginRight: 4,
    color: '#666',
  },
  likedIcon: {
    color: '#ff3040',
  },
  actionCount: {
    fontSize: 12,
    color: '#666',
  },
  actionText: {
    fontSize: 12,
    color: '#666',
  },
  menu: {
    position: 'absolute',
    right: 0,
    top: 30,
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
    minWidth: 120,
    zIndex: 100,
  },
  menuItem: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  menuItemDanger: {
    borderTopWidth: 1,
    borderTopColor: '#eee',
    marginTop: 4,
    paddingTop: 8,
  },
  dangerText: {
    color: '#ff3040',
  },
  repliesToggle: {
    marginTop: 8,
    marginBottom: 8,
  },
  repliesToggleText: {
    fontSize: 13,
    color: '#666',
    fontWeight: '500',
  },
  loadingMore: {
    padding: 16,
    alignItems: 'center',
  },
  loadMore: {
    padding: 16,
    alignItems: 'center',
  },
  loadMoreText: {
    color: '#666',
    fontSize: 14,
  },
  inputWrapper: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  inputContainerBg: {
    borderTopWidth: 1,
    borderTopColor: '#eee',
    backgroundColor: '#fff',
    padding: 12,
    paddingBottom: Platform.OS === 'ios' ? 24 : 12,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: '#f5f5f5',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxHeight: 100,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: '#000',
    maxHeight: 80,
    paddingTop: 4,
    paddingBottom: 4,
  },
  sendButton: {
    marginLeft: 8,
    padding: 4,
  },
  sendButtonDisabled: {
    opacity: 0.3,
  },
  sendIcon: {
    fontSize: 18,
    color: '#0095f6',
  },
  replyInputWrapper: {
    backgroundColor: '#fff',
  },
  replyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  replyingToText: {
    fontSize: 13,
    color: '#666',
  },
  cancelReply: {
    fontSize: 13,
    color: '#0095f6',
    fontWeight: '500',
  },
  editWrapper: {
    backgroundColor: '#fff',
  },
  editHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  editTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000',
  },
  cancelEdit: {
    fontSize: 13,
    color: '#0095f6',
  },
});

export default CommentsModal;