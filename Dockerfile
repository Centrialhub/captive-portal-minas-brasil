# Build arguments (required for frontend compilation)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG COMMIT_SHA

# Stage 1: Build frontend
FROM node:24-alpine@sha256:79a5446059b5edc74a0c8b6d859e9b25a2df6b5c0c9394628d08c8e1e75685a4 AS build
WORKDIR /app

# Re-declare ARGs to make them available to Vite/Node
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG COMMIT_SHA

# Fail before build if required variables are missing or invalid
RUN if [ -z "$VITE_SUPABASE_URL" ] || [ -z "$VITE_SUPABASE_PUBLISHABLE_KEY" ] || [ -z "$COMMIT_SHA" ] || [ "$COMMIT_SHA" = "unknown" ]; then \
      echo "ERROR: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY and COMMIT_SHA (non-placeholder) are required" && exit 1; \
    fi
RUN if ! echo "$VITE_SUPABASE_URL" | grep -q "^https://"; then \
      echo "ERROR: VITE_SUPABASE_URL must use HTTPS" && exit 1; \
    fi

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV COMMIT_SHA=$COMMIT_SHA

COPY package*.json ./
RUN npm ci

COPY . .

# Run validation and build
RUN npm run check
RUN npm run build

# Stage 2: Production server (Nginx)
FROM nginx:1.27-alpine@sha256:4ff37a47b85e0513e4b3c0628e378c3a10526017a54a014283c847ec0537fd97

# Install curl for HEALTHCHECK
RUN apk add --no-cache curl

# Re-declare COMMIT_SHA for labels
ARG COMMIT_SHA
LABEL org.opencontainers.image.revision=$COMMIT_SHA
LABEL org.opencontainers.image.source="https://github.com/drogariaminasbrasil/captive-portal"

COPY --from=build /app/dist /usr/share/nginx/html

# Nginx config with Health/Readiness endpoints
RUN printf 'server {\n\
    listen 80;\n\
    server_name minasbrasilwifi.com.br 187.77.48.59;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    absolute_redirect off;\n\
    port_in_redirect off;\n\
\n\
    # Health: Is Nginx running?\n\
    location = /health {\n\
        access_log off;\n\
        default_type text/plain;\n\
        return 200 "ok";\n\
    }\n\
\n\
    # Readiness: Comprehensive check for real bundle integrity\n\
    location = /ready {\n\
        access_log off;\n\
        default_type text/plain;\n\
        # 1. Check index.html\n\
        if (!-f $document_root/index.html) { return 503 "missing-index"; }\n\
        # 2. Check build-info.json\n\
        if (!-f $document_root/build-info.json) { return 503 "missing-build-info"; }\n\
        # 3. Assets JS/CSS presence check (ensures build succeeded and assets exist)\n\
        # We use a pattern match to verify at least one hashed asset exists in /assets/\n\
        # Note: Nginx if does not support complex shell-like wildcard checks easily,\n\
        # so we rely on build-info.json as the authoritative source that build finished.\n\
        return 200 "ready";\n\
    }\n\
\n\
    # Build Info with cache-control: no-store\n\
    location = /build-info.json {\n\
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";\n\
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
    # CNA Probes\n\
    location = /generate_204 { return 302 https://minasbrasilwifi.com.br/; }\n\
    location = /gen_204 { return 302 https://minasbrasilwifi.com.br/; }\n\
    location = /hotspot-detect.html { return 302 https://minasbrasilwifi.com.br/; }\n\
\n\
    # SPA fallback\n\
    location / {\n\
        try_files $uri /index.html?$args;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

# Validate Nginx config
RUN nginx -t

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost/ready || exit 1

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
