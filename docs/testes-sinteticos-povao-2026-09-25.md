# Testes sintéticos de confiabilidade — Povoão, 25/09/2026

## Conclusão

Foram acrescentados **73 testes**, exercitando concorrência, recuperação sem navegador, prazos, falhas transitórias, cookies, retomada da tela e relógio incorreto. O conjunto atual tem **243 testes: 213 aprovados e 30 reprovados**. As reprovações correspondem a **18 grupos de problemas**; alguns são falhas latentes ou dependem de condições específicas. Os **170 testes anteriores continuam aprovados**.

Os novos testes demonstram lacunas de confiabilidade na implementação examinada. **A validação para publicação está reprovada.** A próxima correção deve resolver os casos prioritários e repetir a bateria antes de publicar o frontend ou ampliar o beta. As asserções permanecem ativas, sem `skip` ou marcação de falha esperada.

Esta rodada acrescentou somente testes e documentação. Não alterou aplicação, migrations, configuração de produção ou registros de clientes. A base examinada é `1b2eefbb3ab9108c4ca46fdea86626c6f81dc942`, correspondente ao backend v253 publicado na etapa anterior. Nenhum comando chegou a uma controladora real. `drive` e `joao23` continuam fora do escopo.

## Resultado reproduzível

| Suíte | Total | Aprovados | Reprovados |
| --- | ---: | ---: | ---: |
| Aplicação: React, handlers, coordenador e adaptador UniFi | 199 | 177 | 22 |
| PostgreSQL nativo 17.10, com RPCs e triggers reais | 44 | 36 | 8 |
| **Total** | **243** | **213** | **30** |

Dos 73 testes novos, 43 passaram e 30 falharam. ESLint e TypeScript passaram. Os testes PostgreSQL foram repetidos pelo agente principal em um novo banco local e reproduziram as mesmas oito falhas. Os resultados resumidos, nomes das asserções reprovadas e observações de carga estão em `synthetic-results-2026-09-25.json`.

```powershell
Set-Location 'F:\captive MB\tmp\reliability-release-20260925'
npx vitest run --reporter=json --outputFile=tmp/synthetic-application-results.json
npm test --prefix tests/database
npm run lint
npm run typecheck
```

As duas suítes de testes atualmente retornam código 1. O runner PostgreSQL registra todas as falhas adversariais e encerra o próprio servidor mesmo nesse resultado. A infraestrutura é local, restrita a `127.0.0.1:55439`, com dados sintéticos e sem ler credenciais de produção. Extensões hospedadas Vault/cron/pg_net são representadas por stubs; o agendamento hospedado não foi medido nesta rodada.

## Achados prioritários

### 1. Recuperação sem navegador perde confirmações em rajadas

Teste com quatro operações por tick de dez segundos, controlador simulado sempre disponível e nenhuma consulta do navegador:

| Condição inicial | Envios aceitos | Leituras de confirmação | Confirmadas | Expiradas sem confirmação |
| --- | ---: | ---: | ---: | ---: |
| 4 operações em fila | 4 | 4 | 4 | 0 |
| 40 operações em fila, sem execução inicial nas requisições | 40 | 0 | 0 | 40 |
| 40 operações já com comando aceito | 40 | 36 | 36 | 4 |

No primeiro cenário de 40, envios ainda em fila ocupam os lotes antes das verificações. Quando chega a vez de verificar, o tempo restante é inferior ao mínimo de 16 segundos aceito pelo coordenador. No segundo, a capacidade de leitura ainda deixa quatro operações fora da janela. Um modelo separado, usando o coordenador real, reproduziu os mesmos 36/4 e ampliou a matriz até 80 operações.

**Isso comprova perda de confirmação nessas condições; não comprova 40 clientes reais sem internet.** O teste não mede o tamanho das rajadas atuais de Povoão. Priorizar verificações por prazo e dimensionar capacidade/admissão são partes necessárias da correção. Apenas aumentar um timeout desloca o limite.

### 2. Erro de preparação pode deixar o cliente sem nenhum comando

Erros transitórios na leitura de permissões ou APs acontecem antes de chamar o adaptador. Mesmo com a gravação disponível, não são registrados como comprovadamente não enviados. A operação fica em `sending` e depois só verifica um comando que nunca foi emitido. Esse caminho precisa preservar a tentativa limitada de preparação quando houver prova de que nenhum POST começou.

### 3. Resposta tardia pode perder o registro do aceite

Um envio obtém a lease antes do prazo; sua resposta chega após o deadline, ainda dentro da lease. O finalizador muda a operação para terminal e tenta atualizar a telemetria dos participantes ainda ativos. O guard rejeita com `AUTH_OPERATION_STATE_MANAGED`, revertendo a transação. Isso ocorre tanto com `accepted` quanto com `unknown` e `command_sent=true`. Separadamente, um retry comprovadamente não enviado ainda consegue obter ação `send` depois do deadline.

### 4. Etapa opcional pode segurar a resposta de Wi-Fi confirmado

A RPC que reserva o login auxiliar fica fora do limite de 1,5 segundo aplicado à criação do token. Se essa RPC demora, o handler não devolve a confirmação já obtida. O orçamento precisa abranger toda a etapa auxiliar.

## Inventário completo

As prioridades expressam impacto técnico, não frequência observada em produção. Detalhes, código examinado, reprodução e propostas estão nos quatro relatórios associados.

| Grupo | Problema reproduzido | Condição ou limite relevante |
| --- | --- | --- |
| DB-SYN-01 | Capacidade insuficiente de recuperação | Rajada sem navegador; inclui os testes do modelo do coordenador |
| DB-SYN-02 | Join usa validade anterior à espera por lock | Dois casos: recibo e capability; leitura pública posterior fornece outra proteção |
| DB-SYN-03 | Renovação aceita lease vencida durante lock | RPC ainda não chamada pelo coordenador atual; falha latente |
| DB-SYN-04 | Novo envio pode ser obtido após o deadline | Retry conhecido como não enviado, ainda dentro da tolerância posterior |
| DB-SYN-05 | Falha em um item bloqueia claims de outros | Erro de auditoria deliberadamente injetado em uma operação |
| DB-SYN-06 | Resposta tardia conflita com o guard e reverte aceite | Resposta dentro de lease válida e fora do prazo de verificação |
| SYN-B01 | Claim auxiliar de login sem orçamento | RPC simulada sem resposta, Wi-Fi já confirmado |
| SYN-B02 | Falha anterior ao comando perde retry seguro | Leitura falha; RPC de registro continua disponível |
| SYN-B03 | Resposta inicial não classifica todas as disposições | Três respostas da RPC viram HTTP 200 incompatível com o validador |
| SYN-U1 | Resposta após prazo absoluto ainda aceita | Relógio avança antes de o callback do timer executar |
| SYN-U2 | Login redirecionado/rejeitado aceito com cookie | Não demonstra autorização indevida; há checagens posteriores |
| SYN-U3 | Rotação de cookies/CSRF perdida antes do comando | Depende de rotação pelo controlador/proxy; não observada em produção |
| SYN-U4 | Cookie com expiração imediata permanece no jar | Atributos válidos `Max-Age=0` e `Expires` no passado |
| SYN-F01 | Retomada fica presa com StrictMode | `main.tsx` atual não usa StrictMode; falha latente |
| SYN-F02 | Relógio adiantado descarta confirmação válida | Relógio do aparelho vinte minutos à frente |
| SYN-F03 | Eventos repetidos geram consultas e adiam redirect | Dois testes: 21 consultas em 200 ms e reinício do timer de navegação |
| SYN-F04 | Remontagem perde cooldown de inicialização | Servidor ainda mantém seu rate limit; não é bypass de quota |
| SYN-F05 | Exceção ao navegar mantém botão desabilitado | `SecurityError` injetado; incidência em aparelhos não medida |

Relatórios detalhados:

- [Banco e carga](synthetic-database-findings.md): 16 testes novos, 8 falhas, 6 grupos.
- [Handlers e modelo de carga](synthetic-backend-findings.md): 14 testes novos, 9 falhas; 3 grupos de handlers e capacidade já contabilizada em DB-SYN-01.
- [Integração UniFi](synthetic-unifi-findings.md): 26 testes novos, 7 falhas, 4 grupos.
- [Frontend e recuperação](synthetic-frontend-findings.md): 17 testes novos, 6 falhas, 5 grupos.

## Ordem de correção e publicação

1. Corrigir perda de preparo, gravação de respostas tardias, veto de novo envio fora do orçamento e capacidade/ordem da recuperação. Manter a proibição de repetir um POST cujo efeito é incerto.
2. Limitar toda a etapa auxiliar, compartilhar a classificação de respostas e corrigir o ciclo de sessão UniFi. Isolar a falha de uma expiração sem comprometer a atomicidade daquela operação.
3. Revalidar tempo após locks e corrigir relógio, retomada e navegação no frontend. Resolver também os contratos latentes cobertos pelos testes.
4. Reexecutar todas as asserções, revisar a implementação e só então preparar a publicação. Correções SQL exigem migration nova; preservar as duas migrations já aplicadas. Complementar com teste físico iPhone/Android em Povoão e navegação externa com dados móveis desligados.

**Continua necessária nova implantação do frontend, depois das correções adicionais.** Os testes e relatórios desta rodada, por si só, não exigem deploy. O PR permanece em rascunho; a indicação anterior de frontend pronto para publicar fica substituída por este resultado reprovado. Backend v253 e banco já implantados não receberam mudanças nesta rodada.

## Revisão realizada

As quatro frentes foram revisadas, incluindo uma segunda revisão dos testes fora da autoria original. Asserções foram ajustadas para aceitar uma futura correção que capture a exceção de navegação e para aceitar erro de domínio ou resposta de falha estruturada no handler. Permanecem exigidas a recuperação do botão e a resposta explícita válida.

A revisão identificou um risco preexistente no próprio harness. Foi corrigido: cada conexão comprova o diretório real do PostgreSQL, seu PID e o processo criado pela execução antes de qualquer escrita. Em um teste controlado com outro cluster descartável ocupando a porta, o harness recusou a conexão com `HARNESS_CLUSTER_MISMATCH`; o log do outro banco mostrou somente `SHOW data_directory`. O outro servidor permaneceu ativo, com seu registro sentinela e catálogo inalterados, e foi encerrado separadamente pelo script que o criou. Essa verificação de isolamento é infraestrutura de teste e não está contada nos 18 grupos de problemas da aplicação.

Não foram relaxadas as condições de autorização nem transformadas as falhas em resultados aprovados. Nenhuma conclusão desta rodada substitui medição de incidência ou confirmação de acesso no aparelho real.
