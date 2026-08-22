export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 06 — SUBSTITUIR EXCLUSIVAMENTE O OAUTH TRACKER POR UMA TRANSAÇÃO AUTORITATIVA
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">
          Garantir que cada retorno Google pertença exatamente à tentativa captive que o iniciou. Não alterar a lógica de liberação UniFi, regra de CPF ou destino final.
        </p>

        <h2 className="font-bold text-lg mb-2">Problema:</h2>
        <p className="mb-4">
          O OAuthTracker salva marcador e parâmetros captive separadamente em localStorage. Parâmetros antigos podem sobreviver ao marcador e ser restaurados em outra visita.
        </p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Criar entidade `captive_auth_attempts` com:
            <ul className="list-disc ml-6 mt-2">
              <li>id UUID;</li>
              <li>resume_token_hash;</li>
              <li>client_mac normalizado;</li>
              <li>ap_mac;</li>
              <li>ssid;</li>
              <li>store_hint;</li>
              <li>captive_timestamp;</li>
              <li>original_url apenas para auditoria restrita;</li>
              <li>status;</li>
              <li>created_at;</li>
              <li>expires_at;</li>
              <li>consumed_at;</li>
              <li>user_id após autenticação.</li>
            </ul>
          </li>
          <li className="mt-2">Criar endpoint público e rate-limited para iniciar a tentativa.</li>
          <li className="mt-2">O endpoint deve:
            <ul className="list-disc ml-6 mt-2">
              <li>validar parâmetros;</li>
              <li>gerar token aleatório criptograficamente forte;</li>
              <li>armazenar somente o hash;</li>
              <li>expirar em 10 minutos;</li>
              <li>retornar attempt_id e token opaco.</li>
            </ul>
          </li>
          <li className="mt-2">O `redirectTo` Google deve conter somente attempt_id e resume_token. Não incluir MAC, CPF, e-mail ou AP diretamente.</li>
          <li className="mt-2">No callback:
            <ul className="list-disc ml-6 mt-2">
              <li>validar attempt_id;</li>
              <li>validar hash do token em comparação constante;</li>
              <li>verificar expiração e status;</li>
              <li>carregar parâmetros do servidor;</li>
              <li>nunca restaurar parâmetros antigos apenas por localStorage.</li>
            </ul>
          </li>
          <li className="mt-2">Remover mb_oauth_marker_v1 e mb_captive_params_v3 como fontes autoritativas.</li>
          <li className="mt-2">LocalStorage pode guardar somente attempt_id/token como cache temporário, removido em sucesso, cancelamento, erro definitivo ou expiração.</li>
          <li className="mt-2">Uma tentativa expirada nunca pode ser reativada.</li>
          <li className="mt-2">Uma tentativa consumida não pode ser vinculada a outro usuário.</li>
          <li className="mt-2">Criar estados explícitos:
            <ul className="list-disc ml-6 mt-2 text-sm italic">
              <li>created; oauth_redirected; callback_received; awaiting_cpf; authorizing; authorized; failed; expired; cancelled.</li>
            </ul>
          </li>
          <li className="mt-2">Não registrar token, MAC, e-mail ou CPF em telemetria do navegador.</li>
          <li className="mt-2">O `onAuthStateChange` deve ser síncrono: agendar o processamento fora do callback, sem await interno.</li>
          <li className="mt-2">Garantir um único Promise de processamento por attempt_id.</li>
          <li className="mt-2">Cancelar processamento atrasado quando a tentativa expirar ou for cancelada.</li>
          <li className="mt-2">Resetar corretamente refs e busy ao reiniciar.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>Callback com token correto recupera somente sua tentativa.</li>
          <li>Token errado, ausente, expirado ou reutilizado é rejeitado.</li>
          <li>Parâmetros de uma tentativa nunca contaminam outra.</li>
          <li>Sessão Google antiga sem tentativa válida não autoriza MAC armazenado.</li>
          <li>Dois callbacks iguais convergem para a mesma tentativa.</li>
          <li>Timeout seguido de sessão tardia não inicia autorização.</li>
          <li>Retry cria tentativa nova e funcional.</li>
          <li>Nenhuma PII aparece na URL além do token opaco.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>A autorização só pode usar parâmetros carregados de uma tentativa server-side válida e não expirada.</p>
      </div>
    </div>
  );
}
