import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api, ApiError } from "./lib/api";
import { supabase } from "./integrations/supabase/client";
import {
  getQueryParams,
  resolvePostAuthRedirect,
  formatCPF,
  Validators,
} from "./lib/portal-utils";
import { OAuthTracker } from "./lib/oauth-tracker";
import { getAuthFailureMessage, isRecoverableAuthResult } from "./lib/auth-outcome";
import { useOAuthCallback } from "./hooks/useOAuthCallback";
import logoMinasBrasil from "./assets/logo-minas-brasil.png";
import Footer from "./components/Footer";
import { SuccessView } from "./components/SuccessView";
import "./index.css";



type Step = 
  | "loading" 
  | "oauth_redirecting" 
  | "oauth_callback" 
  | "login" 
  | "signup" 
  | "forgot" 
  | "forgot_sent" 
  | "authorizing" 
  | "success" 
  | "error" 
  | "cpf_prompt";

// CAPTIVE_PARAMS_STORAGE_KEY was removed as it was unused.




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
  const digits = (value || "").replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits.length ? `(${digits}` : "";
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  
  // Use a local ref to track if component is mounted to prevent state updates on unmounted component
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const [step, setStep] = useState<Step>("loading");
  const [boot, setBoot] = useState<BootstrapData>(FALLBACK_BOOT);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [busy, setBusy] = useState(false);
  
  // Scroll to top on error to ensure user sees the message
  useEffect(() => {
    if (error) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [error]);

  const stepRef = useRef<Step>("loading");
  useEffect(() => { stepRef.current = step; }, [step]);

  // Returning from Google through the captive's Back button may restore the
  // page from bfcache, including its disabled button and redirecting spinner.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && stepRef.current === "oauth_redirecting") {
        setBusy(false);
        setError("O login do Google não foi concluído. Tente novamente ou entre com e-mail nesta janela.");
        setStep("login");
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
  
  // Processing refs for idempotency
  const processingAuthRef = useRef<Promise<any> | null>(null);
  const authCompletedRef = useRef(false);

  // login form
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [googleUser, setGoogleUser] = useState<{ full_name: string; email: string } | null>(null);

  // forgot password
  const [forgotEmail, setForgotEmail] = useState("");

  // CPF Prompt (for Google users)
  const [promptCpf, setPromptCpf] = useState("");
  const [googleConsented, setGoogleConsented] = useState(false);

  // signup form fields state
  const [signupFields, setSignupFields] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
    passwordConfirm: "",
    consented: false
  });

  // Grouped logic for signup form to improve code quality
  const _isSignupValid = useMemo(() => {
    const { name, email, phone, password, passwordConfirm, consented } = signupFields;
    return (
      name.trim().split(/\s+/).length >= 2 &&
      Validators.email(email) &&
      Validators.phone(phone.replace(/\D/g, "")) &&
      password.length >= 8 &&
      password === passwordConfirm &&
      consented
    );
  }, [signupFields]);

  const handleAuthOutcome = useCallback((result: any, successMessage: string) => {
    if (result?.authorized) {
      setSuccessMsg(successMessage);
      const params = getQueryParams();
      const finalUrl = resolvePostAuthRedirect(result.redirect_url, params.redirect_url);
      setRedirectUrl(finalUrl);
      setStep("success");
      authCompletedRef.current = true;
      OAuthTracker.clearAll();
      return true;
    }
    return false;
  }, []);

  const handleAuthComplete = useCallback(() => {
    OAuthTracker.clearAll();
  }, []);

  const isOAuthCallbackFlow = useMemo(() => {
    return location.pathname === "/oauth/callback";
  }, [location.pathname]);
  const isOAuthContinueFlow = location.pathname === "/oauth/continue";
  const isOAuthRoute = isOAuthCallbackFlow || isOAuthContinueFlow;

  const { status: oauthStatus } = useOAuthCallback({
    enabled: isOAuthCallbackFlow,
    onSuccess: (result) => {
      handleAuthOutcome(result, "Wi-Fi liberado com sucesso!");
    },
    onError: (msg) => {
      setError(msg);
      setStep("error");
    },
    onNeedsCpf: (profile) => {
      if (profile) setGoogleUser(profile);
      setStep("cpf_prompt");
    }
  });

  useEffect(() => {
    if (oauthStatus === "processing") {
      setStep("authorizing");
    } else if (oauthStatus === "waiting") {
      setStep("oauth_callback");
    }
  }, [oauthStatus]);

  useEffect(() => {
    // Force production domain for OAuth compatibility
    const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    const isCanonical = window.location.hostname === "minasbrasilwifi.com.br" && window.location.protocol === "https:";
    
    if (!isLocal && !isCanonical) {
      console.log("[boot] non-canonical origin, redirecting to https://minasbrasilwifi.com.br");
      window.location.href = "https://minasbrasilwifi.com.br" + window.location.pathname + window.location.search + window.location.hash;
      return;
    }

    // Only callbacks may restore stored parameters. A fresh captive visit must
    // never be hijacked by state left by another device/attempt.
    if (location.pathname === "/oauth/callback") OAuthTracker.restoreCaptiveParams();

    // Non-blocking bootstrap (store name / consent text)
    api.bootstrap().then(
      (b) => {
        if (b?.store && isMounted.current) setBoot({ store: b.store, consent: b.consent || FALLBACK_BOOT.consent });
      },
      () => { /* keep fallback */ },
    );

  }, [location.pathname]);

  useEffect(() => {
    if (!isOAuthContinueFlow) return;
    let cancelled = false;

    const continueInCaptive = async () => {
      setStep("oauth_redirecting");
      const handoff = new URLSearchParams(window.location.search).get("handoff") || "";
      if (!handoff) {
        setError("A transferência para o navegador está ausente ou expirou.");
        setStep("error");
        return;
      }

      // Compatibility for links issued by older builds. Claim their one-time
      // state here, but never ask the captive to launch another browser.
      const claimed = await OAuthTracker.claimExternalHandoff(handoff);
      window.history.replaceState(null, "", "/oauth/continue");
      if (cancelled) return;
      if (!claimed) {
        setError("A transferência para o navegador expirou. Volte ao Wi-Fi e inicie novamente.");
        setStep("error");
        return;
      }

      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: "https://minasbrasilwifi.com.br/oauth/callback",
          skipBrowserRedirect: false,
        },
      });
      if (!cancelled && oauthError) {
        setError("Não foi possível iniciar o login do Google no navegador.");
        setStep("error");
      }
    };

    void continueInCaptive().catch(() => {
      if (cancelled) return;
      setBusy(false);
      setError("Não foi possível continuar o login do Google. Tente novamente ou entre com e-mail.");
      setStep("error");
    });
    return () => { cancelled = true; };
  }, [isOAuthContinueFlow]);

  const completeAuthenticatedSession = async (session: any, source: "google" | "silent") => {
    // Legacy helper kept for CPF submit flow, but most flows now use the hook
    if (authCompletedRef.current) return;
    if (processingAuthRef.current) return processingAuthRef.current;
    
    processingAuthRef.current = (async () => {
      try {
        setStep("authorizing");
        const params = getQueryParams();
        const tokens = await OAuthTracker.ensureAttempt();
        if (!tokens) {
          setError("Não foi possível criar uma tentativa segura. Tente novamente.");
          setStep("error");
          return;
        }
        const result = await api.authorizeExisting({
          access_token: session.access_token,
          client_mac: params.client_mac,
          ap_mac: params.ap_mac,
          ssid: params.ssid,
          redirect_url: params.redirect_url,
          captive_timestamp: params.captive_timestamp,
          auth_method: source,
          attempt_id: tokens.attempt_id,
          resume_token: tokens.token,
        });

        if (result?.needs_cpf) {
          if (result.profile) setGoogleUser(result.profile);
          setStep("cpf_prompt");
          return result;
        }

        if (result?.authorized) {
          handleAuthOutcome(result, "Wi-Fi liberado com sucesso!");
          return result;
        }

        if (!isRecoverableAuthResult(result)) OAuthTracker.clearAll();
        setError(getAuthFailureMessage(result));
        setStep("error");
        return result;
      } catch (err) {
        if (err instanceof ApiError && err.kind === "http" && [400, 401, 403].includes(err.status || 0)) {
          OAuthTracker.clearAll();
          setError(err.message);
          setStep("error");
          return;
        }
        setError(getAuthFailureMessage({ processing: true }));
        setStep("error");
        console.error("[auth] completion failed", err);
      } finally {
        processingAuthRef.current = null;
      }
    })();

    return processingAuthRef.current;
  };

  // Existing sessions outside the OAuth callback use a fresh authoritative
  // attempt and the same completion path. Without this branch, a returning
  // user with a valid session remains on the loading screen indefinitely.
  useEffect(() => {
    if (isOAuthRoute || stepRef.current !== "loading") return;
    let cancelled = false;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled || !isMounted.current) return;
      if (!session) {
        setStep("login");
        return;
      }
      void completeAuthenticatedSession(session, "silent");
    }).catch(() => {
      if (!cancelled && isMounted.current) setStep("login");
    });

    return () => { cancelled = true; };
  }, [isOAuthRoute]);


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
      const tokens = await OAuthTracker.ensureAttempt();
      if (!tokens) {
        setError("Não foi possível criar uma tentativa segura. Tente novamente.");
        setBusy(false);
        return;
      }
      
      const result = await api.login({
        email: loginEmail.trim().toLowerCase(),
        password: loginPassword,
        client_mac: params.client_mac,
        ap_mac: params.ap_mac,
        ssid: params.ssid,
        redirect_url: params.redirect_url,
        captive_timestamp: params.captive_timestamp,
        attempt_id: tokens.attempt_id,
        resume_token: tokens.token,
      });
      if (result?.error) {
        setError(result.error);
        setBusy(false);
        return;
      }
      if (result?.access_token && result?.refresh_token) {
        authCompletedRef.current = true; // Prevent listener from firing
        await supabase.auth.setSession({
          access_token: result.access_token,
          refresh_token: result.refresh_token,
        });
      }
      if (!handleAuthOutcome(result, "Conectado com sucesso!")) {
        if (!isRecoverableAuthResult(result)) OAuthTracker.clearAll();
        setError(getAuthFailureMessage(result));
        setStep("error");
      }
    } catch (err: any) {
      setError(err?.message || "Não foi possível conectar. Por favor, verifique seus dados e tente novamente.");
    }
    setBusy(false);
  };

  const handleCpfSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");

    const digits = promptCpf.replace(/\D/g, "");
    if (!Validators.cpf(digits)) {
      setError("CPF inválido. Verifique os números informados.");
      return;
    }
    if (!googleConsented || !boot.consent?.version) {
      setError("Leia e aceite os termos de privacidade para continuar.");
      return;
    }

    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setStep("login");
        setBusy(false);
        return;
      }

      const result = await api.updateProfile({
        access_token: session.access_token,
        cpf: digits,
        consent_version: boot.consent.version,
      });

      if (result?.error) {
        if (result.error.includes("já está cadastrado")) {
          setError("Este CPF já está cadastrado em outra conta.");
        } else {
          setError(result.error || "Erro ao atualizar CPF.");
        }
        setBusy(false);
        return;
      }

      // Success! Now authorize UniFi.
      authCompletedRef.current = false;
      await completeAuthenticatedSession(session, "google");
    } catch (err) {
      console.error("[cpf] submit error:", err);
      setError("Erro ao processar. Tente novamente.");
    } finally {
      setBusy(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");

    const { name, email, phone, password, passwordConfirm, consented } = signupFields;

    if (!name || name.trim().split(/\s+/).length < 2) return setError("Informe seu nome completo (nome e sobrenome).");
    if (!Validators.email(email)) return setError("Informe um e-mail válido.");
    
    const phoneDigits = phone.replace(/\D/g, "");
    if (!Validators.phone(phoneDigits)) return setError("Informe um telefone válido com DDD.");
    
    if (password.length < 8) return setError("A senha deve ter pelo menos 8 caracteres.");
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
      return setError("A senha deve conter letras e números.");
    if (password !== passwordConfirm) return setError("As senhas não coincidem.");
    if (!consented) return setError("Você deve aceitar os termos de uso para continuar.");

    setBusy(true);
    try {
      const params = getQueryParams();
      const tokens = await OAuthTracker.ensureAttempt();
      if (!tokens) {
        setError("Não foi possível criar uma tentativa segura. Tente novamente.");
        setBusy(false);
        return;
      }
      
      const result = await api.signup({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        phone: phoneDigits,
        password,
        client_mac: params.client_mac,
        ap_mac: params.ap_mac,
        ssid: params.ssid,
        redirect_url: params.redirect_url,
        captive_timestamp: params.captive_timestamp,
        consent_version: boot.consent?.version || "1.0",
        attempt_id: tokens.attempt_id,
        resume_token: tokens.token,
      });

      if (result?.error) {
        setError(result.error);
        setBusy(false);
        return;
      }
      if (result?.access_token && result?.refresh_token) {
        authCompletedRef.current = true;
        await supabase.auth.setSession({
          access_token: result.access_token,
          refresh_token: result.refresh_token,
        });
      }
      if (!handleAuthOutcome(result, "Cadastro concluído. Conectado com sucesso!")) {
        if (!isRecoverableAuthResult(result)) OAuthTracker.clearAll();
        setError(getAuthFailureMessage(result));
        setStep("error");
      }
    } catch (err: any) {
      setError(err?.message || "Não foi possível concluir seu cadastro. Por favor, verifique os dados e tente novamente.");
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
    setStep("oauth_redirecting");
    
    try {
      api.clientEvent({ event: "google_oauth_started", step: "oauth" });
      const tokens = await OAuthTracker.initOAuthTransaction();
      if (!tokens) {
        setError("Não foi possível preparar o ambiente para login com Google.");
        setStep("login");
        setBusy(false);
        return;
      }
      
      // Supabase redirects this same window. Do not use intents, popups, or
      // external browser handoffs: they trigger the captive's exit warning.
      const redirectTo = "https://minasbrasilwifi.com.br/oauth/callback";
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo, skipBrowserRedirect: false },
      });
      
      if (err) {
        api.clientEvent({ 
          event: "google_oauth_started", 
          step: "oauth", 
          status: "error", 
          error_message: err.message 
        });
        setError("Não foi possível iniciar login com Google.");
        setStep("login");
        setBusy(false);
      }
    } catch (e) {
      console.error("[oauth] initiation error:", e);
      setError("Erro ao iniciar login com Google. Tente novamente.");
      setStep("login");
      setBusy(false);
    }
  };



  // ── CPF PROMPT (Google Auth Gate) ──
  if (step === "cpf_prompt") {
    const handleGoogleRestart = async () => {
      if (busy) return;
      setError("");
      const tokens = OAuthTracker.getTokens();
      
      if (!tokens.attempt_id || !tokens.token) {
        setError("Sessão expirada. Por favor, reinicie o login.");
        OAuthTracker.clearAll();
        setStep("login");
        return;
      }

      setBusy(true);
      try {
        api.clientEvent({ event: "google_oauth_restart_started", step: "oauth" });
        
        // 1. Backend cancels old and creates new attempt
        const res = await api.restartOAuth({ 
          attempt_id: tokens.attempt_id,
          resume_token: tokens.token 
        });

        if (res.attempt_id && res.token) {
          // 2. Update storage with the new pair. Capability tokens are never
          // placed in the callback URL, browser history, or referrer headers.
          OAuthTracker.updateTokens(res.attempt_id, res.token);
          
          // 3. Controlled signOut
          await supabase.auth.signOut();

          // 4. Immediate new OAuth; the pair stays in local storage.
          const callbackUrl = "https://minasbrasilwifi.com.br/oauth/callback";
          
          const { error: oauthErr } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: { 
              redirectTo: callbackUrl, 
              skipBrowserRedirect: false,
              queryParams: { prompt: "select_account" }
            },
          });

          if (oauthErr) throw oauthErr;
          return; // Browser will redirect
        } else {
          throw new Error("Falha ao reiniciar sessão no servidor.");
        }
      } catch (e: any) {
        console.error("[restart] failed:", e);
        setError("Não foi possível trocar de conta. Tente novamente ou faça login manual.");
        setBusy(false);
      }
    };

    return (
      <div className="portal-wrapper">
        <div className="portal-card">
          <div style={{ textAlign: "center" }}>
            <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
            <p className="portal-slogan">vender barato é tradição</p>
          </div>

          <h1 className="portal-title">Complete seu acesso</h1>
          <p className="portal-subtitle">
            Olá, <strong>{googleUser?.full_name || "Cliente"}</strong>! 
            Para liberar seu Wi-Fi, informe seu CPF:
          </p>

          <form onSubmit={handleCpfSubmit}>
            {error && <div className="portal-error">{error}</div>}
            
            <label className="portal-label">CPF</label>
            <input
              type="tel"
              className="portal-input"
              placeholder="000.000.000-00"
              value={formatCPF(promptCpf)}
              onChange={(e) => setPromptCpf(e.target.value)}
              disabled={busy}
              required
            />

            {boot.consent && (
              <div className="mt-4 text-left">
                <details className="portal-terms">
                  <summary>Termos de Uso e LGPD</summary>
                  <div className="p-3 text-[11px] text-gray-500 bg-gray-50 rounded-b-lg border-t border-gray-100 max-h-32 overflow-y-auto">
                    {boot.consent.text}
                  </div>
                </details>
                <label className="portal-checkbox-label mt-2">
                  <input
                    type="checkbox"
                    checked={googleConsented}
                    onChange={(e) => setGoogleConsented(e.target.checked)}
                    disabled={busy}
                  />
                  <span>Li e aceito os termos de privacidade.</span>
                </label>
              </div>
            )}
            
            <button type="submit" className="portal-btn" disabled={busy || !googleConsented || promptCpf.replace(/\D/g, "").length !== 11}>
              {busy ? "Processando..." : "Confirmar e Liberar Wi-Fi"}
            </button>

            <button 
              type="button" 
              className="portal-btn-secondary" 
              onClick={handleGoogleRestart}
              disabled={busy}
            >
              Usar outra conta
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (step === "success") {
    return (
      <SuccessView 
        redirectUrl={redirectUrl} 
        successMsg={successMsg} 
        onComplete={handleAuthComplete} 
      />
    );
  }

  // ── LOADING / OAUTH STATES / AUTHORIZING ──
  if (step === "loading" || step === "oauth_redirecting" || step === "oauth_callback" || step === "authorizing") {

    let msg = "Carregando...";
    if (step === "oauth_redirecting") msg = "Abrindo login do Google...";
    if (step === "oauth_callback") msg = "Concluindo login do Google...";
    if (step === "authorizing") msg = "Liberando seu acesso ao Wi-Fi...";

    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <p className="mt-4 text-gray-500 font-medium">{msg}</p>
        </div>
      </div>
    );
  }

  // ── ERROR ──
  if (step === "error") {
    const isOAuthError = error.includes("Google") || OAuthTracker.isValidOAuthFlow();
    const isRecoverable = error.includes("ainda está sendo confirmada");
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <h1 className="portal-title">Erro</h1>
          <p className="portal-subtitle">{error || "Ocorreu um erro inesperado."}</p>
          <button 
            onClick={() => { 
              setError(""); 
              setBusy(false);
              if (isRecoverable) {
                window.location.reload();
              } else if (isOAuthError) {
                OAuthTracker.clearAll();
                setStep("login");
              } else {
                setStep("login");
              }
            }} 
            className="portal-btn"
          >
            {isRecoverable ? "Verificar novamente" : isOAuthError ? "Voltar e tentar novamente" : "Tentar novamente"}
          </button>
          <Footer />
        </div>
      </div>
    );
  }

  // The success effect has been moved to SuccessView component to comply with Rules of Hooks


  // ── FORGOT PASSWORD ──
  if (step === "forgot") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card">
          <div className="text-center mb-6">
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
          <div className="text-center mb-6">
            <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
            <p className="portal-slogan">vender barato é tradição</p>
          </div>

          <h1 className="portal-title">Criar conta</h1>
          <p className="portal-subtitle">
            {boot.store.city ? `${boot.store.name} — ${boot.store.city}` : boot.store.name}
          </p>

          {error && <div className="portal-error">{error}</div>}

          <form onSubmit={handleSignup} className="space-y-4">
            <div>
              <label className="portal-label">Nome Completo *</label>
              <input
                type="text" value={signupFields.name} 
                onChange={(e) => setSignupFields(prev => ({ ...prev, name: e.target.value }))}
                required className="portal-input" placeholder="Seu nome e sobrenome"
                autoComplete="name"
              />
            </div>

            <div>
              <label className="portal-label">E-mail *</label>
              <input
                type="email" value={signupFields.email} 
                onChange={(e) => setSignupFields(prev => ({ ...prev, email: e.target.value.toLowerCase().trim() }))}
                required className="portal-input" placeholder="seu@email.com"
                autoComplete="email"
              />
            </div>

            <div>
              <label className="portal-label">Celular *</label>
              <input
                type="tel" value={signupFields.phone}
                onChange={(e) => setSignupFields(prev => ({ ...prev, phone: formatPhoneBR(e.target.value) }))}
                required className="portal-input" placeholder="(00) 00000-0000"
                autoComplete="tel"
              />
            </div>

            <div>
              <label className="portal-label">Senha *</label>
              <input
                type="password" value={signupFields.password} 
                onChange={(e) => setSignupFields(prev => ({ ...prev, password: e.target.value }))}
                required minLength={8} className="portal-input"
                placeholder="Mínimo 8 caracteres (letras e números)"
                autoComplete="new-password"
              />
            </div>

            <div>
              <label className="portal-label">Confirmar Senha *</label>
              <input
                type="password" value={signupFields.passwordConfirm} 
                onChange={(e) => setSignupFields(prev => ({ ...prev, passwordConfirm: e.target.value }))}
                required minLength={8} className="portal-input"
                placeholder="Repita sua senha"
                autoComplete="new-password"
              />
            </div>

            {boot.consent && (
              <div className="mt-4">
                <details className="portal-terms">
                  <summary>Termos de Uso e LGPD</summary>
                  <div className="p-3 text-[11px] text-gray-500 bg-gray-50 rounded-b-lg border-t border-gray-100 max-h-32 overflow-y-auto">
                    {boot.consent.text}
                  </div>
                </details>
                <label className="portal-checkbox-label mt-2">
                  <input
                    type="checkbox" checked={signupFields.consented}
                    onChange={(e) => setSignupFields(prev => ({ ...prev, consented: e.target.checked }))}
                  />
                  <span>Li e aceito os <button type="button" className="text-red-600 font-bold hover:underline bg-transparent border-none p-0 inline cursor-pointer" onClick={() => navigate("/politica-privacidade")}>Termos de Privacidade</button></span>
                </label>
              </div>
            )}

            <button type="submit" disabled={busy} className="portal-btn">
              {busy ? "Processando..." : "Cadastrar e Conectar"}
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
        <div className="text-center mb-6">
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <p className="portal-slogan">vender barato é tradição</p>
        </div>

        <h1 className="portal-title">Acessar Wi-Fi</h1>
        <p className="portal-subtitle">
          {boot.store.city ? `${boot.store.name} — ${boot.store.city}` : boot.store.name}
        </p>


        {error && <div className="portal-error">{error}</div>}


        <div className="flex flex-col gap-3 mb-6">
          <button
            type="button"
            onClick={() => handleGoogleOAuth()}
            disabled={busy}
            className="flex items-center justify-center gap-3 py-3 px-4 bg-white text-gray-700 border border-gray-300 rounded-xl text-[15px] font-semibold transition-all hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed"
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

        <div className="flex items-center gap-3 my-4 text-gray-400 text-xs font-semibold uppercase tracking-wider">
          <div className="flex-1 h-px bg-gray-200" />
          <span>ou entre com e-mail</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>



        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="portal-label">E-mail</label>
            <input
              type="email" value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              required className="portal-input" placeholder="seu@email.com"
              autoComplete="email"
            />
          </div>

          <div>
            <label className="portal-label">Senha</label>
            <input
              type="password" value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              required className="portal-input" placeholder="Sua senha"
              autoComplete="current-password"
            />
          </div>

          <button type="submit" disabled={busy} className="portal-btn">
            {busy ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => { setError(""); setForgotEmail(loginEmail); setStep("forgot"); }}
          className="portal-link-btn w-full py-2 text-sm text-red-600 font-bold hover:underline transition-colors"
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
