const express = require('express');
const {
  GetObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const {
  getSignedUrl,
} = require('@aws-sdk/s3-request-presigner');
const {
  createClient,
} = require('@supabase/supabase-js');

const router = express.Router();

const s3Client = new S3Client({
  region: process.env.S3_REGION || 'ap-southeast-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// -----------------------------------------------------------------------------
// LEGACY LIVESTREAM REPLAY PLAYBACK
// -----------------------------------------------------------------------------
//
// Bushrann's active livestream/recording system now uses LiveKit.
//
// The obsolete Agora recording-control endpoints have intentionally been
// removed from this router:
//
//   POST /start
//   POST /stop
//   POST /webhook
//
// This playback endpoint is retained because existing livestream replay
// records may still reference private S3 objects that require a temporary
// signed URL.
// -----------------------------------------------------------------------------

router.get('/livestreams/:id/play', async (req, res) => {
  try {
    const livestreamId = req.params.id;

    console.log(
      '[SIGNED URL] Request for livestream:',
      livestreamId
    );

    // Get only the stored video URL for this replay.
    const {
      data: livestream,
      error,
    } = await supabase
      .from('livestreams')
      .select('video_url, is_public')
      .eq('id', livestreamId)
      .eq('is_public', true)
      .maybeSingle();

    if (error || !livestream) {
      console.error(
        '[SIGNED URL] Livestream not found:',
        livestreamId
      );

      return res.status(404).json({
        error: 'Livestream not found',
      });
    }

    if (
      !livestream.video_url ||
      typeof livestream.video_url !== 'string'
    ) {
      console.error(
        '[SIGNED URL] Livestream has no valid video URL:',
        livestreamId
      );

      return res.status(404).json({
        error: 'Livestream video not found',
      });
    }

    // Existing legacy replay URL format:
    //
    // https://<bucket>.s3.<region>.amazonaws.com/livestreams/<filename>
    //
    // Only the object key after /livestreams/ is used.
    const marker = '/livestreams/';
    const markerIndex = livestream.video_url.indexOf(marker);

    if (markerIndex === -1) {
      console.error(
        '[SIGNED URL] Invalid URL format:',
        livestream.video_url
      );

      return res.status(500).json({
        error: 'Invalid video URL format',
      });
    }

    const fileName = livestream.video_url.slice(
      markerIndex + marker.length
    );

    if (!fileName) {
      console.error(
        '[SIGNED URL] Missing S3 filename:',
        livestream.video_url
      );

      return res.status(500).json({
        error: 'Invalid video URL format',
      });
    }

    const s3Key = `livestreams/${fileName}`;

    console.log(
      '[SIGNED URL] Generating signed URL for key:',
      s3Key
    );

    const command = new GetObjectCommand({
      Bucket:
        process.env.S3_BUCKET_NAME ||
        'balagh-livestreams',
      Key: s3Key,
    });

    // Temporary signed playback URL valid for 1 hour.
    const signedUrl = await getSignedUrl(
      s3Client,
      command,
      {
        expiresIn: 3600,
      }
    );

    console.log(
      '[SIGNED URL] Generated successfully'
    );

    return res.json({
      signedUrl,
      expiresIn: 3600,
      originalUrl: livestream.video_url,
    });
  } catch (err) {
    console.error(
      '[SIGNED URL] Error:',
      err
    );

    return res.status(500).json({
      error: 'Failed to generate signed URL',
    });
  }
});

module.exports = router;