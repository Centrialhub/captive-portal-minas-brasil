import React, { useState, useEffect, useRef } from "react";
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
  
  // Refs for logic control
  const onCompleteRef = useRef(onComplete);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoExecutedRef = useRef(false);
  const manualLockRef = useRef(false);

  // Keep onComplete ref updated without restarting effects
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Centralized cleanup
  const cleanup = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    timeoutRef.current = null;
    intervalRef.current = null;
  };

  useEffect(() => {
    // URL nula cria zero timers e mostra mensagem para fechar a janela
    if (!redirectUrl) {
      cleanup();
      return;
    }

    // Effect principal depende apenas de redirectUrl estável
    // O automático: cria um timeout e um interval
    cleanup();
    
    timeoutRef.current = setTimeout(() => {
      if (!autoExecutedRef.current && !manualLockRef.current) {
        autoExecutedRef.current = true;
        cleanup();
        if (onCompleteRef.current) onCompleteRef.current();
        window.location.replace(redirectUrl);
      }
    }, 2000);

    intervalRef.current = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);

    return () => {
      // Unmount limpa recursos sem executar onComplete automaticamente
      cleanup();
    };
  }, [redirectUrl]);

  const handleManualRedirect = () => {
    if (!redirectUrl || manualLockRef.current) return;
    
    // Deduplica duplo clique
    manualLockRef.current = true;
    
    // Cancela automático
    cleanup();
    
    if (onCompleteRef.current) onCompleteRef.current();
    window.location.replace(redirectUrl);
    
    // Permite nova tentativa deliberada se a página continuou aberta (ex: bloqueio de CNA)
    setTimeout(() => {
      manualLockRef.current = false;
    }, 2000);
  };

  return (
    <div className="portal-wrapper">
      <div className="portal-card text-center">
        <div className="success-icon">
          <svg width="40" height="40" fill="none" stroke="#2e7d32" viewBox="0 0 24 24" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="portal-title text-green-700">Wi-Fi liberado!</h1>
        <p className="portal-subtitle">{successMsg}</p>
        
        {redirectUrl ? (
          <div className="space-y-4">
            <div className="mt-5 mb-5 space-y-2">
              <p className="text-gray-600 text-sm">
                Redirecionando em {countdown} segundos...
              </p>
              <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                <div 
                  className="bg-green-600 h-full transition-all duration-1000 ease-linear"
                  style={{ width: `${(countdown / 2) * 100}%` }}
                />
              </div>
            </div>

            <button
              onClick={handleManualRedirect}
              className="portal-btn mt-2"
            >
              Continuar agora
            </button>
          </div>
        ) : (
          <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-100">
            <p className="text-gray-600 text-sm leading-relaxed">
              Seu acesso já foi liberado com sucesso.<br />
              <strong>Você já pode fechar esta janela</strong> e aproveitar sua conexão.
            </p>
          </div>
        )}
        <Footer />
      </div>
    </div>
  );
};
