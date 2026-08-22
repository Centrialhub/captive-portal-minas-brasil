import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">PROMPT 08 — TORNAR EXCLUSIVAMENTE O PERFIL E O GATE DE CPF SERVER-AUTHORITATIVE</h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Impedir atualização direta de CPF e cpf_required pelo cliente Supabase. Não alterar a decisão comercial sobre exigir ou não CPF.</p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Criar migration que revogue INSERT e UPDATE de profiles para authenticated.</li>
          <li>Remover as policies:
            <ul className="list-disc ml-6">
              <li>Users update own profile;</li>
              <li>Users insert own profile.</li>
            </ul>
          </li>
          <li>Manter SELECT do próprio perfil apenas se a interface realmente precisar.</li>
          <li>Toda criação/alteração de perfil deve ocorrer por Edge Function usando service role.</li>
          <li>update-profile deve identificar o usuário exclusivamente pelo JWT Bearer validado, nunca por user_id no body.</li>
          <li>Validar CPF no backend pelo algoritmo completo.</li>
          <li>Normalizar para exatamente 11 dígitos.</li>
          <li>Adicionar CHECK de formato no banco.</li>
          <li>Manter índice unique parcial para CPF não nulo.</li>
          <li>Atualizar cpf_digits e cpf_required=false na mesma operação.</li>
          <li>authorize-existing deve considerar CPF concluído somente quando:
            <ul className="list-disc ml-6">
              <li>existe;</li>
              <li>possui 11 dígitos;</li>
              <li>passa na validação;</li>
              <li>cpf_required=false.</li>
            </ul>
          </li>
          <li>CPF inválido existente deve voltar a needs_cpf.</li>
          <li>Não registrar CPF bruto.</li>
          <li>Erro unique deve resultar em mensagem específica sem indicar a identidade da outra conta.</li>
          <li>Login por senha deve manter a regra atual, salvo especificação comercial diferente em outro prompt.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>PATCH/POST direto na REST API profiles usando token authenticated é negado.</li>
          <li>Usuário não altera cpf_required diretamente.</li>
          <li>CPF inválido não libera.</li>
          <li>CPF duplicado não libera.</li>
          <li>update-profile legítimo atualiza atomicamente.</li>
          <li>Google sem CPF produz zero chamada UniFi.</li>
          <li>Service role continua operando.</li>
          <li>RLS testada com dois usuários distintos.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>O frontend não possui permissão de banco para satisfazer artificialmente o gate de CPF.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
