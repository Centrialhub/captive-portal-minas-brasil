
-- Optimization: Indexes for frequent query targets
CREATE INDEX IF NOT EXISTS idx_auth_attempts_client_mac ON public.captive_auth_attempts (client_mac);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_status ON public.captive_auth_attempts (status);
CREATE INDEX IF NOT EXISTS idx_sessions_client_mac ON public.captive_sessions (client_mac);
CREATE INDEX IF NOT EXISTS idx_sessions_attempt_id ON public.captive_sessions (attempt_id);

-- Hardening: Ensure store slugs are unique and not null
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stores_slug_unique') THEN
        ALTER TABLE public.stores ADD CONSTRAINT stores_slug_unique UNIQUE (slug);
    END IF;
END $$;

-- Hardening: Ensure base timestamps are not null
ALTER TABLE public.stores ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.captive_auth_attempts ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.captive_sessions ALTER COLUMN started_at SET NOT NULL;
