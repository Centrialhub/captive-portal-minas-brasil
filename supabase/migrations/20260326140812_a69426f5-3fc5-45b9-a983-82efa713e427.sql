UPDATE public.stores
SET unifi_username = 'hotspot',
    unifi_password = 'Hotspot@123',
    unifi_controller_url = 'http://rwificontroller.drogariaminasbrasil.com.br:8083/matriz',
    unifi_site_id = 'default',
    city = 'Montes Claros',
    updated_at = now()
WHERE slug = 'matriz';