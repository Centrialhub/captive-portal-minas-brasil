// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { AttemptTracker } from "./attempt-tracker";

const capability = (id: string) => ({
  attempt_id: "synthetic-" + id, token: "synthetic-token-" + id,
  expires_at: new Date(Date.now() + 600000).toISOString(),
  server_now: new Date().toISOString(),
});
function deferred() {
  let resolve!: (value: ReturnType<typeof capability>) => void;
  const promise = new Promise<ReturnType<typeof capability>>(done => { resolve = done; });
  return { promise, resolve };
}

describe("synthetic attempt tracker concurrency", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    AttemptTracker.clear(true);
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:01&ap=02:00:00:00:00:11&t=1");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); AttemptTracker.clear(true); });

  it("uses elapsed monotonic time for expiry despite forward and backward wall-clock corrections", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "initAttempt").mockResolvedValue(capability("clock"));
    const attempt = await AttemptTracker.ensureAttempt();
    vi.setSystemTime(Date.now() + 1200000);
    expect(AttemptTracker.get()?.attempt_id).toBe(attempt.attempt_id);
    vi.setSystemTime(Date.now() - 2400000);
    expect(AttemptTracker.get()?.attempt_id).toBe(attempt.attempt_id);
    await vi.advanceTimersByTimeAsync(600001);
    expect(AttemptTracker.get()).toBeNull();
  });

  it("reanchors only the server's remaining lifetime after a new document, never another ten minutes", async () => {
    vi.useFakeTimers();
    const initial = capability("restore");
    vi.spyOn(api, "initAttempt").mockResolvedValue(initial);
    const attempt = await AttemptTracker.ensureAttempt();
    await vi.advanceTimersByTimeAsync(180000);
    const originalPerformance = performance;
    vi.stubGlobal("performance", { timeOrigin: originalPerformance.timeOrigin + 180000, now: () => originalPerformance.now() });
    vi.resetModules();
    const { AttemptTracker: restored } = await import("./attempt-tracker");
    expect(restored.get()?.requires_verification).toBe(true);
    expect(restored.get()?.expires_at).toBe(initial.expires_at);
    restored.validateFromServer(attempt.attempt_id, new Date(Date.parse(initial.server_now) + 180000).toISOString());
    expect(restored.get()?.requires_verification).toBe(false);
    expect(restored.get()!.expires_monotonic_ms! - performance.now()).toBe(420000);
    await vi.advanceTimersByTimeAsync(420000);
    expect(restored.get()).toBeNull();
  });

  it("does not renew expiry on a legacy status response that has no server clock", async () => {
    vi.spyOn(api, "initAttempt").mockResolvedValue(capability("legacy"));
    const attempt = await AttemptTracker.ensureAttempt();
    const originalDeadline = attempt.expires_monotonic_ms;
    const originalPerformance = performance;
    vi.stubGlobal("performance", { timeOrigin: originalPerformance.timeOrigin + 180000, now: () => originalPerformance.now() });
    AttemptTracker.validateFromServer(attempt.attempt_id);
    expect(AttemptTracker.get()).toMatchObject({ expires_monotonic_ms: originalDeadline, requires_verification: true, expires_at: attempt.expires_at });
  });

  it("restores the saved cooldown remainder in a new document without using the client's clock", async () => {
    vi.useFakeTimers();
    AttemptTracker.deferInitialization(30000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(AttemptTracker.cooldownRemaining()).toBe(25000);
    const originalPerformance = performance;
    vi.stubGlobal("performance", { timeOrigin: originalPerformance.timeOrigin + 60000, now: () => originalPerformance.now() });
    vi.setSystemTime(Date.now() + 86400000);
    vi.resetModules();
    const { AttemptTracker: restored } = await import("./attempt-tracker");
    expect(restored.cooldownRemaining()).toBe(25000);
    await expect(restored.ensureAttempt()).rejects.toMatchObject({ status: 429, retryAfterMs: 25000 });
    await vi.advanceTimersByTimeAsync(25000);
    expect(restored.cooldownRemaining()).toBe(0);
  });

  it("isolates cooldowns by context and retains the earlier context's delay on return", () => {
    vi.useFakeTimers();
    const originalUrl = window.location.href;
    AttemptTracker.deferInitialization(30000);
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:02&t=2");
    expect(AttemptTracker.cooldownRemaining()).toBe(0);
    AttemptTracker.deferInitialization(10000);
    window.history.replaceState(null, "", originalUrl);
    expect(AttemptTracker.cooldownRemaining()).toBe(30000);
  });

  it("preserves the new context's capability when two initialization responses arrive out of order", async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    vi.spyOn(api, "initAttempt").mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const oldAttempt = AttemptTracker.ensureAttempt();
    const oldRejected = expect(oldAttempt).rejects.toMatchObject({ kind: "abort" });
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:02&ap=02:00:00:00:00:22&t=2");
    const newAttempt = AttemptTracker.ensureAttempt();
    newRequest.resolve(capability("new"));
    expect((await newAttempt).attempt_id).toBe("synthetic-new");
    oldRequest.resolve(capability("old"));
    await oldRejected;
    expect(AttemptTracker.get()?.attempt_id).toBe("synthetic-new");
    expect(await AttemptTracker.ensureAttempt()).toEqual(await newAttempt);
    expect(api.initAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect an old same-context initialization after explicit clear and replacement", async () => {
    const oldRequest = deferred();
    vi.spyOn(api, "initAttempt").mockReturnValueOnce(oldRequest.promise).mockResolvedValue(capability("replacement"));
    const oldAttempt = AttemptTracker.ensureAttempt();
    const oldRejected = expect(oldAttempt).rejects.toMatchObject({ kind: "abort" });
    AttemptTracker.clear();
    const replacement = await AttemptTracker.ensureAttempt();
    oldRequest.resolve(capability("cleared"));
    await oldRejected;
    expect(AttemptTracker.get()).toEqual(replacement);
    expect(AttemptTracker.get()?.attempt_id).toBe("synthetic-replacement");
  });

  it("keeps a pending in-memory capability when storage starts failing after initialization", async () => {
    vi.spyOn(api, "initAttempt").mockResolvedValue(capability("memory"));
    const attempt = await AttemptTracker.ensureAttempt();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("synthetic quota exceeded"); });
    AttemptTracker.markSubmitted(attempt.attempt_id);
    expect(AttemptTracker.get()?.submitted).toBe(true);
    expect(await AttemptTracker.ensureAttempt()).toMatchObject({ attempt_id: attempt.attempt_id, submitted: true });
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });
});
