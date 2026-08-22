import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 14 — ALINHAR EXCLUSIVAMENTE CONSENTIMENTOS E TRANSPARÊNCIA AO TRATAMENTO REAL</h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Fazer com que registros de consentimento e textos apresentados correspondam às ações reais do usuário. Não inventar base legal nem texto jurídico.</p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Separar:
            <ul className="list-disc ml-6">
              <li>ciência/aceite dos termos necessários ao serviço;</li>
              <li>consentimento opcional para marketing;</li>
              <li>consentimento opcional para SMS;</li>
              <li>adesão opcional ao clube/fidelidade.</li>
            </ul>
          </li>
          <li>Nenhuma opção promocional pode vir pré-marcada.</li>
          <li>Recusa de marketing não pode impedir o acesso básico, salvo decisão jurídica formal documentada.</li>
          <li>Remover inserção automática de `consent_version: "1.0"` sem ação real.</li>
          <li>Criar `consent_events` append-only contendo:
            <ul className="list-disc ml-6">
              <li>user/lead;</li>
              <li>purpose_code;</li>
              <li>granted/revoked;</li>
              <li>policy_version;</li>
              <li>timestamp;</li>
              <li>source;</li>
              <li>store;</li>
              <li>proof metadata mínima.</li>
            </ul>
          </li>
          <li>Não armazenar o texto completo repetidamente; versionar os documentos.</li>
          <li>Antes do Google OAuth, mostrar aviso curto com links para termos e privacidade.</li>
          <li>Atualizar a política para listar com precisão:
            <ul className="list-disc ml-6">
              <li>nome;</li>
              <li>e-mail;</li>
              <li>CPF;</li>
              <li>telefone;</li>
              <li>MAC;</li>
              <li>AP;</li>
              <li>SSID;</li>
              <li>IP;</li>
              <li>user-agent;</li>
              <li>timestamps;</li>
              <li>dados Google;</li>
              <li>Supabase;</li>
              <li>UniFi;</li>
              <li>CRM;</li>
              <li>finalidades;</li>
              <li>retenção;</li>
              <li>compartilhamentos;</li>
              <li>direitos e canal do titular.</li>
            </ul>
          </li>
          <li>Não afirmar que não há compartilhamento quando há envio ao CRM, Supabase ou Google.</li>
          <li>Não usar termos genéricos como “melhoria da experiência” para finalidades não definidas.</li>
          <li>Permitir revogação de marketing sem apagar obrigações legais independentes.</li>
          <li>O texto final deve vir de conteúdo aprovado pelo controlador/encarregado; o Lovable não deve inventar justificativa jurídica.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>acesso sem marketing continua possível.</li>
          <li>consentimento SMS falso envia `aceitesms:N`.</li>
          <li>somente ação afirmativa gera granted.</li>
          <li>revogação gera novo evento, sem editar histórico.</li>
          <li>política possui versão e data.</li>
          <li>Google e CRM aparecem na transparência.</li>
          <li>nenhum consentimento é fabricado pelo backend.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>Cada registro de consentimento corresponde a uma escolha verificável e a política descreve o sistema que realmente existe.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
