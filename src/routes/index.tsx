export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 18 — CRIAR EXCLUSIVAMENTE A SUÍTE DE TESTES, OBSERVABILIDADE E GATE DE RELEASE
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">
          Impedir que uma versão com regressões seja publicada. Não implementar novas funcionalidades.
        </p>

        <h2 className="font-bold text-lg mb-2">Testes unitários:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>normalização de MAC;</li>
          <li>CPF válido/inválido;</li>
          <li>redirect;</li>
          <li>expiração de attempt;</li>
          <li>validação de token;</li>
          <li>transições de estado;</li>
          <li>mapeamento de erros;</li>
          <li>consentimentos;</li>
          <li>redaction.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Testes React:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>login;</li>
          <li>Google redirect;</li>
          <li>callback;</li>
          <li>timeout;</li>
          <li>CPF;</li>
          <li>sucesso;</li>
          <li>erro;</li>
          <li>retry;</li>
          <li>navegador externo;</li>
          <li>nenhuma violação de hooks;</li>
          <li>nenhum timer após unmount.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Integração:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>bootstrap;</li>
          <li>login/senha;</li>
          <li>Google com sessão simulada;</li>
          <li>CPF pendente;</li>
          <li>CPF duplicado;</li>
          <li>authorize-existing;</li>
          <li>JWT inválido;</li>
          <li>role admin;</li>
          <li>CORS;</li>
          <li>body excessivo;</li>
          <li>método inválido;</li>
          <li>rate limit indisponível.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Concorrência:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>20 chamadas simultâneas no mesmo attempt;</li>
          <li>evento INITIAL_SESSION + SIGNED_IN;</li>
          <li>refresh durante authorizing;</li>
          <li>resposta perdida e retry;</li>
          <li>callback duplicado;</li>
          <li>duas instâncias da Edge Function.</li>
        </ul>
        <p className="mb-4">Em todos esses testes, uma única chamada UniFi deve ser registrada.</p>

        <h2 className="font-bold text-lg mb-2">Segurança:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>rotas `/diag/*` e `/unifi/*` retornam 404;</li>
          <li>URL arbitrária não gera fetch;</li>
          <li>atualização direta de profiles é negada;</li>
          <li>open redirect é negado;</li>
          <li>secrets não aparecem no bundle;</li>
          <li>PII não aparece nos logs;</li>
          <li>rotas auth/admin exigem credenciais apropriadas.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">CI obrigatório:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>npm ci;</li>
          <li>lint;</li>
          <li>frontend typecheck;</li>
          <li>deno check;</li>
          <li>testes;</li>
          <li>build;</li>
          <li>docker build;</li>
          <li>nginx -t;</li>
          <li>secret scan;</li>
          <li>dependency audit;</li>
          <li>migration lint;</li>
          <li>smoke test da imagem.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Observabilidade:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>métricas por etapa sem PII;</li>
          <li>taxa de início, callback, CPF, autorização e sucesso;</li>
          <li>latência p50/p95/p99;</li>
          <li>callback timeout;</li>
          <li>DNS/upstream failures;</li>
          <li>UniFi call count por attempt;</li>
          <li>CRM outbox;</li>
          <li>alerta por aumento de erro;</li>
          <li>trace_id desde o frontend até o backend.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Deploy:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>imagem imutável identificada por digest;</li>
          <li>canary em uma loja;</li>
          <li>rollback para imagem anterior;</li>
          <li>migrations backward-compatible antes da troca;</li>
          <li>feature flag para Google e CRM;</li>
          <li>nenhum deploy direto da branch de desenvolvimento.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Gate:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>zero P0/P1 conhecidos;</li>
          <li>100% dos testes determinísticos aprovados;</li>
          <li>teste de concorrência confirma uma chamada UniFi;</li>
          <li>20 ciclos reais consecutivos por plataforma principal sem falha não explicada;</li>
          <li>canary mínimo de 48 horas;</li>
          <li>taxa de conclusão de autorização dentro do objetivo acordado;</li>
          <li>nenhuma ocorrência de PII/secret nos logs.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>A pipeline bloqueia automaticamente qualquer versão que não cumpra todos os gates.</p>
      </div>
    </div>
  );
}
