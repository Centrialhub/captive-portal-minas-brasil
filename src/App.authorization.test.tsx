// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { BrowserRouter, MemoryRouter, Route, Routes } from "react-router-dom";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import { api, ApiError } from "./lib/api";
import { AttemptTracker } from "./lib/attempt-tracker";
import { supabase } from "./integrations/supabase/client";

vi.mock("./integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), verifyOtp: vi.fn() } },
}));
vi.mock("./lib/api", async importOriginal => {
  const original = await importOriginal<typeof import("./lib/api")>();
  return {
    ...original,
    api: { bootstrap: vi.fn(), identify: vi.fn(), authorizeExisting: vi.fn(), initAttempt: vi.fn(), attemptStatus: vi.fn(), clientEvent: vi.fn() },
  };
});

const capability = () => ({
  attempt_id: "be7928df-ade1-48cc-a3e9-4937c83c052b",
  token: "synthetic-capability",
  expires_at: new Date(Date.now() + 600000).toISOString(),
  server_now: new Date().toISOString(),
});
const pending = (delay = 1000) => ({
  authorized: false, processing: true, status: "verifying" as const,
  retry_after_ms: delay, deadline_at: new Date(Date.now() + 90000).toISOString(),
  session_id: "synthetic-session", operation_id: "synthetic-operation",
});
const success = () => ({
  authorized: true, processing: false, status: "confirmed" as const,
  session_id: "synthetic-session", redirect_url: "https://example.com/connected",
});
function renderPortal() { return render(<MemoryRouter><App /></MemoryRouter>); }
async function flush() { await act(async () => {}); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function identify() {
  fireEvent.change(screen.getByLabelText("Telefone"), { target: { value: "38999999999" } });
  fireEvent.change(screen.getByLabelText("CPF"), { target: { value: "52998224725" } });
  fireEvent.click(screen.getByRole("button", { name: "Liberar Wi-Fi" }));
  await flush();
}

describe("portal authorization lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    AttemptTracker.clear(true);
    sessionStorage.clear();
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:01&ap=02:00:00:00:00:11&ssid=Loja&t=1");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.mocked(api.bootstrap).mockResolvedValue({ store: { slug: "povao", name: "Povoão" }, consent: { version: "test", text: "Teste" } });
    vi.mocked(api.initAttempt).mockImplementation(async () => capability());
    vi.mocked(api.identify).mockResolvedValue(pending());
    vi.mocked(api.attemptStatus).mockResolvedValue(pending());
    vi.mocked(api.authorizeExisting).mockResolvedValue(pending());
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null });
    vi.mocked(supabase.auth.verifyOtp).mockResolvedValue({ data: { session: null, user: null }, error: null });
  });
  afterEach(() => {
    cleanup();
    AttemptTracker.clear(true);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("submits identity once and polls only status until the same operation confirms", async () => {
    vi.mocked(api.attemptStatus).mockResolvedValueOnce(pending()).mockResolvedValueOnce(success());
    renderPortal();
    await flush();
    await identify();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.attemptStatus).not.toHaveBeenCalled();
    await advance(1000);
    await advance(1000);
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
    expect(api.authorizeExisting).not.toHaveBeenCalled();
    expect(api.attemptStatus).toHaveBeenCalledTimes(2);
    expect(api.attemptStatus).toHaveBeenLastCalledWith({ attempt_id: capability().attempt_id, token: "synthetic-capability" });
    expect(AttemptTracker.get()?.confirmed_at).toBeTruthy();
    expect(api.clientEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "success_rendered", attempt_id: capability().attempt_id, resume_token: "synthetic-capability",
      payload: expect.not.objectContaining({ token: expect.anything(), resume_token: expect.anything() }),
    }));
  });

  it.each(["network", "timeout", "abort", "parse"] as const)("keeps the capability after %s and checks without repeating identity", async kind => {
    vi.mocked(api.identify).mockRejectedValue(new ApiError(kind, "ambiguous transport"));
    vi.mocked(api.attemptStatus).mockResolvedValue(success());
    renderPortal();
    await flush();
    await identify();
    expect(AttemptTracker.get()?.submitted).toBe(true);
    await advance(2000);
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("submits silent authorization once and then uses status only", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: { access_token: "synthetic-session-token" } }, error: null } as any);
    vi.mocked(api.attemptStatus).mockResolvedValue(success());
    renderPortal();
    await flush();
    expect(api.authorizeExisting).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(api.authorizeExisting).toHaveBeenCalledTimes(1);
    expect(api.identify).not.toHaveBeenCalled();
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
  });

  it("does not display an old context's success after the current connection changes", async () => {
    let finish!: (value: ReturnType<typeof success>) => void;
    vi.mocked(api.identify).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderPortal();
    await flush();
    await identify();
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:02&t=2");
    await act(async () => { finish(success()); });
    expect(screen.queryByRole("heading", { name: "Wi-Fi liberado!" })).toBeNull();
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    expect(AttemptTracker.get()).toBeNull();
  });

  it("resumes a pending first visit after remount without another form or auth session", async () => {
    const first = renderPortal();
    await flush();
    await identify();
    first.unmount();
    vi.mocked(api.attemptStatus).mockResolvedValue(success());
    vi.mocked(supabase.auth.getSession).mockClear();
    renderPortal();
    await flush();
    expect(api.attemptStatus).not.toHaveBeenCalled();
    await advance(1000); // The server's pending retry interval survives remount.
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
  });

  it("stops on awaiting_identity without looping or automatically resending", async () => {
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.markSubmitted(attempt.attempt_id);
    vi.mocked(api.attemptStatus).mockResolvedValue({ authorized: false, processing: false, status: "awaiting_identity" });
    renderPortal();
    await flush();
    await advance(20000);
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    expect(api.identify).not.toHaveBeenCalled();
    expect(AttemptTracker.get()?.submitted).toBe(false);
  });

  it("keeps captive context when reading the privacy policy and returning to identify", async () => {
    window.history.replaceState(null, "", window.location.search + "&resume_token=must-not-navigate&cpf=must-not-navigate");
    render(<BrowserRouter><Routes>
      <Route path="/politica-privacidade" element={<PrivacyPolicy />} />
      <Route path="*" element={<App />} />
    </Routes></BrowserRouter>);
    await flush();
    fireEvent.click(screen.getByRole("link", { name: "Política de Privacidade" }));
    await flush();
    expect(window.location.pathname).toBe("/politica-privacidade");
    expect(new URLSearchParams(window.location.search).get("id")).toBe("02:00:00:00:00:01");
    expect(window.location.search).not.toContain("must-not-navigate");
    fireEvent.click(screen.getByRole("link", { name: "Voltar ao portal" }));
    await flush();
    await identify();
    expect(api.initAttempt).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ id: "02:00:00:00:00:01", ap: "02:00:00:00:00:11", store: "povao", t: "1" }),
    }));
    expect(api.identify).toHaveBeenCalledTimes(1);
  });

  it("bounds initial session lookup and fences a late session response", async () => {
    let finish!: (value: any) => void;
    vi.mocked(supabase.auth.getSession).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderPortal();
    await advance(3000);
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    await identify();
    await act(async () => { finish({ data: { session: { access_token: "synthetic-session-token" } }, error: null }); });
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.authorizeExisting).not.toHaveBeenCalled();
  });

  it("renders Wi-Fi confirmed immediately even if session verification never resolves", async () => {
    vi.mocked(api.identify).mockResolvedValue({ ...success(), session_token_hash: "synthetic-otp-challenge" });
    vi.mocked(supabase.auth.verifyOtp).mockImplementation(() => new Promise(() => {}));
    renderPortal();
    await flush();
    await identify();
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Preparando para continuar..." }) as HTMLButtonElement).disabled).toBe(true);
    await advance(3000);
    expect((screen.getByRole("button", { name: "Continuar agora" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(api.clientEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "browser_session", status: "warning", payload: expect.objectContaining({ outcome: "timeout" }) }));
    expect(api.identify).toHaveBeenCalledTimes(1);
  });

  it("does not regress network success if verifyOtp rejects", async () => {
    vi.mocked(api.identify).mockResolvedValue({ ...success(), session_token_hash: "synthetic-otp-challenge" });
    vi.mocked(supabase.auth.verifyOtp).mockRejectedValue(new Error("auth service unavailable"));
    renderPortal();
    await flush();
    await identify();
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(AttemptTracker.get()?.confirmed_at).toBeTruthy();
  });

  it("shows init rate limiting and waits before allowing another explicit submission", async () => {
    vi.mocked(api.initAttempt).mockRejectedValueOnce(new ApiError("http", "Muitas tentativas. Aguarde.", 429, { retryAfterMs: 6000 }));
    renderPortal();
    await flush();
    await identify();
    expect(screen.getByRole("alert").textContent).toContain("Muitas tentativas");
    expect((screen.getByRole("button", { name: "Aguarde 6 s" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.identify).not.toHaveBeenCalled();
    await advance(6000);
    fireEvent.click(screen.getByRole("button", { name: "Liberar Wi-Fi" }));
    await flush();
    expect(api.initAttempt).toHaveBeenCalledTimes(2);
    expect(api.identify).toHaveBeenCalledTimes(1);
  });

  it.each([401, 410])("requires identification after status HTTP %s without creating another attempt", async status => {
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.markSubmitted(attempt.attempt_id);
    vi.mocked(api.attemptStatus).mockRejectedValue(new ApiError("http", "expired", status));
    renderPortal();
    await flush();
    await advance(20000);
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    expect(AttemptTracker.get()).toBeNull();
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    expect(api.identify).not.toHaveBeenCalled();
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("revalidates a confirmed receipt but does not auto redirect again", async () => {
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.markConfirmed(attempt.attempt_id);
    AttemptTracker.markRedirectAttempted(attempt.attempt_id);
    vi.mocked(api.attemptStatus).mockResolvedValue(success());
    renderPortal();
    await flush();
    await advance(10000);
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    expect(api.identify).not.toHaveBeenCalled();
    expect(api.authorizeExisting).not.toHaveBeenCalled();
    expect(api.clientEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: "redirect_started" }));
  });

  it("respects server retry delay during repeated online/visibility events", async () => {
    vi.mocked(api.identify).mockResolvedValue(pending(10000));
    vi.mocked(api.attemptStatus).mockResolvedValue(success());
    renderPortal();
    await flush();
    await identify();
    await advance(2000);
    for (let i = 0; i < 20; i++) {
      fireEvent(window, new Event("online"));
      fireEvent(document, new Event("visibilitychange"));
    }
    await advance(7999);
    expect(api.attemptStatus).not.toHaveBeenCalled();
    await advance(1);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    expect(api.identify).toHaveBeenCalledTimes(1);
  });

  it("preserves the operation and respects Retry-After when status itself is throttled", async () => {
    vi.mocked(api.attemptStatus)
      .mockRejectedValueOnce(new ApiError("http", "Aguarde a próxima consulta.", 429, { retryAfterMs: 5000 }))
      .mockResolvedValueOnce(success());
    renderPortal();
    await flush();
    await identify();
    await advance(1000);
    expect(AttemptTracker.get()?.submitted).toBe(true);
    fireEvent(window, new Event("online"));
    await advance(4999);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.attemptStatus).toHaveBeenCalledTimes(2);
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
  });

  it("requires an explicit restart after the unknown-expiry cooldown and never loops on the terminal operation", async () => {
    vi.mocked(api.identify).mockResolvedValueOnce({ authorized: false, processing: false, status: "expired_unconfirmed", fail_reason: "AUTHORIZATION_UNCONFIRMED", retry_after_ms: 30000 });
    renderPortal();
    await flush();
    await identify();
    expect(screen.getByRole("heading", { name: "Acesso ainda não confirmado" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Aguarde 30 s" }) as HTMLButtonElement).disabled).toBe(true);
    await advance(30000);
    expect(api.attemptStatus).not.toHaveBeenCalled();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Tentar nova liberação" }));
    await flush();
    expect(AttemptTracker.get()).toBeNull();
    await identify();
    expect(api.initAttempt).toHaveBeenCalledTimes(2);
    expect(api.identify).toHaveBeenCalledTimes(2);
  });
});
