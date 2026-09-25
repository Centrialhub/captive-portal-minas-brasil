import { api, ApiError } from "./api";

const RECORD_KEY = "mb_auth_attempt_v2";
const COOLDOWN_KEY = "mb_auth_cooldowns_v1";
const MAX_ATTEMPT_TTL_MS = 600000;

/** Durations in this document never depend on the user's wall clock. */
export const monotonicNow = () => performance.now();
// Legacy records lack a verifiable visit context. A new client must identify
// again; the backend may then attach it to an already running operation.
const ATTEMPT_ID_KEY = "mb_auth_attempt_id";
const ATTEMPT_TOKEN_KEY = "mb_auth_attempt_token";

export interface TrackedAttempt {
  version: 2;
  attempt_id: string;
  token: string;
  context: string;
  expires_at: string | null;
  submitted: boolean;
  confirmed_at?: string;
  redirect_attempted?: boolean;
  clock_origin?: number;
  expires_monotonic_ms?: number;
  requires_verification?: boolean;
}

interface Cooldown { context: string; clock_origin: number; until_ms: number; remaining_ms: number }

let memory: TrackedAttempt | null = null;
let storageLoaded = false;
let generation = 0;
let initializing: { context: string; generation: number; promise: Promise<TrackedAttempt> } | null = null;
let cooldowns: Cooldown[] | null = null;

function readCooldowns(): Cooldown[] {
  if (cooldowns) return cooldowns;
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(COOLDOWN_KEY) || "[]");
    if (Array.isArray(parsed)) cooldowns = parsed.filter((item): item is Cooldown =>
      typeof item?.context === "string" && Number.isFinite(item.clock_origin) &&
      Number.isFinite(item.until_ms) && Number.isFinite(item.remaining_ms) && item.remaining_ms > 0 && item.remaining_ms <= 2147480000).slice(-16);
  } catch { /* An in-memory cooldown is still available when storage is denied. */ }
  return cooldowns ||= [];
}

function saveCooldowns() {
  try { sessionStorage.setItem(COOLDOWN_KEY, JSON.stringify(readCooldowns())); } catch { /* Keep memory. */ }
}

function readCaptiveParams(): Record<string, string> {
  const query = new URLSearchParams(window.location.search);
  const params: Record<string, string> = {};
  for (const key of ["id", "mac", "ap", "ssid", "url", "t", "site", "store"]) {
    const value = query.get(key);
    if (value) params[key] = value;
  }
  return params;
}

function currentContext(): string {
  const p = readCaptiveParams();
  const normalizeMac = (value = "") => value.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  return JSON.stringify([normalizeMac(p.id || p.mac), normalizeMac(p.ap), p.ssid || "", p.store || "", p.site || "", p.t || ""]);
}

function save(record: TrackedAttempt): TrackedAttempt {
  memory = record;
  try { sessionStorage.setItem(RECORD_KEY, JSON.stringify(record)); } catch { /* Memory remains usable in this page. */ }
  return record;
}

function isRecord(value: any): value is TrackedAttempt {
  return value?.version === 2 && typeof value.attempt_id === "string" && !!value.attempt_id &&
    typeof value.token === "string" && !!value.token && typeof value.context === "string" &&
    typeof value.submitted === "boolean" && (value.expires_at === null ||
      (typeof value.expires_at === "string" && Number.isFinite(Date.parse(value.expires_at))));
}

export const AttemptTracker = {
  get(): TrackedAttempt | null {
    if (!storageLoaded) {
      storageLoaded = true;
      try {
        const stored = sessionStorage.getItem(RECORD_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (isRecord(parsed)) memory = parsed;
        }
      } catch { /* Storage denial or corrupt data does not prevent a new flow. */ }
    }
    if (memory && (memory.context !== currentContext() || (memory.clock_origin === performance.timeOrigin &&
        Number.isFinite(memory.expires_monotonic_ms) && memory.expires_monotonic_ms! <= monotonicNow()))) {
      this.clear();
    }
    if (memory && memory.clock_origin !== performance.timeOrigin) memory.requires_verification = true;
    return memory;
  },

  clear(includeCooldowns = false) {
    memory = null;
    storageLoaded = true;
    generation += 1;
    initializing = null;
    for (const key of [RECORD_KEY, ATTEMPT_ID_KEY, ATTEMPT_TOKEN_KEY]) {
      try { sessionStorage.removeItem(key); } catch { /* Clear memory even when storage is unavailable. */ }
    }
    if (includeCooldowns) {
      cooldowns = [];
      try { sessionStorage.removeItem(COOLDOWN_KEY); } catch { /* Keep memory cleared. */ }
    }
  },

  cooldownRemaining(): number {
    const record = readCooldowns().find(item => item.context === currentContext());
    if (!record) return 0;
    // A new document cannot infer elapsed time from Date.now. Conservatively
    // wait the last saved remainder; this never grants or renews a capability.
    if (record.clock_origin !== performance.timeOrigin) {
      record.clock_origin = performance.timeOrigin;
      record.until_ms = monotonicNow() + record.remaining_ms;
    }
    record.remaining_ms = Math.max(0, record.until_ms - monotonicNow());
    saveCooldowns();
    return record.remaining_ms;
  },

  deferInitialization(delayMs: number) {
    const delay = Math.max(this.cooldownRemaining(), Math.min(Math.max(0, delayMs), 2147480000));
    const context = currentContext();
    cooldowns = readCooldowns().filter(item => item.context !== context).slice(-15);
    cooldowns.push({ context, clock_origin: performance.timeOrigin, until_ms: monotonicNow() + delay, remaining_ms: delay });
    saveCooldowns();
  },

  validateFromServer(attemptId: string, serverNow?: string, requestStarted = monotonicNow()) {
    const record = this.get();
    if (record?.attempt_id !== attemptId || !record.expires_at || !serverNow) return;
    const remaining = Math.min(MAX_ATTEMPT_TTL_MS, Date.parse(record.expires_at) - Date.parse(serverNow)) -
      Math.max(0, monotonicNow() - requestStarted);
    if (!Number.isFinite(remaining) || remaining <= 0) { this.clear(); return; }
    const deadline = monotonicNow() + remaining;
    save({ ...record, clock_origin: performance.timeOrigin, requires_verification: false,
      expires_monotonic_ms: record.clock_origin === performance.timeOrigin && Number.isFinite(record.expires_monotonic_ms)
        ? Math.min(record.expires_monotonic_ms!, deadline) : deadline });
  },

  markSubmitted(attemptId: string, submitted = true) {
    const record = this.get();
    if (record?.attempt_id === attemptId) save({ ...record, submitted });
  },

  markConfirmed(attemptId: string) {
    const record = this.get();
    if (record?.attempt_id === attemptId) save({ ...record, submitted: true, confirmed_at: new Date().toISOString() });
  },

  markRedirectAttempted(attemptId: string) {
    const record = this.get();
    if (record?.attempt_id === attemptId) save({ ...record, redirect_attempted: true });
  },

  async ensureAttempt(): Promise<TrackedAttempt> {
    const current = this.get();
    if (current) return current;
    const cooldown = this.cooldownRemaining();
    if (cooldown > 0) throw new ApiError("http", "Aguarde antes de tentar novamente.", 429, { retryAfterMs: cooldown });
    const context = currentContext();
    if (initializing?.context === context && initializing.generation === generation) return initializing.promise;
    if (initializing) generation += 1;
    const startedGeneration = generation;
    const startedAt = monotonicNow();
    const promise = api.initAttempt({ params: readCaptiveParams(), original_url: window.location.href }).then(result => {
      if (generation !== startedGeneration || context !== currentContext()) {
        throw new ApiError("abort", "A conexão Wi-Fi mudou. Confirme os dados para continuar.");
      }
      const ttl = result.server_now ? Math.min(MAX_ATTEMPT_TTL_MS, Date.parse(result.expires_at) - Date.parse(result.server_now)) : MAX_ATTEMPT_TTL_MS;
      if (!Number.isFinite(ttl) || startedAt + ttl <= monotonicNow()) throw new ApiError("http", "A tentativa expirou. Confirme os dados novamente.", 410);
      return save({ version: 2, ...result, context, submitted: false, clock_origin: performance.timeOrigin,
        expires_monotonic_ms: startedAt + ttl, requires_verification: false });
    }).catch(error => {
      if (generation === startedGeneration && context === currentContext() && error instanceof ApiError && error.status === 429) {
        this.deferInitialization(error.retryAfterMs ?? 5000);
      }
      throw error;
    });
    initializing = { context, generation: startedGeneration, promise };
    try { return await promise; } finally {
      if (initializing?.promise === promise) initializing = null;
    }
  },
};
