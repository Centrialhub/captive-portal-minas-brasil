# UniFi proxy na VPS

Esta imagem executa a ponte HTTP interna entre a Edge Function e o gateway
fixo das controladoras. O HTTPS público deve ser terminado pelo EasyPanel
(Traefik) em `unifiproxy.minasbrasilwifi.com.br` e encaminhado para a porta
interna `80` do serviço. Nunca publique essa porta diretamente na internet:
credenciais e cookies UniFi trafegam nessa comunicação.

A imagem já inclui as rotas das 12 lojas cadastradas, encaminhadas para o
gateway fixo `http://177.85.235.28:8083` com o prefixo original preservado.
Um `routes.conf` externo ainda pode ser
montado como somente leitura para substituir a rota padrão no futuro. Se o
serviço atual já possui esse volume, atualize-o com
`unifi-proxy/routes.conf.example`; um volume antigo substitui o conteúdo
embutido no Dockerfile.

Esta imagem segue o modo padrão suportado pela imagem oficial do Nginx: o
processo mestre inicia como `root` para abrir a porta 80 e preparar os arquivos
de execução, enquanto as requisições são processadas pelos workers `nginx`, sem
privilégios. Não configure `USER nginx` nem force um usuário no EasyPanel.

## Build

```sh
docker build --pull -f unifi-proxy/Dockerfile -t minasbrasil/unifi-proxy:1.1.0 .
```

## Execução

```sh
docker run -d \
  --name unifi-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:8083:80 \
  minasbrasil/unifi-proxy:1.1.0
```

No EasyPanel, adicione ao serviço o domínio
`unifiproxy.minasbrasilwifi.com.br`, selecione a porta interna `80`, protocolo
HTTP e habilite Let's Encrypt. Depois do TLS estar validado, a loja `matriz` no
Supabase deve usar `https://unifiproxy.minasbrasilwifi.com.br/<slug-da-loja>`.
Aplique a migration que altera esses endereços somente depois de `/healthz` e
as rotas de loja responderem pelo novo domínio.

Há um virtual host de referência em `ingress/nginx.conf.example`. Para a
primeira emissão, instale temporariamente apenas
`ingress/nginx-http-bootstrap.conf.example`, confirme que o DNS aponta para a
VPS e execute:

```sh
sudo mkdir -p /var/www/certbot
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot \
  --webroot-path /var/www/certbot \
  --domain unifiproxy.minasbrasilwifi.com.br
```

Não reutilize o certificado de outro subdomínio. Depois da emissão, substitua
o bootstrap por `ingress/nginx.conf.example` e valide:

```sh
sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent --show-error \
  https://unifiproxy.minasbrasilwifi.com.br/healthz
```

A resposta pública obrigatória é
`{"ok":true,"service":"unifi-proxy"}`. Certificado com nome divergente,
resposta `403` ou qualquer conteúdo HTML bloqueia a produção.

## Contrato do arquivo gerenciado

O arquivo montado contém apenas blocos `location`. Cada rota deve definir seu
`proxy_pass` e pode ajustar a reescrita de URI. Os padrões globais já preservam o
header `Cookie` completo e deixam passar todos os headers `Set-Cookie`; nenhuma
rota deve usar `proxy_hide_header Set-Cookie`.

Após uma atualização atômica de `routes.conf`, valide e recarregue:

```sh
docker exec unifi-proxy nginx -t
docker kill --signal=HUP unifi-proxy
curl --fail --silent https://unifiproxy.minasbrasilwifi.com.br/healthz
```
