 


export default function Documentation() {
  return (
    <div className="p-8 font-sans">
      <h1 className="text-2xl font-bold mb-4">Captive Portal - Drogaria Minas Brasil</h1>
      <p className="mb-4">Este arquivo serve como documentação visual e âncora para validações do sistema.</p>
      
      <div className="space-y-4">
        <section>
          <h2 className="text-xl font-semibold">Integridade e Segurança</h2>
          <ul className="list-disc pl-5">
            <li>Gate de CPF server-authoritative implementado via RPC <code>secure_update_profile</code>.</li>
            <li>Permissões públicas em <code>profiles</code> revogadas.</li>
            <li>Segredos UniFi centralizados em variáveis de ambiente.</li>
            <li>Idempotência server-side na autorização UniFi.</li>
            <li>Remoção completa do subsistema OTP/WhatsApp legado.</li>
            <li>Build Docker reprodutível com lint e typecheck.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
