# Correção da admissão em rede compartilhada — 26/09/2026

Achado tratado: **NEW-B01**, cliente válido número 21 bloqueado por outros clientes no mesmo IP público. A correção não altera o envio à controladora, a confirmação de liberação ou o prazo da operação durável.

## Comportamento

`/identify` chama `admit_captive_identity` depois da validação do capability. O banco busca MAC e loja na tentativa persistida; campos alternativos enviados no corpo de `/identify` não podem trocar essas dimensões. O MAC persistido é um identificador do contexto captivo, **não uma nova prova de presença na controladora**. A verificação de presença/autorização existente continua necessária.

| Proteção | Regra |
| --- | --- |
| Criação de capability (`/attempt/init`, já existente) | 5 por MAC em 60 s; bloqueio de 300 s |
| Identidade CPF + telefone | 8 novas admissões em 300 s; mantém bloqueio de 900 s |
| Dispositivo na loja | 8 novas admissões em 300 s; bloqueio de 300 s |
| Origem de rede na loja | Teto emergencial de 1.000 novas admissões em 300 s; espera somente até o fim dessa janela |
| IP ausente | Teto emergencial separado por loja; não junta todas as lojas em `unknown` |
| Requisições de um capability ainda sem operação | 20 em 60 s; bloqueio de 60 s |
| Capability já admitido | Retoma o status; não passa novamente pelo limitador nem envia nova autorização |

O teto de 1.000 é uma proteção emergencial contra origens que geram muitos identificadores. Não representa capacidade medida da controladora nem garante 1.000 liberações em 120 segundos. Os limites individuais conservam a defesa para um dispositivo ou uma identidade sem transformar 20 clientes distintos numa origem abusiva.

## Atomicidade e repetição

Um recibo de quota é identificado por `(attempt_id, identity_hash)`. Repetir os mesmos dados, inclusive depois de uma falha de dependência anterior à operação, reutiliza o recibo: não cobra novamente dispositivo, identidade ou origem. O limitador curto de requisições continua contando requisições reais para impedir repetição ilimitada de consultas dispendiosas.

As três dimensões de admissão são bloqueadas em ordem consistente e verificadas antes de qualquer débito. Se uma negar, nenhuma das outras é debitada. O prazo retornado é o maior bloqueio aplicável e não avança quando uma requisição chega durante o bloqueio.

O banco revalida a expiração depois dos pontos de espera: bloqueio da tentativa, contador de requisições e bloqueios das dimensões. Um recibo não é reutilizável se MAC, AP, SSID ou loja persistidos mudarem. Erros da RPC interrompem a admissão com HTTP 503.

## Verificação

- **20 testes em PostgreSQL 17.10 real**, descartável, em `127.0.0.1:55459`, todos aprovados.
- Fluxos completos dos handlers reais de `/attempt/init` e `/identify`: **21 e 300 clientes diferentes atrás do mesmo NAT**, todos chegam à fronteira de admissão durável. Mais **21 sem IP público**, todos chegam.
- Concorrência com 12 conexões reais: a mesma admissão tem um recibo e um débito; uma identidade em 12 capabilities tem no máximo oito admissões; uma origem com 996 admissões concede somente as quatro vagas restantes de 1.000.
- Testes de bloqueio individual, origem emergencial, ausência de débito parcial, espera legítima, repetição após falha de dependência e resposta RPC perdida após commit, expiração durante espera em locks reais, capability cancelado, contexto alterado e erro de banco.
- Execução efetiva da RPC como `service_role`; `anon` e `authenticated` sem acesso; RLS ativa. Exclusão de uma tentativa remove seu recibo por FK `ON DELETE CASCADE`.
- **7 testes Vitest** do contrato HTTP, todos aprovados; lint do teste e checagem Deno do handler aprovados.

Comando permanente: `node tests/database/admission.mjs` depois de instalar as dependências de `tests/database`. Os testes não usam credenciais do ambiente nem fazem chamadas externas. Conferem diretório de dados, processo filho e PID antes de modificar o banco local e encerram somente o processo que criaram. Artefatos: `tmp/post-audit-fixes-20260926/admission/results.json` e `server-last.log`.

As fixtures de descoberta de loja, cadastro e fronteira da operação são locais. Estes testes comprovam os critérios de admissão e proteção contra abuso; não medem latência da controladora, presença física no Wi-Fi ou o SLO de liberação em campo.

## Implantação

Aplicar primeiro `20260926180137_nat_safe_identity_admission.sql`; depois publicar a função `captive-portal` atualizada. A migration é aditiva e não remove limites antigos de outros endpoints. Publicar a função antes da migration retorna HTTP 503 em novas identificações, porque a RPC ainda não existirá. O frontend anterior é compatível com a resposta HTTP; as demais correções de frontend desta revisão têm implantação própria.

Não houve aplicação de migration remota, publicação de função ou alteração de clientes durante estes testes. Após revisão independente, a entrega foi aplicada na versão 255 do backend; ver `correcoes-auditoria-20260926.md`. O arquivo gerado inicialmente pelo CLI foi renomeado para a versão registrada pelo serviço de migrações, sem alteração do SQL testado.
