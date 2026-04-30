import { getApiBase, getQueryParams } from "./portal-utils";

const API_BASE = getApiBase();

/** Forward ?store= param from the landing URL to API calls */
function getStoreParam(): string {
  const params = new URLSearchParams(window.location.search);
  let store = params.get("store");
  // Fallback: if loaded from captive context (has id/mac param) without ?store=,
  // default to "matriz" to avoid "No store detected" errors
  if (!store && (params.get("id") || params.get("mac"))) {
    store = "matriz";
  }
  return store ? `?store=${encodeURIComponent(store)}` : "";
}

async function resilientFetch(
  url: string,
  options?: RequestInit & { retries?: number; timeoutMs?: number },
): Promise<Response> {
  const { retries = 0, timeoutMs = 15000, ...fetchOpts } = options || {};
  const delays = [500, 1500, 3000];
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
      clearTimeout(timer);
      // Retry on transient gateway errors (502/503/504) when retries remain
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        lastError = new Error(`HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, delays[attempt] || 3000));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`[api] fetch attempt ${attempt + 1} failed:`, (err as Error)?.message || err);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delays[attempt] || 3000));
      }
    }
  }
  throw lastError;
}

/** Parse a Response as JSON; if the body isn't JSON, throw a useful error including status + snippet. */
async function safeJson(res: Response, label: string): Promise<any> {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ct.includes("application/json")) {
    try { return JSON.parse(text); } catch { /* fall through */ }
  }
  // Non-JSON response (HTML error page, empty body, captive portal interception, etc.)
  const snippet = text.slice(0, 120).replace(/\s+/g, " ").trim();
  console.error(`[api:${label}] non-JSON response`, { status: res.status, contentType: ct, snippet });
  throw new Error(
    res.status >= 500
      ? `Servidor indisponível (${res.status}). Tente novamente em instantes.`
      : res.status === 0 || !res.status
        ? "Sem resposta do servidor. Verifique sua conexão."
        : `Resposta inesperada do servidor (${res.status}).`,
  );
}

export const api = {
  async bootstrap() {
    const res = await resilientFetch(`${API_BASE}/bootstrap${getStoreParam()}`, { retries: 2 });
    return safeJson(res, "bootstrap");
  },

  async startSession(data: {
    client_mac?: string;
    ap_mac?: string;
    ssid?: string;
    redirect_url?: string;
  }) {
    const res = await resilientFetch(`${API_BASE}/start${getStoreParam()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, user_agent: navigator.userAgent }),
      retries: 2,
    });
    return safeJson(res, "start");
  },

  async submitLead(data: {
    session_id?: string;
    name: string;
    email?: string;
    phone?: string;
    cpf?: string;
    client_mac?: string;
    consent_version: string;
  }) {
    // Submit is critical and must be resilient — captive networks are flaky.
    const res = await resilientFetch(`${API_BASE}/submit${getStoreParam()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      retries: 2,
      timeoutMs: 25000,
    });
    return safeJson(res, "submit");
  },

  async requestCode(data: { session_id: string; phone: string }) {
    const res = await resilientFetch(`${API_BASE}/request-code${getStoreParam()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      retries: 2,
      timeoutMs: 20000,
    });
    return safeJson(res, "request-code");
  },

  async verifyCode(data: { session_id: string; code: string }) {
    const res = await resilientFetch(`${API_BASE}/verify-code${getStoreParam()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      retries: 1,
      timeoutMs: 30000, // verify-code can take up to ~20s due to UniFi polling
    });
    return safeJson(res, "verify-code");
  },
};

