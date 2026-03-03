const API_BASE = "/api/captive-portal";

/** Fetch with timeout + retry (for pre-auth captive resilience) */
async function resilientFetch(
  url: string,
  options?: RequestInit & { retries?: number; timeoutMs?: number },
): Promise<Response> {
  const { retries = 0, timeoutMs = 6000, ...fetchOpts } = options || {};
  const delays = [400, 1200];

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
      if (import.meta.env.DEV) {
        console.warn(`[api] attempt ${attempt + 1} failed for ${url}`, err);
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delays[attempt] || 1200));
      }
    }
  }

  throw lastError;
}

export const api = {
  async bootstrap() {
    const res = await resilientFetch(`${API_BASE}/bootstrap`, { retries: 2 });
    return res.json();
  },

  async startSession(data: {
    client_mac?: string;
    client_ip?: string;
    ap_mac?: string;
    ssid?: string;
    redirect_url?: string;
  }) {
    const res = await resilientFetch(`${API_BASE}/start`, {
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
    const res = await resilientFetch(`${API_BASE}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async requestCode(data: { session_id: string; phone: string }) {
    const res = await resilientFetch(`${API_BASE}/request-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async verifyCode(data: { session_id: string; code: string }) {
    const res = await resilientFetch(`${API_BASE}/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  // Admin endpoints — keep absolute URL since admin runs post-auth
  async adminRequest(path: string, token: string, options?: RequestInit) {
    const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
    const FUNCTION_BASE = `${SUPABASE_URL}/functions/v1/captive-portal`;

    const res = await fetch(`${FUNCTION_BASE}/admin/${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options?.headers || {}),
      },
    });
    return res.json();
  },
};
