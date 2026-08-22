
/**
 * Utility to track Google OAuth flow and preserve captive parameters authoritatively.
 */
import { api } from "./api";

const ATTEMPT_ID_KEY = "mb_oauth_attempt_id";
const ATTEMPT_TOKEN_KEY = "mb_oauth_attempt_token";

export interface CaptiveParams {
  id?: string;
  mac?: string;
  ap?: string;
  ssid?: string;
  url?: string;
  t?: string;
  site?: string;
  store?: string;
}

export const OAuthTracker = {
  /**
   * Initialize a server-side OAuth transaction.
   */
  async initOAuthTransaction(): Promise<{ attempt_id: string; token: string } | null> {
    try {
      const p = new URLSearchParams(window.location.search);
      const params: Record<string, string> = {};
      const keys = ["id", "mac", "ap", "ssid", "url", "t", "site", "store"];
      
      keys.forEach((k) => {
        const v = p.get(k);
        if (v) params[k] = v;
      });

      if (!params.id && !params.mac) {
        console.warn("[OAuthTracker] Missing MAC address in parameters");
      }

      const res = await api.initOAuth({
        params,
        original_url: window.location.href
      });

      if (res.attempt_id && res.token) {
        localStorage.setItem(ATTEMPT_ID_KEY, res.attempt_id);
        localStorage.setItem(ATTEMPT_TOKEN_KEY, res.token);
        return { attempt_id: res.attempt_id, token: res.token };
      }
      
      return null;
    } catch (e) {
      console.error("[OAuthTracker] init failed:", e);
      return null;
    }
  },

  /**
   * Restore stashed captive parameters into the current URL using the attempt tokens.
   */
  restoreCaptiveParams(): boolean {
    try {
      const attemptId = localStorage.getItem(ATTEMPT_ID_KEY);
      const token = localStorage.getItem(ATTEMPT_TOKEN_KEY);
      
      if (!attemptId || !token) return false;
      
      const current = new URLSearchParams(window.location.search);
      let changed = false;

      if (!current.has("attempt_id")) {
        current.set("attempt_id", attemptId);
        changed = true;
      }
      if (!current.has("resume_token")) {
        current.set("resume_token", token);
        changed = true;
      }

      if (changed) {
        const qs = current.toString();
        const newUrl = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
        window.history.replaceState(null, "", newUrl);
        return true;
      }
    } catch (e) {
      console.warn("[OAuthTracker] restore failed:", e);
    }
    return false;
  },

  /**
   * Check if we have tokens for an active transaction.
   */
  isValidOAuthFlow(): boolean {
    const attemptId = localStorage.getItem(ATTEMPT_ID_KEY);
    const token = localStorage.getItem(ATTEMPT_TOKEN_KEY);
    
    // We also check for tokens in the current URL (callback path)
    const p = new URLSearchParams(window.location.search);
    const urlAttemptId = p.get("attempt_id");
    const urlToken = p.get("resume_token");

    return !!((attemptId && token) || (urlAttemptId && urlToken));
  },

  getTokens() {
    const p = new URLSearchParams(window.location.search);
    const urlId = p.get("attempt_id");
    const urlToken = p.get("resume_token");
    const storageId = localStorage.getItem(ATTEMPT_ID_KEY);
    const storageToken = localStorage.getItem(ATTEMPT_TOKEN_KEY);

    // If URL has tokens, they must match storage or we prefer URL if storage is empty
    return {
      attempt_id: urlId || storageId,
      token: urlToken || storageToken
    };
  },

  /**
   * Clear everything.
   */
  clearAll() {
    localStorage.removeItem(ATTEMPT_ID_KEY);
    localStorage.removeItem(ATTEMPT_TOKEN_KEY);
    
    // Also remove from URL to prevent infinite reload loops
    const current = new URLSearchParams(window.location.search);
    if (current.has("attempt_id") || current.has("resume_token")) {
      current.delete("attempt_id");
      current.delete("resume_token");
      const qs = current.toString();
      const newUrl = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(null, "", newUrl);
    }
  },

  /**
   * Ensure an active OAuth attempt exists.
   */
  async ensureAttempt(): Promise<{ attempt_id: string; token: string } | null> {
    const existing = this.getTokens();
    if (existing.attempt_id && existing.token) {
      return { attempt_id: existing.attempt_id, token: existing.token };
    }
    return this.initOAuthTransaction();
  },

  // Legacy stubs for App.tsx compatibility during migration
  stashCaptiveParams() { console.warn("stashCaptiveParams is deprecated, use initOAuthTransaction"); }
};
