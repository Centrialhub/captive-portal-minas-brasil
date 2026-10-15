// @vitest-environment jsdom

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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const serverTime = Date.parse("2026-09-25T20:00:00Z");
const originalQuery = "/?store=povao&id=02:00:00:00:00:01&ap=02:00:00:00:00:11&ssid=Loja&t=1";
const capability = (ttl = 600000) => ({
  attempt_id: "7f2290ec-c69c-4f7c-b235-0489b91b4011", token: "synthetic-resilience-token",
  expires_at: new Date(Date.now() + ttl).toISOString(), server_now: new Date().toISOString(),
});
const pending = (delay = 1000) => ({
  authorized: false, processing: true, status: "verifying" as const, retry_after_ms: delay,
  deadline_at: new Date(Date.now() + 90000).toISOString(), server_now: new Date().toISOString(),
});
const confirmed = () => ({
  authorized: true, processing: false, status: "confirmed" as const,
  redirect_url: "https://example.test/connected", session_id: "synthetic-session",
  server_now: new Date().toISOString(),
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

describe("second-round frontend resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(serverTime);
    vi.resetAllMocks();
    AttemptTracker.clear(true);
    sessionStorage.clear();
    window.history.replaceState(null, "", originalQuery);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.mocked(api.bootstrap).mockResolvedValue({ store: { slug: "povao", name: "Unidade sintética" }, consent: { version: "test", text: "Teste" } });
    vi.mocked(api.initAttempt).mockImplementation(async () => capability());
    vi.mocked(api.identify).mockResolvedValue(pending());
    vi.mocked(api.authorizeExisting).mockResolvedValue(pending());
    vi.mocked(api.attemptStatus).mockResolvedValue(pending());
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null });
    vi.mocked(supabase.auth.verifyOtp).mockResolvedValue({ data: { session: null, user: null }, error: null });
    replaceLocationWith(vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    AttemptTracker.clear(true);
    vi.useRealTimers();
  });

  it("AUD2-F01: does not start a resume read offline when a previously scheduled pageshow timer becomes due", async () => {
    vi.mocked(api.identify).mockResolvedValue(pending(10000));
    renderPortal();
    await flush();
    await identify();
    await advance(1000);
    fireEvent(window, new Event("pageshow"));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await advance(9000);
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.attemptStatus).not.toHaveBeenCalled();
  });

  it("AUD2-F01: does not issue status reads for foreground events while the device is offline", async () => {
    renderPortal();
    await flush();
    await identify();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await advance(1000);
    for (let i = 0; i < 3; i++) {
      fireEvent(document, new Event("visibilitychange"));
      await flush();
      await advance(1000);
    }
    expect(api.attemptStatus).not.toHaveBeenCalled();
    expect(api.identify).toHaveBeenCalledTimes(1);
  });

  it("AUD2-F01: an offline resume must not occupy the request lock when the network returns", async () => {
    const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
    const requests: { online: boolean; at: number }[] = [];
    class OfflineHangingXHR {
      timeout = 0;
      status = 200;
      responseText = "";
      ontimeout?: () => void;
      onload?: () => void;
      open() {}
      setRequestHeader() {}
      getResponseHeader() { return null; }
      send() {
        requests.push({ online: navigator.onLine, at: performance.now() });
        if (navigator.onLine) {
          this.responseText = JSON.stringify(confirmed());
          this.onload?.();
        } else {
          setTimeout(() => this.ontimeout?.(), this.timeout);
        }
      }
    }
    vi.stubGlobal("XMLHttpRequest", OfflineHangingXHR);
    vi.mocked(api.attemptStatus).mockImplementation(actual.api.attemptStatus);
    renderPortal();
    await flush();
    await identify();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await advance(1000);
    fireEvent(window, new Event("pageshow"));
    await flush();
    await advance(100);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    fireEvent(window, new Event("online"));
    await flush();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect.soft(screen.queryByRole("heading", { name: "Wi-Fi liberado!" })).not.toBeNull();
    // Let the known-bounded transport finish to measure recovery, not a hang.
    await advance(22000);
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(requests.filter(request => !request.online)).toHaveLength(0);
  });

  it("recovers a committed identify after the real XHR times out and ignores the late successful response", async () => {
    const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
    let backendCommitted = false;
    let lateResponses = 0;
    class CommitThenTimeoutXHR {
      timeout = 0;
      status = 200;
      responseText = "";
      ontimeout?: () => void;
      onload?: () => void;
      open() {}
      setRequestHeader() {}
      getResponseHeader() { return null; }
      send() {
        setTimeout(() => { backendCommitted = true; }, 24000);
        setTimeout(() => this.ontimeout?.(), this.timeout);
        setTimeout(() => { lateResponses += 1; this.responseText = JSON.stringify(confirmed()); this.onload?.(); }, 30000);
      }
    }
    vi.stubGlobal("XMLHttpRequest", CommitThenTimeoutXHR);
    vi.mocked(api.identify).mockImplementation(actual.api.identify);
    vi.mocked(api.attemptStatus).mockImplementation(async () => backendCommitted ? confirmed() : pending());
    renderPortal();
    await flush();
    await identify();
    await advance(25000);
    expect(screen.getByText("Ainda não recebemos a confirmação. Sua tentativa foi preservada.")).toBeTruthy();
    await advance(2000);
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    await advance(4000);
    expect(lateResponses).toBe(1);
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
  });

  it("does not authorize on a late identify success after its capability expired during transport", async () => {
    vi.mocked(api.initAttempt).mockImplementation(async () => capability(3000));
    const response = deferred<ReturnType<typeof confirmed>>();
    vi.mocked(api.identify).mockReturnValue(response.promise);
    renderPortal();
    await flush();
    await identify();
    await advance(3001);
    await act(async () => { response.resolve(confirmed()); });
    expect(screen.queryByRole("heading", { name: "Wi-Fi liberado!" })).toBeNull();
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
    expect(AttemptTracker.get()).toBeNull();
  });

  it.each([
    ["same MAC, different store", "/?store=synthetic-other&id=02:00:00:00:00:01&ap=02:00:00:00:00:11&ssid=Loja&t=1"],
    ["different MAC, same store", "/?store=povao&id=02:00:00:00:00:02&ap=02:00:00:00:00:11&ssid=Loja&t=1"],
  ])("fences identify success after the context changes: %s", async (_label, nextQuery) => {
    const response = deferred<ReturnType<typeof confirmed>>();
    vi.mocked(api.identify).mockReturnValue(response.promise);
    renderPortal();
    await flush();
    await identify();
    window.history.replaceState(null, "", nextQuery);
    await act(async () => { response.resolve(confirmed()); });
    expect(screen.queryByRole("heading", { name: "Wi-Fi liberado!" })).toBeNull();
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    expect(AttemptTracker.get()).toBeNull();
    expect(api.identify).toHaveBeenCalledTimes(1);
  });

  it.each(["<html>synthetic proxy error</html>", '{"authorized":true,"status":"rejected"}', '{"authorized":true,"server_now":"invalid"}'])("preserves prior confirmation through malformed protected status: %s", async responseText => {
      const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
      class InvalidResponseXHR {
        timeout = 0;
        status = 200;
        responseText = responseText;
        onload?: () => void;
        open() {}
        setRequestHeader() {}
        getResponseHeader() { return null; }
        send() { this.onload?.(); }
      }
      vi.stubGlobal("XMLHttpRequest", InvalidResponseXHR);
      vi.mocked(api.identify).mockResolvedValue(confirmed());
      vi.mocked(api.attemptStatus).mockImplementation(actual.api.attemptStatus);
      renderPortal();
      await flush();
      await identify();
      const attemptId = AttemptTracker.get()?.attempt_id;
      await advance(1000);
      fireEvent(window, new Event("pageshow"));
      await flush();
      expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
      expect(AttemptTracker.get()?.attempt_id).toBe(attemptId);
      expect(api.identify).toHaveBeenCalledTimes(1);
      expect(api.clientEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "request_interrupted", payload: expect.objectContaining({ kind: "parse" }) }));
    });

  it("recovers after hidden offline time crosses the local watch budget without repeating identity", async () => {
    renderPortal();
    await flush();
    await identify();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await advance(130000);
    expect(api.attemptStatus).not.toHaveBeenCalled();
    vi.mocked(api.attemptStatus).mockResolvedValue(confirmed());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    fireEvent(window, new Event("online"));
    await flush();
    expect(screen.getByRole("heading", { name: "Wi-Fi liberado!" })).toBeTruthy();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("requires new identity when restored server capability returns 410 while browser time has not expired", async () => {
    renderPortal();
    await flush();
    await identify();
    vi.mocked(api.attemptStatus).mockRejectedValue(new ApiError("http", "expired", 410, { code: "attempt_expired" }));
    await advance(1000);
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    expect(AttemptTracker.get()).toBeNull();
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not submit again automatically when timeout recovery sees awaiting_identity before an old backend response commits", async () => {
    vi.mocked(api.identify).mockRejectedValue(new ApiError("timeout", "synthetic timeout"));
    vi.mocked(api.attemptStatus).mockResolvedValue({ authorized: false, processing: false, status: "awaiting_identity" });
    renderPortal();
    await flush();
    await identify();
    await advance(2000);
    expect(screen.getByLabelText("CPF")).toBeTruthy();
    expect(AttemptTracker.get()?.submitted).toBe(false);
    await advance(60000);
    expect(api.identify).toHaveBeenCalledTimes(1);
    expect(api.attemptStatus).toHaveBeenCalledTimes(1);
  });
});
