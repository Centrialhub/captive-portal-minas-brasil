// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  OAuthTracker,
  OAUTH_FLOW_TTL_MS,
} from "./oauth-tracker";

const ATTEMPT_ID_KEY = "mb_oauth_attempt_id";
const ATTEMPT_TOKEN_KEY = "mb_oauth_attempt_token";
const MARKER_KEY = "mb_google_oauth_marker";
const PARAMS_KEY = "mb_captive_params";

describe("OAuth transaction tracking", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/oauth/callback");
    vi.restoreAllMocks();
  });

  it("accepts only a versioned, unexpired Google marker with both tokens", () => {
    const now = Date.now();
    localStorage.setItem(ATTEMPT_ID_KEY, "attempt");
    localStorage.setItem(ATTEMPT_TOKEN_KEY, "secret");
    localStorage.setItem(PARAMS_KEY, JSON.stringify({ id: "001122334455", ap: "AABBCCDDEEFF" }));
    localStorage.setItem(MARKER_KEY, JSON.stringify({
      version: 2,
      provider: "google",
      startedAt: now,
      attemptId: "attempt",
      captiveFingerprint: "001122334455|aabbccddeeff||",
    }));
    expect(OAuthTracker.isValidOAuthFlow(now)).toBe(true);
    expect(OAuthTracker.isValidOAuthFlow(now + OAUTH_FLOW_TTL_MS + 1)).toBe(false);
  });

  it("never writes capability tokens to the URL", () => {
    OAuthTracker.updateTokens("attempt", "secret");
    expect(window.location.search).not.toContain("attempt_id");
    expect(window.location.search).not.toContain("resume_token");
    expect(OAuthTracker.getTokens()).toEqual({ attempt_id: "attempt", token: "secret" });
  });

  it("restores captive parameters and strips legacy token query values", () => {
    localStorage.setItem(PARAMS_KEY, JSON.stringify({ id: "001122334455", ap: "AABBCCDDEEFF", store: "matriz" }));
    window.history.replaceState(null, "", "/oauth/callback?attempt_id=old&resume_token=secret");
    expect(OAuthTracker.restoreCaptiveParams()).toBe(true);
    const query = new URLSearchParams(window.location.search);
    expect(query.get("id")).toBe("001122334455");
    expect(query.get("ap")).toBe("AABBCCDDEEFF");
    expect(query.get("store")).toBe("matriz");
    expect(query.has("attempt_id")).toBe(false);
    expect(query.has("resume_token")).toBe(false);
  });

  it("does not reuse an attempt belonging to another captive identity", async () => {
    localStorage.setItem(ATTEMPT_ID_KEY, "old-attempt");
    localStorage.setItem(ATTEMPT_TOKEN_KEY, "old-secret");
    localStorage.setItem(PARAMS_KEY, JSON.stringify({ id: "001122334455", ap: "AABBCCDDEEFF" }));
    window.history.replaceState(null, "", "/?id=66778899AABB&ap=112233445566");
    vi.spyOn(api, "initOAuth").mockResolvedValue({ attempt_id: "new-attempt", token: "new-secret" });

    await expect(OAuthTracker.ensureAttempt()).resolves.toEqual({
      attempt_id: "new-attempt",
      token: "new-secret",
    });
    expect(OAuthTracker.getTokens()).toEqual({ attempt_id: "new-attempt", token: "new-secret" });
  });

});
