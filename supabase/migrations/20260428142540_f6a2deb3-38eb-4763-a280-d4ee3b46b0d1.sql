ALTER TABLE public.captive_sessions
  ADD COLUMN IF NOT EXISTS original_client_mac text,
  ADD COLUMN IF NOT EXISTS auth_latency_ms integer;