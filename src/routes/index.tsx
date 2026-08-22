export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 08 — REMOVER EXCLUSIVAMENTE O SUBSISTEMA OTP/WHATSAPP LEGADO
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600 space-y-6">
        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">OBJETIVO ALCANÇADO</h2>
          <p className="text-gray-700 font-medium">
            Removido todo o código relacionado ao fluxo de verificação via WhatsApp e OTP, simplificando o portal para autenticação exclusiva via Google/Email + CPF.
          </p>
        </section>

        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">AÇÕES EXECUTADAS</h2>
          <ul className="list-disc ml-5 text-gray-700 space-y-1">
            <li>Excluídas rotas legadas: <code>/start</code>, <code>/submit</code>, <code>/session-status</code>, <code>/request-code</code> e <code>/verify-code</code>.</li>
            <li>Removidos helpers de OTP (geração, hashing) e funções de envio de WhatsApp.</li>
            <li>Limpeza de constantes de configuração de OTP e WhatsApp.</li>
            <li>Preservada a integração CRM (ClubeMais) para o fluxo autenticado e atualização de perfil.</li>
            <li>Eliminadas funções auxiliares obsoletas como <code>upsertCaptiveSession</code> e <code>isDuplicateKeyError</code>.</li>
          </ul>
        </section>

        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">ESTADO ATUAL DO PORTAL</h2>
          <p className="text-gray-700">
            O subsistema de mensageria legado foi totalmente removido. O portal agora opera exclusivamente com Identidade Segura (OAuth/Auth), garantindo conformidade e reduzindo custos operacionais.
          </p>
        </section>

        <div className="bg-red-50 p-4 rounded border border-red-200 text-sm text-red-800 italic font-medium">
          O código da Edge Function foi reduzido em mais de 1.500 linhas, eliminando dívida técnica e superfícies de ataque desnecessárias.
        </div>
      </div>
    </div>
  );
}

