const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const app = express();
app.use(express.json());

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

app.listen(3000, () => {
  console.log('Token server running on port 3000');
});