import React, { useEffect, useState } from 'react';
import { View, Image, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';

export default function LiveVideoCard({ stream, onPress }) {
  const [pulseAnim] = useState(new Animated.Value(1));

  // Animated "LIVE" badge pulse
  useEffect(() => {
    Animated.loop(
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
    ).start();
  }, []);

  return (
    <TouchableOpacity onPress={onPress} style={styles.container}>
      {/* Thumbnail (actual stream frame) - SHOWS LIVE PREVIEW */}
      <Image
        source={{ 
          uri: stream.thumbnail_url || stream.user?.avatar 
        }}
        style={styles.thumbnail}
        resizeMode="cover"
      />
      
      {/* Dark overlay for text readability */}
      <View style={styles.overlay} />
      
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
      
      {/* Streamer info */}
      <View style={styles.streamerInfo}>
        <Image 
          source={{ uri: stream.user?.avatar }} 
          style={styles.avatar}
        />
        <Text style={styles.username} numberOfLines={1}>
          {stream.user?.name}
        </Text>
      </View>
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
  },
  thumbnail: {
    ...StyleSheet.absoluteFillObject,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.2)',
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
  streamerInfo: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    right: 8,
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
});