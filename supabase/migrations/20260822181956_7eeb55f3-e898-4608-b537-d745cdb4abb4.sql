-- Migration to drop legacy UniFi secret columns from public.stores
-- and ensure they are no longer present in the database.

ALTER TABLE public.stores 
  DROP COLUMN IF EXISTS unifi_username, 
  DROP COLUMN IF EXISTS unifi_password,
  DROP COLUMN IF EXISTS unifi_api_key_or_token;

-- Re-grant access to the table for authenticated users and service_role
GRANT SELECT ON public.stores TO authenticated;
GRANT ALL ON public.stores TO service_role;