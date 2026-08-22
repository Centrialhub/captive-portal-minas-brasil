import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 05 — CENTRALIZAR EXCLUSIVAMENTE OS SEGREDOS UNIFI EM ARMAZENAMENTO SEGURO</h1>
      
      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Retirar credenciais UniFi de migrations, tabelas comuns, código e respostas, preservando o protocolo e a implementação funcional de comunicação com a controladora.</p>

        <h2 className="font-bold text-lg mb-2">Problema:</h2>
        <p className="mb-4">Existe credencial real em migration e o backend possui fallback para <code>stores.unifi_username</code> e <code>stores.unifi_password</code>.</p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Nunca reproduzir a credencial atual em código, resposta, migration nova, relatório ou log.</li>
          <li>Alterar o backend para obter credenciais somente de:
            <ul className="list-disc ml-6">
              <li>Supabase Secrets; ou</li>
              <li>Supabase Vault com referência por loja.</li>
            </ul>
          </li>
          <li>A tabela stores pode manter apenas:
            <ul className="list-disc ml-6">
              <li>URL/identificador não secreto da controladora;</li>
              <li>site_id;</li>
              <li>nome lógico da referência de segredo.</li>
            </ul>
          </li>
          <li>Não armazenar senha em coluna texto de stores.</li>
          <li>Criar migration forward-only que:
            <ul className="list-disc ml-6">
              <li>zere os valores legados de unifi_username e unifi_password depois que a nova configuração estiver ativa;</li>
              <li>revogue SELECT dessas colunas;</li>
              <li>opcionalmente remova as colunas após confirmação de compatibilidade.</li>
            </ul>
          </li>
          <li>Não depender de alterar uma migration já aplicada para corrigir o banco existente.</li>
          <li>Remover o literal secreto do estado atual do repositório.</li>
          <li>Adicionar secret scanning no CI.</li>
          <li>Quando o segredo estiver ausente:
            <ul className="list-disc ml-6">
              <li>falhar de forma controlada;</li>
              <li>registrar somente <code>UNIFI_SECRET_NOT_CONFIGURED</code>;</li>
              <li>não tentar valores default;</li>
              <li>não retornar detalhes ao cliente.</li>
            </ul>
          </li>
          <li>Manter inalterados:
            <ul className="list-disc ml-6">
              <li>endpoints UniFi;</li>
              <li>payload de autorização;</li>
              <li>timeout validado;</li>
              <li>verificação pós-autorização;</li>
              <li>normalização de MAC.</li>
            </ul>
          </li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Validação:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>Busca por senha, usuário antigo e padrões de segredo resulta em zero ocorrências no estado atual.</li>
          <li>Banco não devolve credencial para anon ou authenticated.</li>
          <li>Fluxo funciona com segredo configurado.</li>
          <li>Ausência do segredo não expõe detalhes.</li>
          <li>Logs não contêm senha, token ou cookie.</li>
          <li>CI bloqueia novo segredo.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2 text-red-700">Ação operacional obrigatória fora do código:</h2>
        <p className="mb-4 font-semibold">A credencial existente deve ser rotacionada na controladora antes do deploy. Bloquear a release até haver confirmação da rotação.</p>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>Nenhuma credencial UniFi permanece em código, migration ativa, tabela comum, frontend ou log.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
