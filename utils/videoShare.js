import { videoCache } from './VideoCache';

/**
 * Returns true for normal MP4 videos.
 * Returns false for livestream types or HLS/livestream URLs
 * (.m3u8/.m3u).
 *
 * Used by the download flow to reject livestream/HLS videos.
 */
export function isShareableVideo(video) {
  const videoUrl = video?.video_url;

  return (
    !!videoUrl &&
    video?.type !== 'livestream' &&
    !videoCache.isHLSStream(videoUrl)
  );
}