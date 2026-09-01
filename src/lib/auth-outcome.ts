const RECOVERABLE_FAILURES = new Set([
  "PROCESSING_IN_PROGRESS",
  "RETRY_REQUIRED",
  "CONNECTION_AMBIGUOUS",
]);

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
    if (typeof reason === "string" && reason) return reason;
  }
  return "Não foi possível liberar o acesso.";
}
