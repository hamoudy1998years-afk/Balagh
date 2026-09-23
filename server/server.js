const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

require('dotenv').config();

const app = express();

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

// Video deletion backend (owner + admin)
app.use('/api/videos', videoRoutes);

// Android App Links verification for Bushrann.
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

// Fallback for shared Bushrann video links.
//
// If Bushrann is installed and Android App Links verification succeeds,
// Android opens the matching /video/:id URL directly in Bushrann,
// so this route is never reached.
//
// If Bushrann is not installed, the browser reaches this route and
// sends the user to Bushrann on Google Play.
app.get('/video/:id', (req, res) => {
  const videoId = String(req.params.id || '').trim();

  if (!videoId) {
    return res.redirect(
      302,
      'https://play.google.com/store/apps/details?id=com.bushrann.app'
    );
  }

  return res.redirect(
    302,
    'https://play.google.com/store/apps/details?id=com.bushrann.app'
  );
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