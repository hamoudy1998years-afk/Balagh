const express = require('express');
const { GetObjectCommand, PutObjectCommand, PutObjectAclCommand, HeadObjectCommand, CopyObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3Client = new S3Client({
  region: process.env.S3_REGION || 'ap-southeast-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  }
});
const router = express.Router();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_CUSTOMER_KEY = process.env.AGORA_CUSTOMER_KEY;
const AGORA_CUSTOMER_SECRET = process.env.AGORA_CUSTOMER_SECRET;

// S3 Configuration
const S3_BUCKET = process.env.S3_BUCKET_NAME || 'balagh-livestreams';
const S3_REGION = process.env.S3_REGION || 'ap-southeast-2';

const getAuthHeader = () => {
  const encoded = Buffer.from(`${AGORA_CUSTOMER_KEY}:${AGORA_CUSTOMER_SECRET}`).toString('base64');
  return `Basic ${encoded}`;
};

// Start recording
router.post('/start', async (req, res) => {
  const { channelName, uid, token } = req.body; // ✅ added token
  
  try {
    const acquireRes = await axios.post(
      `https://api.agora.io/v1/apps/${AGORA_APP_ID}/cloud_recording/acquire`,
      {
        cname: channelName,
        uid: uid.toString(),
        clientRequest: {}
      },
      { headers: { Authorization: getAuthHeader() } }
    );
    
    const { resourceId } = acquireRes.data;

    console.log('[STORAGE CONFIG]', JSON.stringify({
      vendor: 1,
      region: 9,
      bucket: process.env.S3_BUCKET_NAME,
      accessKey: process.env.AWS_ACCESS_KEY?.substring(0, 8),
      secretKeyLength: process.env.AWS_SECRET_KEY?.length,
    }));
        
    const startRes = await axios.post(
      `https://api.agora.io/v1/apps/${AGORA_APP_ID}/cloud_recording/resourceid/${resourceId}/mode/mix/start`,
      {
        cname: channelName,
        uid: uid.toString(),
        clientRequest: {
          token: token, // ✅ added token here
          recordingConfig: {
            maxIdleTime: 30,
            streamTypes: 2,
            audioProfile: 1,
            videoStreamType: 0,
            transcodingConfig: {
              width: 720,
              height: 1280,
              fps: 30,
              bitrate: 1500,
              mixedVideoLayout: 1
            }
          },
          storageConfig: {
            
            vendor: 1,
            region: 9,
            bucket: process.env.S3_BUCKET_NAME,
            accessKey: process.env.AWS_ACCESS_KEY,
            secretKey: process.env.AWS_SECRET_KEY,
            fileNamePrefix: ["livestreams"]
          }
        }
      },
      { headers: { Authorization: getAuthHeader() } }
    );
    
    res.json({
      resourceId,
      sid: startRes.data.sid
    });
  } catch (error) {
    console.error('Start recording error:', JSON.stringify(error.response?.data) || error.message);
    console.error('Start recording status:', error.response?.status);
    res.status(500).json({ 
      error: 'Failed to start recording',
      detail: error.response?.data || error.message
    });
  }
});

// Stop recording
router.post('/stop', async (req, res) => {
  const { resourceId, sid, channelName, uid, userId, title, description, thumbnail_url, duration } = req.body;
  
  console.log('[RECORDING] S3 Bucket:', process.env.S3_BUCKET_NAME);
  console.log('[RECORDING] Saving to DB:', { 
    userId, 
    title, 
    thumbnail: thumbnail_url,
    duration,
    description 
  });
  
  try {
    const response = await axios.post(
      `https://api.agora.io/v1/apps/${AGORA_APP_ID}/cloud_recording/resourceid/${resourceId}/sid/${sid}/mode/mix/stop`,
      {
        cname: channelName,
        uid: uid.toString(),
        clientRequest: {}
      },
      { headers: { Authorization: getAuthHeader() } }
    );

    const serverResponse = response.data.serverResponse;
    const fileListMode = serverResponse?.fileListMode;
    const rawFileList = serverResponse?.fileList;

    // ✅ FIX: fallback to constructing filename if Agora returns empty fileList
    const fileName = (fileListMode === 'string' && rawFileList)
      ? rawFileList
      : `${sid}_${channelName}.m3u8`;
    
    // Construct full S3 URL
    const videoUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/livestreams/${fileName}`;
    console.log('[S3 UPLOAD] Constructed S3 URL:', videoUrl);
    console.log('[S3 UPLOAD] Bucket:', S3_BUCKET);
    console.log('[S3 UPLOAD] Region:', S3_REGION);
    console.log('[S3 UPLOAD] Filename:', fileName);
    console.log('[RECORDING] Full S3 URL:', videoUrl);
    
    // Poll for object existence then make public (Agora uploads asynchronously)
    async function pollAndMakePublic(bucket, key, maxAttempts = 15) {
      for (let i = 1; i <= maxAttempts; i++) {
        try {
          await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          // If HeadObject succeeds, file exists - make it public
          await s3Client.send(new PutObjectAclCommand({
            Bucket: bucket,
            Key: key,
            ACL: 'public-read'
          }));
          console.log(`[S3 ACL]  Made file public: ${key} on attempt ${i}`);
          return true;
        } catch (error) {
          const statusCode = error.$metadata?.httpStatusCode;
          const errorName = error.name;
          
          // If 403, file exists but is private - try to set ACL immediately
          if (statusCode === 403 || errorName === 'Forbidden') {
            console.log(`[S3 Poll] Attempt ${i}: File exists (403), trying ACL...`);
            try {
              await s3Client.send(new PutObjectAclCommand({
                Bucket: bucket,
                Key: key,
                ACL: 'public-read'
              }));
              console.log(`[S3 ACL]  Made file public: ${key} on attempt ${i}`);
              return true;
            } catch (aclError) {
              console.log(`[S3 Poll] ACL failed, will retry...`);
            }
          }
          
          // If 404, file doesn't exist yet - wait and retry
          if (statusCode === 404 || errorName === 'NotFound') {
            const delay = Math.min(1000 * Math.pow(2, i - 1), 30000);
            console.log(`[S3 Poll] Attempt ${i}/${maxAttempts}: File not ready, waiting ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          
          // For other errors, log and retry
          console.error(`[S3 Poll] Attempt ${i} error:`, errorName, statusCode, error.message);
          const delay = Math.min(1000 * Math.pow(2, i - 1), 30000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      console.error(`[S3 ACL]  Failed after max attempts: ${key}`);
      return false;
    }

    // Download and re-upload to change ownership from Agora to server
    async function downloadAndReupload(bucket, key, maxAttempts = 15) {
      for (let i = 1; i <= maxAttempts; i++) {
        try {
          // Download the file using GetObject
          const getCommand = new GetObjectCommand({ Bucket: bucket, Key: key });
          const response = await s3Client.send(getCommand);
          
          // Collect stream data into buffer
          const chunks = [];
          for await (const chunk of response.Body) {
            chunks.push(chunk);
          }
          const buffer = Buffer.concat(chunks);
          
          // Re-upload with public-read ACL (server now owns it)
          await s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: 'application/vnd.apple.mpegurl',
            ACL: 'public-read'
          }));
          
          console.log(`[S3 REUPLOAD]  Fixed ownership for: ${key}`);
          return true;
        } catch (error) {
          if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
            const delay = Math.min(1000 * Math.pow(2, i - 1), 30000);
            console.log(`[S3 Poll] Attempt ${i}/${maxAttempts}: File not ready, waiting ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          console.error(`[S3 REUPLOAD] Error attempt ${i}:`, error.message);
          return false;
        }
      }
      console.error(`[S3 REUPLOAD]  Failed after ${maxAttempts} attempts: ${key}`);
      return false;
    }
    
    const fileList = [videoUrl];

    console.log('[RECORDING] Stop response:', JSON.stringify(serverResponse));
    console.log('[RECORDING] fileListMode:', fileListMode);
    console.log('[RECORDING] videoUrl:', videoUrl);

    // Save to livestreams table if we have a video URL
    let livestreamRecord = null;
    if (videoUrl && userId) {
      const thumbnailUrl = req.body.thumbnail_url;
      console.log('[RECORDING] Received thumbnail_url:', thumbnailUrl);

      const { placeholderId } = req.body;

      let query;
      if (placeholderId) {
        // Update the placeholder record the client already inserted
        query = supabase.from('livestreams').update({
          video_url: videoUrl,
          thumbnail_url: thumbnailUrl || null,
          title: req.body.title || 'Live Stream',
          description: req.body.description || '',
          is_public: true
        }).eq('id', placeholderId).select().single();
      } else {
        // Fallback: insert new record
        query = supabase.from('livestreams').insert({
          user_id: req.body.userId,
          video_url: videoUrl,
          thumbnail_url: thumbnailUrl || null,
          title: req.body.title || 'Live Stream',
          description: req.body.description || '',
          is_public: true
        }).select().single();
      }

      const { data, error } = await query;

      if (error) {
        console.error('Failed to save livestream to database:', error);
      } else {
        livestreamRecord = data;
        console.log('[RECORDING] Saved to DB:', { id: data?.id, thumbnail: data?.thumbnail_url });
      }
    }

    res.json({ 
      serverResponse: serverResponse,
      fileList: fileList,
      livestream: livestreamRecord
    });
  } catch (error) {
    console.error('Stop recording error:', JSON.stringify(error.response?.data) || error.message);
    console.error('Stop recording status:', error.response?.status);
    res.status(500).json({ 
      error: 'Failed to stop recording',
      detail: error.response?.data || error.message
    });
  }
});

// Generate pre-signed URL for video playback (temporary fix until CloudFront is ready)
// This works even if the S3 object is private - no ACL changes needed
router.get('/livestreams/:id/play', async (req, res) => {
  try {
    console.log('[SIGNED URL] Request for livestream:', req.params.id);
    
    // Get the livestream record from database
    const { data: livestream, error } = await supabase
      .from('livestreams')
      .select('video_url')
      .eq('id', req.params.id)
      .single();
    
    if (error || !livestream) {
      console.error('[SIGNED URL] Livestream not found:', req.params.id);
      return res.status(404).json({ error: 'Livestream not found' });
    }
    
    // Extract the S3 key from the stored URL
    // URL format: https://bucket.s3.region.amazonaws.com/livestreams/filename.m3u8
    const urlParts = livestream.video_url.split('/livestreams/');
    if (urlParts.length !== 2) {
      console.error('[SIGNED URL] Invalid URL format:', livestream.video_url);
      return res.status(500).json({ error: 'Invalid video URL format' });
    }
    
    const fileName = urlParts[1];
    const s3Key = `livestreams/${fileName}`;
    
    console.log('[SIGNED URL] Generating signed URL for key:', s3Key);
    
    // Generate pre-signed URL valid for 1 hour (3600 seconds)
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key
    });
    
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    
    console.log('[SIGNED URL] Generated successfully');
    
    res.json({ 
      signedUrl, 
      expiresIn: 3600,
      // Also return the original URL for reference (optional)
      originalUrl: livestream.video_url 
    });
    
  } catch (err) {
    console.error('[SIGNED URL] Error:', err);
    res.status(500).json({ 
      error: 'Failed to generate signed URL', 
      details: err.message 
    });
  }
});

// Webhook endpoint for Agora recording callback
router.post('/webhook', async (req, res) => {
  try {
    console.log('[WEBHOOK] Raw body:', JSON.stringify(req.body, null, 2));
    
    // Agora payload structure: body.payload.details.fileList
    const payload = req.body.payload || req.body;
    const details = payload.details || {};
    
    const fileName = details.fileList || payload.fileList || payload.fileName;
    const channelName = payload.cname || payload.channelName;
    const sid = payload.sid;
    
    console.log('[WEBHOOK] Parsed:', { fileName, channelName, sid });
    
    // Always return 200 for health check
    if (!fileName) {
      console.log('[WEBHOOK] Health check or empty payload - returning 200');
      return res.status(200).json({ success: true, message: 'Webhook received' });
    }
    
    const s3Key = 'livestreams/' + fileName;
    const bucket = process.env.S3_BUCKET_NAME;
    
    console.log('[WEBHOOK] Processing file:', s3Key);
    
    // Download from S3
    const getCommand = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
    const response = await s3Client.send(getCommand);
    
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    console.log('[WEBHOOK] Downloaded:', buffer.length, 'bytes');
    
    // Upload to Supabase Storage
    const supabaseKey = 'livestreams/' + fileName;
    
    console.log('[WEBHOOK] Uploading to Supabase:', supabaseKey);
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('videos')
      .upload(supabaseKey, buffer, {
        contentType: 'application/vnd.apple.mpegurl',
        upsert: true
      });
    
    if (uploadError) {
      throw uploadError;
    }
    
    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('videos')
      .getPublicUrl(supabaseKey);
    
    console.log('[WEBHOOK] Supabase URL:', publicUrl);
    
    // Find and update database using sid (session ID)
    const { error: dbError } = await supabase
      .from('livestreams')
      .update({ video_url: publicUrl })
      .like('video_url', '%' + sid + '%');
    
    if (dbError) {
      console.error('[WEBHOOK] DB Error:', dbError);
    }
    
    // Delete from S3
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: s3Key
    }));
    console.log('[WEBHOOK] Deleted from S3');
    console.log('[WEBHOOK]  Complete');
    
    res.json({ success: true, url: publicUrl });
  } catch (error) {
    console.error('[WEBHOOK] Error:', error.message);
    // Still return 200 so Agora doesn't retry
    res.status(200).json({ success: false, error: error.message });
  }
});

module.exports = router;
