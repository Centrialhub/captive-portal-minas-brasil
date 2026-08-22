
CREATE OR REPLACE FUNCTION public.safe_restart_oauth_attempt(
    p_attempt_id UUID,
    p_resume_token TEXT,
    p_client_ip TEXT DEFAULT NULL
)
RETURNS TABLE (
    new_attempt_id UUID,
    new_token TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_old_attempt RECORD;
    v_token_hash TEXT;
    v_new_token TEXT;
    v_new_token_hash TEXT;
    v_new_attempt_id UUID;
    v_now TIMESTAMPTZ := now();
BEGIN
    -- 1. Lock da linha para evitar concorrência
    SELECT * INTO v_old_attempt 
    FROM public.captive_auth_attempts 
    WHERE id = p_attempt_id 
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ATTEMPT_NOT_FOUND';
    END IF;

    -- 2. Validar Token (Capability Check)
    v_token_hash := encode(digest(p_resume_token, 'sha256'), 'hex');
    
    IF v_old_attempt.resume_token_hash <> v_token_hash THEN
        RAISE EXCEPTION 'INVALID_TOKEN';
    END IF;

    -- 3. Validar Expiração e Estado
    IF v_old_attempt.expires_at < v_now THEN
         RAISE EXCEPTION 'ATTEMPT_EXPIRED';
    END IF;

    -- Estados permitidos: created, oauth_redirected, callback_received, awaiting_cpf
    IF v_old_attempt.status NOT IN ('created', 'oauth_redirected', 'callback_received', 'awaiting_cpf') THEN
        RAISE EXCEPTION 'INVALID_STATE_FOR_RESTART';
    END IF;

    -- 5. Cancelar tentativa antiga
    UPDATE public.captive_auth_attempts
    SET status = 'cancelled',
        updated_at = v_now
    WHERE id = p_attempt_id;

    -- 6. Gerar novo token
    v_new_token := encode(gen_random_bytes(32), 'hex');
    v_new_token_hash := encode(digest(v_new_token, 'sha256'), 'hex');

    -- 7. Criar nova tentativa copiando parâmetros captivos autoritativos
    INSERT INTO public.captive_auth_attempts (
        client_mac,
        ap_mac,
        ssid,
        store_hint,
        captive_timestamp,
        original_url,
        resume_token_hash,
        status,
        expires_at,
        metadata
    ) VALUES (
        v_old_attempt.client_mac,
        v_old_attempt.ap_mac,
        v_old_attempt.ssid,
        v_old_attempt.store_hint,
        v_old_attempt.captive_timestamp,
        v_old_attempt.original_url,
        v_new_token_hash,
        'created',
        v_now + INTERVAL '10 minutes',
        jsonb_build_object('restarted_from', p_attempt_id, 'client_ip', p_client_ip)
    ) RETURNING id INTO v_new_attempt_id;

    RETURN QUERY SELECT v_new_attempt_id, v_new_token;
END;
$$;

REVOKE ALL ON FUNCTION public.safe_restart_oauth_attempt(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safe_restart_oauth_attempt(UUID, TEXT, TEXT) TO service_role;
