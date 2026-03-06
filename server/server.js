const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const cors = require('cors');
require('dotenv').config();

const app = express();
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
    // Reset window
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

// Apply rate limit to token endpoint
app.get('/token', rateLimit, (req, res) => {
  const channelName = req.query.channelName;
  const uid = req.query.uid || 0;
  const role = req.query.role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const expirationTimeInSeconds = 86400; // 🔧 Already fixed: 24 hours
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  if (!channelName) {
    return res.status(400).json({ error: 'channelName is required' });
  }

  const token = RtcTokenBuilder.buildTokenWithUid(
    process.env.AGORA_APP_ID,
    process.env.AGORA_APP_CERTIFICATE,
    channelName,
    uid,
    role,
    privilegeExpiredTs
  );

  res.json({ token, uid, channelName });
});