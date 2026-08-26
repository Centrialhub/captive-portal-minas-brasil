-- Machine-readable marker for the release gate. Because migrations are
-- forward-only, observing this version proves the preceding auth/RLS
-- migrations were applied before the concurrency test runs.
CREATE OR REPLACE FUNCTION public.production_release_contract()
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT '20260824211347'::TEXT
$$;

REVOKE ALL ON FUNCTION public.production_release_contract() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.production_release_contract() TO service_role;

COMMENT ON FUNCTION public.production_release_contract() IS
  'Service-role-only marker consumed by the production release gate.';
