const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { EgressClient, EncodedFileOutput, S3Upload } = require('livekit-server-sdk');

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

    const awsAccessKey = process.env.AWS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
    const awsSecretKey = process.env.AWS_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    const filename = `livestreams/${roomName}_${Date.now()}.mp4`;

    console.log('[EGRESS] Starting with AWS key:', awsAccessKey?.substring(0, 8));

    const output = new EncodedFileOutput({
      filepath: filename,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: awsAccessKey,
          secret: awsSecretKey,
          region: process.env.S3_REGION || 'ap-southeast-2',
          bucket: process.env.S3_BUCKET_NAME,
        })
      }
    });

    const egress = await egressClient.startRoomCompositeEgress(
      roomName,
      { file: output },
      { layout: 'speaker' }
    );

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
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    
    const s3Client = new S3Client({
      region: process.env.S3_REGION || 'ap-southeast-2',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
      }
    });

    // Wait for file to be ready (poll S3)
    let fileReady = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
      try {
        const { HeadObjectCommand } = require('@aws-sdk/client-s3');
        await s3Client.send(new HeadObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: filename,
        }));
        fileReady = true;
        console.log(`[PROCESS] File ready on S3 after ${(i + 1) * 10}s`);
        break;
      } catch (e) {
        console.log(`[PROCESS] File not ready yet (attempt ${i + 1})`);
      }
    }

    if (!fileReady) {
      console.error('[PROCESS] File never appeared on S3');
      return;
    }

    // Download from S3
    console.log('[PROCESS] Downloading from S3...');
    const getCommand = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: filename,
    });
    const s3Response = await s3Client.send(getCommand);
    
    const chunks = [];
    for await (const chunk of s3Response.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    console.log(`[PROCESS] Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)}MB`);

    // Upload to Supabase Storage
    const supabaseFileName = `${egressId}_${Date.now()}.mp4`;
    console.log('[PROCESS] Uploading to Supabase Storage...');
    
    const { error: uploadError } = await supabase.storage
      .from('livestreams')
      .upload(supabaseFileName, buffer, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (uploadError) {
      console.error('[PROCESS] Supabase upload error:', uploadError);
      return;
    }

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('livestreams')
      .getPublicUrl(supabaseFileName);

    console.log('[PROCESS] Public URL:', publicUrl);

    // Update database record
    const { error: updateError } = await supabase
      .from('livestreams')
      .update({ video_url: publicUrl })
      .eq('id', recordId);

    if (updateError) {
      console.error('[PROCESS] DB update error:', updateError);
    } else {
      console.log('[PROCESS] Replay ready! 🎉');
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
    console.log('[PAYMONGO] Payment link created:', checkoutUrl);
    res.json({ checkoutUrl });

  } catch (error) {
    console.error('[PAYMONGO] Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

module.exports = router;