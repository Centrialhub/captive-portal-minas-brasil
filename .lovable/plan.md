

## Dockerfile do unifi-proxy - Correção

O Dockerfile que você mostrou tem dois problemas:

1. **Falta um `;`** após a URL do `proxy_pass` (erro de sintaxe do Nginx)
2. **Falta `\n\`** na mesma linha para o printf funcionar
3. **O proxy_pass deve usar HTTPS** pois o controller UniFi usa SSL (porta 8083)

### Dockerfile corrigido

```dockerfile
FROM nginx:alpine

RUN printf 'server {\n\
    listen 80;\n\
    location /health {\n\
        return 200 "ok";\n\
    }\n\
    location / {\n\
        proxy_pass https://rwificontroller.drogariaminasbrasil.com.br:8083/matriz/;\n\
        proxy_ssl_verify off;\n\
        proxy_ssl_server_name on;\n\
        proxy_set_header Host rwificontroller.drogariaminasbrasil.com.br;\n\
        proxy_set_header X-Real-IP $remote_addr;\n\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
        proxy_set_header X-Forwarded-Proto https;\n\
        proxy_connect_timeout 10s;\n\
        proxy_read_timeout 30s;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Upgrade $http_upgrade;\n\
        proxy_set_header Connection "upgrade";\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### Mudanças principais

| Item | Antes (com erro) | Corrigido |
|------|------------------|-----------|
| proxy_pass | `http://...8083/matriz/` (sem `;`, sem `\n\`) | `https://...8083/matriz/;\n\` |
| SSL | Não habilitado | `proxy_ssl_verify off` + `proxy_ssl_server_name on` |
| Host header | `guedesepaixao.com.br` | `rwificontroller.drogariaminasbrasil.com.br` |
| WebSocket | Ausente | Headers de Upgrade adicionados |

### URL da loja no banco de dados

A `unifi_controller_url` da Matriz deve apontar para o proxy, não direto para o controller:

```sql
UPDATE stores 
SET unifi_controller_url = 'https://wifi.guedesepaixao.com.br/unifi-proxy/' 
WHERE slug = 'matriz';
```

Assim a Edge Function faz login via `https://wifi.guedesepaixao.com.br/unifi-proxy/api/login` → o Nginx principal redireciona para `http://unifi-proxy:80/api/login` → o container unifi-proxy redireciona para `https://rwificontroller...8083/matriz/api/login`. O SSL é terminado pelo EasyPanel com certificado válido.

