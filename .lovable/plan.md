Diagnóstico encontrado:

- O `/submit` agora chega ao Supabase em alguns testes e salvou um lead recente, mas o usuário ainda recebe `failed to fetch`. Isso indica que o cadastro pode estar sendo processado no backend, porém a resposta não volta de forma confiável para o Captive Assistant/navegador.
- O domínio publicado ainda depende de `fetch`/`AbortController` no React. Em captive portals, especialmente iPhone/Android captive assistant, isso é sensível a aborts e quedas de conexão.
- O fallback HTML em `index.html` usa XHR mais compatível, mas ainda tem timeout curto de 15s e não possui fallback direto para Supabase se o proxy falhar.
- O backend ainda pode gastar tempo antes de responder por causa de GeoIP, auditoria, criação de verificação e envio WhatsApp em background via `waitUntil`. Mesmo com a melhoria anterior, há espaço para tornar `/submit` mais rápido e impossível de ficar preso por integrações externas.
- O health check no domínio real respondeu a página HTML, não `ok`, então o Dockerfile/proxy aplicado fora do repositório provavelmente não tem `/health` correto ou não está usando o Dockerfile atual do projeto.

Plano de correção:

1. Tornar o cliente mais compatível com Captive Assistant
   - Substituir o uso crítico de `fetch + AbortController` por uma camada `XMLHttpRequest` para POSTs sensíveis (`/start`, `/submit`, `/request-code`, `/verify-code`).
   - Manter fallback automático: primeiro `/api/captive-portal`, depois Supabase direto (`https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal`) quando houver erro de rede, timeout ou status 502/503/504.
   - Diferenciar mensagens: timeout, erro de rede, resposta não JSON e erro HTTP, para não mostrar apenas `failed to fetch`.
   - Impedir duplicidade visual: se o backend já salvou o cadastro e a resposta falhar, tentar recuperar o estado da sessão antes de reenviar.

2. Atualizar também o fallback vanilla do `index.html`
   - Aplicar a mesma lógica resiliente no portal fallback: timeout maior para `/submit`, fallback para Supabase direto e mensagens claras.
   - Corrigir `/request-code` para não ficar preso em 15s se o WhatsApp demorar.
   - Garantir que em dispositivos onde o bundle React falhe, o fluxo completo ainda funcione.

3. Acelerar e endurecer `/submit` no Edge Function
   - Adicionar logs explícitos de entrada/saída de `/submit` com `session_id`, MAC e duração, sem dados sensíveis.
   - Fazer tarefas não essenciais em background: incremento de cluster, audit log e envio WhatsApp.
   - Adicionar timeout curto interno no webhook WhatsApp (ex.: 8s) para que ele nunca prenda a função.
   - Garantir que a resposta do `/submit` seja enviada imediatamente após salvar lead + verificação, sem depender de integrações externas.
   - Se houver falha ao inserir auditoria ou GeoIP, não bloquear o cadastro.

4. Melhorar recuperação no frontend após falha de resposta
   - Se `/submit` der erro de rede depois de já ter um `session_id`, chamar um endpoint leve de status da sessão para verificar se a verificação foi criada.
   - Se existir verificação pendente, avançar para tela de OTP mesmo que a resposta original tenha se perdido.
   - Se não existir, permitir tentar novamente sem bater no dedup/limite de forma confusa.

5. Adicionar endpoint público seguro de estado da sessão
   - Criar `POST /session-status` aceitando `session_id`.
   - Retornar apenas informações mínimas: `submitted`, `requires_verification`, `phone_masked`, `redirect_url`.
   - Não expor OTP, CPF, nome completo ou dados sensíveis.

6. Entregar Dockerfile completo para você aplicar no proxy externo
   - Manter build React + nginx.
   - Corrigir `/health` para retornar `ok` antes do fallback SPA.
   - Manter `/api/captive-portal/` com timeouts e CORS.
   - Preservar `/guest/s/default/` redirecionando para `https://wifi.guedesepaixao.com.br/?store=matriz&$args`.
   - Incluir o conteúdo inteiro do Dockerfile na resposta final, porque você informou que precisa aplicar manualmente.

7. Validação após implementação
   - Testar via Supabase direto com `curl_edge_functions`: `/bootstrap`, `/start`, `/submit`, `/session-status`.
   - Verificar logs recentes do Edge Function confirmando duração do `/submit`.
   - Testar o domínio publicado com `curl` para `/health`, OPTIONS e `/api/captive-portal/bootstrap`.
   - Informar exatamente o que foi corrigido e o que você precisa atualizar no EasyPanel/Publish.

Resultado esperado:

- O cadastro deixa de depender da resposta perfeita do `fetch` no captive assistant.
- Mesmo se o proxy ou navegador abortar a resposta, o sistema consegue detectar que o cadastro foi salvo e avançar para OTP.
- O `/submit` responde rápido e não fica preso por WhatsApp, GeoIP, audit log ou proxy.
- O Dockerfile externo passa a ter health check correto e proxy com timeouts adequados.