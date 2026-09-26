import { api, ApiError } from "./api";

const RECORD_KEY = "mb_auth_attempt_v2";
const COOLDOWN_KEY = "mb_auth_cooldowns_v1";
const STATUS_COOLDOWN_KEY = "mb_status_cooldowns_v1";
const MAX_ATTEMPT_TTL_MS = 600000;

/** Durations in this document never depend on the user's wall clock. */
export const monotonicNow = () => performance.now();
// Missing timeOrigin must never make unrelated documents share a clock.
// This fallback only identifies this module instance; it is not a credential.
const fallbackClock = "document-" + Math.random().toString(36).slice(2);
function clockId(): string {
  return Number.isFinite(performance.timeOrigin) ? "origin-" + performance.timeOrigin : fallbackClock;
}
function sameClock(record: { clock_id?: string; clock_origin?: number }): boolean {
  return record.clock_id !== undefined ? record.clock_id === clockId() :
    Number.isFinite(record.clock_origin) && record.clock_origin === performance.timeOrigin;
}
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
  clock_id?: string;
  expires_monotonic_ms?: number;
  requires_verification?: boolean;
}

interface Cooldown {
  context: string;
  attempt_id?: string;
  clock_origin?: number;
  clock_id?: string;
  until_ms: number;
  remaining_ms: number;
}

let memory: TrackedAttempt | null = null;
let storageLoaded = false;
let generation = 0;
let initializing: { context: string; generation: number; promise: Promise<TrackedAttempt> } | null = null;
let cooldowns: Cooldown[] | null = null;

function readCooldowns(): Cooldown[] {
  if (cooldowns) return cooldowns;
  cooldowns = [];
  // Keep status separate so a retained older frontend cannot interpret it as
  // initialization throttling. Corruption of one key does not discard the other.
  for (const key of [COOLDOWN_KEY, STATUS_COOLDOWN_KEY]) {
    try {
      const parsed: unknown = JSON.parse(sessionStorage.getItem(key) || "[]");
      if (Array.isArray(parsed)) cooldowns.push(...parsed.filter((item): item is Cooldown =>
        typeof item?.context === "string" && (key === COOLDOWN_KEY ? item.attempt_id === undefined : typeof item.attempt_id === "string") &&
        (item.clock_id === undefined || typeof item.clock_id === "string") &&
        Number.isFinite(item.until_ms) && Number.isFinite(item.remaining_ms) && item.remaining_ms > 0 && item.remaining_ms <= 2147480000).slice(-16));
    } catch { /* An in-memory cooldown is still available when storage is denied. */ }
  }
  return cooldowns;
}

function saveCooldowns(attemptId?: string) {
  const records = readCooldowns().filter(item => (item.attempt_id === undefined) === (attemptId === undefined));
  try { sessionStorage.setItem(attemptId === undefined ? COOLDOWN_KEY : STATUS_COOLDOWN_KEY, JSON.stringify(records)); } catch { /* Keep memory. */ }
}

function cooldownRemaining(attemptId?: string): number {
  const record = readCooldowns().find(item => item.context === currentContext() && item.attempt_id === attemptId);
  if (!record) return 0;
  // Across documents, no trusted elapsed clock is available. Preserve the last
  // saved remainder instead of shortening Retry-After using the user's clock.
  if (!sameClock(record)) {
    record.clock_id = clockId();
    record.clock_origin = performance.timeOrigin;
    record.until_ms = monotonicNow() + record.remaining_ms;
  }
  const now = monotonicNow();
  // A corrupt persisted deadline must not exceed its validated remainder or
  // overflow a browser timer. Repair the deadline too, so it still counts down.
  record.until_ms = Math.min(record.until_ms, now + record.remaining_ms);
  record.remaining_ms = Math.max(0, record.until_ms - now);
  saveCooldowns(attemptId);
  return record.remaining_ms;
}

function deferCooldown(delayMs: number, attemptId?: string) {
  const delay = Math.max(cooldownRemaining(attemptId), Number.isFinite(delayMs) ? Math.min(Math.max(0, delayMs), 2147480000) : 5000);
  const context = currentContext();
  const sameScope = readCooldowns().filter(item => (item.attempt_id === undefined) === (attemptId === undefined));
  cooldowns = readCooldowns().filter(item => (item.attempt_id === undefined) !== (attemptId === undefined));
  cooldowns.push(...sameScope.filter(item => item.context !== context || item.attempt_id !== attemptId).slice(-15));
  cooldowns.push({ context, attempt_id: attemptId, clock_id: clockId(), clock_origin: performance.timeOrigin,
    until_ms: monotonicNow() + delay, remaining_ms: delay });
  saveCooldowns(attemptId);
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
    if (memory && (memory.context !== currentContext() || (sameClock(memory) &&
        Number.isFinite(memory.expires_monotonic_ms) && memory.expires_monotonic_ms! <= monotonicNow()))) {
      this.clear();
    }
    if (memory && !sameClock(memory)) memory.requires_verification = true;
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
      for (const key of [COOLDOWN_KEY, STATUS_COOLDOWN_KEY]) {
        try { sessionStorage.removeItem(key); } catch { /* Keep memory cleared. */ }
      }
    } else {
      cooldowns = readCooldowns().filter(item => item.attempt_id === undefined);
      try { sessionStorage.removeItem(STATUS_COOLDOWN_KEY); } catch { /* Keep memory cleared. */ }
    }
  },

  cooldownRemaining(): number {
    return cooldownRemaining();
  },

  deferInitialization(delayMs: number) {
    deferCooldown(delayMs);
  },

  statusCooldownRemaining(): number {
    const current = this.get();
    return current ? cooldownRemaining(current.attempt_id) : 0;
  },

  deferStatus(attemptId: string, delayMs: number) {
    if (this.get()?.attempt_id === attemptId) deferCooldown(delayMs, attemptId);
  },

  validateFromServer(attemptId: string, serverNow?: string, requestStarted = monotonicNow()) {
    const record = this.get();
    if (record?.attempt_id !== attemptId || !record.expires_at || !serverNow) return;
    const remaining = Math.min(MAX_ATTEMPT_TTL_MS, Date.parse(record.expires_at) - Date.parse(serverNow)) -
      Math.max(0, monotonicNow() - requestStarted);
    if (!Number.isFinite(remaining) || remaining <= 0) { this.clear(); return; }
    const deadline = monotonicNow() + remaining;
    save({ ...record, clock_id: clockId(), clock_origin: performance.timeOrigin, requires_verification: false,
      expires_monotonic_ms: sameClock(record) && Number.isFinite(record.expires_monotonic_ms)
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
      return save({ version: 2, ...result, context, submitted: false, clock_id: clockId(), clock_origin: performance.timeOrigin,
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
