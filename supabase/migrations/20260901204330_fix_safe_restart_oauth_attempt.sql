-- Fix OAuth restart and preserve the authoritative store resolution.
CREATE OR REPLACE FUNCTION public.safe_restart_oauth_attempt(
    p_attempt_id UUID,
    p_resume_token TEXT,
    p_client_ip TEXT DEFAULT NULL
)
RETURNS TABLE(new_attempt_id UUID, new_token TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $function$
DECLARE
    v_old_attempt RECORD;
    v_token_hash TEXT;
    v_new_token TEXT;
    v_new_token_hash TEXT;
    v_new_attempt_id UUID;
    v_now TIMESTAMPTZ := now();
BEGIN
    SELECT *
    INTO v_old_attempt
    FROM public.captive_auth_attempts
    WHERE id = p_attempt_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ATTEMPT_NOT_FOUND';
    END IF;

    v_token_hash := encode(extensions.digest(p_resume_token, 'sha256'), 'hex');

    IF v_old_attempt.resume_token_hash <> v_token_hash THEN
        RAISE EXCEPTION 'INVALID_TOKEN';
    END IF;

    IF v_old_attempt.expires_at < v_now THEN
        RAISE EXCEPTION 'ATTEMPT_EXPIRED';
    END IF;

    IF v_old_attempt.status NOT IN (
        'created',
        'oauth_redirected',
        'callback_received',
        'awaiting_cpf'
    ) THEN
        RAISE EXCEPTION 'INVALID_STATE_FOR_RESTART';
    END IF;

    UPDATE public.captive_auth_attempts
    SET status = 'cancelled'
    WHERE id = p_attempt_id;

    v_new_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_new_token_hash := encode(extensions.digest(v_new_token, 'sha256'), 'hex');

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
        metadata,
        store_id,
        store_detection_source
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
        COALESCE(v_old_attempt.metadata, '{}'::jsonb)
            || jsonb_build_object(
                'restarted_from', p_attempt_id,
                'client_ip', p_client_ip
            ),
        v_old_attempt.store_id,
        v_old_attempt.store_detection_source
    )
    RETURNING id INTO v_new_attempt_id;

    RETURN QUERY SELECT v_new_attempt_id, v_new_token;
END;
$function$;

REVOKE ALL ON FUNCTION public.safe_restart_oauth_attempt(UUID, TEXT, TEXT)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.safe_restart_oauth_attempt(UUID, TEXT, TEXT)
TO service_role;
