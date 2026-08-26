const RECOVERABLE_FAILURES = new Set([
  "PROCESSING_IN_PROGRESS",
  "RETRY_REQUIRED",
  "CONNECTION_AMBIGUOUS",
]);

const FAILURE_MESSAGES: Record<string, string> = {
  NO_STORE_CONFIGURED: "Não foi possível identificar esta unidade. Reconecte-se ao Wi-Fi e tente novamente.",
  CLIENT_NOT_FOUND_ON_CONTROLLER: "Seu dispositivo não foi localizado na controladora da unidade. Desative e reative o Wi-Fi e tente novamente.",
  UNIFI_STATION_LOOKUP_FAILED: "A controladora da unidade não respondeu à verificação do dispositivo. Tente novamente em instantes.",
  UNIFI_LOGIN_FAILED: "A controladora da unidade está temporariamente indisponível.",
  UNIFI_CMD_REJECTED: "A controladora recusou a liberação do dispositivo.",
  MAC_RANDOMIZATION_AMBIGUOUS: "Não foi possível distinguir seu dispositivo. Reconecte-se à rede e tente novamente.",
};

export function isRecoverableAuthResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as { processing?: boolean; fail_reason?: string };
  return value.processing === true || RECOVERABLE_FAILURES.has(value.fail_reason || "");
}

export function getAuthFailureMessage(result: unknown): string {
  if (isRecoverableAuthResult(result)) {
    return "A liberação ainda está sendo confirmada. Aguarde alguns segundos e verifique novamente.";
  }
  if (result && typeof result === "object") {
    const reason = (result as { fail_reason?: unknown }).fail_reason;
    if (typeof reason === "string" && reason) return FAILURE_MESSAGES[reason] || "Não foi possível liberar o acesso nesta unidade.";
  }
  return "Não foi possível liberar o acesso.";
}
