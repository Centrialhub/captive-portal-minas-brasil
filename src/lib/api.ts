import { getApiBase, getQueryParams } from "./portal-utils";

const API_BASE = getApiBase();

/** Forward ?store= param from the landing URL to API calls */
function getStoreParam(): string {
  const store = new URLSearchParams(window.location.search).get("store");
  return store ? `?store=${encodeURIComponent(store)}` : "";
}

async function resilientFetch(
  url: string,
  options?: RequestInit & { retries?: number; timeoutMs?: number },
): Promise<Response> {
  const { retries = 0, timeoutMs = 8000, ...fetchOpts } = options || {};
  const delays = [500, 1500];
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delays[attempt] || 1500));
      }
    }
  }
  throw lastError;
}

export const api = {
  async bootstrap() {
    const res = await resilientFetch(`${API_BASE}/bootstrap${getStoreParam()}`, { retries: 2 });
    return res.json();
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
    return res.json();
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
    const res = await resilientFetch(`${API_BASE}/submit${getStoreParam()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async requestCode(data: { session_id: string; phone: string }) {
    const res = await resilientFetch(`${API_BASE}/request-code${getStoreParam()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async verifyCode(data: { session_id: string; code: string }) {
    const res = await resilientFetch(`${API_BASE}/verify-code${getStoreParam()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.json();
  },
};
