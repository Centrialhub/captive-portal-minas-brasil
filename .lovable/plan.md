

# Corrigir 404 no Captive Assistant

## Diagnóstico

O `vercel.json` com rewrites só funciona em deploy no Vercel. Se o captive assistant está apontando para o preview do Lovable (`*.lovable.app`) ou outro ambiente que não seja Vercel, as chamadas a `/api/captive-portal/bootstrap` retornam 404 porque não há servidor proxy — o arquivo `vercel.json` é ignorado.

Além disso, mesmo no Vercel, se o deploy ainda não incluiu o `vercel.json`, o mesmo problema acontece.

## Solução

Tornar o `API_BASE` em `src/lib/api.ts` dinâmico com fallback:

- **Em produção (Vercel)**: usar caminho relativo `/api/captive-portal` (same-origin proxy)
- **Em outros ambientes** (Lovable preview, dev local): usar URL absoluta do Supabase `https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal`

### Lógica de detecção

```typescript
function getApiBase(): string {
  const host = window.location.hostname;
  // Em produção (Vercel) usa proxy same-origin
  if (host === "wifi.guedesepaixao.com.br") {
    return "/api/captive-portal";
  }
  // Fallback: URL direta do Supabase
  return "https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal";
}

const API_BASE = getApiBase();
```

### Arquivo modificado

- `src/lib/api.ts` — apenas a definição de `API_BASE` muda, todo o resto (resilientFetch, retry, endpoints) permanece igual.

Nenhuma mudança visual. Nenhuma mudança no `vercel.json`.

