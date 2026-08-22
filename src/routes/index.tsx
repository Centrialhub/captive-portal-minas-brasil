import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 11 — IMPLEMENTAR EXCLUSIVAMENTE O HANDOFF DO GOOGLE PARA O NAVEGADOR PADRÃO</h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Permitir que o usuário conclua Google OAuth fora de captive assistants que bloqueiam user-agents embutidos. Não alterar liberação UniFi, CPF ou login por senha.</p>

        <h2 className="font-bold text-lg mb-2">Pré-requisito:</h2>
        <p className="mb-4">Usar a tentativa server-side e o resume_token já criados. Não depender de localStorage compartilhado entre o captive assistant e o navegador padrão.</p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Na tela de login, apresentar:
            <ul className="list-disc ml-6">
              <li>“Continuar com Google”;</li>
              <li>“Abrir Google no navegador”.</li>
            </ul>
          </li>
          <li>Ambos devem reutilizar a mesma tentativa válida.</li>
          <li>O segundo botão deve abrir uma URL canônica contendo somente attempt_id e resume_token.</li>
          <li>A página aberta no navegador padrão inicia ou retoma o OAuth.</li>
          <li>Nunca colocar MAC, CPF, e-mail ou AP na URL.</li>
          <li>Em erro `disallowed_useragent`, callback timeout ou ausência de sessão:
            <ul className="list-disc ml-6">
              <li>explicar que o navegador interno não concluiu o login;</li>
              <li>oferecer “Abrir no navegador”;</li>
              <li>manter login por senha;</li>
              <li>não entrar em loop automático.</li>
            </ul>
          </li>
          <li>Depois que o navegador externo concluir:
            <ul className="list-disc ml-6">
              <li>o attempt fica authorized no servidor;</li>
              <li>o captive assistant pode consultar o estado pelo token;</li>
              <li>ao retornar ao captive, mostrar “Wi-Fi liberado” sem nova chamada UniFi.</li>
            </ul>
          </li>
          <li>Polling deve:
            <ul className="list-disc ml-6">
              <li>usar backoff;</li>
              <li>parar após sucesso, erro, expiração ou unmount;</li>
              <li>nunca autorizar;</li>
              <li>apenas consultar estado.</li>
            </ul>
          </li>
          <li>Disponibilizar botão “Já concluí no navegador”.</li>
          <li>Não tentar fechar janela automaticamente sem confirmação.</li>
          <li>Não usar user-agent como única decisão; o fallback deve estar sempre disponível.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>Fluxo normal no navegador interno.</li>
          <li>disallowed_useragent.</li>
          <li>navegador externo com storage separado.</li>
          <li>captive assistant retomado após sucesso.</li>
          <li>attempt expirado.</li>
          <li>usuário cancela Google e usa senha.</li>
          <li>consulta repetida não duplica autorização.</li>
          <li>iOS CNA, Android captive portal e navegador comum.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p className="mb-4">Bloqueio do Google em browser embutido não deixa o usuário preso e não exige reiniciar toda a conexão.</p>

        <p>Importante: implemente exatamente o descrito acima, sem adicionar funcionalidades, bibliotecas ou modificações não solicitadas. Siga os padrões de código e a arquitetura já existente no projeto.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
