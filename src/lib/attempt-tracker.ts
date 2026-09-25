import { api, ApiError } from "./api";

const RECORD_KEY = "mb_auth_attempt_v2";
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
}

let memory: TrackedAttempt | null = null;
let storageLoaded = false;
let generation = 0;
let initializing: { context: string; generation: number; promise: Promise<TrackedAttempt> } | null = null;

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
    if (memory && (memory.context !== currentContext() || (memory.expires_at && Date.parse(memory.expires_at) <= Date.now()))) {
      this.clear();
    }
    return memory;
  },

  clear() {
    memory = null;
    storageLoaded = true;
    generation += 1;
    initializing = null;
    for (const key of [RECORD_KEY, ATTEMPT_ID_KEY, ATTEMPT_TOKEN_KEY]) {
      try { sessionStorage.removeItem(key); } catch { /* Clear memory even when storage is unavailable. */ }
    }
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
    const context = currentContext();
    if (initializing?.context === context && initializing.generation === generation) return initializing.promise;
    if (initializing) generation += 1;
    const startedGeneration = generation;
    const promise = api.initAttempt({ params: readCaptiveParams(), original_url: window.location.href }).then(result => {
      if (generation !== startedGeneration || context !== currentContext()) {
        throw new ApiError("abort", "A conexão Wi-Fi mudou. Confirme os dados para continuar.");
      }
      return save({ version: 2, ...result, context, submitted: false });
    });
    initializing = { context, generation: startedGeneration, promise };
    try { return await promise; } finally {
      if (initializing?.promise === promise) initializing = null;
    }
  },
};
