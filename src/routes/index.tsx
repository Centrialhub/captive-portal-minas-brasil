export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4 uppercase text-red-600">
        PROMPT 03 — CORRIGIR EXCLUSIVAMENTE OS TIMERS E A NAVEGAÇÃO DO SUCCESSVIEW
      </h1>

      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md border-t-4 border-red-600">
        <h2 className="font-bold text-lg mb-2">OBJETIVO ÚNICO</h2>
        <p className="mb-4 text-gray-700">
          Garantir que a tela de confirmação de Wi-Fi liberado:
        </p>
        <ul className="list-disc ml-6 mb-4 text-gray-700">
          <li>crie apenas um ciclo de contagem regressiva;</li>
          <li>execute no máximo uma tentativa automática de navegação;</li>
          <li>não recrie timers em rerenders;</li>
          <li>permita uma tentativa manual controlada;</li>
          <li>limpe todos os recursos no unmount.</li>
        </ul>
        <p className="mb-4 text-gray-700 font-semibold italic">Não alterar autenticação, OAuth, CPF, backend, redirect resolver ou UniFi.</p>

        <h2 className="font-bold text-lg mb-2">DIAGNÓSTICO CONFIRMADO</h2>
        <p className="mb-4 text-gray-700">
          O <code>SuccessView</code> possuía um effect dependente de <code>navigated</code> (estado), o que causava a reinicialização dos timers quando a navegação era iniciada, gerando loops e race conditions.
        </p>

        <h2 className="font-bold text-lg mb-2">IMPLEMENTAÇÃO REALIZADA</h2>
        <ol className="list-decimal ml-6 mb-4 text-gray-700">
          <li>Substituído <code>useState</code> por <code>useRef</code> para o controle de <code>navigated</code>, garantindo que o valor seja persistente e não dispare rerenders ou efeitos colaterais indesejados.</li>
          <li className="mt-2">Removido <code>navigated</code> da lista de dependências do <code>useEffect</code>.</li>
          <li className="mt-2">Adicionada trava atômica no início do <code>useEffect</code> usando a ref.</li>
          <li className="mt-2">Garantida a limpeza (cleanup) de timers e intervalos no desmonte do componente.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">CRITÉRIO DE ACEITE</h2>
        <p className="text-gray-700">A tela de sucesso deve contar exatamente de 2 a 0 e disparar a navegação apenas uma vez, sem resets visuais ou lógicos durante o processo.</p>
      </div>
    </div>
  );
}
