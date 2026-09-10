import { api } from "./api";

const ATTEMPT_ID_KEY = "mb_auth_attempt_id";
const ATTEMPT_TOKEN_KEY = "mb_auth_attempt_token";

function readCaptiveParams(): Record<string, string> {
  const query = new URLSearchParams(window.location.search);
  const params: Record<string, string> = {};
  for (const key of ["id", "mac", "ap", "ssid", "url", "t", "site", "store"]) {
    const value = query.get(key);
    if (value) params[key] = value;
  }
  return params;
}

export const AttemptTracker = {
  get(): { attempt_id: string | null; token: string | null } {
    return {
      attempt_id: sessionStorage.getItem(ATTEMPT_ID_KEY),
      token: sessionStorage.getItem(ATTEMPT_TOKEN_KEY),
    };
  },

  clear() {
    sessionStorage.removeItem(ATTEMPT_ID_KEY);
    sessionStorage.removeItem(ATTEMPT_TOKEN_KEY);
  },

  async ensureAttempt(): Promise<{ attempt_id: string; token: string } | null> {
    const current = this.get();
    if (current.attempt_id && current.token) {
      return { attempt_id: current.attempt_id, token: current.token };
    }

    try {
      const result = await api.initAttempt({
        params: readCaptiveParams(),
        original_url: window.location.href,
      });
      if (!result.attempt_id || !result.token) return null;
      sessionStorage.setItem(ATTEMPT_ID_KEY, result.attempt_id);
      sessionStorage.setItem(ATTEMPT_TOKEN_KEY, result.token);
      return result;
    } catch (error) {
      console.error("[AttemptTracker] attempt init failed", error);
      return null;
    }
  },
};
