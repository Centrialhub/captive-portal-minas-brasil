# Deploy de produção

Esta sequência é obrigatória para não apontar o banco para uma rota ainda não
publicada.

## 1. Proxy UniFi

No serviço `unifi-proxy` do EasyPanel, publique
`unifi-proxy/Dockerfile`. O domínio deve continuar assim:

- host: `unifiproxy.minasbrasilwifi.com.br`
- protocolo de destino: `HTTP`
- porta interna: `80`
- caminhos de origem e destino: `/`
- HTTPS/Let's Encrypt: habilitado
- sem usuário forçado no runtime
- sem volume antigo substituindo `/etc/nginx/routes/routes.conf`

Depois do deploy, execute:

```bash
npm run verify:unifi-proxy
```

Não prossiga se uma rota retornar `404`, timeout, não emitir
`Location: /manage` ou não emitir o cookie `unifi_controller=<loja>`.

## 2. Migration das lojas

Somente depois de todas as rotas passarem, aplique:

```text
supabase/migrations/20260825200944_route_all_unifi_stores_through_tls_proxy.sql
```

A migration da matriz já foi aplicada anteriormente. Esta migration é
idempotente e normaliza as 12 lojas ativas para
`https://unifiproxy.minasbrasilwifi.com.br/<slug>`.

## 3. Edge Function

`captive-portal` deve permanecer com `verify_jwt=false`, pois as rotas públicas
do captive chegam antes de existir uma sessão. A versão 230 já está publicada
com autenticação própria, cookies UniFi completos e secrets disponíveis.

## 4. Frontend

Publique o `Dockerfile` da raiz com estes build arguments, preservando os
valores configurados no EasyPanel:

- `VITE_SUPABASE_URL=https://fqamejlyytrhovawgtwg.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY=<chave publicável atual>`
- `COMMIT_SHA=<SHA completo da versão publicada>`

Destino do domínio `minasbrasilwifi.com.br`: protocolo `HTTP`, porta interna
`80`, caminho `/`, HTTPS/Let's Encrypt habilitado.

## 5. Verificação

```bash
EXPECTED_COMMIT_SHA=<mesmo SHA do build> npm run verify:production
```

O gate verifica identidade do build, headers, readiness, banco, secrets,
bootstrap, bundle Google OAuth, callback canônico e saúde do proxy. Só depois
de ambos os verificadores passarem deve começar o teste de campo.

O Google Cloud deve possuir exatamente este Authorized redirect URI:

```text
https://fqamejlyytrhovawgtwg.supabase.co/auth/v1/callback
```

O Supabase Authentication → URL Configuration deve possuir exatamente:

```text
https://minasbrasilwifi.com.br/oauth/callback
```
