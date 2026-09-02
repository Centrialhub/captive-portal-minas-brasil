// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { useOAuthCallback } from "./useOAuthCallback";
import { supabase } from "../integrations/supabase/client";
import { api } from "../lib/api";
import { OAuthTracker } from "../lib/oauth-tracker";

vi.mock("../integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), onAuthStateChange: vi.fn() } },
}));
vi.mock("../lib/api", () => ({ ApiError: class extends Error {}, api: { authorizeExisting: vi.fn() } }));

const session = { access_token: "test-access-token" } as Session;
let authEvent: (event: string, session: Session | null) => void;
let unsubscribe: () => void;
const callbacks = () => ({ enabled: true, onSuccess: vi.fn(), onNeedsCpf: vi.fn(), onError: vi.fn() });

describe("captive Google callback recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/oauth/callback");
    localStorage.setItem("mb_captive_params", JSON.stringify({ id: "001122334455", ap: "AABBCCDDEEFF", store: "povao" }));
    OAuthTracker.updateTokens("attempt", "capability");
    unsubscribe = vi.fn();
    vi.mocked(supabase.auth.onAuthStateChange).mockImplementation((cb) => {
      authEvent = cb as typeof authEvent;
      return { data: { subscription: { id: "test-subscription", callback: cb, unsubscribe } } };
    });
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null });
    vi.mocked(api.authorizeExisting).mockResolvedValue({ authorized: true });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("waits for first sign-in, restores the device, and authorizes only once", async () => {
    const handlers = callbacks();
    const { result } = renderHook(() => useOAuthCallback(handlers));
    expect(result.current.status).toBe("waiting");
    await act(async () => {
      authEvent("SIGNED_IN", session);
      authEvent("INITIAL_SESSION", session);
    });
    expect(api.authorizeExisting).toHaveBeenCalledTimes(1);
    expect(api.authorizeExisting).toHaveBeenCalledWith(expect.objectContaining({
      client_mac: "001122334455", ap_mac: "AABBCCDDEEFF", auth_method: "google",
      attempt_id: "attempt", resume_token: "capability",
    }));
    expect(handlers.onSuccess).toHaveBeenCalledTimes(1);
  });

  it.each(["pageshow", "focus"])("finds a persisted session after %s without a SIGNED_IN event", async (event) => {
    const handlers = callbacks();
    renderHook(() => useOAuthCallback(handlers));
    await act(async () => {});
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session }, error: null });
    await act(async () => { window.dispatchEvent(new Event(event)); });
    await waitFor(() => expect(handlers.onSuccess).toHaveBeenCalledTimes(1));
  });

  it("keeps the CPF gate before Wi-Fi success on a new Google profile", async () => {
    const profile = { full_name: "Test User", email: "user@example.com" };
    vi.mocked(api.authorizeExisting).mockResolvedValue({ needs_cpf: true, profile });
    const handlers = callbacks();
    renderHook(() => useOAuthCallback(handlers));
    await act(async () => { authEvent("SIGNED_IN", session); });
    expect(handlers.onNeedsCpf).toHaveBeenCalledWith(profile);
    expect(handlers.onSuccess).not.toHaveBeenCalled();
  });

  it.each(["?error=access_denied", "#error_code=disallowed_useragent"])("handles provider rejection immediately (%s)", (suffix) => {
    window.history.replaceState(null, "", `/oauth/callback${suffix}`);
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session }, error: null });
    const handlers = callbacks();
    renderHook(() => useOAuthCallback(handlers));
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining("entre com e-mail"));
    expect(api.authorizeExisting).not.toHaveBeenCalled();
  });

  it("ends a missing callback session with a bounded error, not an endless spinner", async () => {
    vi.useFakeTimers();
    vi.mocked(supabase.auth.getSession).mockRejectedValue(new Error("network unavailable"));
    const handlers = callbacks();
    renderHook(() => useOAuthCallback(handlers));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Tempo esgotado"));
    expect(api.authorizeExisting).not.toHaveBeenCalled();
  });

  it("removes resume listeners on unmount", async () => {
    const { unmount } = renderHook(() => useOAuthCallback(callbacks()));
    await act(async () => {});
    unmount();
    window.dispatchEvent(new Event("focus"));
    expect(supabase.auth.getSession).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
