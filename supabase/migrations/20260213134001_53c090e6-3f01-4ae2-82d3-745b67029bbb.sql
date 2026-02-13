
-- Fix 1: Drop the security definer view and replace with a regular view
DROP VIEW IF EXISTS public.stores_public;
CREATE VIEW public.stores_public WITH (security_invoker = true) AS
  SELECT id, slug, name, city, is_active
  FROM public.stores;

-- Fix 2: Set search_path on normalize_mac function
CREATE OR REPLACE FUNCTION public.normalize_mac(mac text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT upper(regexp_replace(COALESCE(mac, ''), '[^a-fA-F0-9]', '', 'g'))
$$;
