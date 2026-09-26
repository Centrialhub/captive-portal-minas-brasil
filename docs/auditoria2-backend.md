# Segunda auditoria — transporte UniFi e admissão

Base examinada: `18826aedd4a2abccb62e6e487d0f75cdff92da6a`.
Escopo: checkout local; nenhum comando ou consulta ao controlador/produção. Meta informada: pelo menos 99,9% das tentativas válidas liberadas em até 120 segundos.

## Resultado reproduzível

```powershell
npx vitest run supabase/functions/_shared/transport-resilience.synthetic.test.ts
npx eslint supabase/functions/_shared/transport-resilience.synthetic.test.ts
```

Resultado desta rodada: **14 casos, 6 aprovados e 8 reprovados; ESLint aprovado**. As oito reprovações representam **dois achados novos e uma confirmação de um achado paralelo do coordenador**, não oito defeitos independentes. Permanecem testes ativos, sem `skip` ou `it.fails`. Não houve alteração de produto nesta rodada.

Os corpos atuais das funções Edge são extraídos por AST. Handler, coordenador, login, validação de estação e envio executam sua implementação real. As respostas HTTP e RPC são simuladas. O fake de uma operação reproduz a projeção flat+nested do GET, exclusão por lease de 30s e o requeue de preparação em 5s; não pretende substituir os testes SQL nativos. O fetch nativo é proibido no contexto e os endpoints sintéticos usam `.invalid`.

## A2-T01 — P1: espera sem limite antes de existir operação recuperável

Localizações:

- `supabase/functions/captive-portal/index.ts:680`: `checkRateLimitDb` aguarda `rate_limit_hit` sem deadline.
- `supabase/functions/captive-portal/index.ts:3645`: resolução da identidade sem deadline.
- `supabase/functions/captive-portal/index.ts:3702`: `auth.admin.createUser` sem deadline.
- `supabase/functions/captive-portal/index.ts:2920` e `:2926`: leituras de loja/configuração em `authorizeDurably`, antes de `join_captive_auth_operation`.

**Reprodução:** uma dependência em cada um desses cinco pontos recebe uma Promise controlada que continua pendente. Avançam-se 120.001ms no relógio. O handler continua pendente e não chamou a admissão/autorização durável. Ao final, o teste libera a Promise para limpar a execução. Os cinco casos falham na expectativa de uma conclusão limitada pelo prazo.

**Causa:** os limites recentes de RPC, preparação e worker começam depois desses awaits ou protegem outras chamadas. O timeout de 25s do XHR (`src/lib/api.ts:178`) é apenas do cliente: não cria a operação nem limita esse trabalho no servidor. Também há awaits de perfil, papéis, bloqueio e detecção de loja nessa região; foram inspecionados, mas não se contam como reproduções adicionais.

**Impacto:** uma tentativa válida pode permanecer fora do outbox durante todo o objetivo de 120s. O reconciliador não recupera trabalho que ainda não foi admitido. Isso é uma falta determinística de limite local diante de uma dependência que não conclui; não prova que uma indisponibilidade completa de Auth/Postgres possa ser superada pelo código, nem mede sua frequência em produção.

**Correção proposta:** prazo absoluto de admissão compartilhado desde a entrada, transmitido aos awaits de validação/rate/identidade/configuração, cancelamento quando suportado e resposta recuperável explícita. Fazer uma chamada terminar com 503 evita a espera indefinida, mas **não satisfaz sozinho a meta de liberação**. Se a meta incluir a fase anterior ao join, ela precisa de uma estratégia de admissão/retomada durável e identidade idempotente. Um timeout de `createUser` pode ter criado a conta remotamente; não é prova de ausência de efeito nem autorização para criar outra às cegas.

## A2-T02 — P2: cooldown explícito do controlador é perdido antes do POST

Localizações:

- `supabase/functions/captive-portal/index.ts:835`: login não 2xx retorna somente código genérico.
- `supabase/functions/_shared/unifi-authorization.ts:116`: erro de `/stat/sta` descarta os headers.
- `supabase/migrations/20260925180605_harden_durable_auth_recovery_under_load.sql:438`: três falhas de preparação encerram a operação.
- Mesma migration, `:483`: requeue de preparação fixado em 5s.

**Reprodução:** login ou preflight devolve HTTP 429 com `Retry-After: 30`. O adaptador corretamente retorna `unknown`, `command_sent:false`, `retryable:true`, sem emitir comando, mas não transporta os 30s para o agendador. Os dois testes reprovam a ausência de `retry_after_ms` — campo proposto para o contrato; um contrato equivalente de prazo absoluto pode substituir essa representação, desde que preserve o cooldown.

**Cadeia causal por leitura do SQL atual:** sob despachos nos primeiros instantes elegíveis, as preparações podem falhar em t=0, t=5 e t=10s e virar `AUTHORIZATION_PREPARATION_EXHAUSTED`, embora a dependência tenha anunciado recuperação em t=30s. Em cron a cada 10s, também é possível encerrar em t=20s. Esses tempos são deduzidos da política atual; esta suíte comprova a perda do header, não executa esse cenário de carga em PostgreSQL.

**Correção proposta:** preservar um cooldown validado (segundos ou HTTP-date), limitar ao orçamento remanescente e transmiti-lo ao registro/agendamento. O SQL deve respeitá-lo para preparações comprovadamente não enviadas. Um 429 recebido **depois do POST** continua ambíguo e deve seguir por verificação, sem novo POST. O significado de `Retry-After` e seus dois formatos estão definidos no [RFC 9110, seção 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3).

**Limite:** é uma injeção sintética válida de sobrecarga. Não se afirma que o controlador de Povão esteja emitindo esses headers hoje.

## A2-T03 — corroboração do achado do coordenador: timeout na consulta de AP ocupa a lease

Localizações: `supabase/functions/captive-portal/index.ts:2847` e `supabase/functions/_shared/durable-auth.ts:238`.

**Reprodução end-to-end local:** o comando inicial é aceito. A primeira verificação é reclamada em t=2s. O worker inline recebe 20s de orçamento e reserva 16s para adaptador/registro: a preparação tem somente 4s e vence em t=6s. O teste registra esse horário de conclusão efetivo. O erro de AP programado para 6,1s após a consulta chega em t=8,1s, depois da resposta, e é descartado. Assim, o defeito observado neste caso é `AP_LOOKUP_TIMEOUT`, não `AP_LOOKUP_FAILED` após 6,1s.

Em t=18,1s, com a consulta já saudável e a estação autorizada, a leitura de status não consegue reclamar a operação: a lease permanece até t=32s. O teste concede mais que os 10s máximos do intervalo normal de reagendamento SQL após a resposta, sem impor uma correção específica de 2s. O caso falha na expectativa de confirmação pela verificação saudável seguinte. Nenhum POST extra foi emitido.

**Causa precisa:** a exceção de prazo acontece antes do adaptador de verificação. O catch do coordenador apenas acrescenta o erro; não registra `pending` nem libera a lease. O controlador sequer recebe esse GET. Uma resposta de erro do banco que chegue ainda dentro do orçamento de preparação percorre o mesmo catch; o modelo de carga separado do cron pode ter orçamento suficiente para observar um erro de AP após 6,1s. Já os erros HTTP normais tratados pelo adaptador viram `inconclusive`, são persistidos como `pending` e liberam a lease. Não generalizar esta reprodução para qualquer falha HTTP.

**Impacto/limite:** uma operação isolada ainda pode se recuperar dentro dos 120s, mas perde capacidade e permanece com a lease ocupada por cerca de 26s depois da resposta de timeout. O efeito sobre lotes e a classificação final de severidade pertencem ao cenário de carga independente do coordenador; não foram extrapolados deste único cliente.

**Correção proposta:** diferenciar falha na fase somente leitura de qualquer falha após envio. Reagendar/liberar de forma fenced uma verificação que falhou, conservando a exclusão de novo POST e sem declarar rejeição/autorização. Não aplicar essa regra ao resultado desconhecido de um envio.

## Proteções que passaram nesta rodada

- Três respostas após comando possivelmente aplicado — HTTP 401, 429 e 502 — permaneceram incertas. Uma nova sessão de login e um GET exato confirmaram posteriormente, com **um único POST** por caso.
- Corpo de resposta truncado após aplicação, seguido de falha no RPC de registro, preservou a intenção. Antes de a lease vencer não houve nova consulta/comando; após vencê-la a confirmação ocorreu por leitura, sem reenvio.
- Preflight 401 e preflight JSON truncado foram classificados como comprovadamente não enviados, mesmo com fallback de MAC habilitado. A preparação seguinte usou login/cookie novos e emitiu apenas um comando; a leitura posterior confirmou.

Essas evidências verificam contratos locais e falhas injetadas. Não certificam 99,9% em produção, a disponibilidade dos provedores, a conectividade efetiva de internet ou todos os estados de um controlador físico.
