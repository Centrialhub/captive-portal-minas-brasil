# Validação de identidade — 13/10/2026

## Escopo e decisões

As regras de formato e checksum são compartilhadas pelo frontend e pela Edge
Function em `supabase/functions/_shared/identity.ts`. CPF com dígitos verificadores
corretos não equivale a documento existente ou pertencente ao visitante.

Após resposta explícita do usuário em 13/10, números de preenchimento óbvio,
como `(38) 99999-9999`, são rejeitados. Isso substitui a opção provisória de
segunda digitação publicada no PR #5. Bloqueia-se o assinante inteiro repetido
(sem DDD) ou, no celular, os oito dígitos iguais após o prefixo 9, incluindo
`90000-0000` e `91111-1111`. Não há bypass por `phone_confirmation`.
Em 14/10, o usuário também solicitou rejeitar o assinante exato `912345678`:
o bloqueio vale para qualquer DDD, com ou sem formatação e DDI `+55`.
Essa regra não bloqueia outras sequências automaticamente.
É uma política de qualidade de cadastro, não prova de linha inexistente nem
verificação de posse. Números não uniformes, inclusive com algumas repetições,
continuam aceitos quando atendem ao formato. Não há SMS/WhatsApp nesta alteração.

## Correções

- Letras e caracteres não previstos não são mais apagados para transformar uma
  entrada inválida em identidade válida. Máscaras preservam excesso de dígitos.
- `+55`, DDD 55, demais DDDs válidos, móveis e fixos permanecem aceitos.
- Novas autorizações exigem CPF e telefone válidos para todos os provedores,
  inclusive login silencioso e Apple. A API retorna `awaiting_identity` e o
  formulário permite completar o cadastro, mantendo a capability da visita.
- Operações já admitidas continuam sendo acompanhadas antes da revalidação.
  Não há revogação de Wi-Fi confirmado ou novo comando de liberação por replay.
- Um token Auth opcional, verificado no servidor, permite reparar campos
  ausentes/inválidos do próprio perfil. Identificadores já válidos não podem
  ser trocados por esse mecanismo; conflitos não transferem CPF entre contas.
- Timeout ou falha de rede nessa consulta opcional pula o reparo e mantém a
  resolução normal de CPF/telefone. Sem sessão verificada, nenhum perfil é reparado.
- Erro na consulta de perfil retorna indisponibilidade; não é interpretado como
  ausência do cadastro para criar outro perfil.
- Triggers validam e normalizam campos novos/alterados em profiles e leads.
  Campos históricos inválidos, quando inalterados, não impedem outras atualizações.
  Nenhum registro legado é apagado nem corrigido automaticamente pela migração.
- Helpers privados e reparo são restritos ao serviço, sem novos direitos para
  visitantes ou usuários autenticados comuns. A RPC repete os checks sob lock.
- A migração incremental `20261013154212_reject_placeholder_phones.sql` aplica
  a mesma política no banco. Não altera a migração anterior nem reescreve dados.
  Perfis com telefone agora bloqueado voltam ao formulário antes de uma nova
  autorização; o proprietário autenticado pode corrigir o telefone. Operações
  já admitidas continuam sendo recuperadas.
- `20261014141322_reject_sequential_phone.sql` acrescenta `912345678` ao
  validador SQL, mantendo a preservação e o reparo autenticado dos dados antigos.

## Testes e revisão

- `npm test`: regressões de interface, retomada, concorrência e handlers reais
  extraídos por AST com dependências externas simuladas.
- Um milhão de candidatos de CPF comparados com cálculo independente.
- Todos os DDDs nacionais, formatos +55/DDD 55, telefones fixos, excesso,
  letras, estrangeiros/incompletos, rejeição de repetidos e reparo de perfil.
- `npm run test:identity-db`: PostgreSQL 17 local isolado, migração real,
  paridade SQL/JavaScript, ACLs, registros legados e reparos concorrentes.
- `npm run test:admission`: regressão com 300 clientes por NAT e limites atômicos.
- `npm run verify:recovery`: Chromium no bundle compilado e CSP real; backend
  inteiramente local, sem upstream, em viewport móvel/UA Android.
- Lint, TypeScript, Deno, checks de segurança/migrações/assets e build.

Os testes não representam ensaio físico em Android nem demonstram a meta de
99,9% em campo. Nenhum cliente real é autorizado pelos testes sintéticos.

Resultado da revisão do PR #5: 369 testes de aplicação, 21 de identidade em PostgreSQL,
20 de admissão em PostgreSQL, 16 cenários de navegador e 14 de preservação de
assets aprovados. Lint, TypeScript, Deno, verificações estáticas e build passaram.
O ensaio de navegador identificou ausência das variáveis públicas no primeiro
build local; o build foi refeito com a configuração pública existente e os
16 cenários passaram. A migração teve a sintaxe validada no PostgreSQL real.
Evidências locais estão em `tmp/identity-fixes-20261013/` e nos logs
`tmp/identity-*.log`; esses arquivos não são enviados ao GitHub.

A revisão automática do PR #5 encontrou um timeout não tratado na consulta Auth
opcional. O caminho foi corrigido e coberto por três regressões adicionais:
rejeição de rede, timeout e continuação pela resolução normal de identidade.

Após a decisão explícita de bloquear preenchimentos óbvios: 380 testes da
aplicação, 27 testes de identidade em PostgreSQL e 18 cenários no navegador
passaram. Incluem rejeição direta e via API com confirmação antiga, correção
de cadastro legado autenticado, preservação de operações admitidas e números
próximos válidos. Lint, TypeScript, Deno, migrações, segurança e build passaram.
Evidências: `tmp/placeholder-*.log` e `tmp/placeholder-phones-20261013/browser/`.

A inclusão de `912345678` em 14/10 passou em 389 testes da aplicação,
28 testes PostgreSQL e 21 cenários no navegador. Abrange todos os DDDs,
normalização +55, API sem bypass, preservação e reparo de histórico e aceitação
dos vizinhos `912345677`/`912345679`. Lint, tipos, segurança, migrações e build
aprovados. Evidências em `tmp/sequence-*.log` e
`tmp/sequence-phones-20261014/browser/`. Sem implantação ou teste de campo.

## Implantação compatível

Publicar em GitHub main não implanta automaticamente a Edge Function/migração.
Este pacote deve ser implantado na seguinte ordem:

1. Frontend desta revisão, conservando os assets anteriores já previstos no
   Dockerfile. Conferir `build-info.json` e o hash do bundle efetivamente servido.
   O novo frontend também funciona com o backend anterior: números bloqueados
   são recusados antes do envio e o token opcional de reparo é ignorado até a
   implantação da Edge Function que oferece esse recurso.
2. Aplicar as migrações pendentes em ordem, incluindo
   `20261013113423_enforce_portal_identity_integrity.sql` e
   `20261013154212_reject_placeholder_phones.sql` e
   `20261014141322_reject_sequential_phone.sql`, com a CLI/MCP de migrações.
   Os limites de lock são curtos; falha deve reverter a transação.
3. Implantar `captive-portal` da mesma revisão, preservando `verify_jwt=false`
   conforme a configuração atual e os controles próprios dos endpoints.
4. Conferir saúde/versão e executar diagnóstico sem liberar clientes sintéticos.

Abas antigas que precisarem do reparo autenticado devem
recarregar o frontend novo. A API rejeita placeholders mesmo enviados pelo
formulário antigo com confirmação. Não ativar exigências novas mantendo o frontend
antigo publicado. O arquivo antigo ainda servido na auditoria era `153dd87`.

Rollback: restaurar a função/frontend anteriores em conjunto se necessário.
Os triggers podem permanecer para dados válidos; uma reversão deles deve ser
explícita e não deve apagar cadastros ou revogar autorizações.
