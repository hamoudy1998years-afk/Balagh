import React, { useEffect, useState } from 'react';
import { View, Image, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';
import LiveStreamPreview from './LiveStreamPreview';

export default function LiveVideoCard({ stream, onPress, previewActive = false }) {
  const [pulseAnim] = useState(new Animated.Value(1));

  // Animated "LIVE" badge pulse
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.2,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const avatarUrl = stream.profiles?.avatar_url ?? null;
  const username = stream.profiles?.username ?? 'Scholar';
  const title = stream.title ?? null;

  return (
    <TouchableOpacity onPress={onPress} style={styles.container} activeOpacity={0.9}>
      {/* Thumbnail fallback — stays visible under/behind the preview until
          actual video is available, on failure, and when preview is off. */}
      <Image
        source={{
          uri: stream.thumbnail_url || avatarUrl,
          cache: 'force-cache',
          headers: { 'Cache-Control': 'max-age=86400' },
        }}
        style={styles.thumbnail}
        resizeMode="cover"
      />

      {/* Actual muted live video preview (renders nothing until host video) */}
      <LiveStreamPreview stream={stream} enabled={previewActive} />

      {/* Animated LIVE Badge */}
      <View style={styles.liveBadge}>
        <Animated.View style={[styles.pulseDot, { transform: [{ scale: pulseAnim }] }]} />
        <Text style={styles.liveText}>LIVE</Text>
      </View>

      {/* Viewer count */}
      <View style={styles.viewerBadge}>
        <Ionicons name="eye" size={12} color="#fff" />
        <Text style={styles.viewerText}>{stream.viewer_count || 0}</Text>
      </View>

      {/* Streamer info + optional title */}
      <View style={styles.infoBlock}>
        {!!title && (
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        )}
        <View style={styles.streamerRow}>
          {!!avatarUrl && (
            <Image
              source={{
                uri: avatarUrl,
                cache: 'force-cache',
                headers: { 'Cache-Control': 'max-age=86400' },
              }}
              style={styles.avatar}
            />
          )}
          <Text style={styles.username} numberOfLines={1}>
            {username}
          </Text>
        </View>
      </View>

      {/* Subtle join affordance while the live preview is playing */}
      {previewActive && (
        <View style={styles.joinPill}>
          <Ionicons name="play" size={10} color="#fff" />
          <Text style={styles.joinText}>Tap to join</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 9/16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignSelf: 'center',
  },
  thumbnail: {
    ...StyleSheet.absoluteFillObject,
  },
  liveBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.live,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    gap: 4,
  },
  pulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fff',
  },
  liveText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  viewerBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 12,
    gap: 4,
  },
  viewerText: {
    color: '#fff',
    fontSize: 10,
  },
  infoBlock: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    right: 8,
    gap: 4,
    // Small localized background for readability — does not cover the video
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  streamerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#fff',
  },
  username: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  title: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '500',
    opacity: 0.9,
  },
  joinPill: {
    position: 'absolute',
    bottom: 52,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    gap: 4,
  },
  joinText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
});
