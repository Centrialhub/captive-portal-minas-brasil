const SUPABASE_URL = "https://fqamejlyytrhovawgtwg.supabase.co";
const FUNCTION_BASE = `${SUPABASE_URL}/functions/v1/captive-portal`;

export const api = {
  async bootstrap(storeSlug: string) {
    const res = await fetch(`${FUNCTION_BASE}/bootstrap?store=${encodeURIComponent(storeSlug)}`);
    return res.json();
  },

  async startSession(data: {
    store_slug: string;
    client_mac?: string;
    client_ip?: string;
    ap_mac?: string;
    ssid?: string;
    redirect_url?: string;
  }) {
    const res = await fetch(`${FUNCTION_BASE}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, user_agent: navigator.userAgent }),
    });
    return res.json();
  },

  async submitLead(data: {
    session_id?: string;
    store_slug: string;
    name: string;
    email?: string;
    phone?: string;
    client_mac?: string;
    consent_version: string;
  }) {
    const res = await fetch(`${FUNCTION_BASE}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  // Admin endpoints
  async adminRequest(path: string, token: string, options?: RequestInit) {
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
