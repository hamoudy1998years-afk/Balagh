import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

export function useComments(videoId) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  const [replyingTo, setReplyingTo] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0); // ADDED: refresh trigger state
  const PAGE_SIZE = 20;
  const realtimeSubscription = useRef(null);

  const getCurrentUser = async () => {
    const { data } = await supabase.auth.getUser();
    return data.user;
  };

  // Fetch comments with pagination
  const fetchComments = useCallback(async (pageNum = 0, isRefresh = false) => {
    if (!videoId) return;

    try {
      const { data: commentsData, error: commentsError } = await supabase
        .from('comments')
        .select(`
          *,
          comment_likes(user_id)
        `)
        .eq('video_id', videoId)
        .eq('is_deleted', false)
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .range(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE - 1);

      if (commentsError) throw commentsError;

      const hasMoreData = commentsData.length === PAGE_SIZE;
      setHasMore(hasMoreData);

      if (commentsData.length > 0) {
        const userIds = [...new Set(commentsData.map(c => c.user_id))];

        const { data: profilesData, error: profilesError } = await supabase
          .from('profiles')
          .select('id, username, avatar_url')
          .in('id', userIds);

        if (profilesError) throw profilesError;

        const currentUser = await getCurrentUser();

        const commentsWithUsers = commentsData.map(comment => ({
          ...comment,
          user: profilesData?.find(p => p.id === comment.user_id) || { 
            username: 'Unknown', 
            avatar_url: null 
          },
          isLiked: comment.comment_likes?.some(like => like.user_id === currentUser?.id),
          likesCount: comment.comment_likes?.length || 0,
          repliesCount: 0 // Will be updated separately
        }));

        if (isRefresh || pageNum === 0) {
          setComments(commentsWithUsers);
        } else {
          setComments(prev => [...prev, ...commentsWithUsers]);
        }
      } else if (isRefresh || pageNum === 0) {
        setComments([]);
      }
    } catch (error) {
      console.error('Error fetching comments:', error);
    }
  }, [videoId, refreshTrigger]); // ADDED: refreshTrigger to dependencies

  // Load initial comments
  const loadComments = useCallback(async () => {
    setLoading(true);
    setPage(0);
    await fetchComments(0, true);
    setLoading(false);
  }, [fetchComments]);

  // Load more (pagination)
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    await fetchComments(nextPage);
    setPage(nextPage);
    setLoadingMore(false);
  }, [fetchComments, page, hasMore, loadingMore]);

  // Post new comment
  const postComment = useCallback(async (content, parentId = null) => {
    if (!content.trim()) return;
    setPosting(true);
    try {
      const user = await getCurrentUser();
      if (!user) throw new Error('Not authenticated');

      const { data: newComment, error: insertError } = await supabase
        .from('comments')
        .insert([{
          video_id: videoId,
          user_id: user.id,
          text: content.trim(),
          parent_id: parentId,
          created_at: new Date().toISOString(),
        }])
        .select('*')
        .single();

      if (insertError) throw insertError;

      const { data: userProfile } = await supabase
        .from('profiles')
        .select('id, username, avatar_url')
        .eq('id', user.id)
        .single();

      const commentWithUser = {
        ...newComment,
        user: userProfile || { username: 'Unknown', avatar_url: null },
        isLiked: false,
        likesCount: 0,
        comment_likes: []
      };

      setComments(prev => [commentWithUser, ...prev]);
      setReplyingTo(null);
      return commentWithUser;
    } catch (error) {
      console.error('Error posting comment:', error);
      alert('Failed to post comment');
    } finally {
      setPosting(false);
    }
  }, [videoId]);

  // Edit comment
  const editComment = useCallback(async (commentId, newText) => {
    try {
      const { data, error } = await supabase
        .from('comments')
        .update({ 
          text: newText.trim(),
          edited_at: new Date().toISOString()
        })
        .eq('id', commentId)
        .select('*')
        .single();

      if (error) throw error;

      setComments(prev => prev.map(c => 
        c.id === commentId ? { ...c, ...data } : c
      ));
      return data;
    } catch (error) {
      console.error('Error editing comment:', error);
      alert('Failed to edit comment');
    }
  }, []);

  // Delete comment (soft delete)
  const deleteComment = useCallback(async (commentId) => {
    try {
      const { error } = await supabase
        .from('comments')
        .update({ is_deleted: true })
        .eq('id', commentId);

      if (error) throw error;

      setComments(prev => prev.filter(c => c.id !== commentId));
    } catch (error) {
      console.error('Error deleting comment:', error);
      alert('Failed to delete comment');
    }
  }, []);

  // Toggle like on comment
  const toggleLike = useCallback(async (commentId, isCurrentlyLiked) => {
    try {
      const user = await getCurrentUser();
      if (!user) {
        alert('Please sign in to like comments');
        return;
      }

      // Optimistic update
      setComments(prev => prev.map(c => {
        if (c.id === commentId) {
          return {
            ...c,
            isLiked: !isCurrentlyLiked,
            likesCount: isCurrentlyLiked ? Math.max(0, c.likesCount - 1) : c.likesCount + 1
          };
        }
        return c;
      }));

      if (isCurrentlyLiked) {
        await supabase
          .from('comment_likes')
          .delete()
          .eq('comment_id', commentId)
          .eq('user_id', user.id);
      } else {
        await supabase
          .from('comment_likes')
          .insert({ comment_id: commentId, user_id: user.id });
      }
    } catch (error) {
      console.error('Error toggling like:', error);
      // Revert on error
      setComments(prev => prev.map(c => {
        if (c.id === commentId) {
          return {
            ...c,
            isLiked: isCurrentlyLiked,
            likesCount: isCurrentlyLiked ? c.likesCount + 1 : Math.max(0, c.likesCount - 1)
          };
        }
        return c;
      }));
    }
  }, []);

  // Pin/unpin comment (creator only)
  const pinComment = useCallback(async (commentId, shouldPin) => {
    try {
      // Unpin all others first
      if (shouldPin) {
        await supabase
          .from('comments')
          .update({ is_pinned: false })
          .eq('video_id', videoId);
      }

      const { error } = await supabase
        .from('comments')
        .update({ is_pinned: shouldPin })
        .eq('id', commentId);

      if (error) throw error;

      setComments(prev => prev.map(c => ({
        ...c,
        is_pinned: c.id === commentId ? shouldPin : false
      })).sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0)));
    } catch (error) {
      console.error('Error pinning comment:', error);
    }
  }, [videoId]);

  // ADDED: Manual refresh function
  const refresh = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
  }, []);

  // Setup realtime subscription
  useEffect(() => {
    if (!videoId) return;

    loadComments();

    // Subscribe to realtime changes
    realtimeSubscription.current = supabase
      .channel(`comments:${videoId}`)
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'comments', filter: `video_id=eq.${videoId}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            // New comment added
            fetchComments(0, true);
          } else if (payload.eventType === 'UPDATE') {
            // Comment updated
            setComments(prev => prev.map(c => 
              c.id === payload.new.id ? { ...c, ...payload.new } : c
            ));
          } else if (payload.eventType === 'DELETE') {
            // Comment deleted
            setComments(prev => prev.filter(c => c.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    return () => {
      if (realtimeSubscription.current) {
        supabase.removeChannel(realtimeSubscription.current);
      }
    };
  }, [videoId, loadComments, fetchComments]);

  return {
    comments,
    loading,
    posting,
    loadingMore,
    hasMore,
    replyingTo,
    setReplyingTo,
    loadComments,
    loadMore,
    postComment,
    editComment,
    deleteComment,
    toggleLike,
    pinComment,
    refresh, // ADDED: export refresh function
  };
}