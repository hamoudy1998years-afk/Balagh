const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { EgressClient } = require('livekit-server-sdk');

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

    const awsAccessKey = process.env.AWS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
    const awsSecretKey = process.env.AWS_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;

    console.log('[EGRESS] Starting recording for room:', roomName);
    console.log('[EGRESS] AWS Key exists:', !!awsAccessKey);
    console.log('[EGRESS] AWS Secret exists:', !!awsSecretKey);

    const egressClient = new EgressClient(
      process.env.LIVEKIT_URL,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );

    const filename = `livestreams/${roomName}_${Date.now()}.mp4`;

    const egress = await egressClient.startRoomCompositeEgress(roomName, {
      file: {
        filepath: filename,
        s3: {
          accessKey: awsAccessKey,
          secret: awsSecretKey,
          region: process.env.S3_REGION || 'ap-southeast-2',
          bucket: process.env.S3_BUCKET_NAME,
        }
      }
    });

    console.log('[EGRESS] Recording started:', egress.egressId);
    res.json({ egressId: egress.egressId, filename });

  } catch (error) {
    console.error('[EGRESS] Start error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── STOP EGRESS AND SAVE REPLAY ─────────────────────────────────
router.post('/egress/stop', async (req, res) => {
  try {
    const { egressId, userId, title, thumbnailUrl, filename } = req.body;

    console.log('[EGRESS] Stopping egress:', egressId);

    const egressClient = new EgressClient(
      process.env.LIVEKIT_URL,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );

    await egressClient.stopEgress(egressId);

    const videoUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.S3_REGION || 'ap-southeast-2'}.amazonaws.com/${filename}`;

    if (userId) {
      const { error } = await supabase.from('livestreams').insert({
        user_id: userId,
        video_url: videoUrl,
        thumbnail_url: thumbnailUrl || null,
        title: title || 'Live Stream',
        is_public: true,
      });

      if (error) {
        console.error('[EGRESS] DB save error:', error);
      } else {
        console.log('[EGRESS] Replay saved to DB:', videoUrl);
      }
    }

    res.json({ success: true, videoUrl });

  } catch (error) {
    console.error('[EGRESS] Stop error:', error);
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