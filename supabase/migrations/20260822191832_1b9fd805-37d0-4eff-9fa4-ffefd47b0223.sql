-- Harden Google OAuth attempts.
-- Objetivo: Tornar as tentativas server-authoritative e impedir manipulação via Data API.

-- 1. Revogar todos os privilégios públicos
REVOKE ALL ON public.captive_auth_attempts FROM anon, authenticated, PUBLIC;

-- 2. Remover todas as policies existentes
DROP POLICY IF EXISTS "Anon can insert attempts" ON public.captive_auth_attempts;
DROP POLICY IF EXISTS "Users can see their own attempts" ON public.captive_auth_attempts;
DROP POLICY IF EXISTS "Service role full access" ON public.captive_auth_attempts;

-- 3. Conceder acesso apenas à service_role
GRANT ALL ON public.captive_auth_attempts TO service_role;

-- 4. Reforçar esquema da tabela
ALTER TABLE public.captive_auth_attempts
    ALTER COLUMN status SET DEFAULT 'created';

-- Add status check if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'captive_auth_attempts_status_check') THEN
        ALTER TABLE public.captive_auth_attempts 
        ADD CONSTRAINT captive_auth_attempts_status_check 
        CHECK (status IN (
            'created', 'oauth_redirected', 'callback_received', 'awaiting_cpf',
            'authorizing', 'authorized', 'failed', 'expired', 'cancelled'
        ));
    END IF;
END $$;

-- Add resume_token_hash format check if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'captive_auth_attempts_resume_token_hash_format') THEN
        ALTER TABLE public.captive_auth_attempts 
        ADD CONSTRAINT captive_auth_attempts_resume_token_hash_format 
        CHECK (resume_token_hash ~ '^[a-f0-9]{64}$');
    END IF;
END $$;

-- Add UNIQUE if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'captive_auth_attempts_resume_token_hash_unique') THEN
        ALTER TABLE public.captive_auth_attempts 
        ADD CONSTRAINT captive_auth_attempts_resume_token_hash_unique 
        UNIQUE (resume_token_hash);
    END IF;
END $$;

-- Add expiration check if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'captive_auth_attempts_expiration_check') THEN
        ALTER TABLE public.captive_auth_attempts 
        ADD CONSTRAINT captive_auth_attempts_expiration_check 
        CHECK (expires_at > created_at);
    END IF;
END $$;

-- 5. Garantir RLS fail-closed
ALTER TABLE public.captive_auth_attempts ENABLE ROW LEVEL SECURITY;

-- 6. Trigger para impedir troca de user_id após associação
CREATE OR REPLACE FUNCTION public.protect_attempt_user_id()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.user_id IS NOT NULL AND NEW.user_id IS NOT NULL AND OLD.user_id <> NEW.user_id THEN
        RAISE EXCEPTION 'user_id cannot be changed once associated';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_attempt_user_id_trigger ON public.captive_auth_attempts;
CREATE TRIGGER protect_attempt_user_id_trigger
BEFORE UPDATE ON public.captive_auth_attempts
FOR EACH ROW EXECUTE FUNCTION public.protect_attempt_user_id();
