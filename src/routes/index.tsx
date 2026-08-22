export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 09 — TORNAR O BUILD DOCKER AUTOSSUFICIENTE E REPRODUZÍVEL
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600 space-y-6">
        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">OBJETIVO ALCANÇADO</h2>
          <p className="text-gray-700 font-medium">
            Garantida a capacidade de compilação e empacotamento em Docker fora do ambiente Lovable com total rastreabilidade e segurança.
          </p>
        </section>

        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">AÇÕES EXECUTADAS</h2>
          <ul className="list-disc ml-5 text-gray-700 space-y-1">
            <li>Refatorado <code>Dockerfile</code> para aceitar <code>ARG</code> de configuração do Supabase no build.</li>
            <li>Implementada validação rigorosa (Lint + Typecheck) antes da geração da imagem final.</li>
            <li>Adicionada rastreabilidade via <code>LABEL org.opencontainers.image.revision</code> (COMMIT_SHA).</li>
            <li>Confirmado isolamento de segredos: <code>.env</code> permanece bloqueado no <code>.dockerignore</code>.</li>
            <li>Padronizado o uso de <code>npm ci</code> para garantir builds reprodutíveis baseados no lockfile.</li>
          </ul>
        </section>

        <section>
          <h2 className="font-bold text-lg mb-2 text-gray-900 border-b pb-1">ESTADO DA INFRAESTRUTURA</h2>
          <p className="text-gray-700">
            O build é agora determinístico e falha imediatamente se o código estiver inválido, impedindo o deploy de imagens quebradas. A configuração é injetada de forma segura sem persistir segredos no sistema de arquivos da imagem.
          </p>
        </section>

        <div className="bg-red-50 p-4 rounded border border-red-200 text-sm text-red-800 italic font-medium">
          A aplicação está pronta para ambientes CI/CD externos (GitHub Actions, GitLab CI, Jenkins) e orquestradores como EasyPanel ou Kubernetes.
        </div>
      </div>
    </div>
  );
}


