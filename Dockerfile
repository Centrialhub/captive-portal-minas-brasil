# Build arguments (required for frontend compilation)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG GIT_SHA
ARG COMMIT_SHA

# Official Deno binary, isolated from npm install scripts and pinned immutably.
FROM denoland/deno:bin-2.9.5@sha256:0d1262facd139e815217c001945eb822c7a78584cf660142c34a6b53effec1aa AS deno

# Stage 1: Build frontend
FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /app

# Backward compatibility for repository revisions whose asset validator still
# calls `file --mime-type`. The current validator is self-contained, but this
# keeps partially uploaded GitHub commits deployable as well.
RUN apt-get update \
    && apt-get install -y --no-install-recommends file \
    && rm -rf /var/lib/apt/lists/*

# The official bin image is the supported way to add Deno to another base.
COPY --from=deno /deno /usr/local/bin/deno
RUN deno --version

# Re-declare ARGs to make them available to Vite/Node
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG GIT_SHA
ARG COMMIT_SHA

# Fail before build if required variables are missing or invalid
RUN resolved_sha="${COMMIT_SHA:-$GIT_SHA}"; \
    if [ -z "$VITE_SUPABASE_URL" ] || [ -z "$VITE_SUPABASE_PUBLISHABLE_KEY" ] || [ -z "$resolved_sha" ] || [ "$resolved_sha" = "unknown" ]; then \
      echo "ERROR: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY and COMMIT_SHA or GIT_SHA (non-placeholder) are required" && exit 1; \
    fi; \
    if ! echo "$resolved_sha" | grep -Eq '^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'; then \
      echo "ERROR: COMMIT_SHA or GIT_SHA must be a full 40- or 64-character hexadecimal revision" && exit 1; \
    fi
RUN if [ "$VITE_SUPABASE_URL" != "https://fqamejlyytrhovawgtwg.supabase.co" ]; then \
      echo "ERROR: VITE_SUPABASE_URL must match the Supabase project configured in the proxy and CSP" && exit 1; \
    fi; \
    if ! echo "$VITE_SUPABASE_PUBLISHABLE_KEY" | grep -q '^sb_publishable_'; then \
      echo "ERROR: VITE_SUPABASE_PUBLISHABLE_KEY must be a Supabase sb_publishable_ key; never use a secret or service-role key" && exit 1; \
    fi; \
    if echo "$VITE_SUPABASE_PUBLISHABLE_KEY" | grep -Eqi 'replace|your|<|>'; then \
      echo "ERROR: VITE_SUPABASE_PUBLISHABLE_KEY is still a placeholder" && exit 1; \
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

# EasyPanel always injects GIT_SHA; the manual release gate now does too.
ARG GIT_SHA
ARG COMMIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
LABEL io.easypanel.git-sha=$GIT_SHA
LABEL org.opencontainers.image.source="https://github.com/Centrialhub/captive-portal-minas-brasil"

COPY --from=build /app/dist /usr/share/nginx/html

# Nginx config with Health/Readiness endpoints. Keep cache headers at server
# scope so static locations inherit every browser security header as well.
RUN printf 'map "$status:$uri:$http_range" $portal_cache_control {\n\
    default "";\n\
    "~^(200|304):/assets/[^/]+-[A-Za-z0-9_-]{8,}\\.[^/:]+:$" "public, max-age=31536000, immutable";\n\
    "~^[0-9]+:/assets/" "no-store";\n\
    "~^(200|304):/index\\.html:" "no-cache, max-age=0, must-revalidate";\n\
    "~^[0-9]+:/index\\.html:" "no-store";\n\
}\n\
\n\
server {\n\
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
    add_header Content-Security-Policy "default-src '\''self'\''; base-uri '\''self'\''; connect-src '\''self'\'' https://fqamejlyytrhovawgtwg.supabase.co; font-src '\''self'\'' data:; form-action '\''self'\''; frame-ancestors '\''none'\''; img-src '\''self'\'' data:; object-src '\''none'\''; script-src '\''self'\'' __PORTAL_BOOT_CSP__; style-src '\''self'\'' '\''unsafe-inline'\''; upgrade-insecure-requests" always;\n\
    add_header X-Content-Type-Options "nosniff" always;\n\
    add_header X-Frame-Options "DENY" always;\n\
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n\
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;\n\
    add_header Cache-Control $portal_cache_control always;\n\
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
        if (!-f $document_root/portal-boot.sha256) { return 503 "missing-portal-boot-hash"; }\n\
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
    # A stale HTML document must receive a real missing-asset response.\n\
    # Never serve the SPA document as JavaScript or cache a missing bundle.\n\
    location ^~ /assets/ {\n\
        try_files $uri =404;\n\
    }\n\
\n\
    # HTML, including the embedded early boot, revalidates on every navigation.\n\
    location = /index.html {\n\
        try_files $uri =404;\n\
    }\n\
    # SPA fallback (internal redirect applies the index.html cache policy).\n\
    location / {\n\
        try_files $uri /index.html?$args;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

# Authorize only the exact early boot script embedded by the frontend build.
# Validate the digest before interpolating it into the configuration.
RUN boot_csp_hash="$(cat /usr/share/nginx/html/portal-boot.sha256)"; \
    if [ "${#boot_csp_hash}" -ne 44 ] || ! printf '%s' "$boot_csp_hash" | grep -Eq '^[A-Za-z0-9+/]{43}=$'; then \
      echo "ERROR: missing or invalid early boot CSP hash" && exit 1; \
    fi; \
    sed -i "s|__PORTAL_BOOT_CSP__|'sha256-${boot_csp_hash}'|g" /etc/nginx/conf.d/default.conf

# Validate Nginx config
RUN nginx -t

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost/ready || exit 1

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
