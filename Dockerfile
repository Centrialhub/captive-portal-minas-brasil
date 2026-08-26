# Build arguments (required for frontend compilation)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG GIT_SHA
ARG COMMIT_SHA

# Stage 1: Build frontend
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app

# Re-declare ARGs to make them available to Vite/Node
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG GIT_SHA
ARG COMMIT_SHA

# Fail before build if required variables are missing or invalid
RUN resolved_sha="${COMMIT_SHA:-$GIT_SHA}"; \
    if [ -z "$VITE_SUPABASE_URL" ] || [ -z "$VITE_SUPABASE_PUBLISHABLE_KEY" ] || [ -z "$resolved_sha" ] || [ "$resolved_sha" = "unknown" ]; then \
      echo "ERROR: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY and COMMIT_SHA or GIT_SHA (non-placeholder) are required" && exit 1; \
    fi
RUN if ! echo "$VITE_SUPABASE_URL" | grep -q "^https://"; then \
      echo "ERROR: VITE_SUPABASE_URL must use HTTPS" && exit 1; \
    fi

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV COMMIT_SHA=$COMMIT_SHA
ENV GIT_SHA=$GIT_SHA
ENV DENO_DIR=/tmp/deno-cache

COPY package*.json ./
RUN npm ci

COPY . .

# Run validation and build
RUN npm run check

# Stage 2: Production server (Nginx)
FROM nginx:1.30.4-alpine@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46

# Install curl for HEALTHCHECK
RUN apk add --no-cache curl

# Re-declare COMMIT_SHA for labels
ARG GIT_SHA
ARG COMMIT_SHA
LABEL org.opencontainers.image.revision=$COMMIT_SHA
LABEL io.easypanel.git-sha=$GIT_SHA
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
    server_tokens off;\n\
\n\
    # Browser hardening. HSTS is ignored on local HTTP smoke tests and takes\n\
    # effect only when this response is delivered through the HTTPS ingress.\n\
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n\
    add_header Content-Security-Policy "default-src '\''self'\''; base-uri '\''self'\''; connect-src '\''self'\'' https://fqamejlyytrhovawgtwg.supabase.co; font-src '\''self'\'' data:; form-action '\''self'\''; frame-ancestors '\''none'\''; img-src '\''self'\'' data:; object-src '\''none'\''; script-src '\''self'\''; style-src '\''self'\'' '\''unsafe-inline'\''; upgrade-insecure-requests" always;\n\
    add_header X-Content-Type-Options "nosniff" always;\n\
    add_header X-Frame-Options "DENY" always;\n\
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n\
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;\n\
\n\
    # Health: Is Nginx running?\n\
    location = /health {\n\
        access_log off;\n\
        default_type text/plain;\n\
        return 200 "ok";\n\
    }\n\
\n\
    # Readiness: verify immutable build artifacts copied into this image.\n\
    location = /ready {\n\
        access_log off;\n\
        default_type text/plain;\n\
        if (!-f $document_root/index.html) { return 503 "missing-index"; }\n\
        if (!-f $document_root/build-info.json) { return 503 "missing-build-info"; }\n\
        return 200 "ready";\n\
    }\n\
\n\
    # Build Info with cache-control: no-store\n\
    location = /build-info.json {\n\
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";\n\
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n\
        add_header Content-Security-Policy "default-src '\''none'\''; frame-ancestors '\''none'\''" always;\n\
        add_header X-Content-Type-Options "nosniff" always;\n\
        add_header X-Frame-Options "DENY" always;\n\
        add_header Referrer-Policy "no-referrer" always;\n\
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;\n\
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
        if ($request_method = OPTIONS) { return 204; }\n\
    }\n\
\n\
    # Preserve UniFi parameters while moving legacy guest paths to the\n\
    # canonical HTTPS origin. TLS termination remains outside this container.\n\
    location ~ ^/guest/s/ {\n\
        return 302 https://minasbrasilwifi.com.br/$is_args$args;\n\
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
