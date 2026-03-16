

# Problema: URL do UniFi e Captura de MAC

## Situação

O UniFi Controller redireciona clientes para uma URL configurada no Guest Portal. O problema é que **o UniFi não permite URLs com caminhos complexos** (como `https://wifi.guedesepaixao.com.br/?store=loja_teste&id=%m`) — ele só aceita URLs simples tipo `https://wifi.guedesepaixao.com.br`.

Além disso, o MAC do cliente (`client_mac`) está chegando como `null` em todas as sessões, o que impede a autorização no controlador UniFi.

## Diagnóstico do fluxo MAC

O UniFi redireciona o cliente para uma URL como:
```
https://wifi.guedesepaixao.com.br/guest/s/default/?id=AA:BB:CC:DD:EE:FF&ap=...&url=...
```

O Nginx redireciona `/guest/s/default/` para `index.html` (já configurado). O frontend (`portal-utils.ts`) lê `?id=` como `client_mac`. Isso **deveria funcionar** — mas precisa verificar se o UniFi realmente está passando esses params.

O fluxo atual:
1. `getQueryParams()` lê `?id=` ou `?mac=` da URL → `client_mac`
2. `api.startSession(params)` envia `client_mac` no body do POST `/start`
3. O backend salva `client_mac` na sessão
4. No `/submit`, o `client_mac` é passado no body e salvo na sessão e no lead
5. No `/verify-code`, o backend busca `client_mac` da sessão para autorizar no UniFi

**Problema identificado**: O `?store=` param precisa chegar ao backend sem depender da URL do UniFi. Como o UniFi não permite paths/params customizados, precisamos de outra abordagem.

## Plano de Correção

### 1. Remover dependência do `?store=` na URL do UniFi
Como só existe uma loja ativa, o fallback automático (já implementado) já resolve: `"Store detected via single-active fallback: loja_teste"`. Os logs confirmam que isso está funcionando. Portanto, **não é necessário** passar `?store=` na URL do UniFi.

### 2. Garantir captura do MAC via URL do UniFi
O UniFi gera URLs no formato:
```
https://wifi.guedesepaixao.com.br/guest/s/default/?id=AA:BB:CC:DD:EE:FF
```

O frontend já lê `?id=` como MAC. **Mas** o Nginx precisa preservar os query params ao redirecionar `/guest/s/default/` para `index.html`.

**Ação necessária no Nginx** (instrução para você): verificar que a regra de rewrite para `/guest/` preserva os query params. Exemplo:
```nginx
location /guest/ {
    try_files $uri /index.html?$args;
}
```
O `?$args` é crucial para não perder `?id=AA:BB:CC:DD:EE:FF`.

### 3. Corrigir o self-contained portal (`/portal`)
O endpoint `/captive-portal/portal` no edge function também recebe `?id=` e já extrai o MAC corretamente (linha 1785). Este funciona sem mudanças.

### 4. Adicionar endpoint `/guest/s/default/` no edge function como alias do portal
Para cenários onde o UniFi redireciona diretamente para a edge function (sem Nginx), adicionar uma rota que aceite o path `/guest/s/default/` e sirva o portal HTML (reusa `handlePortalHtml`).

### 5. Verificar a comunicação UniFi via diag endpoint
Usar o endpoint `/diag/unifi-ping` (já existente) para testar se o proxy consegue fazer login e autorizar um MAC de teste.

## Mudanças no código

### Edge Function (`supabase/functions/captive-portal/index.ts`)
- Adicionar rota para `/guest/s/default` que redireciona para `/portal` com os mesmos query params (ou serve diretamente o portal HTML)
- Isso cobre o caso em que o UniFi redireciona para o Supabase edge function diretamente

### Frontend (`index.html` / `portal-utils.ts`)
- Sem mudanças necessárias — já lê `?id=` como MAC

### Nginx (instrução para o usuário)
- Verificar que `try_files` inclui `?$args` para preservar query params

## Resumo da configuração do UniFi
No controller UniFi, a URL do Guest Portal deve ser simplesmente:
```
https://wifi.guedesepaixao.com.br
```
Sem caminhos adicionais. O UniFi automaticamente redireciona para `/guest/s/default/?id=MAC&ap=AP_MAC&url=REDIRECT`.

