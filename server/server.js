const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

require('dotenv').config();

const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.set('trust proxy', true);

// Import routes
const recordingRoutes = require('./routes/recording');
const livekitRoutes = require('./routes/livekit');
const videoProcessingRoutes = require('./routes/videoProcessing');
const videoRoutes = require('./routes/videos');

// Importing starts the rejected-video cleanup sweeper (delayed first run).
require('./lib/rejectedVideoCleanup');

// Force HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }

    next();
  });
}

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(cors());
app.use(express.json());

// Legacy recording route.
//
// recording.js now exposes ONLY:
// GET /livestreams/:id/play
//
// The obsolete Agora recording-control endpoints have been removed:
// POST /start
// POST /stop
// POST /webhook
//
// This mount is retained so existing replay playback continues to use:
// GET /api/recording/livestreams/:id/play
app.use('/api/recording', recordingRoutes);

// Current LiveKit livestream backend
app.use('/api/livekit', livekitRoutes);

// Uploaded-video processing backend
app.use('/api/video-processing', videoProcessingRoutes);

// Video deletion/backend routes
app.use('/api/videos', videoRoutes);

// Android App Links verification for Bushrann.
//
// Android fetches this file to verify that this Railway domain
// is authorized to open links directly in the Bushrann app.
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.type('application/json');

  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.bushrann.app',
        sha256_cert_fingerprints: [
          'CB:8F:23:D5:15:5A:60:2C:5B:3F:EA:87:B4:8F:7A:87:6A:6C:33:5B:D4:C6:A4:42:AB:C3:33:AF:49:93:10:ED',
        ],
      },
    },
  ]);
});

// Escape database-derived text before inserting it into the
// public HTML preview page.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SHARE_BASE_URL =
  'https://balagh-server-production.up.railway.app';

const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.bushrann.app';

// Only allow the server to fetch thumbnail objects belonging to this
// Bushrann Supabase project's public thumbnails bucket.
function isAllowedThumbnailUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }

  const allowedPrefix =
    `${process.env.SUPABASE_URL}` +
    '/storage/v1/object/public/thumbnails/';

  return url.startsWith(allowedPrefix);
}

// Dedicated Facebook/social preview.
//
// The original Bushrann thumbnail remains untouched. This endpoint
// converts the existing portrait thumbnail into a Facebook-friendly
// 1200x630 JPEG.
//
// "contain" preserves the entire original thumbnail without cropping it.
// The remaining horizontal space is filled with black.
app.get('/video/:id/social-preview.jpg', async (req, res) => {
  const videoId = String(req.params.id || '').trim();

  if (!videoId) {
    return res.status(404).end();
  }

  try {
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .select(
        'id, thumbnail_url, is_private, status, processing_status'
      )
      .eq('id', videoId)
      .maybeSingle();

    // Never expose a social image for a video that is missing,
    // private, unapproved, or not ready.
    if (
      videoError ||
      !video ||
      video.is_private ||
      video.status !== 'approved' ||
      video.processing_status !== 'ready' ||
      !isAllowedThumbnailUrl(video.thumbnail_url)
    ) {
      return res.status(404).end();
    }

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 10000);

    let thumbnailResponse;

    try {
      thumbnailResponse = await fetch(video.thumbnail_url, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!thumbnailResponse.ok) {
      console.warn(
        '[VIDEO SHARE] Thumbnail fetch failed:',
        videoId,
        thumbnailResponse.status
      );

      return res.status(502).end();
    }

    const contentType =
      thumbnailResponse.headers.get('content-type') || '';

    if (!contentType.toLowerCase().startsWith('image/')) {
      console.warn(
        '[VIDEO SHARE] Thumbnail response was not an image:',
        videoId,
        contentType
      );

      return res.status(502).end();
    }

    const arrayBuffer = await thumbnailResponse.arrayBuffer();
    const thumbnailBuffer = Buffer.from(arrayBuffer);

    if (thumbnailBuffer.length === 0) {
      return res.status(502).end();
    }

    const background = await sharp(thumbnailBuffer)
      .rotate()
      .resize(1200, 630, {
        fit: 'cover',
      })
      .blur(25)
      .jpeg()
      .toBuffer();

    const foreground = await sharp(thumbnailBuffer)
      .rotate()
      .resize(1200, 630, {
        fit: 'contain',
        background: {
          r: 0,
          g: 0,
          b: 0,
          alpha: 0,
        },
      })
      .png()
      .toBuffer();

    const socialPreview = await sharp(background)
      .composite([
        {
          input: foreground,
          gravity: 'center',
        },
      ])
      .jpeg({
        quality: 88,
        progressive: true,
      })
      .toBuffer();

    // Facebook may cache this deterministic preview aggressively.
    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': String(socialPreview.length),
      'Cache-Control': 'public, max-age=86400',
    });

    return res.status(200).send(socialPreview);
  } catch (error) {
    console.error(
      '[VIDEO SHARE] Social preview generation failed:',
      videoId,
      error?.message || error
    );

    return res.status(500).end();
  }
});

// Shared Bushrann video links.
//
// Android:
// If Bushrann is installed and Android App Links verification succeeds,
// Android opens /video/:id directly in Bushrann before this page loads.
//
// Social crawlers:
// Facebook/Messenger and other crawlers receive Open Graph metadata
// containing the video's social-preview image and owner. Social crawlers
// are NOT redirected to Google Play, otherwise they would use the Play
// Store's generic Bushrann metadata instead of the video's metadata.
//
// Browser fallback:
// If Bushrann is not installed and a normal browser opens this page,
// the person is immediately redirected to Bushrann on Google Play.
app.get('/video/:id', async (req, res) => {
  const videoId = String(req.params.id || '').trim();

  const playStoreUrl = PLAY_STORE_URL;

  if (!videoId) {
    return res.redirect(302, playStoreUrl);
  }

  try {
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .select(
        'id, user_id, thumbnail_url, is_private, status, processing_status'
      )
      .eq('id', videoId)
      .maybeSingle();

    // Never expose preview metadata for a video that is missing,
    // private, unapproved, or not ready.
    if (
      videoError ||
      !video ||
      video.is_private ||
      video.status !== 'approved' ||
      video.processing_status !== 'ready'
    ) {
      return res.redirect(302, playStoreUrl);
    }

    // Resolve the owner from the server rather than trusting anything
    // supplied by the shared URL/client.
    let username = 'Bushrann';

    if (video.user_id) {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', video.user_id)
        .maybeSingle();

      if (
        !profileError &&
        typeof profile?.username === 'string' &&
        profile.username.trim().length > 0
      ) {
        username = `@${profile.username.trim()}`;
      }
    }

    const shareUrl =
      `${SHARE_BASE_URL}/video/` +
      encodeURIComponent(video.id);

    const socialPreviewUrl =
      `${SHARE_BASE_URL}/video/` +
      encodeURIComponent(video.id) +
      '/social-preview.jpg';

    const title =
      username === 'Bushrann'
        ? 'Watch this video on Bushrann'
        : `${username} on Bushrann`;

    const description =
      'Watch this video on Bushrann — Muslim social videos, scholar livestreams, Quran & prayer.';

    const safeTitle = escapeHtml(title);
    const safeDescription = escapeHtml(description);
    const safeShareUrl = escapeHtml(shareUrl);
    const safeSocialPreviewUrl = escapeHtml(socialPreviewUrl);
    const safePlayStoreUrl = escapeHtml(playStoreUrl);

    const imageMetadata = `
  <meta property="og:image" content="${safeSocialPreviewUrl}" />
  <meta property="og:image:secure_url" content="${safeSocialPreviewUrl}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${safeTitle}" />
  <meta name="twitter:image" content="${safeSocialPreviewUrl}" />`;

    // Social crawlers must remain on the Bushrann video page so they
    // can read the video's Open Graph metadata instead of following
    // the Google Play fallback.
    const userAgent = String(req.get('user-agent') || '');

    const isSocialCrawler =
      /facebookexternalhit|Facebot|Twitterbot|LinkedInBot|WhatsApp|TelegramBot|Discordbot|Slackbot/i.test(
        userAgent
      );

    // Normal browser visitors without the app should go to Google Play.
    // Social crawlers must NOT receive this meta refresh.
    const browserFallback = isSocialCrawler
      ? ''
      : `<meta http-equiv="refresh" content="0;url=${safePlayStoreUrl}" />`;

    res.status(200);
    res.type('html');

    return res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />

  <title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}" />

  <link rel="canonical" href="${safeShareUrl}" />

  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Bushrann" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDescription}" />
  <meta property="og:url" content="${safeShareUrl}" />
  ${imageMetadata}

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDescription}" />

  ${browserFallback}
</head>

<body>
  <p>
    Opening Bushrann…
    <a href="${safePlayStoreUrl}">Continue to Google Play</a>
  </p>
</body>
</html>`);
  } catch (error) {
    console.error(
      '[VIDEO SHARE] Preview page failed:',
      videoId,
      error?.message || error
    );

    return res.redirect(302, playStoreUrl);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('========================================');
    console.log('🚀 Server running on port', PORT);
    console.log('🎥 LiveKit API: /api/livekit');
    console.log('🎞️ Video processing API: /api/video-processing');
    console.log('▶️ Replay playback: /api/recording/livestreams/:id/play');
    console.log('========================================');
  }
});