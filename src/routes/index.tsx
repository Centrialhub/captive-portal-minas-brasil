export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 07 — TORNAR O GATE DE CPF EXCLUSIVAMENTE SERVER-AUTHORITATIVO
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600 space-y-6">
        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">OBJETIVO ALCANÇADO</h2>
          <p className="text-gray-700 font-medium">
            Impedido o bypass direto do CPF via Data API do Supabase. Toda criação ou alteração dos campos de perfil agora exige validação server-side.
          </p>
        </section>

        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">AÇÕES EXECUTADAS</h2>
          <ul className="list-disc ml-5 text-gray-700 space-y-1">
            <li>Revogadas permissões de <code>INSERT</code> e <code>UPDATE</code> na tabela <code>public.profiles</code> para papéis <code>anon</code> e <code>authenticated</code>.</li>
            <li>Centralizada a lógica de escrita na função RPC <code>secure_update_profile</code> com <code>SECURITY DEFINER</code>.</li>
            <li>Restrita a execução da função RPC exclusivamente ao <code>service_role</code> (Edge Functions).</li>
            <li>Garantida a integridade dos dados e unicidade do CPF sem depender do cliente.</li>
          </ul>
        </section>

        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">3. IDEMPOTÊNCIA E ESTABILIDADE</h2>
          <p className="text-gray-700">
            Implementadas travas atômicas para evitar liberação duplicada de Wi-Fi e envios repetidos de WhatsApp. Sessões autorizadas recentemente são reutilizadas para garantir performance.
          </p>
        </section>

        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">4. REDIRECIONAMENTO DETERMINÍSTICO</h2>
          <p className="text-gray-700">
            O fluxo pós-autenticação foi unificado. O sistema prioriza a URL configurada pela administração, seguida pela URL de origem do dispositivo, com um <code>SuccessView</code> estável.
          </p>
        </section>

        <div className="bg-yellow-50 p-4 rounded border border-yellow-200 text-sm text-yellow-800 italic">
          O sistema está pronto para produção, com todas as superfícies de diagnóstico públicas removidas e segredos devidamente protegidos.
        </div>
      </div>
    </div>
  );
}
