-- Corrigir avisos do linter de segurança para a nova função de recuperação.
REVOKE EXECUTE ON FUNCTION public.release_auth_retry(UUID, TEXT) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_auth_retry(UUID, TEXT) TO service_role;
