-- Livestreams table to store recorded stream metadata
CREATE TABLE IF NOT EXISTS livestreams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  video_url TEXT NOT NULL, -- S3 URL from Agora Cloud Recording
  thumbnail_url TEXT,
  duration_seconds INTEGER,
  file_size_bytes BIGINT,
  view_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  is_public BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fetching user's livestreams
CREATE INDEX IF NOT EXISTS idx_livestreams_user_id ON livestreams(user_id);

-- Index for fetching public livestreams by date
CREATE INDEX IF NOT EXISTS idx_livestreams_public_created ON livestreams(is_public, created_at DESC);

-- Enable RLS
ALTER TABLE livestreams ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view public livestreams
CREATE POLICY "Anyone can view public livestreams" ON livestreams
  FOR SELECT USING (is_public = true);

-- Policy: Users can view their own livestreams (even if private)
CREATE POLICY "Users can view own livestreams" ON livestreams
  FOR SELECT USING (auth.uid() = user_id);

-- Policy: Users can insert their own livestreams
CREATE POLICY "Users can create own livestreams" ON livestreams
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own livestreams
CREATE POLICY "Users can update own livestreams" ON livestreams
  FOR UPDATE USING (auth.uid() = user_id);

-- Policy: Users can delete their own livestreams
CREATE POLICY "Users can delete own livestreams" ON livestreams
  FOR DELETE USING (auth.uid() = user_id);
