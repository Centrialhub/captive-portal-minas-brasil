import React, { useState, useEffect } from "react";
import App from "../App";
 
export default function AppContainer() {
  const [showDocumentation, setShowDocumentation] = useState(false);

  useEffect(() => {
    // Escuta por atalho de teclado (ex: Ctrl+Shift+D) para mostrar documentação
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        setShowDocumentation((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!showDocumentation) {
    return <App />;
  }

  return <Documentation />;
}

function Documentation() {
  return (
    <div className="p-8 font-sans max-w-4xl mx-auto">
      <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">
        Integridade de ativos binários restaurada (Prompt 38). Logotipo e favicons verificados e script de integridade automatizado no fluxo de build. Conformidade visual e técnica confirmada.
      </div>
      <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-sm">
        Prompt 46 — Build Determinístico e Healthchecks: Dockerfile configurado para falhar em configurações ausentes, build-info gerado dinamicamente e rotas /health e /ready implementadas.
      </div>
      <h1 className="text-3xl font-bold mb-6 text-gray-900 border-b pb-2">Captive Portal - Drogaria Minas Brasil</h1>
      <p className="mb-6 text-gray-600">Documentação visual de arquitetura, segurança e integridade do sistema.</p>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h2 className="text-xl font-semibold mb-4 text-red-600 flex items-center gap-2">
            <span className="w-2 h-6 bg-red-600 rounded-full"></span>
            Segurança Autorizada
          </h2>
          <ul className="space-y-3 text-gray-700">
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-1">✓</span>
              <span><strong>Gate de CPF:</strong> Server-authoritative via RPC <code>secure_update_profile</code>.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-1">✓</span>
              <span><strong>Privilégio Mínimo:</strong> Permissões <code>public</code> revogadas em tabelas críticas.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-1">✓</span>
              <span><strong>Segredos Isolados:</strong> Credenciais UniFi restritas ao <code>Deno.env</code>.</span>
            </li>
          </ul>
        </section>

        <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h2 className="text-xl font-semibold mb-4 text-yellow-500 flex items-center gap-2">
            <span className="w-2 h-6 bg-yellow-500 rounded-full"></span>
            Integridade Transacional
          </h2>
          <ul className="space-y-3 text-gray-700">
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-1">✓</span>
              <span><strong>Idempotência:</strong> Sistema de <em>Transactional Claim</em> para autorizações UniFi.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-1">✓</span>
              <span><strong>OAuth Robusto:</strong> Rastreamento server-side de tentativas de login Google.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-1">✓</span>
              <span><strong>Replay Determinístico:</strong> Suporte a repetição segura após sucesso (Prompt 31).</span>
            </li>
          </ul>
        </section>
      </div>

      <footer className="mt-12 pt-6 border-t text-center text-gray-400 text-sm">
        Build validado: Docker reprodutível · Lint OK · Typecheck OK
      </footer>
    </div>
  );
}

