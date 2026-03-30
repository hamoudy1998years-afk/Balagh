const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

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
    
    console.log('[LIVEKIT] Generating token for:', userId, 'room:', roomName);
    
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

module.exports = router;
