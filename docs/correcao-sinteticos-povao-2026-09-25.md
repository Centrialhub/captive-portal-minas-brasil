# Correção dos testes sintéticos — Povoão, 25/09/2026

## Resultado

Os **18 grupos de problemas reproduzidos foram corrigidos**. A validação final passou com **303 testes automatizados: 253 da aplicação e 50 do PostgreSQL**, além de **dois fluxos em Chromium**. As 30 asserções anteriormente reprovadas continuam ativas e passaram; foram acrescentadas verificações para os casos encontrados durante a revisão. O resultado anterior permanece preservado em `synthetic-results-2026-09-25.json`.

**Banco e backend corrigidos estão implantados:** migration `20260925180605_harden_durable_auth_recovery_under_load.sql` e Edge Function `captive-portal` **v254**. **Ainda é necessária nova implantação do frontend no EasyPanel.** O portal publicado continua no commit `90b0767af59b9490fb3191601ac2796886ee72c2`.

Escopo: beta `povao`. `drive` e `joao23` permanecem fora desta intervenção. Os testes sintéticos usaram dados locais e não emitiram comandos de autorização para clientes reais.

## Correções e evidências

| Grupo | Correção verificada |
| --- | --- |
| DB-SYN-01 | Verificações precedem novos envios; worker drena vários lotes dentro de prazo; banco limita leases ativos a 16 por controladora/site, incluindo solicitações inline e lojas compartilhadas. Controladora cheia não bloqueia outra independente. |
| DB-SYN-02 | Join revalida capability e recibo depois dos locks. Recibo vencido não é reutilizado; expiração é devolvida como erro de domínio. |
| DB-SYN-03 | Renovação revalida dono, versão e relógio depois do lock; lease vencida é recusada. |
| DB-SYN-04 | Envio novo exige orçamento restante de pelo menos 16 s; tolerância de verificação não autoriza novo envio. Prazo original permanece imutável. |
| DB-SYN-05 | Cada expiração usa uma subtransação isolada dentro do lote. Falha de auditoria reverte aquele item; diagnóstico privado e backoff permitem que os demais avancem. |
| DB-SYN-06 | Aceite/resposta incerta tardios persistem a evidência e atualizam participantes atomicamente, sem conflito com o guard. |
| SYN-B01 | Reserva e criação do login auxiliar compartilham 1,5 s. Confirmação do Wi-Fi deixa de depender de uma RPC auxiliar sem prazo. |
| SYN-B02 | Falha comprovadamente anterior ao adaptador é registrada como `not_sent`, com preparação limitada. Uma chamada cujo efeito é incerto continua somente para verificação. |
| SYN-B03 | Respostas de join/status e exceções conhecidas do SQL recebem classificação coerente: expirado 410, capability inválida 401, inconsistência 503. |
| SYN-U1 | Adaptador confere prazo absoluto depois de headers e corpo; resposta posterior ao prazo não é aceita como sucesso. |
| SYN-U2 | Login exige resposta válida e sucesso explícito; redirect ou rejeição não são aceitos por conter cookie. |
| SYN-U3 | Cookies e CSRF renovados na leitura anterior ao comando são incorporados ao único POST autorizado. |
| SYN-U4 | Expiração, revogação e precedência de `Max-Age` são respeitadas pelo cookie jar. |
| SYN-F01 | Requisição em andamento pertence à sua execução; cleanup/StrictMode e respostas antigas não bloqueiam a retomada. |
| SYN-F02 | Validade usa tempo do servidor e duração monotônica. Relógio errado do aparelho não descarta confirmação válida nem renova a capability. |
| SYN-F03 | Eventos repetidos são limitados; revalidação em segundo plano preserva a tela confirmada e o prazo de redirecionamento. |
| SYN-F04 | Cooldown de inicialização persiste por contexto entre remontagens/reaberturas, com recuperação quando storage está indisponível. |
| SYN-F05 | Navegação bloqueada preserva o resultado de Wi-Fi e reabilita tentativa manual; falha é registrada na telemetria. |

## Casos adicionais encontrados na revisão

- RPCs de claim e registro receberam prazo e sinal de cancelamento. Resposta tardia de claim não inicia comando depois do orçamento. Um cancelamento HTTP não é interpretado como prova de rollback remoto.
- Consultas de preparação de permissões e APs têm prazo; suas respostas tardias não iniciam POST. Leitura pública de operação tem limite de 3 s e join de 5 s.
- Expiração ocorrida durante lock pode chegar como exceção SQL; os códigos conhecidos são convertidos em 401/410 sem expor mensagens SQL arbitrárias.
- Resposta do login auxiliar após o prazo é ignorada mesmo quando o relógio avança antes do timer. Um `generateLink` já iniciado pode terminar remotamente; seu resultado tardio não é usado nem inicia uma segunda emissão.
- A revisão de capacidade acrescentou limite global por controladora/site, prioridade de verificação sobre chamadas inline e seleção que permite progresso de outra controladora.

## Orçamento da fila

Cron continua a cada **10 s**. Uma execução usa no máximo **50 s**; o endpoint reserva os 2 s finais para registrar sua conclusão. A drenagem executa até **10 lotes de quatro**, exigindo **16 s restantes** para iniciar outro. O transporte pg_net recebeu timeout de **55 s**. Leases continuam com até **30 s**, e a janela de confirmação continua **90 s**, com tolerância de encerramento de 20 s. Nenhum polling renova esse prazo.

O limite de **16 leases ativos por controladora/site** inclui execuções sobrepostas e chamadas do navegador. É aplicado sob advisory lock e recontagem no banco. Ele limita reservas concorrentes; não promete capacidade ilimitada nem garante que uma requisição remota já recebida pare instantaneamente após timeout.

| Ensaio | Resultado |
| --- | --- |
| PostgreSQL real: 40 operações inicialmente em fila, respostas simuladas imediatas | 40 confirmadas; nenhuma lease rejeitada |
| PostgreSQL real: 40 operações já aceitas, sem navegador | 40 confirmadas; nenhuma lease rejeitada |
| 24 claims concorrentes, conexões independentes | 24 reservas únicas em duas ondas; máximo de 16 leases ativos |
| Coordenador real + modelo de leases, cron sobreposto, 40 e 80 operações já aceitas, leituras de 6,1 s e 14 s | Todas confirmadas; sem expiração e máximo de 16 leituras concorrentes |

O último ensaio pressupõe respostas bem-sucedidas dentro do tempo simulado. Não mede throughput da UniFi real. Demanda superior à capacidade, indisponibilidade prolongada ou respostas além do limite continuam podendo terminar sem confirmação, com estado e diagnóstico explícitos.

## Revisão e validação final

- Revisão cruzada de SQL, locks, ACLs, atomicidade, código UniFi, handlers e frontend, incluindo revisão final do prefiltro de capacidade por outro agente.
- `npm run check`: verificações de assets, contratos, migrations e segurança; ESLint, TypeScript, Deno; **253/253 testes em 16 arquivos**; build de produção.
- PostgreSQL 17.10 nativo: **50/50**, repetidos independentemente pelo agente principal em cluster descartável. Migrations já aplicadas permaneceram intactas. A nova migration foi criada via CLI e depois teve somente o timestamp local alinhado ao registro efetivamente aplicado no Supabase.
- Chromium real, APIs simuladas e rede externa bloqueada: desktop percorreu formulário → pendente → confirmado → destino. Emulação móvel permaneceu no portal após primeiro redirect sem efeito; botão foi reabilitado e retry manual chegou ao destino. Uma identificação e duas consultas de status por fluxo; zero erros de página. Servidor e browser encerrados.
- As alterações não usam `skip` nem falha esperada para converter reprovações em aprovação. Mudanças nos testes de capacidade refletem o novo escalonamento, preservando unicidade, limites e conclusão exigida.

Evidência consolidada: [correction-results-2026-09-25.json](correction-results-2026-09-25.json). Comandos para repetir:

```powershell
npm run check
npm test --prefix tests/database
```

O primeiro comando exige Deno no PATH. O harness PostgreSQL exige Windows x64 e porta local 55439 livre; ele verifica o processo e diretório do cluster antes de qualquer escrita. Vault, cron e pg_net são stubs nos testes locais.

## Conferência após implantação

Em 25/09/2026, entre 18:06 e 18:09 UTC (15:06–15:09 de Brasília):

- Migration registrada no banco, v254 ativa e **seis arquivos publicados idênticos** aos arquivos revisados.
- Cron ativo a cada 10 s; configuração de envio preservada. Não havia leases ativos na conferência anterior ao cutover; não houve revogação de leases nem recriação de clientes.
- Smoke autenticado do worker via pg_net: **HTTP 200**, `{claimed:0, applied:0, failed:0}`, sem timeout. Nenhum cliente sintético foi criado.
- Readiness **HTTP 200**, zero operações ativas/atrasadas e zero diagnósticos de recuperação. Havia duas operações confirmadas no banco; isso descreve estado registrado, sem comprovar navegação física no aparelho.
- Worker e consulta de status sem credencial: **HTTP 401**.
- Verificação pública: **8/8** checks aprovados, incluindo portal, headers, bootstrap, prontidão do Edge e saúde TLS do proxy. A identidade verificada do frontend é a versão anterior, não a nova correção.
- Nova tabela privada com RLS; `anon` e `authenticated` sem SELECT; `service_role` somente SELECT, sem INSERT nem execução do helper interno de expiração.

O advisor hospedado manteve o aviso preexistente de [proteção contra senhas vazadas desabilitada](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). As tabelas internas sem policies aparecem como [informativo de RLS](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), coerente com o acesso exclusivamente por writers confiáveis e ACLs restritas. Essa correção não alterou a configuração global de Auth.

## Publicação e limites restantes

**Sim, é necessária nova implantação do frontend no EasyPanel** para que relógio, retomada, cooldown e redirecionamento corrigidos cheguem aos aparelhos. O PR permanece em rascunho com código e evidências atualizados.

O `release-gate.sh` completo não foi executado: Docker não está disponível neste ambiente; o aviso de proteção de senhas também permanece como requisito separado do gate formal. Não se deve registrar esse gate como aprovado. Após preparar essa etapa, publicar o frontend com o SHA correto e executar `verify:production` para esse SHA.

Ainda é necessário validar iPhone/Android reais em Povoão, dentro do captive browser, e navegação externa com dados móveis desligados. O smoke em Chromium e a leitura de estado da UniFi não substituem essa prova. Os defeitos reproduzidos e revisados foram corrigidos; isso não constitui garantia absoluta contra falhas futuras de rede ou controladora.
