-- High-priority indexes for daily-limit lookups
CREATE INDEX IF NOT EXISTS idx_leads_cpf_created_at ON public.leads (cpf, created_at DESC) WHERE cpf IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_email_created_at ON public.leads (email, created_at DESC) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_client_mac_created_at ON public.leads (client_mac, created_at DESC) WHERE client_mac IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_session_id ON public.leads (session_id) WHERE session_id IS NOT NULL;

-- Captive sessions: daily-limit-by-MAC + admin filtering
CREATE INDEX IF NOT EXISTS idx_captive_sessions_mac_status_auth
  ON public.captive_sessions (client_mac, status, authorized_at DESC)
  WHERE client_mac IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_captive_sessions_store_started
  ON public.captive_sessions (store_id, started_at DESC);

-- Verifications: lookup by session + status, plus OTP rate-limit by phone
CREATE INDEX IF NOT EXISTS idx_captive_verifications_session_status
  ON public.captive_verifications (session_id, status);
CREATE INDEX IF NOT EXISTS idx_captive_verifications_phone_created
  ON public.captive_verifications (phone, created_at DESC);

-- Enforce: at most ONE pending OTP per session at any time
CREATE UNIQUE INDEX IF NOT EXISTS uniq_captive_verifications_pending_session
  ON public.captive_verifications (session_id)
  WHERE status = 'pending';

-- portal_events: admin queries by store/time and by error type
CREATE INDEX IF NOT EXISTS idx_portal_events_store_created
  ON public.portal_events (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_events_event_type_created
  ON public.portal_events (event_type, created_at DESC);