

# Verificação Completa: Problemas que Impedem a Liberação Real

## O que está acontecendo

A screenshot mostra sessões com status "authorized" e MAC capturado (`FA120104D437`). **Porém, essas sessões têm `store_id: null` no banco**, o que significa que a autorização UniFi **nunca foi executada**. O sistema marcou como "authorized" sem realmente liberar o cliente.

## 3 Problemas Críticos

### 1. Falsa autorização: resposta sempre diz `authorized: true`

**Linha 1124-1129**: A resposta do `/verify-code` **sempre** retorna `authorized: true`, independente do que aconteceu:

```typescript
return jsonResponse({
  ok: true,
  authorized: true,  // ← SEMPRE true, mesmo sem autorizar
  message: "Código verificado! Acesso liberado.",
});
```

**Linha 1115-1118**: Quando a autorização é pulada (sem MAC ou sem store_id), o código marca a sessão como "authorized" no banco mesmo sem ter feito nada no UniFi.

**Correção**: Retornar o valor real de `authorized` e mensagem adequada.

### 2. MAC está sendo capturado (confirmado), mas store_id estava null nas sessões antigas

A screenshot confirma MACs `FA120104D437` e `266EEA2A3A90`. **As sessões recentes já têm `store_id` correto** graças ao fallback implementado. Portanto, este problema está resolvido para novos fluxos.

### 3. Proxy UniFi precisa ser testado

A `unifi_controller_url` é `https://wifi.guedesepaixao.com.br/unifi-proxy`, que faz proxy para `guedesepaixao.com.br:8443`. O código tenta login em:
- `/api/auth/login` (UniFi OS) — vai retornar 404 pois é controller standalone
- `/api/login` (legacy) — deve funcionar

O Nginx do VPS precisa garantir que `/unifi-proxy/api/login` chega ao container como `/api/login` (trailing slash no `proxy_pass`).

## Mudanças no Código

### Edge Function (`supabase/functions/captive-portal/index.ts`)

1. **Linha 1115-1129** — Corrigir lógica de resposta:
   - Se `authorized === true`: retornar `authorized: true` + "Acesso liberado"
   - Se `authorized === false` sem MAC: retornar `authorized: false` + "Cadastro salvo, mas MAC não detectado"
   - Se `authorized === false` com MAC: retornar `authorized: false` + "Erro na liberação automática"
   - **Não marcar** a sessão como "authorized" quando a autorização não foi feita — manter como "verified"

2. **Adicionar log** quando MAC ou store_id ausentes no verify-code para facilitar debug

### Frontend (`App.tsx`)

3. **Tratar `authorized: false`** na tela de sucesso — mostrar mensagem diferente informando que o cadastro foi salvo mas a liberação automática falhou, com instrução para reconectar ao WiFi

### Ações manuais (VPS)

4. **Nginx** — Verificar que `try_files $uri /index.html?$args;` preserva query params
5. **Nginx** — Verificar trailing slash: `proxy_pass http://localhost:PORTA/;` para `/unifi-proxy/`
6. **Teste do proxy**: `curl -k https://wifi.guedesepaixao.com.br/unifi-proxy/api/login -d '{"username":"...","password":"..."}'`

