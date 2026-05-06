## Objetivo
Restaurar o fluxo de verificação OTP que parou de funcionar em 30/abr. Não reescrever o fluxo — apenas corrigir a regressão.

## Diagnóstico
- `/submit` funciona: 100% das sessões recentes têm `otp_sent=success` e `verification` criada
- `/verify-code` **nunca é chamado** pelo cliente (zero hits em `function_edge_logs`, `attempts=0` em todas verifications)
- Última verificação OK: **30/abr 08:53**. Após enxurrada de commits no fluxo no mesmo dia (17h–19h UTC), zero verificações.
- Hoje (06/mai) já há 4 sessões com OTP enviado e nenhuma com `/verify-code` registrado — confirma que é regressão recente, não mudança de comportamento dos usuários.

## Plano de correção (3 mudanças cirúrgicas)

### 1. Telemetria client-side do verify-code (essencial para confirmar a causa raiz)
Adicionar em `src/App.tsx` `handleVerify` e no fallback `index.html` (`fb-otp-verify` click):
- Um `logEvent` via novo endpoint `POST /client-event` antes de chamar `/verify-code`, com `{session_id, event:"verify_attempt_started"}`
- Outro após sucesso/erro com `{event:"verify_attempt_finished", outcome, error_kind}`
- Captura `console.error` + `window.onerror` durante a tela OTP, encaminhando para `/client-event`

Endpoint novo no Edge Function: `POST /client-event` que apenas grava em `portal_events` (rate-limited por session_id). Permite ver se:
- O click no botão Verify dispara JS (event "verify_attempt_started")
- O XHR retorna timeout/network (event "verify_attempt_finished" com error_kind)
- Ou se há erro JS antes do click (window.onerror)

### 2. Revisão do `handleVerify` e do botão OTP procurando a regressão
Comparar versão atual contra commit funcional (`30/abr 08:53` — antes de `82d9680`):
- Verificar se o `disabled` do botão Verify está correto (`verifying || otpCode.length !== 6`)
- Verificar se `sessionIdRef.current` está preenchido quando a tela OTP é montada (suspeita: refs zeradas se App.tsx remonta)
- Garantir que o input numérico não bloqueia paste (fluxo comum no mobile: copiar código do WhatsApp e colar)
- Adicionar fallback: se `sessionId` está vazio na tela OTP, chamar `/session-status` automaticamente para recuperar antes de exibir input

### 3. Endurecer o `/verify-code` no fallback HTML
No `index.html` (vanilla fallback), o handler atual depende de `state.session_id` setado em memória. Se a página recarrega entre OTP enviado e código digitado (comum no CNA), `state.session_id` é perdido.

Adicionar:
- Persistir `state.session_id` em `sessionStorage` logo após `/submit` retornar
- No carregamento da tela OTP, restaurar `state.session_id` do `sessionStorage` se vazio
- Mesmo em `src/App.tsx` (`sessionIdRef`)

## Validação
1. Deploy → abrir captive em celular real → chegar em OTP → digitar código
2. Conferir em `portal_events`:
   - `verify_attempt_started` deve aparecer ao clicar
   - `verify_code_response` deve aparecer no Edge
3. Se `verify_attempt_started` aparecer mas `/verify-code` não → bug de XHR
4. Se nem `verify_attempt_started` aparecer → bug de UI (botão/handler)
5. `captive_verifications.attempts > 0` na próxima tentativa real

## O que NÃO vou fazer
- Não trocar arquitetura (sem magic-link, sem callback, sem mudanças de UX)
- Não mexer no `/submit` nem no `sendWhatsAppCode` (estão OK)
- Não tocar em CORS/proxy/Dockerfile (`/submit` chega sem problemas, então a rota proxy está funcional)

## Arquivos afetados
- `supabase/functions/captive-portal/index.ts` — adicionar handler `/client-event`
- `src/App.tsx` — telemetria + persistência de `sessionId` + restore no OTP
- `index.html` — telemetria vanilla + persistência de `state.session_id`
- `src/lib/api.ts` — método `clientEvent(payload)`