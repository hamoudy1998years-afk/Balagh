import React, { useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, Animated, Pressable, PanResponder, // Removed Image import
} from 'react-native';
import { useDownload } from '../context/DownloadContext';
import { COLORS } from '../constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const SHEET_HEIGHT = 400; // Reduced height since we removed preview

export default function GlobalVideoOptionsSheet() {
  const insets = useSafeAreaInsets();
  const context = useDownload();
  
  if (!context) {
    __DEV__ && console.log('GlobalVideoOptionsSheet: context is undefined');
    return null;
  }
  
  const { sheetState, hideVideoOptionsSheet } = context;
  
  if (!sheetState) {
    return null;
  }

  const { visible, video, isOwner, hasDownloaded, onPin, onDelete, onDownload } = sheetState;
  
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

  if (!visible) return null;

  const handlePin = () => {
    hideVideoOptionsSheet();
    setTimeout(() => onPin && onPin(video), 300);
  };

  const handleDelete = () => {
    hideVideoOptionsSheet();
    setTimeout(() => onDelete && onDelete(video), 300);
  };

  const handleDownload = () => {
    if (!hasDownloaded) {
      hideVideoOptionsSheet();
      setTimeout(() => onDownload && onDownload(video), 300);
    }
  };

  return (
    <View style={styles.overlayContainer} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} pointerEvents="auto">
        <Pressable style={StyleSheet.absoluteFill} onPress={hideVideoOptionsSheet} />
      </Animated.View>

      <Animated.View 
        style={[styles.sheet, { transform: [{ translateY }], paddingBottom: insets.bottom + 20 }]} 
        pointerEvents="auto"
        {...panResponder.panHandlers}
      >
        <View style={styles.dragHandle} />
        
        {/* REMOVED: Video Preview Section */}
        
        {/* Pin/Unpin - Only for owner */}
        {isOwner && (
          <Pressable style={styles.option} onPress={handlePin}>
            <View style={styles.optionIcon}>
              <Text style={styles.optionEmoji}>{video?.is_pinned ? '📌' : '📍'}</Text>
            </View>
            <Text style={styles.optionText}>{video?.is_pinned ? 'Unpin Video' : 'Pin Video'}</Text>
          </Pressable>
        )}
        
        {/* Download - For everyone */}
        <Pressable 
          style={[styles.option, hasDownloaded && styles.downloadedOption]} 
          onPress={handleDownload}
          disabled={hasDownloaded}
        >
          <View style={[styles.optionIcon, hasDownloaded && styles.downloadedIcon]}>
            <Text style={styles.optionEmoji}>{hasDownloaded ? '✅' : '⬇️'}</Text>
          </View>
          <Text style={[styles.optionText, hasDownloaded && styles.downloadedText]}>
            {hasDownloaded ? 'Downloaded' : 'Download Video'}
          </Text>
        </Pressable>
        
        {/* Delete - Only for owner */}
        {isOwner && (
          <Pressable style={styles.option} onPress={handleDelete}>
            <View style={[styles.optionIcon, { backgroundColor: '#3d1111' }]}>
              <Text style={styles.optionEmoji}>🗑️</Text>
            </View>
            <Text style={[styles.optionText, { color: '#ef4444' }]}>Delete Video</Text>
          </Pressable>
        )}
        
        {/* Cancel */}
        <Pressable style={styles.cancelOption} onPress={hideVideoOptionsSheet}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlayContainer: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 9999, elevation: 9999, justifyContent: 'flex-end',
  },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { backgroundColor: COLORS.bgCard, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 40 }, // paddingBottom overridden inline
  dragHandle: { width: 36, height: 5, backgroundColor: COLORS.textGray, borderRadius: 3, alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  option: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, gap: 16 },
  optionIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.borderDark, alignItems: 'center', justifyContent: 'center' },
  optionEmoji: { fontSize: 20 },
  optionText: { color: COLORS.textWhite, fontSize: 16, fontWeight: '500' },
  cancelOption: { marginTop: 8, borderTopWidth: 1, borderTopColor: COLORS.borderDark, paddingVertical: 16, alignItems: 'center' },
  cancelText: { color: COLORS.textGray, fontSize: 16, fontWeight: '600' },
  downloadedOption: { opacity: 0.8 },
  downloadedIcon: { backgroundColor: COLORS.success },
  downloadedText: { color: COLORS.success, fontWeight: '600' },
});