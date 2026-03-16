
# Captive Portal — Status do Sistema

## ✅ Verificação completa realizada

### Fluxo testado via curl (Edge Function)
1. `POST /start` com MAC → sessão criada com `store_id` e `client_mac` ✅
2. `POST /submit` → lead criado, OTP enviado via WhatsApp, verification com `store_id` ✅
3. `POST /verify-code` → valida OTP, tenta autorizar no UniFi ✅

### Correções aplicadas

1. **Falsa autorização corrigida** — `/verify-code` retorna valor real de `authorized` (não mais `true` fixo)
2. **Sessões sem MAC/store não marcadas como "authorized"** — ficam como "submitted" com `fail_reason`
3. **Login UniFi resiliente** — sempre tenta legacy `/api/login` como fallback (não apenas em 404)
4. **Consent fallback corrigido** — usa versão `1.0` (existente no DB) em vez de `offline-fallback` (que causava erro 400)

### Fluxo completo: AP → Liberação

```
1. Cliente conecta ao WiFi → UniFi redireciona para:
   https://wifi.guedesepaixao.com.br/guest/s/default/?id=MAC&ap=AP_MAC

2. Nginx serve index.html com ?id=MAC preservado (REQUER ?$args)

3. Frontend lê ?id= como client_mac → POST /start (cria sessão com MAC)

4. Formulário preenchido → POST /submit (cria lead, envia OTP WhatsApp)

5. Código OTP digitado → POST /verify-code:
   a. Valida OTP
   b. Busca client_mac e store_id da sessão
   c. Busca unifi_controller_url da loja
   d. Login no proxy: /api/auth/login (OS) → fallback /api/login (legacy)
   e. Autoriza MAC: POST /api/s/{site}/cmd/stamgr com cmd=authorize-guest
   f. Retorna authorized=true/false real
```

### Dependências do VPS (ações manuais)

1. **Nginx `?$args`**: `try_files $uri /index.html?$args;` — preserva `?id=MAC` do UniFi
2. **Nginx proxy trailing slash**: 
   ```nginx
   location /unifi-proxy/ {
       proxy_pass http://localhost:PORTA/;
   }
   ```
3. **Teste do proxy**: `curl -k https://wifi.guedesepaixao.com.br/unifi-proxy/api/login -d '{"username":"...","password":"..."}'`
4. **Walled Garden UniFi**: incluir domínio do portal, Supabase, OCSP/CRL, domínios de detecção Google/Apple
