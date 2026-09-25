export type AuthStatus = "awaiting_identity" | "queued" | "sending" | "verifying" | "confirmed" | "rejected" | "expired_unconfirmed";

export interface AuthResult {
  authorized: boolean;
  processing?: boolean;
  status?: AuthStatus;
  operation_id?: string;
  retry_after_ms?: number;
  deadline_at?: string;
  server_now?: string;
  fail_reason?: string;
  redirect_url?: string;
  session_id?: string | null;
  session_token_hash?: string;
  needs_cpf?: boolean;
  needs_login?: boolean;
}

const RECOVERABLE_FAILURES = new Set([
  "PROCESSING_IN_PROGRESS", "RETRY_REQUIRED", "CONNECTION_AMBIGUOUS", "RATE_LIMIT_HIT",
]);
const PENDING_STATUSES = new Set(["queued", "sending", "verifying"]);
const AUTH_STATUSES = new Set(["awaiting_identity", "confirmed", "rejected", "expired_unconfirmed", ...PENDING_STATUSES]);

const FAILURE_MESSAGES: Record<string, string> = {
  NO_STORE_CONFIGURED: "Não foi possível identificar esta unidade. Reconecte-se ao Wi-Fi e tente novamente.",
  CLIENT_NOT_FOUND_ON_CONTROLLER: "Seu dispositivo não foi localizado na controladora da unidade. Desative e reative o Wi-Fi e tente novamente.",
  UNIFI_STATION_LOOKUP_FAILED: "A controladora da unidade não respondeu à verificação do dispositivo. Tente novamente em instantes.",
  UNIFI_LOGIN_FAILED: "A controladora da unidade está temporariamente indisponível.",
  UNIFI_CMD_REJECTED: "A controladora recusou a liberação do dispositivo.",
  MAC_RANDOMIZATION_AMBIGUOUS: "Não foi possível distinguir seu dispositivo. Reconecte-se à rede e tente novamente.",
  DAILY_ACCESS_LIMIT_REACHED: "O limite diário de acessos deste dispositivo foi atingido. Tente novamente amanhã.",
  AUTHORIZATION_UNCONFIRMED: "A confirmação demorou mais que o esperado. Verifique novamente ou procure o atendimento da unidade.",
  DEVICE_CONTEXT_CONFLICT: "A conexão deste dispositivo mudou. Desative e reative o Wi-Fi para continuar.",
};

/** Validate the wire result before trusting it as a terminal outcome. */
export function isAuthResult(result: unknown): result is AuthResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const value = result as AuthResult;
  if (typeof value.authorized !== "boolean") return false;
  if (!value.authorized && !value.status && !value.fail_reason && value.processing !== true && value.needs_cpf !== true && value.needs_login !== true) return false;
  if (value.processing !== undefined && typeof value.processing !== "boolean") return false;
  if (value.status !== undefined && !AUTH_STATUSES.has(value.status)) return false;
  if (value.authorized && (value.processing === true || (value.status !== undefined && value.status !== "confirmed"))) return false;
  if (!value.authorized && value.status === "confirmed") return false;
  if (value.processing && value.status && !PENDING_STATUSES.has(value.status)) return false;
  if (value.authorized && (value.needs_cpf === true || value.needs_login === true)) return false;
  if (value.retry_after_ms !== undefined && (!Number.isFinite(value.retry_after_ms) || value.retry_after_ms < 0)) return false;
  if (value.deadline_at !== undefined && (typeof value.deadline_at !== "string" || !Number.isFinite(Date.parse(value.deadline_at)))) return false;
  if (value.server_now !== undefined && (typeof value.server_now !== "string" || !Number.isFinite(Date.parse(value.server_now)))) return false;
  for (const key of ["operation_id", "fail_reason", "redirect_url", "session_token_hash"] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") return false;
  }
  if (value.session_id !== undefined && value.session_id !== null && typeof value.session_id !== "string") return false;
  return true;
}

export function isRecoverableAuthResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as AuthResult;
  if (value.authorized === true || value.status === "rejected" || value.status === "expired_unconfirmed" || value.status === "awaiting_identity") return false;
  return value.processing === true || PENDING_STATUSES.has(value.status || "") || RECOVERABLE_FAILURES.has(value.fail_reason || "");
}

export function getAuthFailureMessage(result: unknown): string {
  if (isRecoverableAuthResult(result)) {
    return "A liberação ainda está sendo confirmada. Aguarde alguns segundos e verifique novamente.";
  }
  if (result && typeof result === "object") {
    const value = result as AuthResult;
    if (value.status === "expired_unconfirmed") return "A confirmação demorou mais que o esperado. Verifique novamente ou procure o atendimento da unidade.";
    if (typeof value.fail_reason === "string" && value.fail_reason) return FAILURE_MESSAGES[value.fail_reason] || "Não foi possível liberar o acesso nesta unidade.";
  }
  return "Não foi possível liberar o acesso.";
}

/** A UI deadline, not cancellation of work that may already have succeeded. */
export function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<
  { outcome: "completed"; value: T } | { outcome: "failed"; error: unknown } | { outcome: "timeout" }
> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ outcome: "timeout" }), timeoutMs);
    operation.then(
      value => { clearTimeout(timer); resolve({ outcome: "completed", value }); },
      error => { clearTimeout(timer); resolve({ outcome: "failed", error }); },
    );
  });
}
