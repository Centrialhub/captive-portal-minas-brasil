-- The public UniFi proxy must terminate TLS on the standard HTTPS port.
-- Port 8083 is loopback-only and must never be stored as a public controller URL.
UPDATE public.stores
SET unifi_controller_url = 'https://rwificontroller.drogariaminasbrasil.com.br'
WHERE unifi_controller_url IS NOT NULL
  AND (
    unifi_controller_url ~* '^https?://rwificontroller\.drogariaminasbrasil\.com\.br(?::(8083|8443))?(?:/.*)?$'
    OR unifi_controller_url ~* '^https?://wifi\.guedesepaixao\.com\.br(?:/.*)?$'
  );

ALTER TABLE public.stores
  DROP CONSTRAINT IF EXISTS stores_unifi_controller_url_https;

ALTER TABLE public.stores
  ADD CONSTRAINT stores_unifi_controller_url_https
  CHECK (
    unifi_controller_url IS NULL
    OR unifi_controller_url ~ '^https://'
  ) NOT VALID;

ALTER TABLE public.stores
  VALIDATE CONSTRAINT stores_unifi_controller_url_https;
