/** Durable authorization coordinator. The database owns intent, exclusion and
 * terminal results. A lost worker may only verify a previously claimed send. */
export interface AuthOperation {
  id: string;
  store_id: string;
  user_id?: string;
  controller_key: string;
  site_id: string;
  client_mac: string;
  ap_mac: string | null;
  ssid?: string | null;
  command: Record<string, unknown>;
  state: string;
  action: "send" | "verify";
  lease_version: number;
  lease_expires_at: string;
  first_sent_at: string | null;
  command_accepted_at?: string | null;
  deadline_at: string | null;
  redirect_url: string | null;
  /** Per-invocation ceiling; not persisted and never extends the DB lease. */
  execution_deadline_at?: number;
}

export interface OperationDatabase {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message?: string; code?: string } | null;
  }>;
}

export interface CommandObservation {
  status: "accepted" | "rejected" | "unknown";
  command_sent: boolean;
  retryable?: boolean;
  reason?: string;
  accepted_at?: string;
  command_sent_at?: string;
  effective_mac: string;
  evidence?: Record<string, unknown>;
}

export interface VerifyObservation {
  state: "authorized" | "not_authorized" | "inconclusive";
  found: boolean | null;
  authorized: boolean | null;
  effective_mac: string;
  reason?: string;
  evidence: Record<string, unknown>;
}

export const AUTH_WORKER_POLICY = {
  batchSize: 4, maxBatches: 10, wallTimeMs: 50_000, minRemainingMs: 16_000,
} as const;

type AuthorizationAdapters = {
  send: (operation: AuthOperation) => Promise<CommandObservation>;
  verify: (operation: AuthOperation) => Promise<VerifyObservation>;
  afterConfirmed?: (operation: AuthOperation) => void;
};
type AuthorizationOptions = {
  owner: string; operationId?: string; limit?: number; allowSend?: boolean;
  now?: () => number; deadlineAt?: number;
};

/** Drain due work while preserving four concurrent adapters and a finite budget.
 * No waiting for not-yet-due items, and no unbounded loop during overload. */
export async function drainAuthorization(
  db: OperationDatabase, adapters: AuthorizationAdapters, options: AuthorizationOptions,
): Promise<{ claimed: number; applied: number; errors: string[] }> {
  if (options.operationId) return reconcileAuthorization(db, adapters, { ...options, limit: 1 });
  const now = options.now || Date.now;
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, now() + AUTH_WORKER_POLICY.wallTimeMs);
  const total = { claimed: 0, applied: 0, errors: [] as string[] };
  for (let batch = 0; batch < AUTH_WORKER_POLICY.maxBatches; batch++) {
    if (deadlineAt - now() < AUTH_WORKER_POLICY.minRemainingMs) break;
    const result = await reconcileAuthorization(db, adapters, {
      ...options, deadlineAt, limit: AUTH_WORKER_POLICY.batchSize,
    });
    total.claimed += result.claimed;
    total.applied += result.applied;
    total.errors.push(...result.errors);
    if (!result.claimed) break;
  }
  return total;
}

/** Bound the whole operation, including thenables whose transport ignores abort.
 * Cancellation cannot prove a remote write did not commit. Callers must retain
 * their durable intent when an RPC or external command becomes uncertain. */
export async function withOperationDeadline<T>(
  start: (signal: AbortSignal) => PromiseLike<T>, deadlineAt: number,
  errorCode: string, now: () => number = Date.now,
): Promise<T> {
  const remaining = deadlineAt - now();
  if (!Number.isFinite(deadlineAt) || remaining <= 0) throw new Error(errorCode);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(errorCode));
      controller.abort();
    }, remaining);
  });
  try {
    return await Promise.race([
      (async () => {
        if (controller.signal.aborted || now() >= deadlineAt) throw new Error(errorCode);
        const value = await start(controller.signal);
        // After a suspended runtime resumes, a Promise may run before an overdue
        // timer callback. The clock remains authoritative in that ordering too.
        if (controller.signal.aborted || now() >= deadlineAt) throw new Error(errorCode);
        return value;
      })(),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

export async function requiredRpc(
  db: OperationDatabase, name: string, args: Record<string, unknown>,
  options: { deadlineAt?: number; now?: () => number } = {},
): Promise<unknown> {
  const start = (signal?: AbortSignal) => {
    const request = db.rpc(name, args) as ReturnType<OperationDatabase["rpc"]> & {
      abortSignal?: (signal: AbortSignal) => ReturnType<OperationDatabase["rpc"]>;
    };
    return signal && typeof request.abortSignal === "function" ? request.abortSignal(signal) : request;
  };
  const { data, error } = options.deadlineAt === undefined ? await start()
    : await withOperationDeadline(signal => start(signal), options.deadlineAt,
      `${name}:DEADLINE_EXCEEDED`, options.now);
  if (error || data == null) throw Object.assign(new Error(`${name}:${error?.code || "NO_RESULT"}`), {
    rpcName: name, rpcCode: error?.code,
    // Only symbolic domain reasons are retained. Never propagate SQL details
    // or arbitrary database messages into a public error or worker log.
    rpcReason: error?.message && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.message) ? error.message : undefined,
  });
  return data;
}

export async function reconcileAuthorization(
  db: OperationDatabase,
  adapters: AuthorizationAdapters,
  options: AuthorizationOptions,
): Promise<{ claimed: number; applied: number; errors: string[] }> {
  const now = options.now || Date.now;
  const claimed = await requiredRpc(db, "claim_captive_auth_operations", {
    p_lease_owner: options.owner,
    p_limit: Math.max(1, Math.min(options.limit || 1, AUTH_WORKER_POLICY.batchSize)),
    p_operation_id: options.operationId || null,
    p_allow_send: options.allowSend !== false,
  }, { deadlineAt: options.deadlineAt, now });
  if (!Array.isArray(claimed)) throw new Error("INVALID_OPERATION_CLAIM");
  const errors: string[] = [];
  let applied = 0;
  // Parallel workers are bounded to four; each HTTP adapter has a 14s total
  // deadline, below the database lease. No worker ever loops an external POST.
  await Promise.all(claimed.map(async (operation: AuthOperation) => {
    try {
      operation = { ...operation, execution_deadline_at: options.deadlineAt };
      const remaining = Math.min(new Date(operation.lease_expires_at).getTime(), options.deadlineAt ?? Infinity,
        operation.action === "send" && operation.deadline_at ? Date.parse(operation.deadline_at) : Infinity) - now();
      let outcome: "accepted" | "unknown" | "not_sent" | "pending" | "confirmed" | "rejected";
      let evidence: Record<string, unknown>;
      let reason: string | null;
      if (remaining < AUTH_WORKER_POLICY.minRemainingMs) {
        if (operation.action !== "send") throw new Error("LEASE_BUDGET_EXHAUSTED");
        // No adapter was invoked. Preserve that proof when the current lease
        // still permits recording it; an expired lease remains DB-fenced.
        outcome = "not_sent";
        reason = "PREPARATION_BUDGET_EXHAUSTED";
        evidence = { mac: operation.client_mac, command_sent: false };
      } else if (operation.action === "send") {
        const result = await adapters.send(operation);
        outcome = result.status;
        reason = result.reason || null;
        evidence = {
          ...result.evidence,
          mac: result.effective_mac,
          command_sent: result.command_sent,
          accepted_at: result.accepted_at || null,
          command_sent_at: result.command_sent_at || null,
        };
        if (result.status === "unknown" && result.command_sent === false && result.retryable === true) {
          outcome = "not_sent";
        }
        if (result.reason === "ALREADY_AUTHORIZED" &&
            result.evidence?.authorized === true && result.evidence?.found === true) {
          outcome = "confirmed";
        }
      } else {
        const result = await adapters.verify(operation);
        outcome = result.state === "authorized" && result.authorized === true && result.found === true
          ? "confirmed" : "pending";
        reason = result.reason || null;
        evidence = {
          ...result.evidence,
          mac: result.effective_mac,
          found: result.found,
          authorized: result.authorized,
        };
      }
      // Success must describe the exact persisted device, never a nearby MAC.
      const canonical = (mac: unknown) => String(mac || "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();
      if (outcome === "confirmed" && canonical(evidence.mac) !== canonical(operation.client_mac)) {
        outcome = "pending";
        reason = "CONFIRMATION_MAC_MISMATCH";
        evidence.authorized = false;
      }
      if (canonical(evidence.mac) === canonical(operation.client_mac)) evidence.mac = operation.client_mac;
      evidence.site_id = operation.site_id;
      evidence.controller_key = operation.controller_key;
      evidence.observed_at = new Date(now()).toISOString();
      const minutes = Number(operation.command.minutes);
      const knownGrant = !!operation.command_accepted_at;
      if (outcome === "confirmed") evidence.validity_basis = knownGrant ? "accepted_command" : "observed_only";
      const until = outcome === "confirmed" && knownGrant && operation.first_sent_at && Number.isFinite(minutes) && minutes > 0
        ? new Date(new Date(operation.first_sent_at).getTime() + minutes * 60_000).toISOString() : null;
      const result = await requiredRpc(db, "record_captive_auth_operation", {
        p_operation_id: operation.id,
        p_lease_owner: options.owner,
        p_lease_version: operation.lease_version,
        p_outcome: outcome,
        p_evidence: evidence,
        p_error_code: reason,
        p_redirect_url: operation.redirect_url,
        p_authorized_until: until,
        p_retry_after_seconds: 2,
      }, { deadlineAt: options.deadlineAt, now }) as { applied?: boolean };
      if (result.applied) {
        applied += 1;
        if (outcome === "confirmed") adapters.afterConfirmed?.(operation);
      }
    } catch (error) {
      // The committed intent/outbox survives. Recovery will verify after the
      // lease, including crashes after POST or before a result can be stored.
      errors.push(`${operation.id}:${error instanceof Error ? error.message : "WORKER_FAILED"}`);
    }
  }));
  return { claimed: claimed.length, applied, errors };
}
