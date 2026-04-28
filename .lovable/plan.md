# Contramedidas — falhas silenciosas de autorização UniFi

Plano para mitigar 5 causas mapeadas: **(1)** MAC divergente, **(7)** race no polling, **(9)** duração divergente, **(11)** cookie expirado, **(12)** ap_mac ausente. Tudo aplicado em `supabase/functions/captive-portal/index.ts` e refletido em `App.tsx` quando o usuário precisa agir.

---

## 1. MAC divergente (randomização / desassociação)

**Estratégia:** parar de confiar no MAC do parâmetro de URL e usar o MAC que o controlador realmente vê no AP, no momento da autorização.

- Antes do `authorize-guest`, buscar `/stat/sta` e tentar localizar o cliente por:
  1. MAC exato vindo do portal.
  2. Se não achar, filtrar clientes **não autorizados**, no mesmo `ap_mac` (quando disponível) e/ou no mesmo `essid`, com `assoc_time` recente (últimos 5 min).
  3. Se sobrar exatamente 1 candidato → usar o MAC dele (logar `MAC_REMAPPED: portal=X controller=Y`).
  4. Se sobrar 0 ou >1 → marcar `fail_reason = MAC_RANDOMIZATION_AMBIGUOUS` e devolver erro acionável ao usuário ("Desative MAC privado nas configurações do Wi-Fi e tente novamente").
- Persistir o MAC efetivamente autorizado em `captive_sessions.client_mac` (sobrescrevendo o original) para auditoria.
- Adicionar coluna `original_client_mac` em `captive_sessions` via migração para preservar o MAC reportado pelo dispositivo.

## 7. Race condition no polling de `/stat/sta`

**Estratégia:** polling mais paciente, com backoff, e re-emissão do comando.

- Aumentar de 5 para **10 tentativas** com backoff `[500, 750, 1000, 1500, 2000, 2000, 2500, 3000, 3000, 3500]ms` (~20s totais).
- Após a 5ª tentativa sem confirmação, **reenviar** `authorize-guest` uma única vez (cobre o caso de o controlador ter "perdido" o comando) e continuar o polling.
- Aceitar como confirmação qualquer cliente que apareça com `authorized === true` **OU** com `use_fixedip` + IP atribuído + `assoc_time` posterior ao envio do comando (alguns firmwares marcam `authorized=false` mas liberam tráfego).
- Logar latência de cada confirmação (`AUTH_CONFIRMED_AFTER_MS=...`) para tunar futuramente.

## 9. Duração divergente / Guest Policy do site limita os minutos

**Estratégia:** ler a política do site e enviar um valor garantidamente aceito.

- Adicionar fetch único (cacheado em memória por 10 min, por `site_id`) de `/rest/portalconf` ou `/rest/wlanconf` para obter o `auth_timeout` do site.
- Calcular `minutes = min(global_settings.session_duration_minutes, site_auth_timeout || 1440)`.
- Incluir explicitamente `minutes` no payload do `authorize-guest` (hoje pode estar omitido — verificar e adicionar `{ cmd: "authorize-guest", mac, minutes }`).
- Se o controlador devolver `meta.msg` indicando limite (ex: `api.err.AuthorizeRejected`), retentar uma vez com `minutes=15` (mínimo seguro) e marcar `fail_reason = SITE_POLICY_OVERRIDE`.

## 11. Cookie de sessão UniFi expirado durante o fluxo

**Estratégia:** detectar resposta de login HTML disfarçada de 200 e re-autenticar.

- Após `authorize-guest`, validar:
  - `Content-Type` da resposta começa com `application/json`. Se for `text/html`, classificar como `UNIFI_SESSION_EXPIRED`.
  - Corpo contém `meta.rc`. Se ausente, idem.
- Em caso de `UNIFI_SESSION_EXPIRED`:
  1. Descartar cookie atual.
  2. Refazer `unifiLogin` (forçando bypass de qualquer cache de cookie que venha a existir).
  3. Reemitir o `authorize-guest` exatamente uma vez.
- Mesma checagem aplicada ao polling de `/stat/sta`: se vier HTML, refazer login antes de continuar tentativas.
- Não usar cache de cookie entre requisições — cada chamada de `unifiAuthorizeByMac` faz login fresh (já é o comportamento atual; documentar para não quebrar).

## 12. ap_mac ausente / incorreto no payload

**Estratégia:** sempre enviar `ap_mac` quando conhecido, e descobri-lo se faltar.

- Se `captive_sessions.ap_mac` existir, incluir no payload: `{ cmd: "authorize-guest", mac, ap_mac, minutes }`.
- Se `ap_mac` for `NULL` na sessão:
  1. Buscar `/stat/sta` antes do authorize.
  2. Localizar o MAC do cliente e ler `c.ap_mac`.
  3. Persistir em `captive_sessions.ap_mac` e usar no payload.
- Se mesmo assim não houver `ap_mac` (cliente não está visível ainda), enviar sem ele e logar `AP_MAC_MISSING_FALLBACK`.

---

## Mudanças por arquivo

### `supabase/functions/captive-portal/index.ts`
- Refatorar `unifiAuthorizeByMac` para:
  - Aceitar `apMac?: string` e `desiredMinutes?: number`.
  - Fazer um GET prévio em `/stat/sta` para resolver MAC efetivo (causa 1) e descobrir `ap_mac` se faltar (causa 12).
  - Validar `Content-Type` JSON em todas as respostas (causa 11), com retry pós re-login.
  - Ampliar polling para 10 tentativas + backoff + re-emissão do comando na metade (causa 7).
  - Incluir `minutes` no payload e respeitar política do site (causa 9).
- Adicionar helper `unifiGetStations(baseUrl, siteId, headers, httpClient)` para reuso.
- Adicionar helper `pickEffectiveMac(stations, portalMac, apMac, ssid)` com a lógica de remapeamento.
- Atualizar chamadores (`/verify-code` e endpoints de diagnóstico) para passar `ap_mac` da sessão e `minutes` calculado.

### `src/App.tsx`
- Quando `result.error` indicar `MAC_RANDOMIZATION_AMBIGUOUS`, mostrar mensagem específica:
  > "Seu celular está usando endereço Wi-Fi privado. Vá em Configurações > Wi-Fi > MINASBRASIL_CLIENTES > desative 'Endereço privado/MAC aleatório' e toque em Reenviar código."
- Para `SITE_POLICY_OVERRIDE` e `UNIFI_SESSION_EXPIRED`, usar mensagem genérica de "Tente novamente em alguns segundos" (sistema já fez retry interno).

### Migração SQL
- `ALTER TABLE captive_sessions ADD COLUMN original_client_mac text;`
- `ALTER TABLE captive_sessions ADD COLUMN auth_latency_ms integer;` (para tuning futuro do polling)

---

## Observabilidade

Códigos de `fail_reason` padronizados gravados em `captive_sessions.fail_reason`:

```text
MAC_RANDOMIZATION_AMBIGUOUS    causa 1
MAC_REMAPPED_OK                causa 1 (sucesso após remap)
UNIFI_200_BUT_NOT_CONFIRMED    causa 7 (esgotou retries)
SITE_POLICY_OVERRIDE           causa 9
UNIFI_SESSION_EXPIRED          causa 11 (recuperado)
UNIFI_SESSION_EXPIRED_FATAL    causa 11 (não recuperado)
AP_MAC_MISSING_FALLBACK        causa 12
```

Cada caminho loga linha estruturada `[unifi-auth] reason=... mac=... ap_mac=... site=... ms=...` para análise posterior via `supabase--edge_function_logs`.

---

## Fora do escopo (deixar para próxima rodada)
- Causas 2/3 (site_id errado) — depende de revisão manual de cadastro de lojas.
- Causa 4 (Guest Control desabilitado) — requer endpoint de diagnóstico, melhor tratar separadamente.
- Causa 8 (permissão insuficiente do usuário UniFi) — operacional, não de código.
- Causa 10 (proxy nginx mascarando) — parcialmente coberto pela validação de Content-Type da causa 11.
