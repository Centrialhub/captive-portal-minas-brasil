// @vitest-environment jsdom
import { createElement } from "react";
import { BrowserRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./lib/api";
import { supabase } from "./integrations/supabase/client";

vi.mock("./lib/api", () => ({
  ApiError: class extends Error {},
  api: {
    bootstrap: vi.fn(), initOAuth: vi.fn(), clientEvent: vi.fn(),
    createOAuthHandoff: vi.fn(), claimOAuthHandoff: vi.fn(),
  },
}));
vi.mock("./integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithOAuth: vi.fn() } },
}));
vi.mock("./hooks/useOAuthCallback", () => ({ useOAuthCallback: () => ({ status: "idle" }) }));

describe("Google OAuth inside the captive window", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/?id=001122334455&ap=AABBCCDDEEFF&store=povao");
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.mocked(api.bootstrap).mockResolvedValue({ store: { slug: "povao", name: "Povão" } });
    vi.mocked(api.initOAuth).mockResolvedValue({ attempt_id: "attempt", token: "capability" });
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null });
    vi.mocked(supabase.auth.signInWithOAuth).mockResolvedValue({
      data: { provider: "google", url: "https://accounts.google.com/" }, error: null,
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const renderPortal = () => render(createElement(BrowserRouter, null, createElement(App)));

  it.each([
    ["Android captive", "Mozilla/5.0 (Linux; Android 14; wv) Version/4.0 Chrome/125 Mobile Safari/537.36"],
    ["iOS captive", "CaptiveNetworkSupport-443.40.1 wispr"],
    ["Chrome", "Mozilla/5.0 (Linux; Android 14) Chrome/125 Mobile Safari/537.36"],
  ])("uses a same-window provider redirect in %s", async (_name, userAgent) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    const open = vi.spyOn(window, "open");
    renderPortal();
    fireEvent.click(await screen.findByRole("button", { name: "Continuar com Google" }));
    await waitFor(() => expect(supabase.auth.signInWithOAuth).toHaveBeenCalledExactlyOnceWith({
      provider: "google",
      options: { redirectTo: "https://minasbrasilwifi.com.br/oauth/callback", skipBrowserRedirect: false },
    }));
    expect(api.createOAuthHandoff).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByText("Continue no navegador")).toBeNull();
    expect(localStorage.getItem("mb_oauth_attempt_token")).toBe("capability");
    expect(window.location.search).not.toContain("capability");
  });

  it("does not start Google without a server-authoritative attempt", async () => {
    vi.mocked(api.initOAuth).mockRejectedValue(new Error("network unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderPortal();
    fireEvent.click(await screen.findByRole("button", { name: "Continuar com Google" }));
    await screen.findByText("Não foi possível preparar o ambiente para login com Google.");
    expect(supabase.auth.signInWithOAuth).not.toHaveBeenCalled();
  });

  it("re-enables login when Back restores the captive from bfcache", async () => {
    renderPortal();
    fireEvent.click(await screen.findByRole("button", { name: "Continuar com Google" }));
    await waitFor(() => expect(supabase.auth.signInWithOAuth).toHaveBeenCalledTimes(1));
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
    const button = await screen.findByRole("button", { name: "Continuar com Google" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(supabase.auth.signInWithOAuth).toHaveBeenCalledTimes(2));
  });

  it("claims an old continuation link inside Android without an external-browser loop", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android 14; wv Version/4.0");
    window.history.replaceState(null, "", "/oauth/continue?handoff=one-time-code");
    vi.mocked(api.claimOAuthHandoff).mockResolvedValue({
      attempt_id: "restored", token: "secret", params: { id: "001122334455", ap: "AABBCCDDEEFF" },
    });
    renderPortal();
    await waitFor(() => expect(supabase.auth.signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(api.claimOAuthHandoff).toHaveBeenCalledExactlyOnceWith({ handoff: "one-time-code" });
    expect(window.location.search).toBe("");
    expect(screen.queryByText("Continue no navegador")).toBeNull();
  });
});
