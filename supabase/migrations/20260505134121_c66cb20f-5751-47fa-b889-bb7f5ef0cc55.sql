ALTER TABLE public.captive_sessions
  ADD COLUMN IF NOT EXISTS unifi_cmd_accepted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS unifi_last_verify_result jsonb NULL,
  ADD COLUMN IF NOT EXISTS unifi_fallback_redirect_url text NULL;