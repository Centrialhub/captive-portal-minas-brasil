import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import logoMinasBrasil from "@/assets/logo-minas-brasil.png";
import brazilMap from "@/assets/brazil-map.png";

interface BootstrapData {
  store: { slug: string; name: string; city?: string };
  consent: { version: string; text: string } | null;
  required_fields: Record<string, unknown>;
}

export default function CaptivePortal() {
  const [storeSlug, setStoreSlug] = useState("");
  const [bootstrapData, setBootstrapData] = useState<BootstrapData | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [consented, setConsented] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pathParts = window.location.pathname.split("/");
    const sIdx = pathParts.indexOf("s");
    const slug = sIdx >= 0 ? pathParts[sIdx + 1] : params.get("store") || "";
    setStoreSlug(slug);

    if (!slug) {
      setError("Loja não identificada na URL.");
      setLoading(false);
      return;
    }

    const clientMac = params.get("id") || params.get("mac") || undefined;
    const apMac = params.get("ap") || undefined;
    const ssid = params.get("ssid") || undefined;
    const redirectUrl = params.get("url") || undefined;

    (async () => {
      try {
        const data = await api.bootstrap(slug);
        if (data.error) {
          setError(data.error);
          setLoading(false);
          return;
        }
        setBootstrapData(data);

        const session = await api.startSession({
          store_slug: slug,
          client_mac: clientMac,
          ap_mac: apMac,
          ssid,
          redirect_url: redirectUrl,
        });
        if (session.session_id) setSessionId(session.session_id);
      } catch {
        setError("Erro ao conectar com o servidor.");
      }
      setLoading(false);
    })();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consented || !bootstrapData?.consent) return;
    setSubmitting(true);
    setError(null);

    const params = new URLSearchParams(window.location.search);
    const clientMac = params.get("id") || params.get("mac") || undefined;

    try {
      const result = await api.submitLead({
        session_id: sessionId || undefined,
        store_slug: storeSlug,
        name,
        email,
        phone,
        client_mac: clientMac,
        consent_version: bootstrapData.consent.version,
      });

      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(result.message || "Cadastro realizado com sucesso!");
        setAuthorized(!!result.authorized);
        const rUrl = result.redirect_url || null;
        setRedirectUrl(rUrl);

        if (result.authorized && rUrl) {
          setTimeout(() => {
            window.location.replace(rUrl);
          }, 800);
        }
      }
    } catch {
      setError("Erro ao enviar cadastro.");
    }
    setSubmitting(false);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-primary">
        <div className="text-center">
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="mx-auto mb-4 h-16 object-contain" />
          <p className="text-primary-foreground font-medium">Carregando...</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-primary p-4 relative overflow-hidden">
        <img src={brazilMap} alt="" className="absolute right-0 bottom-0 h-64 opacity-10 pointer-events-none" />
        <div className="relative z-10 w-full max-w-md rounded-xl bg-card p-8 text-center shadow-2xl">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-success-bg">
            <svg className="h-8 w-8 text-brand-success" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
          </div>
          <h1 className="mb-2 text-xl font-bold text-foreground">
            {authorized ? "Conectado!" : "Cadastro realizado!"}
          </h1>
          <p className="text-muted-foreground">{success}</p>
          {authorized && redirectUrl && (
            <p className="mt-4 text-sm text-muted-foreground">
              Você está sendo redirecionado para nosso site.{" "}
              <a href={redirectUrl} className="text-primary font-medium underline">
                Clique aqui se não redirecionar
              </a>
            </p>
          )}
          {!authorized && redirectUrl && (
            <a
              href={redirectUrl}
              className="mt-6 inline-block rounded-lg bg-secondary px-6 py-3 text-sm font-bold text-secondary-foreground hover:bg-brand-yellow-hover transition-colors"
            >
              Ir para o site
            </a>
          )}
        </div>
      </div>
    );
  }

  if (error && !bootstrapData) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-primary p-4">
        <div className="w-full max-w-md rounded-xl bg-card p-8 text-center shadow-2xl">
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="mx-auto mb-4 h-14 object-contain" />
          <p className="text-destructive font-medium">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-primary p-4 relative overflow-hidden">
      {/* Decorative brazil map */}
      <img src={brazilMap} alt="" className="absolute left-0 bottom-0 h-80 opacity-10 pointer-events-none select-none" />

      <div className="relative z-10 w-full max-w-md rounded-xl bg-card p-6 shadow-2xl">
        {/* Header with logo */}
        <div className="text-center mb-5">
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="mx-auto mb-2 h-16 object-contain" />
          <p className="text-xs font-semibold text-muted-foreground tracking-wide uppercase">vender barato é tradição</p>
        </div>

        <h1 className="mb-1 text-lg font-extrabold text-foreground text-center">
          WiFi Gratuito Drogaria Minas Brasil
        </h1>
        <p className="mb-5 text-sm text-muted-foreground text-center">
          {bootstrapData?.store.city
            ? `Loja ${bootstrapData.store.name} — ${bootstrapData.store.city}`
            : `Loja ${bootstrapData?.store.name || ""}`}
        </p>

        {error && (
          <div className="mb-3 rounded-lg bg-destructive/10 p-3">
            <p className="text-sm text-destructive font-medium">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-semibold text-foreground">Nome *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-lg border-2 border-border bg-background px-3 py-2.5 text-foreground focus:border-secondary focus:ring-2 focus:ring-secondary/30 outline-none transition-all"
              placeholder="Seu nome completo"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold text-foreground">E-mail *</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg border-2 border-border bg-background px-3 py-2.5 text-foreground focus:border-secondary focus:ring-2 focus:ring-secondary/30 outline-none transition-all"
              placeholder="email@exemplo.com"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold text-foreground">Telefone *</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              className="w-full rounded-lg border-2 border-border bg-background px-3 py-2.5 text-foreground focus:border-secondary focus:ring-2 focus:ring-secondary/30 outline-none transition-all"
              placeholder="(11) 99999-9999"
            />
          </div>

          {bootstrapData?.consent && (
            <>
              <details className="rounded-lg border-2 border-border bg-muted">
                <summary className="cursor-pointer px-3 py-2.5 text-xs font-semibold text-muted-foreground select-none">
                  Termos de Uso e Política de Privacidade (LGPD)
                </summary>
                <div className="px-3 pb-3">
                  <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
                    {bootstrapData.consent.text}
                  </p>
                </div>
              </details>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={consented}
                  onChange={(e) => setConsented(e.target.checked)}
                  className="mt-0.5 accent-primary"
                />
                <span className="text-foreground font-medium">Li e aceito os termos</span>
              </label>
            </>
          )}

          <button
            type="submit"
            disabled={submitting || !consented}
            className="w-full rounded-lg bg-secondary px-4 py-3 font-bold text-secondary-foreground hover:bg-brand-yellow-hover disabled:opacity-50 transition-colors text-base"
          >
            {submitting ? "Enviando..." : "Conectar ao Wi-Fi"}
          </button>

        </form>

        <p className="mt-4 text-center text-[10px] text-muted-foreground">
          Drogaria Minas Brasil © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}
