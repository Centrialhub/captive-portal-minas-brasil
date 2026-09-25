# Resultados sintéticos do adaptador UniFi

Data: 25/09/2026. Base examinada: `1b2eefbb3ab9108c4ca46fdea86626c6f81dc942`, checkout `tmp/reliability-release-20260925`.

## Método e limites

A suíte `supabase/functions/_shared/unifi-synthetic.test.ts` extrai por AST as funções reais de login, comando e observação de `captive-portal/index.ts`. Usa os módulos reais de transporte, identificação e cookies. Somente a rede é substituída por respostas HTTP sintéticas; endpoints inesperados falham e o `fetch` global não é usado. Nenhum comando chegou a um controlador real e nenhum dado de produção foi alterado.

Primeira execução: **26 testes, 19 aprovados e 7 reprovados**, correspondendo a **4 defeitos distintos**. ESLint do novo arquivo passou. Os testes reprovados expressam o resultado esperado; não foram marcados como `skip` nem como falhas esperadas para esconder a regressão. A implementação permaneceu intacta nesta fase.

```sh
npx vitest run supabase/functions/_shared/unifi-synthetic.test.ts --reporter=verbose
npx eslint supabase/functions/_shared/unifi-synthetic.test.ts
```

Essas reproduções demonstram comportamento do código sob as condições descritas. Não demonstram que as quatro condições ocorreram em Povoão, nem substituem a confirmação de acesso à internet no dispositivo.

## SYN-U1 — Prazo absoluto depende de o callback do timer já ter executado

**Local:** `supabase/functions/_shared/unifi-authorization.ts`, função `fetchUnifiResponse`, linhas 58–78 da base examinada.

**Reprodução (2 testes):** a chamada começa no instante 0, com limite 100. A resposta de headers ou do corpo torna-se disponível no instante 101, antes de executar o callback do timer. O teste avança `Date` sem executar timers para modelar uma continuação de Promise após suspensão do runtime. O adaptador retorna `status: accepted`; o contrato esperado é `unknown`, mantendo `command_sent: true`.

**Causa:** a função checa o relógio somente antes do fetch. Depois dos headers verifica apenas `signal.aborted`; depois de ler o corpo não revalida relógio nem sinal. Um timer vencido não significa que seu callback já executou.

**Impacto:** o limite absoluto de transporte pode ser ultrapassado e a resposta tardia ainda pode ser tratada como dentro do prazo. A cerca de lease no banco continua sendo uma proteção adicional: este teste não demonstra confirmação indevida no banco nem um segundo POST. Não há garantia possível de interromper um processo enquanto ele está suspenso; ao retomar, ele deve recusar dados vencidos.

**Correção proposta:** revalidar `Date.now() >= deadlineAt` após headers e após leitura de corpo, além do AbortSignal. Uma resposta tardia ao POST deve permanecer ambígua, com `command_sent: true`; jamais reclassificar como envio inexistente.

## SYN-U2 — Login redirecionado ou explicitamente rejeitado é aceito se houver cookie

**Local:** `supabase/functions/captive-portal/index.ts`, `unifiTryLogin`, linhas 834–842 da base examinada.

**Reprodução (2 testes):** (a) HTTP 302 contendo `unifises`; (b) HTTP 200 com `meta.rc: error` e `unifises`. Nos dois casos `unifiLogin` retorna `ok: true`.

**Causa:** o login rejeita apenas HTTP >=400 e depois considera suficiente encontrar um cookie de autenticação. O JSON de rejeição não é examinado e HTTP 3xx não é recusado. O transporte corretamente mantém `redirect: manual`, portanto não houve envio de credenciais para o destino do redirect.

**Impacto:** uma autenticação fracassada pode avançar ao preflight com uma sessão inválida, gerando chamadas desnecessárias e confundindo o motivo da falha. A confirmação estrita de estação permanece uma proteção posterior; o teste não demonstra acesso concedido a outro cliente.

**Correção proposta:** exigir status HTTP 2xx; no endpoint legado, validar o envelope de login e exigir `meta.rc: ok`. Preservar a compatibilidade do endpoint UniFi OS, cujo corpo não necessariamente usa o envelope legado; rejeições explícitas continuam sendo falhas em ambos. Cookies isolados não devem sobrepor uma rejeição HTTP/JSON.

## SYN-U3 — Rotação de sessão/CSRF na consulta de estação é perdida antes do POST

**Local:** `supabase/functions/_shared/unifi-authorization.ts`, `fetchUnifiStationsStrict`; `supabase/functions/captive-portal/index.ts`, `unifiAuthorizeCommandOnly`, linhas 983–1005 da base examinada.

**Reprodução (1 teste):** login emite sessão 1. O preflight responde com estação exata válida, `Set-Cookie: unifises=session-2` e `X-CSRF-Token: csrf-2`. O servidor sintético exige esses valores no comando seguinte. O adaptador envia sessão 1 e nenhum CSRF novo; recebe 401 e retorna `unknown`.

**Causa:** o helper de estações descarta os headers da resposta. O comando reutiliza `init` criado antes da consulta; não há oportunidade de atualizar os cookies/CSRF com a resposta intermediária.

**Impacto:** se o controlador ou proxy renovar a sessão nessa consulta, o comando poderá ser negado e o cliente permanecer bloqueado. Como o POST já começou, a política conservadora passa a verificar sem reenviar; a oportunidade de evitar a falha era renovar os headers antes do primeiro POST. Este teste pressupõe rotação pelo servidor e não afirma que ela ocorre hoje em produção.

**Correção proposta:** expor os headers/metadados de sessão da consulta bem-sucedida e atualizar o cookie jar e CSRF antes do único comando. Manter cookie de roteamento, CSRF coerente com o token mais recente, prazo absoluto e proibição de reenvio ambíguo.

## SYN-U4 — Cookies removidos por expiração continuam no jar

**Local:** `supabase/functions/_shared/unifi-cookie.ts`, `mergeSetCookieValues`, linhas 30–39 da base examinada.

**Reprodução (2 testes):** `Set-Cookie: unifises=deleted; Max-Age=0` ou o mesmo cookie com `Expires=Thu, 01 Jan 1970 00:00:00 GMT`. O jar continua com `unifises: deleted`; deveria removê-lo, preservando o cookie de roteamento.

**Causa:** apenas o par nome/valor é processado; o código remove cookies quando o valor é vazio, mas ignora os atributos de expiração.

**Base do resultado esperado:** a [RFC 6265, seção 5.2.2](https://www.rfc-editor.org/rfc/rfc6265.html#section-5.2.2) define `Max-Age` menor ou igual a zero como expiração no passado. A [seção 5.3](https://www.rfc-editor.org/rfc/rfc6265.html#section-5.3) dá precedência a `Max-Age` sobre `Expires` e exige eliminar cookies expirados. As reproduções usam atributos válidos segundo essas regras; a recomendação de precedência não foi inferida da implementação atual.

**Impacto:** a revogação da sessão pode ser confundida com credencial presente. Combinada com SYN-U2, uma resposta de login que revoga um cookie pode ser reportada como login bem-sucedido. Não implica que o controlador aceite o cookie inválido.

**Correção proposta:** interpretar `Max-Age` e `Expires`, com precedência de `Max-Age` quando válido; remover cookies cujo prazo já terminou. Cobrir valores vazios, inválidos, expiração futura e precedência para evitar remover uma sessão válida.

## Proteções aprovadas na mesma execução

- Aplicação do comando seguida de resposta parcial quebrada produz `unknown`; uma leitura posterior confirma o MAC exato sem segundo POST.
- Erro de transporte durante emissão não vira rejeição inventada, mesmo quando o servidor simulado não aplicou o comando.
- Warm-up, login, consulta e corpo do comando compartilham 14 segundos; estourar esse prazo via timers normais mantém o resultado ambíguo.
- Falha no corpo da consulta de estações impede emissão do comando.
- Negociação UniFi OS → legado compartilha um único limite de login.
- Cookie de roteamento e CSRF extraído de JWT UniFi OS sobrevivem até o comando; redirects não são seguidos.
- AP ou SSID que desaparecem após aceite impedem confirmação indevida.
- MAC quase igual/malformado não é substituído pelo MAC solicitado.
- HTTP 201/202/206 com envelope de erro não confirma autorização.
- Valores truthy não booleanos em `authorized` não confirmam nem permitem o comando.

## Ordem sugerida

Corrigir SYN-U3, SYN-U2 e SYN-U4 juntos para manter consistente o ciclo de autenticação e rotação. Corrigir SYN-U1 no transporte compartilhado preservando a incerteza após envio. Depois executar esta suíte, as suítes já existentes de adaptador/cookies/coordenador e o Deno check. Nenhuma correção requer um POST real para ser verificada nesta etapa.
