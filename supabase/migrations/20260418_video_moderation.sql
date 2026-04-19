-- Video Moderation System Migration
-- Created: 2026-04-18

-- 1. Create admins table
CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin')),
  added_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Enable RLS on admins
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;

-- 2. Alter videos table for moderation
ALTER TABLE videos 
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Update existing videos to approved status
UPDATE videos SET status = 'approved' WHERE status IS NULL;

-- 3. Alter profiles table for user moderation status
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trusted_user BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS approved_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rejection_count INTEGER DEFAULT 0;

-- 4. Create user_messages table
CREATE TABLE IF NOT EXISTS user_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'escalated', 'resolved')),
  assigned_to UUID REFERENCES admins(id) ON DELETE SET NULL,
  escalated_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  escalated_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on user_messages
ALTER TABLE user_messages ENABLE ROW LEVEL SECURITY;

-- 5. Create appeals table
CREATE TABLE IF NOT EXISTS appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(video_id)
);

-- Enable RLS on appeals
ALTER TABLE appeals ENABLE ROW LEVEL SECURITY;

-- 6. Create function: check_trusted_user
-- Updates profiles.trusted_user and profiles.is_banned based on video approval/rejection
CREATE OR REPLACE FUNCTION check_trusted_user()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status != 'approved' THEN
    UPDATE profiles 
    SET approved_count = COALESCE(approved_count, 0) + 1,
        trusted_user = CASE WHEN COALESCE(approved_count, 0) + 1 >= 5 THEN TRUE ELSE trusted_user END
    WHERE id = NEW.user_id;
  ELSIF NEW.status = 'rejected' AND OLD.status != 'rejected' THEN
    UPDATE profiles 
    SET rejection_count = COALESCE(rejection_count, 0) + 1,
        is_banned = CASE WHEN COALESCE(rejection_count, 0) + 1 >= 5 THEN TRUE ELSE is_banned END
    WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_check_trusted_user ON videos;
CREATE TRIGGER trigger_check_trusted_user
  AFTER UPDATE ON videos
  FOR EACH ROW
  EXECUTE FUNCTION check_trusted_user();

-- 7. Create function: auto_reject_banned
-- Auto-rejects uploads from banned users
CREATE OR REPLACE FUNCTION auto_reject_banned()
RETURNS TRIGGER AS $$
DECLARE
  user_banned BOOLEAN;
BEGIN
  SELECT is_banned INTO user_banned FROM profiles WHERE id = NEW.user_id;
  IF user_banned = TRUE THEN
    NEW.status = 'rejected';
    NEW.rejection_reason = 'User is banned from uploading';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_reject_banned ON videos;
CREATE TRIGGER trigger_auto_reject_banned
  BEFORE INSERT ON videos
  FOR EACH ROW
  EXECUTE FUNCTION auto_reject_banned();

-- 8. Create function: notify_admins_new_upload
-- Sends notification when new pending video is uploaded
CREATE OR REPLACE FUNCTION notify_admins_new_upload()
RETURNS TRIGGER AS $$
DECLARE
  admin_record RECORD;
BEGIN
  IF NEW.status = 'pending' THEN
    FOR admin_record IN 
      SELECT a.user_id 
      FROM admins a
      JOIN profiles p ON p.id = a.user_id
      WHERE p.push_token IS NOT NULL
    LOOP
      PERFORM pg_notify('new_pending_video', json_build_object(
        'video_id', NEW.id,
        'user_id', NEW.user_id,
        'admin_id', admin_record.user_id
      )::text);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_notify_admins_new_upload ON videos;
CREATE TRIGGER trigger_notify_admins_new_upload
  AFTER INSERT ON videos
  FOR EACH ROW
  EXECUTE FUNCTION notify_admins_new_upload();

-- 9. RLS Policies for admins table
CREATE POLICY "Admins can view all admins"
  ON admins FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

CREATE POLICY "Super admins can insert admins"
  ON admins FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid() AND role = 'super_admin'));

-- 10. RLS Policies for user_messages
CREATE POLICY "Users can view own messages"
  ON user_messages FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

CREATE POLICY "Users can create messages"
  ON user_messages FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admins can update messages"
  ON user_messages FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

-- 11. RLS Policies for appeals
CREATE POLICY "Users can view own appeals"
  ON appeals FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

CREATE POLICY "Users can create appeals"
  ON appeals FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admins can update appeals"
  ON appeals FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

-- 12. Update videos RLS to allow users to see approved videos and their own pending/rejected
DROP POLICY IF EXISTS "Users can view approved or own videos" ON videos;
CREATE POLICY "Users can view approved or own videos"
  ON videos FOR SELECT
  TO authenticated
  USING (status = 'approved' OR user_id = auth.uid());

-- 13. Index for performance
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_user_id_status ON videos(user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_messages_status ON user_messages(status);
CREATE INDEX IF NOT EXISTS idx_user_messages_assigned ON user_messages(assigned_to);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status);
