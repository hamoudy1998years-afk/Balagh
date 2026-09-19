import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { videoCache } from './VideoCache';

const SHARE_CACHE_DIR = FileSystem.cacheDirectory + 'video-shares/';
const STALE_FILE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SHARE_FILES = 50;
const MIN_VALID_FILE_BYTES = 50000;

/**
 * Returns true for normal MP4 videos that can be shared as a file.
 * Returns false for livestream types or HLS/livestream URLs (.m3u8/.m3u).
 */
export function isShareableVideo(video) {
  const videoUrl = video?.video_url;
  return !!videoUrl && video?.type !== 'livestream' && !videoCache.isHLSStream(videoUrl);
}

function getUniqueShareFileName(videoId) {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  return `${SHARE_CACHE_DIR}${videoId || 'unknown'}_${suffix}.mp4`;
}

async function ensureShareDir() {
  const dirInfo = await FileSystem.getInfoAsync(SHARE_CACHE_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(SHARE_CACHE_DIR, { intermediates: true });
  }
}

async function validateFile(path) {
  const info = await FileSystem.getInfoAsync(path);
  return info.exists && info.size && info.size >= MIN_VALID_FILE_BYTES;
}

/**
 * Lazy cleanup of stale share files.
 * Never deletes the file currently being shared.
 */
async function cleanupStaleShareFiles(currentPath) {
  try {
    const dirInfo = await FileSystem.getInfoAsync(SHARE_CACHE_DIR);
    if (!dirInfo.exists) return;

    const files = await FileSystem.readDirectoryAsync(SHARE_CACHE_DIR);
    const now = Date.now();
    const stats = [];

    for (const file of files) {
      const path = SHARE_CACHE_DIR + file;
      if (path === currentPath) continue;

      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) continue;

      const modifiedMs = info.modificationTime ? info.modificationTime * 1000 : now;
      const age = now - modifiedMs;
      if (age > STALE_FILE_AGE_MS) {
        await FileSystem.deleteAsync(path, { idempotent: true });
      } else {
        stats.push({ path, modificationTime: modifiedMs });
      }
    }

    // If there are still too many files, delete the oldest ones.
    if (stats.length > MAX_SHARE_FILES) {
      stats.sort((a, b) => a.modificationTime - b.modificationTime);
      const toDelete = stats.slice(0, stats.length - MAX_SHARE_FILES);
      for (const { path } of toDelete) {
        await FileSystem.deleteAsync(path, { idempotent: true });
      }
    }
  } catch (error) {
    console.warn('[videoShare] Cleanup error:', error);
  }
}

/**
 * Prepares and shares a video file.
 *
 * For HLS/livestreams, calls onError immediately with the livestream message.
 * For normal MP4s, copies from the validated video cache if available,
 * otherwise downloads directly to a unique temporary file, then opens the
 * system share sheet. Guests can use this without logging in.
 *
 * callbacks: { onStart, onComplete, onError }
 */
export async function shareVideoFile(video, callbacks = {}) {
  const { onStart, onComplete, onError } = callbacks;
  const videoUrl = video?.video_url;

  if (!videoUrl) {
    onError?.('Video URL is missing.');
    return;
  }

  if (!isShareableVideo(video)) {
    onError?.('Video sharing is not available for livestreams yet.');
    return;
  }

  onStart?.();

  let sharePath = null;

  try {
    await ensureShareDir();
    sharePath = getUniqueShareFileName(video.id);

    const cachedPath = await videoCache.getCachedVideo(videoUrl);

    if (cachedPath) {
      const valid = await validateFile(cachedPath);
      if (!valid) {
        throw new Error('Cached video file is invalid.');
      }
      await FileSystem.copyAsync({ from: cachedPath, to: sharePath });
    } else {
      const result = await FileSystem.downloadAsync(videoUrl, sharePath, {
        headers: { Accept: 'video/mp4,video/*' },
      });

      if (result.status !== 200) {
        throw new Error(`Download failed with status ${result.status}.`);
      }
    }

    const valid = await validateFile(sharePath);
    if (!valid) {
      throw new Error('Prepared video file is invalid.');
    }

    // Clean up stale files in the background; never delete the file we are sharing.
    cleanupStaleShareFiles(sharePath).catch(() => {});

    const isSharingAvailable = await Sharing.isAvailableAsync();
    if (!isSharingAvailable) {
      throw new Error('Sharing is not available on this device.');
    }

    await Sharing.shareAsync(sharePath, {
      mimeType: 'video/mp4',
      dialogTitle: 'Share video',
      UTI: 'public.movie',
    });

    onComplete?.();
  } catch (error) {
    console.error('[videoShare] Error sharing video:', error);
    onError?.(error?.message || 'Failed to share video.');

    // Best-effort removal of the failed temp file.
    if (sharePath) {
      try {
        await FileSystem.deleteAsync(sharePath, { idempotent: true });
      } catch (e) {
        // Ignore cleanup errors.
      }
    }
  }
}
