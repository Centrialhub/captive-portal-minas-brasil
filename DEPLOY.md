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

No EasyPanel, use o fluxo de repositório:

- **Source:** GitHub ou Git, apontando para o repositório e branch publicados.
- **Build:** Dockerfile.
- **Build Path:** `/` (raiz do repositório).
- **Dockerfile Path:** `Dockerfile`.
- **Porta interna:** `80`.

Não use **Dockerfile** como tipo de fonte inline: esse modo não possui os
arquivos do repositório e, portanto, não atende aos comandos `COPY` deste
projeto. Também não defina `GIT_SHA` manualmente nesse fluxo; o EasyPanel o
injeta automaticamente a partir do commit selecionado.

Preserve apenas estes valores públicos nas variáveis do serviço:

- `VITE_SUPABASE_URL=https://fqamejlyytrhovawgtwg.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY=<chave publicável atual>`

Antes de disparar o deploy, confirme no mesmo commit a presença de
`Dockerfile`, `package.json`, `package-lock.json`, `.dockerignore`, `src/`,
`public/`, `scripts/` e `supabase/`. Em especial, `scripts/check-assets.ts`
deve validar as assinaturas dos arquivos com `Buffer.subarray` e não deve
conter `execSync` nem `file --mime-type`.

O `Dockerfile` também aceita `COMMIT_SHA` para builds manuais e para o gate de
release local. O estágio de validação usa Node baseado em Debian/glibc, copia
o Deno 2.9.5 da imagem oficial fixada por digest e instala o pequeno utilitário
`file` como compatibilidade para commits que ainda contenham o validador antigo.
Nenhuma dependência precisa estar instalada no host do EasyPanel.

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
