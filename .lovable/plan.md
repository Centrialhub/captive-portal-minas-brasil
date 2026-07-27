# Plano: Atualizar/validar Dockerfile para o novo domínio HTTPS

## O que foi enviado

O Dockerfile correto já foi fornecido na resposta acima. Ele reflete o estado atual do repositório com as seguintes características:

- Escuta na porta `3000`
- Redireciona todos os probes do Captive Network Assistant para `https://drogariaminasbrasilapp.com.br`
- Mantém o proxy `/api/captive-portal/` para o Supabase Edge Function
- Remove os locations `/unifi/` e `/unifi-proxy/` (pois as controladoras agora possuem certificado público válido e a Edge Function se conecta diretamente)
- Inclui SPA fallback preservando query params

## Alterações principais em relação ao arquivo antigo

1. **Porta**: `listen 80` → `listen 3000` (alinhado ao Dockerfile atual do repositório)
2. **Domínio**: `http://wifi.guedesepaixao.com.br` → `https://drogariaminasbrasilapp.com.br`
3. **Protocolo**: `X-Forwarded-Proto http` → `X-Forwarded-Proto https`
4. **Probes CNA**: adicionados `/generate_204`, `/gen_204`, `/hotspot-detect.html`, `/library/test/success.html`, `/connecttest.txt`, `/ncsi.txt`
5. **SPA fallback**: `try_files $uri /index.html?$args`
6. **Remoção de proxies**: `/unifi/` e `/unifi-proxy/` removidos por obsolescência

## Próximos passos

1. Aplicar o Dockerfile fornecido ao repositório.
2. Atualizar `README.md` para refletir o novo domínio no Walled Garden.
3. Validar o build do container (`docker build -t captive-proxy .`).
4. Verificar se a porta exposta no EasyPanel está configurada para `3000` (ou ajustar para `80` se necessário).

## Decisões pendentes

- A porta do EasyPanel é `80` ou `3000`?
- É necessário manter algum proxy legado (`/unifi/` ou `/unifi-proxy/`) por algum outro serviço?

Aprovar este plano para aplicar o Dockerfile e os ajustes de documentação.