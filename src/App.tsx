import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./lib/api";
import { supabase } from "./integrations/supabase/client";
import {
  formatCPF,
  getQueryParams,
  resolvePostAuthRedirect,
  Validators,
} from "./lib/portal-utils";
import { AttemptTracker } from "./lib/attempt-tracker";
import { getAuthFailureMessage, isRecoverableAuthResult, runWithAuthRecovery } from "./lib/auth-outcome";
import logoMinasBrasil from "./assets/logo-minas-brasil.png";
import Footer from "./components/Footer";
import { SuccessView } from "./components/SuccessView";
import "./index.css";

type Step = "loading" | "identity" | "authorizing" | "success" | "error";

interface BootstrapData {
  store: { slug: string | null; name: string; city?: string | null };
  consent: { version: string; text: string } | null;
}

const FALLBACK_BOOT: BootstrapData = {
  store: { slug: null, name: "Drogaria Minas Brasil" },
  consent: {
    version: "1.0",
    text:
      "Ao se conectar à rede Wi-Fi da Drogaria Minas Brasil, você concorda com a coleta e o tratamento do seu CPF e telefone para identificação, segurança da rede e comunicações promocionais, conforme a LGPD (Lei nº 13.709/2018). Você pode solicitar a exclusão dos seus dados a qualquer momento.",
  },
};

function formatPhoneBR(value: string): string {
  const digits = (value || "").replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits.length ? `(${digits}` : "";
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

export default function App() {
  const mountedRef = useRef(true);
  const processingRef = useRef<Promise<unknown> | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [boot, setBoot] = useState<BootstrapData>(FALLBACK_BOOT);
  const [phone, setPhone] = useState("");
  const [cpf, setCpf] = useState("");
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (error) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [error]);

  const handleAuthOutcome = useCallback((result: any, message: string) => {
    if (!result?.authorized) return false;
    const params = getQueryParams();
    setSuccessMsg(message);
    setRedirectUrl(resolvePostAuthRedirect(result.redirect_url, params.redirect_url));
    setStep("success");
    AttemptTracker.clear();
    return true;
  }, []);

  const completeAuthenticatedSession = useCallback(async (accessToken: string) => {
    if (processingRef.current) return processingRef.current;

    processingRef.current = (async () => {
      try {
        setStep("authorizing");
        const params = getQueryParams();
        const attempt = await AttemptTracker.ensureAttempt();
        if (!attempt) throw new Error("Não foi possível criar uma tentativa segura. Tente novamente.");

        const result = await runWithAuthRecovery(() => api.authorizeExisting({
            access_token: accessToken,
            client_mac: params.client_mac,
            ap_mac: params.ap_mac,
            ssid: params.ssid,
            redirect_url: params.redirect_url,
            captive_timestamp: params.captive_timestamp,
            auth_method: "silent",
            attempt_id: attempt.attempt_id,
            resume_token: attempt.token,
          }), { stop: (value: any) => !!value?.authorized || !!value?.needs_cpf });

        if (result?.needs_cpf) {
          await supabase.auth.signOut();
          AttemptTracker.clear();
          setStep("identity");
          return result;
        }

        if (!handleAuthOutcome(result, "Wi-Fi liberado com sucesso!")) {
          if (!isRecoverableAuthResult(result)) AttemptTracker.clear();
          setError(getAuthFailureMessage(result));
          setStep("error");
        }
        return result;
      } catch (err) {
        if (err instanceof ApiError && [400, 401, 403].includes(err.status || 0)) {
          AttemptTracker.clear();
        }
        setError(err instanceof Error ? err.message : "Não foi possível liberar o acesso.");
        setStep("error");
      } finally {
        processingRef.current = null;
      }
    })();

    return processingRef.current;
  }, [handleAuthOutcome]);

  useEffect(() => {
    const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    const isCanonical = window.location.hostname === "minasbrasilwifi.com.br" && window.location.protocol === "https:";
    if (!isLocal && !isCanonical) {
      window.location.href = `https://minasbrasilwifi.com.br${window.location.pathname}${window.location.search}${window.location.hash}`;
      return;
    }

    api.bootstrap().then(
      (data) => {
        if (data?.store && mountedRef.current) {
          setBoot({ store: data.store, consent: data.consent || FALLBACK_BOOT.consent });
        }
      },
      () => undefined,
    );

    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled || !mountedRef.current) return;
      if (session?.access_token) void completeAuthenticatedSession(session.access_token);
      else setStep("identity");
    }).catch(() => {
      if (!cancelled && mountedRef.current) setStep("identity");
    });

    return () => { cancelled = true; };
  }, [completeAuthenticatedSession]);

  const handleIdentity = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError("");

    const phoneDigits = phone.replace(/\D/g, "");
    const cpfDigits = cpf.replace(/\D/g, "");
    if (!Validators.phone(phoneDigits)) {
      setError("Informe um telefone válido com DDD.");
      return;
    }
    if (!Validators.cpf(cpfDigits)) {
      setError("CPF inválido. Verifique os números informados.");
      return;
    }

    setBusy(true);
    try {
      const params = getQueryParams();
      const attempt = await AttemptTracker.ensureAttempt();
      if (!attempt) throw new Error("Não foi possível criar uma tentativa segura. Tente novamente.");

      const identifyPayload = {
        phone: phoneDigits,
        cpf: cpfDigits,
        client_mac: params.client_mac,
        ap_mac: params.ap_mac,
        ssid: params.ssid,
        redirect_url: params.redirect_url,
        captive_timestamp: params.captive_timestamp,
        consent_version: boot.consent?.version || "1.0",
        attempt_id: attempt.attempt_id,
        resume_token: attempt.token,
      };
      const result = await runWithAuthRecovery(() => api.identify(identifyPayload), {
        stop: (value: any) => !!value?.authorized,
      });

      if (result?.authorized && result?.session_token_hash) {
        const { error: sessionError } = await supabase.auth.verifyOtp({
          token_hash: result.session_token_hash,
          type: "magiclink",
        });
        if (sessionError) throw sessionError;
      }

      if (!handleAuthOutcome(result, "Identificação concluída. Wi-Fi liberado com sucesso!")) {
        if (!isRecoverableAuthResult(result)) AttemptTracker.clear();
        setError(getAuthFailureMessage(result));
        setStep("error");
      }
    } catch (err) {
      if (err instanceof ApiError && ![408, 429, 500, 502, 503, 504].includes(err.status || 0)) {
        AttemptTracker.clear();
      }
      setError(err instanceof Error ? err.message : "Não foi possível conectar. Tente novamente.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "success") {
    return <SuccessView redirectUrl={redirectUrl} successMsg={successMsg} />;
  }

  if (step === "loading" || step === "authorizing") {
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <img src={logoMinasBrasil} alt="Drogaria Minas Brasil" className="portal-logo" />
          <p className="mt-4 text-gray-500 font-medium">
            {step === "authorizing" ? "Liberando seu acesso ao Wi-Fi..." : "Carregando..."}
          </p>
        </div>
      </div>
    );
  }

  if (step === "error") {
    const recoverable = error.includes("ainda está sendo confirmada");
    return (
      <div className="portal-wrapper">
        <div className="portal-card" style={{ textAlign: "center" }}>
          <h1 className="portal-title">Não foi possível liberar</h1>
          <p className="portal-subtitle">{error || "Ocorreu um erro inesperado."}</p>
          <button
            type="button"
            className="portal-btn"
            onClick={() => {
              setError("");
              if (recoverable) window.location.reload();
              else setStep("identity");
            }}
          >
            {recoverable ? "Verificar novamente" : "Tentar novamente"}
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
        <p className="portal-subtitle">
          {boot.store.city ? `${boot.store.name} — ${boot.store.city}` : boot.store.name}
        </p>

        {error && <div className="portal-error">{error}</div>}

        <form onSubmit={handleIdentity} className="space-y-4">
          <div>
            <label className="portal-label" htmlFor="phone">Telefone</label>
            <input
              id="phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(event) => setPhone(formatPhoneBR(event.target.value))}
              required
              className="portal-input"
              placeholder="(00) 00000-0000"
              autoComplete="tel"
              disabled={busy}
            />
          </div>

          <div>
            <label className="portal-label" htmlFor="cpf">CPF</label>
            <input
              id="cpf"
              type="text"
              inputMode="numeric"
              value={formatCPF(cpf)}
              onChange={(event) => setCpf(event.target.value)}
              required
              className="portal-input"
              placeholder="000.000.000-00"
              autoComplete="off"
              disabled={busy}
            />
          </div>

          <button type="submit" disabled={busy} className="portal-btn">
            {busy ? "Liberando..." : "Liberar Wi-Fi"}
          </button>
        </form>

        {boot.consent && (
          <details className="portal-terms">
            <summary>Privacidade e LGPD</summary>
            <div>{boot.consent.text}</div>
          </details>
        )}

        <p className="portal-hint" style={{ textAlign: "center", marginTop: 12 }}>
          Ao continuar, você declara ter lido a Política de Privacidade.
        </p>
        <Footer />
      </div>
    </div>
  );
}
