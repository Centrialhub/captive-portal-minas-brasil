-- Consolidate the captive authorization invariants after the incremental
-- idempotency migrations. This migration is safe to apply to databases where
-- the earlier migrations have already run.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- The application actively uses authorizing and the OAuth transition states.
-- Recreate the named check instead of relying on the earlier create-if-missing
-- migration, whose value list only allowed terminal states.
ALTER TABLE public.captive_auth_attempts
    DROP CONSTRAINT IF EXISTS captive_auth_attempts_status_check;

UPDATE public.captive_auth_attempts
SET status = 'authorizing'
WHERE status = 'verifying';

ALTER TABLE public.captive_auth_attempts
    ADD CONSTRAINT captive_auth_attempts_status_check
    CHECK (status IN (
        'created',
        'oauth_redirected',
        'callback_received',
        'awaiting_cpf',
        'authorizing',
        'authorized',
        'failed',
        'expired',
        'cancelled'
    ));

UPDATE public.captive_auth_attempts
SET authorization_attempts = 0
WHERE authorization_attempts IS NULL;

ALTER TABLE public.captive_auth_attempts
    ALTER COLUMN authorization_attempts SET DEFAULT 0,
    ALTER COLUMN authorization_attempts SET NOT NULL;

DROP FUNCTION IF EXISTS public.claim_auth_attempt(UUID, UUID, TEXT, INTERVAL, TEXT);
DROP FUNCTION IF EXISTS public.claim_auth_attempt(UUID, UUID, TEXT, INTERVAL);

CREATE FUNCTION public.claim_auth_attempt(
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
    v_attempt public.captive_auth_attempts%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_token_hash TEXT;
BEGIN
    SELECT * INTO v_attempt
    FROM public.captive_auth_attempts
    WHERE id = p_attempt_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'ATTEMPT_NOT_FOUND'::TEXT, FALSE;
        RETURN;
    END IF;

    IF p_resume_token IS NULL OR p_resume_token = '' THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'RESUME_TOKEN_REQUIRED'::TEXT, FALSE;
        RETURN;
    END IF;

    IF p_user_id IS NULL OR p_lease_owner IS NULL OR p_lease_owner = '' THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'INVALID_CLAIM_CONTEXT'::TEXT, FALSE;
        RETURN;
    END IF;

    v_token_hash := encode(digest(p_resume_token, 'sha256'), 'hex');
    IF v_attempt.resume_token_hash IS DISTINCT FROM v_token_hash THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'INVALID_RESUME_TOKEN'::TEXT, FALSE;
        RETURN;
    END IF;

    IF v_attempt.user_id IS NOT NULL AND v_attempt.user_id <> p_user_id THEN
        RETURN QUERY SELECT 'failed'::TEXT, NULL::UUID, NULL::TEXT, 'FORBIDDEN_ATTEMPT'::TEXT, FALSE;
        RETURN;
    END IF;

    IF v_attempt.expires_at <= v_now THEN
        UPDATE public.captive_auth_attempts
        SET status = 'expired', lease_owner = NULL, lease_expires_at = NULL
        WHERE id = p_attempt_id AND status NOT IN ('authorized', 'cancelled');

        RETURN QUERY SELECT 'failed'::TEXT, v_attempt.captive_session_id, v_attempt.redirect_url, 'ATTEMPT_EXPIRED'::TEXT, FALSE;
        RETURN;
    END IF;

    IF v_attempt.status IN ('cancelled', 'expired', 'failed') THEN
        RETURN QUERY SELECT 'failed'::TEXT, v_attempt.captive_session_id, v_attempt.redirect_url, COALESCE(v_attempt.fail_reason, upper(v_attempt.status)), FALSE;
        RETURN;
    END IF;

    IF v_attempt.status = 'authorized' THEN
        RETURN QUERY SELECT 'completed'::TEXT, v_attempt.captive_session_id, v_attempt.redirect_url, NULL::TEXT, TRUE;
        RETURN;
    END IF;

    IF v_attempt.status = 'authorizing' AND v_attempt.lease_expires_at > v_now THEN
        RETURN QUERY SELECT 'processing'::TEXT, v_attempt.captive_session_id, NULL::TEXT, NULL::TEXT, FALSE;
        RETURN;
    END IF;

    IF v_attempt.status = 'authorizing' THEN
        UPDATE public.captive_auth_attempts
        SET lease_owner = p_lease_owner,
            lease_expires_at = v_now + p_lease_duration
        WHERE id = p_attempt_id;

        RETURN QUERY SELECT 'recovery_required'::TEXT, v_attempt.captive_session_id, NULL::TEXT, NULL::TEXT, FALSE;
        RETURN;
    END IF;

    IF v_attempt.status IN ('created', 'oauth_redirected', 'callback_received', 'awaiting_cpf') THEN
        UPDATE public.captive_auth_attempts
        SET status = 'authorizing',
            user_id = p_user_id,
            authorization_started_at = v_now,
            lease_owner = p_lease_owner,
            lease_expires_at = v_now + p_lease_duration,
            authorization_attempts = authorization_attempts + 1
        WHERE id = p_attempt_id;

        RETURN QUERY SELECT 'claimed'::TEXT, v_attempt.captive_session_id, NULL::TEXT, NULL::TEXT, FALSE;
        RETURN;
    END IF;

    RETURN QUERY SELECT 'failed'::TEXT, v_attempt.captive_session_id, NULL::TEXT, 'UNHANDLED_STATUS:' || v_attempt.status, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_auth_attempt(UUID, UUID, TEXT, INTERVAL, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_auth_attempt(UUID, UUID, TEXT, INTERVAL, TEXT) TO service_role;

-- A recovery check that conclusively finds the client unauthorized may release
-- the same capability for an explicit retry. Terminal failed/cancelled attempts
-- remain irreversible.
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
    UPDATE public.captive_auth_attempts
    SET status = CASE WHEN authorization_attempts < 3 THEN 'callback_received' ELSE 'failed' END,
        lease_owner = NULL,
        lease_expires_at = NULL,
        fail_reason = CASE WHEN authorization_attempts < 3 THEN NULL ELSE 'MAX_AUTHORIZATION_ATTEMPTS' END,
        authorization_finished_at = CASE WHEN authorization_attempts < 3 THEN authorization_finished_at ELSE clock_timestamp() END
    WHERE id = p_attempt_id
      AND lease_owner = p_lease_owner
      AND status = 'authorizing';

    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.release_auth_retry(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_auth_retry(UUID, TEXT) TO service_role;

-- Keep the privileged lookup outside the exposed API schema. It is deliberately
-- restricted to the current JWT subject and only reveals a boolean.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.is_current_user_role(_role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = (SELECT auth.uid())
      AND role = _role
  )
$$;

REVOKE ALL ON FUNCTION private.is_current_user_role(public.app_role) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION private.is_current_user_role(public.app_role) TO authenticated;

-- Public RPC kept for the admin UI, now SECURITY INVOKER. The supplied user id
-- must match auth.uid(), so another user's role cannot be probed.
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT _user_id = (SELECT auth.uid())
     AND (SELECT private.is_current_user_role(_role))
$$;

REVOKE ALL ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated;

-- The frontend uses the Data API only for the authenticated observability UI.
-- Everything else is accessed by the Edge Function with service_role.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.captive_sessions, public.portal_events, public.profiles TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated;

-- New public objects created by repository migrations are opt-in to the Data
-- API. Supabase does not permit migrations to alter supabase_admin defaults;
-- disable automatic exposure in the Dashboard for objects created there.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

-- Replace the accumulated permissive policies with the exact client contract.
DO $$
DECLARE
  policy_row RECORD;
BEGIN
  FOR policy_row IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', policy_row.policyname, policy_row.schemaname, policy_row.tablename);
  END LOOP;
END
$$;

CREATE POLICY "Users can read own sessions"
ON public.captive_sessions
FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Admins can read sessions"
ON public.captive_sessions
FOR SELECT TO authenticated
USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

CREATE POLICY "Users can read own profile"
ON public.profiles
FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = id);

CREATE POLICY "Admins can read profiles"
ON public.profiles
FOR SELECT TO authenticated
USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

CREATE POLICY "Admins can read portal events"
ON public.portal_events
FOR SELECT TO authenticated
USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

-- Remove redundant constraints/indexes produced by incremental migrations.
ALTER TABLE public.captive_sessions
  DROP CONSTRAINT IF EXISTS captive_sessions_attempt_id_fkey;

DROP INDEX IF EXISTS public.idx_captive_auth_attempts_client_mac;
DROP INDEX IF EXISTS public.idx_captive_auth_attempts_token_hash;
DROP INDEX IF EXISTS public.idx_sessions_store_started;
DROP INDEX IF EXISTS public.captive_sessions_attempt_id_unique_idx;
DROP INDEX IF EXISTS public.idx_sessions_attempt_id;
DROP INDEX IF EXISTS public.idx_captive_verifications_pending_session;
DROP INDEX IF EXISTS public.idx_leads_mac_created;
ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS stores_slug_unique;

-- Cover every remaining foreign key used for joins or referential checks.
CREATE INDEX IF NOT EXISTS idx_captive_auth_attempts_user_id
  ON public.captive_auth_attempts (user_id);
CREATE INDEX IF NOT EXISTS idx_captive_verifications_lead_id
  ON public.captive_verifications (lead_id);
CREATE INDEX IF NOT EXISTS idx_captive_verifications_store_id
  ON public.captive_verifications (store_id);
CREATE INDEX IF NOT EXISTS idx_leads_last_seen_store_id
  ON public.leads (last_seen_store_id);
CREATE INDEX IF NOT EXISTS idx_store_public_ips_store_id
  ON public.store_public_ips (store_id);
