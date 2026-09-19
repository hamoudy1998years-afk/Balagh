// ─────────────────────────────────────────────
//  server/routes/transcribe.js
//  Secure server-side transcription endpoint
//  for Bushrann Recitation Checker.
//
//  This route receives audio from the mobile client,
//  forwards it to OpenAI Whisper, and returns the
//  transcription. The OpenAI key lives ONLY here.
// ─────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const fs = require('fs');
const multer = require('multer');
const path = require('path');

// Use the project's existing Supabase auth helper
const { authenticateUser } = require('../middleware/auth');

// OpenAI API key — server-side only, from Railway env
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn('[transcribe] OPENAI_API_KEY is not set. Transcription will fail.');
}

// Real temp directory — absolute path
const tmpDir = path.join(__dirname, '..', '..', 'uploads', 'tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// Multer storage using the real tmp directory with server-side generated filenames
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    // Use a safe server-side generated name; original name is not used in the temp filename
    cb(null, uniqueSuffix + '.tmp');
  },
});

// Allowed audio MIME types produced by Expo AV recording
const ALLOWED_MIME_TYPES = [
  'audio/m4a',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/webm',
  'audio/x-m4a',
  'audio/caf',
  'audio/x-caf',
];

// 15 MB max — generous for a short recitation recording
const MAX_FILE_SIZE = 15 * 1024 * 1024;

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Only audio files are allowed.`));
    }
  },
});

// ── Multer error wrapper ───────────────────────────────────────────────────
// Multer/fileFilter errors happen in middleware, not inside the async handler.
// This wrapper catches them explicitly and returns proper JSON before the
// transcription handler runs.
function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: { message: `File too large. Maximum allowed size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.` }
      });
    }
    return res.status(400).json({
      error: { message: err.message || 'Upload error.' }
    });
  }
  if (err?.message?.includes('Invalid file type')) {
    return res.status(415).json({
      error: { message: err.message }
    });
  }
  if (err) {
    return res.status(500).json({
      error: { message: err.message || 'Upload processing error.' }
    });
  }
  next();
}

// ── Fetch / FormData stack ─────────────────────────────────────────────────
// node-fetch@2 (CommonJS compatible) + npm form-data
const fetch = require('node-fetch');
const FormData = require('form-data');

// OpenAI transcription timeout — 30 seconds is reasonable for short recitations
const OPENAI_TIMEOUT_MS = 30000;

/**
 * POST /api/transcribe-recitation
 * Auth: Bearer token via Supabase JWT (authenticateUser middleware)
 * Body: multipart/form-data with field name "file" (audio, max 15MB)
 * Response: { transcription: "..." }
 */
router.post(
  '/transcribe-recitation',
  authenticateUser,
  upload.single('file'),
  handleUploadError,
  async (req, res) => {
    let timeoutId = null;
    let openaiController = null;

    try {
      if (!OPENAI_API_KEY) {
        return res.status(500).json({
          error: { message: 'Server transcription is not configured. Contact support.' }
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: { message: 'No audio file provided.' }
        });
      }

      const filePath = req.file.path;
      const fileStream = fs.createReadStream(filePath);

      const formData = new FormData();
      formData.append('file', fileStream, {
        filename: req.file.originalname || 'recitation.m4a',
        contentType: req.file.mimetype || 'audio/m4a',
      });
      formData.append('model', 'whisper-1');
      formData.append('language', 'ar'); // Force Arabic for accuracy

      // Set up timeout abort controller
      openaiController = new AbortController();
      timeoutId = setTimeout(() => {
        openaiController.abort();
      }, OPENAI_TIMEOUT_MS);

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: formData,
        signal: openaiController.signal,
      });

      // Clear timeout immediately after fetch completes
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      // Clean up temp file regardless of outcome
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupErr) {
        console.warn('[transcribe] Failed to clean up temp file:', cleanupErr.message);
      }

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        console.error('[transcribe] Whisper API error:', errBody);
        return res.status(502).json({
          error: { message: errBody.error?.message || 'Transcription service error.' }
        });
      }

      const data = await response.json();
      const transcription = data.text || '';

      return res.json({ transcription });

    } catch (e) {
      // Always clear timeout
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      console.error('[transcribe] Server error:', e.message);

      // Clean up temp file on error too
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }

      // Timeout-specific error
      if (e.name === 'AbortError') {
        return res.status(504).json({
          error: { message: 'Transcription request timed out. Please try again.' }
        });
      }

      return res.status(500).json({
        error: { message: e.message || 'Internal server error.' }
      });
    }
  }
);

module.exports = router;