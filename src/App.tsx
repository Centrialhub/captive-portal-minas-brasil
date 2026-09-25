import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./lib/api";
import { supabase } from "./integrations/supabase/client";
import { formatCPF, getQueryParams, resolvePostAuthRedirect, Validators } from "./lib/portal-utils";
import { AttemptTracker, monotonicNow, type TrackedAttempt } from "./lib/attempt-tracker";
import { getAuthFailureMessage, isRecoverableAuthResult, withDeadline, type AuthResult } from "./lib/auth-outcome";
import logoMinasBrasil from "./assets/logo-minas-brasil.png";
import Footer from "./components/Footer";
import { SuccessView } from "./components/SuccessView";
import "./index.css";

type Step = "loading" | "identity" | "authorizing" | "pending" | "success" | "error";
type CheckSource = "automatic" | "resume" | "manual";

interface BootstrapData {
  store: { slug: string | null; name: string; city?: string | null };
  consent: { version: string; text: string } | null;
}

const FALLBACK_BOOT: BootstrapData = {
  store: { slug: null, name: "Drogaria Minas Brasil" },
  consent: {
    version: "1.0",
    text: "Ao se conectar à rede Wi-Fi da Drogaria Minas Brasil, você concorda com a coleta e o tratamento do seu CPF e telefone para identificação, segurança da rede e comunicações promocionais, conforme a LGPD (Lei nº 13.709/2018). Você pode solicitar a exclusão dos seus dados a qualquer momento.",
  },
};
const SESSION_DEADLINE_MS = 3000;
const STATUS_WATCH_MS = 120000;
const RESUME_INTERVAL_MS = 1000;

function formatPhoneBR(value: string): string {
  const digits = (value || "").replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits.length ? "(" + digits : "";
  if (digits.length <= 6) return "(" + digits.slice(0, 2) + ") " + digits.slice(2);
  if (digits.length <= 10) return "(" + digits.slice(0, 2) + ") " + digits.slice(2, 6) + "-" + digits.slice(6);
  return "(" + digits.slice(0, 2) + ") " + digits.slice(2, 7) + "-" + digits.slice(7);
}

export default function App() {
  const mountedRef = useRef(false);
  const epochRef = useRef(0);
  const inFlightRef = useRef<symbol | null>(null);
  const stepRef = useRef<Step>("loading");
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkStatusRef = useRef<(source?: CheckSource) => Promise<void>>();
  const nextCheckRef = useRef(0);
  const watchUntilRef = useRef(0);
  const failuresRef = useRef(0);
  const lastResultRef = useRef<AuthResult | null>(null);
  const exchangedRef = useRef(new Map<string, "pending" | "done">());
  const [step, setStep] = useState<Step>("loading");
  const [boot, setBoot] = useState<BootstrapData>(FALLBACK_BOOT);
  const [phone, setPhone] = useState("");
  const [cpf, setCpf] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [clockNow, setClockNow] = useState(monotonicNow);
  const [manualOnly, setManualOnly] = useState(false);
  const [errorAction, setErrorAction] = useState<"identity" | "restart">("identity");
  const [confirmed, setConfirmed] = useState<{ attemptId: string; result: AuthResult; autoRedirect: boolean } | null>(null);
  const [redirectReady, setRedirectReady] = useState(true);

  const showStep = useCallback((value: Step) => {
    stepRef.current = value;
    setStep(value);
  }, []);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const telemetry = useCallback((event: string, status = "info", extra: Record<string, unknown> = {}) => {
    const attempt = AttemptTracker.get();
    api.clientEvent({
      session_id: lastResultRef.current?.session_id,
      attempt_id: attempt?.attempt_id,
      resume_token: attempt?.token,
      event, step: "client", status,
      payload: {
        attempt_id: attempt?.attempt_id,
        operation_id: lastResultRef.current?.operation_id,
        online: navigator.onLine,
        ...extra,
      },
    });
  }, []);

  const waitBeforeNextCheck = useCallback((delayMs: number, automatic = true) => {
    clearPoll();
    const delay = Math.max(1000, Math.min(delayMs, 2147480000));
    nextCheckRef.current = monotonicNow() + delay;
    setRetryAt(nextCheckRef.current);
    setClockNow(monotonicNow());
    const withinBudget = watchUntilRef.current > nextCheckRef.current;
    setManualOnly(!automatic || !withinBudget);
    if (!automatic || !withinBudget || document.visibilityState === "hidden" || navigator.onLine === false) return;
    pollTimerRef.current = setTimeout(() => { void checkStatusRef.current?.("automatic"); }, delay);
  }, [clearPoll]);

  const returnToIdentity = useCallback((message = "", clearAttempt = false) => {
    clearPoll();
    if (clearAttempt) AttemptTracker.clear();
    watchUntilRef.current = 0;
    const cooldown = AttemptTracker.cooldownRemaining();
    nextCheckRef.current = cooldown ? monotonicNow() + cooldown : 0;
    setRetryAt(nextCheckRef.current);
    setClockNow(monotonicNow());
    setError(message);
    setBusy(false);
    showStep("identity");
  }, [clearPoll, showStep]);

  const applyResult = useCallback((result: AuthResult, attempt: TrackedAttempt, epoch: number, requestStarted: number) => {
    if (!mountedRef.current || epoch !== epochRef.current) return;
    AttemptTracker.validateFromServer(attempt.attempt_id, result.server_now, requestStarted);
    if (AttemptTracker.get()?.attempt_id !== attempt.attempt_id) {
      returnToIdentity("A conexão desta visita mudou ou expirou. Confirme seus dados novamente.");
      return;
    }
    lastResultRef.current = result;
    failuresRef.current = 0;
    clearPoll();

    if (result.authorized === true) {
      nextCheckRef.current = monotonicNow() + RESUME_INTERVAL_MS;
      AttemptTracker.markConfirmed(attempt.attempt_id);
      setError("");
      setPhone("");
      setCpf("");
      setConfirmed({ attemptId: attempt.attempt_id, result, autoRedirect: !AttemptTracker.get()?.redirect_attempted });
      const shouldExchange = !!result.session_token_hash && !exchangedRef.current.has(attempt.attempt_id);
      setRedirectReady(!shouldExchange && exchangedRef.current.get(attempt.attempt_id) !== "pending");
      showStep("success");
      if (shouldExchange) {
        exchangedRef.current.set(attempt.attempt_id, "pending");
        // The network authorization is already confirmed. Session persistence
        // gets a bounded grace period before navigation and never regresses it.
        void withDeadline(supabase.auth.verifyOtp({
          token_hash: result.session_token_hash!,
          type: "magiclink",
        }), SESSION_DEADLINE_MS).then(exchange => {
          if (!mountedRef.current || epoch !== epochRef.current) return;
          exchangedRef.current.set(attempt.attempt_id, "done");
          const ok = exchange.outcome === "completed" && !exchange.value.error;
          telemetry("browser_session", ok ? "success" : "warning", { outcome: ok ? "persisted" : exchange.outcome === "timeout" ? "timeout" : "failed" });
          setRedirectReady(true);
        });
      }
      return;
    }

    if (result.status === "awaiting_identity" || result.needs_cpf || result.needs_login) {
      AttemptTracker.markSubmitted(attempt.attempt_id, false);
      returnToIdentity("Confirme seus dados para continuar.");
      return;
    }

    if (isRecoverableAuthResult(result)) {
      const remaining = result.deadline_at && result.server_now
        ? Math.max(0, Date.parse(result.deadline_at) - Date.parse(result.server_now) + 30000) : STATUS_WATCH_MS;
      const serverDeadline = requestStarted + Math.min(STATUS_WATCH_MS, remaining);
      watchUntilRef.current = watchUntilRef.current ? Math.min(watchUntilRef.current, serverDeadline) : serverDeadline;
      setError("");
      showStep("pending");
      waitBeforeNextCheck(result.retry_after_ms ?? 2000);
      return;
    }

    const unknownExpired = result.status === "expired_unconfirmed";
    nextCheckRef.current = unknownExpired ? monotonicNow() + (result.retry_after_ms ?? 30000) : 0;
    setRetryAt(nextCheckRef.current);
    setClockNow(monotonicNow());
    setError(getAuthFailureMessage(result));
    setErrorAction(unknownExpired ? "restart" : "identity");
    showStep("error");
    telemetry("authorization_outcome", "warning", { state: result.status || "rejected", reason: result.fail_reason });
  }, [clearPoll, returnToIdentity, showStep, telemetry, waitBeforeNextCheck]);

  const handleFailure = useCallback((caught: unknown, attempt: TrackedAttempt | null, fromStatus: boolean) => {
    const err = caught instanceof ApiError ? caught : null;
    const message = caught instanceof Error ? caught.message : "Não foi possível conectar. Tente novamente.";
    telemetry("request_interrupted", "warning", { kind: err?.kind || "unexpected", http_status: err?.status, code: err?.code });
    const invalidCapability = !!err && (
      err.status === 410 || (fromStatus && [401, 403].includes(err.status || 0)) ||
      ["invalid_attempt", "INVALID_ATTEMPT", "ATTEMPT_EXPIRED", "ATTEMPT_REQUIRED"].includes(err.code || "")
    );
    if (invalidCapability) {
      returnToIdentity("A verificação desta visita expirou. Confirme seus dados novamente.", true);
      return;
    }
    if (!attempt) {
      returnToIdentity(message);
      if (err?.status === 429) {
        AttemptTracker.deferInitialization(err.retryAfterMs ?? 5000);
        nextCheckRef.current = monotonicNow() + AttemptTracker.cooldownRemaining();
        setRetryAt(nextCheckRef.current);
        setClockNow(monotonicNow());
      }
      return;
    }
    const unknownOutcome = !err || err.kind !== "http" || err.status === 408 || err.status === 429 || (err.status || 0) >= 500;
    if (unknownOutcome || fromStatus) {
      // All recovery is a status read. Never repeat identify/authorize-existing.
      watchUntilRef.current ||= monotonicNow() + STATUS_WATCH_MS;
      failuresRef.current += 1;
      setError(err?.status === 429 ? message : "Ainda não recebemos a confirmação. Sua tentativa foi preservada.");
      if (stepRef.current !== "success") showStep("pending");
      waitBeforeNextCheck(err?.retryAfterMs ?? Math.min(10000, 1000 * 2 ** Math.min(failuresRef.current, 4)), unknownOutcome);
      return;
    }
    // A rejected input/token request did not initiate authorization. The user
    // may correct identity explicitly; it is never resubmitted automatically.
    AttemptTracker.markSubmitted(attempt.attempt_id, false);
    returnToIdentity(message);
  }, [returnToIdentity, showStep, telemetry, waitBeforeNextCheck]);

  const checkStatus = useCallback(async (source: CheckSource = "automatic") => {
    if (!mountedRef.current || inFlightRef.current) return;
    if (source === "automatic" && (document.visibilityState === "hidden" || navigator.onLine === false)) return;
    if (nextCheckRef.current > monotonicNow()) {
      clearPoll();
      pollTimerRef.current = setTimeout(() => { void checkStatusRef.current?.(source); }, nextCheckRef.current - monotonicNow());
      return;
    }
    const attempt = AttemptTracker.get();
    if (!attempt) {
      returnToIdentity("Confirme seus dados para acompanhar esta visita.", true);
      return;
    }
    const request = Symbol("status");
    inFlightRef.current = request;
    setBusy(true);
    clearPoll();
    if (stepRef.current !== "success") showStep("pending");
    const epoch = epochRef.current;
    const requestStarted = monotonicNow();
    if (source !== "automatic") telemetry("attempt_resumed", "info", { source });
    try {
      const result = await api.attemptStatus({ attempt_id: attempt.attempt_id, token: attempt.token });
      applyResult(result, attempt, epoch, requestStarted);
    } catch (caught) {
      if (mountedRef.current && epoch === epochRef.current) handleFailure(caught, attempt, true);
    } finally {
      if (inFlightRef.current === request) {
        inFlightRef.current = null;
        if (mountedRef.current && epoch === epochRef.current) setBusy(false);
      }
    }
  }, [applyResult, clearPoll, handleFailure, returnToIdentity, showStep, telemetry]);
  checkStatusRef.current = checkStatus;

  const startAuthorization = useCallback(async (identity: { phone: string; cpf: string; consent_version: string } | { access_token: string }) => {
    if (inFlightRef.current || nextCheckRef.current > monotonicNow()) return;
    const existing = AttemptTracker.get();
    if (existing?.submitted) {
      await checkStatus("manual");
      return;
    }
    const epoch = ++epochRef.current;
    const request = Symbol("authorization");
    inFlightRef.current = request;
    setBusy(true);
    setError("");
    showStep("authorizing");
    let attempt: TrackedAttempt | null = null;
    try {
      attempt = await AttemptTracker.ensureAttempt();
      if (!mountedRef.current || epoch !== epochRef.current) return;
      if (attempt.requires_verification) {
        // A legacy response without server time cannot renew a local TTL after
        // reload. Check the real expiry, then continue this explicit user action.
        const checkedAt = monotonicNow();
        const state = await api.attemptStatus({ attempt_id: attempt.attempt_id, token: attempt.token });
        if (!mountedRef.current || epoch !== epochRef.current) return;
        if (state.status !== "awaiting_identity" && !state.needs_cpf && !state.needs_login) {
          applyResult(state, attempt, epoch, checkedAt);
          return;
        }
        AttemptTracker.validateFromServer(attempt.attempt_id, state.server_now, checkedAt);
        if (AttemptTracker.get()?.attempt_id !== attempt.attempt_id) {
          returnToIdentity("A verificação desta visita expirou. Confirme seus dados novamente.", true);
          return;
        }
      }
      const params = getQueryParams();
      const context = {
        client_mac: params.client_mac, ap_mac: params.ap_mac, ssid: params.ssid,
        redirect_url: params.redirect_url, captive_timestamp: params.captive_timestamp,
        attempt_id: attempt.attempt_id, resume_token: attempt.token,
      };
      AttemptTracker.markSubmitted(attempt.attempt_id);
      const requestStarted = monotonicNow();
      watchUntilRef.current = requestStarted + STATUS_WATCH_MS;
      const result = "access_token" in identity
        ? await api.authorizeExisting({ ...context, ...identity, auth_method: "silent" })
        : await api.identify({ ...context, ...identity });
      applyResult(result, attempt, epoch, requestStarted);
    } catch (caught) {
      if (mountedRef.current && epoch === epochRef.current) handleFailure(caught, attempt, false);
    } finally {
      if (inFlightRef.current === request) {
        inFlightRef.current = null;
        if (mountedRef.current && epoch === epochRef.current) setBusy(false);
      }
    }
  }, [applyResult, checkStatus, handleFailure, returnToIdentity, showStep]);

  useEffect(() => {
    mountedRef.current = true;
    const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    const isCanonical = window.location.hostname === "minasbrasilwifi.com.br" && window.location.protocol === "https:";
    if (!isLocal && !isCanonical) {
      window.location.href = "https://minasbrasilwifi.com.br" + window.location.pathname + window.location.search + window.location.hash;
      return;
    }
    const epoch = epochRef.current;
    void api.bootstrap().then(data => {
      if (mountedRef.current && data?.store) setBoot({ store: data.store, consent: data.consent || FALLBACK_BOOT.consent });
    }, () => undefined);

    if (AttemptTracker.get()) {
      void checkStatus("resume");
    } else if (AttemptTracker.cooldownRemaining() > 0) {
      returnToIdentity("Aguarde antes de tentar novamente.");
    } else {
      void withDeadline(supabase.auth.getSession(), SESSION_DEADLINE_MS).then(sessionResult => {
        if (!mountedRef.current || epoch !== epochRef.current) return;
        if (sessionResult.outcome === "completed" && sessionResult.value.data.session?.access_token) {
          void startAuthorization({ access_token: sessionResult.value.data.session.access_token });
        } else {
          if (sessionResult.outcome !== "completed") telemetry("session_lookup", "warning", { outcome: sessionResult.outcome });
          returnToIdentity();
        }
      });
    }

    const resume = () => {
      if (document.visibilityState === "hidden") return;
      if (["pending", "success"].includes(stepRef.current)) void checkStatusRef.current?.("resume");
    };
    const pagehide = () => telemetry("page_hidden", "info", { state: stepRef.current });
    window.addEventListener("online", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pagehide", pagehide);
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
      // Effect replay may begin a new read. Its lock is owned by its request,
      // so a late finally from this setup cannot unlock the new request.
      inFlightRef.current = null;
      clearPoll();
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pagehide", pagehide);
    };
  }, [checkStatus, clearPoll, returnToIdentity, startAuthorization, telemetry]);

  useEffect(() => {
    if (retryAt <= monotonicNow()) return;
    const timer = setInterval(() => {
      setClockNow(monotonicNow());
      AttemptTracker.cooldownRemaining();
      if (monotonicNow() >= retryAt) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [retryAt]);

  useEffect(() => {
    if (step === "success" && confirmed) telemetry("success_rendered", "success", { state: "confirmed" });
  }, [step, confirmed?.attemptId, confirmed?.result.session_id, telemetry]);

  const handleIdentity = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || nextCheckRef.current > monotonicNow()) return;
    const phoneDigits = phone.replace(/\D/g, "");
    const cpfDigits = cpf.replace(/\D/g, "");
    if (!Validators.phone(phoneDigits)) { setError("Informe um telefone válido com DDD."); return; }
    if (!Validators.cpf(cpfDigits)) { setError("CPF inválido. Verifique os números informados."); return; }
    void startAuthorization({ phone: phoneDigits, cpf: cpfDigits, consent_version: boot.consent?.version || "1.0" });
  };

  const retrySeconds = Math.max(0, Math.ceil((retryAt - clockNow) / 1000));

  if (step === "success" && confirmed) {
    return <SuccessView
      redirectUrl={resolvePostAuthRedirect(confirmed.result.redirect_url, getQueryParams().redirect_url)}
      successMsg="Sua conexão Wi-Fi foi confirmada."
      redirectReady={redirectReady}
      autoRedirect={confirmed.autoRedirect}
      onRedirect={(mode) => {
        AttemptTracker.markRedirectAttempted(confirmed.attemptId);
        telemetry("redirect_started", "info", { mode });
      }}
      onRedirectFailure={() => telemetry("redirect_failed", "warning", { reason: "navigation_blocked" })}
    />;
  }

  if (step === "loading" || step === "authorizing" || step === "pending") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <p role="status" className="mt-4 text-gray-500 font-medium">
            {step === "loading" ? "Carregando..." : step === "authorizing" ? "Solicitando acesso ao Wi-Fi..." : "Confirmando seu acesso ao Wi-Fi..."}
          </p>
          {step === "pending" && <>
            <p className="portal-subtitle">{error || "Você não precisa preencher seus dados novamente."}</p>
            {manualOnly && <p className="portal-subtitle">A confirmação automática foi pausada. Você pode consultar novamente.</p>}
            <button type="button" className="portal-btn" disabled={busy || retrySeconds > 0} onClick={() => { void checkStatus("manual"); }}>
              {busy ? "Verificando..." : retrySeconds > 0 ? "Aguarde " + retrySeconds + " s" : "Verificar novamente"}
            </button>
          </>}
          <Footer />
        </div>
      </div>
    );
  }

  if (step === "error") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <h1 className="portal-title">{errorAction === "restart" ? "Acesso ainda não confirmado" : "Não foi possível liberar"}</h1>
          <p role="alert" className="portal-subtitle">{error}</p>
          <button type="button" className="portal-btn" disabled={retrySeconds > 0} onClick={() => returnToIdentity("", true)}>
            {retrySeconds > 0 ? "Aguarde " + retrySeconds + " s" : errorAction === "restart" ? "Tentar nova liberação" : "Tentar novamente"}
          </button>
          <Footer />
        </div>
      </div>
    );
  }

  return (
    <div className="portal-wrapper">
      <div className="portal-card">
        <div className="text-center mb-6">
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <p className="portal-slogan">vender barato é tradição</p>
        </div>
        <h1 className="portal-title">Acessar Wi-Fi</h1>
        <p className="portal-subtitle">{boot.store.city ? boot.store.name + " — " + boot.store.city : boot.store.name}</p>
        {error && <div role="alert" className="portal-error">{error}</div>}
        <form onSubmit={handleIdentity} className="space-y-4">
          <div>
            <label className="portal-label" htmlFor="phone">Telefone</label>
            <input id="phone" type="tel" inputMode="tel" value={phone} onChange={event => setPhone(formatPhoneBR(event.target.value))}
              required className="portal-input" placeholder="(00) 00000-0000" autoComplete="tel" disabled={busy} />
          </div>
          <div>
            <label className="portal-label" htmlFor="cpf">CPF</label>
            <input id="cpf" type="text" inputMode="numeric" value={formatCPF(cpf)} onChange={event => setCpf(event.target.value)}
              required className="portal-input" placeholder="000.000.000-00" autoComplete="off" disabled={busy} />
          </div>
          <button type="submit" disabled={busy || retrySeconds > 0} className="portal-btn">
            {busy ? "Liberando..." : retrySeconds > 0 ? "Aguarde " + retrySeconds + " s" : "Liberar Wi-Fi"}
          </button>
        </form>
        {boot.consent && <details className="portal-terms"><summary>Privacidade e LGPD</summary><div>{boot.consent.text}</div></details>}
        <p className="portal-hint" style={{ textAlign: "center", marginTop: 12 }}>Ao continuar, você declara ter lido a Política de Privacidade.</p>
        <Footer />
      </div>
    </div>
  );
}
