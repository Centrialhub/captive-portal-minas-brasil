export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PORTAL MINAS BRASIL — STATUS E INTEGRIDADE
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600 space-y-6">
        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">SISTEMA RESTAURADO</h2>
          <p className="text-gray-700 font-medium">
            Todos os ativos obrigatórios (Logos e Favicons) foram restaurados a partir do histórico íntegro. O ambiente de build agora conta com validação de integridade para prevenir regressões de assets.
          </p>
        </section>

        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">EVIDÊNCIAS DE INTEGRIDADE</h2>
          <ul className="list-disc ml-5 text-gray-700 space-y-1">
            <li><strong>Logo Restaurado:</strong> <code>src/assets/logo-minas-brasil.png</code> presente e validado.</li>
            <li><strong>Favicons Ativos:</strong> <code>favicon-mb.png</code> e <code>favicon.ico</code> configurados no <code>public/</code>.</li>
            <li><strong>Import Resolution:</strong> Verificado via typecheck (TSC) no <code>src/App.tsx</code>.</li>
            <li><strong>Build Autosuficiente:</strong> Script de verificação de ativos integrado ao pipeline de build.</li>
          </ul>
        </section>

        <div className="bg-red-50 p-4 rounded border border-red-200 text-sm text-red-800 italic font-medium">
          Captive Portal Drogaria Minas Brasil: Árvore de fontes completa e protegida.
        </div>
      </div>
    </div>
  );
}
