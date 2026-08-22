export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 05 — IMPLEMENTAR EXCLUSIVAMENTE IDEMPOTÊNCIA SERVER-SIDE DA AUTORIZAÇÃO CAPTIVE
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">OBJETIVO ÚNICO</h2>
        <p className="mb-4 text-gray-700">
          Garantir que uma mesma tentativa captive produza no máximo uma sessão operacional e um único comando de autorização UniFi, independentemente de concorrência, replay ou resposta HTTP perdida.
        </p>
        <ul className="list-disc ml-6 mb-4 text-gray-700">
          <li>no máximo uma sessão operacional por tentativa;</li>
          <li>no máximo um comando normal de autorização UniFi;</li>
          <li>um único resultado persistido e reutilizável.</li>
        </ul>
        <p className="mb-4 text-gray-700 font-semibold italic">A lógica de comunicação e liberação UniFi foi preservada.</p>

        <h2 className="font-bold text-lg mb-2">DIAGNÓSTICO CONFIRMADO</h2>
        <p className="mb-4 text-gray-700">
          A função <code>authorizeAuthenticatedUser</code> permitia que requisições concorrentes disparassem múltiplos comandos UniFi e criassem sessões duplicadas antes que a primeira tentativa fosse marcada como concluída.
        </p>

        <h2 className="font-bold text-lg mb-2">IMPLEMENTAÇÃO REALIZADA</h2>
        <ol className="list-decimal ml-6 mb-4 text-gray-700">
          <li>Implementada verificação de idempotência que reutiliza sessões autorizadas nos últimos 30 segundos para o mesmo usuário e MAC.</li>
          <li className="mt-2">Adicionada trava atômica (atomic lock) via RPC <code>rate_limit_hit</code> para bloquear requisições concorrentes idênticas em uma janela de 15 segundos.</li>
          <li className="mt-2">Garantido que a chamada à UniFi ocorra apenas se a trava for adquirida e nenhuma sessão recente for encontrada.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">CRITÉRIO DE ACEITE</h2>
        <p className="text-gray-700">Refreshes de página, cliques duplos ou instabilidades de rede durante a autorização não devem gerar sessões duplicadas no banco de dados nem múltiplos comandos de liberação na controladora.</p>
      </div>
    </div>
  );
}
