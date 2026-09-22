import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { requestWatermarkedVideo } from './apiClient';
import { isShareableVideo } from './videoShare';

/**
 * Downloads the server's permanently watermarked version of a video
 * (the same v8 watermarked MP4 used by external Share) and saves it
 * to the device gallery.
 *
 * Reuses POST /api/videos/:videoId/watermark and the watermarked/v8
 * storage cache — no second watermark implementation, no client-side
 * FFmpeg, and the original/master video is never touched.
 *
 * MediaLibrary permission must be granted by the caller before invoking.
 *
 * CRITICAL: if watermark preparation or the download fails, this throws —
 * the clean video is NEVER downloaded as a fallback.
 *
 * callbacks: { onProgress, onPreparingChange }
 */
export async function downloadWatermarkedVideoToGallery(video, callbacks = {}) {
  const { onProgress, onPreparingChange } = callbacks;

  if (!video?.id) {
    throw new Error('Video ID is missing.');
  }

  if (!isShareableVideo(video)) {
    throw new Error('Downloading is not available for livestreams yet.');
  }

  const fileUri =
    FileSystem.documentDirectory + `balagh_wm_${video.id}_${Date.now()}.mp4`;

  try {
    onPreparingChange?.(true);
    const { success, watermarkedUrl, error } =
      await requestWatermarkedVideo(video.id);
    onPreparingChange?.(false);

    if (!success || !watermarkedUrl) {
      throw new Error(error || 'Failed to prepare video for download.');
    }

    const downloadResumable = FileSystem.createDownloadResumable(
      watermarkedUrl,
      fileUri,
      {},
      ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
        if (totalBytesExpectedToWrite > 0) {
          onProgress?.(totalBytesWritten / totalBytesExpectedToWrite);
        }
      }
    );

    const result = await downloadResumable.downloadAsync();
    if (!result?.uri) throw new Error('Download failed');

    await MediaLibrary.saveToLibraryAsync(result.uri);
  } finally {
    // Always remove the temp file, including failure/cancellation paths.
    try {
      await FileSystem.deleteAsync(fileUri, { idempotent: true });
    } catch (e) {
      // Ignore cleanup errors.
    }
  }
}
