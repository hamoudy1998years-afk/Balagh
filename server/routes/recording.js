const express = require('express');
const router = express.Router();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_CUSTOMER_KEY = process.env.AGORA_CUSTOMER_KEY;
const AGORA_CUSTOMER_SECRET = process.env.AGORA_CUSTOMER_SECRET;

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
            region: 7,
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
  const { resourceId, sid, channelName, uid, userId, title, description } = req.body;
  
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

    // ✅ FIX: Agora returns fileList as a string when fileListMode is "string"
    const videoUrl = fileListMode === 'string'
      ? rawFileList || null
      : (Array.isArray(rawFileList) && rawFileList.length > 0 ? rawFileList[0] : null);

    const fileList = videoUrl ? [videoUrl] : [];

    console.log('[RECORDING] Stop response:', JSON.stringify(serverResponse));
    console.log('[RECORDING] fileListMode:', fileListMode);
    console.log('[RECORDING] videoUrl:', videoUrl);

    // Save to livestreams table if we have a video URL
    let livestreamRecord = null;
    if (videoUrl && userId) {
      const { data, error } = await supabase.from('livestreams').insert({
        user_id: userId,
        video_url: videoUrl,
        title: title || 'Live Stream',
        description: description || ''
      }).select().single();

      if (error) {
        console.error('Failed to save livestream to database:', error);
      } else {
        livestreamRecord = data;
        console.log('[RECORDING] Saved to DB:', livestreamRecord.id);
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

module.exports = router;
