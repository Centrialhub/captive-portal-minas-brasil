import { useState, useEffect } from "react";
import { api } from "@/lib/api";

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

  // Form fields
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [consented, setConsented] = useState(false);

  // Extract store slug and UniFi params from URL
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
        email: email || undefined,
        phone: phone || undefined,
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

        // Auto-redirect if authorized
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
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Carregando...</p>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md rounded-lg border bg-card p-6 text-center">
          <h1 className="mb-2 text-xl font-bold text-foreground">
            {authorized ? "✅ Conectado!" : "✅ Cadastro realizado!"}
          </h1>
          <p className="text-muted-foreground">{success}</p>
          {authorized && redirectUrl && (
            <p className="mt-3 text-sm text-muted-foreground">
              Redirecionando...{" "}
              <a href={redirectUrl} className="text-primary underline">
                Clique aqui se não redirecionar
              </a>
            </p>
          )}
          {!authorized && redirectUrl && (
            <a
              href={redirectUrl}
              className="mt-4 inline-block rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
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
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md rounded-lg border bg-destructive/10 p-6 text-center">
          <p className="text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-6">
        <h1 className="mb-1 text-xl font-bold text-foreground">
          {bootstrapData?.store.name || "Wi-Fi"}
        </h1>
        <p className="mb-4 text-sm text-muted-foreground">
          Cadastre-se para acessar o Wi-Fi gratuito
        </p>

        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">Nome *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded border bg-background px-3 py-2 text-foreground"
              placeholder="Seu nome completo"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">E-mail</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border bg-background px-3 py-2 text-foreground"
              placeholder="email@exemplo.com"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">Telefone</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded border bg-background px-3 py-2 text-foreground"
              placeholder="(11) 99999-9999"
            />
          </div>

          {bootstrapData?.consent && (
            <div className="rounded border bg-muted p-3">
              <p className="mb-2 text-xs text-muted-foreground whitespace-pre-line">
                {bootstrapData.consent.text}
              </p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={consented}
                  onChange={(e) => setConsented(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-foreground">Li e aceito os termos acima</span>
              </label>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !consented || (!email && !phone)}
            className="w-full rounded bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
          >
            {submitting ? "Enviando..." : "Conectar ao Wi-Fi"}
          </button>

          {!email && !phone && (
            <p className="text-xs text-muted-foreground text-center">
              Informe ao menos e-mail ou telefone
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
