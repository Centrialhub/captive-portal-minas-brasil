import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 13 — DESACOPLAR EXCLUSIVAMENTE O CLUBE MAIS DO CAMINHO CRÍTICO DO WI-FI</h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Garantir que indisponibilidade, lentidão ou erro do CRM nunca atrase ou impeça a liberação.</p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Remover qualquer await de syncWithClubeMais do caminho de resposta ao usuário.</li>
          <li>Criar tabela `crm_outbox` com:
            <ul className="list-disc ml-6">
              <li>id;</li>
              <li>user_id/lead_id;</li>
              <li>event_type;</li>
              <li>payload mínimo;</li>
              <li>consent_id;</li>
              <li>idempotency_key;</li>
              <li>status;</li>
              <li>attempts;</li>
              <li>next_attempt_at;</li>
              <li>last_error_code;</li>
              <li>created_at;</li>
              <li>processed_at.</li>
            </ul>
          </li>
          <li>Criar worker separado.</li>
          <li>Enfileirar somente quando houver consentimento de marketing válido e atual.</li>
          <li>Não assumir `aceitesms: "S"`.</li>
          <li>O campo deve refletir a escolha real.</li>
          <li>Não enviar CPF, telefone ou e-mail quando não necessários à finalidade aprovada.</li>
          <li>Definir timeout curto para o CRM.</li>
          <li>Usar retry exponencial limitado.</li>
          <li>Implementar dead-letter após limite.</li>
          <li>Usar idempotency_key para evitar cadastros repetidos.</li>
          <li>Mapear explicitamente store_id interno para idlojacliente externo; não usar slug por suposição.</li>
          <li>Não registrar body da resposta nem token.</li>
          <li>Logs devem conter:
            <ul className="list-disc ml-6">
              <li>outbox_id;</li>
              <li>código HTTP;</li>
              <li>latência;</li>
              <li>código de erro normalizado.</li>
            </ul>
          </li>
          <li>Autorização Wi-Fi deve terminar antes do processamento CRM.</li>
          <li>Falha do CRM não muda `authorized:true`.</li>
          <li>Disponibilizar reprocessamento administrativo controlado.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>CRM offline não afeta o Wi-Fi.</li>
          <li>Timeout não bloqueia resposta.</li>
          <li>Sem consentimento não cria outbox.</li>
          <li>Consentimento revogado impede novos envios.</li>
          <li>Retry não duplica cliente.</li>
          <li>Resposta contendo PII não aparece em logs.</li>
          <li>Loja é mapeada corretamente.</li>
          <li>Dead-letter funciona.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>A experiência de conectividade não depende operacionalmente de sistemas comerciais de terceiros.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
