

# Plano: Atualizar Dockerfile para Nginx com proxy integrado

## Problema

O Dockerfile atual usa `vite preview` (servidor estático simples) na porta 3000. Ele **não tem capacidade de**:
1. Fazer proxy de `/api/captive-portal/` para o Supabase Edge Function
2. Fazer proxy de `/unifi-proxy/` para o container `unifi-proxy` (que acessa o UniFi Controller)
3. Preservar query params (`?id=MAC`) do UniFi com `try_files ... ?$args`

Como o EasyPanel puxa direto do GitHub e usa o Dockerfile do repo, a solução é **substituir o Dockerfile** por um multi-stage build que gera os arquivos estáticos e serve com Nginx, incluindo todas as rotas de proxy necessárias.

## O que será feito

### 1. Novo Dockerfile (substitui o atual)

Multi-stage build:
- **Stage 1**: Node 20 — `npm install` + `npm run build` (gera `/app/dist`)
- **Stage 2**: Nginx Alpine — serve os arquivos estáticos com config customizada

Nginx config embutida no Dockerfile com 3 locations:

```text
/ → try_files $uri /index.html?$args  (preserva ?id=MAC do UniFi)

/api/captive-portal/ → proxy_pass https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal/
  (com proxy_ssl_server_name on e Host header correto)

/unifi-proxy/ → proxy_pass http://unifi-proxy:80/
  (trailing slash remove o prefixo, acessa o container irmão no EasyPanel)
```

Escuta na **porta 3000** (para manter compatibilidade com os domínios já configurados no EasyPanel que apontam para porta 3000).

### 2. Nenhuma mudança no código fonte

O `portal-utils.ts` já usa `/api/captive-portal` quando o host é `wifi.guedesepaixao.com.br` — perfeito, vai bater com o proxy do Nginx.

### Após deploy no EasyPanel

O fluxo completo ficará:

```text
wifi.guedesepaixao.com.br (EasyPanel Traefik → porta 3000)
  │
  ▼
wifi-minasbrasil (Nginx:3000)
  ├── /                         → index.html?$args (portal + MAC preservado)
  ├── /api/captive-portal/*     → Supabase Edge Function
  └── /unifi-proxy/*            → unifi-proxy:80/* → guedesepaixao.com.br:8443
```

