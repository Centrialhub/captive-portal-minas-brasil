import { getApiBase, getOrCreateTraceId } from "./portal-utils";

const API_BASE = getApiBase();

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
  kind: "timeout" | "network" | "http" | "parse";
  status?: number;
  constructor(kind: "timeout" | "network" | "http" | "parse", message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
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
    } catch (_e) {
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
      try { parsed = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }

      // Success range
      if (status >= 200 && status < 300) {
        resolve(parsed as T);
        return;
      }

      // Handle specific HTTP error codes
      if (status === 429) {
        reject(new ApiError("http", parsed?.error || "Muitas tentativas. Aguarde um momento.", status));
      } else if (status === 401 || status === 403) {
        reject(new ApiError("http", parsed?.error || "Acesso não autorizado.", status));
      } else if (status >= 400 && status < 500) {
        reject(new ApiError("http", parsed?.error || `Erro na requisição (${status}).`, status));
      } else if (status >= 500) {
        reject(new ApiError("http", "Ocorreu um erro no servidor. Tente novamente em instantes.", status));
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

    try {
      xhr.send(body !== undefined ? JSON.stringify(body) : null);
    } catch (_e) {
      reject(new ApiError("network", "Não foi possível enviar a requisição."));
    }
  });
}

export const api = {
  bootstrap() {
    return xhrRequest<any>("/bootstrap", { method: "GET", timeoutMs: 10000 });
  },

  signup(data: {
    name: string;
    email: string;
    phone: string;
    password: string;
    client_mac?: string;
    ap_mac?: string;
    ssid?: string;
    redirect_url?: string;
    captive_timestamp?: string;
    consent_version: string;
    attempt_id?: string | null;
    resume_token?: string | null;
  }) {
    return xhrRequest<any>("/signup", { method: "POST", body: data, timeoutMs: 25000 });
  },

  login(data: {
    email: string;
    password: string;
    client_mac?: string;
    ap_mac?: string;
    ssid?: string;
    redirect_url?: string;
    captive_timestamp?: string;
    attempt_id?: string | null;
    resume_token?: string | null;
  }) {
    return xhrRequest<any>("/login", { method: "POST", body: data, timeoutMs: 20000 });
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
    return xhrRequest<any>("/authorize-existing", { method: "POST", body: data, timeoutMs: 20000 });
  },

  initOAuth(data: {
    params: Record<string, string>;
    original_url: string;
  }): Promise<{ attempt_id: string; token: string }> {
    return xhrRequest<{ attempt_id: string; token: string }>("/oauth/init", {
      method: "POST",
      body: data,
      timeoutMs: 15000,
    });
  },

  restartOAuth(data: { attempt_id: string; resume_token: string }): Promise<{ attempt_id: string; token: string }> {
    return xhrRequest<{ attempt_id: string; token: string }>("/oauth/restart", {
      method: "POST",
      body: data,
      timeoutMs: 15000,
    });
  },

  requestPasswordReset(data: { email: string }) {
    return xhrRequest<any>("/request-password-reset", { method: "POST", body: data, timeoutMs: 15000 });
  },

  updateProfile(data: { access_token: string; name?: string; phone?: string; cpf?: string }) {
    return xhrRequest<any>("/update-profile", { method: "POST", body: data, timeoutMs: 20000 });
  },

  /** Fire-and-forget client telemetry. Uses sendBeacon first (survives CNA),
   * falls back to XHR. Never throws. */
  clientEvent(data: { session_id?: string | null; event: string; step?: string; status?: string; error_code?: string; error_message?: string; payload?: Record<string, unknown> }) {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const url = buildUrl(API_BASE, "/client-event");
        const blob = new Blob([JSON.stringify(data)], { type: "text/plain;charset=UTF-8" });
        if (navigator.sendBeacon(url, blob)) return;
      }
    } catch { /* fall through */ }
    try {
      xhrRequest<any>("/client-event", { method: "POST", body: data, timeoutMs: 5000 }).catch(() => {});
    } catch { /* ignore */ }
  },
};
