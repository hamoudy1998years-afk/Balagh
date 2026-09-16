-- Persist the LiveKit recording filename on the replay row so that
-- replay finalization can be resumed after a Railway restart or a
-- storage-finalization delay exceeding the normal in-memory polling
-- window. The filename comes only from LiveKit's own egress record.

ALTER TABLE livestreams
  ADD COLUMN IF NOT EXISTS recording_filename TEXT;
