

# Adicionar CPF nas exportacoes e tabela admin

## Situacao atual

- **Banco de dados**: CPF ja esta sendo salvo corretamente na tabela `leads`.
- **CSV export**: Campo CPF nao esta incluido nos headers nem nos dados exportados.
- **XML export**: Nenhuma tag `<cpf>` e gerada no XML.
- **Tabela de leads no painel admin**: Coluna CPF nao aparece.

## Alteracoes necessarias

### 1. Edge Function - CSV Export (~linha 1168)

Adicionar "cpf" ao array de headers do CSV e incluir `lead.cpf` na linha de dados.

### 2. Edge Function - XML Export (~linha 1425)

Adicionar tag `<cpf>` logo apos `<name>` na geracao do XML:
```xml
<cpf>12345678900</cpf>
```

### 3. Painel Admin - Tabela de Leads (~linha 514)

Adicionar coluna "CPF" nos headers da tabela e exibir `l.cpf || "-"` nas linhas.

## Arquivo modificado

- `supabase/functions/captive-portal/index.ts` (CSV e XML)
- `src/pages/AdminPanel.tsx` (tabela de leads)

Nenhuma migracao de banco necessaria -- a coluna `cpf` ja existe.

