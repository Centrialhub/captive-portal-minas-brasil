

# Liberar Wi-Fi sem depender do IP da loja

## Problema
Hoje o sistema identifica a loja pelo IP público do cliente (`store_public_ips`). Se o IP for dinâmico, o mapeamento quebra e a sessão falha com `NO_STORE_CONFIGURED`, impedindo a autorização UniFi.

## Solução: Fallback para loja única ativa + parâmetro opcional na URL

Duas mudanças na função `detectStoreFromRequest`:

1. **Aceitar `?store=slug` na URL de redirecionamento do UniFi** — se presente, buscar a loja diretamente pelo slug, sem depender de IP. A URL do Guest Portal no UniFi ficaria:
   ```
   https://wifi.guedesepaixao.com.br/?store=loja_teste&id=%m
   ```

2. **Fallback automático** — se não houver match por IP nem por `?store`, e existir **apenas uma loja ativa** no banco, usá-la automaticamente. Isso cobre o cenário atual (uma única loja) sem configuração extra.

## Mudanças técnicas

### `supabase/functions/captive-portal/index.ts`
- Na função `detectStoreFromRequest`, adicionar:
  - Antes do lookup por IP: verificar se existe query param `store` na request URL e buscar na tabela `stores` por slug
  - Após o lookup por IP falhar: buscar se há exatamente 1 loja ativa em `stores` e usá-la como fallback
- A ordem de prioridade fica: `?store=slug` > IP mapping > loja única ativa > fallback genérico (sem store_id)

### Nenhuma mudança no frontend
O parâmetro `store` já é passado via URL do UniFi, não precisa de alteração no React.

### Nenhuma migração necessária
Usa tabelas existentes (`stores`).

