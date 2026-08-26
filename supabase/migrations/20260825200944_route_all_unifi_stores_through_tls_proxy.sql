-- Move every managed store behind the same TLS bridge. The original route
-- prefix is preserved because the controller gateway uses it to select the
-- target controller and set the unifi_controller routing cookie.
UPDATE public.stores
SET unifi_controller_url =
  'https://unifiproxy.minasbrasilwifi.com.br/' || slug
WHERE slug IN (
  'cintra', 'cula', 'dpedro', 'drive', 'hu', 'ibituruna',
  'joao23', 'major', 'matriz', 'mestra', 'povao', 'shopping'
)
AND is_active = true;
