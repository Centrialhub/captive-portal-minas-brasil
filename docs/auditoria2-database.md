# Auditoria 2 — PostgreSQL e recuperação de autorização

## Escopo e resultado

Base auditada: `18826aedd4a2abccb62e6e487d0f75cdff92da6a`, incluindo a migration publicada `20260925180605_harden_durable_auth_recovery_under_load.sql`. Somente testes e este relatório foram alterados nesta frente. Nenhuma alteração de produto, migration, produção ou commit.

Foram acrescentados **10 testes adversariais**, preservando os 50 anteriores. As execuções completas em 25/09/2026 reproduziram **56 passes e 4 falhas; exit code 1**, incluindo repetição independente. A última execução desta frente terminou às **18:37:59.791 UTC**, após ajustar a infraestrutura de observação para aceitar conclusões seguras sem espera por lock. Os quatro resultados são violações de contratos específicos, com graus diferentes de exposição no backend atual; não representam quatro incidentes observados em produção.

A meta escolhida é **pelo menos 99,9% das tentativas válidas liberadas em até 120 s**. Essa meta continua sem demonstração estatística. Cenários determinísticos com controlador simulado não fornecem frequência de falhas em campo nem denominador de tentativas válidas.

## Método e segurança do ambiente

- PostgreSQL nativo **17.10**, Windows x64, cluster descartável em `127.0.0.1:55439`.
- Cada conexão verifica `SHOW data_directory`, o processo criado pelo harness e seu `postmaster.pid` antes de escrever. A proteção contra um cluster alheio na mesma porta foi preservada.
- As funções são carregadas das migrations sem modificações. Os testes usam transações, locks, cancelamento e encerramento de backends reais; o processo do cluster não é derrubado abruptamente.
- A terminação de conexão usa somente o PID de uma conexão que já passou pela verificação de cluster. Não há leitura de credenciais ou conexão remota.
- Os novos probes observam concorrentemente a conclusão da RPC ou `wait_event_type='Lock'` em `pg_stat_activity`, com `pg_blocking_pids` contendo o PID do blocker conhecido. Uma conclusão rápida segue os mesmos asserts de resultado correto; somente quando o lock esperado aparece é que o teste mantém a espera para consumir o prazo. Ausência de ambos, ou lock em um backend inesperado, gera `PROBE_SETUP_ERROR` e aborta a execução; não é contabilizada como defeito do produto.
- Locks e triggers de falha são liberados em `finally`. Os participantes e prazos modificados são exclusivamente fixtures sintéticas. Para evitar esperas de 90–110 s, timestamps dessas fixtures são envelhecidos de forma explícita; as esperas finais de 1,1 s ou 3,1 s são reais.
- Vault, pg_cron e pg_net permanecem stubs locais. Na carga, o coordenador TypeScript real chama as RPCs do PostgreSQL real, mas HTTP e UniFi são simulados.

Reprodução: instalar as dependências já fixadas no repositório e em `tests/database`, depois executar `npm test --prefix tests/database`. A versão atual deve encerrar com código 1 devido aos quatro asserts abaixo; não transformar esses asserts em sucesso esperado para aprovar uma correção. `tests/database/results.json` contém o horário, os casos e as observações da última execução e é ignorado pelo Git.

### Ajuste da infraestrutura de observação

A primeira versão desses probes exigia lock incondicionalmente. Isso reproduzia o defeito atual, mas impediria uma correção legítima não bloqueante de passar. O helper `completionOrOwnedLock` remove essa dependência do algoritmo antigo. Um controle SQL `SELECT 1` verifica o caminho de conclusão sem lock e não é contado como teste de produto.

Os resultados seguros aceitos continuam explícitos: DB-A2-01 precisa devolver exatamente o claim saudável; DB-A2-02 pode não reservar trabalho ou devolver envio com pelo menos 16 s; DB-A2-03 pode recusar a renovação ou devolver uma lease vigente. DB-A2-04 aceita confirmação ainda válida, projeção que não anuncie autorização atual, ou recusa explícita de lock/validade com rollback integral. Erro genérico não é uma correção aceita. Cancelamento e corrida terminal também permitem recusa não bloqueante sem relaxar atomicidade; para testar a recuperação final de um item adiado, apenas o retry da sua fixture pode ser antecipado depois de soltar o blocker, preservando o prazo da operação.

Após esse ajuste, todos os quatro casos seguiram pelo caminho `blocked` na implementação publicada e mantiveram as quatro falhas. A alteração do harness não corrige produto nem acrescenta um novo grupo de defeitos.

## Achados novos

| ID | Prioridade | Violação reproduzida | Proteção/limite atual |
| --- | --- | --- | --- |
| DB-A2-01 | P1 | Lock de sessão de uma operação expirada consome o orçamento de um claim saudável através do watchdog síncrono | Outra invocação sobreposta pode ignorar a operação já locked; não há prova de paralisação total da produção |
| DB-A2-02 | P2 | Claim devolve `send` depois que a espera na outbox reduziu o orçamento abaixo de 16 s | Coordenador revalida e registra `not_sent`; não foi emitido POST indevido |
| DB-A2-03 | P3 | Renovação devolve `true` embora sua lease já tenha vencido durante espera na outbox | RPC não possui caller TypeScript no checkout auditado |
| DB-A2-04 | P3 | Resposta de confirmação anuncia `authorized=true` com validade já vencida durante lock de participante | GET posterior rejeita o recibo; handlers atuais fazem essa releitura |

### DB-A2-01 — espera em participante bloqueia claim não relacionado

**Reprodução:** criar uma operação `queued` com 120 s de idade e uma nova operação saudável. Em outra conexão, manter `FOR UPDATE` na sessão da operação expirada. Solicitar claim da saudável com `statement_timeout=1500ms` apenas nessa conexão de teste. Confirmar pelo `pg_stat_activity` que o claim está esperando lock.

**Evidência:** as chamadas terminaram entre **1504 ms e 1508 ms**, com SQLSTATE **57014**, sem devolver operação; a saudável continuou `queued`. O timeout curto serve para medir a dependência de lock, não altera o SLO nem prova um atraso de 120 s. O lock pode durar mais que qualquer orçamento de invocação; isso decorre do mesmo caminho SQL sem espera limitada por item.

**Causa:** `claim_captive_auth_operations` chama `expire_captive_auth_operations(100)` antes de selecionar seu trabalho. A expiração usa `SKIP LOCKED` na operação, mas `sync_captive_auth_operation` espera por `FOR UPDATE OF a,s` nos participantes. O tratamento de erro por subtransação isola exceções por item, mas não impede a espera de lock. O dispatcher também chama esse watchdog antes do HTTP. Referências no SQL: linhas 84, 159 e 510.

**Alcance:** a invocação presa mantém o lock da operação; outra invocação simultânea pode ignorá-la e avançar. Se cada chamada for cancelada antes do próximo tick de 10 s, o mesmo item pode voltar a consumir cada invocação sequencial. Timeout real, cadência hospedada e incidência de sessões locked não foram medidos nesta rodada. O teste não demonstra queda global ou perda de atomicidade.

**Correção proposta:** impedir espera não limitada nas projeções da expiração: aquisição não bloqueante ou orçamento curto por item dentro da subtransação, com diagnóstico privado/backoff e continuação do lote. Não usar `SKIP LOCKED` no participante e concluir parcialmente a operação; o resultado terminal precisa continuar atômico. Separar limpeza de claim é outra opção, desde que o watchdog continue independente e confiável.

### DB-A2-02 — orçamento de envio fica obsoleto após lock da outbox

**Reprodução:** uma preparação comprovadamente sem POST retorna a `queued`. Restam 18 s do prazo original. Bloquear a linha da outbox; o claim obtém a operação, valida mais de 16 s e espera ao atualizar a outbox. Após observar o lock, manter a espera por 3,1 s e soltar.

**Evidência:** o SQL devolveu `action='send'` com **14,860–14,869 s** restantes nas execuções desta frente, abaixo do mínimo de 16 s. A deadline original não foi estendida.

**Causa:** o relógio é revalidado antes de atualizar a operação, mas o `UPDATE captive_auth_work_due` posterior pode bloquear antes do `RETURN NEXT` (migration, linha 138). O snapshot de lease/orçamento devolvido não é revalidado depois dessa espera.

**Alcance:** o coordenador atual calcula novamente o tempo restante, evita o adaptador e registra `not_sent/PREPARATION_BUDGET_EXHAUSTED` (`durable-auth.ts`, linhas 170–176). Portanto não foi demonstrado envio tardio ou reenvio incerto; há reserva inútil, consumo de preparação e possível falha de disponibilidade.

**Correção proposta:** adquirir as linhas necessárias sem espera antes de reservar o envio, ou validar o tempo depois do último lock bloqueante e desfazer/reclassificar atomicamente a reserva que ficou inviável. Conservar a deadline original, a prova de não envio e o fencing.

### DB-A2-03 — renovação positiva já vencida

**Reprodução:** operação possui 1 s restante da tolerância `deadline+20s` e uma lease ainda válida. Bloquear sua outbox. A renovação valida a operação, calcula a nova lease limitada à tolerância e espera na outbox por 1,1 s depois de o lock ser observado.

**Evidência:** `renew_captive_auth_operation_lease` retornou **true**, enquanto a consulta imediatamente seguinte encontrou `lease_expires_at > clock_timestamp()` igual a **false**.

**Causa:** validação e cálculo ocorrem antes da última espera bloqueante (migration, linhas 398–400).

**Alcance:** não há chamada a essa RPC no backend TypeScript auditado. É uma falha do contrato de renovação que pode afetar consumidores futuros; não é evidência de incidência atual em clientes.

**Correção proposta:** renovar somente depois de adquirir a outbox ou revalidar relógio e validade original após a espera. Se o prazo já foi consumido, retornar `false`; jamais ressuscitar uma lease ou estender a tolerância.

### DB-A2-04 — projeção de confirmação fica obsoleta antes da resposta

**Reprodução:** usar a duração permitida de 1 minuto; o comando foi aceito há 59 s, restando 1 s de validade, ainda dentro do prazo de verificação de 90 s. Bloquear a sessão. Registrar evidência válida de confirmação, observar a espera no participante e manter o lock por 1,1 s.

**Evidência:** `record` retornou `operation.authorized=true`, enquanto o GET com a mesma capability retornou imediatamente `receipt_stale`, `authorized=false`.

**Causa:** `record` valida `authorized_until` antes da sincronização dos participantes (migration, linhas 456–457 e 496). Após o lock, retorna `captive_auth_operation_result`, que calcula `authorized` pelo estado histórico `confirmed`, sem verificar a validade atual (migration base, linha 114).

**Alcance:** a configuração histórica do beta de 40 minutos torna esta variante de 1 minuto menos representativa da operação atual. A API suporta durações a partir de 1 minuto. `authorizeDurably` e `handleAttemptStatus` releem o GET e já rejeitam o recibo obsoleto; não foi demonstrada liberação falsa na UI. O status histórico `confirmed` pode continuar correto como registro da observação: o problema é usar a mesma projeção como autorização atual. Nenhuma mudança deve apagar evidência verdadeira só porque o recibo venceu.

**Correção proposta:** uniformizar as respostas de RPC com uma projeção que distinga confirmação histórica de recibo utilizável no momento, reavaliando validade após as esperas relevantes. Manter a releitura final dos handlers e a atomicidade de sessão/tentativa/auditoria.

## Casos que preservaram os invariantes

| Teste adicional | Resultado |
| --- | --- |
| Terminar conexão depois do claim em transação ainda sem commit | Reserva inteira revertida; próximo claim seguro envia uma vez, versão 1 |
| Terminar conexão depois de registrar aceite sem commit | Estado anterior `sending` preservado; recuperação só verifica, sem repetir POST |
| Cancelar confirmação enquanto aguarda participante | SQLSTATE 57014 e rollback integral; retry confirma com uma única auditoria |
| Concorrer confirmação e watchdog em ambas as ordens de lock | Uma conclusão coerente, uma auditoria, sessão/tentativa alinhadas e outbox removida |
| 105 operações com erro de auditoria | Primeiro lote diagnosticou 100; próximo lote completou 105, classificou a saudável expirada e permitiu claim novo |
| 80 comandos aceitos + 40 operações em fila, com dez clientes exigindo três leituras | 120 confirmadas, 40 POSTs novos, 140 leituras, última conclusão em 40 s simulados |

No teste misto, o pico medido foi de **4 leases ativas**, pois a controladora responde imediatamente e o teste executa uma invocação por tick. Isso não mede saturação das 16 leases globais nem HTTP de 14 s. Os testes anteriores de concorrência real mantêm o limite de 16; o cenário novo mede ordenação, transientes e mistura de operações aceitas e não enviadas. Não é justificativa para admitir demanda ilimitada.

## Próximos critérios de validação

1. Corrigir o isolamento da espera do watchdog e repetir o cenário com um item bloqueado por mais de uma cadência, incluindo invocações sobrepostas.
2. Corrigir os contratos de tempo/projeção sem aumentar deadlines e sem retirar a revalidação do coordenador. Os quatro asserts devem então passar sem mudar os limites.
3. Medir em campo início, aceitação, confirmação, causa terminal e prazo de cada tentativa válida, com denominador definido, antes de declarar atendimento ao SLO de 99,9% em 120 s. Não inferir essa taxa a partir de 120 clientes sintéticos iguais.

Referência de semântica: locks de linha persistem até o fim da transação e esperas precisam ser consideradas nos caminhos posteriores ao primeiro lock; o teste usa esses comportamentos documentados em [PostgreSQL — Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html). O cancelamento real segue o contrato de [PostgreSQL — Canceling Queries](https://www.postgresql.org/docs/current/libpq-cancel.html). As causas acima são inferidas do SQL publicado e corroboradas pelas reproduções locais.
