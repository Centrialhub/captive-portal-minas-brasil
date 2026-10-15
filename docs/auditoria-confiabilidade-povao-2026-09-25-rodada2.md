# Segunda auditoria de confiabilidade — beta Povoão

## Conclusão

**A meta escolhida é pelo menos 99,9% das tentativas válidas liberadas em até 120 segundos. Ainda não há evidência suficiente para afirmar que o sistema cumpre essa meta.** A nova bateria reproduziu nove grupos adicionais de problemas, com impactos e proteções diferentes. Quatro são prioritários para reduzir perdas de recuperação ou detectar indisponibilidade.

Foram acrescentados **60 testes**. Resultado integrado: **363 testes, 346 aprovados e 17 reprovados**. **Os 303 testes da rodada anterior continuam aprovados**. Portanto, os defeitos anteriormente corrigidos não regrediram nos testes existentes; esta rodada ampliou as condições examinadas.

Esta rodada alterou testes e documentação. A aplicação, as migrations e a configuração de produção permanecem na versão auditada. Backend publicado: **v254**. Frontend publicado: **`90b0767af59b9490fb3191601ac2796886ee72c2`**, ainda anterior às correções de recuperação. **Continua necessária uma nova implantação do frontend após resolver os novos bloqueadores e concluir os gates de publicação.**

## Estado observado em produção

Conferência de 25/09/2026, 18:20–18:28 UTC (15:20–15:28 de Brasília), somente leituras:

- Edge Function v254; prontidão HTTP 200, zero operações atrasadas e zero diagnósticos de recuperação.
- Cron: **359 execuções concluídas na hora examinada**, com configuração de envio habilitada.
- Desde a implantação v254 às 18:06 UTC: **duas operações confirmadas**, com tempos entre criação e confirmação de **3,925 s e 4,540 s**. Duas tentativas/sessões estavam autorizadas e vinculadas às operações.
- Logs da função na janela fixa 18:06:22–18:20:17 UTC: 16 respostas HTTP 200 e duas 401. Essa janela inclui verificações da auditoria, inclusive o smoke sem credencial; não é uma amostra de 18 tentativas de clientes. Não apareceram respostas 5xx nesse recorte, o que não descarta requisições que nem chegaram ao serviço.
- Havia eventos de confirmação da operação, mas não evidência de navegação externa desses dois aparelhos nesse recorte. Estado confirmado na controladora e internet efetivamente utilizável são medidas diferentes.

Esses dados indicam funcionamento nos casos observados. **Duas confirmações são uma amostra insuficiente para validar 99,9%.** Além disso, o cenário sintético A2-O01 mostra que prontidão verde isoladamente pode mascarar um worker sem resposta.

O advisor também manteve o aviso de [proteção contra senhas vazadas desabilitada](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Apontou, como informativos, [duas FKs sem índice](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) em `user_id` de `captive_auth_operations` e `captive_auth_operation_members`, 27 [índices sem uso registrado](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) e 20 tabelas internas com [RLS sem policies](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy). Os índices das FKs merecem avaliação para crescimento; não foi medido atraso causado por eles nesta rodada. Pouco uso no beta não justifica remover índices de proteção/recuperação. O RLS sem policies das tabelas privadas é coerente com ACLs restritas e gravação por funções confiáveis. Esses avisos não foram contados como novos defeitos reproduzidos.

`drive` e `joao23` continuam fora do escopo, conforme orientação do responsável. Nenhum cliente sintético foi criado ou liberado em produção nesta auditoria.

## Resultado reproduzível

| Suíte | Total | Aprovados | Reprovados |
| --- | ---: | ---: | ---: |
| Aplicação: React, handlers, UniFi, coordenador e prontidão | 303 | 290 | 13 |
| PostgreSQL 17.10 nativo, transações e locks reais | 60 | 56 | 4 |
| **Total** | **363** | **346** | **17** |

Dos 60 casos novos, 43 passaram e 17 falharam. São **17 testes reprovados**, não 17 defeitos nem necessariamente 17 asserções individuais. Um teste adicional aprovado também percorre 20 schedules determinísticos de jitter; esses schedules não foram somados artificialmente ao total.

ESLint e TypeScript passaram. O agente principal repetiu a suíte completa da aplicação e a suíte PostgreSQL em novo cluster descartável, reproduzindo os resultados. Houve revisão cruzada das três frentes e dos modelos de carga/prontidão. Não há `skip`, falha esperada ou mudança de implementação para fazer a auditoria passar.

```powershell
npx vitest run --reporter=json --outputFile=tmp/audit2-application-results.json
npm test --prefix tests/database
npm run lint
npm run typecheck
```

As duas suítes de testes devem retornar código 1 enquanto os achados permanecerem. Resultado consolidado: [audit2-results-2026-09-25.json](audit2-results-2026-09-25.json).

## Achados por prioridade

| ID | Prioridade | Evidência e consequência | Proteção/limite relevante |
| --- | --- | --- | --- |
| A2-T01 | **P1** | Cinco dependências anteriores ao join continuam pendentes depois de 120 s; ainda não existe operação recuperável | Timeout no navegador não cria trabalho no outbox. Responder 503 mais cedo, sozinho, não entrega liberação |
| A2-C01 | **P1** | Exceção na preparação da verificação retém lease. No modelo de 40 operações com uma falha auxiliar por operação, 20 confirmam e 20 expiram | Controle `inconclusive` confirma 40/40; resultado condicionado, não taxa de falha observada em Povoão |
| DB-A2-01 | **P1** | Watchdog espera lock de participante antes de reclamar trabalho saudável; teste consome seu statement timeout | Uma invocação sobreposta pode avançar; não foi demonstrada paralisação global |
| A2-O01 | **P1** | Novos despachos reiniciam a idade usada pela prontidão; aos 90 s sem heartbeat, ainda retorna HTTP 200 | Falha de detecção reproduzida, não indicação de que o worker hospedado estava parado |
| A2-T02 | **P2** | Login/preflight 429 perdem `Retry-After: 30`; política de três preparações pode encerrar antes da recuperação anunciada | Só se aplica ao caminho comprovadamente anterior ao POST; resposta pós-POST continua incerta |
| DB-A2-02 | **P2** | Claim devolve `send` com menos de 16 s após esperar pela outbox | Coordenador atual recusa o envio; consome preparação/capacidade, sem POST tardio demonstrado |
| AUD2-F01 | **P3** | Eventos de retomada fazem leitura mesmo offline; XHR pendurado atrasa a retomada em aproximadamente 22 s no cenário | Recupera depois; nenhum POST UniFi duplicado ou bloqueio permanente demonstrado |
| DB-A2-03 | **P3** | Renovação retorna `true` com lease vencida durante espera na outbox | RPC sem caller TypeScript atual; contrato latente |
| DB-A2-04 | **P3** | Resultado de `record` anuncia autorização cuja validade venceu durante lock | GET posterior retorna `receipt_stale`; handlers atuais fazem a releitura e estão protegidos |

A2-T03, no relatório de transporte, é uma segunda reprodução da retenção de lease de **A2-C01** e não foi contado novamente. Prioridade indica impacto e urgência técnica; não expressa probabilidade medida.

### Por que a recuperação ainda perde capacidade

Uma exceção na consulta auxiliar de AP durante a verificação fica no catch do coordenador e mantém a lease até expirar. Isso reserva capacidade sem estar consultando a controladora. O controle com resposta HTTP inconclusiva já usa `pending`, libera a lease e confirma todos os 40 itens. A correção deve liberar/reagendar de forma segura somente a fase de leitura, preservando fencing e prazo original.

O modelo executa o coordenador e o helper real de deadline, incluindo o subdeadline da preparação. Ele não simula todos os locks ou a plataforma hospedada. A reprodução com um cliente usa handlers e adaptadores reais extraídos por AST, e confirma que uma preparação de verificação pode reter a lease mesmo após a consulta ficar saudável. Não se deve interpretar os 20/40 como previsão exata para qualquer rajada real.

### Por que um indicador verde não basta

`last_dispatch_at` registra a tentativa mais recente de despertar o worker. Se é atualizado a cada 10 s, nunca atinge os 30 s usados para detectar ausência de resposta. A limpeza também pode encerrar filas antes do limite de atraso usado por `/ready`. É necessário medir execução/progresso e resultados inconclusivos, além de verificar que o cron está chamando o dispatcher.

## Proteções que resistiram à nova rodada

- POST possivelmente aplicado com resposta 401, 429, 502 ou corpo truncado: recuperação por leitura, sem repetir o comando.
- Perda da gravação após POST: intenção preservada e recuperação após lease, sem comando duplicado.
- Encerramento real de conexão PostgreSQL antes do commit: rollback de reservas e de aceite parcial.
- Cancelamento durante sincronização e corrida confirmação/watchdog: um estado coerente e auditoria sem duplicação.
- 105 itens com falha de auditoria: processamento em lotes sem perder os diagnósticos ou bloquear definitivamente os itens saudáveis por exceção.
- Carga mista em PostgreSQL real: 80 operações já aceitas + 40 em fila, respostas simuladas imediatas e dez clientes exigindo três leituras; **120/120 confirmadas**, 40 novos POSTs e 140 leituras. Não mede saturação de rede.
- Modelo com 40 operações novas e chamadas de 12 s; modelo com até 80 já aceitas e confirmação visível somente aos 60 s: todos os itens confirmados dentro de 120 s nas condições fornecidas.
- Mudança de contexto, capability expirada, resposta inválida após confirmação e retomada após timeout não produziram reenvio automático de identificação nos casos verificados.

## Plano necessário para perseguir 99,9%

1. **Admissão com prazo e retomada.** Aplicar orçamento absoluto desde a entrada a rate limit, identidade, Auth, resolução da loja e configuração. Persistir de forma idempotente o progresso recuperável da tentativa válida. Timeout de criação de usuário não autoriza criar outra conta às cegas. Testar resposta perdida e commit tardio antes de existir operação Wi-Fi.
2. **Recuperação que avança sob falhas.** Reagendar verificações após erro/timeout auxiliar quando o banco permite registrar o resultado; respeitar cooldown da controladora para preparação não enviada. Manter um único envio possível e deadlines imutáveis.
3. **Espera SQL limitada por item.** Evitar que lock em participante da expiração consuma a execução de clientes independentes. Concluir operação/tentativa/sessão/auditoria atomicamente; não ignorar um participante locked e concluir parcialmente. Revalidar validade depois do último lock bloqueante.
4. **Detecção de falha efetiva.** Medir o trabalho devido mais antigo sem progresso, início/fim de execução, falha HTTP do dispatcher e crescimento de `expired_unconfirmed`. Despachos novos não apagam a idade da falha. Definir alerta antes do esgotamento da janela de 120 s.
5. **Retomada do navegador.** Eventos automáticos de retorno respeitam offline/visibilidade e não ocupam a única requisição durante uma desconexão. Repetir o cenário em captive browsers físicos, além do teste jsdom.
6. **Publicação verificável.** Tornar os 17 testes aprovados sem remover as invariantes; completar o gate formal e publicar o frontend com SHA verificável. A indisponibilidade de Docker e o requisito preexistente de proteção contra senhas vazadas no Auth continuam pendências documentadas do gate completo.
7. **Medição operacional e campo.** Registrar denominador, tempo e causa por visita válida; testar iPhone/Android reais em Povoão com dados móveis desligados e verificar tráfego externo ao ambiente liberado pelo captive portal. Só então avaliar a meta com uma janela operacional definida.

## Como medir a meta sem ocultar falhas

Proposta de indicador principal: visitas válidas liberadas em até 120 s / total de visitas válidas, em janela móvel de 30 dias, com inspeção diária. O relógio começa na primeira submissão válida; retries e troca de capability não o reiniciam. Rejeições legítimas de política (identidade inválida, bloqueio ou quota) devem ter motivo separado. Indisponibilidade de dependência não deve simplesmente desaparecer do denominador.

É necessário registrar tentativas válidas que falham **antes do join**, deduplicar reentradas da mesma visita sem apagar seu atraso, e separar: comando aceito, confirmação de MAC exata, sucesso exibido e conectividade externa observada. Hoje a confirmação do banco não comprova as últimas duas etapas.

Os 120 s são o objetivo de atendimento desde a submissão válida. Não devem ser usados para interromper cegamente uma recuperação segura já em andamento: uma confirmação posterior continua verdadeira, mas entra como atraso no indicador. O prazo interno atual da operação e a meta da visita têm origens distintas e precisam ser medidos separadamente.

Como referência matemática: com zero falhas, seriam necessárias **2.995 observações independentes e representativas** para que o limite unilateral de 95% para a taxa de falha ficasse em 0,1% ou menos (`n = ceil(log(0,05) / log(0,999))`). Isso pressupõe taxa estável e independência; redes sofrem falhas correlacionadas. Milhares de repetições do mesmo mock não atendem essas premissas, e essa conta não substitui o acompanhamento operacional.

Existe ainda uma janela arquitetural entre o commit da intenção e o POST: se o worker morre ali, a recuperação segura não consegue distinguir ausência de envio de um envio cuja resposta se perdeu. O teste preserva a segurança e encerra sem confirmação. Reduzir esse risco exige avaliar idempotência durável e resultado consultável na fronteira do proxy/controlador, sem prometer atomicidade externa inexistente.

## Relatórios técnicos

- [Banco e transações](auditoria2-database.md).
- [Admissão e transporte UniFi](auditoria2-backend.md).
- [Coordenador, capacidade e prontidão](auditoria2-coordenador.md).
- [Frontend e retomada](auditoria2-frontend.md).

O estado atual é **auditoria reprovada para declarar o objetivo de confiabilidade atendido**. Os resultados não demonstram clientes reais novos prejudicados; demonstram condições reproduzíveis que precisam de correção e medição antes dessa declaração.
