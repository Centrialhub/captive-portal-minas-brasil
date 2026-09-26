# Correção de carregamento do frontend — 26/09/2026

Base: main `153dd87ae34f0c9adc3b6454e4368d8c5949c836`.

## Alterações

- Proteção de `globalThis` executada antes das dependências do aplicativo.
- Inicializador incorporado ao HTML, sem uma requisição adicional. O build calcula o SHA-256 dos bytes finais, e o Nginx autoriza somente esse script na CSP, preservando `script-src 'self'` sem `unsafe-inline` para scripts.
- Recuperação independente do React para erro de módulo, CSS e inicialização. Um único prazo de dez segundos mantém a recuperação possível mesmo com recursos pendurados. Folhas de estilo ainda não carregadas são removidas quando impedem a pintura; uma confirmação tardia não esconde esse erro.
- Botão de recarga manual com ação registrada antes de `DOMContentLoaded`, preservando URL, parâmetros e armazenamento. Nenhuma recarga automática ou chamada de autorização foi acrescentada.
- Orientação para navegador sem módulos e limite de erro de renderização no React.
- HTML com revalidação; arquivos versionados com cache longo; arquivos ausentes em `/assets/` com 404 real e sem cache. Cabeçalhos de segurança, proxy e redirecionamentos preservados.
- Retenção dos arquivos públicos JS/CSS da publicação anterior, com hashes e limites de descompactação. Ver `compat/previous-frontend/README.md` para manutenção.

## Revisão e verificação

Foram corrigidos durante a revisão dois problemas da primeira implementação: o botão que dependia de um evento adiado por downloads pendurados e a dependência de uma requisição separada para o próprio preboot. A matriz também levou à proteção contra CSS que impedia a pintura da recuperação e à manutenção do prazo após falhas precoces.

- `npm run check`: integridade dos assets, contratos, segurança, lint, tipos do frontend/Edge Function, testes e build.
- `npm run check:previous-assets`: 14 testes de retenção, incluindo adulteração, tamanho, caminhos, colisões, dependências e repetição segura.
- `npm run verify:startup`: matriz no bundle compilado, com CSP real, API exclusivamente local e bloqueio de origens externas. Requer Playwright/Chromium disponível; `PORTAL_PLAYWRIGHT_MODULE` permite indicar uma instalação existente. O HTML real anterior pode ser fornecido em `PORTAL_STARTUP_PREVIOUS_HTML`.
- `npm run verify:delivery`: configuração extraída do Dockerfile, validada com Nginx 1.30.4 real. Nove verificações HTTP e rejeição de três hashes inválidos. Requer `NGINX_BINARY` apontando para uma instalação disponível.
- `npm run verify:production`: valida identidade da publicação, hash do preboot/CSP, cache, 404, contrato do bundle e serviços de saúde, sem identificar ou autorizar cliente sintético.

Os resultados detalhados locais são gravados em `tmp/portal-startup/results.json` e `tmp/android-release-check.log`. Processos dos ensaios são encerrados ao final.

Resultado final antes da publicação: 261 testes Vitest, 14 testes de retenção e 23 cenários de navegador aprovados. Os 23 cenários incluem o HTML real anterior e falhas combinadas de módulo/CSS. Nenhum pedido externo ou de nova autorização foi enviado pela matriz. A revisão independente não encontrou bloqueios restantes neste conjunto.

## Limites

Esta correção trata a entrega e execução da página. Os ensaios em Chromium com identificação Android e falhas injetadas não são uma execução do detector de portal do Android na rede de visitantes. Não certificam a meta de 99,9%, nem encerram as demais falhas da auditoria anterior.

O banco, a Edge Function e a controladora não foram alterados nesta publicação. O usuário informou separadamente a remoção de `www.google.com`, `gstatic.com`, `googleapis.com` e `www.gstatic.com` do walled garden.

A atualização em main precisa ser seguida pelo build/implantação do frontend na hospedagem. A identidade de main e a identidade servida publicamente devem ser verificadas separadamente.
