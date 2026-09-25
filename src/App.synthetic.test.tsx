// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import { api, ApiError } from "./lib/api";
import { AttemptTracker } from "./lib/attempt-tracker";
import { supabase } from "./integrations/supabase/client";

vi.mock("./integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), verifyOtp: vi.fn() } },
}));
vi.mock("./lib/api", async importOriginal => ({
  ...await importOriginal<typeof import("./lib/api")>(),
  api: { bootstrap: vi.fn(), identify: vi.fn(), authorizeExisting: vi.fn(), initAttempt: vi.fn(), attemptStatus: vi.fn(), clientEvent: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const serverTime = Date.parse("2026-09-25T18:00:00Z");
const capability = (ttl = 600000) => ({
  attempt_id: "52870b9b-d690-48fa-835e-232fa17cda00",
  token: "synthetic-capability-00000000000000",
  expires_at: new Date(Date.now() + ttl).toISOString(),
  server_now: new Date().toISOString(),
});
const pending = (delay = 1000) => ({
  authorized: false, processing: true, status: "verifying" as const,
  retry_after_ms: delay, deadline_at: new Date(Date.now() + 90000).toISOString(),
});
const confirmed = () => ({
  authorized: true, processing: false, status: "confirmed" as const,
  redirect_url: "https://example.test/connected", session_id: "synthetic-session",
});
function renderPortal(strict = false) {
  const view = <MemoryRouter><App /></MemoryRouter>;
  return render(strict ? <StrictMode>{view}</StrictMode> : view);
}
async function flush() { await act(async () => {}); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function identify() {
  fireEvent.change(screen.getByLabelText("Telefone"), { target: { value: "38999999999" } });
  fireEvent.change(screen.getByLabelText("CPF"), { target: { value: "52998224725" } });
  fireEvent.click(screen.getByRole("button", { name: "Liberar Wi-Fi" }));
  await flush();
}
async function seedSubmitted() {
  const attempt = await AttemptTracker.ensureAttempt();
  AttemptTracker.markSubmitted(attempt.attempt_id);
  return attempt;
}
function replaceLocationWith(spy: (url: string | URL) => void) {
  const originalWindow = window;
  const location = new Proxy({} as Location, {
    get(_target, property) {
      if (property === "replace") return spy;
      const value = Reflect.get(originalWindow.location, property, originalWindow.location);
      return typeof value === "function" ? value.bind(originalWindow.location) : value;
    },
  });
  vi.stubGlobal("window", new Proxy(originalWindow, {
    get(target, property) { return property === "location" ? location : Reflect.get(target, property, target); },
  }));
}

describe("synthetic frontend boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(serverTime);
    vi.resetAllMocks();
    AttemptTracker.clear(true);
    sessionStorage.clear();
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:01&ap=02:00:00:00:00:11&ssid=Loja&t=1");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.mocked(api.bootstrap).mockResolvedValue({ store: { slug: "povao", name: "Unidade sintética" }, consent: { version: "test", text: "Teste" } });
    vi.mocked(api.initAttempt).mockImplementation(async () => capability());
    vi.mocked(api.identify).mockResolvedValue(pending());
    vi.mocked(api.authorizeExisting).mockResolvedValue(pending());
    vi.mocked(api.attemptStatus).mockResolvedValue(pending());
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null });
    vi.mocked(supabase.auth.verifyOtp).mockResolvedValue({ data: { session: null, user: null }, error: null });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    AttemptTracker.clear(true);
    vi.useRealTimers();
  });

  it("SYN-F01: StrictMode resumes a stored operation after effect cleanup invalidates its first response", async () => {
    replaceLocationWith(vi.fn());
    await seedSubmitted();
    vi.mocked(api.attemptStatus).mockResolvedValue(confirmed());
    renderPortal(true);
    await flush();
    await advance(30000);
    expect(api.identify).not.toHaveBeenCalled();
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Wi-Fi liberado!" })).not.toBeNull();
  });

  it("keeps a new StrictMode request locked when the invalidated request finishes first", async () => {
    await seedSubmitted();
    const old = deferred<ReturnType<typeof confirmed>>();
    const current = deferred<ReturnType<typeof confirmed>>();
    vi.mocked(api.attemptStatus).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    renderPortal(true);
    await flush();
    expect(api.attemptStatus).toHaveBeenCalledTimes(2);
    await act(async () => { old.resolve(confirmed()); });
    for (let i = 0; i < 20; i++) fireEvent(window, new Event("online"));
    await flush();
    expect(api.attemptStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("heading", { name: "Wi-Fi liberado!" })).toBeNull();
    await act(async () => { current.resolve(confirmed()); });
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
  });

  it("keeps the new mount authoritative when the unmounted page's request resolves later", async () => {
    await seedSubmitted();
    const oldRequest = deferred<ReturnType<typeof confirmed>>();
    vi.mocked(api.attemptStatus).mockReturnValueOnce(oldRequest.promise).mockResolvedValue(pending(10000));
    const first = renderPortal();
    await flush();
    first.unmount();
    renderPortal();
    await flush();
    await act(async () => { oldRequest.resolve(confirmed()); });
    expect(screen.queryByRole("heading", { name: "Wi-Fi liberado!" })).toBeNull();
    expect(screen.getByRole("button", { name: "Aguarde 10 s" })).toBeTruthy();
    expect(AttemptTracker.get()?.confirmed_at).toBeUndefined();
    expect(api.attemptStatus).toHaveBeenCalledTimes(2);
  });

  it("fences a status confirmation after the AP/visit changes while the request is in flight", async () => {
    await seedSubmitted();
    const response = deferred<ReturnType<typeof confirmed>>();
    vi.mocked(api.attemptStatus).mockReturnValue(response.promise);
    renderPortal();
    await flush();
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:01&ap=02:00:00:00:00:22&t=2");
    await act(async () => { response.resolve(confirmed()); });
    expect(screen.queryByRole("heading", { name: "Wi-Fi liberado!" })).toBeNull();
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    expect(AttemptTracker.get()).toBeNull();
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("rejects a delayed confirmation after local capability expiry without automatically initializing again", async () => {
    vi.mocked(api.initAttempt).mockImplementation(async () => capability(5000));
    await seedSubmitted();
    const response = deferred<ReturnType<typeof confirmed>>();
    vi.mocked(api.attemptStatus).mockReturnValue(response.promise);
    renderPortal();
    await flush();
    await advance(5001);
    await act(async () => { response.resolve(confirmed()); });
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    expect(AttemptTracker.get()).toBeNull();
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
    expect(api.identify).not.toHaveBeenCalled();
  });

  it("SYN-F02: accepts a current server confirmation when the device clock is twenty minutes fast", async () => {
    const serverCapability = capability();
    vi.setSystemTime(serverTime + 20 * 60000);
    vi.mocked(api.initAttempt).mockResolvedValue(serverCapability);
    vi.mocked(api.identify).mockResolvedValue(confirmed());
    renderPortal();
    await flush();
    await identify();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Wi-Fi liberado!" })).not.toBeNull();
  });

  it("coalesces one hundred resume events while a status request remains in flight", async () => {
    await seedSubmitted();
    const response = deferred<ReturnType<typeof pending>>();
    vi.mocked(api.attemptStatus).mockReturnValue(response.promise);
    renderPortal();
    await flush();
    for (let i = 0; i < 100; i++) {
      fireEvent(window, new Event("online"));
      fireEvent(window, new Event("pageshow"));
      fireEvent(document, new Event("visibilitychange"));
    }
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    await act(async () => { response.resolve(pending(10000)); });
    await advance(9999);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
  });

  it("SYN-F03: bounds completed status reads during a short storm after confirmation", async () => {
    await seedSubmitted();
    AttemptTracker.markRedirectAttempted(capability().attempt_id);
    vi.mocked(api.attemptStatus).mockResolvedValue(confirmed());
    renderPortal();
    await flush();
    for (let i = 0; i < 20; i++) {
      fireEvent(document, new Event("visibilitychange"));
      await flush();
      await advance(10);
    }
    expect(api.identify).not.toHaveBeenCalled();
    expect(vi.mocked(api.attemptStatus).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("SYN-F03b: successful revalidation does not keep postponing the existing redirect deadline", async () => {
    const replace = vi.fn();
    replaceLocationWith(replace);
    vi.mocked(api.identify).mockResolvedValue(confirmed());
    vi.mocked(api.attemptStatus).mockResolvedValue(confirmed());
    renderPortal();
    await flush();
    await identify();
    for (let i = 0; i < 5; i++) {
      await advance(800);
      fireEvent(document, new Event("visibilitychange"));
      await flush();
    }
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("removes success and cancels redirect when protected revalidation returns expired", async () => {
    const replace = vi.fn();
    replaceLocationWith(replace);
    vi.mocked(api.identify).mockResolvedValue(confirmed());
    vi.mocked(api.attemptStatus).mockRejectedValue(new ApiError("http", "expired", 410));
    renderPortal();
    await flush();
    await identify();
    await advance(1000);
    fireEvent(window, new Event("pageshow"));
    await flush();
    await advance(5000);
    expect(screen.queryByRole("heading", { name: "Wi-Fi liberado!" })).toBeNull();
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(AttemptTracker.get()).toBeNull();
    expect(api.identify).toHaveBeenCalledTimes(1);
  });

  it("checks a restored legacy capability before continuing an explicit identity submission", async () => {
    const attempt = await AttemptTracker.ensureAttempt();
    const originalPerformance = performance;
    vi.stubGlobal("performance", { timeOrigin: originalPerformance.timeOrigin + 10000, now: () => originalPerformance.now() });
    vi.mocked(api.attemptStatus).mockResolvedValue({ authorized: false, processing: false, status: "awaiting_identity" });
    renderPortal();
    await flush();
    expect(AttemptTracker.get()?.requires_verification).toBe(true);
    await identify();
    expect(api.attemptStatus).toHaveBeenCalledTimes(2);
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.identify).toHaveBeenCalledWith(expect.objectContaining({ attempt_id: attempt.attempt_id }));
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("SYN-F05: a synchronously blocked navigation eventually restores the continue button", async () => {
    const blocked = new DOMException("Synthetic navigation denied", "SecurityError");
    const replace = vi.fn<() => void>(() => { throw blocked; });
    replaceLocationWith(replace);
    vi.mocked(api.identify).mockResolvedValue(confirmed());
    renderPortal();
    await flush();
    await identify();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(replace).toHaveBeenCalledTimes(1);
    await advance(5000);
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continuar agora" }) as HTMLButtonElement).disabled).toBe(false);
    replace.mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Continuar agora" }));
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it("does not leak redirect timers across unmount and only navigates once after remount", async () => {
    const replace = vi.fn();
    replaceLocationWith(replace);
    vi.mocked(api.identify).mockResolvedValue(confirmed());
    vi.mocked(api.attemptStatus).mockResolvedValue(confirmed());
    const first = renderPortal();
    await flush();
    await identify();
    await advance(1500);
    first.unmount();
    await advance(5000);
    expect(replace).not.toHaveBeenCalled();
    const second = renderPortal();
    await flush();
    await advance(2000);
    expect(replace).toHaveBeenCalledTimes(1);
    second.unmount();
    renderPortal();
    await flush();
    await advance(10000);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(AttemptTracker.get()?.redirect_attempted).toBe(true);
  });

  it("keeps recovery operational in App when storage is denied, including page remount", async () => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error("synthetic storage denial"); });
    }
    vi.mocked(api.identify).mockRejectedValue(new ApiError("timeout", "synthetic transport timeout"));
    vi.mocked(api.attemptStatus).mockResolvedValue(confirmed());
    const first = renderPortal();
    await flush();
    await identify();
    first.unmount();
    renderPortal();
    await flush();
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("SYN-F04: preserves an init Retry-After across remount before silent login can create another capability", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: { access_token: "synthetic-session-token" } }, error: null } as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(api.initAttempt).mockRejectedValue(new ApiError("http", "Aguarde", 429, { retryAfterMs: 30000 }));
    const first = renderPortal();
    await flush();
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Aguarde 30 s" }) as HTMLButtonElement).disabled).toBe(true);
    first.unmount();
    renderPortal();
    await flush();
    await advance(5000);
    expect(api.authorizeExisting).not.toHaveBeenCalled();
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not poll while offline and resumes the existing operation once the network returns", async () => {
    vi.mocked(api.identify).mockResolvedValue(pending(1000));
    vi.mocked(api.attemptStatus).mockResolvedValue(confirmed());
    renderPortal();
    await flush();
    await identify();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await advance(30000);
    expect(api.attemptStatus).not.toHaveBeenCalled();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    fireEvent(window, new Event("online"));
    await flush();
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
  });

  it("retains status-only recovery when the real XHR adapter reaches its twenty-second deadline", async () => {
    const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
    const timeouts: number[] = [];
    class TimeoutXHR {
      timeout = 0;
      ontimeout?: () => void;
      open() {}
      setRequestHeader() {}
      send() { timeouts.push(this.timeout); setTimeout(() => this.ontimeout?.(), this.timeout); }
    }
    vi.stubGlobal("XMLHttpRequest", TimeoutXHR);
    vi.mocked(api.attemptStatus).mockImplementation(actual.api.attemptStatus);
    renderPortal();
    await flush();
    await identify();
    await advance(1000);
    expect(timeouts).toEqual([20000]);
    expect((screen.getByRole("button", { name: "Verificando..." }) as HTMLButtonElement).disabled).toBe(true);
    await advance(20000);
    expect(screen.getByText("Ainda não recebemos a confirmação. Sua tentativa foi preservada.")).toBeTruthy();
    expect(AttemptTracker.get()?.submitted).toBe(true);
    expect(api.identify).toHaveBeenCalledTimes(1);
    await advance(2000);
    expect(timeouts).toEqual([20000, 20000]);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });
});
