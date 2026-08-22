-- 1. Atualizar claim_auth_attempt para suportar 'recovery_required'
-- Isso acontece quando a lease expirou mas o status ainda é 'authorizing' (provável crash).
CREATE OR REPLACE FUNCTION public.claim_auth_attempt(
    p_attempt_id UUID,
    p_user_id UUID,
    p_lease_owner TEXT,
    p_lease_duration INTERVAL DEFAULT INTERVAL '30 seconds'
)
RETURNS TABLE (
    result_status TEXT,
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
    SELECT * FROM captive_auth_attempts 
    WHERE id = p_attempt_id 
    FOR UPDATE INTO v_attempt;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'ATTEMPT_NOT_FOUND'::TEXT, FALSE;
        RETURN;
    END IF;

    IF v_attempt.expires_at < v_now THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'ATTEMPT_EXPIRED'::TEXT, FALSE;
        RETURN;
    END IF;

    IF v_attempt.user_id IS NOT NULL AND v_attempt.user_id <> p_user_id THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'FORBIDDEN_ATTEMPT'::TEXT, FALSE;
        RETURN;
    END IF;

    IF v_attempt.status = 'authorized' THEN
        RETURN QUERY SELECT 'completed'::TEXT, v_attempt.captive_session_id, v_attempt.redirect_url, NULL::TEXT, TRUE;
        RETURN;
    END IF;

    -- Se a lease expirou mas ainda está em 'authorizing', exige recuperação antes de novo comando.
    IF v_attempt.status = 'authorizing' AND v_attempt.lease_expires_at <= v_now THEN
        -- O worker que pegar este status se torna o owner da lease de recuperação.
        UPDATE captive_auth_attempts
        SET 
            lease_owner = p_lease_owner,
            lease_expires_at = v_now + p_lease_duration
        WHERE id = p_attempt_id;
        
        RETURN QUERY SELECT 'recovery_required'::TEXT, v_attempt.captive_session_id, NULL::TEXT, NULL::TEXT, FALSE;
        RETURN;
    END IF;

    IF v_attempt.status = 'failed' AND v_attempt.authorization_attempts >= 3 THEN
        RETURN QUERY SELECT 'failed'::TEXT, v_attempt.captive_session_id, v_attempt.redirect_url, v_attempt.fail_reason, FALSE;
        RETURN;
    END IF;

    IF v_attempt.status = 'authorizing' AND v_attempt.lease_expires_at > v_now THEN
        RETURN QUERY SELECT 'processing'::TEXT, v_attempt.captive_session_id, NULL::TEXT, NULL::TEXT, FALSE;
        RETURN;
    END IF;

    UPDATE captive_auth_attempts
    SET 
        status = 'authorizing',
        user_id = p_user_id,
        authorization_started_at = v_now,
        lease_owner = p_lease_owner,
        lease_expires_at = v_now + p_lease_duration,
        authorization_attempts = authorization_attempts + 1
    WHERE id = p_attempt_id;

    v_session_id := v_attempt.captive_session_id;
    RETURN QUERY SELECT 'claimed'::TEXT, v_session_id, NULL::TEXT, NULL::TEXT, FALSE;
END;
$$;

-- 2. Criar RPC para liberar retry explícito
CREATE OR REPLACE FUNCTION public.release_auth_retry(
    p_attempt_id UUID,
    p_lease_owner TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE captive_auth_attempts
    SET 
        status = 'failed',
        lease_expires_at = now()
    WHERE id = p_attempt_id 
      AND lease_owner = p_lease_owner
      AND status = 'authorizing';

    RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_auth_retry(UUID, TEXT) TO service_role;
