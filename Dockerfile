FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html

RUN printf 'server {\n\
    listen 3000;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    absolute_redirect off;\n\
    port_in_redirect off;\n\
\n\
    location = /health {\n\
        access_log off;\n\
        default_type text/plain;\n\
        return 200 "ok";\n\
    }\n\
\n\
    # Proxy para Edge Functions do Supabase\n\
    location /api/captive-portal/ {\n\
        proxy_pass https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal/;\n\
        proxy_set_header Host fqamejlyytrhovawgtwg.supabase.co;\n\
        proxy_set_header X-Real-IP $remote_addr;\n\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
        proxy_set_header X-Forwarded-Proto http;\n\
        proxy_ssl_server_name on;\n\
        proxy_ssl_protocols TLSv1.2 TLSv1.3;\n\
        proxy_http_version 1.1;\n\
        # Allow long edge function calls (verify-code can take ~20s)\n\
        proxy_connect_timeout 30s;\n\
        proxy_send_timeout 60s;\n\
        proxy_read_timeout 60s;\n\
        proxy_buffering off;\n\
        proxy_request_buffering off;\n\
        client_max_body_size 1m;\n\
        # Always send CORS headers, even on upstream errors\n\
        add_header Access-Control-Allow-Origin "*" always;\n\
        add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;\n\
        add_header Access-Control-Allow-Headers "authorization, x-client-info, apikey, content-type" always;\n\
        if ($request_method = OPTIONS) { return 204; }\n\
    }\n\
\n\
    # Proxy para o container unifi-proxy (comunicacao interna)\n\
    location /unifi-proxy/ {\n\
        proxy_pass http://unifi-proxy:80/;\n\
        proxy_ssl_verify off;\n\
        proxy_set_header Host guedesepaixao.com.br;\n\
        proxy_set_header X-Real-IP $remote_addr;\n\
        proxy_connect_timeout 10s;\n\
        proxy_read_timeout 30s;\n\
    }\n\
\n\
    # Proxy reverso para o UniFi Controller\n\
    # SSL terminado pelo EasyPanel, permite acesso via dominio com cert valido\n\
    location /unifi/ {\n\
        proxy_pass https://rwificontroller.drogariaminasbrasil.com.br:8083/;\n\
        proxy_ssl_verify off;\n\
        proxy_ssl_server_name on;\n\
        proxy_set_header Host rwificontroller.drogariaminasbrasil.com.br;\n\
        proxy_set_header X-Real-IP $remote_addr;\n\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
        proxy_set_header X-Forwarded-Proto https;\n\
        proxy_set_header Referer "";\n\
        proxy_connect_timeout 10s;\n\
        proxy_read_timeout 30s;\n\
        proxy_buffering off;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Upgrade $http_upgrade;\n\
        proxy_set_header Connection "upgrade";\n\
    }\n\
\n\
    # Redirect do captive portal UniFi (IP) para dominio com SSL valido\n\
    # Controladoras agora tem certificado publico, entao redirect HTTPS eh seguro.\n\
    location /guest/s/default/ {\n\
        return 302 https://drogariaminasbrasilapp.com.br/?$args;\n\
    }\n\
\n\
    location = /generate_204 { return 302 https://drogariaminasbrasilapp.com.br/?$args; }\n\
    location = /gen_204 { return 302 https://drogariaminasbrasilapp.com.br/?$args; }\n\
    location = /hotspot-detect.html { return 302 https://drogariaminasbrasilapp.com.br/?$args; }\n\
    location = /library/test/success.html { return 302 https://drogariaminasbrasilapp.com.br/?$args; }\n\
    location = /connecttest.txt { return 302 https://drogariaminasbrasilapp.com.br/?$args; }\n\
    location = /ncsi.txt { return 302 https://drogariaminasbrasilapp.com.br/?$args; }\n\

\n\
    # SPA fallback - preserva query params\n\
    location / {\n\
        try_files $uri /index.html?$args;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
