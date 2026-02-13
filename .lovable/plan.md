
## Objetivo
Corrigir a função `requireAdmin()` na Edge Function `captive-portal/index.ts` para usar `getUser(token)` em vez de `getClaims(token)`, melhorando a compatibilidade com diferentes versões do runtime Supabase Edge.

## Contexto Atual
A função `requireAdmin()` (linhas 564-590) implementa autenticação e autorização para endpoints administrativos:
1. Extrai o token do header `Authorization: Bearer <token>`
2. Valida o token usando `authClient.auth.getClaims(token)` 
3. Obtém o `user_id` de `data.claims.sub`
4. Consulta a tabela `user_roles` para verificar se o usuário tem role `admin`
5. Retorna `{ db, userId }` se autorizado, ou erro 401/403 caso contrário

## Problema
`getClaims(token)` pode falhar ou comportar-se inconsistentemente em diferentes versões do supabase-js ou runtime do Deno no Supabase Edge. O método `getUser(token)` é mais estável e é o padrão recomendado.

## Implementação Planejada

### 1. Substituição em `requireAdmin()` (linhas 564-590)
- **Remover**: `const { data, error } = await authClient.auth.getClaims(token);`
- **Remover**: Extração de `userId` via `data.claims.sub`
- **Adicionar**: `const { data: userData, error: userErr } = await authClient.auth.getUser(token);`
- **Adicionar**: Validação `if (userErr || !userData?.user) return errorResponse("Unauthorized", 401);`
- **Adicionar**: Extração de `userId = userData.user.id`
- **Adicionar**: `console.warn()` para erros de autenticação (sem imprimir o token)

**Fluxo após mudança:**
```
1. Extrair token do header Authorization
2. Chamar authClient.auth.getUser(token)
3. Se erro ou sem usuário → 401
4. Extrair userId de userData.user.id
5. Consultar user_roles com userId
6. Se role 'admin' não existe → 403
7. Se tudo OK → retornar { db, userId }
```

### 2. Logging de Erros
- Adicionar `console.warn("Auth error:", error.message)` quando `getUser()` falhar
- **Nunca** imprimir o token ou dados sensíveis no log

### 3. Garantias de Compatibilidade
- Todas as 6 rotas admin que chamam `requireAdmin()` continuarão funcionando identicamente:
  - `handleAdminStores` (linhas 592+)
  - `handleAdminLeads` (linhas 675+)
  - `handleAdminLeadsXml` (linhas 869+)
  - `handleAdminConsent` (linhas 736+)
  - `handleAdminSessions` (linhas 775+)
  - `handleTestAuthorize` (linhas 800+)
- Código que chama `requireAdmin()` não precisa mudar (validação e retorno de erro/sucesso idênticos)
- Mensagens HTTP (401, 403) mantêm-se as mesmas

### 4. Mudanças de Código
**Arquivo**: `supabase/functions/captive-portal/index.ts`

**Linhas 564-590** (função `requireAdmin`):
```typescript
async function requireAdmin(req: Request): Promise<{ db: ReturnType<typeof supabaseAdmin>; userId: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Unauthorized", 401);
  }

  const authClient = supabaseAuth(authHeader);
  const token = authHeader.replace("Bearer ", "");
  
  // Usar getUser em vez de getClaims para melhor compatibilidade
  const { data: userData, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userData?.user) {
    if (userErr) console.warn("Auth error:", userErr.message);
    return errorResponse("Unauthorized", 401);
  }

  const userId = userData.user.id;
  const db = supabaseAdmin();

  const { data: roleData } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();

  if (!roleData) return errorResponse("Forbidden: admin role required", 403);

  return { db, userId };
}
```

## Validação Esperada
- ✓ Admin consegue fazer login em `/admin`
- ✓ Endpoints `/admin/stores`, `/admin/leads`, `/admin/leads-xml`, `/admin/consent`, `/admin/sessions` funcionam com autenticação
- ✓ Usuários sem role admin recebem 403 Forbidden
- ✓ Requests sem Authorization header recebem 401 Unauthorized
- ✓ Nenhum erro de runtime relacionado a `getClaims()`

## Escopo
- **Apenas** mudança interna em `requireAdmin()`
- Sem alteração de UI, rotas, APIs ou respostas
- Sem alteração de segurança (validações mantidas)
- Sem mudança de mensagens de erro visíveis ao cliente
