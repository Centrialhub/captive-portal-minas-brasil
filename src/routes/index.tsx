import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4">PROMPT 02 — CORRIGIR EXCLUSIVAMENTE O LIFECYCLE DA TELA DE SUCESSO</h1>
      
      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Eliminar a violação das Rules of Hooks em src/App.tsx sem modificar autenticação, CPF, chamada UniFi, cálculo de redirect ou textos de negócio.</p>

        <h2 className="font-bold text-lg mb-2">Problema:</h2>
        <p className="mb-4">O useEffect da tela de sucesso está declarado depois dos retornos condicionais de cpf_prompt, loading, OAuth e error. Dependendo do step, o componente executa quantidades diferentes de hooks entre renders.</p>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Nenhum hook pode permanecer depois de qualquer return condicional.</li>
          <li>Preferir extrair a tela para um componente <code>SuccessView</code>.</li>
          <li><code>SuccessView</code> deve receber:
            <ul className="list-disc ml-6">
              <li>redirectUrl;</li>
              <li>successMsg;</li>
              <li>callback de conclusão opcional.</li>
            </ul>
          </li>
          <li>O componente deve controlar internamente:
            <ul className="list-disc ml-6">
              <li>countdown iniciado em 2;</li>
              <li>um único setTimeout;</li>
              <li>um único setInterval;</li>
              <li>limpeza de ambos no unmount;</li>
              <li>prevenção de duas navegações.</li>
            </ul>
          </li>
          <li>Ao clicar “Continuar agora”:
            <ul className="list-disc ml-6">
              <li>cancelar timer e interval;</li>
              <li>executar <code>window.location.replace(redirectUrl)</code> uma única vez.</li>
            </ul>
          </li>
          <li>O redirect automático deve fazer o mesmo após 2 segundos.</li>
          <li>Se redirectUrl estiver vazio, mostrar apenas: “Seu acesso já foi liberado. Você pode fechar esta janela.”</li>
          <li>Não limpar dados OAuth antes de o estado <code>authorized:true</code> estar confirmado.</li>
          <li>Não modificar resolvePostAuthRedirect.</li>
          <li>Não alterar completeAuthenticatedSession.</li>
          <li>Não inserir eslint-disable para react-hooks.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Testes:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li>Render inicial em login e transição para success não gera erro de hooks.</li>
          <li>Transições loading → error → login → success funcionam.</li>
          <li>Um único timeout e interval são criados.</li>
          <li>Clique manual cancela o automático.</li>
          <li>Unmount cancela timers.</li>
          <li><code>replace</code> é chamado no máximo uma vez.</li>
          <li>lint e testes React sem warnings de hooks.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>O componente App executa sempre a mesma sequência de hooks, independentemente do step, e a tela de confirmação não pode quebrar depois da liberação.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
