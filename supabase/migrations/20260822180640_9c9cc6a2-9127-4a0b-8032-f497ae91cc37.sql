-- PROMPT 08 SECURITY FIX: Restrict function execution to service_role only

-- Revoke default execute from public (which includes anon and authenticated)
REVOKE EXECUTE ON FUNCTION public.secure_update_profile(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;

-- Explicitly allow service_role to execute it
GRANT EXECUTE ON FUNCTION public.secure_update_profile(UUID, TEXT, TEXT, TEXT) TO service_role;
