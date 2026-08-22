# Build arguments for Supabase (required for frontend compilation)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG COMMIT_SHA=unknown

# Stage 1: Build frontend
FROM node:24-alpine@sha256:79a5446059b5edc74a0c8b6d859e9b25a2df6b5c0c9394628d08c8e1e75685a4 AS build
WORKDIR /app

# Re-declare ARGs in the build stage to make them available as environment variables
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

COPY package*.json ./
# Use npm ci for deterministic builds based on lockfile
RUN npm ci
COPY . .

# Run validation checks before building
RUN npm run lint && npm run typecheck

RUN npm run build

# Stage 2: Production server (Nginx)
FROM nginx:1.27-alpine@sha256:4ff37a47b85e0513e4b3c0628e378c3a10526017a54a014283c847ec0537fd97

LABEL org.opencontainers.image.revision=$COMMIT_SHA
LABEL org.opencontainers.image.source="https://github.com/drogariaminasbrasil/captive-portal"

COPY --from=build /app/dist /usr/share/nginx/html

RUN printf 'server {\n\
    listen 80;\n\
    server_name minasbrasilwifi.com.br 187.77.48.59;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    absolute_redirect off;\n\
    port_in_redirect off;\n\
\n\
    # Health check for EasyPanel / Orchestrators\n\
    location = /health {\n\
        access_log off;\n\
        default_type text/plain;\n\
        return 200 "ok";\n\
    }\n\
\n\
    # Proxy for Supabase Edge Functions\n\
    location /api/captive-portal/ {\n\
        proxy_pass https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal/;\n\
        proxy_set_header Host fqamejlyytrhovawgtwg.supabase.co;\n\
        proxy_set_header X-Real-IP $remote_addr;\n\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
        proxy_set_header X-Forwarded-Proto $scheme;\n\
        proxy_ssl_server_name on;\n\
        proxy_ssl_protocols TLSv1.2 TLSv1.3;\n\
        proxy_http_version 1.1;\n\
        proxy_connect_timeout 30s;\n\
        proxy_send_timeout 60s;\n\
        proxy_read_timeout 60s;\n\
        proxy_buffering off;\n\
        client_max_body_size 1m;\n\
        add_header Access-Control-Allow-Origin "*" always;\n\
        add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;\n\
        add_header Access-Control-Allow-Headers "authorization, x-client-info, apikey, content-type" always;\n\
        if ($request_method = OPTIONS) { return 204; }\n\
    }\n\
\n\
    # UniFi redirect alias\n\
    location /guest/s/default/ {\n\
        return 302 https://minasbrasilwifi.com.br/?store=matriz&$args;\n\
    }\n\
\n\
    # CNA Probes (redirect to portal to force interaction)\n\
    location = /generate_204 { return 302 https://minasbrasilwifi.com.br/; }\n\
    location = /gen_204 { return 302 https://minasbrasilwifi.com.br/; }\n\
    location = /hotspot-detect.html { return 302 https://minasbrasilwifi.com.br/; }\n\
    location = /library/test/success.html { return 302 https://minasbrasilwifi.com.br/; }\n\
    location = /connecttest.txt { return 302 https://minasbrasilwifi.com.br/; }\n\
    location = /ncsi.txt { return 302 https://minasbrasilwifi.com.br/; }\n\
\n\
    # SPA fallback\n\
    location / {\n\
        try_files $uri /index.html?$args;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

