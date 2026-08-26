-- Finalize OTP subsystem removal and lock historical tables for non-admin roles.

-- 1. Revoke generic modification permissions on captive_sessions.
-- The app uses Edge Functions with service_role for updates.
REVOKE INSERT, UPDATE, DELETE ON public.captive_sessions FROM authenticated, anon;
GRANT SELECT ON public.captive_sessions TO authenticated;
GRANT ALL ON public.captive_sessions TO service_role;

-- 2. Revoke modification on portal_events.
REVOKE UPDATE, DELETE ON public.portal_events FROM authenticated, anon;
GRANT SELECT, INSERT ON public.portal_events TO authenticated;
GRANT ALL ON public.portal_events TO service_role;

-- 3. Revoke EXECUTE on legacy OTP RPCs if they exist.
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'verify_otp') THEN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.verify_otp FROM authenticated, anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'request_otp') THEN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.request_otp FROM authenticated, anon';
    END IF;
END $$;

COMMENT ON TABLE public.captive_sessions IS 'Historical portal sessions; the legacy OTP subsystem is disabled.';
