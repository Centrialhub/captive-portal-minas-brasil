DROP FUNCTION IF EXISTS public.finalize_auth_attempt(UUID, TEXT, UUID, BOOLEAN, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.finalize_auth_attempt(
    p_attempt_id UUID,
    p_lease_owner TEXT,
    p_session_id UUID,
    p_authorized BOOLEAN,
    p_redirect_url TEXT DEFAULT NULL,
    p_fail_reason TEXT DEFAULT NULL,
    p_result_code TEXT DEFAULT NULL
)
RETURNS TABLE (
    finalized BOOLEAN,
    status_final TEXT,
    session_id UUID,
    authorized BOOLEAN,
    redirect_url TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_attempt RECORD;
    v_now TIMESTAMPTZ := now();
BEGIN
    -- 1. Lock rigoroso
    SELECT * FROM public.captive_auth_attempts 
    WHERE id = p_attempt_id 
    FOR UPDATE INTO v_attempt;

    -- 2. Validar existência e terminalidade
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'NOT_FOUND'::TEXT, NULL::UUID, FALSE, NULL::TEXT;
        RETURN;
    END IF;

    -- 3. Se já finalizada por outro ou pelo mesmo, retornar estado atual sem mudar nada
    IF v_attempt.status IN ('authorized', 'failed', 'cancelled', 'expired') THEN
        RETURN QUERY SELECT TRUE, v_attempt.status, v_attempt.captive_session_id, v_attempt.authorized, v_attempt.redirect_url;
        RETURN;
    END IF;

    -- 4. Validar propriedade da lease
    IF v_attempt.lease_owner IS DISTINCT FROM p_lease_owner THEN
        RETURN QUERY SELECT FALSE, 'LEASE_MISMATCH'::TEXT, v_attempt.captive_session_id, v_attempt.authorized, v_attempt.redirect_url;
        RETURN;
    END IF;

    -- 5. Atualizar somente se em estado de processamento
    UPDATE public.captive_auth_attempts
    SET 
        status = CASE WHEN p_authorized THEN 'authorized' ELSE 'failed' END,
        captive_session_id = COALESCE(p_session_id, captive_session_id),
        authorized = p_authorized,
        redirect_url = p_redirect_url,
        fail_reason = p_fail_reason,
        last_result_code = p_result_code,
        authorization_finished_at = v_now,
        consumed_at = CASE WHEN p_authorized AND consumed_at IS NULL THEN v_now ELSE consumed_at END,
        lease_owner = NULL, -- Limpar lease
        lease_expires_at = NULL
    WHERE id = p_attempt_id;

    RETURN QUERY SELECT TRUE, 
                        CASE WHEN p_authorized THEN 'authorized'::TEXT ELSE 'failed'::TEXT END,
                        COALESCE(p_session_id, v_attempt.captive_session_id),
                        p_authorized,
                        p_redirect_url;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_auth_attempt(UUID, TEXT, UUID, BOOLEAN, TEXT, TEXT, TEXT) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_auth_attempt(UUID, TEXT, UUID, BOOLEAN, TEXT, TEXT, TEXT) TO service_role;