-- Enforce secure function access: only service_role (edge function) should call these sensitive RPCs.
-- The edge function authenticates users via auth.getUser and passes their ID as a parameter.

REVOKE EXECUTE ON FUNCTION public.secure_update_profile(UUID, TEXT, TEXT, TEXT) FROM authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.secure_update_profile(UUID, TEXT, TEXT, TEXT) TO service_role;

-- ensure secure_set_cpf is also restricted (already in previous migration but reinforcing)
REVOKE EXECUTE ON FUNCTION public.secure_set_cpf(UUID, TEXT) FROM authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.secure_set_cpf(UUID, TEXT) TO service_role;
