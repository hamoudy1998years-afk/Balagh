import React, { useRef, useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  View, Text, StyleSheet, Animated, Pressable, PanResponder, Image, Share,
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useDownload } from '../context/DownloadContext';
import { useUser } from '../context/UserContext';
import { COLORS } from '../constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import ModernDialog from '../screens/ModernDialog';

const SHEET_HEIGHT = 400;

export default function GlobalVideoOptionsSheet() {
  const insets = useSafeAreaInsets();
  const context = useDownload();
  const { blockUser } = useUser();
  const fallbackNavigation = useNavigation();
  const [loginDialogVisible, setLoginDialogVisible] = useState(false);
  const [loginDialogAction, setLoginDialogAction] = useState('');
  const [blockConfirmVisible, setBlockConfirmVisible] = useState(false);
  const [blockUserData, setBlockUserData] = useState(null);
  const [dialog, setDialog] = useState({ visible: false, title: '', message: '', type: 'info', buttons: [] });

  const shareLockRef = useRef(false);
  
  // TikTok sheet animation
  const tikTokTranslateY = useRef(new Animated.Value(0)).current;

  const tikTokPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => gestureState.dy > 5,
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) {
          tikTokTranslateY.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {

        if (gestureState.dy > 100 || gestureState.vy > 0.5) {

          Animated.timing(tikTokTranslateY, {
            toValue: 400,
            duration: 200,
            useNativeDriver: true,
          }).start(() => {

            hideTikTokShare();
          });
        } else {
          Animated.spring(tikTokTranslateY, {
            toValue: 0,
            tension: 65,
            friction: 11,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;
  
  const sheetState = context?.sheetState;
  const hideVideoOptionsSheet = context?.hideVideoOptionsSheet;
  const hideTikTokShare = context?.hideTikTokShare;

  const { visible, video, isOwner, hasDownloaded, currentUserId, onPin, onDelete, onDownload, onBlock, tiktokShareVisible } = sheetState || {};

  // Dismiss the sheet/popups when the screen that opened them navigates away.
  // Keep the popup alive while the native share sheet is active.
  const openerNavigation = sheetState?.navigation;

  useEffect(() => {
    if (!visible && !tiktokShareVisible) return;
    if (!openerNavigation || typeof openerNavigation.addListener !== 'function') return;

    const sub = openerNavigation.addListener('blur', () => {
      if (shareLockRef.current) return;

      hideTikTokShare();
      hideVideoOptionsSheet();
    });

    return () => sub();
  }, [
    visible,
    tiktokShareVisible,
    openerNavigation,
    hideTikTokShare,
    hideVideoOptionsSheet,
  ]);

  useEffect(() => {
    if (tiktokShareVisible) {
      tikTokTranslateY.stopAnimation(() => {
        tikTokTranslateY.setValue(400);
        Animated.spring(tikTokTranslateY, {
          toValue: 0,
          tension: 65,
          friction: 11,
          useNativeDriver: true,
        }).start();
      });
    }
  }, [tiktokShareVisible]);
  
  // Properly check if user is logged in
  const isGuest = !currentUserId || currentUserId === null || currentUserId === undefined;

  
  // TikTok share handlers
  const handleTikTokClose = () => {
    hideTikTokShare();
  };

  const getVideoShareUrl = () => {
  if (!video?.id) return null;

  return `https://balagh-server-production.up.railway.app/video/${encodeURIComponent(
    video.id
  )}`;
};

const handleCopyLink = async () => {
  const shareUrl = getVideoShareUrl();

  if (!shareUrl) {
    setDialog({
      visible: true,
      title: 'Copy Failed',
      message: 'Video ID is missing.',
      type: 'error',
      buttons: [
        {
          text: 'OK',
          onPress: () =>
            setDialog(d => ({ ...d, visible: false })),
        },
      ],
    });
    return;
  }

  await Clipboard.setStringAsync(shareUrl);

  hideTikTokShare();

  setDialog({
    visible: true,
    title: 'Copied!',
    message: 'Link copied to clipboard',
    type: 'success',
    buttons: [
      {
        text: 'OK',
        onPress: () =>
          setDialog(d => ({ ...d, visible: false })),
      },
    ],
  });
};

  const handleShareVideo = async () => {
  if (shareLockRef.current) return;

  const shareUrl = getVideoShareUrl();

  if (!shareUrl) {
    setDialog({
      visible: true,
      title: 'Share Failed',
      message: 'Video ID is missing.',
      type: 'error',
      buttons: [
        {
          text: 'OK',
          onPress: () =>
            setDialog(d => ({ ...d, visible: false })),
        },
      ],
    });
    return;
  }

  shareLockRef.current = true;

  try {
    await Share.share({
      message: `Watch this video on Bushrann:\n${shareUrl}`,
      url: shareUrl,
      title: 'Share Bushrann video',
    });

    hideTikTokShare();
  } catch (error) {
    console.error(
      '[GlobalVideoOptionsSheet] Error sharing video link:',
      error
    );

    setDialog({
      visible: true,
      title: 'Share Failed',
      message:
        error?.message ||
        'Failed to share video.',
      type: 'error',
      buttons: [
        {
          text: 'OK',
          onPress: () =>
            setDialog(d => ({ ...d, visible: false })),
        },
      ],
    });
  } finally {
    shareLockRef.current = false;
  }
};


  const translateY = useRef(new Animated.Value(SHEET_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      translateY.setValue(SHEET_HEIGHT);
      backdropOpacity.setValue(0);
      Animated.parallel([
        Animated.timing(backdropOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, tension: 65, friction: 11, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(backdropOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: SHEET_HEIGHT, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) => gestureState.dy > 10,
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) translateY.setValue(gestureState.dy);
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy > 100 || gestureState.vy > 0.5) {
          Animated.timing(translateY, { toValue: SHEET_HEIGHT, duration: 200, useNativeDriver: true }).start(() => hideVideoOptionsSheet());
        } else {
          Animated.spring(translateY, { toValue: 0, tension: 65, friction: 11, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  if (!context) return null;
  if (!sheetState) return null;

  // Show if either main sheet or TikTok share is visible
  if (
    !visible &&
    !tiktokShareVisible &&
    !dialog.visible &&
    !loginDialogVisible &&
    !blockConfirmVisible
  ) {
    return null;
  }

  // Use navigation from sheetState or fallback to useNavigation
  const navigation = sheetState.navigation || fallbackNavigation;

  const handlePin = () => {
    hideVideoOptionsSheet();
    setTimeout(() => onPin && onPin(video), 300);
  };

  const handleDelete = () => {
    hideVideoOptionsSheet();
    setTimeout(() => onDelete && onDelete(video), 300);
  };

  const handleDownload = () => {
    if (isGuest) {
      setLoginDialogAction('download videos');
      setLoginDialogVisible(true);
      return;
    }
    if (!hasDownloaded) {
      hideVideoOptionsSheet();
      setTimeout(() => onDownload && onDownload(video), 300);
    }
  };

  const handleBlock = () => {
    if (isGuest) {
      setLoginDialogAction('block users');
      setLoginDialogVisible(true);
      return;
    }
    
    // Show confirmation modal
    setBlockUserData(video);
    setBlockConfirmVisible(true);
  };

  const confirmBlock = async () => {
    if (!blockUserData) return;
    setBlockConfirmVisible(false);
    hideVideoOptionsSheet();
    
    // Use context blockUser for instant UI update (triggers fade animation)
    if (blockUserData?.user_id) {
      blockUser(blockUserData.user_id);
    }
    
    // Also call the callback if provided
    setTimeout(() => onBlock && onBlock(blockUserData), 300);
  };



  return (
    <View style={styles.overlayContainer} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} pointerEvents="auto">
        <Pressable style={StyleSheet.absoluteFill} onPress={hideVideoOptionsSheet} />
      </Animated.View>

      <Animated.View 
        style={[styles.sheet, { transform: [{ translateY }], paddingBottom: insets.bottom + 16 }]} 
        pointerEvents="auto"
        {...panResponder.panHandlers}
      >
        {/* Drag Handle */}
        <View style={styles.dragHandle} />
        
        {/* Video Preview Header */}
        {(video?.thumbnail_url || video?.video_url) && (
          <View style={styles.previewHeader}>
            <Image 
              source={{ uri: video.thumbnail_url || video.video_url }} 
              style={styles.previewImage} 
              resizeMode="cover"
            />
            <View style={styles.previewInfo}>
              <Text style={styles.previewTitle} numberOfLines={1}>
                {video?.caption || 'Video'}
              </Text>
              <Text style={styles.previewMeta}>
                @{video?.profiles?.username || 'user'}
              </Text>
            </View>
          </View>
        )}
        
        {/* Action Grid - Modern Layout */}
        <View style={styles.actionGrid}>
          {/* Share moved to TikTok-style share modal */}

          {/* Download */}
          <TouchableOpacity 
            style={[styles.gridItem, hasDownloaded && styles.gridItemDisabled]} 
            onPress={handleDownload}
            disabled={hasDownloaded}
          >
            <Animated.View style={[
              styles.gridIcon, 
              hasDownloaded ? { backgroundColor: 'rgba(34, 197, 94, 0.15)' } : { backgroundColor: 'rgba(16, 185, 129, 0.15)' }
            ]}>
              <Ionicons 
                name={hasDownloaded ? 'checkmark-circle' : 'download-outline'} 
                size={24} 
                color={hasDownloaded ? '#22c55e' : '#10b981'} 
              />
            </Animated.View>
            <Text style={[styles.gridLabel, hasDownloaded && { color: '#22c55e' }]}>
              {hasDownloaded ? 'Saved' : 'Download'}
            </Text>
          </TouchableOpacity>

          {/* Pin - Owner only */}
          {isOwner && (
            <TouchableOpacity style={styles.gridItem} onPress={handlePin}>
              <Animated.View style={[
                styles.gridIcon,
                video?.is_pinned ? { backgroundColor: 'rgba(183, 110, 121, 0.2)' } : { backgroundColor: 'rgba(255, 255, 255, 0.1)' }
              ]}>
                <Text style={{ fontSize: 22 }}>📌</Text>
              </Animated.View>
              <Text style={styles.gridLabel}>
                {video?.is_pinned ? 'Unpin' : 'Pin'}
              </Text>
            </TouchableOpacity>
          )}

          {/* Block - Non-owner only */}
          {sheetState.onBlock && (
            <TouchableOpacity style={styles.gridItem} onPress={handleBlock}>
              <Animated.View style={[
                styles.gridIcon, 
                { backgroundColor: 'rgba(239, 68, 68, 0.15)' }
              ]}>
                <Ionicons name="ban-outline" size={24} color="#ef4444" />
              </Animated.View>
              <Text style={[styles.gridLabel, { color: '#ef4444' }]}>Block</Text>
            </TouchableOpacity>
          )}

          {/* Delete - Owner only */}
          {isOwner && (
            <TouchableOpacity style={styles.gridItem} onPress={handleDelete}>
              <Animated.View style={[
                styles.gridIcon, 
                { backgroundColor: 'rgba(239, 68, 68, 0.15)' }
              ]}>
                <Ionicons name="trash-outline" size={24} color="#ef4444" />
              </Animated.View>
              <Text style={[styles.gridLabel, { color: '#ef4444' }]}>Delete</Text>
            </TouchableOpacity>
          )}
        </View>
        
        {/* Cancel Button */}
        <TouchableOpacity style={styles.cancelButton} onPress={hideVideoOptionsSheet}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
        
        {/* Modern Login Required Dialog */}
        {loginDialogVisible && (
          <View style={styles.loginDialogOverlay}>
            <View style={styles.loginDialog}>
              <View style={styles.loginDialogIcon}>
                <Text style={{ fontSize: 48 }}>🔒</Text>
              </View>
              <Text style={styles.loginDialogTitle}>Login Required</Text>
              <Text style={styles.loginDialogMessage}>
                Please login or create an account to {loginDialogAction}.
              </Text>
              <View style={styles.loginDialogButtons}>
                <Pressable 
                  style={styles.loginDialogCancel} 
                  onPress={() => setLoginDialogVisible(false)}
                >
                  <Text style={styles.loginDialogCancelText}>Cancel</Text>
                </Pressable>
                <Pressable 
                  style={styles.loginDialogLogin}
                  onPress={() => {
                    setLoginDialogVisible(false);
                    hideVideoOptionsSheet();
                    setTimeout(() => navigation?.navigate('Login'), 300);
                  }}
                >
                  <Text style={styles.loginDialogLoginText}>Login</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}
        
        </Animated.View>
      
      {/* TikTok Style Share Modal - Renders at top level, outside Animated.View */}
      {tiktokShareVisible && (
        <View style={styles.tiktokOverlay}>
          <Pressable style={styles.tiktokBackdrop} onPress={handleTikTokClose} />
          <Animated.View 
            style={[styles.tiktokContent, { transform: [{ translateY: tikTokTranslateY }] }]}
            {...tikTokPanResponder.panHandlers}
          >
            {/* Drag Handle */}
            <View style={styles.tiktokDragHandle} />
            
            <View style={styles.tiktokHeader}>
              <Text style={styles.tiktokTitle}>Send to</Text>
              <Pressable onPress={handleTikTokClose} style={styles.tiktokClose}>
                <Ionicons name="close" size={24} color="#1a2e44" />
              </Pressable>
            </View>
            
            <View style={styles.tiktokGrid}>
              <Pressable style={styles.tiktokItem} onPress={handleShareVideo}>
                <View style={[styles.tiktokIcon, { backgroundColor: '#3b82f6' }]}>
                  <Ionicons name="share-outline" size={28} color="#ffffff" />
                </View>
                <Text style={styles.tiktokLabel}>Share video</Text>
              </Pressable>

              <Pressable style={styles.tiktokItem} onPress={handleCopyLink}>
                <View style={[styles.tiktokIcon, { backgroundColor: '#f1f5f9' }]}>
                  <Ionicons name="link" size={28} color="#1a2e44" />
                </View>
                <Text style={styles.tiktokLabel}>Copy link</Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      )}

      {/* Block Confirmation Modal */}
      {blockConfirmVisible && (
        <View style={styles.blockConfirmOverlay}>
          <Pressable style={styles.blockConfirmBackdrop} onPress={() => setBlockConfirmVisible(false)} />
          <View style={styles.blockConfirmContainer}>
            <View style={styles.blockConfirmCard}>
              <View style={styles.blockConfirmHeader}>
                <Text style={styles.blockConfirmTitle}>
                  Block @{blockUserData?.profiles?.username || 'user'}?
                </Text>
                <Text style={styles.blockConfirmMessage}>
                  They won't be able to see your content or interact with you. You can unblock them anytime from your settings.
                </Text>
              </View>
              <View style={styles.blockConfirmDivider} />
              <Pressable
                style={({ pressed }) => [
                  styles.blockConfirmButton,
                  pressed && { backgroundColor: 'rgba(255, 59, 48, 0.1)' }
                ]}
                onPress={confirmBlock}
              >
                <Text style={[styles.blockConfirmButtonText, { color: '#ff3b30' }]}>Block</Text>
              </Pressable>
              <View style={styles.blockConfirmDivider} />
              <Pressable
                style={({ pressed }) => [
                  styles.blockConfirmButton,
                  pressed && { backgroundColor: '#f5f5f5' }
                ]}
                onPress={() => setBlockConfirmVisible(false)}
              >
                <Text style={[styles.blockConfirmButtonText, { color: '#1a2e44' }]}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      <ModernDialog
        visible={dialog.visible}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        buttons={dialog.buttons}
        onDismiss={() => setDialog(d => ({ ...d, visible: false }))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlayContainer: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 9999, elevation: 9999, justifyContent: 'flex-end',
  },
  backdrop: { 
    ...StyleSheet.absoluteFillObject, 
    backgroundColor: 'rgba(0,0,0,0.5)' 
  },
  sheet: { 
    backgroundColor: '#ffffff', 
    borderTopLeftRadius: 28, 
    borderTopRightRadius: 28, 
    paddingTop: 8,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 20,
  },
  dragHandle: { 
    width: 40, 
    height: 5, 
    backgroundColor: 'rgba(0,0,0,0.2)', 
    borderRadius: 3, 
    alignSelf: 'center', 
    marginTop: 8, 
    marginBottom: 16 
  },
  
  // Preview Header
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderRadius: 16,
    padding: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  previewImage: {
    width: 56,
    height: 56,
    borderRadius: 12,
    backgroundColor: '#e2e8f0',
  },
  previewInfo: {
    marginLeft: 12,
    flex: 1,
  },
  previewTitle: {
    color: '#1a2e44',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  previewMeta: {
    color: '#64748b',
    fontSize: 14,
  },
  
  // Action Grid
  actionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: 12,
    marginBottom: 24,
  },
  gridItem: {
    alignItems: 'center',
    width: 80,
    marginBottom: 8,
  },
  gridItemDisabled: {
    opacity: 0.5,
  },
  gridIcon: {
    width: 56,
    height: 56,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  gridLabel: {
    color: '#1a2e44',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
  
  // Cancel
  cancelButton: {
    backgroundColor: '#f1f5f9',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 8,
  },
  cancelButtonText: {
    color: '#1a2e44',
    fontSize: 16,
    fontWeight: '600',
  },
  
  // Modern Login Dialog
  loginDialogOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    zIndex: 10000,
  },
  loginDialog: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 28,
    width: '100%',
    maxWidth: 320,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 20,
  },
  loginDialogIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  loginDialogTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a2e44',
    marginBottom: 8,
    textAlign: 'center',
  },
  loginDialogMessage: {
    fontSize: 15,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  loginDialogButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  loginDialogCancel: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
  },
  loginDialogCancelText: {
    color: '#64748b',
    fontSize: 16,
    fontWeight: '600',
  },
  loginDialogLogin: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
    backgroundColor: COLORS.gold,
    alignItems: 'center',
  },
  loginDialogLoginText: {
    color: '#1a2e44',
    fontSize: 16,
    fontWeight: '700',
  },
  
  // TikTok Share Styles
  tiktokOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 99999,
    elevation: 99999,
  },
  tiktokBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  tiktokContent: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingBottom: 32,
    zIndex: 100000,
    elevation: 100000,
  },
  tiktokDragHandle: {
    width: 40,
    height: 5,
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: 3,
    alignSelf: 'center',
    marginBottom: 12,
  },
  tiktokHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  tiktokTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a2e44',
    flex: 1,
    textAlign: 'center',
  },
  tiktokClose: {
    padding: 4,
  },
  tiktokGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-around',
    paddingHorizontal: 16,
  },
  tiktokItem: {
    alignItems: 'center',
    width: '25%',
    marginBottom: 20,
  },
  tiktokIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  tiktokLabel: {
    color: '#1a2e44',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
  
  // Block Confirmation Modal Styles
  blockConfirmOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100001,
    elevation: 100001,
  },
  blockConfirmBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  blockConfirmContainer: {
    width: '100%',
    maxWidth: 300,
    paddingHorizontal: 32,
    zIndex: 100002,
  },
  blockConfirmCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 0.5,
    borderColor: '#e5e5e5',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 8,
  },
  blockConfirmHeader: {
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  blockConfirmTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a2e44',
    textAlign: 'center',
    marginBottom: 6,
  },
  blockConfirmMessage: {
    fontSize: 13,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 20,
  },
  blockConfirmDivider: {
    height: 0.5,
    backgroundColor: '#e5e5e5',
    width: '100%',
  },
  blockConfirmButton: {
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  blockConfirmButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
