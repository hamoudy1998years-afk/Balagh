import React, {
  useRef,
  useCallback,
  useEffect,
  useState,
} from 'react';

import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Keyboard,
  Platform,
  Vibration,
  BackHandler,
  TouchableWithoutFeedback,
} from 'react-native';

import {
  BottomSheetModal,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';

import { useComments } from '../hooks/useComments';
import CommentHeader from '../components/comments/CommentHeader';
import CommentList from '../components/comments/CommentList';
import CommentInput from '../components/comments/CommentInput';
import ReplyInput from '../components/comments/ReplyInput';
import { COLORS } from '../constants/theme';
import { ROUTES } from '../constants/routes';
import { useUser } from '../context/UserContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function CustomBackdrop({ onClose }) {
  return (
    <TouchableWithoutFeedback
      onPress={onClose}
    >
      <View style={styles.backdrop} />
    </TouchableWithoutFeedback>
  );
}

export default function CommentsModal({
  visible,
  onClose,
  videoId,
  navigation,
  isCreator = false,
}) {
  const insets =
    useSafeAreaInsets();

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
    reportComment,
  } = useComments(videoId);

  const [
    newComment,
    setNewComment,
  ] = useState('');

  const [
    replyText,
    setReplyText,
  ] = useState('');

  const [
    keyboardHeight,
    setKeyboardHeight,
  ] = useState(0);

  const { user: authUser } =
    useUser();

  const currentUserId =
    authUser?.id ?? null;

  const [
    activeMenuId,
    setActiveMenuId,
  ] = useState(null);

  const [
    visibleReplies,
    setVisibleReplies,
  ] = useState({});

  const [
    justRepliedTo,
    setJustRepliedTo,
  ] = useState(null);

  const bottomSheetRef =
    useRef(null);

  const snapPoints = ['68%'];

  const COMMENT_MAX = 300;

  const sanitize = text =>
    text
      .replace(/<[^>]*>/g, '')
      .trim();

  // Open / close
  useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, [visible]);

  // Android back
  useEffect(() => {
    const handler =
      BackHandler.addEventListener(
        'hardwareBackPress',
        () => {
          if (activeMenuId) {
            setActiveMenuId(null);
            return true;
          }

          if (visible) {
            closeModal();
            return true;
          }

          return false;
        }
      );

    return () =>
      handler.remove();
  }, [
    activeMenuId,
    visible,
  ]);

  // Keyboard tracking
  useEffect(() => {
    const showEvent =
      Platform.OS === 'ios'
        ? 'keyboardWillShow'
        : 'keyboardDidShow';

    const hideEvent =
      Platform.OS === 'ios'
        ? 'keyboardWillHide'
        : 'keyboardDidHide';

    const onShow = e =>
      setKeyboardHeight(
        e.endCoordinates.height
      );

    const onHide = () =>
      setKeyboardHeight(0);

    const showSub =
      Keyboard.addListener(
        showEvent,
        onShow
      );

    const hideSub =
      Keyboard.addListener(
        hideEvent,
        onHide
      );

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Pagination
  const handleScroll =
    useCallback(
      event => {
        const {
          layoutMeasurement,
          contentOffset,
          contentSize,
        } =
          event.nativeEvent;

        const paddingToBottom = 50;

        const isNearBottom =
          layoutMeasurement.height +
            contentOffset.y >=
          contentSize.height -
            paddingToBottom;

        if (
          isNearBottom &&
          hasMore &&
          !loadingMore
        ) {
          loadMore();
        }
      },
      [
        hasMore,
        loadingMore,
        loadMore,
      ]
    );

  // Close
  const closeModal =
    useCallback(() => {
      setActiveMenuId(null);

      Keyboard.dismiss();

      setReplyingTo(null);
      setNewComment('');
      setReplyText('');
      setKeyboardHeight(0);
      setVisibleReplies({});
      setJustRepliedTo(null);

      bottomSheetRef.current?.dismiss();
    }, [setReplyingTo]);

  const handleSheetDismiss =
    useCallback(() => {
      setActiveMenuId(null);
      setReplyingTo(null);
      setNewComment('');
      setReplyText('');
      setKeyboardHeight(0);
      setVisibleReplies({});
      setJustRepliedTo(null);

      onClose();
    }, [
      onClose,
      setReplyingTo,
    ]);

  // Toggle replies
  const handleToggleReplies =
    useCallback(
      parentCommentId => {
        setVisibleReplies(prev => ({
          ...prev,

          [parentCommentId]:
            !prev[parentCommentId],
        }));

        setJustRepliedTo(prev =>
          prev === parentCommentId
            ? null
            : prev
        );
      },
      []
    );

  // Submit comment
  const handleSubmitComment =
    async () => {
      const clean =
        sanitize(newComment);

      if (!clean || posting) {
        return;
      }

      const result =
        await postComment(clean);

      if (!result) return;

      setNewComment('');

      Keyboard.dismiss();

      Vibration.vibrate(10);
    };

  // Submit reply
  const handleSubmitReply =
    async () => {
      const cleanReply =
        sanitize(replyText);

      if (
        !cleanReply ||
        !replyingTo ||
        posting
      ) {
        return;
      }

      const parentId =
        replyingTo.id;

      const result =
        await postComment(
          cleanReply,
          parentId
        );

      if (!result) return;

      setJustRepliedTo(
        parentId
      );

      setReplyText('');
      setReplyingTo(null);

      Keyboard.dismiss();

      Vibration.vibrate(10);
    };

  const handleReply =
    useCallback(
      comment => {
        setActiveMenuId(null);
        setReplyingTo(comment);
      },
      [setReplyingTo]
    );

  const cancelReply =
    useCallback(() => {
      setReplyingTo(null);
      setReplyText('');

      Keyboard.dismiss();
    }, [setReplyingTo]);

  const handleUserPress =
    useCallback(
      userId => {
        setActiveMenuId(null);

        if (
          navigation &&
          userId
        ) {
          closeModal();

          setTimeout(
            () =>
              navigation.navigate(
                ROUTES.USER_PROFILE,
                {
                  profileUserId:
                    userId,
                }
              ),
            300
          );
        }
      },
      [
        navigation,
        closeModal,
      ]
    );

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      index={0}
      snapPoints={snapPoints}
      onDismiss={
        handleSheetDismiss
      }
      enablePanDownToClose={true}
      enableContentPanningGesture={
        true
      }
      keyboardBehavior="fillParent"
      keyboardBlurBehavior="none"
      android_keyboardInputMode="adjustPan"
      backdropComponent={() => (
        <CustomBackdrop
          onClose={closeModal}
        />
      )}
      handleIndicatorStyle={
        styles.dragHandle
      }
      backgroundStyle={
        styles.sheetBackground
      }
      enableDynamicSizing={false}
      enableOverDrag={false}
    >
      <View
        style={
          styles.outerContainer
        }
      >
        <View
          style={
            styles.headerSection
          }
        >
          <CommentHeader
            count={comments.length}
            onClose={closeModal}
          />
        </View>

        <View
          style={
            styles.listContainer
          }
        >
          {loading ? (
            <View
              style={
                styles.loadingContainer
              }
            >
              <ActivityIndicator
                size="large"
                color={COLORS.gold}
              />

              <Text
                style={
                  styles.loadingText
                }
              >
                Loading comments...
              </Text>
            </View>
          ) : (
            <BottomSheetScrollView
              style={
                styles.scrollView
              }
              contentContainerStyle={
                styles.scrollContent
              }
              showsVerticalScrollIndicator={
                false
              }
              bounces={false}
              overScrollMode="never"
              onScroll={
                handleScroll
              }
              scrollEventThrottle={400}
            >
              <CommentList
                comments={comments}
                onReply={
                  handleReply
                }
                onLike={
                  toggleLike
                }
                onEdit={
                  editComment
                }
                onDelete={
                  deleteComment
                }
                onReport={
                  reportComment
                }
                onUserPress={
                  handleUserPress
                }
                onPin={
                  pinComment
                }
                currentUserId={
                  currentUserId
                }
                isCreator={
                  isCreator
                }
                loadingMore={
                  loadingMore
                }
                onLoadMore={
                  loadMore
                }
                hasMore={
                  hasMore
                }
                activeMenuId={
                  activeMenuId
                }
                setActiveMenuId={
                  setActiveMenuId
                }
                visibleReplies={
                  visibleReplies
                }
                onToggleReplies={
                  handleToggleReplies
                }
                justRepliedTo={
                  justRepliedTo
                }
              />

              <View
                style={{
                  height: 20,
                }}
              />
            </BottomSheetScrollView>
          )}
        </View>

        <View
          style={[
            styles.inputWrapper,

            {
              marginBottom:
                keyboardHeight,

              paddingBottom:
                insets.bottom + 8,
            },
          ]}
        >
          {replyingTo ? (
            <ReplyInput
              value={replyText}
              onChangeText={t =>
                setReplyText(
                  t.slice(
                    0,
                    COMMENT_MAX
                  )
                )
              }
              onSubmit={
                handleSubmitReply
              }
              onCancel={
                cancelReply
              }
              replyingTo={
                replyingTo
              }
            />
          ) : (
            <CommentInput
              value={newComment}
              onChangeText={t =>
                setNewComment(
                  t.slice(
                    0,
                    COMMENT_MAX
                  )
                )
              }
              onSubmit={
                handleSubmitComment
              }
              placeholder="Add comment..."
            />
          )}
        </View>
      </View>
    </BottomSheetModal>
  );
}

const styles =
  StyleSheet.create({
    sheetBackground: {
      backgroundColor: '#fff',

      borderTopLeftRadius:
        20,

      borderTopRightRadius:
        20,
    },

    dragHandle: {
      backgroundColor:
        '#ddd',

      width: 36,
      height: 5,
    },

    backdrop: {
      ...StyleSheet.absoluteFillObject,

      backgroundColor:
        'rgba(0,0,0,0.5)',
    },

    outerContainer: {
      flex: 1,

      backgroundColor:
        '#fff',
    },

    headerSection: {
      backgroundColor:
        '#fff',

      zIndex: 10,
    },

    listContainer: {
      flex: 1,

      backgroundColor:
        '#fff',
    },

    scrollView: {
      flex: 1,
    },

    scrollContent: {
      flexGrow: 1,

      paddingBottom: 100,
    },

    loadingContainer: {
      flex: 1,

      justifyContent:
        'center',

      alignItems:
        'center',

      paddingVertical: 50,
    },

    loadingText: {
      marginTop: 12,

      fontSize: 14,

      color: '#666',
    },

    inputWrapper: {
      backgroundColor:
        '#fff',

      borderTopWidth: 1,

      borderTopColor:
        '#f0f0f0',

      paddingBottom:
        Platform.OS === 'ios'
          ? 20
          : 8,
    },
  });