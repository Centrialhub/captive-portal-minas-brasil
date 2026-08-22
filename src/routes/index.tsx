import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 17 — ENDURECER EXCLUSIVAMENTE A ENTREGA HTTP DO PORTAL</h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Adicionar headers, cache e health checks adequados sem alterar fluxos funcionais.</p>

        <h2 className="font-bold text-lg mb-2">Pré-requisito:</h2>
        <p className="mb-4">O JavaScript inline ativo do index.html já deve ter sido removido.</p>

        <h2 className="font-bold text-lg mb-2">Nginx:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Adicionar:
            <ul className="list-disc ml-6">
              <li>X-Content-Type-Options: nosniff;</li>
              <li>Referrer-Policy: no-referrer;</li>
              <li>Permissions-Policy restritiva;</li>
              <li>Content-Security-Policy;</li>
              <li>frame-ancestors 'none';</li>
              <li>object-src 'none';</li>
              <li>base-uri 'self';</li>
              <li>form-action 'self'.</li>
            </ul>
          </li>
          <li>CSP deve permitir somente os hosts realmente usados:
            <ul className="list-disc ml-6">
              <li>portal;</li>
              <li>endpoint Supabase exato necessário ao Auth;</li>
              <li>recursos Google estritamente necessários;</li>
              <li>nenhuma wildcard genérica.</li>
            </ul>
          </li>
          <li>Não usar unsafe-eval.</li>
          <li>Remover CORS wildcard.</li>
          <li>`/oauth/callback`, `/reset-password`, HTML principal e respostas autenticadas:
            <ul className="list-disc ml-6">
              <li>Cache-Control: no-store.</li>
            </ul>
          </li>
          <li>Assets versionados:
            <ul className="list-disc ml-6">
              <li>cache longo;</li>
              <li>immutable.</li>
            </ul>
          </li>
          <li>Criar:
            <ul className="list-disc ml-6">
              <li>`/health` para processo Nginx;</li>
              <li>`/ready` para verificar que o bundle existe e configuração básica foi carregada.</li>
            </ul>
          </li>
          <li>Adicionar HEALTHCHECK na imagem.</li>
          <li>Limitar body no Nginx e novamente na Edge Function.</li>
          <li>Ocultar versão detalhada do Nginx.</li>
          <li>Manter terminação TLS no proxy EasyPanel.</li>
          <li>Não adicionar HSTS antes de o certificado e todos os primeiros redirects da controladora estarem certificados em dispositivos reais. Depois dessa certificação, habilitar HSTS no ponto que termina TLS, não cegamente dentro do container HTTP.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Validação:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>`nginx -t`.</li>
          <li>CSP não bloqueia portal, OAuth ou assets necessários.</li>
          <li>páginas sensíveis não entram em cache.</li>
          <li>assets possuem cache adequado.</li>
          <li>CORS de origem externa não é permitido.</li>
          <li>health/readiness funcionam.</li>
          <li>nenhuma rota funcional mudou.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>A entrega HTTP possui política explícita de conteúdo, origem, cache e framing.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
