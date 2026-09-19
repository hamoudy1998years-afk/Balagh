-- Phase 2B: Race-safe rejected-video cleanup claim
--
-- Prepared locally. NOT applied. Apply manually to Supabase after review.
--
-- Problem: the rejected-video sweeper deleted Storage objects before an
-- atomic row delete. An approve_appeal racing in between restored the row
-- (status='approved') while its media was already gone.
--
-- Fix:
--  1. Add a cleanup-only status so the sweeper can claim exclusive cleanup
--     ownership of a row (rejected -> cleanup) BEFORE touching Storage.
--  2. Gate approve_appeal so a video that is no longer 'rejected' (claimed
--     for cleanup, or otherwise changed) cannot be restored: the UPDATE
--     matches zero rows, we raise before marking the appeal approved, and
--     the whole transaction rolls back leaving the appeal pending.
--  3. Guard check_trusted_user so the sweeper's failed-cleanup revert
--     (cleanup -> rejected) does NOT double-count rejection_count.
--
-- All function bodies below are the VERIFIED live definitions with only
-- the minimum required changes (marked inline).

-- 1. Extend the videos.status CHECK constraint with the 'cleanup' state.
--    Live constraint name and definition verified read-only.
ALTER TABLE videos DROP CONSTRAINT videos_status_check;
ALTER TABLE videos ADD CONSTRAINT videos_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cleanup'::text]));

-- 2. check_trusted_user(): live body preserved EXACTLY except the minimum
--    change so the sweeper's failed-cleanup revert (cleanup -> rejected)
--    is not counted as a new moderation decision.
CREATE OR REPLACE FUNCTION public.check_trusted_user()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.status = 'approved' AND OLD.status != 'approved' THEN
        UPDATE profiles
        SET approved_count = COALESCE(approved_count, 0) + 1,
            trusted_user = CASE WHEN COALESCE(approved_count, 0) + 1 >= 5 THEN TRUE ELSE trusted_user END
        WHERE id = NEW.user_id;
    -- PHASE 2B: exclude the cleanup-claim revert from rejection_count.
    ELSIF NEW.status = 'rejected'
          AND OLD.status NOT IN ('rejected', 'cleanup') THEN
        UPDATE profiles
        SET rejection_count = COALESCE(rejection_count, 0) + 1,
            is_banned = CASE WHEN COALESCE(rejection_count, 0) + 1 >= 5 THEN TRUE ELSE is_banned END
        WHERE id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$function$;

-- 3. approve_appeal(): live body preserved EXACTLY except the race gate:
--    the video UPDATE now requires status='rejected' and verifies it
--    affected exactly one row, raising BEFORE the appeal is marked
--    approved otherwise.
CREATE OR REPLACE FUNCTION public.approve_appeal(p_appeal_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_video_id UUID;
  v_admin_id UUID;
  v_updated_count INT;
BEGIN
  SELECT id INTO v_admin_id
  FROM admins WHERE user_id = auth.uid();

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: caller is not an admin';
  END IF;

  SELECT video_id INTO v_video_id
  FROM appeals
  WHERE id = p_appeal_id AND status = 'pending'
  FOR UPDATE;

  IF v_video_id IS NULL THEN
    RAISE EXCEPTION 'Appeal not found or not pending';
  END IF;

  -- PHASE 2B: restore ONLY a still-rejected video. If the sweeper claimed
  -- it (status='cleanup') or it was otherwise changed, this matches zero
  -- rows and we abort before the appeal is marked approved.
  UPDATE videos
  SET status = 'approved', reviewed_by = v_admin_id, reviewed_at = NOW()
  WHERE id = v_video_id
    AND status = 'rejected';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count = 0 THEN
    RAISE EXCEPTION 'Video is not in a restorable (rejected) state';
  END IF;

  UPDATE appeals
  SET status = 'approved', reviewed_by = v_admin_id
  WHERE id = p_appeal_id;
END;
$function$;
