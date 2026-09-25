# Testes sintéticos adicionais do backend — 25/09/2026

> **Atualização:** os achados abaixo são o diagnóstico histórico anterior à correção. Os 18 grupos foram corrigidos; a validação atual passou com 303 testes automatizados e dois fluxos de navegador. Backend v254 e migration corretiva implantados; frontend ainda pendente. Veja [correção e evidências atuais](correcao-sinteticos-povao-2026-09-25.md).

Fonte da aplicação: `1b2eefbb3ab9108c4ca46fdea86626c6f81dc942`, correspondente à implementação da Edge Function v253. Esta rodada altera somente testes e documentação. Nenhuma requisição foi enviada a uma controladora real.

## Método

Foram ampliados os testes em `supabase/functions/_shared/durable-handlers.test.ts`. Eles extraem por AST as funções reais de `index.ts`, usam o coordenador real e o validador real das respostas do frontend. Banco/Auth/HTTP são dependências simuladas; seus resultados seguem o formato das RPCs publicadas. Os 14 casos anteriores passaram; os seis novos reproduziram três classes de problema.

```powershell
npx vitest run supabase/functions/_shared/durable-handlers.test.ts --reporter=verbose
```

## SYN-B01 — consulta auxiliar de login pode segurar uma confirmação já obtida

**Reprodução:** `get_captive_auth_operation` retorna `confirmed`, com sessão e usuário válidos. Somente a chamada seguinte, `claim_captive_auth_challenge`, fica sem resposta. Após avançar dois segundos de relógio sintético, o handler ainda não respondeu; o criador do token nem foi chamado.

**Causa:** `claimPortalSessionChallenge` espera a RPC sem prazo. O limite de 1,5 s é aplicado apenas na etapa posterior de criação do token. Isso deixa parte do login auxiliar no caminho obrigatório da resposta de Wi-Fi.

**Impacto:** a autorização pode estar correta no banco/controladora, mas o navegador receber timeout e continuar consultando. O teste não afirma que uma Promise JavaScript possa permanecer ativa além dos limites do serviço hospedado; demonstra que a aplicação não cumpre seu próprio orçamento para essa dependência opcional.

**Correção proposta:** aplicar um único prazo a toda a etapa auxiliar, desde o claim, retornando o estado confirmado mesmo se essa etapa falhar. Evitar criar token depois de abandonar a etapa; conservar a emissão única e a confirmação da rede. Prioridade sugerida: **P1**.

## SYN-B02 — falha comprovadamente anterior ao comando perde a recuperação de preparação

**Reprodução:** o join e o claim funcionam. A consulta de `user_roles` ou de `store_access_points` retorna erro transitório. Em ambos os casos o adaptador de comando tem zero chamadas, e não há nenhuma chamada a `record_captive_auth_operation` para registrar `not_sent`.

**Causa:** `runAuthorizationWorker` lança a exceção na preparação. O catch externo do coordenador conserva a intenção em `sending`, como se o comando pudesse ter sido enviado. Após vencer a lease, só restam verificações; o sistema não tenta preparar o envio novamente.

**Impacto:** um cliente ainda não autorizado pode esperar até a expiração sem que seu comando tenha sido enviado, mesmo se a consulta voltar a funcionar. Uma falha global que também impeça gravar `not_sent` precisa continuar conservadora; este caso isola a falha de leitura enquanto a RPC de registro está disponível.

**Correção proposta:** delimitar explicitamente a preparação anterior à invocação do adaptador e devolver resultado comprovadamente não enviado nesse trecho, respeitando as três preparações e o prazo original. Exceções após iniciar o POST continuam ambíguas e não autorizam reenvio. Prioridade sugerida: **P1**.

## SYN-B03 — a resposta inicial não classifica todos os resultados de leitura

**Reprodução:** após join, a leitura devolve `state_inconsistent`, `receipt_stale` ou `invalid_capability`. Nos três casos `authorizeDurably` retorna um objeto com `authorized:false`, `processing:false`, sem status e sem motivo. O caminho de identificação o serializa como HTTP 200; o validador do frontend rejeita esse corpo como inválido.

**Causa:** o caminho inicial trata apenas `capability_expired` depois de reler. O endpoint de status já possui classificação dos demais casos, mas essa classificação não é compartilhada com a resposta inicial.

**Impacto:** a pessoa pode receber recuperação genérica de erro de comunicação em vez da instrução correta de reidentificação ou falha transitória. Não é uma liberação falsa: `authorized` permanece falso. `state_inconsistent` e token inválido foram injetados como respostas da RPC; o teste não demonstra um caminho externo que consiga fabricar esses estados. A expiração de um recibo durante espera de lock foi reproduzida separadamente no PostgreSQL.

**Correção proposta:** compartilhar a interpretação dos resultados entre identificação e status, com resposta explícita e coerente, incluindo 401/410/503 quando apropriado. Prioridade sugerida: **P2**.

## Carga de recuperação sem navegador

`supabase/functions/_shared/durable-load.synthetic.test.ts` executa o coordenador real contra um modelo determinístico das regras SQL de ordenação, lease e watchdog. Os comandos começam já aceitos, a controladora simulada sempre confirma o MAC exato e não há consultas do navegador. Um worker processa quatro operações a cada dez segundos.

| Operações simultâneas | Confirmadas | Expiradas sem confirmação |
| ---: | ---: | ---: |
| 1 | 1 | 0 |
| 4 | 4 | 0 |
| 20 | 20 | 0 |
| 32 | 32 | 0 |
| 36 | 36 | 0 |
| 40 | 36 | 4 |
| 48 | 36 | 12 |
| 80 | 36 | 44 |

São oito testes: cinco aprovados e três reprovados. Não houve POST de autorização em nenhuma dessas simulações. No tick de 100 s, a lease dos próximos quatro itens termina em 110 s; sobram dez segundos, abaixo dos 16 s exigidos pelo coordenador, que nem realiza a leitura. O watchdog encerra os demais.

O modelo foi conferido por uma reprodução com as RPCs reais em PostgreSQL nativo: o caso de 40 comandos já aceitos também resultou em 36 confirmações e quatro expirações. O relatório `synthetic-database-findings.md` contém os detalhes e a variante de fila ainda não enviada. Não se trata de um benchmark de rede nem de um limite universal: consultas do navegador, fase do cron, latência e concorrência externa mudam o resultado.

**Correção proposta:** dimensionar a recuperação pelo orçamento disponível, priorizar confirmação de comandos enviados e evitar que uma fila de envios consuma toda a janela dos itens anteriores. Avaliar consultas compartilhadas por controladora, novos passes limitados por tempo e cadência/capacidade, mantendo a exclusão de envio e carga controlada. O limiar de aceite precisa incluir rajadas sem depender do navegador.
