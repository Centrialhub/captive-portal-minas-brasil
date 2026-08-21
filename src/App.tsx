import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { api } from "./lib/api";
import { supabase } from "./integrations/supabase/client";
import {
  getQueryParams,
  sanitizeCaptiveRedirect,
} from "./lib/portal-utils";
import logoMinasBrasil from "./assets/logo-minas-brasil.png";
import "./index.css";

function Footer() {
  return (
    <p className="portal-footer">
      Drogaria Minas Brasil © {new Date().getFullYear()} ·{" "}
      <Link to="/sobre" style={{ color: "#bbb" }}>
        Sobre
      </Link>{" "}
      ·{" "}
      <Link to="/politica-privacidade" style={{ color: "#bbb" }}>
        Política de Privacidade
      </Link>

    </p>
  );
}


type Step = "loading" | "login" | "signup" | "forgot" | "forgot_sent" | "authorizing" | "success" | "error" | "cpf_prompt";

const CAPTIVE_PARAM_KEYS = ["id", "mac", "ap", "ssid", "url", "t", "site", "store"] as const;
const CAPTIVE_PARAMS_STORAGE_KEY = "mb_captive_params_v2";

/** Preserve UniFi captive params across an OAuth round-trip. Using localStorage for better persistence in CNA. */
function stashCaptiveParams() {
  try {
    const p = new URLSearchParams(window.location.search);
    const out: Record<string, string> = {};
    CAPTIVE_PARAM_KEYS.forEach((k) => {
      const v = p.get(k);
      if (v) out[k] = v;
    });
    if (Object.keys(out).length) {
      localStorage.setItem(CAPTIVE_PARAMS_STORAGE_KEY, JSON.stringify(out));
      console.log("[params] stashed:", out);
    }
  } catch (e) {
    console.warn("[params] stash failed:", e);
  }
}

/** Restore captive params into the current URL when coming back from OAuth. */
function restoreCaptiveParamsIfNeeded() {
  try {
    const current = new URLSearchParams(window.location.search);
    const hasAny = CAPTIVE_PARAM_KEYS.some((k) => current.get(k));
    if (hasAny) return;
    const raw = localStorage.getItem(CAPTIVE_PARAMS_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, string>;
    console.log("[params] restoring from localStorage:", saved);
    Object.entries(saved).forEach(([k, v]) => current.set(k, v));
    const qs = current.toString();
    const newUrl = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);
  } catch (e) {
    console.warn("[params] restore failed:", e);
  }
}



interface BootstrapData {
  store: { slug: string | null; name: string; city?: string | null };
  consent: { version: string; text: string } | null;
}

const FALLBACK_BOOT: BootstrapData = {
  store: { slug: null, name: "Drogaria Minas Brasil" },
  consent: {
    version: "1.0",
    text:
      "Ao se conectar à rede Wi-Fi da Drogaria Minas Brasil, você concorda com a coleta e tratamento dos seus dados pessoais (nome, CPF, e-mail e telefone) para fins de autenticação, segurança da rede e comunicações promocionais. Sua senha é armazenada de forma criptografada e serve para acesso recorrente em qualquer unidade. Seus dados serão tratados conforme a LGPD (Lei nº 13.709/2018). Você pode solicitar a exclusão dos seus dados a qualquer momento.",
  },
};

/** Format Brazilian phone as (DD) 9XXXX-XXXX or (DD) XXXX-XXXX */
function formatPhoneBR(value: string): string {
  const d = (value || "").replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export default function App() {
  const [step, setStep] = useState<Step>("loading");
  const [boot, setBoot] = useState<BootstrapData>(FALLBACK_BOOT);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const silentTriedRef = useRef(false);

  // login form
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  // forgot password
  const [forgotEmail, setForgotEmail] = useState("");

  // CPF Prompt (for Google users)
  const [promptCpf, setPromptCpf] = useState("");

  // signup form (CPF is no longer collected)
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [consented, setConsented] = useState(false);


  // Boot: fetch bootstrap + try silent login
  useEffect(() => {
    // Force production domain for OAuth compatibility
    const isLocal = window.location.hostname === "localhost" || window.location.hostname.includes("lovable.app");
    if (!isLocal && window.location.hostname !== "minasbrasilwifi.com.br") {
      console.log("[boot] non-production domain, redirecting to minasbrasilwifi.com.br");
      window.location.href = "http://minasbrasilwifi.com.br" + window.location.search;
      return;
    }

    // Restore captive parameters if coming back from OAuth
    restoreCaptiveParamsIfNeeded();

    // Non-blocking bootstrap (store name / consent text)
    api.bootstrap().then(
      (b) => {
        if (b?.store) setBoot({ store: b.store, consent: b.consent || FALLBACK_BOOT.consent });
      },
      () => { /* keep fallback */ },
    );

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log(`[auth] event: ${event}`, session?.user?.id);
      
      if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session?.access_token) {
        if (silentTriedRef.current) return;
        silentTriedRef.current = true;

        try {
          setStep("authorizing");
          const params = getQueryParams();
          console.log("[auth] authorizing with params:", params);
          
          const result = await api.authorizeExisting({
            access_token: session.access_token,
            client_mac: params.client_mac,
            ap_mac: params.ap_mac,
            ssid: params.ssid,
            redirect_url: params.redirect_url,
            captive_timestamp: params.captive_timestamp,
            auth_method: "google"
          });

          if (result?.needs_cpf) {
            setStep("cpf_prompt");
            return;
          }

          if (result?.needs_login) {
            setStep("login");
            return;
          }
          if (result?.authorized) {
            setSuccessMsg("Conectado com sucesso!");
            setRedirectUrl(sanitizeCaptiveRedirect(result.redirect_url));
            setStep("success");
            
            // Auto-redirect signal for CNA
            const finalUrl = sanitizeCaptiveRedirect(result.redirect_url);
            if (finalUrl && finalUrl !== window.location.href) {
              setTimeout(() => { window.location.href = finalUrl; }, 1500);
            }
            return;
          }
          setError(result?.fail_reason ? "Não foi possível liberar. Faça login novamente." : "");
          setStep("login");
        } catch (err) {
          console.error("[auth] authorizeExisting failed:", err);
          setStep("login");
        }
      } else if (event === "SIGNED_OUT") {
        setStep("login");
        silentTriedRef.current = false;
      }
    });

    // Initial session check with a fallback timer for redirects
    const timer = setTimeout(() => {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session && !silentTriedRef.current) {
          console.log("[auth] session found in fallback check");
          // @ts-ignore
          supabase.auth._notifyAllChannels("SIGNED_IN", session);
        } else if (!session && step === "loading") {
          setStep("login");
        }
      });
    }, 1000);

    return () => {
      clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, []);


  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!loginEmail || !loginPassword) {
      setError("Informe e-mail e senha.");
      return;
    }
    setBusy(true);
    try {
      const params = getQueryParams();
      const result = await api.login({
        email: loginEmail.trim().toLowerCase(),
        password: loginPassword,
        client_mac: params.client_mac,
        ap_mac: params.ap_mac,
        ssid: params.ssid,
        redirect_url: params.redirect_url,
        captive_timestamp: params.captive_timestamp,
      });
      if (result?.error) {
        setError(result.error);
        setBusy(false);
        return;
      }
      if (result?.access_token && result?.refresh_token) {
        await supabase.auth.setSession({
          access_token: result.access_token,
          refresh_token: result.refresh_token,
        });
      }
      if (result?.authorized) {
        setSuccessMsg("Conectado com sucesso!");
        setRedirectUrl(sanitizeCaptiveRedirect(result.redirect_url));
        setStep("success");
      } else {
        setError(
          "Login realizado, mas o Wi-Fi não confirmou a liberação. Desconecte e conecte-se novamente à rede.",
        );
      }
    } catch {
      setError("Ainda está ocorrendo problemas ao conectar. Tente novamente.");
    }
    setBusy(false);
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");

    if (!name || name.trim().length < 2) return setError("Informe seu nome completo.");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError("E-mail inválido.");
    const phoneDigits = phone.replace(/\D/g, "");
    if (phoneDigits && (phoneDigits.length < 10 || phoneDigits.length > 11)) return setError("Telefone inválido.");
    if (password.length < 8) return setError("A senha deve ter ao menos 8 caracteres.");
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
      return setError("A senha deve conter letras e números.");
    if (password !== password2) return setError("As senhas não coincidem.");
    if (!consented) return setError("Você precisa aceitar os termos.");

    setBusy(true);
    try {
      const params = getQueryParams();
      const result = await api.signup({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        cpf: "",
        phone: phoneDigits,
        password,
        client_mac: params.client_mac,
        ap_mac: params.ap_mac,
        ssid: params.ssid,
        redirect_url: params.redirect_url,
        captive_timestamp: params.captive_timestamp,
        consent_version: boot.consent?.version || "1.0",
      });

      if (result?.error) {
        setError(result.error);
        setBusy(false);
        return;
      }
      if (result?.access_token && result?.refresh_token) {
        await supabase.auth.setSession({
          access_token: result.access_token,
          refresh_token: result.refresh_token,
        });
      }
      if (result?.authorized) {
        setSuccessMsg("Cadastro concluído. Conectado com sucesso!");
        setRedirectUrl(sanitizeCaptiveRedirect(result.redirect_url));
        setStep("success");
      } else {
        setError(
          "Conta criada, mas o Wi-Fi não confirmou a liberação. Desconecte e conecte-se novamente à rede.",
        );
      }
    } catch {
      setError("Ainda está ocorrendo problemas ao processar seu cadastro.");
    }
    setBusy(false);
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!forgotEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forgotEmail)) {
      setError("Informe um e-mail válido.");
      return;
    }
    setBusy(true);
    try {
      await api.requestPasswordReset({ email: forgotEmail.trim().toLowerCase() });
      // Always go to the confirmation screen (avoid account enumeration)
      setStep("forgot_sent");
    } catch {
      // Network glitch — still show the confirmation screen; backend swallowed enumeration risk
      setStep("forgot_sent");
    }
    setBusy(false);
  };

  const handleGoogleOAuth = async () => {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      stashCaptiveParams();
      const qs = window.location.search || "";
      const redirectTo = `http://minasbrasilwifi.com.br/`;
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo, skipBrowserRedirect: false },
      });
      if (err) {
        setError("Não foi possível iniciar login com Google.");
        setBusy(false);
      }
      // On success, the browser navigates away — no further UI update needed.
    } catch {
      setError("Erro ao iniciar login com Google. Tente novamente.");
      setBusy(false);
    }
  };



  // ── LOADING / AUTHORIZING ──
  if (step === "loading" || step === "authorizing") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <p style={{ color: "#888", marginTop: 12 }}>
            {step === "authorizing" ? "Liberando seu acesso..." : "Carregando..."}
          </p>
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
          <button onClick={() => { setError(""); setStep("login"); }} className="portal-btn">
            Tentar novamente
          </button>
          <Footer />
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
            <a
              href={redirectUrl}
              className="portal-btn"
              style={{ display: "inline-block", marginTop: 16, textDecoration: "none" }}
            >
              Continuar conexão
            </a>
          )}
          <Footer />
        </div>
      </div>
    );
  }

  // ── FORGOT PASSWORD ──
  if (step === "forgot") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card">
          <div style={{ textAlign: "center" }}>
            <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
            <p className="portal-slogan">vender barato é tradição</p>
          </div>
          <h1 className="portal-title">Recuperar senha</h1>
          <p className="portal-subtitle">
            Informe o e-mail da sua conta. Enviaremos um link para redefinir sua senha.
          </p>
          {error && <div className="portal-error">{error}</div>}
          <form onSubmit={handleForgot}>
            <label className="portal-label">E-mail</label>
            <input
              type="email" value={forgotEmail}
              onChange={(e) => setForgotEmail(e.target.value)}
              required className="portal-input" placeholder="email@exemplo.com"
              autoComplete="email"
            />
            <button type="submit" disabled={busy} className="portal-btn">
              {busy ? "Enviando..." : "Enviar link"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => { setError(""); setStep("login"); }}
            className="portal-btn-secondary"
          >
            Voltar
          </button>
          <Footer />
        </div>
      </div>
    );
  }

  if (step === "forgot_sent") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <h1 className="portal-title">Verifique seu e-mail</h1>
          <p className="portal-subtitle">
            Se existir uma conta com esse e-mail, enviaremos um link para redefinir a senha.
          </p>
          <p style={{ color: "#666", fontSize: 14, marginTop: 12 }}>
            Dica: o link precisa ser aberto <strong>fora do Wi-Fi da loja</strong> (use dados móveis
            ou outra rede). Depois de redefinir a senha, volte ao portal Wi-Fi e faça login.
          </p>
          <button
            type="button"
            onClick={() => { setError(""); setStep("login"); }}
            className="portal-btn"
            style={{ marginTop: 16 }}
          >
            Voltar ao login
          </button>
          <Footer />
        </div>
      </div>
    );
  }

  // ── SIGNUP ──
  if (step === "signup") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card">
          <div style={{ textAlign: "center" }}>
            <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
            <p className="portal-slogan">vender barato é tradição</p>
          </div>

          <h1 className="portal-title">Criar conta</h1>
          <p className="portal-subtitle">
            {boot.store.city ? `${boot.store.name} — ${boot.store.city}` : boot.store.name}
          </p>

          {error && <div className="portal-error">{error}</div>}

          <form onSubmit={handleSignup}>
            <label className="portal-label">Nome *</label>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)}
              required className="portal-input" placeholder="Seu nome completo"
            />

            <label className="portal-label">E-mail *</label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              required className="portal-input" placeholder="email@exemplo.com"
            />

            <label className="portal-label">Telefone *</label>
            <input
              type="tel" value={phone}
              onChange={(e) => setPhone(formatPhoneBR(e.target.value))}
              required className="portal-input" placeholder="(11) 99999-9999"
            />


            <label className="portal-label">Senha *</label>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              required minLength={8} className="portal-input"
              placeholder="Mínimo 8 caracteres, letras e números"
              autoComplete="new-password"
            />

            <label className="portal-label">Confirmar senha *</label>
            <input
              type="password" value={password2} onChange={(e) => setPassword2(e.target.value)}
              required minLength={8} className="portal-input"
              placeholder="Digite a senha novamente"
              autoComplete="new-password"
            />

            {boot.consent && (
              <>
                <details className="portal-terms">
                  <summary>Termos de Uso e Política de Privacidade (LGPD)</summary>
                  <p>{boot.consent.text}</p>
                </details>
                <label className="portal-checkbox-label">
                  <input
                    type="checkbox" checked={consented}
                    onChange={(e) => setConsented(e.target.checked)}
                  />
                  <span>Li e aceito os termos</span>
                </label>
              </>
            )}

            <button type="submit" disabled={busy} className="portal-btn">
              {busy ? "Criando conta..." : "Criar conta e conectar"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => { setError(""); setStep("login"); }}
            className="portal-btn-secondary"
          >
            Já tenho conta
          </button>

          <Footer />
        </div>
      </div>
    );
  }

  // ── LOGIN (default) ──
  return (
    <div className="portal-wrapper">
      <div className="portal-card">
        <div style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <p className="portal-slogan">vender barato é tradição</p>
        </div>

        <h1 className="portal-title">Acessar Wi-Fi</h1>
        <p className="portal-subtitle">
          {boot.store.city ? `${boot.store.name} — ${boot.store.city}` : boot.store.name}
        </p>


        {error && <div className="portal-error">{error}</div>}


        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => handleGoogleOAuth()}
            disabled={busy}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              padding: "12px 16px", background: "#fff", color: "#3c4043",
              border: "1px solid #dadce0", borderRadius: 8, fontSize: 15, fontWeight: 500,
              cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Continuar com Google
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 16px", color: "#999", fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: "#e5e7eb" }} />
          <span>ou entre com e-mail</span>
          <div style={{ flex: 1, height: 1, background: "#e5e7eb" }} />
        </div>



        <form onSubmit={handleLogin}>
          <label className="portal-label">E-mail</label>
          <input
            type="email" value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            required className="portal-input" placeholder="email@exemplo.com"
            autoComplete="email"
          />

          <label className="portal-label">Senha</label>
          <input
            type="password" value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            required className="portal-input" placeholder="Sua senha"
            autoComplete="current-password"
          />

          <button type="submit" disabled={busy} className="portal-btn">
            {busy ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => { setError(""); setForgotEmail(loginEmail); setStep("forgot"); }}
          className="portal-link-btn"
          style={{
            background: "none", border: "none", color: "#E30613",
            textDecoration: "underline", cursor: "pointer", padding: "8px 0",
            width: "100%", fontSize: 14,
          }}
        >
          Esqueci minha senha
        </button>

        <button
          type="button"
          onClick={() => { setError(""); setStep("signup"); }}
          className="portal-btn-secondary"
        >
          Não tem conta? Cadastre-se
        </button>

        <Footer />
      </div>
    </div>
  );
}
