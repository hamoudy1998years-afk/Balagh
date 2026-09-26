import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useUser } from '../context/UserContext';

export function useComments(videoId) {
  const { user: authUser } = useUser();

  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [posting, setPosting] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  const [replyingTo, setReplyingTo] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const PAGE_SIZE = 20;
  const realtimeSubscription = useRef(null);

  // The realtime subscription below is established once per videoId and is
  // not re-created when authUser changes, so the handler reads the current
  // user through this ref instead of a stale closure.
  const authUserRef = useRef(authUser);
  authUserRef.current = authUser;

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
        .range(
          pageNum * PAGE_SIZE,
          (pageNum + 1) * PAGE_SIZE - 1
        );

      if (commentsError) throw commentsError;

      const hasMoreData = commentsData.length === PAGE_SIZE;
      setHasMore(hasMoreData);

      if (commentsData.length > 0) {
        const userIds = [
          ...new Set(
            commentsData.map(c => c.user_id)
          ),
        ];

        const {
          data: profilesData,
          error: profilesError,
        } = await supabase
          .from('profiles')
          .select('id, username, avatar_url')
          .in('id', userIds);

        if (profilesError) throw profilesError;

        const currentUser = authUser;

        const commentsWithUsers = commentsData.map(comment => ({
          ...comment,
          user:
            profilesData?.find(
              p => p.id === comment.user_id
            ) || {
              username: 'Unknown',
              avatar_url: null,
            },

          isLiked:
            comment.comment_likes?.some(
              like =>
                like.user_id === currentUser?.id
            ),

          likesCount:
            comment.comment_likes?.length || 0,

          repliesCount: 0,
        }));

        if (isRefresh || pageNum === 0) {
          setComments(commentsWithUsers);
        } else {
          setComments(prev => [
            ...prev,
            ...commentsWithUsers,
          ]);
        }
      } else if (isRefresh || pageNum === 0) {
        setComments([]);
      }

      setError(null);
    } catch (error) {
      __DEV__ &&
        console.error(
          'Error fetching comments:',
          error
        );

      setError(
        'Failed to load comments. Pull down to retry.'
      );
    }
  }, [videoId, refreshTrigger, authUser]);

  // Load initial comments
  const loadComments = useCallback(async () => {
    setLoading(true);
    setPage(0);

    await fetchComments(0, true);

    setLoading(false);
  }, [fetchComments]);

  // Load more
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;

    setLoadingMore(true);

    const nextPage = page + 1;

    await fetchComments(nextPage);

    setPage(nextPage);
    setLoadingMore(false);
  }, [
    fetchComments,
    page,
    hasMore,
    loadingMore,
  ]);

  // Post new comment
  const postComment = useCallback(async (
    content,
    parentId = null
  ) => {
    if (!content.trim()) return;

    setPosting(true);

    const user = authUser;

    // Collision-safe local id for the optimistic comment. Replaced by the
    // authoritative server id once the INSERT resolves.
    const tempId = `temp-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    try {
      if (!user) {
        throw new Error(
          'Not authenticated'
        );
      }

      // Current-user display data is already available from authUser — no
      // profiles query is needed before showing the comment.
      const currentUserInfo = {
        id: user.id,
        username:
          user.username ??
          user.user_metadata?.username ??
          'Unknown',
        avatar_url:
          user.avatar_url ??
          user.user_metadata?.avatar_url ??
          null,
      };

      const tempComment = {
        id: tempId,
        video_id: videoId,
        user_id: user.id,
        text: content.trim(),
        parent_id: parentId,
        created_at:
          new Date().toISOString(),
        user: currentUserInfo,
        isLiked: false,
        likesCount: 0,
        repliesCount: 0,
        comment_likes: [],
        _pending: true,
      };

      // Optimistic insert: the comment (and the header count, which is
      // comments.length) updates immediately, before any network round trip.
      setComments(prev => [
        tempComment,
        ...prev,
      ]);

      const {
        data: newComment,
        error: insertError,
      } = await supabase
        .from('comments')
        .insert([
          {
            video_id: videoId,
            user_id: user.id,
            text: content.trim(),
            parent_id: parentId,
            created_at:
              new Date().toISOString(),
          },
        ])
        .select('*')
        .single();

      if (insertError) {
        throw insertError;
      }

      // Reconcile: replace the temp comment by tempId AND drop any copy of
      // the same real id that realtime may already have inserted (realtime
      // can fire before this promise resolves). Exactly one copy remains.
      setComments(prev => [
        {
          ...newComment,
          user: currentUserInfo,
          isLiked: false,
          likesCount: 0,
          repliesCount: 0,
          comment_likes: [],
        },
        ...prev.filter(
          c =>
            c.id !== tempId &&
            c.id !== newComment.id
        ),
      ]);

      setReplyingTo(null);

      return newComment;
    } catch (error) {
      __DEV__ &&
        console.error(
          'Error posting comment:',
          error
        );

      // Roll back ONLY the optimistic comment — no ghost, count restored.
      setComments(prev =>
        prev.filter(c => c.id !== tempId)
      );

      alert('Failed to post comment');
    } finally {
      setPosting(false);
    }
  }, [videoId, authUser]);

  // Edit comment
  const editComment = useCallback(async (
    commentId,
    newText
  ) => {
    try {
      const { data, error } =
        await supabase
          .from('comments')
          .update({
            text: newText.trim(),
            edited_at:
              new Date().toISOString(),
          })
          .eq('id', commentId)
          .select('*')
          .single();

      if (error) throw error;

      setComments(prev =>
        prev.map(c =>
          c.id === commentId
            ? {
                ...c,
                ...data,
              }
            : c
        )
      );

      return data;
    } catch (error) {
      __DEV__ &&
        console.error(
          'Error editing comment:',
          error
        );

      alert('Failed to edit comment');
    }
  }, []);

  // Delete comment
  const deleteComment = useCallback(async (
    commentId
  ) => {
    try {
      const { error } =
        await supabase
          .from('comments')
          .update({
            is_deleted: true,
          })
          .eq('id', commentId);

      if (error) throw error;

      setComments(prev =>
        prev.filter(
          c => c.id !== commentId
        )
      );
    } catch (error) {
      __DEV__ &&
        console.error(
          'Error deleting comment:',
          error
        );

      alert('Failed to delete comment');
    }
  }, []);

  // Toggle like
  const toggleLike = useCallback(async (
    commentId,
    isCurrentlyLiked
  ) => {
    try {
      const user = authUser;

      if (!user) {
        alert(
          'Please sign in to like comments'
        );

        return;
      }

      setComments(prev =>
        prev.map(c => {
          if (c.id === commentId) {
            return {
              ...c,

              isLiked:
                !isCurrentlyLiked,

              likesCount:
                isCurrentlyLiked
                  ? Math.max(
                      0,
                      c.likesCount - 1
                    )
                  : c.likesCount + 1,
            };
          }

          return c;
        })
      );

      if (isCurrentlyLiked) {
        const { error } =
          await supabase
            .from('comment_likes')
            .delete()
            .eq(
              'comment_id',
              commentId
            )
            .eq(
              'user_id',
              user.id
            );

        if (error) throw error;
      } else {
        const { error } =
          await supabase
            .from('comment_likes')
            .insert({
              comment_id:
                commentId,

              user_id:
                user.id,
            });

        if (error) throw error;
      }
    } catch (error) {
      __DEV__ &&
        console.error(
          'Error toggling like:',
          error
        );

      // Revert optimistic update
      setComments(prev =>
        prev.map(c => {
          if (c.id === commentId) {
            return {
              ...c,

              isLiked:
                isCurrentlyLiked,

              likesCount:
                isCurrentlyLiked
                  ? c.likesCount + 1
                  : Math.max(
                      0,
                      c.likesCount - 1
                    ),
            };
          }

          return c;
        })
      );
    }
  }, [authUser]);

  // Pin/unpin comment
  const pinComment = useCallback(async (
    commentId,
    shouldPin
  ) => {
    try {
      if (shouldPin) {
        const { error } =
          await supabase
            .from('comments')
            .update({
              is_pinned: false,
            })
            .eq(
              'video_id',
              videoId
            );

        if (error) throw error;
      }

      const { error } =
        await supabase
          .from('comments')
          .update({
            is_pinned:
              shouldPin,
          })
          .eq('id', commentId);

      if (error) throw error;

      setComments(prev =>
        prev
          .map(c => ({
            ...c,

            is_pinned:
              c.id === commentId
                ? shouldPin
                : false,
          }))
          .sort(
            (a, b) =>
              (b.is_pinned ? 1 : 0) -
              (a.is_pinned ? 1 : 0)
          )
      );
    } catch (error) {
      __DEV__ &&
        console.error(
          'Error pinning comment:',
          error
        );
    }
  }, [videoId]);

  // ─────────────────────────────────────────────────────────────
  // REPORT COMMENT
  // Uses the existing `reports` table so AdminScreen immediately
  // receives comment reports without adding another DB table.
  // ─────────────────────────────────────────────────────────────
  const reportComment = useCallback(async (
    comment
  ) => {
    const user = authUser;

    if (!user) {
      throw new Error(
        'Please sign in to report comments.'
      );
    }

    if (!comment?.id) {
      throw new Error(
        'Invalid comment.'
      );
    }

    if (!comment?.user_id) {
      throw new Error(
        'Comment author could not be identified.'
      );
    }

    if (!videoId) {
      throw new Error(
        'Video could not be identified.'
      );
    }

    const safeText =
      String(comment.text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);

    const reason =
      `Comment report [${comment.id}]: ${safeText || 'No comment text available'}`;

    const { error } =
      await supabase
        .from('reports')
        .insert({
          reporter_id:
            user.id,

          reported_user_id:
            comment.user_id,

          video_id:
            videoId,

          reason,
        });

    if (error) {
      throw error;
    }

    return true;
  }, [authUser, videoId]);

  // Manual refresh
  const refresh = useCallback(() => {
    setRefreshTrigger(
      prev => prev + 1
    );
  }, []);

  // Realtime subscription
  useEffect(() => {
    if (!videoId) return;

    loadComments();

    // Insert-if-absent by real comment id. Never duplicates a comment that
    // is already local (e.g. our own optimistic post reconciled with the
    // server row), and never refetches the whole list for an INSERT.
    const insertCommentIfAbsent = (
      row,
      userInfo
    ) => {
      setComments(prev =>
        prev.some(c => c.id === row.id)
          ? prev
          : [
              {
                ...row,
                user:
                  userInfo || {
                    username: 'Unknown',
                    avatar_url: null,
                  },
                isLiked: false,
                likesCount: 0,
                repliesCount: 0,
                comment_likes: [],
              },
              ...prev,
            ]
      );
    };

    // Latest realtime event seen per comment id, scoped to this subscription
    // (fresh Map per videoId). Used to discard a stale async INSERT
    // enrichment if a DELETE/UPDATE for the same id arrived while its
    // profile lookup was in flight.
    const lastEventById = new Map();

    // False once this subscription's effect is cleaned up (videoId change or
    // unmount). Straggling async profile lookups from THIS effect must not
    // call setComments after a newer effect has taken over the state.
    let isActive = true;

    // Guard for the async other-user INSERT continuation: only insert if no
    // newer event superseded this INSERT and the row still belongs to the
    // video this subscription is for (videoId changes recreate the effect,
    // but a straggling profile fetch from the old effect can still resolve).
    const canApplyAsyncInsert = row =>
      isActive &&
      lastEventById.get(row.id) ===
        'INSERT' &&
      row.video_id === videoId;

    realtimeSubscription.current =
      supabase
        .channel(
          `comments:${videoId}`
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'comments',
            filter:
              `video_id=eq.${videoId}`,
          },
          payload => {
            lastEventById.set(
              payload.new?.id ??
                payload.old?.id,
              payload.eventType
            );

            if (
              payload.eventType ===
              'INSERT'
            ) {
              const row = payload.new;
              const currentUser =
                authUserRef.current;

              if (
                row.user_id ===
                currentUser?.id
              ) {
                // Our own comment: display data is already local.
                insertCommentIfAbsent(
                  row,
                  {
                    id: currentUser.id,
                    username:
                      currentUser.username ??
                      currentUser
                        .user_metadata
                        ?.username ??
                      'Unknown',
                    avatar_url:
                      currentUser.avatar_url ??
                      currentUser
                        .user_metadata
                        ?.avatar_url ??
                      null,
                  }
                );
              } else {
                // Another user's comment: fetch only that author's minimal
                // profile (never a full list refetch), then insert. If the
                // comment already arrived locally in the meantime, the
                // insert-if-absent makes this a no-op.
                supabase
                  .from('profiles')
                  .select(
                    'id, username, avatar_url'
                  )
                  .eq('id', row.user_id)
                  .single()
                  .then(({ data }) => {
                    if (
                      !canApplyAsyncInsert(
                        row
                      )
                    ) {
                      return;
                    }
                    insertCommentIfAbsent(
                      row,
                      data
                    );
                  })
                  .catch(() => {
                    if (
                      !canApplyAsyncInsert(
                        row
                      )
                    ) {
                      return;
                    }
                    insertCommentIfAbsent(
                      row,
                      null
                    );
                  });
              }
            } else if (
              payload.eventType ===
              'UPDATE'
            ) {
              setComments(prev =>
                prev.map(c =>
                  c.id ===
                  payload.new.id
                    ? {
                        ...c,
                        ...payload.new,
                      }
                    : c
                )
              );
            } else if (
              payload.eventType ===
              'DELETE'
            ) {
              setComments(prev =>
                prev.filter(
                  c =>
                    c.id !==
                    payload.old.id
                )
              );
            }
          }
        )
        .subscribe();

    return () => {
      isActive = false;

      if (
        realtimeSubscription.current
      ) {
        supabase.removeChannel(
          realtimeSubscription.current
        );

        realtimeSubscription.current =
          null;
      }
    };
  }, [
    videoId,
    loadComments,
    fetchComments,
  ]);

  return {
    comments,
    loading,
    error,
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
    reportComment,
    refresh,
  };
}