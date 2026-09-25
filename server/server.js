const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
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

// Shared Bushrann video links.
//
// Android:
// If Bushrann is installed and Android App Links verification succeeds,
// Android opens /video/:id directly in Bushrann before this page loads.
//
// Social crawlers:
// Facebook/Messenger and other crawlers receive Open Graph metadata
// containing the video's thumbnail and owner. Social crawlers are NOT
// redirected to Google Play, otherwise they would use the Play Store's
// generic Bushrann metadata instead of the video's metadata.
//
// Browser fallback:
// If Bushrann is not installed and a normal browser opens this page,
// the person is immediately redirected to Bushrann on Google Play.
app.get('/video/:id', async (req, res) => {
  const videoId = String(req.params.id || '').trim();

  const playStoreUrl =
    'https://play.google.com/store/apps/details?id=com.bushrann.app';

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
      `https://balagh-server-production.up.railway.app/video/` +
      encodeURIComponent(video.id);

    const title =
      username === 'Bushrann'
        ? 'Watch this video on Bushrann'
        : `${username} on Bushrann`;

    const description =
      'Watch this video on Bushrann — Muslim social videos, scholar livestreams, Quran & prayer.';

    const thumbnailUrl =
      typeof video.thumbnail_url === 'string'
        ? video.thumbnail_url.trim()
        : '';

    const safeTitle = escapeHtml(title);
    const safeDescription = escapeHtml(description);
    const safeShareUrl = escapeHtml(shareUrl);
    const safeThumbnailUrl = escapeHtml(thumbnailUrl);
    const safePlayStoreUrl = escapeHtml(playStoreUrl);

    const imageMetadata = safeThumbnailUrl
      ? `
  <meta property="og:image" content="${safeThumbnailUrl}" />
  <meta property="og:image:alt" content="${safeTitle}" />
  <meta name="twitter:image" content="${safeThumbnailUrl}" />`
      : '';

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

  <meta property="og:type" content="video.other" />
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