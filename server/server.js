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