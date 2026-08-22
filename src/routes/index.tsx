import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-2xl font-bold mb-4">PROMPT 01 — ESTABELECER UMA BASE DE BUILD REPRODUZÍVEL E SEM ERROS</h1>
      
      <div className="max-w-2xl text-left bg-white p-6 rounded-lg shadow-md">
        <h2 className="font-bold text-lg mb-2">Objetivo único:</h2>
        <p className="mb-4">Tornar instalação, typecheck, testes, build e imagem Docker determinísticos. Não alterar UI, OAuth, CPF, redirects, banco de dados, autorização ou comunicação UniFi.</p>

        <h2 className="font-bold text-lg mb-2">Problemas confirmados:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li><code>react-router-dom</code> está no package.json, mas ausente da raiz do package-lock.json.</li>
          <li>Existem package-lock.json, bun.lock e bun.lockb simultaneamente.</li>
          <li>Docker usa <code>npm install</code>.</li>
          <li>Docker usa Node 20, já fora de suporte.</li>
          <li>Existem erros TypeScript reais na Edge Function.</li>
          <li><code>.env</code> está versionado e não é ignorado.</li>
          <li>Não existe comando único de verificação.</li>
          <li><code>vercel.json</code> mantém uma segunda estratégia de deploy, embora EasyPanel/Docker seja o ambiente comercial.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Implementação:</h2>
        <ol className="list-decimal ml-6 mb-4">
          <li>Adotar npm como único package manager.</li>
          <li>Remover bun.lock e bun.lockb.</li>
          <li>Regenerar package-lock.json usando a mesma versão de npm definida para CI.</li>
          <li>Garantir que todas as dependências do package.json estejam na raiz do lockfile, incluindo react-router-dom.</li>
          <li>Alterar o Dockerfile para usar uma versão atual e corrigida do Node 24 LTS.</li>
          <li>Usar <code>npm ci</code>, nunca <code>npm install</code>, dentro do Docker.</li>
          <li>Fixar versões explícitas das imagens Node e Nginx; registrar os digests validados no Dockerfile ou na documentação de release.</li>
          <li>Criar <code>.dockerignore</code> excluindo node_modules, dist, .git, ZIPs, logs, arquivos locais e segredos.</li>
          <li>Adicionar <code>.env</code> ao .gitignore e criar <code>.env.example</code> apenas com nomes e valores fictícios. A chave publishable do Supabase pode ser pública, mas nenhuma credencial privilegiada pode entrar no repositório.</li>
          <li>Remover <code>vercel.json</code> caso EasyPanel/Docker seja a origem oficial de produção. Não manter dois pipelines de deploy concorrentes.</li>
          <li>Corrigir somente os erros de compilação já identificados:
            <ul className="list-disc ml-6">
              <li>remover a duplicidade de <code>toE164BR</code>;</li>
              <li>alinhar o retorno de <code>syncWithClubeMais</code>;</li>
              <li>tipar corretamente <code>step</code> e <code>status</code>;</li>
              <li>corrigir o acesso inválido a <code>result.store_id</code>;</li>
              <li>alinhar imports Supabase das Edge Functions em uma versão fixada;</li>
              <li>não usar imports flutuantes <code>@2</code>.</li>
            </ul>
          </li>
          <li>Não refatorar regras de negócio durante essas correções.</li>
          <li>Adicionar scripts: <code>typecheck</code>, <code>typecheck:edge</code>, <code>check</code>.</li>
          <li>Usar configuração Deno/import map ou deno.json para que a Edge Function seja verificada no runtime correto.</li>
          <li>Não afrouxar ESLint ou TypeScript para esconder erros.</li>
        </ol>

        <h2 className="font-bold text-lg mb-2">Validação:</h2>
        <ul className="list-disc ml-6 mb-4">
          <li><code>npm ci</code> funciona em diretório limpo.</li>
          <li><code>npm run lint</code> sem erros.</li>
          <li><code>npm run typecheck</code> sem erros.</li>
          <li><code>deno check</code> nas Edge Functions sem erros.</li>
          <li><code>npm test</code> executa, mesmo que inicialmente haja apenas testes mínimos.</li>
          <li><code>npm run build</code> sem erros.</li>
          <li><code>docker build</code> sem alterar lockfiles.</li>
          <li>Dois builds consecutivos usam a mesma árvore de dependências.</li>
          <li>Busca global não encontra credenciais reais.</li>
        </ul>

        <h2 className="font-bold text-lg mb-2">Critério de aceite:</h2>
        <p>O diff contém somente infraestrutura de build, dependências, tipagem e correções mínimas necessárias para compilação. Nenhuma mudança funcional no portal ou no UniFi.</p>
      </div>

      <div className="mt-8">
        <Link to="/sobre" className="text-blue-600 hover:underline">Sobre o Portal</Link>
      </div>
    </div>
  );
}
