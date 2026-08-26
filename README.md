# Captive Portal — Drogaria Minas Brasil

Portal React/Vite com autenticação Supabase e autorização de clientes em
controladoras UniFi. A origem pública canônica é
`https://minasbrasilwifi.com.br`; o frontend acessa a Edge Function somente
pelo proxy same-origin `/api/captive-portal`.

## Desenvolvimento e validação

Requisitos locais: Node 24 LTS, npm 10.9.4, Deno 2.9.5 e acesso à internet na
primeira instalação. No Docker, o Deno vem da imagem oficial
`denoland/deno:bin-2.9.5`, fixada por digest, e não executa scripts de instalação
do npm.

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
`20260824200345_captive_auth_invariants.sql` consolida:

- estados válidos da tentativa, incluindo `authorizing`;
- validação do hash do `resume_token`;
- ownership da lease, replay e recuperação;
- tentativas/sessões 1:1;
- execução segura de `has_role` nas policies RLS.

A migration `20260824200934_consolidate_read_policies.sql` combina as regras
de proprietário e administrador, evitando avaliações RLS duplicadas sem expor
sessões anônimas a usuários autenticados.

As migrations `20260824211705_admin_configuration_contract.sql` e
`20260824215556_admin_operations_and_user_controls.sql` completam o contrato
operacional do painel: configuração de duração, datas de aquisição dos leads,
bloqueio imediato de usuários, estados de supressão/anônimização para marketing
e índices para auditoria. `user_blocks` não possui acesso direto pelo browser;
somente a Edge Function com `service_role` administra esses registros após
revalidar o JWT e o papel `admin`.

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
- `SUPABASE_LEAKED_PASSWORD_PROTECTION_ENABLED=true`
- `UNIFI_CREDENTIALS_ROTATED=true`

O payload de concorrência deve ser JSON para
`/api/captive-portal/?route=%2Fauthorize-existing` e conter
`attempt_id`, `resume_token` e `access_token` de homologação. O gate envia
20 requisições idênticas e confirma no banco:

```text
1 captive_session
1 comando UniFi persistido
19 respostas processing ou replay
```

O gate também exige um checkout Git limpo e que `COMMIT_SHA` corresponda
exatamente ao `HEAD`. Depois ele constrói a imagem com o SHA informado, executa
`nginx -t` durante o build e testa `/health`, `/ready`, a SPA,
`/build-info.json` e os headers de segurança.

Antes de definir `SUPABASE_LEAKED_PASSWORD_PROTECTION_ENABLED=true`, habilite
Auth → Attack Protection → Leaked Password Protection no Dashboard e confirme
que o advisor de segurança deixou de emitir esse aviso.

A migration `20260824211347_production_release_contract.sql` publica um
marcador consultável somente pela `service_role`. O teste de concorrência
valida esse marcador antes de consumir a tentativa, comprovando que a cadeia
forward-only de migrations chegou à versão exigida.

## Verificação após o deploy

Depois de publicar a imagem aprovada, execute:

```bash
PRODUCTION_UNIFI_STORES=matriz npm run verify:unifi-proxy
EXPECTED_COMMIT_SHA=<sha-completo-exato> npm run verify:production
```

Antes de migrar todas as lojas, execute `npm run verify:unifi-proxy` sem limitar
`PRODUCTION_UNIFI_STORES`; isso valida as 12 rotas cadastradas. O comando de
produção reprova a publicação se o SHA servido não for o esperado, se
`/ready` ou `/build-info.json` caírem no fallback da SPA, se os headers de
segurança estiverem ausentes, se o bundle Google OAuth for antigo, se a Edge
Function/bootstrap falharem ou se o TLS/health do proxy UniFi não estiver
válido. Uma release só está aprovada
quando `release:gate` e `verify:production` passam nessa ordem.

## Proxy UniFi

O container separado para a VPS está em `unifi-proxy/Dockerfile`. Ele preserva
o conjunto completo de cookies, usa master Nginx padrão com workers sem
privilégios e carrega as rotas por
um arquivo somente leitura mantido pela aplicação externa. As instruções de
build, execução e integração TLS estão em `unifi-proxy/README.md`.

## Configuração externa obrigatória

Cadastre exatamente `https://minasbrasilwifi.com.br/oauth/callback` em
Supabase Authentication → URL Configuration → Redirect URLs. Credenciais
UniFi, service role, CRM e cron pertencem apenas aos secrets do runtime da Edge
Function; nunca ao frontend ou à imagem final.

No ingress HTTPS do portal, preserve os headers emitidos pelo container e não
reescreva `/ready` nem `/build-info.json` para `index.html`. O ingress UniFi
deve usar o virtual host e o certificado do hostname exato, conforme
`unifi-proxy/ingress/nginx.conf.example`.

Os endpoints persistidos devem seguir
`https://unifiproxy.minasbrasilwifi.com.br/<slug-da-loja>`. Esse hostname
termina TLS no EasyPanel da VPS do portal e encaminha, pelo container
`unifi-proxy`, para o gateway legado fixo `http://177.85.235.28:8083`.
As migrations `20260825170953_route_unifi_through_local_proxy.sql` e
`20260825200944_route_all_unifi_stores_through_tls_proxy.sql` fazem a transição
em duas etapas; URLs armazenadas continuam obrigadas a usar HTTPS. Consulte
`DEPLOY.md` para a ordem segura da publicação.

O histórico recebido continha uma credencial UniFi em texto puro numa migration
antiga. O literal foi removido do repositório, mas a senha correspondente deve
ser considerada comprometida e rotacionada na controladora e nos secrets do
ambiente antes da publicação.
