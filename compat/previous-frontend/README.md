# Arquivos da publicação anterior

Este snapshot preserva os bytes públicos da release `153dd87ae34f0c9adc3b6454e4368d8c5949c836`, consultados em 26/09/2026. O HTML que um navegador já armazenou pode continuar apontando para esses nomes depois da próxima implantação.

O manifesto registra origem, revisão, data, nomes, tamanhos e SHA-256 dos arquivos comprimidos e originais. São apenas dois arquivos públicos JS/CSS, totalizando 123.925 bytes comprimidos. O logo compartilhado precisa existir com o hash registrado no novo build. Não há download durante a compilação.

`scripts/generate-build-info.cjs` chama `restorePreviousAssets(distPath)` depois do Vite. O restaurador valida todos os dados antes de gravar, limita a descompactação, restringe os destinos a nomes em `dist/assets` e rejeita colisões com conteúdo diferente. Alterar o código de um bundle antigo mantendo seu nome é proibido.

## Manutenção

- Antes de outra publicação, verificar quais documentos e arquivos anteriores ainda precisam ser atendidos. Este snapshot garante apenas a release identificada no manifesto; não conserva automaticamente cada build futuro.
- Para atualizar a versão preservada, capturar a publicação vigente com sua revisão e bytes exatos, revisar o conteúdo público, atualizar manifesto/snapshots e o pin `PREVIOUS_RELEASE` no restaurador. Conservar também todas as dependências referenciadas que deixem de existir no build atual.
- Executar `npm run check:previous-assets`, a compilação e o cenário `previous-release-cached-html` com o HTML real anterior. Registrar hashes e revisão na revisão de código.
- Remover uma versão preservada somente após avaliar os acessos a seus arquivos e a política de retenção da hospedagem. Não remover silenciosamente arquivos ainda necessários para clientes com documentos antigos.

A retenção mantém arquivos disponíveis. Ela não adiciona o novo preboot ao HTML já armazenado: para receber a nova proteção de compatibilidade, o navegador precisa carregar o novo documento.
