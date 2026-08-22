import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 15 — IMPLEMENTAR EXCLUSIVAMENTE O CICLO DE VIDA E A MINIMIZAÇÃO DE DADOS</h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Reduzir exposição de dados pessoais em logs e impedir retenção indefinida. Não alterar regras de autenticação ou autorização.</p>

        <h2 className="font-bold text-lg mb-2">Logs:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Remover CPF, e-mail, telefone, MAC bruto, IP bruto, URL original e resposta CRM de console/logEvent.</li>
          <li>Usar:
            <ul className="list-disc ml-6">
              <li>trace_id;</li>
              <li>attempt_id;</li>
              <li>error_code;</li>
              <li>store_slug;</li>
              <li>latência;</li>
              <li>MAC pseudonimizado por HMAC server-side quando correlação for necessária.</li>
            </ul>
          </li>
          <li>Nunca enviar MAC na telemetria do navegador.</li>
          <li>Não registrar token, cookie, senha ou body externo.</li>
          <li>Redigir mensagens de erro antes de persistir.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Retenção:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Criar matriz de retenção por tabela:
            <ul className="list-disc ml-6">
              <li>captive_auth_attempts;</li>
              <li>captive_sessions;</li>
              <li>portal_events;</li>
              <li>leads;</li>
              <li>profiles;</li>
              <li>consent_events;</li>
              <li>audit_logs;</li>
              <li>CRM outbox;</li>
              <li>GeoIP;</li>
              <li>rate limits.</li>
            </ul>
          </li>
          <li>Os prazos devem ser configuração aprovada, não números espalhados no código.</li>
          <li>Criar job de limpeza com:
            <ul className="list-disc ml-6">
              <li>dry-run;</li>
              <li>contagem;</li>
              <li>exclusão por lotes;</li>
              <li>proteção contra legal hold;</li>
              <li>métrica de sucesso/falha.</li>
            </ul>
          </li>
          <li>Após o período operacional, anonimizar MAC/IP quando o registro precisar ser mantido.</li>
          <li>Remover payloads arbitrários antigos.</li>
          <li>Implementar fluxo administrativo para solicitação de:
            <ul className="list-disc ml-6">
              <li>acesso;</li>
              <li>correção;</li>
              <li>revogação;</li>
              <li>exclusão quando aplicável;</li>
              <li>exportação controlada.</li>
            </ul>
          </li>
          <li>Não apagar consent_events necessários à comprovação sem política aprovada.</li>
          <li>Não manter CPF em mais de uma tabela sem justificativa.</li>
          <li>Documentar controlador, operador e finalidade de cada cópia.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>novos logs não contêm PII.</li>
          <li>scanner de logs detecta padrões de CPF/e-mail/MAC.</li>
          <li>dry-run não altera dados.</li>
          <li>limpeza respeita prazo e legal hold.</li>
          <li>anonimização é irreversível sem segredo.</li>
          <li>falha parcial pode ser retomada.</li>
          <li>dados ativos necessários ao UniFi não são apagados antes da autorização terminar.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>PII existe apenas nos locais, formatos e períodos estritamente necessários.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
