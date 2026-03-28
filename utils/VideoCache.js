import * as FileSystem from 'expo-file-system/legacy';

const CACHE_DIR = FileSystem.cacheDirectory + 'videos/';
const MAX_CACHE_SIZE_MB = 200;
const MAX_CACHE_FILES = 30;

class VideoCache {
  constructor() {
    this.ensureCacheDir();
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
    const hash = url.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    return CACHE_DIR + Math.abs(hash) + '.mp4';
  }

  async getCachedVideo(url) {
    if (!url) return url;
    
    // ✅ Skip caching for HLS streams - return original URL directly
    if (this.isHLSStream(url)) {
      console.log('[VideoCache] HLS stream - skipping cache, using direct URL:', url);
      return url;
    }
    
    const cacheFile = this.getCacheFileName(url);
    const fileInfo = await FileSystem.getInfoAsync(cacheFile);
    
    if (fileInfo.exists) {
      console.log('[VideoCache] Using cached:', cacheFile);
      return cacheFile;
    }
    
    return null;
  }

  async cacheVideo(url) {
    if (!url) return;
    
    // ✅ Skip caching for HLS streams
    if (this.isHLSStream(url)) {
      console.log('[VideoCache] HLS stream - skipping cache');
      return;
    }
    
    const cacheFile = this.getCacheFileName(url);
    const fileInfo = await FileSystem.getInfoAsync(cacheFile);
    
    if (fileInfo.exists) return;
    
    try {
      console.log('[VideoCache] Downloading:', url);
      await this.cleanupCacheIfNeeded();
      await FileSystem.downloadAsync(url, cacheFile, {
        headers: {
          'Accept': 'video/mp4,video/*',
        }
      });
      console.log('[VideoCache] Cached successfully:', cacheFile);
    } catch (error) {
      console.error('[VideoCache] Download failed:', error.message);
      try {
        await FileSystem.deleteAsync(cacheFile, { idempotent: true });
      } catch (e) {}
    }
  }

  async cleanupCacheIfNeeded() {
    try {
      const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
      if (files.length >= MAX_CACHE_FILES) {
        const fileStats = await Promise.all(
          files.map(async (file) => {
            const path = CACHE_DIR + file;
            const info = await FileSystem.getInfoAsync(path);
            return { path, modificationTime: info.modificationTime };
          })
        );
        fileStats.sort((a, b) => a.modificationTime - b.modificationTime);
        const toDelete = Math.ceil(files.length * 0.2);
        for (let i = 0; i < toDelete; i++) {
          await FileSystem.deleteAsync(fileStats[i].path);
        }
      }
    } catch (error) {
      console.error('[VideoCache] Cleanup error:', error);
    }
  }

  async clearCache() {
    try {
      const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
      await Promise.all(files.map(file => 
        FileSystem.deleteAsync(CACHE_DIR + file)
      ));
      console.log('[VideoCache] All cache cleared');
    } catch (error) {
      console.error('[VideoCache] Clear error:', error);
    }
  }
}

export const videoCache = new VideoCache();