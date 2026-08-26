-- Centralize UniFi credentials in runtime secret storage.
-- Migration forward-only para limpar credenciais legadas e restringir acesso.

-- 1. Zerar valores legados de credenciais UniFi na tabela stores
UPDATE public.stores
SET unifi_username = NULL,
    unifi_password = NULL
WHERE unifi_username IS NOT NULL OR unifi_password IS NOT NULL;

-- 2. Revogar privilégios de SELECT nas colunas de credenciais para as roles anon e authenticated
REVOKE SELECT (unifi_username, unifi_password) ON public.stores FROM anon;
REVOKE SELECT (unifi_username, unifi_password) ON public.stores FROM authenticated;

-- 3. Garantir que apenas service_role possa ver essas colunas
GRANT SELECT (unifi_username, unifi_password) ON public.stores TO service_role;
