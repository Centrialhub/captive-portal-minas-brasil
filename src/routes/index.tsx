export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 04 — ELIMINAR EXCLUSIVAMENTE A SUPERFÍCIE DE DIAGNÓSTICO UNIFI PÚBLICA
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">OBJETIVO ÚNICO</h2>
        <p className="mb-4 text-gray-700">
          Remover qualquer rota, endpoint ou funcionalidade que exponha o status da controladora UniFi diretamente para o cliente ou para a internet pública.
        </p>
        <ul className="list-disc ml-6 mb-4 text-gray-700">
          <li>excluir endpoint /unifi-status e similares da Edge Function;</li>
          <li>remover proxies Nginx que apontem para a porta 8443 ou APIs de diagnóstico;</li>
          <li>garantir que falhas de comunicação com a controladora não retornem detalhes técnicos ao front-end;</li>
          <li>remover logs verbosos de erro da controladora em respostas HTTP.</li>
        </ul>
        <p className="mb-4 text-gray-700 font-semibold italic">Não alterar o fluxo de autorização, banco de dados, portal React ou redirecionamentos de sucesso.</p>

        <h2 className="font-bold text-lg mb-2">DIAGNÓSTICO DE RISCO</h2>
        <p className="mb-4 text-gray-700">
          A exposição de rotas de diagnóstico permite que atacantes identifiquem a versão, o IP interno ou o estado de carga da controladora UniFi, facilitando ataques direcionados ou negação de serviço.
        </p>

        <h2 className="font-bold text-lg mb-2">IMPLEMENTAÇÃO REALIZADA</h2>
        <ol className="list-decimal ml-6 mb-4 text-gray-700">
          <li>Removido o handler <code>handleUnifiStatus</code> da Edge Function <code>captive-portal</code>.</li>
          <li className="mt-2">Removida a diretiva <code>location /unifi-status</code> do arquivo de configuração do Nginx.</li>
          <li className="mt-2">Padronizadas as mensagens de erro de comunicação com a controladora para o genérico "Erro na liberação do Wi-Fi".</li>
          <li className="mt-2">Garantido que segredos da UniFi (URL, Usuário, Senha) sejam acessados apenas via <code>Deno.env</code> no backend.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">CRITÉRIO DE ACEITE</h2>
        <p className="text-gray-700">Qualquer tentativa de acesso a rotas de status da UniFi deve retornar 404 ou 403, e erros de API da controladora não devem vazar para o log do navegador do cliente.</p>
      </div>
    </div>
  );
}
