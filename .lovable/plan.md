## Resumo

Sim, o sistema **já suporta múltiplas lojas** (multi-controladora). A arquitetura de detecção de loja (`?store=` → IP → fallback), credenciais UniFi por loja (`stores.unifi_controller_url/username/password/site_id`) e RLS estão prontos. Hoje existe apenas a loja `matriz` cadastrada (2 IPs públicos).

Para adicionar uma nova unidade, há **3 ajustes obrigatórios** no Dockerfile (que hoje hardcoda `store=matriz`) e o cadastro da loja + IP + URL do hotspot no UniFi da nova unidade.

---

## O que já está pronto

- `stores` aceita N lojas com credenciais UniFi próprias (URL, site_id, user, pass).
- `detectStore()` no edge function resolve a loja por: `?store=slug` → `store_public_ips` (IP de saída NAT) → fallback única loja ativa.
- `/start`, `/submit`, `/verify-code` autorizam no controller **da loja detectada** usando `store.unifi_controller_url`.
- Admin UI permite criar/editar lojas e mapear IPs.
- RLS isola dados — endpoints públicos só passam por edge function (service role).

---

## O que precisa mudar no código (Dockerfile)

O Nginx hoje tem **`?store=matriz` cravado** em todos os redirects de captive probe e no `/guest/s/default/`. Isso quebra a detecção quando o cliente da nova unidade cair nesses caminhos.

**Mudança:** trocar `?store=matriz&$args` por `?$args` em:
- `location /guest/s/default/`
- `/generate_204`, `/gen_204`, `/hotspot-detect.html`, `/library/test/success.html`, `/connecttest.txt`, `/ncsi.txt`

A detecção continua funcionando porque:
1. O UniFi de cada loja injeta seus próprios `id=`/`ap=`/`ssid=` na URL.
2. Sem `?store=`, o edge function resolve pela tabela `store_public_ips` (IP NAT da unidade) — que é justamente o mecanismo previsto para multi-loja.

Opcional: o proxy `location /unifi/` hoje aponta hardcoded para `rwificontroller...:8083`. Só é usado pelo admin; se a nova unidade tiver controller diferente, podemos remover ou parametrizar depois — **não bloqueia** o captive flow.

---

## O que precisa ser cadastrado para a nova unidade

1. **Loja** no Admin → Lojas → Nova:
   - `slug` (ex: `filial-centro`)
   - `name`, `city`
   - `unifi_controller_url` (ex: `http://rwificontroller.drogariaminasbrasil.com.br:8083/filial-centro` ou outra controladora)
   - `unifi_site_id` (default `default`)
   - `unifi_username` / `unifi_password` (deixar em branco usa as globais `UNIFI_USERNAME`/`UNIFI_PASSWORD`)
   - `is_active = true`

2. **IP público de saída** da nova unidade em `store_public_ips` (Admin → IPs). Garante detecção mesmo quando o UniFi não injeta `?store=`.

3. **Hotspot UniFi da nova unidade**: configurar o "External Portal URL" para:
   ```
   http://wifi.guedesepaixao.com.br/?store=<slug-da-nova-loja>
   ```
   Isso é o caminho mais confiável de detecção (não depende de IP NAT).

4. **Walled Garden** no UniFi da nova unidade: liberar os mesmos domínios já usados na matriz (`wifi.guedesepaixao.com.br`, `fqamejlyytrhovawgtwg.supabase.co`, hosts do webhook OTP, etc.).

---

## Validações pós-deploy

- Abrir `http://wifi.guedesepaixao.com.br/?store=<novo-slug>` num cliente da nova unidade → portal carrega com nome correto.
- Submeter formulário → checar `captive_sessions.store_id` aponta para nova loja e `unifi_authorize_called_at` preenchido.
- Conferir `portal_events` por `store_id` para erros de autorização.

---

## Detalhes técnicos

- Build target es2015 e arquitetura same-origin HTTP continuam válidos para todas as lojas.
- Nenhuma migração de schema necessária.
- Sem mudanças em edge functions, frontend React ou RLS.
- Única alteração de código: 7 linhas no `Dockerfile`.
