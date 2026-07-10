## Objetivo

1. Impedir cadastros duplicados por **e-mail** e **CPF** (telefone pode repetir).
2. Adicionar fluxo de **resgate de senha por e-mail** (link Supabase padrão).

---

## 1) Duplicidade de conta

### Banco (migration)

- `profiles.cpf_digits`: adicionar **UNIQUE INDEX** (`profiles_cpf_digits_key`) sobre 11 dígitos normalizados. Antes do índice, rodar `SELECT` de checagem — se já houver duplicatas atuais, migration mantém o índice como `UNIQUE INDEX CONCURRENTLY` falha em migration; usarei `CREATE UNIQUE INDEX` simples e, caso exista duplicata, o passo falha e a gente resolve manual (o admin decide qual conta manter).
- E-mail: já é único em `auth.users` (Supabase garante), não precisa mexer.
- Telefone: **sem constraint**. Mantém `phone_digits` livre.

### Edge function `/signup`

Antes de criar o auth user:
1. `select id from profiles where cpf_digits = $1 limit 1` → se existir, retorna `409 { error_code: "cpf_already_registered" }`.
2. Chamar `supabase.auth.admin.createUser` — se falhar com `email_exists`/`user_already_exists`, mapear para `409 { error_code: "email_already_registered" }`.
3. Se o INSERT em `profiles` violar `profiles_cpf_digits_key` (race), tratar unique_violation → apagar o auth user recém-criado (`admin.deleteUser`) e retornar `cpf_already_registered`. Evita conta órfã.

Log em `portal_events`:
- `signup_failed` com `error_code = email_already_registered | cpf_already_registered`.

### Frontend (`src/App.tsx`)

Mapear mensagens no step `signup`:
- `email_already_registered` → "Este e-mail já possui conta. Faça login ou recupere a senha."
- `cpf_already_registered` → "Este CPF já possui conta. Entre com o e-mail cadastrado ou recupere a senha."
- Sem CTA automático (conforme sua escolha) — usuário navega manualmente para "Entrar".

### `src/lib/api.ts`

Sem mudanças estruturais; só passar o novo `error_code` adiante (já é genérico).

---

## 2) Resgate de senha (link mágico por e-mail)

### Fluxo do usuário

```text
Login  ── [Esqueci a senha] ──▶  Forgot password
                                     │
                                     ▼
                         Digita e-mail → chama /request-password-reset
                                     │
                                     ▼
                        "Enviamos um link para seu e-mail"
                                     │
    ┌────────────────────────────────┴───────────────────────────────┐
    ▼                                                                ▼
Usuário abre e-mail no celular         Se ainda sem Wi-Fi, abre em outra rede
    │                                                                │
    └──── link abre  ${SITE_URL}/reset-password#access_token=...  ───┘
                                     │
                                     ▼
                        Nova senha + confirmar → updateUser({password})
                                     │
                                     ▼
                     Login automático → success (autoriza UniFi)
```

### Backend

**Nova rota `POST /request-password-reset`** em `captive-portal/index.ts`:
- Body: `{ email }`. Valida formato.
- Rate limit `rate_limit_hit`: 3 tentativas / 15 min por `ip:email`, bloqueio 30 min.
- Chama `supabase.auth.resetPasswordForEmail(email, { redirectTo: '${SITE_URL}/reset-password' })`.
- **Sempre retorna sucesso genérico** (`{ ok: true }`) mesmo se e-mail não existir — evita enumeração de contas.
- Log `password_reset_requested` em `portal_events`.

`SITE_URL` = `POST_AUTH_REDIRECT_URL` (secret já existe) sem query, ou hardcoded `https://wifi.guedesepaixao.com.br`. Vou usar `POST_AUTH_REDIRECT_URL` como base.

### Frontend

**Novos steps** em `src/App.tsx`:
- `"forgot"` — form com um campo (e-mail) + botão "Enviar link" + link "Voltar".
- `"forgot_sent"` — tela de confirmação com instruções: "Abra o e-mail em qualquer rede e clique no link. Após redefinir a senha, você poderá continuar no Wi-Fi."
- No step `login`: adicionar link "Esqueci a senha" abaixo do botão Entrar.

**Nova página `/reset-password`** (`src/pages/ResetPassword.tsx`):
- Rota adicionada no `main.tsx` (ou via detecção de path no `App.tsx`, já que o portal não usa router). Vou detectar `window.location.pathname === '/reset-password'` no boot e renderizar componente separado antes do fluxo captive.
- Ao montar, Supabase JS detecta o `type=recovery` no hash e emite `PASSWORD_RECOVERY` via `onAuthStateChange`. Uso esse evento para habilitar o form.
- Form: nova senha + confirmar (validação ≥8, letra+número, iguais).
- `supabase.auth.updateUser({ password })` → sucesso → mensagem "Senha alterada. Volte ao portal Wi-Fi e faça login."
- Não tenta autorizar UniFi aqui (usuário provavelmente está em rede externa quando abre o link do e-mail).

### `src/lib/api.ts`

Novo método:
```ts
requestPasswordReset(data: { email: string })
```

### Walled Garden UniFi

O link do e-mail precisa abrir com o dispositivo ainda **sem Wi-Fi liberado**. Provedores comuns:
- gmail.com, googleusercontent.com (imagens Gmail)
- outlook.com, live.com, hotmail.com, office.com
- yahoo.com, yahoo.net
- icloud.com, apple.com

**Decisão pragmática**: não vou adicionar todos os provedores ao walled garden — inflaria a lista e cada provedor tem CDNs próprios. A tela `forgot_sent` orienta o usuário a abrir o e-mail **em outra rede (4G/outra Wi-Fi)** ou fora do portal. O reset em si só precisa do domínio do próprio site (`wifi.guedesepaixao.com.br`) — que já é o captive host e é acessível via redirect do UniFi.

Vou apenas garantir que o Supabase Auth (`fqamejlyytrhovawgtwg.supabase.co`) já está no walled garden — está (é o que o portal usa).

### Configuração Supabase (você faz manualmente)

1. **Authentication → URL Configuration → Site URL**: `https://wifi.guedesepaixao.com.br`
2. **Authentication → URL Configuration → Redirect URLs**: adicionar `https://wifi.guedesepaixao.com.br/reset-password`
3. **Authentication → Email Templates → Reset Password**: opcional, personalizar texto em pt-BR (posso deixar template default).

Não vou usar `scaffold_auth_email_templates` (evita configurar domínio de e-mail Lovable) — o template padrão do Supabase funciona.

---

## 3) Observabilidade

Novos `event_type` em `portal_events`:
- `signup_failed` com `error_code = cpf_already_registered | email_already_registered` (o admin já mostra failures agregados; só precisa aparecer no filtro).
- `password_reset_requested` (payload: `{ email_masked }` — só domínio + primeiros 2 chars).
- `password_reset_completed` (registrado quando `/reset-password` chama `updateUser` com sucesso — via `api.clientEvent`).

No `AdminDashboard`, adicionar linha no bloco "Contas & Autenticação":
- **Resgates de senha**: `requested` / `completed` na janela selecionada.

---

## 4) Arquivos afetados

- `supabase/migrations/<novo>.sql` — UNIQUE index em `profiles.cpf_digits`.
- `supabase/functions/captive-portal/index.ts` — rota `/request-password-reset`, checagem de CPF duplicado no `/signup`, cleanup em race.
- `src/lib/api.ts` — `requestPasswordReset()`.
- `src/App.tsx` — steps `forgot` / `forgot_sent`, link "Esqueci a senha" no login, roteamento para `/reset-password`, mapeamento de erros de duplicidade.
- `src/pages/ResetPassword.tsx` — nova página.
- `src/main.tsx` — montagem condicional de `/reset-password` (sem react-router; check de `pathname`).
- `src/pages/AdminDashboard.tsx` — métricas de resgate.

---

## 5) Riscos

- **CPF duplicado existente**: se já houver duplicatas em produção, a migration falha. Rodo `SELECT cpf_digits, count(*) FROM profiles GROUP BY 1 HAVING count(*) > 1` antes; se retornar linhas, alerto você para consolidar manualmente antes de aprovar a migration.
- **E-mail em provedor não-liberado**: usuário precisa abrir link em outra rede. Aceitável (fluxo raro).
- **Enumeração de contas**: mitigado por resposta genérica no `/request-password-reset`.
- **Reset abre no navegador do sistema (não CNA)**: melhor UX — o CNA fecha ao autorizar; se abrir no CNA, o próprio Supabase JS resolve o hash antes.

---

## 6) O que você faz antes do go-live

1. Confirmar Site URL + Redirect URL no Supabase Dashboard (passo acima).
2. (Opcional) Personalizar template de "Reset Password" em pt-BR.
