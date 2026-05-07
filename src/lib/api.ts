import { getApiBase, getOrCreateTraceId, SUPABASE_DIRECT_BASE } from "./portal-utils";

const API_BASE = getApiBase();
const SUPABASE_DIRECT = SUPABASE_DIRECT_BASE;
// Resilience: try same-origin proxy first; fall back to Supabase direct
// (requires fqamejlyytrhovawgtwg.supabase.co to be allowed in the UniFi
// Walled Garden, otherwise the fallback will simply fail too).

/** Forward ?store= param from the landing URL to API calls */
function getStoreParam(): string {
  const params = new URLSearchParams(window.location.search);
  let store = params.get("store");
  if (!store && (params.get("id") || params.get("mac"))) {
    store = "matriz";
  }
  return store ? `?store=${encodeURIComponent(store)}` : "";
}

function buildUrl(base: string, path: string): string {
  const qs = getStoreParam();
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  // Some external Nginx proxy builds only expose /api/captive-portal as the
  // Edge Function base and drop nested paths. Keep the call alive by encoding
  // the route as a query fallback that the proxy still forwards to Supabase.
  const fallbackRoute = `route=${encodeURIComponent(normalizedPath)}`;
  const root = `${normalizedBase}/`;
  return `${root}${qs ? `${qs}&${fallbackRoute}` : `?${fallbackRoute}`}`;
}

export class ApiError extends Error {
  kind: "timeout" | "network" | "http" | "parse";
  status?: number;
  constructor(kind: "timeout" | "network" | "http" | "parse", message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export function createClientSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

interface XhrOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * XHR-based request — much more reliable than fetch in captive portal browsers
 * (iOS / Android Captive Network Assistants frequently abort fetch).
 * Tries the proxy first (when applicable), then falls back to direct Supabase.
 */
function xhrRequest<T = any>(path: string, opts: XhrOptions = {}): Promise<T> {
  const { method = "GET", body, timeoutMs = 20000 } = opts;
  const bases = API_BASE === SUPABASE_DIRECT
    ? [SUPABASE_DIRECT]
    : [API_BASE, SUPABASE_DIRECT];

  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryBase = () => {
      if (attempt >= bases.length) {
        reject(new ApiError("network", "Sem resposta do servidor. Verifique sua conexão."));
        return;
      }
      const base = bases[attempt++];
      const url = buildUrl(base, path);
      // Detect cross-origin to avoid forcing a CORS preflight via x-trace-id.
      let isCrossOrigin = false;
      try {
        const u = new URL(url, window.location.href);
        isCrossOrigin = u.origin !== window.location.origin;
      } catch { /* ignore */ }
      const xhr = new XMLHttpRequest();
      try {
        xhr.open(method, url, true);
      } catch (e) {
        tryBase();
        return;
      }
      xhr.timeout = timeoutMs;
      if (body !== undefined) {
        // Cross-origin requests use text/plain to skip the CORS preflight,
        // which often fails inside captive-network assistants / Walled Garden.
        // The edge function's safeParseJson() accepts text/plain too.
        if (isCrossOrigin) {
          xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
        } else {
          xhr.setRequestHeader("Content-Type", "application/json");
        }
      }
      if (!isCrossOrigin) {
        try { xhr.setRequestHeader("x-trace-id", getOrCreateTraceId()); } catch { /* ignore */ }
      }
      xhr.onload = () => {
        const status = xhr.status;
        const text = xhr.responseText || "";
        // Retry on transient gateway errors via fallback base
        if ((status === 0 || status === 502 || status === 503 || status === 504) && attempt < bases.length) {
          console.warn(`[api] ${path} HTTP ${status} on ${base}, falling back`);
          tryBase();
          return;
        }
        let parsed: any = null;
        try { parsed = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
        if (parsed && typeof parsed === "object") {
          // Even when API returns {error: "..."}, surface as resolved value
          // so callers can show a friendly message instead of a generic failure.
          resolve(parsed as T);
          return;
        }
        if (status >= 500) {
          reject(new ApiError("http", `Servidor indisponível (${status}).`, status));
        } else if (status === 0) {
          reject(new ApiError("network", "Sem resposta do servidor."));
        } else {
          reject(new ApiError("parse", `Resposta inesperada do servidor (${status}).`, status));
        }
      };
      xhr.onerror = () => {
        console.warn(`[api] ${path} network error on ${base}`);
        if (attempt < bases.length) tryBase();
        else reject(new ApiError("network", "Erro de conexão. Verifique sua rede."));
      };
      xhr.ontimeout = () => {
        console.warn(`[api] ${path} timeout on ${base}`);
        if (attempt < bases.length) tryBase();
        else reject(new ApiError("timeout", "Tempo esgotado. Tente novamente."));
      };
      try {
        xhr.send(body !== undefined ? JSON.stringify(body) : null);
      } catch (e) {
        if (attempt < bases.length) tryBase();
        else reject(new ApiError("network", "Não foi possível enviar a requisição."));
      }
    };

    tryBase();
  });
}

export const api = {
  bootstrap() {
    return xhrRequest<any>("/bootstrap", { method: "GET", timeoutMs: 10000 });
  },

  startSession(data: {
    client_mac?: string;
    ap_mac?: string;
    ssid?: string;
    redirect_url?: string;
  }) {
    return xhrRequest<any>("/start", {
      method: "POST",
      body: { ...data, user_agent: navigator.userAgent },
      timeoutMs: 12000,
    });
  },

  submitLead(data: {
    session_id?: string;
    name: string;
    email?: string;
    phone?: string;
    cpf?: string;
    client_mac?: string;
    ap_mac?: string;
    ssid?: string;
    redirect_url?: string;
    user_agent?: string;
    consent_version: string;
  }) {
    return xhrRequest<any>("/submit", {
      method: "POST",
      body: data,
      timeoutMs: 35000,
    });
  },

  sessionStatus(session_id: string) {
    return xhrRequest<any>("/session-status", {
      method: "POST",
      body: { session_id },
      timeoutMs: 8000,
    });
  },

  requestCode(data: { session_id: string; phone: string }) {
    return xhrRequest<any>("/request-code", {
      method: "POST",
      body: data,
      timeoutMs: 15000,
    });
  },

  verifyCode(data: { session_id: string; code: string }) {
    return xhrRequest<any>("/verify-code", {
      method: "POST",
      body: data,
      timeoutMs: 30000,
    });
  },

  /** Fire-and-forget client telemetry. Never throws. */
  clientEvent(data: { session_id?: string | null; event: string; step?: string; status?: string; error_code?: string; error_message?: string; payload?: Record<string, unknown> }) {
    try {
      xhrRequest<any>("/client-event", { method: "POST", body: data, timeoutMs: 5000 }).catch(() => {});
    } catch { /* ignore */ }
  },
};
