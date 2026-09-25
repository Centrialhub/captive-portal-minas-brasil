# Correção da autorização do beta Povoão — 25/09/2026

> **Atualização:** os achados abaixo são o diagnóstico histórico anterior à correção. Os 18 grupos foram corrigidos; a validação atual passou com 303 testes automatizados e dois fluxos de navegador. Backend v254 e migration corretiva implantados; frontend ainda pendente. Veja [correção e evidências atuais](correcao-sinteticos-povao-2026-09-25.md).

## Escopo e conclusão

Correção da coordenação entre portal, banco e UniFi para o beta `povao`. As falhas externas de `drive` e `joao23` permanecem fora do escopo informado pelo responsável.

O diagnóstico anterior está em `diagnostico-povao-2026-09-25.md`. Na janela fixa de 18/09 12:40 a 25/09 12:40 (Brasília), 35 sessões com comando aceito foram encerradas pelo próprio limitador durante a confirmação; outras cinco perderam a continuidade. A correção mantém a mesma operação até confirmar ou classificar honestamente o resultado como inconclusivo. Um aceite de comando não é apresentado como prova de internet funcionando no aparelho.

## Mudanças implementadas

- Intenção e trabalho pendente persistidos no PostgreSQL, com uma operação ativa por loja/controladora/site/MAC. Tentativas elegíveis acompanham o mesmo resultado.
- Exclusão de envio, lease com versão, prazo imutável e proteção contra gravações atrasadas. Timeout depois de um POST não provoca reenvio automático. Falha comprovadamente anterior ao envio admite preparação limitada.
- Confirmação exige a MAC exata e resposta válida da controladora. Troca de AP só é aceita com ambos os APs cadastrados na mesma loja e SSID correspondente; nunca se escolhe outro dispositivo por proximidade ou exclusividade circunstancial.
- Operação, tentativa, sessão e auditoria concluem na mesma transação. A leitura de status usa um snapshot consistente.
- Reconciliador independente do navegador, acionado pelo cron a cada 10 segundos quando há trabalho. Watchdog encerra pendências além do orçamento operacional, conservando a distinção entre rejeição e ausência de confirmação.
- Endpoint de consulta com capability no corpo da requisição. Consultar progresso não repete identificação nem consome a trava do comando.
- Frontend preserva a tentativa em falhas de rede, retoma ao voltar à janela/rede, respeita o prazo de nova tentativa e mostra sucesso sem depender do OTP auxiliar. Links da política de privacidade preservam o contexto de conexão.
- Telemetria distingue envio, aceite, confirmação, sucesso exibido e redirecionamento iniciado. Readiness inclui cron, worker e trabalho atrasado.

## Histórico e roaming

Dos 17 registros antigos com tentativa autorizada e sessão pendente, dez também satisfazem os critérios mais estritos de mesma pessoa, MAC, AP, SSID e confirmação anterior única em até 30 segundos. A migration de reparo conserva a data da evidência anterior e registra auditoria; não cria autorização atual nem envia comandos. Os sete restantes não recebem sucesso presumido.

Na revisão adicional, 11 confirmações históricas tinham a mesma MAC da tentativa e AP diferente. Todos os pares de APs estavam cadastrados em Povoão e o SSID coincidia. Isso motivou a cobertura explícita de roaming seguro.

## Verificação

`npm run check` passou: validadores de assets/contratos/segurança, ESLint, TypeScript, Deno 2.9.5, **142 testes em 11 arquivos no checkout isolado da release** e build. A suíte separada passou **28 testes em PostgreSQL nativo 17.10**, com 20 conexões simultâneas, falhas transacionais, snapshot concorrente e workers atrasados. Os testes HTTP usam controladora simulada e os testes de interface renderizam o App real.

A navegação local em desktop/mobile e o retorno da política foram inspecionados, sem enviar identificação ou comando real de teste. O browser não apresentou erros. Os parâmetros sintéticos de conexão foram conservados no retorno da política.

### Verificação em produção, 25/09/2026, 13:49–13:50 (Brasília)

| Componente | Resultado |
| --- | --- |
| Edge Function | `captive-portal` **v253**, ativa, contrato `durable-v1`; seis arquivos recuperados do deploy conferem com a fonte revisada |
| Migration durável | `20260925164858_durable_captive_auth_operations` aplicada |
| Reparo histórico | `20260925165002_reconcile_proven_legacy_authorization_reuse` aplicado: dez sessões, dez auditorias, dez eventos; sete casos sem evidência preservados |
| Reconciliador | Ativado; cron `captive-auth-reconcile-v1`, `10 seconds`, execuções `succeeded` |
| Integração Vault → pg_net → Edge | HTTP 200, `claimed:0`, `applied:0`, `failed:0`; nenhuma autorização de teste enviada a clientes |
| Readiness | HTTP 200; banco, configuração e reconciliador disponíveis; zero operações atrasadas no momento da verificação |
| Autenticação | Worker sem segredo e status sem capability retornaram HTTP 401; zero RPCs novas executáveis por `anon`/`authenticated` |

O advisor de segurança não apontou nova exposição das tabelas: as cinco tabelas privadas têm RLS e acesso público revogado; o aviso informativo de ausência de policies é intencional para acesso exclusivo do backend. Permanece o aviso anterior de [proteção contra senhas vazadas desativada](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), fora da causa desta falha de liberação.

## Implantação e recuperação

Ordem: migration durável → Edge Function compatível → configuração do worker → frontend. O novo frontend depende de `expires_at` no init e de `/attempt/status`.

**É necessária nova implantação do frontend; o frontend ainda não foi publicado nesta tarefa.** A rodada sintética posterior reprovou a validação: concluir as correções adicionais antes dessa implantação. O deploy deverá compilar o commit corrigido usando o Dockerfile do repositório, com as variáveis públicas já configuradas no EasyPanel. Na verificação anterior, o frontend público informava SHA `90b0767af59b9490fb3191601ac2796886ee72c2`. O backend implantado oferece o contrato durável e compatibilidade com o bundle anterior, mas também tem os achados adicionais registrados no novo relatório.

O contrato técnico e os comandos de configuração estão em `durable-captive-auth-db-contract.md`. Para interromper novos envios, manter o reconciliador publicado e configurar `p_enabled=true, p_sends_enabled=false`. Isso preserva consultas de comandos que podem já ter sido aplicados. Não remover tabelas nem retornar operações incertas ao caminho legado.

## Limites e aceite em campo

Os testes não substituem um aparelho conectado fisicamente em Povoão. Continua necessário validar iPhone/Android com dados móveis desligados, navegação externa após liberação, fechamento/reabertura do captive e troca de AP. A razão física pela qual algumas MACs não aparecem inicialmente em `/stat/sta` ainda requer observação simultânea da controladora e do aparelho.

O script completo `release-gate.sh`, que também exige Docker e verificações operacionais adicionais, não foi executado neste ambiente. As verificações de código, build, banco isolado e produção realizadas nesta tarefa são registradas separadamente, sem presumir passagem daquele gate.
