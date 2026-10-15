# Auditoria 2 — recuperação sob falhas e sinal de prontidão

Base: `18826aedd4a2abccb62e6e487d0f75cdff92da6a`. Meta definida pelo responsável: pelo menos 99,9% das tentativas válidas liberadas em até 120 s. Esta frente acrescenta testes e documentação; não altera o produto nem produção.

## Método

`durable-faults.synthetic.test.ts` executa o coordenador real com relógio acelerado e modelo explícito de leases, outbox e prazos publicados. Cron começa no décimo segundo, repete a cada 10 s e pode sobrepor execuções. Cada execução recebe o deadline de 48 s efetivamente usado pelo endpoint. O modelo aplica limite de 16 leases, prioridade de verificação, fencing e prazo original. Ele não inclui disputa real de locks, limites da plataforma ou rede real; sua capacidade é condicional, potencialmente otimista. A suíte nativa separada cobre SQL/locks reais.

`readiness-resilience.synthetic.test.ts` extrai por AST e executa o bloco real de `/ready`, com respostas de banco e relógio simulados. Nenhuma chamada é feita ao Supabase ou UniFi.

Resultado desta frente: **15 testes, 13 aprovados e 2 reprovados**. Um teste aprovado executa adicionalmente **20 sequências determinísticas de jitter, com seeds 1–20**. Essas sequências não são contadas como 20 testes independentes nem como amostra de confiabilidade de produção.

## A2-C01 — P1: exceções de preparação da verificação retêm capacidade

Em um lote de **40 operações já aceitas**, foi programada uma falha na primeira preparação de verificação de cada operação para ocorrer após 6,1 s, sujeita ao subdeadline real da preparação. As passagens seguintes estavam saudáveis, com a autorização já presente na controladora simulada.

- **20 confirmaram e 20 expiraram sem confirmação**. Nenhum POST foi repetido e todas atingiram estado terminal.
- Houve 60 passagens de verificação, pico de oito adaptadores em execução e 52 erros acumulados, incluindo orçamento de lease insuficiente. Leases retidas também consomem o limite global mesmo quando não há HTTP em execução.
- Controle com os mesmos 40 itens e primeira resposta `inconclusive`: **40 confirmados**, 80 passagens, última confirmação em **58,3 s**.

**Causa:** `runAuthorizationWorker.verify` lança uma exceção quando a consulta auxiliar de AP falha antes do adaptador UniFi (`index.ts:2847`). O catch de `reconcileAuthorization` registra o erro sem chamar `record` (`durable-auth.ts:238`), conservando a lease de 30 s. Isso reduz a capacidade útil e o tempo restante de recuperação. O teste de um cliente com os handlers reais em `transport-resilience.synthetic.test.ts` corrobora a ligação entre a falha de AP e a retenção da lease.

**Não generalizar:** falhas HTTP normais tratadas pelo adaptador UniFi retornam `inconclusive` e já são persistidas como `pending`. O caso reprovado representa exceções da preparação de verificação, não toda falha de rede. A injeção de uma falha por operação é uma condição adversarial, não uma estimativa de frequência; **20/40 não é taxa medida no beta**.

**Correção proposta:** gravar um resultado pendente e liberar/reagendar a lease com fencing quando uma fase exclusivamente de leitura falha, caso o banco esteja acessível. Manter o prazo original e a proibição de repetir POST incerto. Se o registro falhar, conservar o fallback pela expiração da lease. Acrescentar teste em SQL real com invocações sobrepostas e latência, além deste modelo.

## A2-O01 — P1: despachos contínuos podem esconder worker sem resposta

O teste mantém uma operação em fila e cron saudável. A cada 10 s, o dispatcher atualiza `last_dispatch_at`, mas nenhuma execução conclui ou registra heartbeat — por exemplo, o transporte aceita a requisição e o endpoint responde erro ou nunca chega a executar. Aos **90 s**, o bloco real de `/ready` ainda retorna **HTTP 200, `authorization_reconciler=true`**.

**Causa:** `dispatchUnanswered` mede somente a idade do despacho mais recente (`index.ts:4534`). Cada novo despacho reinicia esse relógio antes do limite de 30 s; `last_worker_finished_at` pode permanecer nulo. Além disso, o watchdog encerra uma fila nunca enviada em 110 s, enquanto readiness considera sua idade excessiva apenas depois de 120 s. Assim, a limpeza pode remover a pendência antes de esse alerta aparecer. O teste demonstra a resposta incorreta aos 90 s; a possibilidade de continuar mascarada em tráfego contínuo decorre dessas regras.

**Alcance:** é uma falha de detecção, não prova de que o worker esteja parado em produção. O cron e o smoke hospedado estavam saudáveis na conferência desta rodada. A prontidão atual não deve ser usada isoladamente como comprovação de sucesso da liberação.

**Correção proposta:** registrar início/resultado dos despachos e o trabalho devido mais antigo ainda sem progresso, distinguir requisição enviada de execução iniciada/concluída, e avaliar falhas HTTP do transporte. Despachos novos não devem apagar a idade do trabalho sem resposta. Acompanhar também a taxa de conclusões `expired_unconfirmed`, inclusive após o watchdog esvaziar a fila. Evitar exigir tráfego artificial para considerar saudável um sistema realmente ocioso.

## Controles que passaram

| Condição simulada | Resultado |
| --- | --- |
| 4 operações novas, chamadas de 6,1 s, confirmação visível 60 s após aceite | 4/4 dentro de 120 s |
| 40 novas, chamadas de 2 s, visibilidade após 20 s | 40/40 dentro de 120 s |
| 40 novas, envio e leitura de 12 s | 40/40 dentro de 120 s |
| 40 já aceitas, leituras de 6,1 s, visibilidade somente aos 60 s | 40/40 dentro de 120 s |
| 80 já aceitas, mesmas condições | 80/80 dentro de 120 s |
| Perda da primeira gravação do resultado depois do POST, 8 operações | 8/8 por leitura, um POST por operação, dentro de 120 s |
| 20 schedules com jitter determinístico e perda de gravação pós-POST | Todas as oito operações de cada schedule recuperadas, sem POST repetido |
| Cron parado, diagnóstico privado de recuperação, sistema ocioso e primeiro despacho | Estados de prontidão coerentes nos quatro controles |

## Limite arquitetural explicitamente verificado

Quando o worker desaparece **depois do commit da intenção e antes do POST**, o banco não pode distinguir esse caso de um POST cujo efeito ocorreu mas cuja resposta se perdeu. O controle de quatro operações terminou com zero comandos reais e quatro expirações honestas, sem reenvio. Esse teste **passa**, pois preserva a segurança existente; também evidencia uma janela real de perda de disponibilidade.

Não é correto resolver esse limite reenviando cegamente. Para reduzir essa janela sem duplicar efeitos, é necessário avaliar idempotência durável na fronteira do proxy/controlador, com resultado consultável e sem prometer atomicidade entre sistemas que não a oferecem. Sua frequência precisa ser instrumentada; não foi medida em produção nesta auditoria.

## Reprodução

```powershell
npx vitest run supabase/functions/_shared/durable-faults.synthetic.test.ts supabase/functions/_shared/readiness-resilience.synthetic.test.ts
```

Os dois asserts reprovados devem continuar ativos até a correção. O resultado esperado atualmente é exit code 1. Não ampliar deadlines, remover o cap ou converter falhas em `skip` para aprovar a bateria.
