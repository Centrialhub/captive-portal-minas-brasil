# Contrato de autorização durável no banco

Implementação: `supabase/migrations/20260925164858_durable_captive_auth_operations.sql`, aplicada em produção em 25/09/2026 às 16:49 UTC. O reparo histórico foi registrado como `20260925165002_reconcile_proven_legacy_authorization_reuse.sql`. Os nomes locais correspondem às versões registradas no banco remoto. Os testes estão em `tests/database` e executam PostgreSQL nativo 17.10 isolado, com conexões concorrentes reais.

## Estado e identidade

Uma operação representa a intenção de autorização de uma identidade de rede: loja/controladora/site/MAC. O banco mantém uma única operação ativa nessa chave. Joins são serializados por loja/MAC para também coordenar a quota diária. O mesmo usuário, AP e SSID podem retomar uma operação ativa com novo timestamp de visita. Mudança de AP também pode aderir enquanto a operação estiver ativa, somente quando ambos os APs estiverem cadastrados na mesma loja e o SSID explícito continuar igual; preservam-se o AP original da operação e o AP recebido por cada tentativa. Uma autorização já confirmada não é reutilizada através dessa exceção de roaming. Usuário ou associação incompatível não é anexado. A `association_key` original fica persistida como contexto, sem transformar o timestamp do navegador em uma prova de identidade.

Tentativa, sessão e participação são criadas/vinculadas na mesma transação. O token de retomada precisa corresponder ao hash SHA-256 da tentativa e estar válido. A identidade do usuário e as regras de bloqueio devem ter sido verificadas pelo backend antes do join. Um novo usuário não recebe o resultado de outra pessoa por mera igualdade de MAC.

Estados: `queued`, `sending`, `verifying`, `confirmed`, `rejected`, `expired_unconfirmed`. Uma tentativa participante usa `authorizing` durante trabalho e passa, junto com sua sessão, a `authorized` ou `failed` na conclusão. `expired_unconfirmed` é uma conclusão sem confirmação, não uma prova de que o comando foi desfeito ou de que o cliente ficou sem internet.

As tabelas de operação, participação, eventos, trabalho devido e configuração usam RLS, sem acesso de `anon`/`authenticated`; `service_role` lê e invoca RPCs, mas não grava diretamente essas tabelas. Funções internas não são executáveis pelo cliente nem por `service_role`. As RPCs fazem as gravações como `SECURITY DEFINER` com `search_path` vazio e nomes qualificados. Triggers impedem que workers legados alterem status, vínculo, identidade, evidência ou timestamps de autorização depois que uma sessão/tentativa passou a pertencer a uma operação. As RPCs usam um marcador transacional de escrita, restaurado ao sair; esse mecanismo coordena writers confiáveis e não pretende impedir um administrador SQL privilegiado.

## RPCs

| RPC | Entrada e resultado |
| --- | --- |
| `join_captive_auth_operation` | `p_attempt_id`, `p_user_id`, `p_store_id`, `p_controller_key`, `p_site_id`, `p_client_mac`, `p_ap_mac`, `p_association_key`, `p_redirect_url`; opcionais `p_command`, `p_resume_token`, `p_session_id`, `p_session`. Retorna `{disposition, operation, session_id}`. A sessão é criada atomicamente se não existir. |
| `get_captive_auth_operation` | `p_attempt_id`, `p_resume_token`. Retorna DTO plano com `operation_id`, `status`, `authorized`, `processing`, `session_id`, `user_id` interno, `redirect_url`, `fail_reason`, `retry_after_ms`, `deadline_at`, além de `operation` aninhada. O backend remove `user_id` da resposta pública. |
| `claim_captive_auth_operations` | `p_lease_owner`, `p_limit` de 1–20, `p_operation_id` opcional, `p_allow_send`. Retorna array de JSONs da operação, com `action=send|verify`, `state`, `deadline_at`, dono, versão e vencimento da lease. |
| `renew_captive_auth_operation_lease` | ID, dono e versão atuais. Retorna booleano; nunca estende além de `verification_deadline + 20s`. |
| `record_captive_auth_operation` | ID, dono, versão, `p_outcome`, evidência, erro, redirect, validade e retry. Retorna `{applied, disposition, operation}`. `applied=false` exige observar o estado retornado, não supor que o resultado pedido foi aceito. |
| `expire_captive_auth_operations` | Limite opcional. Encerra trabalho além do prazo+tolerância e propaga conclusão atomicamente. |
| `claim_captive_auth_challenge` | ID e capability. Retorna UUID do usuário uma única vez por tentativa confirmada e elegível, ou NULL. Verifica bloqueio, papel admin e validade do recibo; falha auxiliar não altera o Wi-Fi. |
| `authorize_captive_auth_worker` | Token secreto recebido no header interno. Retorna booleano, comparando seu hash com a configuração. |
| `finish_captive_auth_worker` | Número de falhas do lote. Retorna `void`; registra conclusão do worker para health/readiness. |
| `configure_captive_auth_worker` | Endpoint HTTPS do projeto, `p_enabled`, `p_sends_enabled`. Gera/rota segredo no Vault, salva só hash na configuração e cria/atualiza o job de 10 s. Retorna estado de configuração, nunca o token. |

`join` pode retornar `context_conflict`, `daily_limit` ou `unconfirmed_cooldown` sem operação anexada. Esses resultados não permitem polling de uma operação à qual a tentativa não pertence. `get` pode retornar `invalid_capability`, `capability_expired`, `awaiting_identity`, `receipt_stale` ou `state_inconsistent`; nenhum deles deve ser tratado como liberação. `awaiting_identity` inclui `status`, `authorized=false`, `processing=false` para o frontend voltar à identificação.

`p_session` só fornece os campos sanitizados usados pelo backend (`auth_method`, `trace_id`, `user_agent`, `client_ip`); MAC/AP/SSID e vínculo vêm da tentativa validada. `p_command.minutes` define `grant_seconds`; `max_daily_accesses` é aplicado sob lock. O começo do dia é calculado pelo banco em `America/Sao_Paulo`, não confiado ao valor enviado pelo chamador. Confirmar novamente sem novo envio não consome outro acesso. Operações ativas reservam capacidade da quota.

## Envio, evidência e recuperação

O claim de envio grava a intenção antes do HTTP. Se o worker morrer antes/depois do POST, a retomada recebe somente `verify`, pois não se sabe se o efeito ocorreu. Não existe repetição automática de POST após envio incerto. O prazo original não é renovado pelo polling ou troca de worker.

`record` aceita:

- `accepted`: somente em `sending` com `command_sent:true` booleano; persiste aceite e próximo trabalho de verificação.
- `unknown` e `pending`: mantêm verificação e causa observada. Não são sucesso nem rejeição.
- `confirmed`: exige `found:true`, `authorized:true`, MAC canônica correta, mesma controladora/site e `observed_at` recente. Com aceite conhecido, validade fica limitada ao primeiro envio + duração persistida. Sem aceite, somente `validity_basis=observed_only`, sem fabricar uma expiração de 40 minutos.
- `rejected`: exige rejeição explícita booleana e erro definido; não aceita rejeição depois de comando aceito.
- `not_sent`: somente em `sending`, lease atual, sem aceite, com `command_sent:false` booleano e erro explícito de preparação. Permite até duas novas preparações, com espera de 5 s e prazo original preservado. A terceira falha termina `rejected/AUTHORIZATION_PREPARATION_EXHAUSTED`. Não pode ser usado em recuperação de POST incerto.

`command_dispatched_at` registra um envio indicado como efetuado pelo adaptador (`accepted`/`unknown` com `command_sent:true`); `send_count` marca a única intenção que pode ter chegado ao controlador, e `prepare_failures` conta falhas comprovadamente anteriores ao POST.

Confirmação `observed_only` permite mostrar o resultado recente, mas não permite reutilização no SQL. Seu recibo fica obsoleto após 30 s e exige nova leitura/identificação apropriada. Confirmação com validade conhecida pode ser reutilizada por até 30 s, no mesmo contexto, conservando a validade original. Um recibo vencido nunca reabre execução por conta própria.

Após conclusão sem confirmação, `retry_after_ms` informa o tempo restante da espera de 30 s, contado da conclusão; novas consultas não renovam essa espera. A consulta de estado usa um único snapshot de leitura para não misturar a tentativa anterior à confirmação com a operação já concluída. A gravação do resultado revalida o relógio após obter o lock, impedindo que uma espera pelo banco aceite uma lease que já venceu.

O finalizador grava operação, tentativas elegíveis, sessões, auditoria e eventos em uma transação. Uma falha injetada na auditoria foi testada: toda a conclusão é revertida, preservando o trabalho recuperável. Fencing rejeita resultado de lease antiga mesmo que o worker antigo retorne mais tarde.

## Outbox, cron e limites

`captive_auth_work_due` é uma tabela logged, com uma linha por operação. Intenção, transição e próximo agendamento são escritos na mesma transação. `pg_net` serve apenas para despertar o worker; perda de suas tabelas transitórias não perde a intenção da aplicação.

O prazo de verificação é 90 s desde a primeira intenção de envio, imutável. O watchdog SQL encerra depois do prazo + 20 s; a cadência configurada de 10 s dá classificação nominal até 120 s, sujeita ao funcionamento e à carga do banco/cron. Trabalho que ainda não foi enviado vence após 110 s de fila. O lote de expiração é limitado, e readiness precisa alertar atrasos acumulados. Isso é um orçamento operacional, não uma garantia temporal contra indisponibilidade da infraestrutura.

O dispatcher roda o watchdog antes de tentar HTTP, só desperta o worker quando há trabalho devido e usa timeout de transporte de 25 s. Erro no transporte não reverte a classificação do watchdog. A função de worker recebe `x-captive-worker-token`, valida o hash e registra `last_worker_finished_at`/quantidade de falhas. `last_tick_at`, `last_dispatch_at` e `last_worker_finished_at` medem etapas diferentes; cron executando não comprova worker funcionando.

## Ativação e rollback

A migration cria a configuração desabilitada e `sends_enabled=false`; não envia comandos, não configura automaticamente cron nem trata clientes antigos. Após publicar o backend compatível e validar testes, a ativação controlada é:

```sql
select public.configure_captive_auth_worker(
  'https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal/cron/auth-reconcile',
  true,
  true
);
```

Esse passo foi executado na implantação de 25/09/2026, com a Edge Function versão 253 e o cron ativado a cada 10 s. O smoke do worker sem trabalho pendente retornou HTTP 200. Isso confirma o caminho de autenticação e transporte do worker; não constitui teste de liberação de um cliente real. Exige `supabase_vault`, `pg_cron` e `pg_net`; as versões observadas eram 0.3.1, 1.6.4 e 0.19.5. O segredo é gerado dentro do banco, armazenado criptografado pelo Vault e nunca gravado em texto no código do cron. O endpoint verifica o token interno, e o gateway permite que a requisição chegue a essa verificação, conforme a configuração da Edge Function.

Para interromper novos envios e continuar consultando operações já enviadas, chamar a mesma função com `p_enabled=true, p_sends_enabled=false`, mantendo o reconciliador compatível. Ela também rota o segredo; requisições antigas já enfileiradas podem falhar uma vez, mas o trabalho continua na outbox e o próximo tick usa o token atual. Não apagar tabelas nem encaminhar incertezas ao fluxo legado.

Durante cutover, uma tentativa legada já `authorizing` ou com comando aceito é importada apenas como `verifying`, vinculada a uma solicitação atual com identidade validada. Pendência recente do mesmo dispositivo com usuário/AP/SSID incompatível não é anexada. Não há varredura que envie comandos antigos. `expire_stale_auth_attempts` continua atendendo somente o legado e ignora participantes das operações novas.

## Testes e limites da validação

Em 25/09/2026, `npm ci --prefix tests/database` e `npm test --prefix tests/database` passaram em PostgreSQL 17.10 nativo Windows x64. O conjunto inclui 20 conexões simultâneas, exclusão de envio, leases, rollback transacional, provas de confirmação, retomada sem token válido, proteção contra writers legados, challenge de uso único, quota, bloqueio de abuso e reparo histórico idempotente. O resultado detalhado é gerado em `tests/database/results.json`.

Vault, pg_cron e pg_net são stubs SQL somente no teste local: configuração e argumentos são testados, sem validar a criptografia do Vault. Na implantação, o cron hospedado e o transporte HTTP do worker foram verificados com o smoke sem trabalho descrito acima. Os testes locais não chamam Supabase de produção, UniFi ou dispositivos da loja. A matriz de campo e navegação real do plano continuam necessárias antes de declarar o beta confiável em operação.
