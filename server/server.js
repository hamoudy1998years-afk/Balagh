const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const APP_ID = '3be4f80ee12e40708afe7ced6308ef9d';
const APP_CERTIFICATE = '6bbe7d0c6578421c9089b99c7eb5ac3c';

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Token server running on port ${PORT}`);
});