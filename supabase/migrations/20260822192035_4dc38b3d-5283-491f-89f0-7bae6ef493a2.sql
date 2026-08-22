-- Fix security linter warnings for claim and finalize functions
-- The previous REVOKE ... FROM PUBLIC might not have been enough depending on default privileges

REVOKE EXECUTE ON FUNCTION public.claim_auth_attempt(UUID, UUID, TEXT, INTERVAL) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finalize_auth_attempt(UUID, TEXT, UUID, BOOLEAN, TEXT, TEXT, TEXT) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.link_session_to_attempt() FROM anon, authenticated, PUBLIC;

GRANT EXECUTE ON FUNCTION public.claim_auth_attempt(UUID, UUID, TEXT, INTERVAL) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_auth_attempt(UUID, TEXT, UUID, BOOLEAN, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.link_session_to_attempt() TO service_role;
