# Captive Portal — Drogaria Minas Brasil

Portal React/Vite com autenticação Supabase e autorização de clientes em
controladoras UniFi. A origem pública canônica é
`https://minasbrasilwifi.com.br`; o frontend acessa a Edge Function somente
pelo proxy same-origin `/api/captive-portal`.

## Desenvolvimento e validação

Requisitos: Node 24 LTS, npm 10.9.4 e acesso à internet na primeira instalação.

```bash
npm ci
npm run check
```

`npm run check` valida assets, contratos de migrations, ausência de tokens
OAuth em URLs, lint, TypeScript, `deno check` da Edge Function, testes e build
de produção. O único lockfile aceito é `package-lock.json`.

## Banco

As migrations são forward-only. Antes de publicar, aplique a migration mais
recente em homologação e execute o teste de concorrência com um usuário, MAC e
tentativa exclusivos do ambiente de teste. A migration
`20260824170000_captive_auth_invariants.sql` consolida:

- estados válidos da tentativa, incluindo `authorizing`;
- validação do hash do `resume_token`;
- ownership da lease, replay e recuperação;
- tentativas/sessões 1:1;
- execução segura de `has_role` nas policies RLS.

## Gate de release

`npm run release:gate` é propositalmente fail-closed. Ele exige Docker e as
variáveis abaixo:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `COMMIT_SHA`
- `CONCURRENCY_TEST_URL`
- `CONCURRENCY_TEST_PAYLOAD`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

O payload de concorrência deve ser JSON para
`/api/captive-portal/?route=%2Fauthorize-existing` e conter
`attempt_id`, `resume_token` e `access_token` de homologação. O gate envia
20 requisições idênticas e confirma no banco:

```text
1 captive_session
1 comando UniFi persistido
19 respostas processing ou replay
```

Depois ele constrói a imagem com o SHA informado, executa `nginx -t` durante
o build e testa `/health`, `/ready`, a SPA e `/build-info.json`.

## Configuração externa obrigatória

Cadastre exatamente `https://minasbrasilwifi.com.br/oauth/callback` em
Supabase Authentication → URL Configuration → Redirect URLs. Credenciais
UniFi, service role, CRM e cron pertencem apenas aos secrets do runtime da Edge
Function; nunca ao frontend ou à imagem final.

O histórico recebido continha uma credencial UniFi em texto puro numa migration
antiga. O literal foi removido do repositório, mas a senha correspondente deve
ser considerada comprometida e rotacionada na controladora e nos secrets do
ambiente antes da publicação.
