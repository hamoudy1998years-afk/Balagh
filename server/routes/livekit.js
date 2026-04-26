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
    if (!roomName) return res.status(400).json({ error: 'Missing roomName' });

    const egressClient = new EgressClient(
      process.env.LIVEKIT_URL,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );

    const filename = `${roomName}_${Date.now()}.mp4`;

    console.log('[EGRESS] Starting with Supabase S3');

    const egress = await egressClient.startRoomCompositeEgress(roomName, {
      file: {
        filepath: filename,
        s3: {
          accessKey: process.env.SUPABASE_S3_KEY_ID,
          secret: process.env.SUPABASE_S3_SECRET,
          region: process.env.SUPABASE_S3_REGION,
          bucket: 'livestreams',
          endpoint: process.env.SUPABASE_S3_ENDPOINT,
          forcePathStyle: true,
        }
      }
    }, { layout: 'speaker' });

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

    const egressClient = new EgressClient(
      process.env.LIVEKIT_URL,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );

    await egressClient.stopEgress(egressId);
    console.log('[EGRESS] Stopped:', egressId);

    // Save as processing first
    if (userId) {
      const { data: record, error: dbError } = await supabase
        .from('livestreams')
        .insert({
          user_id: userId,
          video_url: 'processing',
          thumbnail_url: thumbnailUrl || null,
          title: title || 'Live Stream',
          is_public: true,
        })
        .select()
        .single();

      if (dbError) {
        console.error('[EGRESS] DB save error:', dbError);
      } else {
        console.log('[EGRESS] Saved as processing, id:', record.id);
        // Start background job to download from S3 and upload to Supabase
        processRecording(record.id, filename, egressId);
      }
    }

    res.json({ success: true });

  } catch (error) {
    console.error('[EGRESS] Stop error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── BACKGROUND: Download from S3 and upload to Supabase ─────────
async function processRecording(recordId, filename, egressId) {
  try {
    console.log('[PROCESS] Waiting for LiveKit to finish uploading to Supabase...');

    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/livestreams/${filename}`;

    // Poll Supabase Storage until file appears
    let fileReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // wait 10 seconds
      try {
        const response = await fetch(publicUrl, { method: 'HEAD' });
        if (response.ok) {
          fileReady = true;
          console.log(`[PROCESS] File ready after ${(i + 1) * 10}s`);
          break;
        }
      } catch (e) {
        // not ready yet
      }
      console.log(`[PROCESS] File not ready yet (attempt ${i + 1})`);
    }

    if (!fileReady) {
      console.error('[PROCESS] File never appeared in Supabase Storage');
      return;
    }

    // Generate thumbnail from video
    let thumbnailUrl = null;
    try {
      const ffmpeg = require('fluent-ffmpeg');
      ffmpeg.setFfmpegPath(require('ffmpeg-static'));
      const fs = require('fs');
      const tempVideoPath = `/tmp/${egressId}.mp4`;
      const tempThumbPath = `/tmp/${egressId}.jpg`;

      // Download video
      const videoResponse = await fetch(publicUrl);
      const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
      fs.writeFileSync(tempVideoPath, videoBuffer);

      // Extract frame at 1 second
      await new Promise((resolve, reject) => {
        ffmpeg(tempVideoPath)
          .screenshots({ timestamps: ['1'], filename: `${egressId}.jpg`, folder: '/tmp', size: '720x?' })
          .on('end', resolve)
          .on('error', reject);
      });

      // Upload thumbnail
      const thumbBuffer = fs.readFileSync(tempThumbPath);
      const { error: thumbError } = await supabase.storage
        .from('thumbnails')
        .upload(`${egressId}_thumb.jpg`, thumbBuffer, { contentType: 'image/jpeg', upsert: true });

      if (!thumbError) {
        const { data: { publicUrl: thumbUrl } } = supabase.storage
          .from('thumbnails')
          .getPublicUrl(`${egressId}_thumb.jpg`);
        thumbnailUrl = thumbUrl;
        console.log('[PROCESS] Thumbnail generated:', thumbnailUrl);
      }

      // Cleanup
      try { fs.unlinkSync(tempVideoPath); } catch(e) {}
      try { fs.unlinkSync(tempThumbPath); } catch(e) {}
    } catch (thumbErr) {
      console.error('[PROCESS] Thumbnail error:', thumbErr.message);
    }

    // Update livestreams record
    const { error: updateError } = await supabase
      .from('livestreams')
      .update({ video_url: publicUrl, thumbnail_url: thumbnailUrl })
      .eq('id', recordId);

    // Also insert into videos table so it shows in the main feed
    const { data: livestreamRecord } = await supabase
      .from('livestreams')
      .select('user_id, title')
      .eq('id', recordId)
      .single();

    if (livestreamRecord) {
      await supabase.from('videos').insert({
        user_id: livestreamRecord.user_id,
        video_url: publicUrl,
        thumbnail_url: thumbnailUrl,
        title: livestreamRecord.title || 'Live Stream Replay',
        type: 'livestream',
        status: 'approved',
        is_public: true,
      });
      console.log('[PROCESS] Added to main feed!');
    }

    if (updateError) {
      console.error('[PROCESS] DB update error:', updateError);
    } else {
      console.log('[PROCESS] Replay ready! 🎉', publicUrl);
    }

  } catch (error) {
    console.error('[PROCESS] Error:', error.message);
  }
}

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
    const paymentLinkId = response.data.data.id;
    console.log('[PAYMONGO] Payment link created:', checkoutUrl);

    // Save donation record to database
    const { donorId, scholarId } = req.body;
    if (donorId && scholarId) {
      await supabase.from('donations').insert({
        donor_id: donorId,
        scholar_id: scholarId,
        stream_id: streamId,
        amount: amount,
        status: 'pending',
        payment_link_id: paymentLinkId,
      });
    }

    res.json({ checkoutUrl });

  } catch (error) {
    console.error('[PAYMONGO] Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

module.exports = router;