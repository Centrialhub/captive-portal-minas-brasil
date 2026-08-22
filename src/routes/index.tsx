import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4">PROMPT 04 — REMOVER EXCLUSIVAMENTE A SUPERFÍCIE PÚBLICA DE DIAGNÓSTICO UNIFI</h1>
      
      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Impedir que visitantes ou atacantes usem o portal para consultar, testar ou alcançar a controladora. Preservar integralmente a lógica interna usada pela autorização legítima.</p>

        <h2 className="font-bold text-lg mb-2">Remover da Edge Function:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li><code>/diag/list-aps</code>;</li>
          <li><code>/diag/find-real-mac</code>;</li>
          <li><code>/diag/find-ssid</code>;</li>
          <li><code>/diag/unifi-ping</code>;</li>
          <li>qualquer alias equivalente;</li>
          <li>suporte a controller_url, username, password, mac ou site_id fornecidos para diagnóstico.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Remover do Dockerfile/Nginx:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>o bloco público <code>location /unifi/</code>;</li>
          <li><code>proxy_ssl_verify off</code>;</li>
          <li>qualquer encaminhamento direto do navegador para a controladora.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Regras:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li><code>authorizeClient</code>, <code>unifiAuthorizeByMac</code>, login interno da controladora e detecção de loja devem continuar disponíveis apenas para o fluxo server-side legítimo.</li>
          <li>Nenhuma rota pública pode:
            <ul className="list-disc ml-6">
              <li>testar credenciais;</li>
              <li>escolher URL de controladora;</li>
              <li>consultar clientes/APs;</li>
              <li>autorizar MAC de teste;</li>
              <li>devolver cookie, token, usuário ou preview de resposta.</li>
            </ul>
          </li>
          <li>Rotas removidas devem retornar 404 genérico, não 401 ou mensagem indicando que existiram.</li>
          <li>Não substituir por novos endpoints “temporários”.</li>
          <li>Diagnóstico local, quando necessário, deve existir como script de CLI que leia configuração local e não seja incluído na imagem de produção.</li>
          <li>Não modificar o algoritmo de autorização normal.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>Todas as quatro rotas retornam 404 em GET e POST.</li>
          <li><code>/unifi/</code> retorna 404.</li>
          <li>Busca global não encontra handlers públicos de diagnóstico.</li>
          <li>Tentativas com URL interna, localhost ou metadata IP não geram fetch.</li>
          <li>Fluxo normal de autorização continua chamando a função interna existente.</li>
          <li>Nenhuma resposta HTTP contém controller_url, username, password_len, cookie ou body_preview.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>A controladora só é alcançável pelo backend durante uma autorização legítima vinculada a uma sessão.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
