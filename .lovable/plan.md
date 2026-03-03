

# Tornar o Portal Resiliente a Falhas de Rede

## Diagnóstico

A configuração do UniFi está correta — o domínio e o IP do Vercel estão no walled garden. O problema é que o **captive assistant** (mini-browser do Android/iOS) tem restrições adicionais que podem bloquear chamadas HTTPS ou assets JS antes da autorização completa.

Como não podemos controlar o comportamento do captive assistant, a solução é **tornar o portal funcional mesmo quando o bootstrap falha**.

## Solução

Modificar `src/pages/CaptivePortal.tsx` para:

1. **Mostrar o formulário imediatamente** com dados fallback em vez de travar com "Erro ao conectar"
2. **Tentar bootstrap em background** — se conseguir, atualiza os dados; se não, o formulário já está visível
3. **Submeter lead mesmo sem session_id** — o backend já aceita isso

### Dados fallback quando bootstrap falha:
- Nome da loja: "Drogaria Minas Brasil"  
- Consent text: texto padrão da LGPD hardcoded
- Consent version: "offline-fallback"

### Mudança no fluxo:
- Atual: loading → bootstrap → (erro = tela travada) | (ok = formulário)
- Novo: loading breve → formulário com fallback → bootstrap atualiza dados se conseguir

### Arquivo modificado:
- `src/pages/CaptivePortal.tsx` — useEffect de inicialização e estado inicial

Nenhuma mudança no backend, no `vercel.json`, ou no `api.ts`.

