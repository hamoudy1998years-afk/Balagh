import React, { useRef, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Animated, Pressable, PanResponder, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDownload } from '../context/DownloadContext';
import { useUser } from '../context/UserContext';
import { COLORS } from '../constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';

const SHEET_HEIGHT = 400;

export default function GlobalVideoOptionsSheet() {
  const insets = useSafeAreaInsets();
  const context = useDownload();
  const { currentUser, blockUser } = useUser();
  const fallbackNavigation = useNavigation();
  const [loginDialogVisible, setLoginDialogVisible] = useState(false);
  const [loginDialogAction, setLoginDialogAction] = useState('');
  const [blockConfirmVisible, setBlockConfirmVisible] = useState(false);
  const [blockUserData, setBlockUserData] = useState(null);
  
  // TikTok sheet animation
  const tikTokTranslateY = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
  
    if (tiktokShareVisible) {

      // Stop any running animation and reset to off-screen position
      tikTokTranslateY.stopAnimation(() => {

        tikTokTranslateY.setValue(400);

        Animated.spring(tikTokTranslateY, {
          toValue: 0,
          tension: 65,
          friction: 11,
          useNativeDriver: true,
        }).start(() => {

        });
      });
    } else {

    }
  }, [tiktokShareVisible]);

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
  
  if (!context) {

    return null;
  }
  
  const { sheetState, hideVideoOptionsSheet, hideTikTokShare } = context;
  
  if (!sheetState) {
    return null;
  }



  const { visible, video, isOwner, hasDownloaded, currentUserId, onPin, onDelete, onDownload, onBlock, tiktokShareVisible } = sheetState;
  // Force reset animation when tiktokShareVisible becomes true
  if (tiktokShareVisible && tikTokTranslateY.__getValue() > 350) {

    tikTokTranslateY.setValue(400);
    Animated.spring(tikTokTranslateY, {
      toValue: 0,
      tension: 65,
      friction: 11,
      useNativeDriver: true,
    }).start(() => {

    });
  }
  
  // Properly check if user is logged in
  const isGuest = !currentUserId || currentUserId === null || currentUserId === undefined;

  
  // TikTok share handlers
  const handleTikTokClose = () => {
    hideTikTokShare();
  };

  const handleCopyLink = () => {
    const { Clipboard } = require('react-native');
    Clipboard.setString(`https://bushrann.app/video/${video?.id}`);
    hideTikTokShare();
    Alert.alert('Copied!', 'Link copied to clipboard');
  };

  const handleShareWhatsApp = () => {
    const url = `whatsapp://send?text=Check out this video on Bushrann! ${video?.caption || ''} https://bushrann.app/video/${video?.id}`;
    Linking.openURL(url).catch(() => Alert.alert('WhatsApp not installed'));
    hideTikTokShare();
  };

  const handleShareFacebook = () => {
    const url = `https://www.facebook.com/sharer/sharer.php?u=https://bushrann.app/video/${video?.id}`;
    Linking.openURL(url);
    hideTikTokShare();
  };

  const handleShareMessenger = () => {
    const url = `fb-messenger://share/?link=https://bushrann.app/video/${video?.id}`;
    Linking.openURL(url).catch(() => Alert.alert('Messenger not installed'));
    hideTikTokShare();
  };

  const handleShareSMS = () => {
    const url = `sms:?body=Check out this video on Bushrann! https://bushrann.app/video/${video?.id}`;
    Linking.openURL(url);
    hideTikTokShare();
  };

  const handleShareEmail = () => {
    const url = `mailto:?subject=Check out this video on Bushrann&body=https://bushrann.app/video/${video?.id}`;
    Linking.openURL(url);
    hideTikTokShare();
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
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => gestureState.dy > 0,
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

  // Show if either main sheet or TikTok share is visible
  if (!visible && !tiktokShareVisible) return null;

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
    console.log('🚫 Blocking user:', video?.user_id);
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
          {/* Share removed - now on right side action bar */}

          {/* Download */}
          <Pressable 
            style={[styles.gridItem, hasDownloaded && styles.gridItemDisabled]} 
            onPress={handleDownload}
            disabled={hasDownloaded}
          >
            <View style={[
              styles.gridIcon, 
              hasDownloaded ? { backgroundColor: 'rgba(34, 197, 94, 0.15)' } : { backgroundColor: 'rgba(16, 185, 129, 0.15)' }
            ]}>
              <Ionicons 
                name={hasDownloaded ? 'checkmark-circle' : 'download-outline'} 
                size={24} 
                color={hasDownloaded ? '#22c55e' : '#10b981'} 
              />
            </View>
            <Text style={[styles.gridLabel, hasDownloaded && { color: '#22c55e' }]}>
              {hasDownloaded ? 'Saved' : 'Download'}
            </Text>
          </Pressable>

          {/* Pin - Owner only */}
          {isOwner && (
            <Pressable style={styles.gridItem} onPress={handlePin}>
              <View style={[
                styles.gridIcon, 
                video?.is_pinned ? { backgroundColor: 'rgba(183, 110, 121, 0.2)' } : { backgroundColor: 'rgba(255, 255, 255, 0.1)' }
              ]}>
                <Ionicons 
                  name={video?.is_pinned ? 'pin' : 'pin-outline'} 
                  size={24} 
                  color={video?.is_pinned ? '#B76E79' : '#ffffff'} 
                />
              </View>
              <Text style={styles.gridLabel}>
                {video?.is_pinned ? 'Unpin' : 'Pin'}
              </Text>
            </Pressable>
          )}

          {/* Block - Non-owner only */}
          {sheetState.onBlock && (
            <Pressable style={styles.gridItem} onPress={handleBlock}>
              <View style={[styles.gridIcon, { backgroundColor: 'rgba(239, 68, 68, 0.15)' }]}>
                <Ionicons name="ban-outline" size={24} color="#ef4444" />
              </View>
              <Text style={[styles.gridLabel, { color: '#ef4444' }]}>Block</Text>
            </Pressable>
          )}

          {/* Delete - Owner only */}
          {isOwner && (
            <Pressable style={styles.gridItem} onPress={handleDelete}>
              <View style={[styles.gridIcon, { backgroundColor: 'rgba(239, 68, 68, 0.15)' }]}>
                <Ionicons name="trash-outline" size={24} color="#ef4444" />
              </View>
              <Text style={[styles.gridLabel, { color: '#ef4444' }]}>Delete</Text>
            </Pressable>
          )}
        </View>
        
        {/* Cancel Button */}
        <Pressable style={styles.cancelButton} onPress={hideVideoOptionsSheet}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </Pressable>
        
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
              <Pressable style={styles.tiktokItem} onPress={handleCopyLink}>
                <View style={[styles.tiktokIcon, { backgroundColor: '#f1f5f9' }]}>
                  <Ionicons name="link" size={28} color="#1a2e44" />
                </View>
                <Text style={styles.tiktokLabel}>Copy link</Text>
              </Pressable>

              <Pressable style={styles.tiktokItem} onPress={handleShareWhatsApp}>
                <View style={[styles.tiktokIcon, { backgroundColor: '#25D366' }]}>
                  <Ionicons name="logo-whatsapp" size={28} color="#ffffff" />
                </View>
                <Text style={styles.tiktokLabel}>WhatsApp</Text>
              </Pressable>

              <Pressable style={styles.tiktokItem} onPress={handleShareFacebook}>
                <View style={[styles.tiktokIcon, { backgroundColor: '#1877F2' }]}>
                  <Ionicons name="logo-facebook" size={28} color="#ffffff" />
                </View>
                <Text style={styles.tiktokLabel}>Facebook</Text>
              </Pressable>

              <Pressable style={styles.tiktokItem} onPress={handleShareMessenger}>
                <View style={[styles.tiktokIcon, { backgroundColor: '#00B2FF' }]}>
                  <Ionicons name="chatbubble-ellipses" size={28} color="#ffffff" />
                </View>
                <Text style={styles.tiktokLabel}>Messenger</Text>
              </Pressable>

              <Pressable style={styles.tiktokItem} onPress={handleShareSMS}>
                <View style={[styles.tiktokIcon, { backgroundColor: '#34C759' }]}>
                  <Ionicons name="chatbubble" size={28} color="#ffffff" />
                </View>
                <Text style={styles.tiktokLabel}>SMS</Text>
              </Pressable>

              <Pressable style={styles.tiktokItem} onPress={handleShareEmail}>
                <View style={[styles.tiktokIcon, { backgroundColor: '#EA4335' }]}>
                  <Ionicons name="mail" size={28} color="#ffffff" />
                </View>
                <Text style={styles.tiktokLabel}>Email</Text>
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
    gap: 16,
    marginBottom: 24,
  },
  gridItem: {
    alignItems: 'center',
    width: '22%',
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
