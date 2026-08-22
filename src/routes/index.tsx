export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 08 — ESTABELECER GATE DE CPF SERVER-AUTHORITATIVE
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4 text-gray-700">
          Tornar a validação de CPF e a atualização do perfil processos exclusivos do backend, impedindo burlas por meio de manipulação direta de tabelas públicas.
        </p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4 text-gray-700">
          <li>Revogar permissões de <code>INSERT/UPDATE</code> direto na tabela <code>public.profiles</code> para usuários autenticados e anônimos.</li>
          <li className="mt-2">Criar a função <code>public.secure_update_profile</code> com <code>SECURITY DEFINER</code> para gerenciar as atualizações de forma atômica e segura.</li>
          <li className="mt-2">Restringir a execução dessa função apenas à <code>service_role</code> (Edge Functions).</li>
          <li className="mt-2">Refatorar o endpoint <code>/update-profile</code> na Edge Function para utilizar exclusivamente a RPC segura.</li>
          <li className="mt-2">Garantir validação de unicidade de CPF e integridade de dados no nível de banco de dados, sem depender de lógica no frontend.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes obrigatórios:</h2>
        <ul className="list-disc ml-6 mb-4 text-gray-700">
          <li>Tentativa de <code>UPDATE</code> direto via Supabase JS Client deve falhar com erro de permissão.</li>
          <li>Tentativa de cadastrar um CPF já existente deve retornar erro 409 (Conflict) via Edge Function.</li>
          <li>Acesso a Wi-Fi só deve ser liberado após o status <code>cpf_required</code> ser alterado para <code>false</code> pela função segura.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p className="text-gray-700">O frontend não tem poder de escrita na tabela de perfis; toda transição de estado de usuário é autorizada e executada pelo servidor.</p>
      </div>
    </div>
  );
}
