import { getApiBase, getOrCreateTraceId } from "./portal-utils";
import { isAuthResult, type AuthResult } from "./auth-outcome";

const API_BASE = getApiBase();

/** Forward only an explicit ?store= param; server-side attempt/AP data is authoritative. */
export function getStoreParam(search = window.location.search): string {
  const params = new URLSearchParams(search);
  const store = params.get("store");
  return store ? `?store=${encodeURIComponent(store)}` : "";
}

function buildUrl(base: string, path: string): string {
  const qs = getStoreParam();
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const queryIndex = normalizedPath.indexOf("?");
  const routePath = queryIndex === -1 ? normalizedPath : normalizedPath.slice(0, queryIndex);
  const routeQuery = queryIndex === -1 ? "" : normalizedPath.slice(queryIndex + 1);

  // Some external Nginx proxy builds only expose /api/captive-portal as the
  // Edge Function base and drop nested paths. Keep the call alive by encoding
  // the route as a query fallback that the proxy still forwards to Supabase.
  const fallbackRoute = `route=${encodeURIComponent(routePath)}`;
  const root = `${normalizedBase}/`;
  const extra = routeQuery ? `&${routeQuery}` : "";
  return `${root}${qs ? `${qs}&${fallbackRoute}${extra}` : `?${fallbackRoute}${extra}`}`;
}

export class ApiError extends Error {
  kind: "timeout" | "network" | "abort" | "http" | "parse";
  status?: number;
  code?: string;
  retryAfterMs?: number;
  constructor(kind: ApiError["kind"], message: string, status?: number, details: { code?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = details.code;
    this.retryAfterMs = details.retryAfterMs;
  }
}

export interface AttemptCapability {
  attempt_id: string;
  token: string;
  expires_at: string;
}

function retryAfterMs(xhr: XMLHttpRequest, body: any): number | undefined {
  const header = xhr.getResponseHeader("Retry-After");
  const bodyDelay = body?.retry_after_ms;
  const headerDelay = header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : NaN;
  const blockedDelay = typeof body?.blocked_until === "string" ? Date.parse(body.blocked_until) - Date.now() : NaN;
  const delays = [bodyDelay, headerDelay, blockedDelay].filter(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return delays.length ? Math.max(...delays) : undefined;
}

async function authRequest(path: string, body: unknown, timeoutMs: number): Promise<AuthResult> {
  let value = await xhrRequest<any>(path, { method: "POST", body, timeoutMs });
  // Compatibility with the existing silent-login identity challenge.
  if (value && value.authorized === undefined && (value.needs_cpf === true || value.needs_login === true)) {
    value = { ...value, authorized: false, status: "awaiting_identity" };
  }
  if (!isAuthResult(value)) throw new ApiError("parse", "A resposta não pôde ser confirmada. Vamos verificar a mesma tentativa.");
  return value;
}

interface XhrOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * XHR-based request — much more reliable than fetch in captive portal browsers
 * (iOS / Android Captive Network Assistants frequently abort fetch).
 */
function xhrRequest<T = any>(path: string, opts: XhrOptions = {}): Promise<T> {
  const { method = "GET", body, timeoutMs = 20000 } = opts;
  const url = buildUrl(API_BASE, path);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    try {
      xhr.open(method, url, true);
    } catch (_) {
      reject(new ApiError("network", "Erro ao abrir conexão."));
      return;
    }

    xhr.timeout = timeoutMs;
    
    // Cross-origin requests are not expected here as we use a same-origin proxy,
    // but we keep the header setting robust.
    if (body !== undefined) {
      xhr.setRequestHeader("Content-Type", "application/json");
    }
    
    try { 
      xhr.setRequestHeader("x-trace-id", getOrCreateTraceId()); 
    } catch { /* ignore */ }

    xhr.onload = () => {
      const status = xhr.status;
      const text = xhr.responseText || "";
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* Validate below. */ }

      // Success range
      if (status >= 200 && status < 300) {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new ApiError("parse", "Resposta inválida do servidor. A situação do acesso ainda precisa ser verificada.", status));
          return;
        }
        resolve(parsed as T);
        return;
      }

      const details = {
        code: typeof parsed?.code === "string" ? parsed.code : undefined,
        retryAfterMs: retryAfterMs(xhr, parsed),
      };
      const errorMessage = typeof parsed?.error === "string" ? parsed.error : undefined;
      // Preserve structured throttling information for status polling and UI.
      if (status === 429) {
        reject(new ApiError("http", errorMessage || "Muitas tentativas. Aguarde um momento.", status, { ...details, retryAfterMs: details.retryAfterMs ?? 5000 }));
      } else if (status === 401 || status === 403) {
        reject(new ApiError("http", errorMessage || "Acesso não autorizado.", status, details));
      } else if (status >= 400 && status < 500) {
        reject(new ApiError("http", errorMessage || `Erro na requisição (${status}).`, status, details));
      } else if (status >= 500) {
        reject(new ApiError("http", "Ocorreu um erro no servidor. Tente novamente em instantes.", status, details));
      } else if (status === 0) {
        reject(new ApiError("network", "Sem resposta do servidor. Verifique sua conexão."));
      } else {
        // Fallback for valid JSON that isn't a 2xx success
        if (parsed?.error) {
          reject(new ApiError("http", parsed.error, status));
        } else {
          reject(new ApiError("parse", `Resposta inesperada do servidor (${status}).`, status));
        }
      }
    };

    xhr.onerror = () => reject(new ApiError("network", "Erro de conexão. Verifique sua rede."));
    xhr.ontimeout = () => reject(new ApiError("timeout", "Tempo esgotado. Tente novamente."));
    xhr.onabort = () => reject(new ApiError("abort", "A conexão foi interrompida. Vamos verificar a mesma tentativa."));

    try {
      xhr.send(body !== undefined ? JSON.stringify(body) : null);
    } catch (_) {
      reject(new ApiError("network", "Não foi possível enviar a requisição."));
    }
  });
}

export const api = {
  bootstrap() {
    return xhrRequest<any>("/bootstrap", { method: "GET", timeoutMs: 10000 });
  },

  identify(data: {
    phone: string;
    cpf: string;
    client_mac?: string;
    ap_mac?: string;
    ssid?: string;
    redirect_url?: string;
    captive_timestamp?: string;
    consent_version: string;
    attempt_id?: string | null;
    resume_token?: string | null;
  }) {
    return authRequest("/identify", data, 25000);
  },

  authorizeExisting(data: {
    access_token: string;
    client_mac?: string;
    ap_mac?: string;
    ssid?: string;
    redirect_url?: string;
    captive_timestamp?: string;
    auth_method?: string;
    attempt_id?: string | null;
    resume_token?: string | null;
  }) {
    return authRequest("/authorize-existing", data, 20000);
  },

  attemptStatus(data: { attempt_id: string; token: string }) {
    return authRequest("/attempt/status", data, 20000);
  },

  initAttempt(data: {
    params: Record<string, string | undefined>;
    original_url: string;
  }): Promise<AttemptCapability> {
    return xhrRequest<AttemptCapability>("/attempt/init", {
      method: "POST",
      body: data,
      timeoutMs: 15000,
    }).then(value => {
      if (!value.attempt_id || !value.token || typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at))) {
        throw new ApiError("parse", "Não foi possível confirmar a criação da tentativa. Tente novamente.");
      }
      return value;
    });
  },

  /** Fire-and-forget client telemetry. Uses sendBeacon first (survives CNA),
   * falls back to XHR. Never throws. */
  clientEvent(data: { session_id?: string | null; attempt_id?: string; resume_token?: string; event: string; step?: string; status?: string; error_code?: string; error_message?: string; payload?: Record<string, unknown> }) {
    const eventData = { ...data, trace_id: getOrCreateTraceId() };
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const url = buildUrl(API_BASE, "/client-event");
        const blob = new Blob([JSON.stringify(eventData)], { type: "text/plain;charset=UTF-8" });
        if (navigator.sendBeacon(url, blob)) return;
      }
    } catch { /* fall through */ }
    try {
      xhrRequest<any>("/client-event", { method: "POST", body: eventData, timeoutMs: 5000 }).catch(() => {});
    } catch { /* ignore */ }
  },
};
