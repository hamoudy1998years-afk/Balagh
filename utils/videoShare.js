import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { videoCache } from './VideoCache';
import { requestWatermarkedVideo } from './apiClient';

const SHARE_CACHE_DIR =
  FileSystem.cacheDirectory + 'video-shares/';

const STALE_FILE_AGE_MS =
  24 * 60 * 60 * 1000; // 24 hours

const MAX_SHARE_FILES = 50;
const MIN_VALID_FILE_BYTES = 50000;

/**
 * Tracks downloads already happening for a video so rapid/repeated
 * share attempts do not download the same watermarked file twice.
 */
const pendingShareDownloads = new Map();

/**
 * Returns true for normal MP4 videos that can be shared as a file.
 * Returns false for livestream types or HLS/livestream URLs
 * (.m3u8/.m3u).
 */
export function isShareableVideo(video) {
  const videoUrl = video?.video_url;

  return (
    !!videoUrl &&
    video?.type !== 'livestream' &&
    !videoCache.isHLSStream(videoUrl)
  );
}

/**
 * Use one deterministic local file per video.
 *
 * This allows a previously downloaded watermarked video to be reused
 * instead of downloading it again every time Share is pressed.
 */
function getShareCachePath(videoId) {
  return `${SHARE_CACHE_DIR}${videoId}.mp4`;
}

async function ensureShareDir() {
  const dirInfo =
    await FileSystem.getInfoAsync(
      SHARE_CACHE_DIR
    );

  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(
      SHARE_CACHE_DIR,
      {
        intermediates: true,
      }
    );
  }
}

async function validateFile(path) {
  try {
    const info =
      await FileSystem.getInfoAsync(path);

    return Boolean(
      info.exists &&
      info.size &&
      info.size >= MIN_VALID_FILE_BYTES
    );
  } catch (error) {
    return false;
  }
}

/**
 * Lazy cleanup of stale share files.
 *
 * Never deletes the file currently being shared.
 */
async function cleanupStaleShareFiles(
  currentPath
) {
  try {
    const dirInfo =
      await FileSystem.getInfoAsync(
        SHARE_CACHE_DIR
      );

    if (!dirInfo.exists) {
      return;
    }

    const files =
      await FileSystem.readDirectoryAsync(
        SHARE_CACHE_DIR
      );

    const now = Date.now();
    const stats = [];

    for (const file of files) {
      const path =
        SHARE_CACHE_DIR + file;

      if (path === currentPath) {
        continue;
      }

      const info =
        await FileSystem.getInfoAsync(path);

      if (!info.exists) {
        continue;
      }

      const modifiedMs =
        info.modificationTime
          ? info.modificationTime * 1000
          : now;

      const age =
        now - modifiedMs;

      if (age > STALE_FILE_AGE_MS) {
        await FileSystem.deleteAsync(
          path,
          {
            idempotent: true,
          }
        );
      } else {
        stats.push({
          path,
          modificationTime:
            modifiedMs,
        });
      }
    }

    /*
     * If there are still too many cached share files,
     * delete the oldest ones.
     */
    if (
      stats.length >
      MAX_SHARE_FILES
    ) {
      stats.sort(
        (a, b) =>
          a.modificationTime -
          b.modificationTime
      );

      const toDelete =
        stats.slice(
          0,
          stats.length -
            MAX_SHARE_FILES
        );

      for (const {
        path,
      } of toDelete) {
        await FileSystem.deleteAsync(
          path,
          {
            idempotent: true,
          }
        );
      }
    }
  } catch (error) {
    console.warn(
      '[videoShare] Cleanup error:',
      error
    );
  }
}

/**
 * Downloads the server-generated watermarked video only when it is
 * not already available in the local share cache.
 *
 * IMPORTANT:
 * - Never uses video.video_url as a fallback.
 * - Only downloads the URL returned by the watermark endpoint.
 * - Reuses an existing valid cached file.
 * - Deduplicates simultaneous downloads for the same video.
 */
async function getOrDownloadWatermarkedFile(
  videoId
) {
  await ensureShareDir();

  const sharePath =
    getShareCachePath(videoId);

  /*
   * Fast path:
   * reuse an already completed local watermarked copy.
   */
  if (
    await validateFile(sharePath)
  ) {
    return sharePath;
  }

  /*
   * IMPORTANT:
   * Check for an existing download BEFORE deleting or modifying
   * anything at sharePath. This prevents a second share request
   * from interfering with the first request.
   */
  const pending =
    pendingShareDownloads.get(
      videoId
    );

  if (pending) {
    return pending;
  }

  const downloadPromise =
    (async () => {
      const tempPath =
        `${sharePath}.part`;

      try {
        /*
         * Clean up any stale/invalid final or temporary file.
         * Only the owner of this download promise reaches here.
         */
        await FileSystem.deleteAsync(
          sharePath,
          {
            idempotent: true,
          }
        );

        await FileSystem.deleteAsync(
          tempPath,
          {
            idempotent: true,
          }
        );

        const {
          success,
          watermarkedUrl,
          error,
        } =
          await requestWatermarkedVideo(
            videoId
          );

        if (
          !success ||
          !watermarkedUrl
        ) {
          throw new Error(
            error ||
              'Failed to prepare video for sharing.'
          );
        }

        /*
         * Download into a temporary file first.
         * The permanent cache path is never exposed while incomplete.
         */
        const result =
          await FileSystem.downloadAsync(
            watermarkedUrl,
            tempPath,
            {
              headers: {
                Accept:
                  'video/mp4,video/*',
              },
            }
          );

        if (result.status !== 200) {
          throw new Error(
            `Download failed with status ${result.status}.`
          );
        }

        const tempValid =
          await validateFile(
            tempPath
          );

        if (!tempValid) {
          throw new Error(
            'Prepared video file is invalid.'
          );
        }

        /*
         * Promote the completed temporary file into the deterministic
         * cache location.
         */
        await FileSystem.moveAsync({
          from: tempPath,
          to: sharePath,
        });

        const finalValid =
          await validateFile(
            sharePath
          );

        if (!finalValid) {
          throw new Error(
            'Prepared video file is invalid.'
          );
        }

        return sharePath;
      } catch (error) {
        /*
         * Never leave partial/corrupt files behind.
         */
        try {
          await FileSystem.deleteAsync(
            tempPath,
            {
              idempotent: true,
            }
          );
        } catch (cleanupError) {
          // Ignore cleanup errors.
        }

        /*
         * Only remove the final cache file if it isn't valid.
         * Never destroy a previously completed good cache entry.
         */
        try {
          const finalValid =
            await validateFile(
              sharePath
            );

          if (!finalValid) {
            await FileSystem.deleteAsync(
              sharePath,
              {
                idempotent: true,
              }
            );
          }
        } catch (cleanupError) {
          // Ignore cleanup errors.
        }

        throw error;
      } finally {
        pendingShareDownloads.delete(
          videoId
        );
      }
    })();

  pendingShareDownloads.set(
    videoId,
    downloadPromise
  );

  return downloadPromise;
}

/**
 * Prepares and shares a watermarked video file.
 *
 * For HLS/livestreams, calls onError immediately with the livestream
 * message.
 *
 * For normal MP4s:
 *
 * 1. Reuse a valid locally cached watermarked file when available.
 * 2. Otherwise request the server's permanent watermarked version.
 * 3. Download that watermarked version into the local share cache.
 * 4. Open the native system share sheet.
 *
 * Guests can continue using this without logging in.
 *
 * CRITICAL:
 * If the watermark request or download fails, sharing fails.
 * The clean/original video is NEVER shared as a fallback.
 *
 * callbacks:
 * { onStart, onComplete, onError }
 */
export async function shareVideoFile(
  video,
  callbacks = {}
) {
  const {
    onStart,
    onComplete,
    onError,
  } = callbacks;

  const videoUrl =
    video?.video_url;

  if (!videoUrl) {
    onError?.(
      'Video URL is missing.'
    );
    return;
  }

  if (!isShareableVideo(video)) {
    onError?.(
      'Video sharing is not available for livestreams yet.'
    );
    return;
  }

  if (!video?.id) {
    onError?.(
      'Video ID is missing.'
    );
    return;
  }

  onStart?.();

  let sharePath = null;

  try {
    sharePath =
      await getOrDownloadWatermarkedFile(
        video.id
      );

    /*
     * Validate again immediately before sharing.
     */
    const valid =
      await validateFile(
        sharePath
      );

    if (!valid) {
      throw new Error(
        'Prepared video file is invalid.'
      );
    }

    /*
     * Clean stale files in the background.
     * Never delete the file currently being shared.
     */
    cleanupStaleShareFiles(
      sharePath
    ).catch(() => {});

    const isSharingAvailable =
      await Sharing.isAvailableAsync();

    if (!isSharingAvailable) {
      throw new Error(
        'Sharing is not available on this device.'
      );
    }

    await Sharing.shareAsync(
      sharePath,
      {
        mimeType: 'video/mp4',
        dialogTitle:
          'Share video',
        UTI: 'public.movie',
      }
    );

    onComplete?.();
  } catch (error) {
    console.error(
      '[videoShare] Error sharing video:',
      error
    );

    onError?.(
      error?.message ||
        'Failed to share video.'
    );

    /*
     * Do NOT delete a valid cached watermarked file just because
     * opening the system share sheet failed.
     *
     * getOrDownloadWatermarkedFile() already removes partial or
     * invalid downloads when preparation itself fails.
     */
  }
}