import * as FileSystem from 'expo-file-system/legacy';

const CACHE_DIR = FileSystem.cacheDirectory + 'videos/';
const MAX_CACHE_SIZE_MB = 200; // 200MB limit
const MAX_CACHE_FILES = 30; // Max 30 videos

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

  getCacheFileName(url) {
    // Create hash from URL for filename
    const hash = url.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    return CACHE_DIR + Math.abs(hash) + '.mp4';
  }

  async getCachedVideo(url) {
    if (!url) return url;
    
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
    
    const cacheFile = this.getCacheFileName(url);
    const fileInfo = await FileSystem.getInfoAsync(cacheFile);
    
    if (fileInfo.exists) return; // Already cached
    
    try {
      console.log('[VideoCache] Downloading:', url);
      
      // Check cache size before downloading
      await this.cleanupCacheIfNeeded();
      
      // Download to cache
      await FileSystem.downloadAsync(url, cacheFile, {
        headers: {
          'Accept': 'video/mp4,video/*',
        }
      });
      
      console.log('[VideoCache] Cached successfully:', cacheFile);
    } catch (error) {
      console.error('[VideoCache] Download failed:', error.message);
      // Clean up partial file if exists
      try {
        await FileSystem.deleteAsync(cacheFile, { idempotent: true });
      } catch (e) {}
    }
  }

  async cleanupCacheIfNeeded() {
    try {
      const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
      
      if (files.length >= MAX_CACHE_FILES) {
        // Get file stats to find oldest
        const fileStats = await Promise.all(
          files.map(async (file) => {
            const path = CACHE_DIR + file;
            const info = await FileSystem.getInfoAsync(path);
            return { path, modificationTime: info.modificationTime };
          })
        );
        
        // Sort by oldest first
        fileStats.sort((a, b) => a.modificationTime - b.modificationTime);
        
        // Delete oldest 20% of files
        const toDelete = Math.ceil(files.length * 0.2);
        for (let i = 0; i < toDelete; i++) {
          await FileSystem.deleteAsync(fileStats[i].path);
          console.log('[VideoCache] Cleaned up old file:', fileStats[i].path);
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
