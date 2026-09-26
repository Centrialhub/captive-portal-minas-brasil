# Correções da auditoria adicional — 26/09/2026

## Escopo

Correção dos cinco achados da auditoria adicional de 26/09, sobre a base `af08da1b1373a2ac8ba5453fb87c0c0ff4f75c63`. O beta considerado é Povoão. Drive e João23 continuam fora da validação operacional. Não houve teste em campo nem autorização de cliente real nos testes sintéticos.

| Achado | Correção | Evidência |
| --- | --- | --- |
| NEW-B01: o 21º cliente válido no mesmo IP era bloqueado | Admissão atômica por dispositivo e identidade, com teto emergencial por origem/loja e recibo para repetição da mesma tentativa | 20 testes PostgreSQL, incluindo 300 clientes distintos no mesmo NAT, concorrência, resposta perdida e expiração durante espera por locks; 7 testes de contrato HTTP |
| AUD3-F01: telefone com +55 era truncado ou alterado | Normalização antes da formatação, preservando todos os dígitos e o DDD 55; excesso de dígitos é rejeitado | Testes de formulário e navegador para celular, fixo, DDD 91, DDD 55, E.164 e entrada excessiva |
| AUD3-D01: vínculos de operações impediam retenção | Limpeza transacional do conjunto elegível, respeitando FKs, guardas, prazos de 180/365 dias e vínculos recentes | PostgreSQL real com constraints e triggers; sessões de 181/366 dias, grupos mistos, leases, comprovantes válidos, concorrência e rollback |
| AUD3-O01: falhas de limpeza eram anunciadas como sucesso | Uma RPC atômica, validação estrita dos contadores e HTTP 503 em falha; auditoria administrativa dentro da mesma transação | Falhas injetadas nas exclusões e na auditoria; validação dos handlers de simulação, execução administrativa e cron |
| AUD3-F02: recarga ou volta da política ignorava Retry-After | Espera persistida por tentativa e contexto, com relógio monotônico e restauração conservadora entre documentos | Recarga mantém a tentativa e aguarda pelo menos 30 segundos; navegação e armazenamento indisponível cobertos |

A revisão identificou e levou a quatro ajustes adicionais: limitar e reparar prazo corrompido no armazenamento do navegador; coletar tentativas expiradas antigas sem sessão e seus recibos; impedir que a simulação conte uma tentativa simultaneamente como excluída e expirada; preservar 365 dias de uma tentativa que indica autorização mesmo quando o estado legado da sessão diverge. Todos receberam testes de regressão e revisão independente.

## Verificação desta entrega

- `npm run check`: **301/301 testes**, verificações de assets, migrações, segurança, lint, tipos de frontend e Edge Function, e build aprovados.
- `npm run test:admission`: **20/20** testes PostgreSQL; reexecutados independentemente.
- `npm run test:housekeeping`: **33/33** testes PostgreSQL e handlers, incluindo estados legados divergentes, reexecutados independentemente.
- `npm run verify:recovery`: **10/10** cenários no bundle compilado final, sem upstream; verificação de identidade sem truncamento, ausência de submissão duplicada, manutenção do token e do prazo de espera.
- `npm run verify:startup`: **7/7** cenários selecionados: normal, ausência de globalThis, armazenamento negado, APIs antigas simuladas, busca de sessão travada, recuperação manual da mesma tentativa e HTML da versão anterior.
- Bundle verificado: `index-DMt3XCYS.js`. As duas suítes de navegador registram seu SHA-256 nos artefatos locais. São testes em Chromium atual com apresentação móvel e falhas simuladas, não em Android físico/WebView antigo.

Os testes de banco criam processos PostgreSQL isolados em loopback, conferem PID e diretório de dados antes de escrever e encerram apenas os próprios processos. As dependências estão fixadas em `tests/database/package-lock.json`. Os comandos novos exigem `npm ci --prefix tests/database` e atualmente Windows x64. O navegador requer Playwright/Chromium instalado e aceita `PORTAL_PLAYWRIGHT_MODULE`.

Resultados detalhados locais: `tmp/post-audit-fixes-20260926/check.log`, `admission/results.json`, `retention/results.json`, `browser-final/browser-results.json` e `startup-results.json`. Os resultados da descoberta anterior foram preservados separadamente; as falhas originais não foram transformadas em testes de sucesso esperado.

## Implantação e acompanhamento

As três migrações devem estar aplicadas antes de disponibilizar a nova manutenção. Elas criam as rotinas, reforçam a retenção e adicionam a tabela de recibos; aplicar DDL não executa limpeza. A validação remota usa somente simulação da limpeza. A nova função preserva a autenticação específica existente e a checagem na controladora antes de afirmar acesso liberado.

O frontend exige nova implantação a partir de `main`. Às 14:59:55 BRT, o domínio público ainda entregava `153dd87ae34f0c9adc3b6454e4368d8c5949c836`, anterior inclusive às correções de inicialização de `af08da1`. Atualizar o GitHub não comprova atualização da hospedagem; conferir `build-info.json` depois da implantação.

Aplicadas as migrações `20260926180129_atomic_captive_housekeeping` e `20260926180137_nat_safe_identity_admission`. Os arquivos inicialmente gerados pelo CLI foram renomeados para corresponder às versões registradas pelo serviço de migrações, sem mudar o SQL aplicado. A simulação remota foi executada em transação explicitamente somente de leitura. Não houve purge.

Backend `captive-portal` **v255 ACTIVE**, artefato `a5deefcda2f39dd55d4bfddd78bd5b62355c21be794b00adec7c37da9d471897`. Os seis arquivos publicados foram recuperados do serviço e comparados ao código local; todos correspondem. Às 15:03:49 BRT, `/health` e `/ready` responderam 200, sem operações ativas, atrasadas ou falhas de recuperação naquele instante.

Permissões remotas verificadas: novas RPCs públicas executáveis somente pelo `service_role`; auxiliares privados sem acesso público; tabela de recibos com RLS e sem acesso por `anon`/`authenticated`. O verificador do Supabase não acrescentou avisos de segurança: a tabela nova gera apenas a informação esperada de RLS sem políticas públicas. O aviso de proteção contra senhas vazadas já existia.

Aplicada também `20260926180635_preserve_authorized_attempt_retention`, após duas revisões e testes independentes. A migração posterior preserva o histórico SQL já aplicado; modifica somente três critérios para respeitar o prazo de autorização da tentativa. Nova simulação remota e conferência de permissões passaram. A publicação do código em `main` reúne o frontend, o backend já ativo, as três migrações, testes e documentação.

## Limites

Estes resultados não comprovam 99,9% das tentativas válidas liberadas em até 120 segundos. Os testes de admissão chegam à fronteira da operação durável com serviços simulados; não medem capacidade ou latência da controladora. Os testes de manutenção comprovam integridade e comportamento em falhas nas fixtures, sem executar purge em produção.

O roteiro completo `release:gate` não foi aprovado nesta máquina: exige Docker, teste de concorrência de integração e comprovações operacionais de rotação de credenciais e proteção contra senhas vazadas. Nenhuma dessas condições foi simulada como verdadeira para liberar o roteiro. A proteção contra senhas vazadas continua como aviso preexistente do Supabase.

Esta entrega trata os cinco achados acima. Não encerra os achados ainda pendentes da auditoria de confiabilidade de 25/09, rodada 2, incluindo dependências antes da admissão sem prazo global, recuperação de lease em erro de preparação e critérios de saúde/prontidão do worker. Também não permite confirmar remotamente a abertura automática do assistente de Wi-Fi no Android.
