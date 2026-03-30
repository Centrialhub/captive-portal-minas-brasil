

## Atualizar URL do controller da Matriz para usar o proxy

### O que será feito
Executar um UPDATE na tabela `stores` para apontar a `unifi_controller_url` da Loja Matriz para o proxy HTTPS em vez de acessar o controller diretamente.

### SQL a executar
```sql
UPDATE stores 
SET unifi_controller_url = 'https://wifi.guedesepaixao.com.br/unifi-proxy/'
WHERE slug = 'matriz';
```

### Antes → Depois
| Campo | Antes | Depois |
|---|---|---|
| `unifi_controller_url` | `http://rwificontroller...8083/matriz/` | `https://wifi.guedesepaixao.com.br/unifi-proxy/` |

### Resultado
A Edge Function passará a fazer chamadas UniFi via proxy com SSL válido, eliminando o erro de certificado.

