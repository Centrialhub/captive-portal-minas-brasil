-- Resolve the phone/CPF transition without creating a second Auth user for a
-- legacy profile. The function is intentionally service-role-only: public
-- callers must never be able to enumerate identity records.
CREATE OR REPLACE FUNCTION public.resolve_portal_identity(
    p_cpf_digits TEXT,
    p_phone_digits TEXT
)
RETURNS TABLE (
    resolution_status TEXT,
    user_id UUID
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_user_id UUID;
    v_candidate_ids UUID[];
BEGIN
    IF p_cpf_digits IS NULL OR p_cpf_digits !~ '^[0-9]{11}$'
       OR p_phone_digits IS NULL OR p_phone_digits !~ '^[0-9]{10,11}$' THEN
        RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    -- Serialize both sides of the rolling migration. Using the same lock order
    -- for every invocation avoids deadlocks when concurrent captive browsers
    -- submit the same identity.
    PERFORM pg_advisory_xact_lock(hashtextextended('portal-identity-cpf:' || p_cpf_digits, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('portal-identity-phone:' || p_phone_digits, 0));

    SELECT p.id
    INTO v_user_id
    FROM public.profiles AS p
    WHERE p.cpf_digits = p_cpf_digits
    FOR UPDATE;

    IF FOUND THEN
        RETURN QUERY SELECT 'existing'::TEXT, v_user_id;
        RETURN;
    END IF;

    SELECT array_agg(p.id ORDER BY p.created_at, p.id)
    INTO v_candidate_ids
    FROM public.profiles AS p
    WHERE (p.cpf_digits IS NULL OR p.cpf_digits = '')
      AND regexp_replace(COALESCE(p.phone_digits, ''), '\D', '', 'g') = p_phone_digits;

    IF COALESCE(cardinality(v_candidate_ids), 0) = 1 THEN
        v_user_id := v_candidate_ids[1];

        UPDATE public.profiles
        SET cpf_digits = p_cpf_digits,
            cpf_required = FALSE,
            updated_at = clock_timestamp()
        WHERE id = v_user_id
          AND (cpf_digits IS NULL OR cpf_digits = '');

        IF FOUND THEN
            RETURN QUERY SELECT 'migrated'::TEXT, v_user_id;
            RETURN;
        END IF;

        -- A defensive re-read covers an unexpected concurrent writer even
        -- though both identity advisory locks are held.
        SELECT p.id
        INTO v_user_id
        FROM public.profiles AS p
        WHERE p.cpf_digits = p_cpf_digits;

        IF FOUND THEN
            RETURN QUERY SELECT 'existing'::TEXT, v_user_id;
            RETURN;
        END IF;
    ELSIF COALESCE(cardinality(v_candidate_ids), 0) > 1 THEN
        RETURN QUERY SELECT 'ambiguous'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_portal_identity(TEXT, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_portal_identity(TEXT, TEXT)
TO service_role;

COMMENT ON FUNCTION public.resolve_portal_identity(TEXT, TEXT) IS
'Atomically resolves a CPF or attaches it to one unique legacy phone profile; service-role only.';

-- Keep expired authorization capabilities and their session records in a
-- consistent terminal state. This function is also called by housekeeping.
CREATE OR REPLACE FUNCTION public.expire_stale_auth_attempts()
RETURNS TABLE (
    expired_attempts INTEGER,
    failed_sessions INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_expired_attempts INTEGER := 0;
    v_failed_sessions INTEGER := 0;
BEGIN
    WITH expired AS (
        UPDATE public.captive_auth_attempts
        SET status = 'expired',
            fail_reason = COALESCE(fail_reason, 'ATTEMPT_EXPIRED'),
            authorization_finished_at = COALESCE(authorization_finished_at, clock_timestamp()),
            lease_owner = NULL,
            lease_expires_at = NULL
        WHERE status = 'authorizing'
          AND expires_at <= clock_timestamp()
        RETURNING captive_session_id
    ), updated_sessions AS (
        UPDATE public.captive_sessions AS s
        SET status = 'failed',
            fail_reason = 'ATTEMPT_EXPIRED',
            last_error_code = 'ATTEMPT_EXPIRED',
            updated_at = clock_timestamp()
        WHERE s.id IN (
            SELECT e.captive_session_id
            FROM expired AS e
            WHERE e.captive_session_id IS NOT NULL
        )
          AND s.status IN ('started', 'submitted')
        RETURNING s.id
    )
    SELECT
        (SELECT count(*)::INTEGER FROM expired),
        (SELECT count(*)::INTEGER FROM updated_sessions)
    INTO v_expired_attempts, v_failed_sessions;

    RETURN QUERY SELECT v_expired_attempts, v_failed_sessions;
END;
$function$;

REVOKE ALL ON FUNCTION public.expire_stale_auth_attempts()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_auth_attempts()
TO service_role;

COMMENT ON FUNCTION public.expire_stale_auth_attempts() IS
'Expires timed-out authorizing attempts and fails their non-terminal captive sessions; service-role only.';

-- Repair historical records immediately. This is idempotent and only touches
-- capabilities whose own ten-minute expiry has already elapsed.
SELECT * FROM public.expire_stale_auth_attempts();
