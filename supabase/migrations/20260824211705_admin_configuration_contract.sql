-- Keep the operational configuration schema in the captive application's
-- migration history. The admin application is a client only and must never
-- own or redeploy this database contract.
ALTER TABLE public.global_settings
  ADD COLUMN IF NOT EXISTS max_daily_accesses integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS session_duration_minutes integer NOT NULL DEFAULT 1440;

-- These timestamps support one lead per authenticated user while preserving
-- the first acquisition date and the most recent captive interaction.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

UPDATE public.leads
SET first_seen_at = COALESCE(first_seen_at, created_at),
    last_seen_at = COALESCE(last_seen_at, updated_at, created_at)
WHERE first_seen_at IS NULL OR last_seen_at IS NULL;

ALTER TABLE public.leads
  ALTER COLUMN first_seen_at SET DEFAULT now(),
  ALTER COLUMN first_seen_at SET NOT NULL,
  ALTER COLUMN last_seen_at SET DEFAULT now(),
  ALTER COLUMN last_seen_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'global_settings_session_duration_range'
      AND conrelid = 'public.global_settings'::regclass
  ) THEN
    ALTER TABLE public.global_settings
      ADD CONSTRAINT global_settings_session_duration_range
      CHECK (session_duration_minutes BETWEEN 1 AND 43200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'global_settings_max_daily_accesses_range'
      AND conrelid = 'public.global_settings'::regclass
  ) THEN
    ALTER TABLE public.global_settings
      ADD CONSTRAINT global_settings_max_daily_accesses_range
      CHECK (max_daily_accesses BETWEEN 0 AND 100);
  END IF;
END
$$;

COMMENT ON COLUMN public.global_settings.session_duration_minutes IS
  'UniFi authorization duration managed by the authenticated admin panel.';
COMMENT ON COLUMN public.leads.first_seen_at IS
  'Timestamp of the first lead acquisition for the authenticated user.';
COMMENT ON COLUMN public.leads.last_seen_at IS
  'Timestamp of the most recent captive interaction for the authenticated user.';
