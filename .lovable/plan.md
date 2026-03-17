

# Reduzir autorização WiFi para 15 minutos

## Mudança

No arquivo `supabase/functions/captive-portal/index.ts`, linha 567:

**Atual:** `{ cmd: "authorize-guest", mac: formattedMac, minutes: 1440 }` (24 horas)

**Novo:** `{ cmd: "authorize-guest", mac: formattedMac, minutes: 15 }` (15 minutos)

Após 15 minutos, o UniFi desautoriza o cliente automaticamente e ele precisará refazer o cadastro/login no portal para reconectar.

