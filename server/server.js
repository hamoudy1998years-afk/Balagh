const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// 🔧 NEW: Simple in-memory rate limiter
const rateLimits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 10; // 10 requests per minute

  const userLimit = rateLimits.get(ip) || { count: 0, resetTime: now + windowMs };

  if (now > userLimit.resetTime) {
    userLimit.count = 1;
    userLimit.resetTime = now + windowMs;
  } else {
    userLimit.count++;
  }

  rateLimits.set(ip, userLimit);

  if (userLimit.count > maxRequests) {
    return res.status(429).json({ error: 'Too many requests, please slow down' });
  }

  next();
}

// Purge expired rate-limit entries every 5 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimits.entries()) {
    if (now > data.resetTime) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

// Apply rate limit to token endpoint
app.get('/token', rateLimit, (req, res) => {
  const channelName = req.query.channelName;
  const uid = parseInt(req.query.uid, 10) || 0;
  const role = req.query.role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const expirationTimeInSeconds = 86400; // 24 hours
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  if (!channelName) {
    return res.status(400).json({ error: 'channelName is required' });
  }

  if (!process.env.AGORA_APP_ID || !process.env.AGORA_APP_CERTIFICATE) {
    console.error('Missing AGORA_APP_ID or AGORA_APP_CERTIFICATE env vars');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      process.env.AGORA_APP_ID,
      process.env.AGORA_APP_CERTIFICATE,
      channelName,
      uid,
      role,
      privilegeExpiredTs
    );
    res.json({ token, uid, channelName });
  } catch (e) {
    console.error('Token generation failed:', e.message);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 Server running on port', PORT);
  console.log('📹 Token endpoint: /token');
  console.log('========================================');
});