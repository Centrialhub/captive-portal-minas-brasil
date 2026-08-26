# syntax=docker/dockerfile:1.7

# Production UniFi reverse proxy. The matriz route is baked into the image so
# the Edge Function always reaches the fixed controller gateway through this
# TLS-terminated bridge. A read-only routes.conf mount may still override it.
FROM nginx:1.30.4-alpine@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46

LABEL org.opencontainers.image.title="Minas Brasil UniFi proxy" \
      org.opencontainers.image.description="Cookie-preserving TLS bridge for the fixed UniFi controller gateway"

RUN <<'EOF'
set -eu
rm -f /etc/nginx/conf.d/default.conf
mkdir -p /etc/nginx/routes
mkdir -p \
    /var/cache/nginx/client_temp \
    /var/cache/nginx/proxy_temp \
    /var/cache/nginx/fastcgi_temp \
    /var/cache/nginx/uwsgi_temp \
    /var/cache/nginx/scgi_temp

cat > /etc/nginx/nginx.conf <<'NGINX'
user nginx;
worker_processes auto;
pid /var/run/nginx.pid;
error_log /dev/stderr warn;

events {
    # O EasyPanel fornece RLIMIT_NOFILE=1024 neste serviço.
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Captive requests can contain MACs and return URLs in the query string.
    # Log the normalized URI only, never query strings or Cookie headers.
    log_format privacy '$remote_addr - $request_method $uri $status '
                       '$body_bytes_sent "$http_referer" "$http_user_agent"';
    access_log /dev/stdout privacy;

    server_tokens off;
    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65s;
    client_max_body_size 1m;

    client_body_temp_path /var/cache/nginx/client_temp;
    proxy_temp_path /var/cache/nginx/proxy_temp;
    fastcgi_temp_path /var/cache/nginx/fastcgi_temp;
    uwsgi_temp_path /var/cache/nginx/uwsgi_temp;
    scgi_temp_path /var/cache/nginx/scgi_temp;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }

    map $http_x_forwarded_proto $forwarded_proto {
        default $http_x_forwarded_proto;
        '' $scheme;
    }

    server {
        listen 80;
        server_name _;

        location = /healthz {
            access_log off;
            default_type application/json;
            return 200 '{"ok":true,"service":"unifi-proxy"}';
        }

        # Defaults inherited by every managed route. The complete incoming
        # cookie jar contains the routing cookie plus the UniFi session/CSRF
        # cookies. UniFi Set-Cookie responses pass through unchanged.
        proxy_http_version 1.1;
        proxy_pass_request_headers on;
        proxy_set_header Host $proxy_host;
        proxy_set_header Cookie $http_cookie;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $forwarded_proto;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_pass_header Set-Cookie;
        proxy_ssl_server_name on;
        proxy_connect_timeout 10s;
        proxy_send_timeout 90s;
        proxy_read_timeout 90s;
        proxy_buffering off;

        # The image ships a validated matriz route. A read-only mount can
        # replace this file when another controller route is required.
        include /etc/nginx/routes/routes.conf;

        location / {
            return 404;
        }
    }
}
NGINX

cat > /etc/nginx/routes/routes.conf <<'ROUTES'
# Fixed controller gateway. Only the explicitly managed store prefixes are
# exposed. proxy_pass has no URI component so Nginx preserves the complete
# /<store>/api/... path and query string sent by the Edge Function.
location ~ ^/(cintra|cula|dpedro|drive|hu|ibituruna|joao23|major|matriz|mestra|povao|shopping)(?:/|$) {
    proxy_pass http://177.85.235.28:8083;
}
ROUTES

cat > /usr/local/bin/start-unifi-proxy <<'SH'
#!/bin/sh
set -eu

routes=/etc/nginx/routes/routes.conf

if [ ! -r "$routes" ]; then
    echo "ERROR: managed route file is not readable: $routes" >&2
    exit 78
fi
if ! grep -Eq '^[[:space:]]*location([[:space:]=~^]|$)' "$routes"; then
    echo "ERROR: managed route file has no location blocks" >&2
    exit 78
fi
if ! grep -Eq '^[[:space:]]*proxy_pass[[:space:]]+' "$routes"; then
    echo "ERROR: managed route file has no proxy_pass targets" >&2
    exit 78
fi
if grep -Eq 'proxy_hide_header[[:space:]]+Set-Cookie' "$routes"; then
    echo "ERROR: managed routes must not hide UniFi Set-Cookie headers" >&2
    exit 78
fi

nginx -t
exec nginx -g 'daemon off;'
SH

chmod 0755 /usr/local/bin/start-unifi-proxy
chown -R nginx:nginx /etc/nginx/routes /var/cache/nginx
nginx -t
EOF

EXPOSE 80
STOPSIGNAL SIGQUIT

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:80/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/start-unifi-proxy"]
