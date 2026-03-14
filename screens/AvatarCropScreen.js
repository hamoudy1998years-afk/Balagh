import {
  View, Text, StyleSheet, Dimensions, TouchableOpacity,
  ActivityIndicator, PanResponder, Animated
} from 'react-native';
import { useState, useRef } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';

const { width, height } = Dimensions.get('window');
const CROP_SIZE = width - 60;
const SIDE = (width - CROP_SIZE) / 2;
const VERT = (height - CROP_SIZE) / 2 - 80;

export default function AvatarCropScreen({ route, navigation }) {
  const { imageUri } = route.params;
  const insets = useSafeAreaInsets();
  const [processing, setProcessing] = useState(false);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });

  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;

  const currentX = useRef(0);
  const currentY = useRef(0);
  const currentScale = useRef(1);
  const lastDistance = useRef(null);
  const lastScale = useRef(1);

  function getDistance(touches) {
    const dx = touches[0].pageX - touches[1].pageX;
    const dy = touches[0].pageY - touches[1].pageY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      lastDistance.current = null;
      lastScale.current = currentScale.current;
    },
    onPanResponderMove: (evt, gestureState) => {
      const touches = evt.nativeEvent.touches;
      if (touches.length === 2) {
        const dist = getDistance(touches);
        if (lastDistance.current !== null) {
          const scaleDelta = dist / lastDistance.current;
          const newScale = Math.max(0.5, Math.min(lastScale.current * scaleDelta, 5));
          currentScale.current = newScale;
          scale.setValue(newScale);
        }
        lastDistance.current = dist;
        lastScale.current = currentScale.current;
      } else if (touches.length === 1) {
        translateX.setValue(currentX.current + gestureState.dx);
        translateY.setValue(currentY.current + gestureState.dy);
      }
    },
    onPanResponderRelease: (evt, gestureState) => {
      if (evt.nativeEvent.touches.length === 0) {
        currentX.current += gestureState.dx;
        currentY.current += gestureState.dy;
        lastDistance.current = null;
      }
    },
    onPanResponderTerminate: () => {
      lastDistance.current = null;
    },
  })).current;

  function onImageLoad(e) {
    const { width: w, height: h } = e.nativeEvent.source;
    setImageSize({ width: w, height: h });
  }

  async function handleCrop() {
    try {
        setProcessing(true);

        // Step 1 — normalize EXIF rotation, get real dimensions from result
        const normalized = await ImageManipulator.manipulateAsync(
        imageUri, [], { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
        );

        const imgW = normalized.width;
        const imgH = normalized.height;

        // Step 2 — calculate crop
        const coverScale = Math.max(CROP_SIZE / imgW, CROP_SIZE / imgH);
        const totalScale = coverScale * currentScale.current;
        const cropSize = Math.round(CROP_SIZE / totalScale);

        const centerX = imgW / 2 - currentX.current / totalScale;
        const centerY = imgH / 2 - currentY.current / totalScale;

        const originX = Math.max(0, Math.min(Math.round(centerX - cropSize / 2), imgW - cropSize));
        const originY = Math.max(0, Math.min(Math.round(centerY - cropSize / 2), imgH - cropSize));

        // Step 3 — crop
        const result = await ImageManipulator.manipulateAsync(
        normalized.uri,
        [
            { crop: { originX, originY, width: cropSize, height: cropSize } },
            { resize: { width: 500, height: 500 } },
        ],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG }
        );

        setProcessing(false);
        navigation.navigate('Main', {
        screen: 'Profile',
        params: { croppedUri: result.uri },
        });
    } catch (e) {
        console.error('Crop error:', e);
        setProcessing(false);
        navigation.goBack();
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>

      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.topBtn}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.topTitle}>Move and Scale</Text>
        <TouchableOpacity onPress={handleCrop} style={styles.doneBtn} disabled={processing}>
          {processing
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.doneText}>Done</Text>
          }
        </TouchableOpacity>
      </View>

      <Text style={styles.hint}>Pinch to zoom • Drag to reposition</Text>

      {/* Crop area */}
      <View style={styles.cropArea}>
        <View style={styles.gestureLayer} {...panResponder.panHandlers}>
          <Animated.Image
            source={{ uri: imageUri }}
            style={[styles.image, { transform: [{ translateX }, { translateY }, { scale }] }]}
            resizeMode="cover"
            onLoad={onImageLoad}
          />
        </View>

        {/* Dark overlays */}
        <View style={[styles.overlay, { top: 0, left: 0, right: 0, height: VERT }]} pointerEvents="none" />
        <View style={[styles.overlay, { bottom: 0, left: 0, right: 0, height: VERT }]} pointerEvents="none" />
        <View style={[styles.overlay, { top: VERT, bottom: VERT, left: 0, width: SIDE }]} pointerEvents="none" />
        <View style={[styles.overlay, { top: VERT, bottom: VERT, right: 0, width: SIDE }]} pointerEvents="none" />

        {/* Circle border */}
        <View style={styles.circleBorder} pointerEvents="none" />
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#1a1a1a',
  },
  topTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  topBtn: { minWidth: 70 },
  cancelText: { color: '#a0a0b0', fontSize: 15, fontWeight: '600' },
  doneBtn: {
    backgroundColor: COLORS.gold, borderRadius: 20,
    paddingHorizontal: 18, paddingVertical: 7, minWidth: 70, alignItems: 'center',
  },
  doneText: { color: COLORS.navy, fontSize: 15, fontWeight: '700' },
  hint: { color: '#505070', fontSize: 12, textAlign: 'center', marginTop: 10, fontStyle: 'italic' },
  cropArea: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  gestureLayer: { width, height, alignItems: 'center', justifyContent: 'center' },
  image: { width: CROP_SIZE, height: CROP_SIZE },
  overlay: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.75)' },
  circleBorder: {
    position: 'absolute', width: CROP_SIZE, height: CROP_SIZE,
    borderRadius: CROP_SIZE / 2, borderWidth: 2, borderColor: COLORS.gold,
  },
});