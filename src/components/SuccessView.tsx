import React, { useState, useEffect } from "react";
import Footer from "../components/Footer";

interface SuccessViewProps {
  redirectUrl: string | null;
  successMsg: string;
  onComplete?: () => void;
}

export const SuccessView: React.FC<SuccessViewProps> = ({
  redirectUrl,
  successMsg,
  onComplete
}) => {
  const [countdown, setCountdown] = useState(2);
  const navigatedRef = React.useRef(false);

  useEffect(() => {
    if (!redirectUrl || navigatedRef.current) return;

    const handleRedirect = () => {
      if (navigatedRef.current) return;
      navigatedRef.current = true;
      if (onComplete) onComplete();
      window.location.replace(redirectUrl);
    };

    const timer = setTimeout(() => {
      handleRedirect();
    }, 2000);

    const interval = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [redirectUrl, onComplete]);

  const handleManualRedirect = () => {
    if (!redirectUrl || navigatedRef.current) return;
    navigatedRef.current = true;
    if (onComplete) onComplete();
    window.location.replace(redirectUrl);
  };

  return (
    <div className="portal-wrapper">
      <div className="portal-card" style={{ textAlign: "center" }}>
        <div className="success-icon">
          <svg width="40" height="40" fill="none" stroke="#2e7d32" viewBox="0 0 24 24" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="portal-title">Wi-Fi liberado com sucesso!</h1>
        <p className="portal-subtitle">{successMsg}</p>
        
        {redirectUrl ? (
          <>
            <div style={{ marginTop: 20, marginBottom: 20 }}>
              <p style={{ color: "#666", fontSize: 14 }}>
                Redirecionando em {countdown} segundos...
              </p>
            </div>
            <button
              onClick={handleManualRedirect}
              className="portal-btn"
              style={{ marginTop: 8 }}
            >
              Continuar agora
            </button>
          </>
        ) : (
          <p style={{ color: "#999", fontSize: 12, marginTop: 24 }}>
            Seu acesso já foi liberado. Você pode fechar esta janela.
          </p>
        )}
        <Footer />
      </div>
    </div>
  );
};
