

## Problema

O código atual da função `unifiAuthorizeByMac` usa o header `X-API-Key` e o path `/proxy/network/api/s/{site}/cmd/stamgr`, que é o formato para UDM/Cloud Key com API Keys. O seu controlador **self-hosted** usa autenticação **legacy via cookie** e o path `/api/s/{site}/cmd/stamgr`.

## O que precisa mudar

### 1. Alterar a função de autorização UniFi (edge function)

Substituir a autenticação por API Key por um fluxo de duas etapas:

1. **Login**: `POST {controller}/api/login` com `{ "username": "...", "password": "..." }` — retorna um cookie `unifises`
2. **Autorização**: `POST {controller}/api/s/{site}/cmd/stamgr` com o cookie da sessão e payload `{ "cmd": "authorize-guest", "mac": "aa:bb:cc:dd:ee:ff", "minutes": 1440 }`

O path muda de `/proxy/network/api/s/...` para `/api/s/...`.

### 2. Usar credenciais existentes

Os secrets `UNIFI_USERNAME` e `UNIFI_PASSWORD` já existem no Supabase. A coluna `unifi_api_key_or_token` na tabela `stores` passará a ser **opcional** (não usada no modo legacy). As credenciais de login serão lidas dos secrets do ambiente.

### 3. Tratamento de certificado SSL auto-assinado

Controladores self-hosted geralmente usam certificados auto-assinados. O Deno por padrão rejeita esses certificados. Será necessário usar a opção `{ client: Deno.createHttpClient({ caCerts: [...] }) }` ou, se o secret `UNIFI_CA_CERT` estiver vazio, desabilitar a verificação de TLS para chamadas ao controlador.

### 4. Mudanças na tabela `stores`

- Preencher `unifi_controller_url` com a URL do controlador (ex: `https://192.168.1.1:8443`)
- Preencher `unifi_site_id` (normalmente `default`)
- `unifi_api_key_or_token` fica vazio (não usado no modo legacy)

### Arquivos alterados

- `supabase/functions/captive-portal/index.ts` — reescrever `unifiAuthorizeByMac` para usar login+cookie ao invés de API Key, e mudar o path para `/api/s/{site}/cmd/stamgr`

### Fluxo resumido

```text
1. POST /api/login  →  cookie "unifises"
2. POST /api/s/default/cmd/stamgr  →  autoriza o MAC
   Header: Cookie: unifises=xxxxx
   Body: { "cmd": "authorize-guest", "mac": "aa:bb:cc:dd:ee:ff", "minutes": 1440 }
```

### Pendências pós-implementação (configuração manual)

- Cadastrar o IP público da loja na tabela `store_public_ips`
- Preencher `unifi_controller_url` e `unifi_site_id` na tabela `stores`
- Garantir que a VPS consegue alcançar o controlador UniFi (rede/firewall)

