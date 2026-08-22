import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 05 — CORRIGIR EXCLUSIVAMENTE O REDIRECIONAMENTO APÓS AUTORIZAÇÃO CONFIRMADA</h1>
      
      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Eliminar qualquer falha de redirecionamento, loop ou tela branca após a confirmação da autorização Wi-Fi. Garantir que o usuário receba feedback visual imediato e seja encaminhado ao destino final.</p>

        <h2 className="font-bold text-lg mb-2">Implementação Frontend:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li><strong>SuccessView Determinístico:</strong> Componente isolado que exibe "Wi-Fi Liberado" e contagem regressiva;</li>
          <li><strong>resolvePostAuthRedirect:</strong> Lógica centralizada que prioriza URL salva, depois URL da controladora, depois fallback Minas Brasil;</li>
          <li><strong>Timeout de Segurança:</strong> Se o redirecionamento automático falhar por restrição do navegador (CNA), exibir botão de ação manual destacado.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Implementação Edge Function:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li><strong>handleOAuthCallback:</strong> Restauração do handler determinístico que repassa parâmetros de sessão para a SPA no domínio principal;</li>
          <li><strong>Redirect 302:</strong> Uso estrito de redirecionamentos temporários para evitar cache de rotas de autenticação.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Regras de Ouro:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Nunca redirecionar para domínios antigos (ex: guedesepaixão);</li>
          <li>Sempre usar HTTPS em produção;</li>
          <li>Preservar <code>redirect_url</code> original recebido no início do fluxo.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>Após clicar em "Entrar" ou completar o CPF após o Google Login, o usuário deve ver a tela de sucesso e ser redirecionado em no máximo 3 segundos, ou ter um botão claro para seguir manualmente.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
