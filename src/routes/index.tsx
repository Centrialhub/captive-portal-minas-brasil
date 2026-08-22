import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 10 — CENTRALIZAR EXCLUSIVAMENTE A POLÍTICA DE REDIRECIONAMENTO</h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Eliminar destinos controlados por query string e divergências entre sanitizadores. Não alterar autorização, OAuth ou CPF.</p>

        <h2 className="font-bold text-lg mb-2">Política:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>O destino principal deve vir de `stores.post_auth_redirect_url`, configurado por administrador.</li>
          <li>O parâmetro captive `url` não deve ser usado como destino final. Pode ser guardado para diagnóstico com acesso restrito.</li>
          <li>Fallback único: `https://www.drogariaminasbrasil.com.br/`</li>
          <li>Aceitar somente HTTPS.</li>
          <li>Rejeitar:
            <ul className="list-disc ml-6">
              <li>domínio do próprio captive;</li>
              <li>Supabase;</li>
              <li>controladora;</li>
              <li>IP literal IPv4 ou IPv6;</li>
              <li>localhost;</li>
              <li>redes privadas;</li>
              <li>userinfo;</li>
              <li>porta não padrão;</li>
              <li>javascript, data, file;</li>
              <li>URL malformada.</li>
            </ul>
          </li>
          <li>Validar post_auth_redirect_url também ao salvar configurações da loja.</li>
          <li>O backend deve devolver `redirect_url` já resolvido.</li>
          <li>O frontend não deve tentar revalidar com outra regra; apenas confirmar que é HTTPS e usar fallback em caso de contrato inválido.</li>
          <li>Remover as três implementações divergentes de sanitizeCaptiveRedirect.</li>
          <li>Password reset deve usar origem fixa `https://minasbrasilwifi.com.br`, nunca Origin ou Referer fornecido pela requisição.</li>
          <li>Usar `window.location.replace`.</li>
          <li>Nunca redirecionar antes de `authorized:true`.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>URL de loja válida é utilizada.</li>
          <li>Query `url` maliciosa é ignorada.</li>
          <li>URL do captive, Supabase, controladora, IP, localhost e esquemas proibidos são rejeitados.</li>
          <li>Configuração de loja inválida não é salva.</li>
          <li>Reset de senha sempre aponta para origem canônica.</li>
          <li>Nenhum open redirect.</li>
          <li>Tela de sucesso permanece funcional sem destino.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>O usuário não controla o domínio para o qual o portal redireciona.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
