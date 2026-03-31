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
\n\
    # Proxy para Edge Functions do Supabase\n\
    location /api/captive-portal/ {\n\
        proxy_pass https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal/;\n\
        proxy_set_header Host fqamejlyytrhovawgtwg.supabase.co;\n\
        proxy_ssl_server_name on;\n\
        proxy_ssl_protocols TLSv1.2 TLSv1.3;\n\
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
    # Quando o UniFi redireciona para https://31.97.170.23/guest/s/default/?ap=...&id=...\n\
    # este bloco faz 302 para https://wifi.guedesepaixao.com.br com todos os params\n\
    location /guest/s/default/ {\n\
        return 302 https://wifi.guedesepaixao.com.br/?store=matriz&$args;\n\
    }\n\
\n\
    # SPA fallback - preserva query params\n\
    location / {\n\
        try_files $uri /index.html?$args;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
