import { useCallback, useEffect, useRef, useState } from "react";
import Footer from "./Footer";

interface SuccessViewProps {
  redirectUrl: string | null;
  successMsg: string;
  redirectReady?: boolean;
  autoRedirect?: boolean;
  onRedirect?: (mode: "automatic" | "manual") => void;
}

export function SuccessView({
  redirectUrl, successMsg, redirectReady = true, autoRedirect = true, onRedirect,
}: SuccessViewProps) {
  const [countdown, setCountdown] = useState(2);
  const [navigating, setNavigating] = useState(false);
  const automaticAttemptedRef = useRef(false);
  const manualUnlockRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRedirectRef = useRef(onRedirect);
  onRedirectRef.current = onRedirect;

  const navigate = useCallback((mode: "automatic" | "manual") => {
    if (!redirectUrl) return;
    automaticAttemptedRef.current = true;
    setNavigating(true);
    // Record intent before navigation. This is not proof of delivery.
    onRedirectRef.current?.(mode);
    window.location.replace(redirectUrl);
    if (manualUnlockRef.current) clearTimeout(manualUnlockRef.current);
    manualUnlockRef.current = setTimeout(() => setNavigating(false), 2000);
  }, [redirectUrl]);

  useEffect(() => {
    if (!redirectUrl || !redirectReady || !autoRedirect || automaticAttemptedRef.current || navigating) return;
    setCountdown(2);
    const started = Date.now();
    const tick = setInterval(() => setCountdown(Math.max(0, 2 - Math.floor((Date.now() - started) / 1000))), 250);
    const redirect = setTimeout(() => navigate("automatic"), 2000);
    return () => { clearInterval(tick); clearTimeout(redirect); };
  }, [redirectUrl, redirectReady, autoRedirect, navigate, navigating]);

  useEffect(() => () => {
    if (manualUnlockRef.current) clearTimeout(manualUnlockRef.current);
  }, []);

  return (
    <div className="portal-wrapper">
      <div className="portal-card text-center">
        <div className="success-icon">
          <svg width="40" height="40" fill="none" stroke="#2e7d32" viewBox="0 0 24 24" strokeWidth={2.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="portal-title text-green-700">Wi-Fi liberado!</h1>
        <p role="status" className="portal-subtitle">{successMsg}</p>
        <p className="text-gray-600 text-sm">Você já pode usar sua conexão ou fechar esta janela.</p>
        {redirectUrl && <div className="space-y-4">
          {redirectReady && autoRedirect && !automaticAttemptedRef.current && (
            <p className="text-gray-600 text-sm mt-5">Redirecionando em {countdown} segundos...</p>
          )}
          <button type="button" className="portal-btn mt-2" disabled={!redirectReady || navigating} onClick={() => navigate("manual")}>
            {!redirectReady ? "Preparando para continuar..." : "Continuar agora"}
          </button>
        </div>}
        <Footer />
      </div>
    </div>
  );
}
