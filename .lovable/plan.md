

## Ajustes no Formulário do Portal Captive

### Mudancas planejadas no arquivo `src/pages/CaptivePortal.tsx`:

### 1. Todos os campos obrigatorios
- **E-mail**: adicionar `required` e label com asterisco "E-mail *"
- **Telefone**: adicionar `required` e label com asterisco "Telefone *"
- **Nome**: ja esta obrigatorio, manter como esta
- Remover a validacao `(!email && !phone)` do botao `disabled` -- agora todos sao required pelo HTML
- Remover a mensagem "Informe ao menos e-mail ou telefone"

### 2. Texto LGPD em dropdown colapsavel
- Substituir o bloco que mostra o texto do consentimento (linhas 226-241) por um elemento colapsavel usando `<details>/<summary>` nativo do HTML (sem precisar instalar nada)
- O summary mostrara algo como "Termos de Uso e Politica de Privacidade (LGPD)" com um icone de seta
- O texto completo ficara escondido por padrao, e o usuario clica para expandir se quiser ler
- O checkbox "Li e aceito os termos" ficara **fora** do collapsible, sempre visivel
- O botao "Conectar ao Wi-Fi" continuara logo abaixo, visivel sem scroll

### 3. Layout final (de cima para baixo, sem scroll necessario para o essencial)
```
[Logo]
[Slogan]
[Titulo WiFi]
[Nome *]
[E-mail *]
[Telefone *]
[> Termos de Uso e LGPD (clique para ler)]  <-- colapsado
[x] Li e aceito os termos
[Conectar ao Wi-Fi]
[Copyright]
```

### Detalhes tecnicos

**Arquivo**: `src/pages/CaptivePortal.tsx`

- Linhas 205-224: Adicionar `required` nos inputs de email e telefone, atualizar labels para incluir "*"
- Linhas 226-241: Substituir bloco de consentimento por `<details>` colapsavel + checkbox separado fora dele
- Linha 245: Remover `(!email && !phone)` da condicao `disabled` do botao
- Linhas 251-255: Remover bloco da mensagem "Informe ao menos e-mail ou telefone"
- Linhas 84-86: No `handleSubmit`, enviar email e phone como valores diretos (nao mais condicionais com `|| undefined`) ja que agora sao obrigatorios
- Estilizar o `<details>` com classes Tailwind para manter a identidade visual (borda, fundo muted, texto pequeno)
