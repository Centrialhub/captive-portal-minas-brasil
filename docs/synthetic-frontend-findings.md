# Testes sintéticos do frontend — 25/09/2026

## Escopo e reprodução

Checkout canônico: `F:\captive MB\tmp\reliability-release-20260925`.
Base examinada: `1b2eefbb3ab9108c4ca46fdea86626c6f81dc942`.
Somente arquivos novos de teste e este relatório foram escritos nesta rodada. Nenhuma implementação, configuração de produção, cliente real, navegador real ou controladora foi alterada/acessada.

Os testes renderizam **App e SuccessView reais** com React Testing Library, jsdom e timers do Vitest. API e Supabase Auth são simulados com dados sintéticos; um caso usa o adaptador XHR real com um transporte sintético que dispara seu timeout. `window.location.replace` é interceptado apenas nos testes de navegação; não existe navegação externa.

Executar a partir do checkout:

```powershell
node node_modules/vitest/vitest.mjs run src/App.synthetic.test.tsx src/lib/attempt-tracker.synthetic.test.ts --reporter verbose
```

Resultado em 25/09/2026: **17 testes; 11 passaram, 6 falharam; cinco classes novas de problema.** Os seis testes vermelhos são intencionais: expressam o comportamento desejado e preservam a reprodução antes de corrigir a implementação. Não são `skip`, `todo` ou `it.fails`.

TypeScript (`tsc -b tsconfig.json`) passou. A execução inicial desta frente focou os testes novos. Na validação integrada posterior, os testes anteriores também foram reexecutados: a suíte de aplicação completa terminou com 199 casos, 177 aprovados e 22 reprovados. O consolidado está em `testes-sinteticos-povao-2026-09-25.md`.

## Resumo dos achados

| ID | Prioridade sugerida | Evidência sintética | Limite da conclusão |
| --- | --- | --- | --- |
| SYN-F01 | P3 hoje | StrictMode + capability pendente: resposta confirmed descartada, tela ainda sem sucesso após 30 s | `src/main.tsx` atual não usa StrictMode; falha latente de ciclo de efeito, não incidente demonstrado no bundle atual |
| SYN-F02 | P2 | Relógio cliente 20 min adiantado: init e identify confirmam no servidor simulado, UI descarta a confirmação | Exige relógio incorreto; não medimos frequência em clientes reais |
| SYN-F03 / F03b | P2 | 20 eventos concluídos geram 21 consultas em 200 ms; cinco revalidações em 4 s impedem o redirect previsto para 2 s | São POSTs de status; não houve reenviar identify nem comando UniFi nos testes |
| SYN-F04 | P2 | init 429/Retry-After 30 s seguido de remontagem executa outro init antes do prazo | Quota no servidor continua válida; perda é da espera e recuperação do frontend |
| SYN-F05 | P2 | `location.replace` lança SecurityError; botão continua desabilitado 5 s depois | A exceção foi injetada; ocorrência física em CNA não foi demonstrada |

## SYN-F01 — efeito retomado fica preso ao request invalidado

Teste: `src/App.synthetic.test.tsx:96`, nome exato:

`SYN-F01: StrictMode resumes a stored operation after effect cleanup invalidates its first response`

Reprodução:

1. Criar capability sintética e marcá-la como submitted.
2. Montar `<StrictMode><MemoryRouter><App /></MemoryRouter></StrictMode>`.
3. `/attempt/status` resolve `confirmed` imediatamente.
4. Avançar timers em 30 s. A asserção que espera `Wi-Fi liberado!` recebe `null`.

Sequência no código: o primeiro setup inicia `checkStatus` e define `inFlightRef=true` (`src/App.tsx:211`, `:223`). O cleanup aumenta `epochRef` (`:315`), invalidando a resposta antiga. O segundo setup encontra a chamada em voo e retorna. Quando a primeira resposta termina, `applyResult` a ignora (`:113`) e o `finally` só libera `inFlightRef`; `setBusy(false)` também é cercado pelo epoch antigo (`:235`). Não há timer de polling para continuar. Um evento externo de retomada pode recuperar; o botão permanece indisponível enquanto não ocorrer isso.

Correção proposta: tornar a propriedade da chamada explícita por geração/request ID e fazer o novo setup reassumir ou reagendar a consulta. O `finally` de uma geração antiga não pode limpar o lock de uma geração nova. Manter o bloqueio de envio inicial duplicado. Critério: StrictMode com capability pendente termina em confirmed ou pending com consulta agendada/botão funcional; no máximo uma identidade enviada.

## SYN-F02 — validade decidida pelo relógio do cliente descarta verdade do servidor

Teste: `src/App.synthetic.test.tsx:152`, nome exato:

`SYN-F02: accepts a current server confirmation when the device clock is twenty minutes fast`

Reprodução:

1. Relógio do servidor simulado em `2026-09-25T18:00:00Z`; init retorna expiração às 18:10.
2. Relógio do dispositivo simulado às 18:20 antes de montar App.
3. Usuário sintético envia o formulário; identify retorna authorized=true/confirmed.
4. `api.identify` é chamado uma vez, mas a tela de sucesso não aparece. A interface volta à identificação.

Causa: `AttemptTracker.get()` elimina a capability com `Date.parse(expires_at) <= Date.now()` (`src/lib/attempt-tracker.ts:66`), usando relógios sem referência comum. `markSubmitted` já pode apagar o registro antes do identify; o retorno confirmado depois é descartado pela checagem de capability em `src/App.tsx:114`. O orçamento de polling baseado em `deadline_at` também usa o relógio local (`src/App.tsx:155`).

Correção proposta: transportar referência temporal do servidor/TTL e medir prazos locais com duração monotônica; servidor continua autoridade de validade (401/410). Persistir uma referência de prazo coerente para reload e preferir verificação de status se não for possível determinar idade com segurança. Não transformar uma comparação de relógio local em prova de que um resultado servidor confirmed está obsoleto. Critério: com desvios ±20 min, confirmação válida aparece e polling respeita durações; expiração real/contexto diferente continuam protegidos.

## SYN-F03 — retomadas após sucesso não têm intervalo mínimo e desmontam SuccessView

Testes:

- `src/App.synthetic.test.tsx:181`: `SYN-F03: bounds completed status reads during a short storm after confirmation`
- `src/App.synthetic.test.tsx:196`: `SYN-F03b: successful revalidation does not keep postponing the existing redirect deadline`

Reprodução de carga:

1. Montar uma capability com receipt; status resolve confirmed.
2. Disparar 20 `visibilitychange`, cada um depois que a resposta anterior terminou, com 10 ms entre eles.
3. Resultado: **21 chamadas de status em 200 ms** (uma inicial + 20 retomadas). Esperado pelo teste: no máximo duas no mesmo intervalo. Não houve identify.

Reprodução do redirect:

1. Identify confirma e SuccessView inicia seu timer de 2 s.
2. Disparar uma retomada a cada 800 ms, cinco vezes; cada status retorna confirmed.
3. Aos 4 s, `location.replace` continua com **zero chamadas**; cada retomada desmontou/recriou a tela e reiniciou seu timer.

Causa: `checkStatus` impede concorrência, mas não chamadas sequenciais rápidas após um resultado terminal; `nextCheckRef` só recebe atraso em pending/erro. Toda consulta executa `showStep("pending")` (`src/App.tsx:226`), mesmo tendo confirmação já exibida. SuccessView perde o timer ao desmontar (`src/components/SuccessView.tsx:33`).

Correção proposta: aplicar intervalo mínimo/debounce para retomadas, incluindo confirmed; revalidar receipt em segundo plano preservando a tela e o prazo de redirect, com política explícita para 401/410/contexto alterado. Manter consulta obrigatória quando uma nova instância restaura receipt local. Critério: tempestade sequencial é limitada, não reenvia identidade, não reinicia indefinidamente o redirect e não toma receipt local como autorização sem servidor.

## SYN-F04 — cooldown do init desaparece ao remontar

Teste: `src/App.synthetic.test.tsx:274`, nome exato:

`SYN-F04: preserves an init Retry-After across remount before silent login can create another capability`

Reprodução:

1. `getSession` encontra token sintético, iniciando login silencioso.
2. Init retorna HTTP 429 com `retryAfterMs=30000`; botão mostra `Aguarde 30 s` corretamente.
3. Desmontar/remontar App imediatamente com a mesma sessão/contexto; avançar 5 s.
4. Contagem de init é **2**, embora o prazo da primeira resposta ainda esteja em vigor; authorizeExisting permanece em zero.

Causa: o cooldown existe somente em refs/state de App (`src/App.tsx:188`); não há capability para retomar e o novo mount começa em zero, repetindo a inicialização silenciosa. Pode acontecer em reload e navegação de política/retorno. O servidor continua protegendo a quota, portanto isso não demonstra bypass de limite nem comando duplicado.

Correção proposta: guardar o próximo instante permitido por contexto no tracker, com memória + armazenamento protegido, e consultar esse estado antes de init/silent. Associar o intervalo a tempo confiável (SYN-F02), expirar sem loop e deixar claro quando o usuário pode tentar novamente. Critério: remontagem antes do prazo não faz novo init; após o prazo uma ação permitida faz no máximo uma inicialização.

## SYN-F05 — exceção de navegação deixa botão bloqueado

Teste: `src/App.synthetic.test.tsx:214`, nome exato:

`SYN-F05: a synchronously blocked navigation eventually restores the continue button`

Reprodução:

1. Identify retorna confirmed e a tela de sucesso é exibida.
2. Substituir somente `location.replace` por função que lança `DOMException` com nome `SecurityError`.
3. Aos 2 s, ocorre uma chamada e a exceção esperada; avançar mais 5 s.
4. Wi-Fi continua corretamente exibido como confirmado, porém `Continuar agora` permanece **disabled=true**.

Causa: `setNavigating(true)` acontece antes de `location.replace`, e o timer que reabilita o botão é criado somente após essa chamada (`src/components/SuccessView.tsx:24`, `:28`, `:30`). A exceção pula a criação do timer.

Correção proposta: criar/liberar o estado de navegação em `try/finally`, capturar a falha sem regredir o estado de Wi-Fi e permitir nova ação manual. Registrar falha de navegação como tal, preservando a distinção entre intenção e entrega. Critério: exceção síncrona e navegação que não fecha a página deixam alternativa manual funcional; não criar repetição automática infinita.

## Controles que passaram

Oito casos em App e três em tracker passaram:

- Resposta tardia de uma instância desmontada não altera a instância nova.
- Mudança de AP/visita enquanto status está em voo impede sucesso de contexto antigo.
- Capacidade que expira durante consulta volta ao formulário, sem init automático.
- Cem eventos enquanto uma consulta está em voo resultam em uma só chamada.
- Timers de redirect são limpos na desmontagem; remontagem navega uma vez e receipt impede nova navegação automática.
- Storage bloqueado mantém a tentativa em memória e permite retomada na remontagem do componente. Isso não promete recuperação depois de perda completa do processo sem armazenamento.
- Offline pausa consultas; online retoma a mesma operação.
- Adaptador XHR real usa timeout de **20 s** e preserva tentativa/consulta de status após timeout; não reenvia identify. Não foi usado um mock que simplesmente nunca resolve para alegar falha ignorando o timeout já existente.
- Inicializações de contextos distintos concluídas fora de ordem preservam somente a capability nova.
- Clear explícito seguido de init novo impede ressurreição de init antigo no mesmo contexto.
- Falha de escrita após init mantém submitted em memória e não cria outro init.

## Arquivos entregues

- `src/App.synthetic.test.tsx` — 14 casos; 8 verdes, 6 vermelhos.
- `src/lib/attempt-tracker.synthetic.test.ts` — 3 casos verdes.
- `docs/synthetic-frontend-findings.md` — este relatório.

Os achados descrevem resultados determinísticos de simulação e suas causas no código. Não atribuem esses cinco mecanismos a clientes reais sem evidência de campo adicional.
