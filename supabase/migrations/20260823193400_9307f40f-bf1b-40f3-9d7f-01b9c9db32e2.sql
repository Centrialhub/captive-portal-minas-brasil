CREATE OR REPLACE FUNCTION public.claim_auth_attempt(
    p_attempt_id UUID,
    p_user_id UUID,
    p_lease_owner TEXT,
    p_lease_duration INTERVAL DEFAULT INTERVAL '30 seconds',
    p_resume_token TEXT DEFAULT NULL
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
SET search_path = public, extensions
AS $$
DECLARE
    v_attempt RECORD;
    v_now TIMESTAMPTZ := now();
BEGIN
    -- 1. Lock da linha antes de qualquer decisão (implementação obrigatória)
    SELECT * FROM public.captive_auth_attempts 
    WHERE id = p_attempt_id 
    FOR UPDATE INTO v_attempt;

    -- 2. Validar existência
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'ATTEMPT_NOT_FOUND'::TEXT, FALSE;
        RETURN;
    END IF;

    -- 3. Validate the capability against the stored SHA-256 hash.
    IF p_resume_token IS NULL OR p_resume_token = '' OR
       v_attempt.resume_token_hash IS DISTINCT FROM encode(digest(p_resume_token, 'sha256'), 'hex') THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'INVALID_RESUME_TOKEN'::TEXT, FALSE;
        RETURN;
    END IF;

    -- 4. Validar user_id vinculado
    IF v_attempt.user_id IS NOT NULL AND v_attempt.user_id <> p_user_id THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'FORBIDDEN_ATTEMPT'::TEXT, FALSE;
        RETURN;
    END IF;

    -- 5. Validar expiração temporal (mesmo se status ainda for created/oauth_*)
    IF v_attempt.expires_at < v_now THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'ATTEMPT_EXPIRED'::TEXT, FALSE;
        RETURN;
    END IF;

    -- 6. Tratar estados terminais e transições
    
    -- ESTADOS TERMINAIS DEFINITIVOS (Impedir reativação)
    IF v_attempt.status IN ('cancelled', 'expired', 'failed') THEN
        RETURN QUERY SELECT 'failed'::TEXT, v_attempt.captive_session_id, v_attempt.redirect_url, v_attempt.fail_reason, FALSE;
        RETURN;
    END IF;

    -- SUCESSO PERSISTIDO
    IF v_attempt.status = 'authorized' THEN
        RETURN QUERY SELECT 'completed'::TEXT, v_attempt.captive_session_id, v_attempt.redirect_url, NULL::TEXT, TRUE;
        RETURN;
    END IF;

    -- LEASE ATIVA (Processing)
    IF v_attempt.status = 'authorizing' AND v_attempt.lease_expires_at > v_now THEN
        RETURN QUERY SELECT 'processing'::TEXT, v_attempt.captive_session_id, NULL::TEXT, NULL::TEXT, FALSE;
        RETURN;
    END IF;

    -- RECUPERAÇÃO DE LEASE EXPIRADA (Recovery)
    IF v_attempt.status = 'authorizing' AND v_attempt.lease_expires_at <= v_now THEN
        UPDATE public.captive_auth_attempts
        SET 
            lease_owner = p_lease_owner,
            lease_expires_at = v_now + p_lease_duration
        WHERE id = p_attempt_id;
        
        RETURN QUERY SELECT 'recovery_required'::TEXT, v_attempt.captive_session_id, NULL::TEXT, NULL::TEXT, FALSE;
        RETURN;
    END IF;

    -- ESTADOS ELEGÍVEIS (created, oauth_redirected, callback_received, awaiting_cpf)
    IF v_attempt.status IN ('created', 'oauth_redirected', 'callback_received', 'awaiting_cpf') THEN
        UPDATE public.captive_auth_attempts
        SET 
            status = 'authorizing',
            user_id = p_user_id,
            authorization_started_at = v_now,
            lease_owner = p_lease_owner,
            lease_expires_at = v_now + p_lease_duration,
            authorization_attempts = authorization_attempts + 1
        WHERE id = p_attempt_id;

        RETURN QUERY SELECT 'claimed'::TEXT, v_attempt.captive_session_id, NULL::TEXT, NULL::TEXT, FALSE;
        RETURN;
    END IF;

    -- NUNCA USAR ELSE GENÉRICO (Retornar erro para estados desconhecidos)
    RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'UNHANDLED_STATUS:' || v_attempt.status, FALSE;
END;
$$;
