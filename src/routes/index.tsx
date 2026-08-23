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
        Prompt 50 — Imutabilidade do Contexto: Eliminada reatribuição de constante ctx via extração segura e retorno determinístico no helper de contexto.
      </div>
      <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-sm">
        Prompt 52 — Máquina de Estados Autoritativa: Constraint de status em captive_auth_attempts atualizada para permitir transições oauth_redirected, awaiting_cpf e callback_received.
      </div>
      <div className="mb-4 p-4 bg-purple-50 border border-purple-200 rounded-lg text-purple-800 text-sm">
        Prompt 53 — Refinamento Estrutural e Autenticação: Otimização de consultas, padronização de nomenclatura no banco e eliminação de redundâncias no fluxo de login.
      </div>
      <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
        Prompt 54 — Capability Pair Obrigatório: Implementada exigência server-side do par (attempt_id, resume_token) para todos os métodos de autenticação e criação de conta.
      </div>
      <div className="mb-4 p-4 bg-orange-50 border border-orange-200 rounded-lg text-orange-800 text-sm">
        Prompt 55 — Otimização de Backend e Segurança: Refinamento de validações, proteção contra ataques de força bruta e melhoria na performance das rotas críticas.
      </div>
      <div className="mb-4 p-4 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 text-sm">
        Prompt 09 — Estados Terminais Autoritativos: RPC <code>claim_auth_attempt</code> refatorado para garantir que tentativas canceladas ou concluídas sejam irrevogáveis, protegendo contra reentrância e CNA loops.
      </div>
      <div className="mb-4 p-4 bg-cyan-50 border border-cyan-200 rounded-lg text-cyan-800 text-sm">
        Prompt 10 — Propriedade da Lease na Finalização: RPC <code>finalize_auth_attempt</code> agora exige a lease ativa e retorna um objeto estruturado, garantindo que o sucesso só seja entregue ao usuário após a persistência correta no banco.
      </div>
      <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm">
        Prompt 11 — Exceções de authorizeClient: Implementado try/catch robusto em torno da autorização UniFi, garantindo que timeouts ou falhas de rede resultem em estado ambíguo recuperável em vez de abandono da lease.
      </div>
      <div className="mb-4 p-4 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-sm">
        Prompt 12 — Resgate de Lease Expirada: Implementada verificação autoritativa read-only via <code>checkUnifiAuthorizationState</code> antes de qualquer tentativa de re-autorização, eliminando comandos duplicados e loops de conexão.
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
