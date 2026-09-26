// Admin PC uploader support routes.
//
// Serves the public Supabase client configuration (URL + anon key only —
// never the service-role key) and verifies that the authenticated user
// exists in the existing `admins` table before the uploader UI is shown.
//
// Auth pattern matches routes/videoProcessing.js and routes/videos.js:
// Bearer <supabase user JWT>, validated via supabase.auth.getUser.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';

    const token = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : null;

    if (!token) {
      return res.status(401).json({
        error: 'Missing authentication',
      });
    }

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user?.id) {
      return res.status(401).json({
        error: 'Invalid or expired authentication',
      });
    }

    req.authUserId = user.id;

    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Invalid or expired authentication',
    });
  }
}

// Public Supabase client config for the admin uploader page.
// The anon key is safe to expose to browsers; the service-role key never is.
router.get('/config', (req, res) => {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({
      error: 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY configuration',
    });
  }

  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

// Verify the Bearer token belongs to a user present in the `admins` table.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { data: adminRow, error: adminError } = await supabase
      .from('admins')
      .select('user_id, role')
      .eq('user_id', req.authUserId)
      .maybeSingle();

    if (adminError) {
      console.error(
        '[ADMIN-UPLOADER] Admin verification failed:',
        req.authUserId,
        adminError.message
      );

      return res.status(500).json({
        error: 'Failed to verify admin access',
      });
    }

    if (!adminRow) {
      return res.status(403).json({
        error: 'Admin access required',
      });
    }

    res.json({ isAdmin: true, role: adminRow.role });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to verify admin access',
    });
  }
});

module.exports = router;
