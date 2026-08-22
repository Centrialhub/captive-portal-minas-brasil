export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 06 — FINALIZAR EXCLUSIVAMENTE A CENTRALIZAÇÃO E PROTEÇÃO DOS SEGREDOS UNIFI
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">OBJETIVO ÚNICO</h2>
        <p className="mb-4 text-gray-700">
          Garantir que usuário, senha, cookies e tokens UniFi sejam removidos de migrations, código, tabelas comuns e logs, sendo centralizados em armazenamento seguro.
        </p>
        <ul className="list-disc ml-6 mb-4 text-gray-700">
          <li>remover colunas <code>unifi_username</code> e <code>unifi_password</code> do código de consulta;</li>
          <li>eliminar campos de credenciais de APIs administrativas e interfaces;</li>
          <li>centralizar acesso a segredos exclusivamente via <code>Deno.env</code> no backend;</li>
          <li>preservar a funcionalidade de comunicação e autorização.</li>
        </ul>
        <p className="mb-4 text-gray-700 font-semibold italic">A lógica funcional de autorização UniFi permanece inalterada.</p>

        <h2 className="font-bold text-lg mb-2">DIAGNÓSTICO CONFIRMADO</h2>
        <p className="mb-4 text-gray-700">
          O backend possuía dependência de colunas legadas na tabela <code>stores</code> e existiam referências a credenciais em migrations históricas e endpoints administrativos.
        </p>

        <h2 className="font-bold text-lg mb-2">IMPLEMENTAÇÃO REALIZADA</h2>
        <ol className="list-decimal ml-6 mb-4 text-gray-700">
          <li>Removida a seleção das colunas <code>unifi_username</code> e <code>unifi_password</code> em todas as consultas SQL do backend.</li>
          <li className="mt-2">Substituído o uso de credenciais por loja pelo uso global e seguro das variáveis de ambiente <code>UNIFI_USERNAME</code> e <code>UNIFI_PASSWORD</code>.</li>
          <li className="mt-2">Eliminada a capacidade de enviar ou receber credenciais UniFi através dos endpoints de administração de lojas.</li>
          <li className="mt-2">Refatorada a descoberta de lojas e testes de conectividade para usar apenas segredos centralizados.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">CRITÉRIO DE ACEITE</h2>
        <p className="text-gray-700">Nenhum segredo UniFi deve estar presente no tráfego de rede (HTTP), nas tabelas públicas acessíveis ou no código-fonte, mantendo a liberação de Wi-Fi 100% funcional.</p>
      </div>
    </div>
  );
}
