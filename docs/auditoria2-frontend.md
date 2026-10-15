# Auditoria sintética 2 — retomada do frontend

Data: 25/09/2026. Base examinada: `18826ae`. Checkout: `tmp/reliability-release-20260925`.

Somente testes e este relatório foram acrescentados nesta frente. Implementação, produção e dispositivos de Povoão não foram alterados. Drive e João23 estão fora do escopo.

## Resultado

**21 casos novos: 18 aprovados e 3 reprovados, uma classe nova de defeito.** Os três testes reprovados permanecem ativos; não usam `skip` nem `it.fails`. O terceiro caso possui duas asserções reprovadas; isso não representa um quarto teste ou outra classe de defeito.

| Arquivo | Total | Aprovados | Reprovados |
| --- | ---: | ---: | ---: |
| `src/App.resilience.test.tsx` | 13 | 10 | 3 |
| `src/lib/attempt-tracker.resilience.test.ts` | 8 | 8 | 0 |
| Total | 21 | 18 | 3 |

Comando reproduzível, executado no checkout acima:

```powershell
npx vitest run src/App.resilience.test.tsx src/lib/attempt-tracker.resilience.test.ts --reporter=verbose
```

Saída final: `Tests 3 failed | 18 passed (21)`, exit code 1. ESLint dos dois arquivos e `tsc -b tsconfig.json` passaram. A suíte anterior não foi repetida nesta frente.

## AUD2-F01 — eventos de retomada contornam a pausa offline

**Prioridade: P3, falha de retomada e trabalho desnecessário no cliente.** Há reprodução determinística de consultas iniciadas offline e atraso adicional condicionado a transporte pendurado. Não foi demonstrada nova recusa de liberação, repetição de comando UniFi nem descumprimento de 120 s em produção.

### Causa

`src/App.tsx:221` aplica as guardas de rede e visibilidade apenas a `source === "automatic"`. O listener em `src/App.tsx:339` usa `source="resume"` e verifica somente a visibilidade naquele instante. Em `src/App.tsx:224`, o timer para respeitar `nextCheckRef` conserva essa origem. Se o dispositivo fica offline entre o evento e o timer, a consulta ainda começa. Um evento de retorno à página já offline também consegue iniciá-la diretamente.

A consulta ocupa `inFlightRef` em `src/App.tsx:233`. Quando a rede volta, o novo evento é descartado pela guarda de requisição em andamento em `src/App.tsx:220`. A proteção contra concorrência funciona, mas pode ficar ocupada por uma leitura que a pausa offline deveria ter evitado.

### Reproduções que permanecem vermelhas

| Caso exato | Local | Sequência e resultado observado |
| --- | --- | --- |
| `AUD2-F01: does not start a resume read offline when a previously scheduled pageshow timer becomes due` | `src/App.resilience.test.tsx:90` | Identificação retorna pendente com espera de 10 s. `pageshow` em 1 s agenda retomada. A rede cai antes de 10 s. Observado: **uma consulta de status offline**, quando nenhuma deveria começar. |
| `AUD2-F01: does not issue status reads for foreground events while the device is offline` | `src/App.resilience.test.tsx:103` | Após resposta pendente, o dispositivo fica offline. Três eventos `visibilitychange`, separados por 1 s, provocam **três consultas**. O adapter neste caso responde imediatamente para isolar a guarda; isso não simula três respostas reais de uma rede desligada. |
| `AUD2-F01: an offline resume must not occupy the request lock when the network returns` | `src/App.resilience.test.tsx:118` | O XHR real da aplicação recebe um transporte sintético que demora até o timeout de 20 s se iniciado offline. Em 1 s, `pageshow` inicia essa consulta; em 1,1 s, a rede volta, mas `online` não inicia a leitura útil. Só após timeout e backoff de 2 s a recuperação confirma. A confirmação chega até 23,1 s no teste, aproximadamente **22 s após a rede voltar**. Recupera sem repetir identidade. |

São POSTs para `/attempt/status`, que consultam a operação. **Não são novos comandos de liberação enviados à UniFi.** O terceiro teste conserva o adapter XHR da aplicação; apenas o comportamento do transporte é injetado. A permanência de um XHR offline até o timeout é uma condição sintética, não uma medição em iPhone, Android ou Povoão.

### Correção recomendada, ainda não aplicada

Aplicar as guardas de offline/visibilidade a toda consulta disparada automaticamente por timer ou evento de retomada, inclusive quando o timer finalmente executar. Preservar a retomada no próximo `online` e o respeito a `retry_after_ms`; não apagar capability nem reenviar identidade. A consulta explicitamente solicitada pelo botão pode continuar sendo uma exceção deliberada, pois `navigator.onLine` é apenas um sinal do navegador.

Critérios: os três casos acima passam, nenhum evento offline cria XHR, o retorno online consulta a mesma capability e os controles anteriores de StrictMode, singleflight, cooldown e status protegido permanecem válidos.

## Controles novos que passaram

### App real, 10 casos

- **Timeout com efeito remoto já confirmado:** o XHR de identify atinge 25 s; o backend sintético tinha confirmado em 24 s. A leitura de status em 27 s recupera a confirmação; a resposta de identify entregue em 30 s é ignorada. Uma inicialização, uma identificação e uma consulta de status. Não depende de reenviar identidade.
- **Capability expira durante identify:** confirmação tardia não é aceita com capability vencida; formulário reaparece sem reinicialização automática.
- **Troca de contexto durante identify:** dois casos, mesmo MAC/outra loja e outro MAC/mesma loja. Nenhuma confirmação antiga aparece no contexto novo.
- **Resposta malformada depois de confirmação:** três casos pelo adapter XHR real — HTML com HTTP 200, resultado `authorized=true/status=rejected` e `server_now` inválido. Todos são classificados como parse; confirmação anterior e capability são preservadas. Não são aceitos como uma nova confirmação.
- **Offline e aba oculta por 130 s:** retorno online consulta a mesma operação e recupera, sem nova identificação. Isso demonstra a retomada após pausa, não atendimento dentro de 120 s durante indisponibilidade de rede.
- **Servidor responde 410 antes da expiração local:** servidor continua autoridade; capability é descartada e identidade explícita volta a ser exigida.
- **Timeout seguido de `awaiting_identity`:** para a consulta e volta ao formulário, sem reenviar automaticamente durante os 60 s observados. A idempotência de eventual nova submissão explícita é uma responsabilidade do backend, não demonstrada por esse teste de UI.

### Estado entre documentos e abas, 8 casos

- Abas independentes têm tokens e memória independentes; limpar uma não apaga a outra.
- Cópia de sessionStorage do opener exige revalidação no documento novo; alteração da cópia não modifica a aba original.
- Abas clonadas antes da submissão mantêm `submitted` independente. O teste explicita que singleflight local **não é um mutex entre abas**; deduplicação remota continua necessária.
- Perda completa do módulo e restauração de tentativa pendente: consulta do tempo do servidor recusa capability realmente expirada.
- Storage totalmente negado mais perda do módulo: capability deixa de existir localmente; nenhum recibo confirmado é inventado.
- Falha de persistência ao marcar `submitted`, seguida de perda do módulo: o registro antigo recuperado exige consulta protegida.
- Cinco recriações do documento, com relógio do cliente retrocedendo: validade absoluta não muda e resposta legada sem tempo do servidor não elimina a necessidade de revalidação.
- Mudança de loja e retorno ao query original: recibo descartado não ressuscita do storage.

Os testes de abas/documentos usam instâncias independentes do módulo, objetos Storage separados ou copiados e origens monotônicas distintas. Não representam dois navegadores físicos nem atestam implementação de BFCache. Eventos `pageshow`, visibilidade e mudança de query são injetados no jsdom; a restauração real pelo sistema operacional permanece fora da evidência.

## Limites e relação com a meta de 99,9% em 120 s

Estes 21 casos são exemplos dirigidos, não uma amostra aleatória de usuários. **18/21 não estima taxa de sucesso operacional**, e corrigir os três vermelhos não provaria 99,9%. O defeito novo afeta consultas e a tela de retomada; o worker pode continuar liberando normalmente enquanto essa tela espera. Não há prova, nesta frente, de navegação externa nem de abandono causado pelo atraso.

Perder o processo com storage negado também perde a capability em memória. O controle aprovado documenta essa limitação; não afirma recuperação transparente. A reidentificação posterior precisa ser vinculada com segurança pelo backend à autorização existente. Duas abas podem apresentar a mesma capability clonada ou capabilities diferentes para o mesmo dispositivo; esses casos exigem testes de join/quota/challenge e unicidade de comando no backend.

Para avaliar a meta em Povoão, tentativas com identidade validada que ficam presas ou são abandonadas precisam continuar no denominador. Deve-se medir início, confirmação e prova de navegação externa, distinguindo resposta da controladora, redirecionamento tentado e página realmente alcançada. Nenhum percentual operacional, tamanho de amostra suficiente ou intervalo de confiança foi inferido destes testes.
