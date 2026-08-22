export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 07 — GARANTIR EXCLUSIVAMENTE IDEMPOTÊNCIA SERVER-SIDE NA LIBERAÇÃO
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4 text-gray-700">
          Impedir que a mesma tentativa provoque duas sessões ou duas chamadas UniFi. Não alterar o conteúdo da chamada UniFi funcional.
        </p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4 text-gray-700">
          <li>Usar <code>captive_auth_attempts.id</code> como chave idempotente.</li>
          <li className="mt-2">Adicionar <code>attempt_id</code> obrigatório a authorize-existing e aos demais fluxos que possam autorizar.</li>
          <li className="mt-2">Criar RPC transacional <code>claim_captive_authorization</code>.</li>
          <li className="mt-2">A RPC deve bloquear atomicamente a tentativa e permitir transição:
            <ul className="list-disc ml-6 mt-2">
              <li>callback_received/awaiting_cpf → authorizing.</li>
            </ul>
          </li>
          <li className="mt-2">Somente a requisição que efetuar essa transição pode:
            <ul className="list-disc ml-6 mt-2 text-sm italic">
              <li>criar captive_sessions; atualizar lead; chamar authorizeClient.</li>
            </ul>
          </li>
          <li className="mt-2">Requisições concorrentes devem:
            <ul className="list-disc ml-6 mt-2">
              <li>retornar o estado atual; nunca criar nova captive_session; nunca chamar UniFi novamente.</li>
            </ul>
          </li>
          <li className="mt-2">Registrar em captive_auth_attempts:
            <ul className="list-disc ml-6 mt-2 text-sm italic">
              <li>captive_session_id; authorization_started_at; authorization_finished_at; authorized; fail_reason normalizado; número de tentativas controladas.</li>
            </ul>
          </li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes obrigatórios:</h2>
        <ul className="list-disc ml-6 mb-4 text-gray-700">
          <li>20 requests simultâneos para o mesmo attempt_id geram uma captive_session e uma chamada UniFi.</li>
          <li>Refresh depois de sucesso retorna o mesmo resultado.</li>
          <li>INITIAL_SESSION e SIGNED_IN simultâneos geram uma chamada.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p className="text-gray-700">Para cada attempt_id, a quantidade máxima de chamadas UniFi bem iniciadas é uma, salvo retry server-side explicitamente controlado após falha transitória.</p>
      </div>
    </div>
  );
}
