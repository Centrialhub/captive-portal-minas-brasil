# Novos achados dos testes sintéticos de banco — 25/09/2026

> **Atualização:** os achados abaixo são o diagnóstico histórico anterior à correção. Os 18 grupos foram corrigidos; a validação atual passou com 303 testes automatizados e dois fluxos de navegador. Backend v254 e migration corretiva implantados; frontend ainda pendente. Veja [correção e evidências atuais](correcao-sinteticos-povao-2026-09-25.md).

## Escopo e resultado

Checkout: `F:\captive MB\tmp\reliability-release-20260925`. Nenhuma chamada a produção, UniFi ou clientes reais. Nenhuma alteração nas migrations aplicadas ou nas funções de produto. Os testes usam PostgreSQL 17.10 nativo em `127.0.0.1:55439`, schema sintético com constraints/triggers do catálogo e as migrations publicadas, sem dados pessoais.

Foram acrescentados **16 cenários adversariais** a `tests/database/run.mjs`: **8 passam e 8 falham**. Com os 28 anteriores, são **36 sucessos e 8 falhas**, que correspondem a **seis problemas distintos**. A suíte prossegue depois das falhas adversariais, grava `tests/database/results.json`, encerra seu PostgreSQL e retorna **exit 1**. Isso bloqueia a validação para uma próxima liberação; não é um conjunto de falhas convertido artificialmente em sucesso.

```powershell
Set-Location 'F:\captive MB\tmp\reliability-release-20260925'
npm test --prefix tests/database
```

O `README` do harness explica instalação, isolamento e tratamento das falhas. Nesta máquina foi usada uma junction local para as dependências já instaladas em `F:\captive MB\tests\database\node_modules`. O arquivo de resultados contém as observações e todos os ticks de carga. As reproduções abaixo são locais; **não demonstram que estes incidentes ocorreram em produção**.

## DB-SYN-01 — P1: a fila excede o prazo mesmo com controlador sempre disponível

Referências: `run.mjs`, função `runBrowserlessLoad` e três testes de capacidade; migration durável, `claim_captive_auth_operations`, ordenação `ORDER BY w.due_at,op.id` (linha 420); coordenador, gate mínimo de lease de 16 s e limite de quatro operações por lote.

### Reprodução e evidência

A cada tick de 10 s o harness chama o RPC real com lote 4. O aceite agenda a consulta para 2 s depois, igual ao coordenador. Um envio sintético é sempre aceito; uma consulta sintética sempre encontraria `found=true, authorized=true` para a MAC correta. Cada operação só é processada se sua lease tiver pelo menos 16 s restantes.

Para acelerar o teste, são envelhecidos apenas os timestamps das operações e outbox desse cenário em 10 s por tick. As funções SQL, locks, ordem, lease e watchdog são os mesmos da migration. Não há troca de funções por modelos. O controle de quatro clientes confirma que o mecanismo simulado permite sucesso.

| Condição inicial | Envios aceitos | Consultas de confirmação executadas | Recusados pelo gate de 16 s | Confirmados | `expired_unconfirmed` |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4 operações em fila | 4 | 4 | 0 | 4 | 0 |
| 40 operações em fila | 40 | 0 | 40 | 0 | 40 |
| 40 operações já aceitas pela execução inicial | 40 | 36 | 4 | 36 | 4 |

No lote de 40 operações em fila, os ticks de 0 a 90 s são ocupados por envios. Uma verificação volta para a fila com `due_at` maior que o das operações ainda não enviadas. Sua primeira oportunidade ocorre aproximadamente 100 s depois da intenção original. A lease restante é de 10 s, abaixo dos 16 s exigidos. O mesmo atraso alcança cada grupo; o watchdog termina todos sem confirmação.

No lote já aceito, as primeiras verificações vencem em 2 s e começam no tick de 10 s. Nove lotes confirmam 36 clientes até 90 s; o décimo só é obtido em 100 s, com 10 s restantes de lease. Quatro clientes ficam sem confirmação mesmo sem nenhum envio novo competindo.

### Impacto e proposta

O caminho de recuperação independente do navegador não sustenta esse tamanho de rajada dentro do orçamento atual. O estado final de erro não comprova ausência de internet: neste teste os comandos foram aceitos, mas a leitura posterior não coube na capacidade disponível. A carga de produção e o tamanho de rajadas reais não foram medidos nesta rodada.

Uma próxima correção deve reservar capacidade para operações já enviadas, ordenar sua urgência pelo prazo e aplicar admissão/backpressure compatível com o orçamento. Aumentar somente o lote desloca o limite: validar também recuperação após reinício, filas mistas e a pressão do paralelismo sobre a controladora. Manter o limite de repetição de POST e os estados honestos. Os dois testes de 40 clientes devem passar com o orçamento adotado antes de afirmar recuperação independente do navegador nessa carga.

## DB-SYN-02 — P2: join usa validade anterior à espera por locks

Referências: migration durável, `join_captive_auth_operation`, `v_now` na declaração (linha 193), advisory lock (209), consulta de reuso (234), retornos de participação existente (223/279). Testes: `join cannot reuse an authorization...` e `existing membership cannot bypass capability expiry...`.

### Reprodução A: autorização expira durante o advisory lock

1. Criar uma operação confirmada com aceite e um novo attempt compatível.
2. No fixture, definir `authorized_until=agora+1.000 ms`.
3. Uma conexão mantém o advisory lock da loja/MAC; outra inicia o join.
4. Confirmar no `pg_stat_activity` que o join espera por lock; liberar depois de mais 1.100 ms.

**Obtido:** join retorna `disposition=confirmed`, `authorized=true`, e projeta autorização na nova tentativa/sessão. GET imediato da mesma tentativa retorna `receipt_stale`. O filtro de seleção usou `v_now` anterior à espera.

### Reprodução B: capability expira durante o lock da operação

1. Criar participação ativa e definir expiração da capability para `agora+1.000 ms`.
2. Uma conexão mantém a operação com `SELECT ... FOR UPDATE`.
3. Iniciar outro join dessa mesma tentativa, confirmar o bloqueio e liberar depois de mais 1.100 ms.

**Obtido:** `disposition=joined`, embora a capability já esteja vencida. O retorno rápido para uma participação existente não repete a validação temporal depois do lock.

### Impacto e proposta

O handler atual relê GET depois do worker; esse passo reduz o risco de uma resposta pública de sucesso obsoleta. Ainda assim, no caso A o banco já anexa a tentativa nova a um recibo vencido, escreve `authorized` e deixa de criar uma operação nova que poderia consultar/liberar o cliente. No caso B, o contrato da RPC aceita uma capability fora de sua validade.

Recalcular o relógio após esperas e revalidar token, identidade, elegibilidade e validade antes de todos os retornos de join. A operação confirmada selecionada também deve ser revalidada depois de seu row lock. Se o recibo perdeu a validade de reuso, continuar pelo fluxo de operação nova/consulta, preservando locks e unicidade; não promover a sessão com evidência vencida.

## DB-SYN-03 — P2: renovação ressuscita uma lease vencida durante row lock

Referência: migration durável, `renew_captive_auth_operation_lease` (linha 436). Teste: `lease renewal refuses an owner whose lease expired during row-lock wait`.

### Reprodução e evidência

Criar lease válida, reduzir seu vencimento no fixture para `agora+1.000 ms`, reter a linha com `SELECT ... FOR UPDATE`, iniciar a RPC de renovação em outra conexão e liberar o lock depois de mais 1.100 ms. O teste confirma primeiro o bloqueio real via `pg_stat_activity`; se ele não for observado, a execução aborta com erro de preparação e não contabiliza uma violação de produto.

**Obtido:** a RPC retorna `true` e estende a lease após seu vencimento. O predicado do `UPDATE` pode ter sido avaliado antes da espera; o dono que segurou apenas o lock não mudou a versão da linha para obrigar outra avaliação das condições temporais.

### Impacto e proposta

Quebra o contrato de vencimento da lease. O coordenador atual não chama esta RPC; portanto é uma falha latente do contrato, e este teste isolado não demonstra dois POSTs nem uso incorreto em produção. Seguir o padrão do finalizador: adquirir explicitamente o row lock, obter o relógio atual, conferir dono/versão/lease/prazo e só então renovar e ajustar a outbox na mesma transação.

## DB-SYN-04 — P1: retry comprovadamente não enviado recebe novo POST após o prazo

Referências: migration durável, claim `status='queued' -> action='send'` (422), limite de lease com tolerância de 20 s (428), tratamento de `not_sent` (481) e classificação por prazo no record (514). Teste: `known-unsent retry cannot emit a fresh send after the verification deadline`.

### Reprodução e evidência

Criar operação, obter o primeiro claim, registrar `not_sent` com `command_sent=false`. Envelhecer seu orçamento no fixture para `first_sent_at=agora-91 s` e `verification_deadline=agora-1 s`, com outbox devida. Chamar o claim normal.

**Obtido:** `action=send` com aproximadamente **19.000 ms de lease**, suficiente para atravessar o gate de 16 s do coordenador. Ao tentar registrar um aceite sintético desse envio, o record encontra também o conflito de projeção descrito em DB-SYN-06: `AUTH_OPERATION_STATE_MANAGED`.

### Impacto e proposta

A tolerância criada para conciliar uma operação já enviada também permite iniciar um novo envio depois do orçamento de preparação/verificação. Um POST aceito nessa janela pode liberar a rede sem uma oportunidade útil de confirmar; ainda se soma a falha de persistência DB-SYN-06. Nenhum POST externo foi executado para reproduzir isso.

O claim deve impedir um novo `send` depois do prazo original e considerar o tempo mínimo necessário para enviar e verificar. A tolerância posterior deve permitir somente conciliação de efeitos já possíveis. Para casos comprovadamente não enviados com orçamento esgotado, produzir um terminal explícito de preparação/prazo, sem renovar o orçamento ou enviar novamente. Confirmar esta condição também no adaptador antes do POST, pois o tempo entre claim e rede consome orçamento.

## DB-SYN-05 — P2: erro específico de um item expirado paralisa claims não relacionados

Referências: migration durável, `claim_captive_auth_operations` chama `expire_captive_auth_operations(100)` antes do claim (412); watchdog itera a conclusão sem isolamento de erro por item (557–567). Teste: `one audit poison item cannot prevent claiming unrelated healthy work`.

### Reprodução e evidência

Criar duas operações expiradas e uma nova saudável. Injetar um trigger local de auditoria que falha **apenas** para a primeira operação expirada. Tentar o claim específico da operação nova.

**Obtido:** o claim novo falha com `POISON_OPERATION_AUDIT`; as três operações continuam `queued`, inclusive a expiração saudável. O rollback da operação com falha é correto, mas a mesma transação reverte o lote e impede trabalho não relacionado. Após remover o trigger em `finally`, o watchdog volta a concluir as expirações.

### Impacto e proposta

Este é um teste deliberado de contenção de falhas de persistência, não evidência de um trigger defeituoso existente em produção. Mostra que uma falha dependente de um item pode interromper globalmente claims novos e dispatchers, repetindo indefinidamente o mesmo erro.

Separar o fracasso de um item da transação que atende outros: subtransação por expiração, diagnóstico sanitizado e retry/backoff/quarentena duráveis, com alerta. Preservar a atomicidade de operação/tentativa/sessão/auditoria dentro do item; não considerar sucesso uma conclusão parcialmente gravada. Garantir que a operação saudável continua sendo atendida quando uma expiração específica falha.

## DB-SYN-06 — P1: resposta de envio após o prazo entra em conflito com o guard

Referência: migration durável, `record_captive_auth_operation`, classificação após prazo (514), gravação terminal da operação (516–534), telemetria dos participantes (536–542) e só então `sync_captive_auth_operation` (545). Teste: `late actual-send responses persist their effect and terminal projections atomically`.

### Reprodução e evidência

Criar uma operação, registrar uma preparação comprovadamente não enviada e ajustar apenas o fixture para restarem 500 ms de seu orçamento original. Obter o novo claim **antes** do deadline; a lease real vai até aproximadamente deadline + 20 s. Esperar 650 ms reais e registrar `accepted` com `command_sent=true`, já depois do deadline mas dentro da lease. Repetir numa operação independente com `unknown` e `command_sent=true`. O teste confirma as duas condições temporais e não depende do envio pós-deadline de DB-SYN-04.

**Obtido nos dois casos:** `AUTH_OPERATION_STATE_MANAGED`. A transação reverte: operação continua `sending`, tentativa `authorizing`, sessão `submitted`, `command_dispatched_at` e `command_accepted_at` continuam nulos. A evidência do efeito externo não é persistida, embora dono, versão e lease sejam válidos.

O record muda primeiro a operação para `expired_unconfirmed`; em seguida atualiza contadores/timestamps nos participantes, ainda com seus estados ativos. O guard exige estado `failed` para uma operação terminal e rejeita essa atualização antes que o finalizador tenha chance de projetar os estados corretos.

### Impacto e proposta

Respostas atrasadas de comandos podem não ser registradas precisamente quando mais se precisa preservar a incerteza/aceite. A outbox e o estado `sending` sobrevivem ao rollback, portanto a retomada continua sendo verificação, sem prova de reenvio; porém o sistema perde a evidência de aceite recebida por aquele worker e pode terminar por watchdog.

Reordenar a transação ou unificar telemetria e projeção para que todas as atualizações respeitem o estado canônico da operação. Registrar o efeito conhecido do POST e o terminal honesto atomicamente, sem enfraquecer o guard para writers legados. Testar tanto `accepted` quanto `unknown` com `command_sent=true` após o prazo e antes de vencer a lease.

## Cenários novos aprovados

- 24 joins simultâneos com quatro contextos incompatíveis na mesma MAC: uma identidade vence; seus seis participantes aderem; os 18 restantes ficam sem sessão parcial.
- 24 dispositivos independentes distribuídos entre três claims concorrentes: cada operação é obtida uma vez.
- Duas respostas simultâneas de aceite: uma gravação, um evento de lease, um item recuperável na outbox.
- Confirmação e rejeição terminal concorrentes: um vencedor, projeções coerentes e uma auditoria.
- Participante cancelado e participação com identidade inválida injetados como DBA: somente o participante elegível é autorizado; GET dos excluídos não afirma sucesso. A API normal de atualização não consegue cancelar uma linha gerenciada, e o trigger foi restaurado imediatamente após a injeção.
- Bloqueio de usuário após um comando já aceito: a verdade observada sobre Wi-Fi é conservada e o challenge de login é recusado. Não testa revogação de acesso de rede, que é outra operação.
- Falha na criação do evento inicial: identidade, sessão, operação e outbox são revertidas; a tentativa seguinte cria uma única operação.
- Controle de capacidade com quatro clientes sem navegador: quatro confirmações.

## Limites e próximo gate

As prioridades representam a importância do caminho quebrado, não sua incidência em produção. Os testes de capacidade assumem ticks regulares e ausência de navegador/worker inicial no cenário enfileirado; no cenário já aceito, assumem perda de todos os navegadores depois do POST. Rede lenta, sobreposição de invocações hospedadas e carga real precisam de validação própria.

Esta rodada termina com testes e diagnóstico. A correção precisa de código/migration nova, revisão e novo resultado sem falhas. Não alterar o histórico das migrations `20260925164858` e `20260925165002`, não aplicar correções em produção como parte da execução destes testes e não desabilitar o gate para conseguir resultado verde.
