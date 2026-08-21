
/**
 * Utility to track Google OAuth flow and preserve captive parameters.
 */

const STORAGE_KEY = "mb_oauth_marker_v1";
const CAPTIVE_PARAMS_KEY = "mb_captive_params_v3";

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
   * Save captive parameters to localStorage before starting OAuth.
   */
  stashCaptiveParams() {
    try {
      const p = new URLSearchParams(window.location.search);
      const out: Record<string, string> = {};
      const keys = ["id", "mac", "ap", "ssid", "url", "t", "site", "store"];
      
      keys.forEach((k) => {
        const v = p.get(k);
        if (v) out[k] = v;
      });

      if (Object.keys(out).length) {
        localStorage.setItem(CAPTIVE_PARAMS_KEY, JSON.stringify(out));
      }
      
      // Save OAuth marker with timestamp
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: "1.0",
        timestamp: Date.now(),
        provider: "google"
      }));
    } catch (e) {
      console.warn("[OAuthTracker] stash failed:", e);
    }
  },

  /**
   * Restore stashed captive parameters into the current URL.
   */
  restoreCaptiveParams(): boolean {
    try {
      const raw = localStorage.getItem(CAPTIVE_PARAMS_KEY);
      if (!raw) return false;
      
      const saved = JSON.parse(raw) as CaptiveParams;
      const current = new URLSearchParams(window.location.search);
      
      let changed = false;
      Object.entries(saved).forEach(([k, v]) => {
        if (v && !current.has(k)) {
          current.set(k, v);
          changed = true;
        }
      });

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
   * Check if we are in an active OAuth flow.
   * TTL: 10 minutes.
   */
  isValidOAuthFlow(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      
      const marker = JSON.parse(raw);
      const now = Date.now();
      const tenMinutes = 10 * 60 * 1000;
      
      if (marker && marker.timestamp && (now - marker.timestamp) < tenMinutes) {
        return true;
      }
      
      // Expired or invalid
      this.clearMarker();
    } catch (e) {
      this.clearMarker();
    }
    return false;
  },

  /**
   * Clear only the OAuth marker. Captive params stay until authorization finishes.
   */
  clearMarker() {
    localStorage.removeItem(STORAGE_KEY);
  },

  /**
   * Clear everything.
   */
  clearAll() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(CAPTIVE_PARAMS_KEY);
  }
};
