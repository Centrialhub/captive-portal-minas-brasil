## Objetivo

Trocar o fluxo atual (formul\u00e1rio + OTP WhatsApp) por conta interna com e-mail e senha:

- **Cadastro:** nome, e-mail, CPF, telefone, senha
- **Login:** e-mail + senha
- **Login silencioso:** mesma conta funciona em **qualquer loja** que o usu\u00e1rio visitar, sem novo cadastro nem novo login, at\u00e9 que o localStorage do dispositivo seja limpo

Sem OTP, sem WhatsApp, sem Google.

---

## Como o login silencioso funciona entre lojas

A sess\u00e3o Supabase Auth vive em `localStorage` do navegador do cliente e vale para **o projeto Supabase inteiro**, n\u00e3o para uma loja espec\u00edfica. Ent\u00e3o:

1. Usu\u00e1rio se cadastra na loja Matriz \u2192 tokens salvos em `localStorage` do celular
2. Depois, mesmo celular abre o portal na Filial Centro \u2192 boot detecta sess\u00e3o Supabase v\u00e1lida no `localStorage`
3. Portal chama `POST /authorize-existing` com o `access_token` + par\u00e2metros UniFi da nova loja (`id`, `ap`, `ssid`, ...)
4. Edge function **detecta a loja atual** com a l\u00f3gica que j\u00e1 existe (`?store=` \u2192 IP NAT \u2192 fallback) e chama `unifiAuthorize` no controller da **loja atual**
5. Sem tela de login, sem digitar nada

O que amarra a portabilidade:
- Tokens s\u00e3o do projeto Supabase (\u00fanico), n\u00e3o da loja
- `authorize-existing` sempre roda `detectStoreFromRequest` no request atual, ent\u00e3o autoriza sempre no controller certo
- `captive_sessions` da nova visita fica com `store_id` da loja atual e `user_id` do usu\u00e1rio existente
- `leads.last_seen_store_id` atualiza a cada autoriza\u00e7\u00e3o para mostrar no admin a \u00faltima loja onde apareceu

O usu\u00e1rio s\u00f3 volta a ver a tela de login se:
- Trocar de dispositivo/navegador
- Limpar dados do site
- O refresh token expirar sem uso (padr\u00e3o Supabase: 30 dias sem atividade)

---

## Fluxo no portal

```text
Loading (checa supabase.auth.getSession)
   \u251c\u2500 sess\u00e3o v\u00e1lida  \u2192 POST /authorize-existing \u2192 Success
   \u2514\u2500 sem sess\u00e3o     \u2192 tela Login
                          \u251c\u2500 Login OK    \u2192 authorize \u2192 Success
                          \u2514\u2500 Criar conta \u2192 Signup    \u2192 authorize \u2192 Success
```

---

## Autentica\u00e7\u00e3o

Uso o Supabase Auth do pr\u00f3prio projeto (SDK j\u00e1 est\u00e1 no reposit\u00f3rio).

- `supabase.auth.signUp` no cadastro (via edge function com admin API + `email_confirm: true` pra pular verifica\u00e7\u00e3o de e-mail)
- `supabase.auth.signInWithPassword` no login
- Sess\u00e3o persistida em `localStorage` (j\u00e1 configurado em `src/integrations/supabase/client.ts`)

**Dashboard Supabase \u2192 Authentication \u2192 Providers \u2192 Email \u2192 desligar \u201cConfirm email\u201d.** Sem isso o usu\u00e1rio teria que abrir link no e-mail antes de conseguir Wi-Fi, o que quebra o captive. Voc\u00ea desliga manualmente uma vez.

Consequ\u00eancia: e-mails n\u00e3o s\u00e3o verificados. Aceit\u00e1vel porque objetivo \u00e9 lead + libera\u00e7\u00e3o de rede, n\u00e3o autentica\u00e7\u00e3o forte.

---

## Schema

Nova tabela `public.profiles` ligada a `auth.users`:

```text
profiles
  id            uuid PK  \u2192 references auth.users(id) on delete cascade
  full_name     text not null
  cpf_digits    text not null   -- 11 d\u00edgitos, valida\u00e7\u00e3o cliente + edge
  phone_digits  text not null   -- s\u00f3 d\u00edgitos, formato BR
  email         text not null   -- espelho de auth.users.email
  created_at, updated_at
```

- Grants: `SELECT/INSERT/UPDATE` para `authenticated`; `ALL` para `service_role`
- RLS: usu\u00e1rio l\u00ea/atualiza s\u00f3 o pr\u00f3prio (`auth.uid() = id`); insert pelo edge via service_role
- Sem unique em `cpf_digits` na entrega inicial (evita bloquear casos leg\u00edtimos; admin decide depois)
- Trigger reutiliza `public.update_updated_at_column()`

Ajustes em `captive_sessions`:
- `user_id uuid` (nullable), `auth_method text` (`password` | `otp_legacy`)
- Colunas de OTP continuam pra hist\u00f3rico

Ajustes em `leads`:
- `user_id uuid` para amarrar lead \u2192 conta
- `last_seen_store_id uuid` para refletir \u00faltima loja visitada
- Um lead \u00e9 upsert por `user_id` (n\u00e3o mais por MAC/CPF/telefone isolados)

RLS de `leads` continua igual (leitura admin, escrita via edge).

---

## Endpoints novos no edge function `captive-portal`

Todos com service role.

- `POST /signup`
  - Body: `{ name, email, cpf, phone, password, client_mac, ap_mac, ssid, redirect_url, captive_timestamp, consent_version }`
  - Valida: nome (>=2), e-mail v\u00e1lido, CPF (algoritmo completo), phone (>=10 d\u00edgitos), senha (>=8, letra + n\u00famero)
  - `supabase.auth.admin.createUser({ email, password, email_confirm: true })`
  - Insere `profiles`, cria/atualiza `captive_sessions` com `user_id` + loja detectada, dispara `unifiAuthorize`, upsert em `leads`
  - Retorna `{ session_id, authorized, redirect_url, access_token, refresh_token }`
  - Erros mapeados: `email_already_registered`, `weak_password`, `invalid_cpf`, `invalid_phone`

- `POST /login`
  - Body: `{ email, password, client_mac, ap_mac, ssid, redirect_url, captive_timestamp }`
  - Valida credenciais via SDK anon (n\u00e3o admin), respeita `rate_limit_hit`
  - Cria/atualiza `captive_sessions` com `user_id` + loja detectada, dispara `unifiAuthorize`, atualiza `leads.last_seen_store_id`
  - Retorna `{ session_id, authorized, redirect_url, access_token, refresh_token }`

- `POST /authorize-existing`
  - Usado no login silencioso quando o dispositivo j\u00e1 tem tokens Supabase v\u00e1lidos (\u00e9 esse endpoint que garante funcionamento entre lojas)
  - Body: `{ access_token, client_mac, ap_mac, ssid, redirect_url, captive_timestamp }`
  - Valida token via `supabase.auth.getUser(token)` (regra do projeto: `getUser`, n\u00e3o `getClaims`)
  - `detectStoreFromRequest` no request atual, dispara `unifiAuthorize` no controller dessa loja
  - Upsert `leads` (last_seen_at, last_seen_store_id), insere `captive_sessions` com `store_id` da loja atual + `user_id`
  - Retorna `{ authorized, redirect_url }`
  - Se o token expirou, retorna `{ needs_login: true }` e o front cai para tela de login

Rotas antigas (`/submit`, `/request-code`, `/verify-code`) ficam por 1\u20132 semanas como leg\u00e1cy.

---

## Rate limiting

Reuso `public.rate_limit_hit`:
- Login: 5 tentativas / 5 min por `ip:email`, bloqueio 15 min
- Signup: 3 contas / hora por IP
- Authorize-existing: 20 / min por MAC (protege contra loop em CNAs)

---

## Frontend (`src/App.tsx`, `src/lib/api.ts`, `portal-utils.ts`)

Novos steps: `"loading" | "login" | "signup" | "authorizing" | "success" | "error"`.

1. **Boot**
   - `supabase.auth.getSession()`
   - Se sess\u00e3o expirou mas h\u00e1 refresh_token, tenta `refreshSession()` silenciosamente
   - Se v\u00e1lida \u2192 `POST /authorize-existing` \u2192 `success`
   - Se n\u00e3o \u2192 `login`
2. **Login**: e-mail, senha, bot\u00e3o "Entrar", link "Criar conta".
3. **Signup**: nome / e-mail / CPF (m\u00e1scara existente) / telefone (m\u00e1scara BR) / senha / confirmar senha / checkbox de consentimento.
4. **Success**: tela atual (bot\u00e3o \u201cContinuar\u201d que abre `redirect_url` sanitizado).

Persistir sess\u00e3o via `supabase.auth.setSession({ access_token, refresh_token })` no callback do `/signup` e `/login` para que a pr\u00f3xima visita (em qualquer loja) entre por login silencioso.

Remover: campos e telas de OTP (`otp` step, cooldown, resend, `verifyCodeBackup`, `submitLeadBackup`). Manter helpers reutiliz\u00e1veis (CPF, sanitizeCaptiveRedirect, traceId).

`src/lib/api.ts` ganha: `signup()`, `login()`, `authorizeExisting()`.

---

## Observabilidade (`portal_events`)

Novos `event_type`:
- `signup_started/success/failed` (`error_code`: email_exists / weak_password / invalid_cpf / invalid_phone)
- `login_started/success/failed` (`error_code`: invalid_credentials / rate_limited)
- `silent_login_success/failed` (`payload.store_slug` mostra em qual loja rolou)
- `unifi_authorize_from_auth_flow`

Admin dashboard continua funcionando; coluna \u201cOTP verified\u201d pode virar \u201cAuth method\u201d numa segunda entrega.

---

## LGPD

`consent_version` permanece `1.0`. Se voc\u00ea quiser eu adiciono uma linha ao texto sobre \u201carmazenamento de senha para acesso recorrente em qualquer unidade\u201d \u2014 confirma se \u00e9 pra incluir.

`audit_logs` continua sendo gerado em signup / login / authorize.

---

## Riscos e considera\u00e7\u00f5es

- **Senha esquecida**: n\u00e3o entra na primeira entrega. Op\u00e7\u00f5es depois: reset por e-mail (exige walled garden dos provedores de e-mail, complexo) ou fluxo \u201cN\u00e3o consigo entrar\u201d criando conta nova. Sugiro come\u00e7ar sem reset.
- **Refresh token expira em 30 dias sem uso**: usu\u00e1rio raro (visita > 30d) vai passar por login uma vez. Aceit\u00e1vel.
- **Trocou de celular / limpou dados**: passa por login. Aceit\u00e1vel.
- **CPF duplicado entre contas**: n\u00e3o bloqueado inicialmente; pode virar unique parcial depois.
- **Walled garden**: sem novidade. Todo fluxo j\u00e1 passa por `wifi.guedesepaixao.com.br` e Supabase (j\u00e1 whitelisted).

---

## O que voc\u00ea precisa fazer antes do go-live

1. Dashboard Supabase \u2192 Authentication \u2192 Providers \u2192 Email \u2192 desligar \u201cConfirm email\u201d
2. Confirmar se adiciono linha no consentimento sobre senha
3. Sem secrets novos, sem dom\u00ednios novos no walled garden
