# Plan: Centralizar Segredos UniFi em Armazenamento Seguro (PROMPT 05)

Este plano visa remover credenciais sensíveis (usuário e senha da controladora UniFi) do código-fonte, migrations e tabelas de acesso público, movendo-as para o Supabase Secrets.

## Mudanças

### Backend (Edge Function)
- Alterar `supabase/functions/captive-portal/index.ts` para que as credenciais globais `UNIFI_USERNAME` e `UNIFI_PASSWORD` sejam lidas exclusivamente de variáveis de ambiente (`Deno.env.get`), sem fallbacks vazios.
- Implementar falha controlada (`UNIFI_SECRET_NOT_CONFIGURED`) quando as credenciais estiverem ausentes, registrando o erro nos logs internos sem expor detalhes ao cliente.
- Garantir que a importação de APs via admin também falhe de forma segura se as credenciais não estiverem configuradas.
- Remover referências a `UNIFI_CA_CERT` que não é mais utilizado.

### Banco de Dados (Migration)
- Criar uma nova migration para:
  - Limpar (setar como `NULL`) todos os valores legados nas colunas `unifi_username` e `unifi_password` da tabela `public.stores`.
  - Revogar privilégios de `SELECT` nessas colunas sensíveis para as roles `anon` e `authenticated`, garantindo que não vazem via API REST.
  - Conceder `SELECT` apenas para `service_role` (usado pela Edge Function).
  - Corrigir vulnerabilidades de `SECURITY DEFINER` nas funções `has_role` e `rate_limit_hit` restringindo o acesso apenas a usuários autenticados/service_role.

### Documentação (Frontend)
- Atualizar `src/routes/index.tsx` com o texto oficial do **PROMPT 05** descrevendo a nova arquitetura de segredos.

## Detalhes Técnicos
- As credenciais UniFi agora devem ser configuradas exclusivamente via `supabase secrets set UNIFI_USERNAME=... UNIFI_PASSWORD=...`.
- O código do portal passa a tratar a ausência de segredos como um erro de configuração fatal interno, retornando `Configuração de credenciais UniFi ausente ou incompleta` no ambiente admin e falhando silenciosamente no fluxo do usuário para evitar vazamento de informações.

## Validação
- Verificação de ausência de strings sensíveis no repositório via `grep`/`rg`.
- Teste de build e checagem de tipos (`npm run check`).
- Linter de segurança do Supabase para confirmar a correção das permissões das funções.
