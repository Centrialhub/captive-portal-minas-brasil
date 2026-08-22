import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 09 — SEPARAR EXCLUSIVAMENTE AS ROTAS POR TRUST BOUNDARY</h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Evitar que uma única Edge Function com verify_jwt=false concentre rotas públicas, autenticadas, administrativas e webhooks.</p>

        <h2 className="font-bold text-lg mb-2">Arquitetura:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>`captive-public`, verify_jwt=false:
            <ul className="list-disc ml-6">
              <li>bootstrap;</li>
              <li>início de tentativa;</li>
              <li>login;</li>
              <li>signup;</li>
              <li>recuperação de senha;</li>
              <li>eventos públicos mínimos.</li>
            </ul>
          </li>
          <li>`captive-auth`, JWT obrigatório:
            <ul className="list-disc ml-6">
              <li>authorize-existing;</li>
              <li>update-profile;</li>
              <li>leitura do próprio perfil;</li>
              <li>conclusão da tentativa autenticada.</li>
            </ul>
          </li>
          <li>`captive-admin`, JWT obrigatório:
            <ul className="list-disc ml-6">
              <li>dashboard;</li>
              <li>configurações;</li>
              <li>relatórios;</li>
              <li>exports;</li>
              <li>manutenção.</li>
            </ul>
          </li>
          <li>Webhooks externos em função própria:
            <ul className="list-disc ml-6">
              <li>verify_jwt=false;</li>
              <li>assinatura obrigatória;</li>
              <li>rejeição fail-closed.</li>
            </ul>
          </li>
          <li>Extrair somente utilitários compartilhados necessários para módulo interno. Não fazer uma refatoração estética geral das 5.000 linhas.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Regras:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>Função pública nunca usa rota administrativa.</li>
          <li>Função autenticada valida JWT na plataforma e novamente identifica o usuário no handler.</li>
          <li>Função admin valida JWT, role e requisito de MFA.</li>
          <li>Nenhuma função confia em user_id, store_id ou role enviados no body.</li>
          <li>CORS somente para `https://minasbrasilwifi.com.br` e origens locais explicitamente habilitadas em desenvolvimento.</li>
          <li>Requisição sem Origin pode ser aceita apenas nos endpoints necessários ao captive, mantendo os demais controles.</li>
          <li>Definir allowlist de métodos por rota.</li>
          <li>Rejeitar content-type inesperado.</li>
          <li>Limitar body antes do parse.</li>
          <li>Não usar `Access-Control-Allow-Origin: *` em rotas autenticadas.</li>
          <li>Preservar os caminhos públicos do frontend por meio do proxy same-origin.</li>
          <li>Não alterar contratos de resposta além de erros de segurança padronizados.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Rate limit:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>login, signup, reset, OTP remanescente e autorização devem falhar fechado quando o limitador estiver indisponível.</li>
          <li>bootstrap e health podem degradar de forma segura.</li>
          <li>não usar somente Map em memória.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>rota pública funciona anonimamente.</li>
          <li>rota auth sem JWT retorna 401 antes da lógica.</li>
          <li>rota admin com usuário comum retorna 403.</li>
          <li>função webhook sem assinatura retorna 401/403.</li>
          <li>método não permitido retorna 405.</li>
          <li>body excessivo retorna 413.</li>
          <li>origem não autorizada não recebe CORS.</li>
          <li>contratos do frontend continuam válidos.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>Cada endpoint é executado dentro da fronteira de autenticação apropriada, sem depender de uma função monolítica anônima.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
