
-- 1. Adicionar colunas de timeline em captive_sessions
ALTER TABLE public.captive_sessions
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS params_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS form_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS otp_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS otp_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS unifi_authorize_called_at timestamptz,
  ADD COLUMN IF NOT EXISTS unifi_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS redirect_served_at timestamptz,
  ADD COLUMN IF NOT EXISTS redirect_clicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_step text,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS last_error_message text,
  ADD COLUMN IF NOT EXISTS total_latency_ms integer;

CREATE INDEX IF NOT EXISTS idx_captive_sessions_trace_id ON public.captive_sessions(trace_id);
CREATE INDEX IF NOT EXISTS idx_captive_sessions_started_at ON public.captive_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_captive_sessions_last_step ON public.captive_sessions(last_step);

-- 2. Tabela portal_events (event log append-only)
CREATE TABLE IF NOT EXISTS public.portal_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id uuid,
  trace_id text,
  store_id uuid,
  event_type text NOT NULL,
  step text NOT NULL,
  status text NOT NULL DEFAULT 'info',
  error_code text,
  error_message text,
  latency_ms integer,
  payload jsonb,
  client_ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_events_session_id ON public.portal_events(session_id);
CREATE INDEX IF NOT EXISTS idx_portal_events_trace_id ON public.portal_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_portal_events_created_at ON public.portal_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_events_event_type ON public.portal_events(event_type);
CREATE INDEX IF NOT EXISTS idx_portal_events_status ON public.portal_events(status);
CREATE INDEX IF NOT EXISTS idx_portal_events_step ON public.portal_events(step);

ALTER TABLE public.portal_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can read portal_events"
  ON public.portal_events
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anon denied on portal_events"
  ON public.portal_events
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);
