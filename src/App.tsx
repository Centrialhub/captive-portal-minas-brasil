import { useState, useEffect, useRef } from "react";
import { api } from "./lib/api";
import { getQueryParams, buildSubmitPayload, type PortalStep } from "./lib/portal-utils";
import logoMinasBrasil from "./assets/logo-minas-brasil.png";
import "./index.css";

interface BootstrapData {
  store: { slug: string | null; name: string; city?: string | null };
  consent: { version: string; text: string } | null;
}

const FALLBACK_BOOT: BootstrapData = {
  store: { slug: null, name: "Drogaria Minas Brasil" },
  consent: {
    version: "1.0",
    text: "Ao se conectar à rede Wi-Fi da Drogaria Minas Brasil, você concorda com a coleta e tratamento dos seus dados pessoais (nome, CPF, e-mail e telefone) para fins de autenticação, segurança da rede e comunicações promocionais. Seus dados serão tratados conforme a LGPD (Lei nº 13.709/2018). Você pode solicitar a exclusão dos seus dados a qualquer momento.",
  },
};

export default function App() {
  const [step, setStep] = useState<PortalStep>("loading");
  const [boot, setBoot] = useState<BootstrapData>(FALLBACK_BOOT);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [cpf, setCpf] = useState("");
  const [consented, setConsented] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [otpCode, setOtpCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const startPromiseRef = useRef<Promise<string | null> | null>(null);

  // Ensure session_id exists before any submit/verify/resend call
  const ensureSession = async (): Promise<string> => {
    if (sessionIdRef.current) return sessionIdRef.current;

    // If /start is already in-flight, wait for it
    if (startPromiseRef.current) {
      const id = await startPromiseRef.current;
      if (id) return id;
    }

    // Otherwise call /start now
    const params = getQueryParams();
    const promise = api.startSession(params).then(s => {
      const id = s.session_id || null;
      if (id) {
        sessionIdRef.current = id;
        setSessionId(id);
      }
      return id;
    });
    startPromiseRef.current = promise;
    const id = await promise;
    if (!id) throw new Error("Não foi possível criar sessão. Tente novamente.");
    return id;
  };

  // Boot: show form immediately, fetch bootstrap/start in background
  useEffect(() => {
    setStep("form");

    // Hide HTML fallback — React mounted successfully
    const fb = document.getElementById("fb");
    if (fb) fb.style.display = "none";

    const params = getQueryParams();

    (async () => {
      try {
        const data = await api.bootstrap();
        if (!data.error) setBoot(data);
      } catch { /* use fallback */ }

      try {
        const promise = api.startSession(params).then(s => {
          const id = s.session_id || null;
          if (id) {
            sessionIdRef.current = id;
            setSessionId(id);
          }
          return id;
        });
        startPromiseRef.current = promise;
        await promise;
      } catch { /* non-blocking, ensureSession will retry */ }
    })();
  }, []);

  useEffect(() => {
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
  }, []);

  const startCooldown = (sec: number) => {
    setCooldown(sec);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setCooldown(p => {
        if (p <= 1) { clearInterval(cooldownRef.current!); return 0; }
        return p - 1;
      });
    }, 1000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consented) return;
    setSubmitting(true);
    setError("");

    try {
      // Guarantee session_id before submit
      const sid = await ensureSession();

      const payload = buildSubmitPayload({
        session_id: sid,
        name, email, phone, cpf,
        client_mac: getQueryParams().client_mac,
        consent_version: boot.consent?.version || "1.0",
      });
      const result = await api.submitLead(payload);

      if (result.error) {
        setError(result.error);
      } else if (result.requires_verification) {
        setRedirectUrl(result.redirect_url || null);
        setStep("otp");
        startCooldown(60);
      } else {
        setSuccessMsg(result.message || "Cadastro realizado! Você já pode navegar.");
        setRedirectUrl(result.redirect_url || null);
        setStep("success");
      }
    } catch (err) {
      console.error("[portal] submit error:", err);
      setError("Erro ao enviar cadastro. Tente novamente.");
    }
    setSubmitting(false);
  };

  const handleVerify = async () => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) { setError("Sessão não encontrada. Recarregue a página."); return; }
    if (otpCode.length !== 6) return;
    setVerifying(true);
    setError("");

    try {
      const result = await api.verifyCode({ session_id: sid, code: otpCode });
      if (result.error) {
        setError(result.error);
        setOtpCode("");
      } else {
        setSuccessMsg(result.message || "Conectado com sucesso!");
        const finalUrl = result.redirect_url || redirectUrl;
        setRedirectUrl(finalUrl);
        setStep("success");

        // CRITICAL: when backend says use_hotspot_redirect, navigate to the UniFi
        // controller's /guest/s/<site>/ endpoint. The controller will authorize
        // the MAC the AP actually sees (solves Android MAC randomization issue).
        if (result.use_hotspot_redirect && finalUrl) {
          setTimeout(() => { window.location.href = finalUrl; }, 1200);
        }
      }
    } catch {
      setError("Erro ao verificar código.");
    }
    setVerifying(false);
  };

  const handleResend = async () => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) { setError("Sessão não encontrada. Recarregue a página."); return; }
    if (cooldown > 0) return;
    setResending(true);
    setError("");
    try {
      const result = await api.requestCode({ session_id: sid, phone });
      if (result.error) setError(result.error);
      else startCooldown(60);
    } catch {
      setError("Erro ao reenviar código.");
    }
    setResending(false);
  };

  // ── LOADING ──
  if (step === "loading") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <p style={{ color: "#888", marginTop: 12 }}>Carregando...</p>
        </div>
      </div>
    );
  }

  // ── ERROR ──
  if (step === "error") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <h1 className="portal-title">Erro</h1>
          <p className="portal-subtitle">{error || "Ocorreu um erro inesperado."}</p>
          <button onClick={() => { setError(""); setStep("form"); }} className="portal-btn">Tentar novamente</button>
          <p className="portal-footer">Drogaria Minas Brasil © {new Date().getFullYear()}</p>
        </div>
      </div>
    );
  }

  // ── SUCCESS ──
  if (step === "success") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <div className="success-icon">
            <svg width="40" height="40" fill="none" stroke="#2e7d32" viewBox="0 0 24 24" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="portal-title">Conectado!</h1>
          <p className="portal-subtitle">{successMsg}</p>
          {redirectUrl && (
            <a href={redirectUrl} className="portal-btn" style={{ display: "inline-block", marginTop: 16, textDecoration: "none" }}>
              Continuar conexão
            </a>
          )}
          <p className="portal-footer">Drogaria Minas Brasil © {new Date().getFullYear()}</p>
        </div>
      </div>
    );
  }

  // ── OTP ──
  if (step === "otp") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card">
          <div style={{ textAlign: "center" }}>
            <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          </div>
          <h1 className="portal-title">Verificação</h1>
          <p className="portal-subtitle">
            Digite o código de 6 dígitos enviado para <strong>{phone}</strong>
          </p>

          {error && <div className="portal-error">{error}</div>}

          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={otpCode}
            onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="portal-input portal-otp-input"
            placeholder="000000"
            autoFocus
          />

          <button onClick={handleVerify} disabled={verifying || otpCode.length !== 6} className="portal-btn">
            {verifying ? "Verificando..." : "Verificar código"}
          </button>

          <button onClick={handleResend} disabled={resending || cooldown > 0} className="portal-btn-secondary">
            {cooldown > 0 ? `Reenviar código (${cooldown}s)` : resending ? "Reenviando..." : "Reenviar código"}
          </button>

          <p className="portal-footer">Drogaria Minas Brasil © {new Date().getFullYear()}</p>
        </div>
      </div>
    );
  }

  // ── FORM ──
  return (
    <div className="portal-wrapper">
      <div className="portal-card">
        <div style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <p className="portal-slogan">vender barato é tradição</p>
        </div>

        <h1 className="portal-title">WiFi Gratuito</h1>
        <p className="portal-subtitle">
          {boot.store.city ? `${boot.store.name} — ${boot.store.city}` : boot.store.name}
        </p>

        {error && <div className="portal-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label className="portal-label">Nome *</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} required className="portal-input" placeholder="Seu nome completo" />

          <label className="portal-label">E-mail</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="portal-input" placeholder="email@exemplo.com (opcional)" />

          <label className="portal-label">CPF *</label>
          <input type="text" value={cpf} onChange={e => setCpf(e.target.value)} required inputMode="numeric" maxLength={14} className="portal-input" placeholder="000.000.000-00" />
          <p className="portal-hint">Certifique-se que o seu CPF está correto</p>

          <label className="portal-label">Telefone (WhatsApp) *</label>
          <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} required className="portal-input" placeholder="(11) 99999-9999" />

          {boot.consent && (
            <>
              <details className="portal-terms">
                <summary>Termos de Uso e Política de Privacidade (LGPD)</summary>
                <p>{boot.consent.text}</p>
              </details>
              <label className="portal-checkbox-label">
                <input type="checkbox" checked={consented} onChange={e => setConsented(e.target.checked)} />
                <span>Li e aceito os termos</span>
              </label>
            </>
          )}

          <button type="submit" disabled={submitting || !consented} className="portal-btn">
            {submitting ? "Enviando..." : "Conectar ao Wi-Fi"}
          </button>
        </form>

        <p className="portal-footer">Drogaria Minas Brasil © {new Date().getFullYear()}</p>
      </div>
    </div>
  );
}
