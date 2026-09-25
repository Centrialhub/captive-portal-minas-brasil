**Diagnóstico e plano de confiabilidade do beta Povoão — 25/09/2026**

O principal defeito comprovado está na coordenação entre confirmação, repetição e bloqueio de concorrência. Uma liberação aceita pelo UniFi pode ser encerrada pelo próprio portal antes de completar 15 segundos. Há também sessões que continuam pendentes apenas porque o caminho de reutilização de uma autorização não atualiza o registro da sessão. A ausência inicial do dispositivo na consulta da controladora permanece uma questão de rede/integração a validar no equipamento real.

O beta atende somente Povoão. A ausência de tráfego nas demais lojas é esperada; `drive` e `joao23` têm problemas externos informados pelo responsável e estão fora deste plano.

**Base da investigação**

Foram consultados o banco e os logs de produção, a fonte efetivamente publicada da Edge Function v252, o JavaScript público do portal e as definições SQL reais das RPCs, triggers e constraints. A janela de comparação foi fixada em **18/09/2026 12:40 até 25/09/2026 12:40, horário de Brasília**, para evitar contagens móveis durante o diagnóstico. A inspeção foi somente leitura em produção.

O frontend publicado informa commit `90b0767af59b9490fb3191601ac2796886ee72c2`, build de 17/09. A função v252 foi publicada em 16/09. A fonte local contém alterações posteriores de limite diário que não estão na função publicada; essas alterações não explicam os incidentes observados.

| Resultado observado | Sessões | Interpretação correta |
|---|---:|---|
| Sessão autorizada com confirmação UniFi | 71 | Há evidência da controladora; não equivale a teste de navegação no aparelho |
| Comando aceito, confirmação pendente, tentativa encerrada por `RATE_LIMIT_HIT` | 35 | Recuperação transformada em falha terminal pela aplicação |
| Comando aceito, confirmação pendente, tentativa em `callback_received` | 5 | Recuperação interrompida e sem conclusão automática |
| Sessão pendente, tentativa autorizada, sem novo comando | 17 | Reutilização de autorização anterior sem atualizar a sessão atual |
| Sessão pendente, tentativa encerrada por `RATE_LIMIT_HIT`, sem comando próprio | 7 | Concorrência/repetição tratada como falha terminal |
| **Total** | **135** | Sessões e tentativas repetidas não são clientes únicos |

Das 40 sessões com comando aceito e confirmação pendente, 18 têm uma liberação confirmada posterior para a mesma MAC/loja; 22 não têm. Entre as 18, o menor intervalo até a confirmação posterior foi 16,18 s e a mediana foi 26,07 s; 16 mantiveram o mesmo AP e 14 o mesmo trace. Isso comprova recuperação posterior em parte dos casos, mas não permite concluir se o primeiro comando já havia liberado a internet.

**1. Causa comprovada: a recuperação colide com a própria trava de 15 segundos**

A sequência real é:

1. O backend consome `rate_limit_hit` para loja+MAC: uma chamada em 15 s.
2. O UniFi aceita `authorize-guest`.
3. O backend faz quatro consultas de confirmação. As esperas somam 2,7 s, além da rede; a quarta entrada de 2,5 s no vetor de backoff não é usada.
4. A MAC não aparece em `/stat/sta`; a sessão fica `UNIFI_CONFIRMATION_PENDING` e o backend expira a lease imediatamente.
5. O navegador repete o POST após 1 s. A recuperação consulta a controladora, interpreta MAC ausente como `not_authorized` e libera novo envio, passando a tentativa para `callback_received`.
6. O navegador repete novamente após 1 s. O bloqueio de 15 s ainda está ativo; o backend retorna `RATE_LIMIT_HIT`.
7. O chamador grava a tentativa como `failed`. O navegador considera o resultado definitivo e perde a capacidade normal de acompanhar essa tentativa.
8. A sessão continua `submitted`, porque essa saída e a RPC de finalização não atualizam seu estado.

**As 35 ocorrências têm `authorization_attempts=2` e terminaram entre 7,36 e 11,93 segundos após o aceite do comando**, com mediana de 7,886 s. A assinatura é consistente em todos esses casos.

Uma ocorrência de 25/09, sessão abreviada `31f27a2b`, foi reconstruída nos logs:

| Horário de Brasília | Evento |
|---|---|
| 08:18:26.706 | Cliente ausente na lista; usado o fallback para a MAC recebida pelo portal |
| 08:18:26.783 | UniFi aceita o comando |
| 08:18:26.945–08:18:30.116 | Quatro consultas sem localizar o cliente |
| 08:18:32.002 | Recuperação iniciada |
| 08:18:32.701 | Nova tentativa liberada pela recuperação |
| 08:18:34.633 | A própria trava de concorrência impede a nova autorização |
| 08:18:34.668 | Tentativa finalizada como `failed/RATE_LIMIT_HIT` |

A falha foi reproduzida em memória usando os corpos exatos das funções publicadas, relógio controlado e dependências simuladas: três chamadas, um comando UniFi, tentativa `failed`, sessão `submitted/pending`.

Correção necessária: espera por concorrência deve retornar estado pendente e prazo de nova consulta; não pode finalizar a tentativa. Ausência de estação depois de comando aceito é resultado inconclusivo, não prova de rejeição. A consulta de confirmação não deve voltar ao caminho de envio nem consumir sua quota. Aumentar apenas o atraso do navegador ou remover a trava não resolve esse contrato.

**2. Causa comprovada: reaproveitamento de sucesso deixa o painel incorreto**

Quando encontra autorização da mesma loja/MAC nos últimos 30 s, `authorizeClient` retorna `ok:true` antes de atualizar a sessão e inserir auditoria. Em seguida, `finalize_auth_attempt` atualiza somente a tentativa.

Nas **17 sessões com tentativa autorizada e sessão pendente**, existe exatamente uma autorização anterior confirmada dentro desses 30 s para a mesma loja/MAC. A reprodução local confirmou retorno de sucesso com zero gravações de sessão/auditoria. Esses 17 registros não devem ser classificados automaticamente como pessoas sem acesso.

O conserto deve registrar reutilização explicitamente, vinculando a sessão à autorização anterior e à sua validade. Não deve inventar um comando ou uma confirmação nova. Operação, tentativa, sessão e evento de conclusão precisam mudar na mesma transação.

**3. Causa comprovada: a continuidade depende do navegador**

Não existe reconciliador de autorização independente das chamadas do cliente. As cinco tentativas em `callback_received`, com comando aceito e prazo vencido, ficam sem conclusão. Há também duas tentativas antigas `authorizing` expiradas. `cron.job` estava vazio e não foram encontrados logs de conclusão do cron nas 24 h consultadas. Isso não exclui um agendador externo não observado, mas não há evidência de recuperação automática efetiva.

Ativar a limpeza atual não basta: `expire_stale_auth_attempts` só cobre `authorizing`; deixa `callback_received` e outros estados vencidos de fora e não consulta a controladora antes de encerrar um comando incerto.

No primeiro acesso, a sessão Supabase só é criada depois da liberação. O botão “Verificar novamente” recarrega a página; sem sessão Supabase, ela volta ao formulário vazio em vez de acompanhar a tentativa cuja identidade já foi validada.

**4. Outros defeitos confirmados no código, sem atribuir incidência não medida**

| Defeito | Consequência | Correção planejada |
|---|---|---|
| Timeout/rede no `identify` apaga o attempt; HTTP 200 inválido pode virar `null` | A resposta pode ter se perdido depois de um comando aplicado; novo clique cria outra tentativa | Preservar capability em resultado desconhecido; validar resposta e consultar estado |
| `verifyOtp` é aguardado antes de mostrar a liberação | Acesso confirmado pode parecer erro por falha auxiliar na sessão persistente | Exibir estado da rede; persistência de login separada, com prazo e telemetria |
| Sucesso apaga o attempt e redireciona em 2 s; reabertura inicia silent com novo attempt | Repetições e possível retorno contínuo ao portal | Guardar recibo de conclusão, consultar autorização atual e limitar redirecionamento por visita |
| `sessionStorage` sem tolerância a falha e attempt sem contexto/expiração | Falha de armazenamento impede iniciar; mudança de visita pode reutilizar contexto antigo | Registro versionado, fallback em memória, inicialização única e validação de contexto |
| Writes críticos ignoram `{error}` e número de linhas | Backend pode devolver sucesso com gravação incompleta | RPC transacional; verificar erro e resultado canônico em todos os caminhos |
| Timeout do POST UniFi vira `UNIFI_CMD_REJECTED` | Wrapper pode reenviar um comando cujo efeito é desconhecido | Classificar separadamente rejeição explícita, aceite e envio de resultado desconhecido |
| Timeout é cancelado antes da leitura do corpo; lease tem 30 s | Corpo lento pode prolongar trabalho e permitir recuperação concorrente | Orçamento completo da requisição, lease renovável e versão de posse |
| Pending não persiste MAC efetivamente comandada | Recuperação pode consultar outra MAC | Persistir identidade exata e intenção antes do envio; reutilizá-las em toda confirmação |
| Remapeamento permite escolher outra estação por ser a única candidata | Pode associar a identidade da pessoa a outro equipamento | Remover inferência por exclusividade circunstancial; exigir vínculo verificável |
| `/stat/sta` não valida totalmente schema/`meta.rc`; recovery usa truthiness | Resposta anômala pode ser interpretada como ausência ou sucesso | Adaptador UniFi com contrato estrito e booleano exato |
| Eventos do navegador não são emitidos; campos do funil não são preenchidos | Painel não distingue erro visual, abandono, fechamento do captive e acesso real | Eventos mínimos por fase e invariantes automáticas |
| Inicialização admite só 5 chamadas por MAC/60 s; erro 429 perde prazo e mensagem no cliente | Reentradas podem impedir abrir nova tentativa e apresentar erro genérico | Deduplicar inicialização; transmitir motivo/Retry-After; testar janela e bloqueio de abuso separadamente |

Há uma sequência real com o mesmo trace: identificação confirmada às 10:08:22, três reaproveitamentos silent em torno de 10:08:27/31/34 e outro comando confirmado às 10:08:39. Logo depois ocorreram dois HTTP 429 em `/attempt/init`, às 10:08:42 e 10:08:52. A relação temporal reforça a necessidade de controlar reentrada; os logs disponíveis não provam a causa física da volta ao portal nem vinculam os 429, sozinhos, a uma pessoa específica.

O limitador configura bloqueio de 300 s, mas sua RPC limpa `blocked_until` ao vencer a janela de 60 s; a duração efetiva não deve ser apresentada como cinco minutos sem corrigir e testar esse contrato. Esses HTTP 429 são diferentes do resultado de negócio `RATE_LIMIT_HIT`, devolvido como HTTP 200. Nas últimas 24 h, 15 eventos `identity_failed` se dividem em 5 `PROCESSING_IN_PROGRESS`, 5 `RETRY_REQUIRED` e 5 `RATE_LIMIT_HIT`; o painel está contando verificações intermediárias como falhas de identificação. As métricas novas precisam deduplicar por operação e distinguir progresso de desfecho.

As RPCs publicadas também não impõem todos os contratos necessários: finalização não exige lease ainda vigente, estado `authorizing` ou contexto de sessão coerente; não há trigger que sincronize os estados. Expiração é checada antes de consultar uma tentativa já concluída. Essas lacunas foram verificadas em catálogos, mas não são tratadas como prova de que todos esses caminhos ocorreram.

**5. O que falta esclarecer na integração UniFi**

Todas as 40 confirmações pendentes registraram cliente não encontrado, não `authorized=false`. Os snapshots tinham centenas de estações; nos exemplos examinados, 206–407. As 40 sessões distribuem-se pelos oito APs cadastrados, todos vinculados corretamente ao Povoão. As MACs estavam em formato canônico e os timestamps do portal tinham aproximadamente 57–111 s no envio, sem URL antiga de horas/dias.

Foram 32 ocorrências em iPhone, 3 em Android, 4 em Windows e 1 sem plataforma identificável. A participação de iPhone é maior, mas há casos nas três plataformas; não há base para atribuir a causa exclusivamente à Apple ou à MAC privada.

As hipóteses abertas são: atraso/semântica da lista de estações; MAC da URL diferente da associação ativa; alteração de associação durante o fluxo; formato de `ap_mac` no fallback; diferença entre a visão da controladora e o estado aplicado pelo AP. A fonte usa AP com separadores quando vem da estação e sem separadores no fallback; a compatibilidade precisa ser testada, não presumida.

Para fechar essa parte, executar um teste acompanhado em Povoão, com dados móveis desligados, registrando de forma correlacionada: versão da controladora/AP, associação real, MAC da URL, MAC/clientId observado, AP/site/SSID, payload sanitizado enviado, resposta e leitura exata do cliente em 0/1/3/5/10/20/40/60 s. Conferir também a sincronização dos relógios antes de usar `assoc_time` como evidência. Comparar navegação externa que não pertença à lista de destinos permitidos antes da autenticação. Verificar se o cliente tinha acesso apesar da ausência em `/stat/sta`.

O uso de leitura por cliente exato deve seguir a versão instalada. A [documentação oficial da Ubiquiti](https://help.ui.com/hc/en-us/articles/31228198640023-External-Hotspot-API-for-Authorization-Clients) descreve resolução por MAC para `clientId` e consulta posterior do estado de autorização. A adoção dessa API depende da compatibilidade da controladora; não é proposta uma troca cega do endpoint legado.

**Plano de correção em seis entregas**

1. **Fixar a base reproduzível e os testes de falha.** Recuperar do histórico canônico a migration ausente que quebra `check:migrations`; alinhar fonte, bundle, Edge Function e banco em um manifesto de versão. Usar Deno fixado no ambiente de validação. Transformar as reproduções do defeito em testes de comportamento esperado, usando banco de teste para os contratos reais. Saída: build e migrations reproduzíveis, regressão atual demonstrada, fixture de cliente/controladora sem dados reais.

2. **Implementar uma operação persistente de autorização.** Adicionar tabela privada/restrita de operações e RPCs, preservando compatibilidade com sessões e clientes já abertos. Chave de exclusão por loja/controladora/site/MAC, com contexto de associação verificado; múltiplos attempts elegíveis acompanham o mesmo resultado. A participação exige identidade validada, contexto compatível e aprovação das regras de acesso/bloqueio; mera igualdade de MAC não concede acesso ao resultado. Tentativas canceladas, não identificadas ou vencidas antes de participar não são promovidas por associação. Persistir intenção, identidade comandada, parâmetros, número de envios/verificações, evidência, prazo, `next_check_at`, dono e versão da lease. Separar os estados `queued`, `sending`, `verifying`, `confirmed`, `rejected` e `expired_unconfirmed`. Estado incerto não vira sucesso nem rejeição inventada.

3. **Corrigir o adaptador UniFi e a finalização.** Retirar o contador de abuso do papel de mutex. Comando aceito/timeout incerto passa a confirmação; ausência temporária não autoriza reenvio. Nova tentativa de envio só ocorre segundo política explícita, após consulta conclusiva e dentro de limite persistido. Canonicalizar MAC/AP, validar respostas e preservar MAC efetiva. RPC única atualiza operação, tentativa, sessão e evento, exige contexto/lease/versão válidos e devolve o estado canônico. Reuso aponta para evidência anterior e validade. Escrita tardia de worker antigo não regride estado.

4. **Garantir recuperação sem navegador.** Criar outbox em tabela durável do Postgres: intenção, transição e agendamento entram na mesma transação, deduplicados por operação. Worker imediato e periódico adquirem trabalho pela mesma RPC/lease. Usar as extensões já instaladas (`pg_cron` 1.6.4 e `pg_net` 0.19.5) para despertar o worker em lotes limitados, com cadência inicial proposta de 10 s, a validar em homologação e contra carga da controladora. `pg_net` é transporte; a fonte durável do trabalho é a tabela da aplicação. Acordar worker só quando houver trabalho devido. Expiração da capability impede novas ações não autenticadas, mas não cancela comando enviado; expiração da lease permite troca de worker, com renovação limitada e fencing. Proposta inicial: prazo de verificação de 90 s contado do primeiro envio e imutável nos retries, mais tolerância operacional inicial de até 30 s para fila/chamada final/classificação. Se a última leitura falhar, encerrar `expired_unconfirmed` com causa explícita e alerta, sem esperar indefinidamente por uma consulta bem-sucedida. Validar esses orçamentos no teste de campo. `waitUntil` pode acelerar o caso comum, mas não será o único mecanismo: suas tarefas continuam sujeitas aos [limites da Edge Function](https://supabase.com/docs/guides/functions/background-tasks). O banco mantém o trabalho para sobreviver à queda do worker.

5. **Fazer o navegador acompanhar a mesma operação.** Novo contrato de status autenticado pela capability, sem tokens em URL e sem revalidar CPF a cada consulta. Resposta pendente contém `retry_after_ms`, prazo e ID estável. Consultar no retorno da rede/janela e no botão de verificação. Preservar resultado incerto em timeout/abort/5xx/JSON inválido; impedir nova inicialização simultânea. Dar deadline ao `getSession`/refresh inicial: se ficar pendurado, apresentar identificação e impedir que sua resposta tardia inicie silent concorrente. Mostrar Wi-Fi confirmado imediatamente; guardar recibo quando possível e dar somente uma janela curta e limitada à persistência de login antes da navegação. Timeout/erro de `verifyOtp` não regride o sucesso nem mantém a tela travada. Guardar recibo por visita e confirmar no servidor antes de reutilizar; não usar cache local como prova de acesso. Conter repetição automática do redirect. Se uma nova janela perdeu capability, usar sessão autenticada válida para recuperar leitura; sem nenhuma credencial, pedir identificação novamente e anexar a operação compatível existente, sem novo comando. Nunca recuperar só pela MAC fornecida pelo navegador. Fallback em memória protege o carregamento atual, não sobrevive ao fechamento da janela. Após vencer a capability, a leitura de resultado exige nova autorização adequada e não reabre execução.

6. **Reconciliar histórico e operar com indicadores confiáveis.** Corrigir registros somente quando houver evidência, em lotes auditáveis. Nos 17 reaproveitamentos, associar a evidência anterior após validar identidade, escopo e tempo; não inventar novo comando. Registros antigos inconclusivos ficam classificados como legado sem confirmação; não se enviam comandos antigos a clientes que podem ter saído. Medir tentativa válida, comando, confirmação, reuso, recuperação, sucesso exibido, redirecionamento iniciado e teste de conectividade como eventos diferentes. Alertar divergências, operação parada, worker sem execução e aumento de `expired_unconfirmed`.

O desenho não promete exatamente uma execução externa numa falha entre UniFi e banco sem suporte de idempotência na controladora. Ele exige exclusão por dispositivo, registro de intenção, ausência de reenvio cego e reconciliação verificável do resultado.

**Gates de aceite antes e durante o beta**

| Cenário | Resultado exigido |
|---|---|
| Cliente só aparece 20–60 s depois do aceite | A mesma operação confirma; nenhum `RATE_LIMIT_HIT` terminal; sem comando repetido por polling |
| Duas abas/20 chamadas idênticas e attempts distintos para a mesma visita | Uma operação ativa; participantes recebem o mesmo resultado; nenhum cliente incorreto liberado |
| Resposta de comando perdida, corpo travado ou worker encerrado após envio | Resultado `verifying/unknown`; leitura antes de decidir reenvio; retomada pelo worker |
| Falha de banco entre cada etapa e callback atrasado | Estado recuperável e coerente; worker sem posse não sobrescreve o atual |
| Reuso de autorização | Sessão/tentativa coerentes, evidência anterior referenciada, validade preservada |
| Reload/timeout com capability preservada | Retoma a operação sem novo CPF e sem novo comando |
| Nova janela sem capability e armazenamento negado | Operação segue no servidor; sessão autenticada ou nova identificação recupera resultado, sem confiar só na MAC nem duplicar comando |
| `getSession` não conclui ou conclui depois do deadline | Interface permite identificação; resposta tardia não cria silent concorrente |
| `verifyOtp` falha depois de confirmação | Wi-Fi continua apresentado como confirmado; falha auxiliar medida separadamente |
| Reentrada repetida e expiração da capability | Sem loop de comandos; contexto novo é validado; consulta de resultado não executa novo comando |
| Cliente ausente e outra MAC como única candidata | Nenhuma autorização de terceiro por inferência |
| Android, iOS e Windows em Povoão | Navegação externa verificada com dados móveis desligados e evidência correlacionada |

Metas iniciais propostas para o beta corrigido: zero falso sucesso sem evidência; zero contradição nova entre operação e participantes elegíveis segundo suas transições permitidas; zero falha terminal causada por mera concorrência; nenhuma operação ativa além do prazo+tolerância sem classificação/alerta; no mínimo 99% de confirmação entre pedidos válidos com cliente presente e infraestrutura disponível, com p95 de até 15 s e p99 de até 60 s. As exclusões devem ser publicadas no painel, nunca esconder indisponibilidades. Medir também taxa bruta e navegação real; um beta pequeno não sustenta uma alegação estatística de 99% sem amostra suficiente.

**Implantação e retorno seguro**

Aplicar primeiro a estrutura aditiva e os testes em homologação; publicar backend compatível com o frontend antigo, obrigando todos os caminhos (`identify`, silent e resume) a adquirir a mesma operação antes de qualquer envio; ligar métricas e worker; ativar o novo fluxo apenas para Povoão e executar a matriz de campo; publicar o cliente com polling/retomada; acompanhar ao menos um ciclo completo de sessão de 40 minutos e um período de maior movimento. Expandir somente após os gates e amostra operacional suficientes.

Rollback desativa novos envios pelo fluxo novo, preserva os dados e mantém um reconciliador versionado somente de consulta para operações já enviadas. Bloquear explicitamente envio legado para identidades com operação incerta; não apagar a fila nem devolver essas operações ao envio legado. Mudanças destrutivas de esquema e retirada de compatibilidade ficam para uma etapa posterior, com operações antigas encerradas e dados validados.

**Evidências e reprodução**

- [Análise do backend publicado](<F:/captive MB/tmp/diagnostico-povao-20260925/backend/diagnostico-backend.md>), incluindo fonte v252 e seis reproduções isoladas.
- [Análise do navegador público](<F:/captive MB/tmp/diagnostico-povao-20260925/frontend-review.md>), incluindo bundle e cinco reproduções isoladas.
- [Contratos reais do banco](<F:/captive MB/tmp/diagnostico-povao-20260925/database-review.md>), com snapshots de RPCs e catálogos.
- [Consultas principais de diagnóstico](<F:/captive MB/tmp/diagnostico-povao-20260925/queries-readonly.sql>).

As onze reproduções mostram os defeitos determinísticos sob dependências simuladas; não equivalem a teste do equipamento. A validação ampla anterior teve lint, TypeScript e 51 testes aprovados, mas o gate completo foi impedido pela migration ausente e a checagem Edge pela falta de Deno neste host. Nenhuma correção foi publicada nesta etapa de diagnóstico e planejamento.
