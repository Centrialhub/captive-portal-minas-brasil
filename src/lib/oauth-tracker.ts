import { api } from "./api";

const ATTEMPT_ID_KEY = "mb_oauth_attempt_id";
const ATTEMPT_TOKEN_KEY = "mb_oauth_attempt_token";
const OAUTH_MARKER_KEY = "mb_google_oauth_marker";
const CAPTIVE_PARAMS_KEY = "mb_captive_params";

export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const OAUTH_MARKER_VERSION = 1;

export interface CaptiveParams {
  [key: string]: string | undefined;
  id?: string;
  mac?: string;
  ap?: string;
  ssid?: string;
  url?: string;
  t?: string;
  site?: string;
  store?: string;
}

interface OAuthMarker {
  version: number;
  provider: "google";
  startedAt: number;
}

type CaptiveParamKey = "id" | "mac" | "ap" | "ssid" | "url" | "t" | "site" | "store";

const CAPTIVE_PARAM_KEYS: CaptiveParamKey[] = [
  "id", "mac", "ap", "ssid", "url", "t", "site", "store",
];

function readCaptiveParams(search = window.location.search): CaptiveParams {
  const query = new URLSearchParams(search);
  const params: CaptiveParams = {};
  for (const key of CAPTIVE_PARAM_KEYS) {
    const value = query.get(key);
    if (value) params[key] = value;
  }
  return params;
}

function readMarker(): OAuthMarker | null {
  try {
    const raw = localStorage.getItem(OAUTH_MARKER_KEY);
    if (!raw) return null;
    const marker = JSON.parse(raw) as Partial<OAuthMarker>;
    if (
      marker.version !== OAUTH_MARKER_VERSION ||
      marker.provider !== "google" ||
      typeof marker.startedAt !== "number"
    ) return null;
    return marker as OAuthMarker;
  } catch {
    return null;
  }
}

function stripLegacyTokensFromUrl() {
  const query = new URLSearchParams(window.location.search);
  if (!query.has("attempt_id") && !query.has("resume_token")) return;
  query.delete("attempt_id");
  query.delete("resume_token");
  const search = query.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
  );
}

export const OAuthTracker = {
  async initOAuthTransaction(): Promise<{ attempt_id: string; token: string } | null> {
    try {
      const params = readCaptiveParams();
      if (!params.id && !params.mac) {
        console.warn("[OAuthTracker] captive MAC is missing");
      }

      const result = await api.initOAuth({ params, original_url: window.location.href });
      if (!result.attempt_id || !result.token) return null;

      localStorage.setItem(ATTEMPT_ID_KEY, result.attempt_id);
      localStorage.setItem(ATTEMPT_TOKEN_KEY, result.token);
      localStorage.setItem(CAPTIVE_PARAMS_KEY, JSON.stringify(params));
      localStorage.setItem(OAUTH_MARKER_KEY, JSON.stringify({
        version: OAUTH_MARKER_VERSION,
        provider: "google",
        startedAt: Date.now(),
      } satisfies OAuthMarker));
      stripLegacyTokensFromUrl();
      return result;
    } catch (error) {
      console.error("[OAuthTracker] init failed", error);
      return null;
    }
  },

  restoreCaptiveParams(): boolean {
    try {
      stripLegacyTokensFromUrl();
      const raw = localStorage.getItem(CAPTIVE_PARAMS_KEY);
      if (!raw) return false;
      const stored = JSON.parse(raw) as CaptiveParams;
      const query = new URLSearchParams(window.location.search);
      let changed = false;
      for (const key of CAPTIVE_PARAM_KEYS) {
        const value = stored[key];
        if (value && !query.has(key)) {
          query.set(key, value);
          changed = true;
        }
      }
      if (!changed) return false;
      const search = query.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
      );
      return true;
    } catch (error) {
      console.warn("[OAuthTracker] captive parameter restore failed", error);
      return false;
    }
  },

  isValidOAuthFlow(now = Date.now()): boolean {
    const marker = readMarker();
    const tokens = this.getTokens();
    if (!marker || !tokens.attempt_id || !tokens.token) return false;
    const age = now - marker.startedAt;
    return age >= 0 && age <= OAUTH_FLOW_TTL_MS;
  },

  getTokens(): { attempt_id: string | null; token: string | null } {
    return {
      attempt_id: localStorage.getItem(ATTEMPT_ID_KEY),
      token: localStorage.getItem(ATTEMPT_TOKEN_KEY),
    };
  },

  updateTokens(attemptId: string, token: string) {
    localStorage.setItem(ATTEMPT_ID_KEY, attemptId);
    localStorage.setItem(ATTEMPT_TOKEN_KEY, token);
    localStorage.setItem(OAUTH_MARKER_KEY, JSON.stringify({
      version: OAUTH_MARKER_VERSION,
      provider: "google",
      startedAt: Date.now(),
    } satisfies OAuthMarker));
    stripLegacyTokensFromUrl();
  },

  clearAll() {
    localStorage.removeItem(ATTEMPT_ID_KEY);
    localStorage.removeItem(ATTEMPT_TOKEN_KEY);
    localStorage.removeItem(OAUTH_MARKER_KEY);
    localStorage.removeItem(CAPTIVE_PARAMS_KEY);
    stripLegacyTokensFromUrl();
  },

  async ensureAttempt(): Promise<{ attempt_id: string; token: string } | null> {
    const existing = this.getTokens();
    if (existing.attempt_id && existing.token) {
      return { attempt_id: existing.attempt_id, token: existing.token };
    }

    // Email and silent authentication use the same server-authoritative
    // attempt primitive, but are deliberately not marked as Google OAuth.
    try {
      const params = readCaptiveParams();
      const result = await api.initOAuth({ params, original_url: window.location.href });
      if (!result.attempt_id || !result.token) return null;
      localStorage.setItem(ATTEMPT_ID_KEY, result.attempt_id);
      localStorage.setItem(ATTEMPT_TOKEN_KEY, result.token);
      localStorage.setItem(CAPTIVE_PARAMS_KEY, JSON.stringify(params));
      return result;
    } catch (error) {
      console.error("[OAuthTracker] attempt init failed", error);
      return null;
    }
  },
};
