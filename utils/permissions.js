import { Alert, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { Camera } from 'expo-camera';
import { ERROR_MESSAGES } from '../constants/errors';

// Camera permission
export async function requestCameraPermission() {
  const { status } = await Camera.requestCameraPermissionsAsync();
  return status === 'granted';
}

export async function checkCameraPermission() {
  const { status } = await Camera.getCameraPermissionsAsync();
  return status === 'granted';
}

// Microphone permission
export async function requestMicrophonePermission() {
  const { status } = await Camera.requestMicrophonePermissionsAsync();
  return status === 'granted';
}

export async function checkMicrophonePermission() {
  const { status } = await Camera.getMicrophonePermissionsAsync();
  return status === 'granted';
}

// Photo library permission
export async function requestPhotoLibraryPermission() {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  return status === 'granted';
}

export async function checkPhotoLibraryPermission() {
  const { status } = await ImagePicker.getMediaLibraryPermissionsAsync();
  return status === 'granted';
}

// Media library permission (for saving)
export async function requestMediaLibraryPermission() {
  const { status } = await MediaLibrary.requestPermissionsAsync();
  return status === 'granted';
}

export async function checkMediaLibraryPermission() {
  const { status } = await MediaLibrary.getPermissionsAsync();
  return status === 'granted';
}

// Combined permissions for streaming
export async function requestStreamingPermissions() {
  const [cameraGranted, microphoneGranted] = await Promise.all([
    requestCameraPermission(),
    requestMicrophonePermission(),
  ]);
  
  return {
    camera: cameraGranted,
    microphone: microphoneGranted,
    allGranted: cameraGranted && microphoneGranted,
  };
}

export async function checkStreamingPermissions() {
  const [cameraGranted, microphoneGranted] = await Promise.all([
    checkCameraPermission(),
    checkMicrophonePermission(),
  ]);
  
  return {
    camera: cameraGranted,
    microphone: microphoneGranted,
    allGranted: cameraGranted && microphoneGranted,
  };
}

// Permission alerts
export function showCameraPermissionAlert() {
  Alert.alert(
    'Permission Required',
    ERROR_MESSAGES.CAMERA_PERMISSION,
    [{ text: 'OK' }]
  );
}

export function showMicrophonePermissionAlert() {
  Alert.alert(
    'Permission Required',
    ERROR_MESSAGES.MICROPHONE_PERMISSION,
    [{ text: 'OK' }]
  );
}

export function showMediaLibraryPermissionAlert() {
  Alert.alert(
    'Permission Required',
    ERROR_MESSAGES.MEDIA_LIBRARY_PERMISSION,
    [{ text: 'OK' }]
  );
}

// Ensure permissions with alert on denial
export async function ensureCameraPermission(showAlert = true) {
  const granted = await requestCameraPermission();
  if (!granted && showAlert) {
    showCameraPermissionAlert();
  }
  return granted;
}

export async function ensureMicrophonePermission(showAlert = true) {
  const granted = await requestMicrophonePermission();
  if (!granted && showAlert) {
    showMicrophonePermissionAlert();
  }
  return granted;
}

export async function ensureMediaLibraryPermission(showAlert = true) {
  const granted = await requestMediaLibraryPermission();
  if (!granted && showAlert) {
    showMediaLibraryPermissionAlert();
  }
  return granted;
}
