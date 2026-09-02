import { api } from "./api";

const ATTEMPT_ID_KEY = "mb_oauth_attempt_id";
const ATTEMPT_TOKEN_KEY = "mb_oauth_attempt_token";
const OAUTH_MARKER_KEY = "mb_google_oauth_marker";
const CAPTIVE_PARAMS_KEY = "mb_captive_params";

export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const OAUTH_MARKER_VERSION = 2;

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
  attemptId: string;
  captiveFingerprint: string;
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

function readStoredCaptiveParams(): CaptiveParams | null {
  try {
    const raw = localStorage.getItem(CAPTIVE_PARAMS_KEY);
    return raw ? JSON.parse(raw) as CaptiveParams : null;
  } catch {
    return null;
  }
}

function captiveFingerprint(params: CaptiveParams): string {
  return [params.id || params.mac || "", params.ap || "", params.ssid || "", params.store || ""]
    .map((value) => value.trim().toLowerCase())
    .join("|");
}

function hasCaptiveIdentity(params: CaptiveParams | null): boolean {
  return !!(params?.id || params?.mac);
}

function sameCaptiveIdentity(left: CaptiveParams | null, right: CaptiveParams | null): boolean {
  if (!hasCaptiveIdentity(left) || !hasCaptiveIdentity(right)) return false;
  return captiveFingerprint(left!) === captiveFingerprint(right!);
}

function writeOAuthState(attemptId: string, token: string, params: CaptiveParams, markGoogle: boolean) {
  localStorage.setItem(ATTEMPT_ID_KEY, attemptId);
  localStorage.setItem(ATTEMPT_TOKEN_KEY, token);
  localStorage.setItem(CAPTIVE_PARAMS_KEY, JSON.stringify(params));
  if (markGoogle) {
    localStorage.setItem(OAUTH_MARKER_KEY, JSON.stringify({
      version: OAUTH_MARKER_VERSION,
      provider: "google",
      startedAt: Date.now(),
      attemptId,
      captiveFingerprint: captiveFingerprint(params),
    } satisfies OAuthMarker));
  } else {
    localStorage.removeItem(OAUTH_MARKER_KEY);
  }
}

function readMarker(): OAuthMarker | null {
  try {
    const raw = localStorage.getItem(OAUTH_MARKER_KEY);
    if (!raw) return null;
    const marker = JSON.parse(raw) as Partial<OAuthMarker>;
    if (
      marker.version !== OAUTH_MARKER_VERSION ||
      marker.provider !== "google" ||
      typeof marker.startedAt !== "number" ||
      typeof marker.attemptId !== "string" ||
      typeof marker.captiveFingerprint !== "string"
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

      writeOAuthState(result.attempt_id, result.token, params, true);
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
      const stored = readStoredCaptiveParams();
      if (!stored) return false;
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
    const stored = readStoredCaptiveParams();
    if (!stored || marker.attemptId !== tokens.attempt_id) return false;
    if (marker.captiveFingerprint !== captiveFingerprint(stored)) return false;
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
    writeOAuthState(attemptId, token, readStoredCaptiveParams() || readCaptiveParams(), true);
    stripLegacyTokensFromUrl();
  },

  async claimExternalHandoff(handoff: string): Promise<boolean> {
    try {
      const result = await api.claimOAuthHandoff({ handoff });
      if (!result.attempt_id || !result.token || !result.params) return false;
      writeOAuthState(result.attempt_id, result.token, result.params, true);
      stripLegacyTokensFromUrl();
      return true;
    } catch (error) {
      console.error("[OAuthTracker] handoff claim failed", error);
      return false;
    }
  },

  clearAll() {
    localStorage.removeItem(ATTEMPT_ID_KEY);
    localStorage.removeItem(ATTEMPT_TOKEN_KEY);
    localStorage.removeItem(OAUTH_MARKER_KEY);
    localStorage.removeItem(CAPTIVE_PARAMS_KEY);
    stripLegacyTokensFromUrl();
  },

  async ensureAttempt(): Promise<{ attempt_id: string; token: string } | null> {
    const currentParams = readCaptiveParams();
    const storedParams = readStoredCaptiveParams();
    const existing = this.getTokens();
    if (existing.attempt_id && existing.token) {
      if (!hasCaptiveIdentity(currentParams) || sameCaptiveIdentity(currentParams, storedParams)) {
        return { attempt_id: existing.attempt_id, token: existing.token };
      }
      // A new captive visit must never inherit the capability for another MAC.
      this.clearAll();
    }

    // Email and silent authentication use the same server-authoritative
    // attempt primitive, but are deliberately not marked as Google OAuth.
    try {
      const params = currentParams;
      const result = await api.initOAuth({ params, original_url: window.location.href });
      if (!result.attempt_id || !result.token) return null;
      writeOAuthState(result.attempt_id, result.token, params, false);
      return result;
    } catch (error) {
      console.error("[OAuthTracker] attempt init failed", error);
      return null;
    }
  },
};
