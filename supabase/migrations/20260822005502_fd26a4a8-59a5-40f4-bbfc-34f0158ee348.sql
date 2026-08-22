-- Create captive_auth_attempts table
CREATE TABLE public.captive_auth_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resume_token_hash TEXT NOT NULL,
    client_mac TEXT NOT NULL,
    ap_mac TEXT,
    ssid TEXT,
    store_hint TEXT,
    captive_timestamp TEXT,
    original_url TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Grants
GRANT SELECT, INSERT, UPDATE ON public.captive_auth_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.captive_auth_attempts TO anon;
GRANT ALL ON public.captive_auth_attempts TO service_role;

-- RLS
ALTER TABLE public.captive_auth_attempts ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Anon can insert attempts" ON public.captive_auth_attempts
    FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Users can see their own attempts" ON public.captive_auth_attempts
    FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "Service role full access" ON public.captive_auth_attempts
    FOR ALL TO service_role USING (true);

-- Index for cleanup and lookups
CREATE INDEX idx_captive_auth_attempts_token_hash ON public.captive_auth_attempts (resume_token_hash);
CREATE INDEX idx_captive_auth_attempts_expires_at ON public.captive_auth_attempts (expires_at);
CREATE INDEX idx_captive_auth_attempts_client_mac ON public.captive_auth_attempts (client_mac);
