const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── GENERATE LIVEKIT TOKEN ──────────────────────────────────────
router.post('/token', async (req, res) => {
  try {
    const { roomName, userId, isHost } = req.body;

    if (!roomName || !userId) {
      return res.status(400).json({ error: 'Missing roomName or userId' });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      return res.status(500).json({ error: 'LiveKit credentials not configured' });
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: apiKey,
      sub: userId,
      iat: now,
      exp: now + (2 * 60 * 60),
      nbf: now,
      video: {
        room: roomName,
        roomJoin: true,
        canPublish: isHost === true,
        canSubscribe: true,
        canPublishData: true,
      }
    };

    const token = jwt.sign(payload, apiSecret, { algorithm: 'HS256' });
    console.log('[LIVEKIT] Token generated successfully');

    res.json({
      token,
      url: process.env.LIVEKIT_URL,
      roomName,
    });
  } catch (error) {
    console.error('[LIVEKIT] Token error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── START EGRESS RECORDING ──────────────────────────────────────
router.post('/egress/start', async (req, res) => {
  try {
    const { roomName } = req.body;

    if (!roomName) {
      return res.status(400).json({ error: 'Missing roomName' });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL?.replace('wss://', 'https://');

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: apiKey,
      sub: apiKey,
      iat: now,
      exp: now + 3600,
      video: { roomCreate: true, roomRecord: true }
    };
    const token = jwt.sign(payload, apiSecret, { algorithm: 'HS256' });

    const filename = `${roomName}_${Date.now()}.mp4`;

    // Use LiveKit's own storage (no S3 needed)
    const response = await axios.post(
      `${livekitUrl}/twirp/livekit.Egress/StartRoomCompositeEgress`,
      {
        room_name: roomName,
        layout: 'speaker',
        file: {
          filepath: filename,
          s3: {
            access_key: process.env.AWS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
            secret: process.env.AWS_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
            region: process.env.S3_REGION || 'ap-southeast-2',
            bucket: process.env.S3_BUCKET_NAME,
          }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        }
      }
    );

    console.log('[EGRESS] Recording started:', response.data.egress_id);
    res.json({ egressId: response.data.egress_id, filename });

  } catch (error) {
    console.error('[EGRESS] Start error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── STOP EGRESS AND SAVE REPLAY ─────────────────────────────────
router.post('/egress/stop', async (req, res) => {
  try {
    const { egressId, userId, title, thumbnailUrl } = req.body;

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL?.replace('wss://', 'https://');

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: apiKey,
      sub: apiKey,
      iat: now,
      exp: now + 3600,
      video: { roomCreate: true, roomRecord: true }
    };
    const token = jwt.sign(payload, apiSecret, { algorithm: 'HS256' });

    // Stop the egress
    const stopResponse = await axios.post(
      `${livekitUrl}/twirp/livekit.Egress/StopEgress`,
      { egress_id: egressId },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        }
      }
    );

    console.log('[EGRESS] Stopped:', egressId);

    // Get the download URL from LiveKit
    const egressInfo = stopResponse.data;
    // Poll LiveKit for the download URL
let downloadUrl = null;
let attempts = 0;
const maxAttempts = 20;

while (!downloadUrl && attempts < maxAttempts) {
  attempts++;
  console.log(`[EGRESS] Polling for download URL (attempt ${attempts})...`);
  
  await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds
  
  const listResponse = await axios.post(
    `${livekitUrl}/twirp/livekit.Egress/ListEgress`,
    { egress_id: egressId },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
    }
  );
  
  const egress = listResponse.data?.items?.[0];
  downloadUrl = egress?.file_results?.[0]?.download_url 
    || egress?.file?.download_url 
    || null;
    
  console.log(`[EGRESS] Status: ${egress?.status}, Download URL: ${downloadUrl}`);
  
  if (egress?.status === 'EGRESS_FAILED') {
    console.error('[EGRESS] Egress failed!');
    break;
  }
}

    console.log('[EGRESS] Download URL from LiveKit:', downloadUrl);

    if (downloadUrl && userId) {
      // Download the file from LiveKit
      console.log('[EGRESS] Downloading MP4 from LiveKit...');
      const videoResponse = await axios.get(downloadUrl, { 
        responseType: 'arraybuffer',
        timeout: 300000 // 5 min timeout for large files
      });

      const buffer = Buffer.from(videoResponse.data);
      const fileName = `${egressId}_${Date.now()}.mp4`;

      console.log('[EGRESS] Uploading to Supabase Storage...');

      // Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('livestreams')
        .upload(fileName, buffer, {
          contentType: 'video/mp4',
          upsert: true,
        });

      if (uploadError) {
        console.error('[EGRESS] Supabase upload error:', uploadError);
        return res.status(500).json({ error: 'Failed to upload to Supabase' });
      }

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('livestreams')
        .getPublicUrl(fileName);

      console.log('[EGRESS] Public URL:', publicUrl);

      // Save to database
      const { error: dbError } = await supabase.from('livestreams').insert({
        user_id: userId,
        video_url: publicUrl,
        thumbnail_url: thumbnailUrl || null,
        title: title || 'Live Stream',
        is_public: true,
      });

      if (dbError) {
        console.error('[EGRESS] DB save error:', dbError);
      } else {
        console.log('[EGRESS] Replay saved to DB!');
      }

      return res.json({ success: true, videoUrl: publicUrl });
    }

    // If no download URL yet, save as processing
    if (userId) {
      const { error: dbError } = await supabase.from('livestreams').insert({
        user_id: userId,
        video_url: 'processing',
        thumbnail_url: thumbnailUrl || null,
        title: title || 'Live Stream',
        is_public: true,
      });

      if (dbError) {
        console.error('[EGRESS] DB save error:', dbError);
      }
    }

    res.json({ success: true, videoUrl: 'processing' });

  } catch (error) {
    console.error('[EGRESS] Stop error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── GCASH DONATION VIA PAYMONGO ─────────────────────────────────
router.post('/donate', async (req, res) => {
  try {
    const { amount, scholarName, streamId } = req.body;
    const amountInCentavos = Math.round(amount * 100);

    if (amountInCentavos < 2000) {
      return res.status(400).json({ error: 'Minimum donation is ₱20' });
    }

    const response = await axios.post(
      'https://api.paymongo.com/v1/links',
      {
        data: {
          attributes: {
            amount: amountInCentavos,
            description: `Support ${scholarName} on Balagh`,
            remarks: `stream_${streamId}`,
          }
        }
      },
      {
        headers: {
          'Authorization': `Basic ${Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64')}`,
          'Content-Type': 'application/json',
        }
      }
    );

    const checkoutUrl = response.data.data.attributes.checkout_url;
    console.log('[PAYMONGO] Payment link created:', checkoutUrl);
    res.json({ checkoutUrl });

  } catch (error) {
    console.error('[PAYMONGO] Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

module.exports = router;