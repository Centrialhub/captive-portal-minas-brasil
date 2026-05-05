ALTER TABLE public.captive_sessions
  ADD COLUMN IF NOT EXISTS captive_timestamp text NULL,
  ADD COLUMN IF NOT EXISTS original_unifi_url_params jsonb NULL;