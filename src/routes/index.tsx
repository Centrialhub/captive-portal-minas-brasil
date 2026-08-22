export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PORTAL MINAS BRASIL — STATUS E INTEGRIDADE
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600 space-y-6">
        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">SISTEMA OTIMIZADO</h2>
          <p className="text-gray-700 font-medium">
            O projeto passou por uma auditoria completa de código e infraestrutura. Arquivos redundantes foram removidos, metadados de SEO foram padronizados e a consistência visual foi reforçada.
          </p>
        </section>

        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">MELHORIAS APLICADAS</h2>
          <ul className="list-disc ml-5 text-gray-700 space-y-1">
            <li><strong>Interface Consistente:</strong> Padronização de botões, inputs e estados de carregamento em todo o fluxo.</li>
            <li><strong>Código Limpo:</strong> Remoção de rotas, componentes e assets não utilizados (About, placeholders, links legados).</li>
            <li><strong>SEO & Branding:</strong> Metadados e títulos padronizados no <code>index.html</code> para melhor apresentação visual.</li>
            <li><strong>Estabilidade de Handoff:</strong> Refinamento dos timers de redirecionamento e persistência de parâmetros UniFi.</li>
            <li><strong>Segurança Padrão:</strong> RPCs restritos a <code>service_role</code> e isolamento total de segredos UniFi em variáveis de ambiente.</li>
          </ul>
        </section>

        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">PRONTO PARA PRODUÇÃO</h2>
          <p className="text-gray-700">
            A estrutura do banco de dados e a lógica de negócio foram preservadas integralmente, focando exclusivamente na excelência operacional e clareza da interface.
          </p>
        </section>

        <div className="bg-red-50 p-4 rounded border border-red-200 text-sm text-red-800 italic font-medium">
          Captive Portal Drogaria Minas Brasil: Otimizado, Seguro e Escalável.
        </div>
      </div>
    </div>
  );
}



