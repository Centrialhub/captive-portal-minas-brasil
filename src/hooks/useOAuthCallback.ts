import { useEffect, useRef, useState } from "react";
import { supabase } from "../integrations/supabase/client";
import { OAuthTracker } from "../lib/oauth-tracker";
import { api, ApiError } from "../lib/api";
import { Session } from "@supabase/supabase-js";
import { getAuthFailureMessage, isRecoverableAuthResult } from "../lib/auth-outcome";

export type OAuthCallbackStatus = "idle" | "waiting" | "processing" | "needs_cpf" | "authorized" | "error" | "expired";

interface UseOAuthCallbackOptions {
  onSuccess: (result: any) => void;
  onError: (message: string) => void;
  onNeedsCpf: (profile: any) => void;
  enabled: boolean;
}

/**
 * Authoritative hook for Google OAuth callback lifecycle.
 * Ensures the callback runs exactly once per transaction.
 */
export function useOAuthCallback({ onSuccess, onError, onNeedsCpf, enabled }: UseOAuthCallbackOptions) {
  const [status, setStatus] = useState<OAuthCallbackStatus>("idle");
  const processingRef = useRef<Promise<any> | null>(null);
  const terminalReachedRef = useRef(false);
  
  useEffect(() => {
    if (!enabled || terminalReachedRef.current) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let isCancelled = false;

    const startProcessing = async (session: Session, source: "google" | "silent") => {
      if (terminalReachedRef.current || processingRef.current) return;
      
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      setStatus("processing");
      
      processingRef.current = (async () => {
        try {
          const { attempt_id, token } = OAuthTracker.getTokens();
          const params = new URLSearchParams(window.location.search);
          
          const result = await api.authorizeExisting({
            access_token: session.access_token,
            client_mac: params.get("id") || params.get("mac") || undefined,
            ap_mac: params.get("ap") || undefined,
            ssid: params.get("ssid") || undefined,
            redirect_url: params.get("url") || undefined,
            captive_timestamp: params.get("t") || undefined,
            auth_method: source,
            attempt_id,
            resume_token: token,
          });

          if (isCancelled) return;

          if (result?.needs_cpf) {
            terminalReachedRef.current = true;
            setStatus("needs_cpf");
            onNeedsCpf(result.profile);
            return result;
          }

          if (result?.authorized) {
            terminalReachedRef.current = true;
            setStatus("authorized");
            onSuccess(result);
            return result;
          }

          const recoverable = isRecoverableAuthResult(result);
          terminalReachedRef.current = true;
          setStatus("error");
          if (!recoverable) OAuthTracker.clearAll();
          onError(getAuthFailureMessage(result));
          return result;
        } catch (error) {
          if (isCancelled) return;
          terminalReachedRef.current = true;
          setStatus("error");
          if (error instanceof ApiError && error.kind === "http" && [400, 401, 403].includes(error.status || 0)) {
            OAuthTracker.clearAll();
            onError(error.message);
            return undefined;
          }
          onError(getAuthFailureMessage({ processing: true }));
          return undefined;
        } finally {
          processingRef.current = null;
        }
      })();

      return processingRef.current;
    };

    // Captive assistants and mobile account selection can take longer to
    // persist the Supabase session, especially with MFA or slow mobile data.
    timeoutId = setTimeout(() => {
      if (!terminalReachedRef.current && status !== "processing") {
        terminalReachedRef.current = true;
        setStatus("expired");
        onError("Não foi possível concluir o login do Google. Tempo esgotado.");
      }
    }, 30000);

    setStatus("waiting");

    // Subscription for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (isCancelled || terminalReachedRef.current) return;
      
      if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session) {
        const source = OAuthTracker.isValidOAuthFlow() ? "google" : "silent";
        startProcessing(session, source);
      }
    });

    // Immediate check
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (isCancelled || terminalReachedRef.current) return;
      if (session) {
        const source = OAuthTracker.isValidOAuthFlow() ? "google" : "silent";
        startProcessing(session, source);
      }
    });

    return () => {
      isCancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  }, [enabled]); // Only re-run if explicitly re-enabled (new transaction)

  return { status };
}
