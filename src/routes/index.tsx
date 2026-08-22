import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 07 — GARANTIR EXCLUSIVAMENTE IDEMPOTÊNCIA SERVER-SIDE NA LIBERAÇÃO</h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Impedir que a mesma tentativa provoque duas sessões ou duas chamadas UniFi. Não alterar o conteúdo da chamada UniFi funcional.</p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Usar <code>captive_auth_attempts.id</code> como chave idempotente.</li>
          <li>Adicionar <code>attempt_id</code> obrigatório a authorize-existing e aos demais fluxos que possam autorizar.</li>
          <li>Criar RPC transacional <code>claim_captive_authorization</code>.</li>
          <li>A RPC deve bloquear atomicamente a tentativa e permitir transição:
            <ul className="list-disc ml-6">
              <li>callback_received/awaiting_cpf → authorizing.</li>
            </ul>
          </li>
          <li>Somente a requisição que efetuar essa transição pode:
            <ul className="list-disc ml-6">
              <li>criar captive_sessions;</li>
              <li>atualizar lead;</li>
              <li>chamar authorizeClient.</li>
            </ul>
          </li>
          <li>Requisições concorrentes devem:
            <ul className="list-disc ml-6">
              <li>retornar o estado atual;</li>
              <li>nunca criar nova captive_session;</li>
              <li>nunca chamar UniFi novamente.</li>
            </ul>
          </li>
          <li>Registrar em captive_auth_attempts:
            <ul className="list-disc ml-6">
              <li>captive_session_id;</li>
              <li>authorization_started_at;</li>
              <li>authorization_finished_at;</li>
              <li>authorized;</li>
              <li>fail_reason normalizado;</li>
              <li>número de tentativas controladas.</li>
            </ul>
          </li>
          <li>Após sucesso:
            <ul className="list-disc ml-6">
              <li>replay retorna o mesmo session_id e redirect_url;</li>
              <li>não chama a controladora.</li>
            </ul>
          </li>
          <li>Após falha transitória:
            <ul className="list-disc ml-6">
              <li>retry deve ser explícito;</li>
              <li>exigir lease expirada ou transição autorizada;</li>
              <li>limitar quantidade;</li>
              <li>registrar novo número da tentativa;</li>
              <li>nunca ocorrer automaticamente por evento duplicado.</li>
            </ul>
          </li>
          <li>Remover o Map de deduplicação em memória como mecanismo de correção. Pode permanecer somente para otimização não autoritativa.</li>
          <li>A criação de captive_sessions e a associação ao attempt devem ser transacionais.</li>
          <li>Não alterar authorizeClient, payload UniFi ou verificação de sucesso.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes obrigatórios:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>20 requests simultâneos para o mesmo attempt_id geram uma captive_session e uma chamada UniFi.</li>
          <li>Refresh depois de sucesso retorna o mesmo resultado.</li>
          <li>INITIAL_SESSION e SIGNED_IN simultâneos geram uma chamada.</li>
          <li>Resposta perdida e retry não duplicam.</li>
          <li>Dois attempt_ids diferentes continuam independentes.</li>
          <li>CPF pendente gera zero chamadas.</li>
          <li>Tentativa expirada gera zero chamadas.</li>
          <li>Métrica <code>unifi_authorization_calls_total</code> confirma cardinalidade.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>Para cada attempt_id, a quantidade máxima de chamadas UniFi bem iniciadas é uma, salvo retry server-side explicitamente controlado após falha transitória.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
