import * as FileSystem from 'expo-file-system/legacy';

// Versioned cache directory. The old 'videos/' dir is intentionally left
// untouched: legacy partial files in it are never read again, and files an
// active player might still hold are never deleted out from under it.
const CACHE_DIR = FileSystem.cacheDirectory + 'videos_v2/';
const MAX_CACHE_SIZE_MB = 200;
const MAX_CACHE_FILES = 30;

class VideoCache {
  constructor() {
    this.cacheDirReady = this.ensureCacheDir();
    // URL -> in-flight download promise (dedupes concurrent downloads)
    this.inFlight = new Map();
    this.downloadQueue = Promise.resolve();
    // Cached files currently held by video players.
    // URI -> number of players using that file.
    this.activeFiles = new Map();
    // Prevent multiple cache cleanup operations from running together.
    this.cleanupPromise = null;
  }

  retainCachedVideo(uri) {
    if (!uri || !uri.startsWith(CACHE_DIR)) return;

    const count = this.activeFiles.get(uri) ?? 0;
    this.activeFiles.set(uri, count + 1);
  }

  releaseCachedVideo(uri) {
    if (!uri || !uri.startsWith(CACHE_DIR)) return;

    const count = this.activeFiles.get(uri) ?? 0;

    if (count <= 1) {
      this.activeFiles.delete(uri);
    } else {
      this.activeFiles.set(uri, count - 1);
    }
  }

  async ensureCacheDir() {
    const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    }
  }

  // ✅ Check if URL is HLS stream
  isHLSStream(url) {
    return url && (url.includes('.m3u8') || url.includes('.m3u'));
  }

  getCacheFileName(url) {
    // 64-bit FNV-1a hash for a much lower collision risk.
    // Keep this synchronous so existing callers need no changes.
    const bytes = new TextEncoder().encode(url);
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;

    for (const byte of bytes) {
      hash ^= BigInt(byte);
      hash = (hash * prime) & mask;
    }

    const hashString = hash.toString(16).padStart(16, '0');

    // Preserve the original video file extension.
    const cleanUrl = url.split('?')[0].split('#')[0];
    const match = cleanUrl.match(/\.([a-zA-Z0-9]{2,5})$/);
    const ext = match?.[1]?.toLowerCase();

    const allowedExtensions = new Set([
      'mp4', 'mov', 'm4v', 'webm', '3gp', 'mkv',
    ]);

    const safeExt = allowedExtensions.has(ext) ? ext : 'mp4';

    return `${CACHE_DIR}${hashString}.${safeExt}`;
  }

  async getCachedVideo(url) {
    if (!url) return url;
    await this.cacheDirReady;
    
    // ✅ Skip caching for HLS streams - return original URL directly
    if (this.isHLSStream(url)) {
      console.log('[VideoCache] HLS stream - skipping cache, using direct URL:', url);
      return url;
    }
    
    const cacheFile = this.getCacheFileName(url);
    const fileInfo = await FileSystem.getInfoAsync(cacheFile);
    
    if (fileInfo.exists) {
      if (!fileInfo.size || fileInfo.size < 50000) {
        console.warn('[VideoCache] Corrupt/incomplete cached file — discarding:', cacheFile);
        await FileSystem.deleteAsync(cacheFile, { idempotent: true });
        return null;
      }
      __DEV__ && console.log(`[VIDEO DIAG] cache HIT file=${cacheFile.split('/').pop()} size=${fileInfo.size}`);
      return cacheFile;
    }

    __DEV__ && console.log(`[VIDEO DIAG] cache MISS file=${cacheFile.split('/').pop()}`);

    // Never return an in-progress or temporary download.
    if (this.inFlight.has(url)) {
      return null;
    }
    
    return null;
  }

  getTempFileName(url) {
    return this.getCacheFileName(url) + '.tmp.part';
  }

  async cacheVideo(url) {
    if (!url) return;
    
    // Skip caching for HLS streams
    if (this.isHLSStream(url)) {
      console.log('[VideoCache] HLS stream - skipping cache');
      return;
    }

    // Deduplicate concurrent downloads of the same URL
    if (this.inFlight.has(url)) {
      return this.inFlight.get(url);
    }

    const promise = this.downloadQueue.then(() => this._downloadAndCache(url));
    this.downloadQueue = promise.catch(() => {});
    this.inFlight.set(url, promise);
    try {
      await promise;
    } finally {
      this.inFlight.delete(url);
    }
  }

  async _downloadAndCache(url) {
    await this.cacheDirReady;

    // Do not download while startup eviction is running.
    if (this.cleanupPromise) {
      await this.cleanupPromise;
    }

    const cacheFile = this.getCacheFileName(url);
    const tempFile = this.getTempFileName(url);

    // If a completed file appeared since (e.g. from a deduped caller), do nothing.
    const existing = await FileSystem.getInfoAsync(cacheFile);
    if (existing.exists) return;

    try {
      console.log('[VideoCache] Downloading:', url);

      // Temporarily disable automatic eviction.
      // VideoCard can still be playing a cached file.
      // Re-enable only after active-file protection is implemented.

      // Download to a temporary file so the final cache name is never partial.
      const result = await FileSystem.downloadAsync(url, tempFile, {
        headers: { 'Accept': 'video/mp4,video/*' }
      });

      // Verify the download actually completed with a valid status
      if (result.status !== 200) {
        console.warn('[VideoCache] Bad status', result.status, '— discarding temp:', tempFile);
        await FileSystem.deleteAsync(tempFile, { idempotent: true });
        return;
      }

      const saved = await FileSystem.getInfoAsync(tempFile);

      // Verify the file is large enough to be a real MP4 (min 50KB)
      if (!saved.exists || !saved.size || saved.size < 50000) {
        console.warn('[VideoCache] File too small or missing — discarding temp:', tempFile);
        await FileSystem.deleteAsync(tempFile, { idempotent: true });
        return;
      }

      // Validate actual size against Content-Length. Promotion requires a
      // trustworthy expected length; without it the file is never promoted,
      // so playback falls back to the remote URL.
      const contentLengthHeader =
        result.headers?.['Content-Length'] ??
        result.headers?.['content-length'];
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        console.warn('[VideoCache] No trustworthy Content-Length — discarding temp:', tempFile);
        await FileSystem.deleteAsync(tempFile, { idempotent: true });
        return;
      }
      if (saved.size !== contentLength) {
        console.warn(
          `[VideoCache] Size mismatch: got ${saved.size} bytes, expected ${contentLength} — discarding temp:`,
          tempFile
        );
        await FileSystem.deleteAsync(tempFile, { idempotent: true });
        return;
      }

      // Promote the validated temp file to the final cache filename.
      // Only replace an existing file if we are sure it's ours to replace.
      const finalInfo = await FileSystem.getInfoAsync(cacheFile);
      if (finalInfo.exists) {
        // A completed file already exists (another deduped path promoted it).
        await FileSystem.deleteAsync(tempFile, { idempotent: true });
        return;
      }
      await FileSystem.moveAsync({ from: tempFile, to: cacheFile });

      console.log('[VideoCache] Cached successfully:', cacheFile, `(${(saved.size / 1024 / 1024).toFixed(2)} MB)`);
    } catch (error) {
      console.error('[VideoCache] Download failed:', error.message);
      // Clean up only the temporary file; a valid completed cache file is untouched.
      try {
        await FileSystem.deleteAsync(tempFile, { idempotent: true });
      } catch (e) {}
    }
  }

  async getCacheStats() {
    await this.cacheDirReady;

    const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
    const completedFiles = files.filter(
      file => !file.endsWith('.tmp.part')
    );

    const sizes = await Promise.all(
      completedFiles.map(async file => {
        const info = await FileSystem.getInfoAsync(CACHE_DIR + file);
        return info.exists ? (info.size ?? 0) : 0;
      })
    );

    const totalBytes = sizes.reduce((sum, size) => sum + size, 0);

    return {
      files: completedFiles.length,
      sizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
    };
  }

  async cleanupCacheIfNeeded() {
    if (this.cleanupPromise) return this.cleanupPromise;

    this.cleanupPromise = (async () => {
      try {
        await this.cacheDirReady;

        const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
        const completedFiles = files.filter(
          file => !file.endsWith('.tmp.part')
        );

        const stats = await Promise.all(
          completedFiles.map(async file => {
            const path = CACHE_DIR + file;
            const info = await FileSystem.getInfoAsync(path);

            return {
              path,
              size: info.exists ? (info.size ?? 0) : 0,
              modified: info.modificationTime ?? 0,
              exists: info.exists,
            };
          })
        );

        const existing = stats.filter(file => file.exists);
        let totalBytes = existing.reduce((sum, file) => sum + file.size, 0);
        let totalFiles = existing.length;

        const maxBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;

        // Oldest files first.
        existing.sort((a, b) => a.modified - b.modified);

        for (const file of existing) {
          if (totalBytes <= maxBytes && totalFiles <= MAX_CACHE_FILES) {
            break;
          }

          // Never delete a file currently referenced by a VideoCard.
          if (this.activeFiles.has(file.path)) continue;

          await FileSystem.deleteAsync(file.path, { idempotent: true });

          totalBytes -= file.size;
          totalFiles -= 1;

          __DEV__ && console.log(
            `[VIDEO DIAG] cache EVICT file=${file.path.split('/').pop()}`
          );
        }
      } catch (error) {
        console.error('[VideoCache] Cleanup error:', error);
      }
    })();

    try {
      await this.cleanupPromise;
    } finally {
      this.cleanupPromise = null;
    }
  }

  async removeCachedVideo(url) {
    if (!url) return;

    await this.cacheDirReady;

    const cacheFile = this.getCacheFileName(url);

    // Do not delete a file currently referenced by a video player.
    if (this.activeFiles.has(cacheFile)) {
      __DEV__ && console.log(
        '[VideoCache] Skipping removal of active file:',
        cacheFile
      );
      return;
    }

    try {
      await FileSystem.deleteAsync(cacheFile, { idempotent: true });
    } catch (error) {
      console.warn('[VideoCache] Remove failed:', error);
    }
  }

  async clearCache() {
    try {
      await this.cacheDirReady;

      const files = await FileSystem.readDirectoryAsync(CACHE_DIR);

      for (const file of files) {
        const path = CACHE_DIR + file;

        // Never delete a file currently used by VideoCard.
        if (this.activeFiles.has(path)) continue;

        await FileSystem.deleteAsync(path, { idempotent: true });
      }

      console.log('[VideoCache] Cleared unprotected cache files');
    } catch (error) {
      console.error('[VideoCache] Clear error:', error);
    }
  }
}

export const videoCache = new VideoCache();