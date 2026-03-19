const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

// Load environment variables from .env file
require('dotenv').config();

const app = express();
app.use(express.json());

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

if (!APP_ID || !APP_CERTIFICATE) {
  console.error('❌ Missing required environment variables:');
  console.error('   AGORA_APP_ID and AGORA_APP_CERTIFICATE must be set');
  console.error('   Create a .env file with these variables or export them');
  process.exit(1);
}

app.post('/get-token', (req, res) => {
  const { channelName, uid, role } = req.body;
  
  const userRole = role === 'host' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const expireTime = Math.floor(Date.now() / 1000) + 3600;
  
  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channelName,
    uid,
    userRole,
    expireTime
  );
  
  res.json({ token });
});

app.listen(3000, () => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('Token server running on port 3000');
  }
});