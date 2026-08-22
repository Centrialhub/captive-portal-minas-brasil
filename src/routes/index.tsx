export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 01 — RESTAURAR EXCLUSIVAMENTE A ROTA POST /LOGIN
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4 text-gray-700">
          Restaurar o roteamento do login por e-mail e senha para o handler `handleLogin` já existente. 
          Esta interação não deve modificar a lógica interna de autenticação, cadastro, sessão Supabase, 
          OAuth Google, CPF, redirecionamento, autorização UniFi, banco de dados, interface ou qualquer outro endpoint.
        </p>

        <h2 className="font-bold text-lg mb-2">Diagnóstico confirmado:</h2>
        <ul className="list-disc ml-6 mb-4 text-gray-700">
          <li>O frontend chama: <code>POST /login</code> por meio de <code>src/lib/api.ts</code>.</li>
          <li>O handler <code>handleLogin(req)</code> existe na Edge Function.</li>
          <li>O Main Router não possuía a condição para encaminhar o path <code>/login</code> (POST).</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Implementação realizada:</h2>
        <p className="mb-4 text-gray-700">
          Adicionada ao Main Router da Edge Function a condição obrigatória:
        </p>
        <pre className="bg-gray-100 p-3 rounded mb-4 overflow-x-auto text-sm">
          {`if (path === "/login" && req.method === "POST") {
  return await handleLogin(req);
}`}
        </pre>

        <h2 className="font-bold text-lg mb-2">Regras respeitadas:</h2>
        <ul className="list-disc ml-6 mb-4 text-gray-700">
          <li>Nenhum novo handler criado ou duplicado.</li>
          <li>Endpoint original preservado (sem aliases).</li>
          <li>Payload e formato de resposta inalterados.</li>
          <li>Nenhuma alteração em CORS ou headers comuns.</li>
          <li>Nenhuma implementação temporária ou mock adicionado.</li>
        </ul>
      </div>
    </div>
  );
}
