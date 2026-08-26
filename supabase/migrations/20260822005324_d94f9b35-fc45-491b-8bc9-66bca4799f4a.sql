-- Restrict execution of security-definer functions.
-- 1. Restringir execução de funções SECURITY DEFINER
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(text, int, int, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(text, int, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(text, int, int, int) TO authenticated, service_role;

-- 2. Limpar credenciais legadas (reforço)
UPDATE public.stores SET unifi_username = NULL, unifi_password = NULL;
