-- Route Edge Function traffic through the TLS proxy hosted beside the portal.
-- The proxy then forwards /matriz/ to the fixed legacy controller gateway.
UPDATE public.stores
SET unifi_controller_url = 'https://unifiproxy.minasbrasilwifi.com.br/matriz'
WHERE slug = 'matriz'
  AND (
    unifi_controller_url IS NULL
    OR unifi_controller_url ~* '^https?://rwificontroller\.drogariaminasbrasil\.com\.br(?::(8083|8443))?(?:/.*)?$'
    OR unifi_controller_url ~* '^https?://wifi\.guedesepaixao\.com\.br(?:/.*)?$'
    OR unifi_controller_url ~* '^https?://unifiproxy\.minasbrasilwifi\.com\.br(?:/.*)?$'
  );
