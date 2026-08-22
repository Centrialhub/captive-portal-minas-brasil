import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4">PROMPT 03 — ELIMINAR EXCLUSIVAMENTE AS IMPLEMENTAÇÕES CONCORRENTES DO PORTAL</h1>
      
      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Fazer do frontend React a única máquina de estado do captive portal. Não alterar autenticação, CPF, regras de cadastro, autorização UniFi ou layouts React.</p>

        <h2 className="font-bold text-lg mb-2">Problema:</h2>
        <p className="mb-4">O index.html ainda executa um portal legado completo antes do React, realizando /bootstrap, /start, /submit, /request-code, /verify-code e /session-status. A Edge Function também serve um HTML standalone com outro fluxo. Isso cria requisições duplicadas e corridas.</p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Reduzir index.html a um shell Vite passivo:
            <ul className="list-disc ml-6">
              <li>metadados;</li>
              <li>favicon;</li>
              <li><code>&lt;div id="root"&gt;&lt;/div&gt;</code>;</li>
              <li>script de entrada React.</li>
            </ul>
          </li>
          <li>Remover do index.html:
            <ul className="list-disc ml-6">
              <li>formulários;</li>
              <li>coleta de dados;</li>
              <li>chamadas fetch/XHR;</li>
              <li>timers;</li>
              <li><code>boot()</code>;</li>
              <li>OTP;</li>
              <li>fallback que cria sessão;</li>
              <li>qualquer autorização.</li>
            </ul>
          </li>
          <li>Manter no máximo uma mensagem estática dentro de <code>&lt;noscript&gt;</code>, sem formulário ou chamada de API.</li>
          <li>Na Edge Function, remover o portal standalone de <code>handlePortalHtml</code>.</li>
          <li>Para aliases como <code>/guest/s/...</code>, <code>/generate_204</code>, <code>/hotspot-detect.html</code>, <code>/connecttest.txt</code> e equivalentes:
            <ul className="list-disc ml-6">
              <li>retornar redirect 302 para a origem React canônica;</li>
              <li>preservar parâmetros captive permitidos;</li>
              <li>não executar bootstrap, start ou submit.</li>
            </ul>
          </li>
          <li>Não criar um novo portal alternativo.</li>
          <li>Se o bundle React falhar, exibir somente página estática de indisponibilidade com botão “Tentar novamente”; nunca iniciar um fluxo simplificado.</li>
          <li>Garantir que <code>/politica-privacidade</code>, <code>/sobre</code>, <code>/oauth/callback</code> e <code>/reset-password</code> sejam renderizados exclusivamente pelo React.</li>
          <li>Não remover endpoints backend ainda utilizados pelo React neste prompt.</li>
          <li>Não alterar Docker/Nginx além do necessário para servir a SPA.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>Abrir index.html não produz requisição antes de o React montar.</li>
          <li>Exatamente uma chamada de bootstrap por inicialização.</li>
          <li>Nenhum HTML de formulário antigo aparece no source inicial.</li>
          <li>Nenhuma string <code>/request-code</code> ou <code>/verify-code</code> permanece em index.html.</li>
          <li>Aliases CNA redirecionam para o React e preservam query string.</li>
          <li>Falha simulada do bundle não cria sessão ou lead.</li>
          <li>Build e testes aprovados.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>Existe uma única interface, uma única máquina de estado e uma única origem para chamadas do captive.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
