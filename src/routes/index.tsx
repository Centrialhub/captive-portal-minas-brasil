import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 12 — REMOVER EXCLUSIVAMENTE O SUBSISTEMA OTP QUE NÃO FAZ PARTE DO PORTAL OFICIAL</h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Eliminar código morto e superfície de ataque do antigo login por WhatsApp, mantendo Google e senha.</p>

        <h2 className="font-bold text-lg mb-2">Remover:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>`/request-code`;</li>
          <li>`/verify-code`;</li>
          <li>lógica `/session-status` específica de OTP;</li>
          <li>função `whatsapp-status`;</li>
          <li>envio de código;</li>
          <li>locks, retries e fallbacks específicos;</li>
          <li>HTML e scripts OTP remanescentes;</li>
          <li>secrets de WhatsApp não utilizados;</li>
          <li>dependências exclusivas desse fluxo.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Banco:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Revogar acesso público às tabelas OTP.</li>
          <li>Manter dados antigos somente pelo período de retenção aprovado.</li>
          <li>Criar limpeza programada.</li>
          <li>Não remover tabela aplicada de forma destrutiva antes da expiração da retenção.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Regras:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>Não substituir OTP por outro fluxo.</li>
          <li>Não alterar Google.</li>
          <li>Não alterar senha.</li>
          <li>Não alterar UniFi.</li>
          <li>Não manter endpoints “desativados” respondendo informações.</li>
          <li>Rotas antigas devem retornar 404.</li>
          <li>Remover também o webhook que aceita requisição quando o segredo está ausente.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>Google e senha continuam funcionando.</li>
          <li>Rotas OTP retornam 404.</li>
          <li>Nenhum envio WhatsApp ocorre.</li>
          <li>Busca global não encontra códigos, endpoints ou secrets do fluxo legado.</li>
          <li>Build e typecheck aprovados.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>O produto contém apenas métodos de autenticação oficialmente suportados e visíveis ao usuário.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
