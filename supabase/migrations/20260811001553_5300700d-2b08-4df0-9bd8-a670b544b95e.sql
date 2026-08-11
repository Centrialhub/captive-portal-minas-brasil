UPDATE public.stores 
SET unifi_controller_url = REPLACE(unifi_controller_url, 'wifi.guedesepaixao.com.br', 'rwificontroller.drogariaminasbrasil.com.br:8083') 
WHERE unifi_controller_url LIKE '%guedesepaixao%';