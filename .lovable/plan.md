

# Detecção de Loja sem IP + Rota UniFi Guest

## Implementado

1. **Detecção de loja por `?store=slug`** — prioridade máxima na função `detectStoreFromRequest`
2. **Fallback para loja única ativa** — se não houver match por slug nem IP, usa a única loja ativa
3. **Rota `/guest/s/default/`** — alias para o portal HTML self-contained, captura `?id=MAC` do UniFi
4. **Frontend repassa `?store=`** — todas as chamadas da API incluem o parâmetro `store` da URL

## Configuração do UniFi
- URL do Guest Portal: `https://wifi.guedesepaixao.com.br`
- O UniFi redireciona para `/guest/s/default/?id=MAC&ap=AP_MAC`
- O Nginx deve preservar query params: `try_files $uri /index.html?$args;`

## Fluxo de detecção de MAC
1. UniFi redireciona → `/guest/s/default/?id=AA:BB:CC:DD:EE:FF`
2. Frontend lê `?id=` como `client_mac` via `getQueryParams()`
3. `startSession()` envia `client_mac` ao backend
4. Backend salva na sessão e usa para autorizar no UniFi controller
