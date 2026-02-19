

## Problema

Quando a aplicacao e uma SPA (Single Page Application), acessar diretamente URLs como `/s/loja_teste` pode resultar em 404 porque o servidor web tenta encontrar um arquivo fisico nesse caminho em vez de servir o `index.html` e deixar o React Router resolver a rota.

No React Router, a rota `/s/:slug` ja e dinamica e aceita qualquer slug -- nao e necessario registrar cada loja. O problema esta no servidor web, nao no codigo.

## Solucao

Adicionar um arquivo `public/_redirects` para garantir que qualquer rota desconhecida redirecione para `index.html` (padrao SPA fallback). Isso funciona em hosts como Netlify, e o Lovable preview ja suporta nativamente.

Adicionalmente, criar um `public/404.html` que redireciona para `index.html` via meta refresh -- isso cobre hosts como GitHub Pages e servidores estaticos simples.

### Arquivos a criar

**1. `public/_redirects`**
```
/*    /index.html   200
```
Uma unica linha. Garante que qualquer caminho serve o `index.html` com status 200 (nao redirect), permitindo que o React Router processe a URL no cliente.

**2. `public/404.html`**
Um HTML minimo que redireciona automaticamente para a mesma URL via `index.html`. Isso cobre servidores que servem `404.html` para rotas desconhecidas (como GitHub Pages):

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script>
    // Redireciona para index.html preservando o path
    sessionStorage.setItem('redirect', window.location.href);
    window.location.replace('/');
  </script>
</head>
<body></body>
</html>
```

**3. Ajuste em `src/main.tsx`** (ou `src/App.tsx`)
Adicionar um trecho no carregamento inicial que verifica se ha um redirect salvo no sessionStorage e navega para ele:

```typescript
// No inicio do App, antes do return
const redirect = sessionStorage.getItem('redirect');
if (redirect) {
  sessionStorage.removeItem('redirect');
  const url = new URL(redirect);
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
```

### Detalhes tecnicos

- **`_redirects`**: Padrao do Netlify/Lovable para SPA fallback
- **`404.html`**: Fallback para GitHub Pages e servidores estaticos
- **sessionStorage redirect**: Tecnica padrao para preservar a URL original quando o servidor serve 404.html
- Nenhuma mudanca na logica de negocio, rotas ou UI
- Nenhuma mudanca no banco de dados

### Resultado esperado

- Acessar `/s/loja_teste` (ou qualquer slug) diretamente funciona em qualquer ambiente de hospedagem
- Refresh da pagina em qualquer rota funciona sem 404
- Nenhum impacto em rotas existentes

