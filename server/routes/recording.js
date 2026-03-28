const express = require('express');
const { GetObjectCommand, PutObjectAclCommand, S3Client } = require('@aws-sdk/client-s3');
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
    
    // Make the S3 object public after Agora upload
    try {
      const m3u8Key = 'livestreams/' + fileName;
      await s3Client.send(new PutObjectAclCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: m3u8Key,
        ACL: 'public-read'
      }));
      console.log('[S3 ACL] Made file public:', m3u8Key);
    } catch (aclError) {
      console.error('[S3 ACL] Failed to make file public:', aclError.message);
      // Don't fail the request if ACL update fails - file might already be public
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

// Generate signed URL for secure video playback
router.get('/livestreams/:id/play', async (req, res) => {
  try {
    console.log('[DEBUG] AWS_KEY exists:', !!process.env.AWS_ACCESS_KEY_ID);
    console.log('[DEBUG] AWS_SECRET exists:', !!process.env.AWS_SECRET_ACCESS_KEY);
    console.log('[DEBUG] BUCKET:', process.env.S3_BUCKET_NAME);
    console.log('[DEBUG] REGION:', process.env.S3_REGION);
    console.log('[DEBUG] Livestream ID:', req.params.id);
    
    const { data: livestream, error } = await supabase
      .from('livestreams')
      .select('video_url')
      .eq('id', req.params.id)
      .single();
    
    if (error || !livestream) {
      return res.status(404).json({ error: 'Livestream not found' });
    }
    
    const urlParts = livestream.video_url.split('/');
    const key = 'livestreams/' + urlParts[urlParts.length - 1];
    
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key
    });
    
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    
    res.json({ signedUrl, expiresIn: 3600 });
    
  } catch (err) {
    console.error('[SIGNED URL] Full error:', err);
    console.error('[SIGNED URL] Error message:', err.message);
    res.status(500).json({ error: 'Failed to generate signed URL', details: err.message });
  }
});

module.exports = router;
