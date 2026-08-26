-- Replace pseudo-idempotency with transactional claims.

-- 1. Database schema updates
-- Add attempt_id to captive_sessions
ALTER TABLE public.captive_sessions ADD COLUMN IF NOT EXISTS attempt_id UUID;

-- Add necessary tracking columns to captive_auth_attempts
ALTER TABLE public.captive_auth_attempts 
    ADD COLUMN IF NOT EXISTS captive_session_id UUID REFERENCES public.captive_sessions(id),
    ADD COLUMN IF NOT EXISTS authorization_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS authorization_finished_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lease_owner TEXT,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS authorization_attempts INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS authorized BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS fail_reason TEXT,
    ADD COLUMN IF NOT EXISTS redirect_url TEXT,
    ADD COLUMN IF NOT EXISTS last_result_code TEXT;

-- Index for attempt association
CREATE INDEX IF NOT EXISTS idx_captive_sessions_attempt_id ON public.captive_sessions(attempt_id);

-- 2. Transactional Claim RPC
CREATE OR REPLACE FUNCTION public.claim_auth_attempt(
    p_attempt_id UUID,
    p_user_id UUID,
    p_lease_owner TEXT,
    p_lease_duration INTERVAL DEFAULT INTERVAL '30 seconds'
)
RETURNS TABLE (
    result_status TEXT, -- 'claimed', 'processing', 'completed', 'failed'
    session_id UUID,
    redirect_url TEXT,
    fail_reason TEXT,
    authorized BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_attempt RECORD;
    v_session_id UUID;
    v_now TIMESTAMPTZ := now();
BEGIN
    -- 1. Lock the attempt row for atomic transition
    SELECT * FROM captive_auth_attempts 
    WHERE id = p_attempt_id 
    FOR UPDATE INTO v_attempt;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'ATTEMPT_NOT_FOUND'::TEXT, FALSE;
        RETURN;
    END IF;

    -- 2. Validation
    IF v_attempt.expires_at < v_now THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'ATTEMPT_EXPIRED'::TEXT, FALSE;
        RETURN;
    END IF;

    -- user_id swap protection (handled by trigger too, but good here for response)
    IF v_attempt.user_id IS NOT NULL AND v_attempt.user_id <> p_user_id THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'FORBIDDEN_ATTEMPT'::TEXT, FALSE;
        RETURN;
    END IF;

    -- 3. Check terminal state (Replay after success)
    IF v_attempt.status = 'authorized' THEN
        RETURN QUERY SELECT 'completed'::TEXT, v_attempt.captive_session_id, v_attempt.redirect_url, NULL::TEXT, TRUE;
        RETURN;
    END IF;

    IF v_attempt.status = 'failed' AND v_attempt.authorization_attempts >= 3 THEN
        RETURN QUERY SELECT 'failed'::TEXT, v_attempt.captive_session_id, v_attempt.redirect_url, v_attempt.fail_reason, FALSE;
        RETURN;
    END IF;

    -- 4. Check active lease (Concurrent processing)
    IF v_attempt.status = 'authorizing' AND v_attempt.lease_expires_at > v_now THEN
        RETURN QUERY SELECT 'processing'::TEXT, v_attempt.captive_session_id, NULL::TEXT, NULL::TEXT, FALSE;
        RETURN;
    END IF;

    -- 5. Transition to authorizing + Lease
    UPDATE captive_auth_attempts
    SET 
        status = 'authorizing',
        user_id = p_user_id,
        authorization_started_at = v_now,
        lease_owner = p_lease_owner,
        lease_expires_at = v_now + p_lease_duration,
        authorization_attempts = authorization_attempts + 1
    WHERE id = p_attempt_id;

    -- 6. Retrieve or generate session_id
    -- We use a partial unique index on attempt_id to ensure one session per attempt
    -- But here we just lookup or return what we have
    v_session_id := v_attempt.captive_session_id;

    RETURN QUERY SELECT 'claimed'::TEXT, v_session_id, NULL::TEXT, NULL::TEXT, FALSE;
END;
$$;

-- 3. Finalization RPC
CREATE OR REPLACE FUNCTION public.finalize_auth_attempt(
    p_attempt_id UUID,
    p_lease_owner TEXT,
    p_session_id UUID,
    p_authorized BOOLEAN,
    p_redirect_url TEXT DEFAULT NULL,
    p_fail_reason TEXT DEFAULT NULL,
    p_result_code TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE captive_auth_attempts
    SET 
        status = CASE WHEN p_authorized THEN 'authorized' ELSE 'failed' END,
        captive_session_id = p_session_id,
        authorized = p_authorized,
        redirect_url = p_redirect_url,
        fail_reason = p_fail_reason,
        last_result_code = p_result_code,
        authorization_finished_at = now(),
        consumed_at = CASE WHEN p_authorized THEN now() ELSE consumed_at END,
        lease_expires_at = now() -- Release lease
    WHERE id = p_attempt_id 
      AND lease_owner = p_lease_owner; -- Only the owner can finalize

    RETURN FOUND;
END;
$$;

-- 4. Grant access to service_role only
REVOKE ALL ON FUNCTION public.claim_auth_attempt(UUID, UUID, TEXT, INTERVAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_auth_attempt(UUID, TEXT, UUID, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_auth_attempt(UUID, UUID, TEXT, INTERVAL) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_auth_attempt(UUID, TEXT, UUID, BOOLEAN, TEXT, TEXT, TEXT) TO service_role;

-- 5. Atomic link trigger for captive_sessions
CREATE OR REPLACE FUNCTION public.link_session_to_attempt()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.attempt_id IS NOT NULL THEN
        UPDATE public.captive_auth_attempts 
        SET captive_session_id = NEW.id 
        WHERE id = NEW.attempt_id AND captive_session_id IS NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS link_session_to_attempt_trigger ON public.captive_sessions;
CREATE TRIGGER link_session_to_attempt_trigger
AFTER INSERT ON public.captive_sessions
FOR EACH ROW EXECUTE FUNCTION public.link_session_to_attempt();
