import { useState, useEffect, useRef } from "react";
import { api, createClientSessionId } from "./lib/api";
import { getApiBase, getQueryParams, buildSubmitPayload, sanitizeCaptiveRedirect, type PortalStep } from "./lib/portal-utils";
import logoMinasBrasil from "./assets/logo-minas-brasil.png";
import "./index.css";

const API_BASE_FOR_TELEMETRY = (() => {
  try { return getApiBase(); } catch { return ""; }
})();

async function recoverAfterSubmitNetworkError(sid: string) {
  const waits = [500, 1200, 2500];
  for (const w of waits) {
    await new Promise(r => setTimeout(r, w));
    try {
      const status = await api.sessionStatus(sid);
      if (status?.requires_verification) return status;
      if (status?.authorized) return status;
      if (status?.use_hotspot_redirect) return status;
      if (status?.verified) return status;
    } catch { /* keep trying */ }
  }
  return null;
}

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
      try {
        const id = await startPromiseRef.current;
        if (id) return id;
      } catch {
        // A failed background /start must not poison the whole captive flow.
        startPromiseRef.current = null;
      }
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
    }).catch(err => {
      startPromiseRef.current = null;
      throw err;
    });
    startPromiseRef.current = promise;
    const id = await promise;
    if (!id) throw new Error("Não foi possível criar sessão. Tente novamente.");
    return id;
  };

  // Boot: show form immediately, fetch bootstrap + start in background
  useEffect(() => {
    setStep("form");

    // Hide HTML fallback — React mounted successfully
    const fb = document.getElementById("fb");
    if (fb) fb.style.display = "none";

    const params = getQueryParams();

    // Fingerprint of the current captive redirect — if UniFi sent us a new
    // id/ap/ssid/t we must NOT reuse the stored session from a previous
    // connection attempt.
    const fingerprint = [
      params.client_mac || "",
      params.ap_mac || "",
      params.ssid || "",
      params.captive_timestamp || "",
    ].join("|");
    const MAX_AGE_MS = 30 * 60 * 1000;

    let localSid: string | null = null;
    try {
      const storedSid = sessionStorage.getItem("mb_session_id");
      const storedFp = sessionStorage.getItem("mb_session_fingerprint");
      const storedAt = parseInt(sessionStorage.getItem("mb_session_created_at") || "0", 10);
      const fresh = storedAt && (Date.now() - storedAt) < MAX_AGE_MS;
      if (storedSid && storedFp === fingerprint && fresh) {
        localSid = storedSid;
      }
    } catch { /* ignore */ }

    if (!localSid) {
      localSid = createClientSessionId();
      try {
        sessionStorage.setItem("mb_session_id", localSid);
        sessionStorage.setItem("mb_session_fingerprint", fingerprint);
        sessionStorage.setItem("mb_session_created_at", String(Date.now()));
      } catch { /* ignore */ }
    }
    sessionIdRef.current = localSid;
    setSessionId(localSid);

    // Bootstrap (non-blocking)
    api.bootstrap()
      .then(data => { if (data && !data.error) setBoot(data); })
      .catch(() => { /* use fallback */ });

    // /start in background — does not block the form
    startPromiseRef.current = api.startSession({
      ...params,
      session_id: localSid,
    } as any).then(s => {
      const id = (s && s.session_id) || localSid!;
      sessionIdRef.current = id;
      setSessionId(id);
      try { sessionStorage.setItem("mb_session_id", id); } catch { /* ignore */ }
      return id;
    }).catch(err => {
      api.clientEvent({
        session_id: localSid,
        event: "start_background_failed",
        step: "params",
        status: "warning",
        error_code: err?.kind || "unknown",
        error_message: err?.message?.slice(0, 200),
      });
      return localSid;
    });
  }, []);

  useEffect(() => {
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
  }, []);

  // Restore session_id from sessionStorage on mount (CNA may reload page mid-flow)
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("mb_session_id");
      if (stored && !sessionIdRef.current) {
        sessionIdRef.current = stored;
        setSessionId(stored);
      }
    } catch { /* ignore */ }

    const onErr = (msg: unknown, src?: unknown, line?: unknown) => {
      try {
        api.clientEvent({
          session_id: sessionIdRef.current,
          event: "window_error",
          status: "error",
          error_message: String(msg).slice(0, 200),
          payload: { src: String(src).slice(0, 200), line: typeof line === "number" ? line : 0 },
        });
      } catch { /* ignore */ }
    };
    window.addEventListener("error", (e) => onErr(e.message, e.filename, e.lineno));
    window.addEventListener("unhandledrejection", (e) => onErr(e.reason?.message || e.reason || "unhandledrejection"));
  }, []);

  // Telemetry on entering OTP step
  useEffect(() => {
    if (step === "otp") {
      api.clientEvent({
        session_id: sessionIdRef.current,
        event: "otp_screen_mounted",
        step: "otp",
        status: "info",
        payload: { has_session: !!sessionIdRef.current },
      });
    }
  }, [step]);

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

    const params = getQueryParams();

    // Prefer session id from background /start; fall back to local one.
    let sid: string;
    try {
      sid = await ensureSession();
    } catch {
      sid = sessionIdRef.current || sessionId || createClientSessionId();
    }
    sessionIdRef.current = sid;
    setSessionId(sid);
    try { sessionStorage.setItem("mb_session_id", sid); } catch { /* ignore */ }

    api.clientEvent({
      session_id: sid,
      event: "submit_attempt_started",
      step: "form",
      status: "info",
      payload: {
        host: typeof window !== "undefined" ? window.location.hostname : "",
        api_base: API_BASE_FOR_TELEMETRY,
        has_client_mac: !!params.client_mac,
        has_ap_mac: !!params.ap_mac,
        ssid: params.ssid || null,
      },
    });

    try {
      const payload = buildSubmitPayload({
        session_id: sid,
        name, email, phone, cpf,
        client_mac: params.client_mac,
        consent_version: boot.consent?.version || "1.0",
      });
      Object.assign(payload, {
        ap_mac: params.ap_mac,
        ssid: params.ssid,
        redirect_url: params.redirect_url,
        captive_timestamp: params.captive_timestamp,
        site: params.site,
        original_unifi_url_params: {
          id: params.client_mac,
          ap: params.ap_mac,
          ssid: params.ssid,
          url: params.redirect_url,
          t: params.captive_timestamp,
          site: params.site,
          raw_query: params.raw_query,
        },
        user_agent: navigator.userAgent,
      });
      const result = await api.submitLead(payload);

      if (result?.session_id) {
        sessionIdRef.current = result.session_id;
        setSessionId(result.session_id);
        try { sessionStorage.setItem("mb_session_id", result.session_id); } catch { /* ignore */ }
      }

      api.clientEvent({
        session_id: sid,
        event: "submit_attempt_finished",
        step: "form",
        status: result?.error ? "error" : "success",
        payload: { has_error: !!result?.error, requires_verification: !!result?.requires_verification, ok: !!result?.ok },
      });

      if (result?.error) {
        setError(result.error);
      } else if (result?.requires_verification) {
        setRedirectUrl(sanitizeCaptiveRedirect(result.redirect_url));
        setStep("otp");
        startCooldown(60);
      } else if (result?.ok) {
        setSuccessMsg(result.message || "Cadastro realizado! Você já pode navegar.");
        setRedirectUrl(sanitizeCaptiveRedirect(result.redirect_url));
        setStep("success");
      } else {
        setError("Resposta inesperada do servidor. Tente novamente.");
      }
    } catch (err) {
      console.error("[portal] submit error:", err);
      const e2 = err as { kind?: string; message?: string };
      api.clientEvent({
        session_id: sid,
        event: "submit_attempt_failed",
        step: "form",
        status: "error",
        error_code: e2?.kind || "unknown",
        error_message: e2?.message?.slice(0, 200),
        payload: {
          host: typeof window !== "undefined" ? window.location.hostname : "",
          api_base: API_BASE_FOR_TELEMETRY,
        },
      });
      const backupPayload = buildSubmitPayload({
        session_id: sid,
        name, email, phone, cpf,
        client_mac: params.client_mac,
        consent_version: boot.consent?.version || "1.0",
      });
      Object.assign(backupPayload, {
        ap_mac: params.ap_mac,
        ssid: params.ssid,
        redirect_url: params.redirect_url,
        captive_timestamp: params.captive_timestamp,
        site: params.site,
        original_unifi_url_params: { id: params.client_mac, ap: params.ap_mac, ssid: params.ssid, url: params.redirect_url, t: params.captive_timestamp, site: params.site, raw_query: params.raw_query },
        user_agent: navigator.userAgent,
      });
      api.submitLeadBackup(backupPayload as Record<string, unknown>);

      // Recovery: backend may have processed /submit even if the response
      // never made it back. Poll /session-status with backoff.
      const recovered = await recoverAfterSubmitNetworkError(sid);
      if (recovered?.requires_verification) {
        api.clientEvent({ session_id: sid, event: "submit_recovery_success", step: "form", status: "success", payload: { outcome: "otp" } });
        setRedirectUrl(recovered.redirect_url || null);
        setStep("otp");
        startCooldown(60);
        setSubmitting(false);
        return;
      }
      if (recovered?.authorized) {
        api.clientEvent({ session_id: sid, event: "submit_recovery_success", step: "form", status: "success", payload: { outcome: "authorized" } });
        setSuccessMsg(recovered.message || "Conectado com sucesso!");
        setRedirectUrl(recovered.redirect_url || null);
        setStep("success");
        setSubmitting(false);
        return;
      }
      api.clientEvent({ session_id: sid, event: "submit_recovery_failed", step: "form", status: "error" });

      const friendly =
        e2?.kind === "timeout" ? "Tempo esgotado. Verifique o sinal e tente novamente." :
        e2?.kind === "network" ? "Falha de conexão. Verifique sua rede e tente novamente." :
        e2?.message || "Erro ao enviar cadastro. Tente novamente.";
      setError(friendly);
    }
    setSubmitting(false);
  };

  const handleVerify = async () => {
    let sid = sessionIdRef.current || sessionId;
    if (!sid) {
      try {
        const stored = sessionStorage.getItem("mb_session_id");
        if (stored) {
          sid = stored;
          sessionIdRef.current = stored;
          setSessionId(stored);
        }
      } catch { /* ignore */ }
    }
    if (!sid) {
      api.clientEvent({ event: "verify_no_session", status: "error" });
      setError("Sessão não encontrada. Recarregue a página.");
      return;
    }
    if (otpCode.length !== 6) return;
    setVerifying(true);
    setError("");

    api.clientEvent({ session_id: sid, event: "verify_attempt_started", step: "otp", status: "info" });

    // Proactive backup transport: fire sendBeacon/iframe POST in parallel with the XHR.
    // Captive Network Assistants on some devices silently drop XHR POST bodies for
    // /verify-code while still letting sendBeacon through. The backend dedupes by
    // session_id so duplicate /verify-code is safe.
    try { api.verifyCodeBackup({ session_id: sid, code: otpCode }); } catch { /* ignore */ }

    try {
      const result = await api.verifyCode({ session_id: sid, code: otpCode });
      api.clientEvent({
        session_id: sid,
        event: "verify_attempt_finished",
        step: "otp",
        status: result?.error ? "error" : (result?.authorized ? "success" : "warning"),
        payload: { has_error: !!result?.error, authorized: !!result?.authorized, use_hotspot_redirect: !!result?.use_hotspot_redirect },
      });
      if (result.error) {
        setError(result.error);
        setOtpCode("");
        setVerifying(false);
        return;
      }

      // Hotspot redirect has PRIORITY over authorized flag — backend already
      // accepted the OTP, and the UniFi controller will finalize liberation
      // when the browser hits /guest/s/<site>/.
      // Hotspot redirect: backend may try to send the user to the UniFi
      // controller (HTTPS, port 8443, raw IP). During the captive flow that
      // breaks the Android Captive Network Assistant with a cert error.
      // We sanitize: only HTTP same-domain redirects are allowed; otherwise
      // we keep the user on the in-app success screen.
      if (result.use_hotspot_redirect && result.redirect_url) {
        const safe = sanitizeCaptiveRedirect(result.redirect_url);
        setSuccessMsg(result.message || "Finalizando liberação do Wi-Fi...");
        setRedirectUrl(safe);
        setStep("success");
        setTimeout(() => { window.location.href = safe; }, 800);
        return;
      }

      if (result.authorized) {
        setSuccessMsg(result.message || "Conectado com sucesso!");
        const finalUrl = sanitizeCaptiveRedirect(result.redirect_url || redirectUrl);
        setRedirectUrl(finalUrl);
        setStep("success");
      } else {
        setError(result.message || "Cadastro confirmado, mas o UniFi não confirmou a liberação. Desconecte e conecte novamente à rede ou procure atendimento.");
        setOtpCode("");
      }
    } catch (err) {
      const e2 = err as { kind?: string; message?: string };
      api.clientEvent({
        session_id: sid,
        event: "verify_attempt_failed",
        step: "otp",
        status: "error",
        error_code: e2?.kind || "unknown",
        error_message: e2?.message?.slice(0, 200),
      });
      // Backup transport: captive assistants frequently drop the XHR POST response
      // for /verify-code. Fire a sendBeacon/iframe POST and poll /session-status
      // to recover the verify result.
      try { api.verifyCodeBackup({ session_id: sid, code: otpCode }); } catch { /* ignore */ }
      const recovered = await recoverAfterSubmitNetworkError(sid);
      if (recovered) {
        api.clientEvent({ session_id: sid, event: "verify_recovery_success", step: "otp", status: "success",
          payload: { authorized: !!recovered.authorized, use_hotspot_redirect: !!recovered.use_hotspot_redirect } });
        if (recovered.use_hotspot_redirect && recovered.redirect_url) {
          const safe = sanitizeCaptiveRedirect(recovered.redirect_url);
          setSuccessMsg("Finalizando liberação do Wi-Fi...");
          setRedirectUrl(safe);
          setStep("success");
          setTimeout(() => { window.location.href = safe; }, 800);
          setVerifying(false);
          return;
        }
        if (recovered.authorized) {
          setSuccessMsg("Conectado com sucesso!");
          setRedirectUrl(sanitizeCaptiveRedirect(recovered.redirect_url || redirectUrl));
          setStep("success");
          setVerifying(false);
          return;
        }
      }
      api.clientEvent({ session_id: sid, event: "verify_recovery_failed", step: "otp", status: "error" });
      setError("Erro ao verificar código. Tente novamente.");
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
