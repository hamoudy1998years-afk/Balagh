const express = require('express');
const router = express.Router();
const { AccessToken } = require('livekit-server-sdk');

// Generate LiveKit token for streaming
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
    
    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: userId,
    });
    
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: isHost,
      canSubscribe: true,
      canPublishData: true,
    });
    
    const token = at.toJwt();
    
    console.log('[LIVEKIT] Token generated for:', userId, 'room:', roomName, 'host:', isHost);
    
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

module.exports = router;
