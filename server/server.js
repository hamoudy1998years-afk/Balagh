const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ==================== YOUR EXISTING TOKEN SERVER CODE ====================

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// Your existing token endpoint (keep this!)
app.get('/token', (req, res) => {
  const channelName = req.query.channelName;
  const uid = req.query.uid || 0;
  const role = req.query.role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const expirationTimeInSeconds = 3600;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  if (!channelName) {
    return res.status(400).json({ error: 'channelName is required' });
  }

  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channelName,
    uid,
    role,
    privilegeExpiredTs
  );

  res.json({ token, uid, channelName });
});

// ==================== NEW THUMBNAIL CAPTURE CODE ====================

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Store active capture sessions
const activeCaptures = new Map();

/**
 * Capture thumbnail from Agora stream using Puppeteer
 */
async function captureThumbnail(channelName, token = null) {
  console.log(`🎬 Starting browser for channel: ${channelName}`);

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 360 });

    // Create HTML page with Agora Web SDK
    const tokenStr = token ? `"${token}"` : 'null';
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <script src="https://download.agora.io/sdk/release/AgoraRTC_N-4.20.0.js"></script>
        <style>
          body { margin: 0; background: #000; overflow: hidden; }
          #video-container { width: 640px; height: 360px; }
          video { width: 100%; height: 100%; object-fit: cover; }
        </style>
      </head>
      <body>
        <div id="video-container"></div>
        <script>
          let client = null;
          
          async function joinChannel() {
            try {
              client = AgoraRTC.createClient({ mode: "live", codec: "vp8" });
              
              client.on("user-published", async (user, mediaType) => {
                await client.subscribe(user, mediaType);
                
                if (mediaType === "video") {
                  const videoTrack = user.videoTrack;
                  const container = document.getElementById("video-container");
                  container.innerHTML = "";
                  videoTrack.play(container);
                  window.videoReady = true;
                }
              });
              
              await client.join("${APP_ID}", "${channelName}", ${tokenStr}, 999999);
              
            } catch (err) {
              console.error("Join error:", err);
              window.joinError = err.message;
            }
          }
          
          joinChannel();
        </script>
      </body>
      </html>
    `;

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    // Wait for video (max 15 seconds)
    await page.waitForFunction(() => window.videoReady, { timeout: 15000 });
    console.log('✅ Video received, stabilizing...');
    
    // Wait for video to stabilize
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Capture screenshot
    const screenshot = await page.screenshot({ 
      type: 'jpeg', 
      quality: 85,
      clip: { x: 0, y: 0, width: 640, height: 360 }
    });
    
    console.log('📸 Screenshot captured');
    return screenshot;
    
  } finally {
    await browser.close();
    console.log('🔒 Browser closed');
  }
}

/**
 * Upload thumbnail to Supabase Storage
 */
async function uploadThumbnail(streamId, imageBuffer) {
  const timestamp = Date.now();
  const fileName = `thumbnails/${streamId}/${timestamp}.jpg`;
  
  const { data, error } = await supabase.storage
    .from('livestreams')
    .upload(fileName, imageBuffer, {
      contentType: 'image/jpeg',
      upsert: false
    });
    
  if (error) throw error;
  
  // Get public URL
  const { data: { publicUrl } } = supabase.storage
    .from('livestreams')
    .getPublicUrl(fileName);
    
  return publicUrl;
}

/**
 * Update stream thumbnail in database
 */
async function updateStreamThumbnail(streamId, thumbnailUrl) {
  const { error } = await supabase
    .from('streams')
    .update({ 
      thumbnail_url: thumbnailUrl,
      updated_at: new Date().toISOString()
    })
    .eq('id', streamId);
    
  if (error) throw error;
}

/**
 * Single capture and upload
 */
async function captureAndUpload(streamId, channelName, token) {
  console.log(`🚀 Capturing thumbnail for stream ${streamId}`);
  const screenshot = await captureThumbnail(channelName, token);
  const thumbnailUrl = await uploadThumbnail(streamId, screenshot);
  await updateStreamThumbnail(streamId, thumbnailUrl);
  console.log(`✅ Thumbnail updated: ${thumbnailUrl}`);
  return thumbnailUrl;
}

// ==================== NEW API ENDPOINTS ====================

/**
 * POST /api/thumbnail/start - Start capturing thumbnails every 30 seconds
 */
app.post('/api/thumbnail/start', async (req, res) => {
  try {
    const { streamId, channelName, token } = req.body;
    
    if (!streamId || !channelName) {
      return res.status(400).json({ error: 'streamId and channelName required' });
    }
    
    // Stop existing if any
    if (activeCaptures.has(streamId)) {
      clearInterval(activeCaptures.get(streamId));
    }
    
    // Capture immediately
    captureAndUpload(streamId, channelName, token).catch(console.error);
    
    // Then every 30 seconds
    const intervalId = setInterval(() => {
      captureAndUpload(streamId, channelName, token).catch(err => {
        console.error(`❌ Capture failed for ${streamId}:`, err);
      });
    }, 30000);
    
    activeCaptures.set(streamId, intervalId);
    
    res.json({ success: true, message: 'Thumbnail capture started', interval: 30000 });
    
  } catch (error) {
    console.error('Start error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/thumbnail/stop - Stop capturing thumbnails
 */
app.post('/api/thumbnail/stop', (req, res) => {
  const { streamId } = req.body;
  
  if (!streamId) {
    return res.status(400).json({ error: 'streamId required' });
  }
  
  if (activeCaptures.has(streamId)) {
    clearInterval(activeCaptures.get(streamId));
    activeCaptures.delete(streamId);
    console.log(`🛑 Stopped capture for ${streamId}`);
    res.json({ success: true, message: 'Capture stopped' });
  } else {
    res.json({ success: false, message: 'No active capture found' });
  }
});

/**
 * POST /api/thumbnail/capture - Single immediate capture
 */
app.post('/api/thumbnail/capture', async (req, res) => {
  try {
    const { streamId, channelName, token } = req.body;
    
    if (!streamId || !channelName) {
      return res.status(400).json({ error: 'streamId and channelName required' });
    }
    
    // Run in background
    captureAndUpload(streamId, channelName, token)
      .then(url => console.log(`✅ Captured: ${url}`))
      .catch(err => console.error(`❌ Failed:`, err));
    
    res.json({ success: true, message: 'Capture started' });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /health - Check server status
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeCaptures: activeCaptures.size,
    timestamp: new Date().toISOString()
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📹 Token endpoint: /token`);
  console.log(`🖼️  Thumbnail endpoints: /api/thumbnail/*`);
  console.log(`========================================`);
});