
# Captive Portal — Plano e Correções

## Implementado

1. **Detecção de loja por `?store=slug`** — prioridade máxima na função `detectStoreFromRequest`
2. **Fallback para loja única ativa** — se não houver match por slug nem IP, usa a única loja ativa
3. **Rota `/guest/s/default/`** — alias para o portal HTML self-contained, captura `?id=MAC` do UniFi
4. **Frontend repassa `?store=`** — todas as chamadas da API incluem o parâmetro `store` da URL
5. **Correção de falsa autorização** — `/verify-code` agora retorna o valor real de `authorized` e não marca sessão como "authorized" quando a autorização UniFi foi pulada

## Correção: Falsa Autorização (v2)

### Problema
O `/verify-code` sempre retornava `authorized: true` mesmo quando:
- `client_mac` estava ausente (MAC não capturado)
- `store_id` estava null (loja não detectada)
- A chamada UniFi falhava

### Solução
- Retorna `authorized: true/false` baseado no resultado real da chamada UniFi
- Quando autorização é pulada (sem MAC ou sem store_id), marca sessão como "submitted" com `fail_reason` descritivo
- Mensagem de resposta varia conforme o resultado:
  - `authorized=true`: "Código verificado! Acesso liberado."
  - Sem MAC: "Cadastro salvo! Para liberar o WiFi, reconecte à rede."
  - Com MAC mas falha: "Cadastro salvo! Houve um problema na liberação automática."

## Configuração do UniFi
- URL do Guest Portal: `https://wifi.guedesepaixao.com.br`
- O UniFi redireciona para `/guest/s/default/?id=MAC&ap=AP_MAC&url=REDIRECT`

## Ações manuais pendentes (VPS)

1. **Nginx**: Verificar `try_files $uri /index.html?$args;` para preservar query params do UniFi
2. **Nginx**: Verificar trailing slash em `proxy_pass` para `/unifi-proxy/`:
   ```nginx
   location /unifi-proxy/ {
       proxy_pass http://localhost:PORTA/;  # trailing slash remove o prefixo
   }
   ```
3. **Teste do proxy**: `curl -k https://wifi.guedesepaixao.com.br/unifi-proxy/api/login -d '{"username":"...","password":"..."}'`
