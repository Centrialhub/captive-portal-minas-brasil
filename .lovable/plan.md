## Migração para HTTPS + Login Social (Google/Apple)

### 1. Novo domínio e HTTPS
- Domínio único do portal: `drogariaminasbrasilapp.com.br` (HTTPS).
- Atualizar Nginx (`Dockerfile`) — todos os redirects `/guest/s/default/`, `/generate_204`, `/gen_204`, `/hotspot-detect.html`, etc. passam a apontar para `https://drogariaminasbrasilapp.com.br/?$args`.
- Atualizar `vite.config.ts` `allowedHosts` com o novo domínio.
- Atualizar Walled Garden esperado (documentar): adicionar `drogariaminasbrasilapp.com.br`, `accounts.google.com`, `appleid.apple.com`, `*.googleusercontent.com`, `*.apple.com` (o usuário aplica no UniFi).
- Como controladoras agora têm certificado público, o redirect UniFi → portal continua funcionando sem CNA quebrar em HTTPS.

### 2. Autenticação Google + Apple (Supabase OAuth)
- Habilitar providers Google e Apple no Supabase Dashboard (o usuário configura client IDs/secrets no painel — não vai para código).
- Fluxo no portal:
  1. Tela inicial: botões **Continuar com Google**, **Continuar com Apple**, e link "Entrar com e-mail e senha" (fallback).
  2. `supabase.auth.signInWithOAuth({ provider, options: { redirectTo: 'https://drogariaminasbrasilapp.com.br/?<params captive preservados>' } })`.
  3. Ao voltar autenticado, portal detecta sessão, cria/atualiza `profiles` (sem CPF), chama `/authorize-existing` com o `access_token` — mesmo fluxo silencioso já existente.
- Preservar `id`, `ap`, `mac`, `ssid`, `url`, `t` do UniFi durante o round-trip OAuth (guardar em `sessionStorage` antes do redirect e restaurar no retorno).

### 3. Ajustes de dados (CPF opcional)
- Migração:
  - `ALTER TABLE profiles ALTER COLUMN cpf DROP NOT NULL` (se aplicável) e remover `UNIQUE INDEX` de `cpf_digits` (ou torná-lo parcial: `WHERE cpf_digits IS NOT NULL`).
  - `leads.cpf` e `captive_sessions.cpf` continuam existindo apenas para registros antigos; novos signups podem enviar `null`.
- Backend `/signup`: tornar CPF opcional; pular checagem de duplicidade quando não fornecido.
- Frontend cadastro e-mail/senha (fallback): remover campo CPF.

### 4. Fluxo unificado no frontend (`src/App.tsx`)
```text
Loading → tenta silent login (sessão Supabase existente)
   ├─ sucesso → authorize-existing → Success
   └─ sem sessão → Tela de escolha:
        [Continuar com Google]
        [Continuar com Apple]
        [Entrar com e-mail e senha]  (fallback: login/signup/forgot já existentes, sem CPF)
```
- Após OAuth callback, mesma rotina de `authorize-existing` já implementada — só muda a origem do `access_token`.

### 5. Backend (`supabase/functions/captive-portal/index.ts`)
- `/signup`: `cpf` opcional; sem check de duplicidade quando ausente.
- Novo endpoint (ou reuso de `/authorize-existing`): já aceita qualquer `access_token` Supabase, portanto Google/Apple funcionam sem endpoint novo. Garantir que `profiles` é criado no primeiro login OAuth (nome vem do provider; e-mail idem; telefone/cpf ficam null).
- Observabilidade: novos valores `auth_method`: `google`, `apple` (além de `email`, `silent`), refletidos em `portal_events` e no dashboard.

### 6. Dashboard (`src/pages/AdminDashboard.tsx`)
- Adicionar contadores/pills para `google` e `apple` nas seções "Contas & Autenticação" e "Auth" da tabela de sessões.

### Detalhes técnicos
- Supabase OAuth exige Site URL e Redirect URL atualizados no dashboard: `https://drogariaminasbrasilapp.com.br` (usuário faz).
- Apple: usar Services ID + private key no Supabase Dashboard (usuário configura com sua conta de developer).
- Contas e-mail/senha existentes continuam válidas (mesmo `auth.users`); nada a migrar.
- OAuth dentro do CNA: com HTTPS válido no portal + certificado público nas controladoras, o webview do CNA aceita o fluxo. Mesmo assim mantemos o fallback e-mail/senha por segurança (iOS às vezes bloqueia popups).

### Fora do escopo (confirmar depois se necessário)
- Configuração dos providers no dashboard Supabase (feita pelo usuário).
- Ajustes de Walled Garden no UniFi (feito pelo usuário).
- Configuração DNS/SSL do novo domínio.
