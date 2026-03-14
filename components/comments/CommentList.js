import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import CommentItem from './CommentItem';
import { COLORS } from '../../constants/theme';

export default function CommentList({
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
  visibleReplies = {},
  onToggleReplies,
  justRepliedTo,
}) {
  // Separate top-level comments from replies
  const organizeComments = (flatComments) => {
    const parents = [];
    const repliesMap = {};

    flatComments.forEach(comment => {
      if (comment.parent_id) {
        if (!repliesMap[comment.parent_id]) {
          repliesMap[comment.parent_id] = [];
        }
        repliesMap[comment.parent_id].push(comment);
      } else {
        parents.push(comment);
      }
    });

    return { parents, repliesMap };
  };

  const { parents, repliesMap } = organizeComments(comments);

  if (!comments || comments.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No comments yet</Text>
        <Text style={styles.emptySubtext}>Be the first to comment!</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {parents.map((comment) => {
        const replies = repliesMap[comment.id] || [];

        // Determine which replies to show:
        // - If user toggled open (visibleReplies): show ALL replies
        // - If user just replied (justRepliedTo): show ONLY their new reply
        // - Otherwise: show nothing
        const isToggleOpen = !!visibleReplies[comment.id];
        const isJustReplied = justRepliedTo === comment.id;

        let repliesToShow = [];
        if (isToggleOpen) {
          // Show all replies
          repliesToShow = replies;
        } else if (isJustReplied) {
          // Show only the current user's most recent reply to this comment
          repliesToShow = replies.filter(r => r.user_id === currentUserId).slice(-1);
        }

        return (
          <View key={comment.id?.toString() || Math.random().toString()}>
            {/* Parent comment */}
            <CommentItem
              comment={comment}
              onReply={onReply}
              onLike={onLike}
              onEdit={onEdit}
              onDelete={onDelete}
              onUserPress={onUserPress}
              onPin={onPin}
              currentUserId={currentUserId}
              isCreator={isCreator}
              activeMenuId={activeMenuId}
              setActiveMenuId={setActiveMenuId}
            />

            {/* "View X replies" / "Hide replies" toggle */}
            {replies.length > 0 && (
              <TouchableOpacity
                style={styles.repliesToggle}
                onPress={() => onToggleReplies && onToggleReplies(comment.id)}
              >
                <Text style={styles.repliesToggleText}>
                  {isToggleOpen
                    ? 'Hide replies'
                    : `View ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
                </Text>
              </TouchableOpacity>
            )}

            {/* Replies — shown based on toggle or just-replied logic */}
            {repliesToShow.map(reply => (
              <CommentItem
                key={reply.id?.toString() || Math.random().toString()}
                comment={reply}
                onLike={onLike}
                onEdit={onEdit}
                onDelete={onDelete}
                onUserPress={onUserPress}
                currentUserId={currentUserId}
                isReply={true}
                activeMenuId={activeMenuId}
                setActiveMenuId={setActiveMenuId}
              />
            ))}
          </View>
        );
      })}

      {/* Load more indicator */}
      {loadingMore && (
        <View style={styles.loadingMore}>
          <ActivityIndicator size="small" color={COLORS.gold} />
          <Text style={styles.loadingText}>Loading more...</Text>
        </View>
      )}

      {!hasMore && comments.length > 0 && (
        <View style={styles.endMessage}>
          <Text style={styles.endText}>No more comments</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyContainer: { paddingVertical: 100, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 16, fontWeight: '600', color: '#666' },
  emptySubtext: { fontSize: 14, color: '#999', marginTop: 8 },
  repliesToggle: { paddingLeft: 72, paddingVertical: 8, marginTop: -4 },
  repliesToggleText: { fontSize: 13, color: COLORS.gold, fontWeight: '600' },
  loadingMore: { paddingVertical: 20, alignItems: 'center' },
  loadingText: { fontSize: 12, color: '#999', marginTop: 8 },
  endMessage: { alignItems: 'center', paddingVertical: 20 },
  endText: { fontSize: 12, color: '#999' },
});