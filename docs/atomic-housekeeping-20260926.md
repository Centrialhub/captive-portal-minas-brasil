# Retenção e manutenção atômicas — 26/09/2026

## Defeitos corrigidos

- **AUD3-D01:** a exclusão de sessões maduras falhava porque a operação e a tentativa ainda referenciavam a sessão.
- **AUD3-O01:** as exclusões independentes ignoravam os erros de banco e retornavam sucesso.

O frontend principal e a autorização de clientes não são alterados por esta correção. A instalação da migration cria funções/índices; **não executa a limpeza**. É necessário instalar a migration antes de implantar a Edge Function que chama a nova RPC.

## Implementação

`public.captive_housekeeping` é uma entrada `SECURITY INVOKER`, com execução concedida somente a `service_role`. Sua implementação privilegiada fica no schema não exposto `captive_internal`, também com acesso restrito e `search_path` vazio. Os auxiliares não recebem permissão de execução de `service_role`, `anon`, `authenticated` ou `PUBLIC`.

Uma chamada executa um lote em uma transação. Exclusões, desvinculação da sessão na tentativa, expiração de tentativas legadas e auditoria administrativa confirmam juntas. Qualquer erro SQL reverte o lote inteiro. A administração e o cron retornam HTTP 503, `ok:false` e registram a falha; não escrevem log de conclusão nessa situação. Payload de contadores ausente ou inválido também é erro.

O registro administrativo foi movido para a mesma transação. Antes, `writeAdminAudit` podia apenas registrar sua própria falha e deixar a resposta de sucesso prosseguir. Os demais usos desse helper não foram modificados.

Se a conexão se perde **depois** do commit, o backend não pode garantir que nada foi removido. Ele relata a falha, não repete automaticamente o lote, e orienta conferir o resultado antes de repetir. Esse cenário foi reproduzido com banco real e perda de resposta simulada.

### Política de retenção

- Sessões sem autorização: mais de 180 dias. Sessões autorizadas: mais de 365 dias. Datas exatamente na fronteira são preservadas.
- Operações precisam ser terminais e ter conclusão madura. Recibos ainda válidos, lease vigente, participante recente, handoff válido, verificação recente ou evento de portal dentro de 180 dias preservam o grupo.
- Se uma operação contém participante antigo e recente, ambos e sua operação permanecem intactos.
- Tentativas abandonadas antes de criar sessão também usam 180/365 dias, precisam estar expiradas e sem lease válida, handoff válido, sessão ou operação. A exclusão remove os recibos de admissão relacionados pela FK específica adicionada pela correção de admissão.
- Quando estados legados divergem, prevalece a retenção mais longa: uma tentativa com status `authorized` ou flag `authorized=true` conserva 365 dias mesmo se a sessão disser `failed`. A proteção foi acrescentada em migration posterior, preservando intacta a migration inicial já instalada.
- Operações em `queued`, `sending` ou `verifying` são preservadas, mesmo com timestamps anormalmente antigos.
- Ligações inconsistentes são preservadas para diagnóstico; a limpeza não tenta repará-las removendo dados.
- `audit_logs` mantém o prazo existente de 180 dias. Ele é independente dos 365 dias das sessões autorizadas. `portal_events` recentes impedem remover a sessão relacionada; este trabalho não amplia a exclusão de eventos de portal.
- Um bloqueio de limite de requisições ainda vigente é preservado, mesmo com `updated_at` antigo.

### Integridade e lotes

O lote padrão seleciona até 100 sessões, 100 tentativas (incluindo órfãs), 100 operações e 100 eventos de operação. O limite aceito pela RPC é 1–500. Operações com muitos participantes e eventos antigos podem terminar em chamadas sucessivas, sem apagar participantes restantes. A resposta contém `batch_size`; seus contadores indicam aquele lote, não a eliminação de todo o histórico elegível.

As verificações OTP e handoffs que dependem das sessões/tentativas selecionadas são removidos explicitamente e contados. Existem também lotes limitados para verificações expiradas independentes, limites de requisições, auditorias e handoffs. O limite de sessões não equivale a um limite igual no total de registros dependentes: uma sessão pode ter diversas verificações históricas.

A ordem das relações duráveis é: operação → tentativa → sessão; depois, participante → desvincular `captive_session_id` → dependências expiradas → sessão → tentativa. O identificador `auth_operation_id` nunca é desvinculado. Os triggers de estado e identidade permanecem ativos; a atualização controlada do backlink usa e restaura o mesmo marcador interno usado pelas RPCs de autorização. Eventos e operação são removidos somente quando não restam participantes nem referências.

A FK de `leads.session_id` preserva o lead e torna nula apenas a referência à sessão expirada. Nenhuma FK ampla `CASCADE` foi acrescentada. A FK existente dos recibos de admissão foi testada com a migration real.

Há uma trava consultiva exclusiva para chamadas de manutenção, sem participação dos clientes. Operações e participantes já bloqueados são pulados quando possível. Travas adicionais de relações têm `lock_timeout` de 250 ms; um conflito não previsto gera falha observável e rollback, em vez de permanecer esperando indefinidamente. Não foi alegado um prazo máximo geral de execução da consulta.

### Simulação

A simulação usa a mesma RPC e critérios da execução, sem exclusões ou expiração de tentativas. Ela prevê o próximo lote. Sob tráfego concorrente ou passagem de tempo, a execução pode selecionar menos registros ou outros candidatos elegíveis. Nos testes sem concorrência, todos os contadores da simulação e da execução foram comparados, incluindo tentativas legadas que seriam removidas antes da etapa de expiração.

## Verificação local

Comandos no checkout:

```powershell
npm ci --prefix tests/database
node tests/database/housekeeping.mjs
```

O runner permanente usa PostgreSQL 17.10 nativo em `127.0.0.1:55469`, criado em diretório temporário exclusivo. Não aceita URL ou credenciais externas. Confere `data_directory`, PID e processo filho antes de escrever, e encerra apenas seu próprio servidor ao concluir. Resultados ficam em `tmp/post-audit-fixes-20260926/retention/results.json`.

**33 testes aprovados**, com saída 0:

- ACL pública/privada e negação de DML direto em operações;
- FKs reais de membros, tentativas, sessões, leads, OTP, handoffs e recibos;
- triggers de identidade, backlinks, normalização, atualização e estado durável;
- fronteiras 180/365 dias, grupos mistos, trabalho ativo e recibos válidos;
- retenção de órfãs e exclusão dos recibos maduros;
- estados legados contraditórios preservando o prazo maior de autorização;
- grupos e eventos drenando em lotes;
- erros injetados em sete exclusões, provando rollback do conjunto;
- falha no registro administrativo depois da limpeza, ainda atômica;
- operação bloqueada, manutenção concorrente e lead bloqueado;
- contadores equivalentes entre simulação e execução;
- falhas/payload inválido nos handlers admin, simulação e cron;
- perda de resposta após commit, sem falso sucesso e sem repetição automática.

O runner carrega o catálogo sintético completo da auditoria de sessões/tentativas e suas constraints/triggers, as duas migrations duráveis, o DDL original de leads/OTP/handoffs e as migrations novas de retenção e admissão. Não usa clientes reais, UniFi, fetch externo, tarefas de cron reais ou dados de produção.

`deno check supabase/functions/captive-portal/index.ts` também passou. Os testes anteriores da auditoria permanecem como evidência histórica; sua instrumentação antiga das seis exclusões não corresponde à RPC atômica nova e não deve substituir este teste permanente.

## Limites

- Este trabalho corrige retenção e observabilidade da manutenção; não resolve as pendências de deadline, lease e prontidão da segunda auditoria.
- Os testes não são uma medição do SLO de 99,9% das liberações em 120 segundos.
- Não houve purge, migração aplicada, publicação ou escrita em produção durante os testes desta frente. Após revisão, a entrega foi aplicada pelo coordenador; ver `correcoes-auditoria-20260926.md` para versões e validação remota.
