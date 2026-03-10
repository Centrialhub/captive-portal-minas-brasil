import { useState, useEffect, useRef } from "react";
import { api } from "./lib/api";
import logoMinasBrasil from "./assets/logo-minas-brasil.png";
import "./index.css";

type Step = "loading" | "form" | "otp" | "success" | "error";

interface BootstrapData {
  store: { slug: string | null; name: string; city?: string | null };
  consent: { version: string; text: string } | null;
}

const FALLBACK: BootstrapData = {
  store: { slug: null, name: "Drogaria Minas Brasil" },
  consent: {
    version: "offline-fallback",
    text: "Ao se conectar à rede Wi-Fi da Drogaria Minas Brasil, você concorda com a coleta e tratamento dos seus dados pessoais (nome, CPF, e-mail e telefone) para fins de autenticação, segurança da rede e comunicações promocionais. Seus dados serão tratados conforme a LGPD (Lei nº 13.709/2018). Você pode solicitar a exclusão dos seus dados a qualquer momento.",
  },
};

function getQueryParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    client_mac: p.get("id") || p.get("mac") || undefined,
    ap_mac: p.get("ap") || undefined,
    ssid: p.get("ssid") || undefined,
    redirect_url: p.get("url") || undefined,
  };
}

export default function App() {
  const [step, setStep] = useState<Step>("loading");
  const [boot, setBoot] = useState<BootstrapData>(FALLBACK);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // Form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [cpf, setCpf] = useState("");
  const [consented, setConsented] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // OTP
  const [otpCode, setOtpCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Boot
  useEffect(() => {
    const params = getQueryParams();
    setStep("form"); // show form immediately

    (async () => {
      try {
        const data = await api.bootstrap();
        if (!data.error) setBoot(data);
      } catch { /* fallback already set */ }

      try {
        const s = await api.startSession(params);
        if (s.session_id) setSessionId(s.session_id);
      } catch { /* non-blocking */ }
    })();
  }, []);

  useEffect(() => {
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
  }, []);

  const startCooldown = (sec: number) => {
    setCooldown(sec);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setCooldown(p => { if (p <= 1) { clearInterval(cooldownRef.current!); return 0; } return p - 1; });
    }, 1000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consented) return;
    setSubmitting(true);
    setError("");

    try {
      const result = await api.submitLead({
        session_id: sessionId || undefined,
        name, email, phone, cpf,
        client_mac: getQueryParams().client_mac,
        consent_version: boot.consent?.version || "offline-fallback",
      });

      if (result.error) {
        setError(result.error);
      } else if (result.requires_verification) {
        setRedirectUrl(result.redirect_url || null);
        setStep("otp");
        startCooldown(60);
      } else {
        setSuccessMsg(result.message || "Cadastro realizado!");
        setRedirectUrl(result.redirect_url || null);
        setStep("success");
      }
    } catch {
      setError("Erro ao enviar cadastro. Tente novamente.");
    }
    setSubmitting(false);
  };

  const handleVerify = async () => {
    if (!sessionId || otpCode.length !== 6) return;
    setVerifying(true);
    setError("");

    try {
      const result = await api.verifyCode({ session_id: sessionId, code: otpCode });
      if (result.error) {
        setError(result.error);
        setOtpCode("");
      } else {
        setSuccessMsg(result.message || "Conectado com sucesso!");
        setRedirectUrl(result.redirect_url || redirectUrl);
        setStep("success");
      }
    } catch {
      setError("Erro ao verificar código.");
    }
    setVerifying(false);
  };

  const handleResend = async () => {
    if (!sessionId || cooldown > 0) return;
    setResending(true);
    setError("");
    try {
      const result = await api.requestCode({ session_id: sessionId, phone });
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
            <a href={redirectUrl} className="portal-btn" style={{ display: "inline-block", marginTop: 20, textDecoration: "none" }}>
              Abrir no navegador
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
          <h1 className="portal-title">Verificação por WhatsApp</h1>
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
            className="portal-input"
            placeholder="000000"
            style={{ textAlign: "center", fontSize: 24, letterSpacing: 8 }}
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
