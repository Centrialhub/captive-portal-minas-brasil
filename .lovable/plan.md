

# Implementar Loja Matriz com Credenciais por Loja

## Contexto

A Loja Matriz tem credenciais UniFi diferentes (`hotspot` / `Hotspot@123`) das atuais (globais via secrets). O sistema precisa suportar credenciais por loja.

- Controller URL: `http://rwificontroller.drogariaminasbrasil.com.br:8083/matriz/`
- Cidade: Montes Claros
- Site ID: `default`
- Usuário: `hotspot` / Senha: `Hotspot@123`

## Plano

### 1. Migração: adicionar colunas de credenciais na tabela `stores`

```sql
ALTER TABLE stores
  ADD COLUMN unifi_username text,
  ADD COLUMN unifi_password text;
```

Essas colunas são nullable — quando vazias, o sistema usa os secrets globais (`UNIFI_USERNAME` / `UNIFI_PASSWORD`) como fallback.

### 2. Inserir a Loja Matriz

```sql
INSERT INTO stores (name, slug, city, unifi_controller_url, unifi_site_id, unifi_username, unifi_password, is_active)
VALUES (
  'Drogaria Minas Brasil - Matriz',
  'matriz',
  'Montes Claros',
  'http://rwificontroller.drogariaminasbrasil.com.br:8083/matriz',
  'default',
  'hotspot',
  'Hotspot@123',
  true
);
```

### 3. Atualizar Edge Function para credenciais por loja

Modificar `supabase/functions/captive-portal/index.ts`:

- A função `unifiTryLogin` passa a receber `username` e `password` como parâmetros em vez de usar as variáveis globais
- A função `unifiLogin` e `unifiAuthorizeByMac` recebem os mesmos parâmetros
- No fluxo de `/verify-code`, ao buscar a store, também buscar `unifi_username` e `unifi_password`
- Se a store tiver credenciais próprias, usar elas; senão, fallback para os secrets globais

Trecho principal da mudança:

```typescript
// Antes (global):
body: JSON.stringify({ username: UNIFI_USERNAME, password: UNIFI_PASSWORD })

// Depois (por loja com fallback):
body: JSON.stringify({ username: storeUsername || UNIFI_USERNAME, password: storePassword || UNIFI_PASSWORD })
```

### 4. Atualizar query da store no verify-code

Onde o sistema busca `unifi_controller_url` da loja, adicionar `unifi_username, unifi_password` no SELECT e passar para `unifiAuthorizeByMac`.

### 5. Mascarar credenciais nas respostas admin

Garantir que `unifi_username` e `unifi_password` sejam mascarados nas rotas admin (mesmo padrão já usado para `unifi_api_key_or_token`).

## Resumo de mudanças

| Arquivo | Mudança |
|---|---|
| Migration SQL | Adicionar `unifi_username`, `unifi_password` à tabela `stores` |
| `captive-portal/index.ts` | Passar credenciais como parâmetro nas funções UniFi; buscar da store |
| Insert SQL | Criar registro da Loja Matriz |

## Configuração no UniFi da Matriz (ação manual)

1. **Guest Portal**: ativar portal externo com URL `https://wifi.guedesepaixao.com.br/guest/s/default/?store=matriz`
2. **Walled Garden**: adicionar `wifi.guedesepaixao.com.br`, `fqamejlyytrhovawgtwg.supabase.co`, domínios WhatsApp e detecção de conectividade

