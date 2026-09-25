// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { AttemptTracker } from "./attempt-tracker";

const capability = (suffix = "1") => ({
  attempt_id: "synthetic-" + suffix,
  token: "test-capability-" + suffix,
  expires_at: new Date(Date.now() + 600000).toISOString(),
});

describe("captive attempt tracking", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    AttemptTracker.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/?id=02:00:00:00:00:01&ap=02:00:00:00:00:11&ssid=Loja&t=1");
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); AttemptTracker.clear(); });

  it("deduplicates simultaneous initialization and keeps its server expiry", async () => {
    let finish!: (value: ReturnType<typeof capability>) => void;
    const init = vi.spyOn(api, "initAttempt").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = AttemptTracker.ensureAttempt();
    const second = AttemptTracker.ensureAttempt();
    expect(init).toHaveBeenCalledTimes(1);
    const value = capability();
    finish(value);
    expect(await first).toMatchObject({ ...value, submitted: false, version: 2 });
    expect(await second).toEqual(await first);
    expect(await AttemptTracker.ensureAttempt()).toEqual(await first);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("retains confirmed receipts for server revalidation and prevents repeated auto redirect", async () => {
    vi.spyOn(api, "initAttempt").mockResolvedValue(capability());
    const current = await AttemptTracker.ensureAttempt();
    AttemptTracker.markSubmitted(current.attempt_id);
    AttemptTracker.markConfirmed(current.attempt_id);
    AttemptTracker.markRedirectAttempted(current.attempt_id);
    expect(AttemptTracker.get()).toMatchObject({ attempt_id: current.attempt_id, submitted: true, redirect_attempted: true });
    expect(AttemptTracker.get()?.confirmed_at).toBeTruthy();
  });

  it("restores the same submitted capability in a fresh module after a page reload", async () => {
    vi.spyOn(api, "initAttempt").mockResolvedValue(capability());
    const current = await AttemptTracker.ensureAttempt();
    AttemptTracker.markSubmitted(current.attempt_id);
    vi.resetModules();
    const { AttemptTracker: freshPage } = await import("./attempt-tracker");
    expect(freshPage.get()).toMatchObject({ attempt_id: current.attempt_id, token: current.token, submitted: true });
  });

  it("does not reuse capability when MAC, AP or visit timestamp changes", async () => {
    const init = vi.spyOn(api, "initAttempt").mockResolvedValueOnce(capability("1")).mockResolvedValueOnce(capability("2"));
    await AttemptTracker.ensureAttempt();
    window.history.replaceState(null, "", "/?id=02:00:00:00:00:02&ap=02:00:00:00:00:22&ssid=Loja&t=2");
    expect((await AttemptTracker.ensureAttempt()).attempt_id).toBe("synthetic-2");
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("invalidates a late init reply after the captive context changes", async () => {
    let finish!: (value: ReturnType<typeof capability>) => void;
    vi.spyOn(api, "initAttempt").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = AttemptTracker.ensureAttempt();
    window.history.replaceState(null, "", "/?id=02:00:00:00:00:02&t=2");
    finish(capability());
    await expect(pending).rejects.toMatchObject({ kind: "abort" });
    expect(AttemptTracker.get()).toBeNull();
  });

  it("expires capabilities before reusing them", async () => {
    vi.useFakeTimers();
    const init = vi.spyOn(api, "initAttempt").mockResolvedValueOnce(capability("1")).mockImplementation(async () => capability("2"));
    await AttemptTracker.ensureAttempt();
    vi.setSystemTime(Date.now() + 600001);
    expect(AttemptTracker.get()).toBeNull();
    expect((await AttemptTracker.ensureAttempt()).attempt_id).toBe("synthetic-2");
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("works in memory when storage reads, writes and removal are denied", async () => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error("storage denied"); });
    }
    const init = vi.spyOn(api, "initAttempt").mockResolvedValue(capability());
    const value = await AttemptTracker.ensureAttempt();
    expect(await AttemptTracker.ensureAttempt()).toEqual(value);
    AttemptTracker.markSubmitted(value.attempt_id);
    expect(AttemptTracker.get()?.submitted).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    expect(() => AttemptTracker.clear()).not.toThrow();
    expect(AttemptTracker.get()).toBeNull();
  });

  it("preserves structured init throttling for the caller", async () => {
    vi.spyOn(api, "initAttempt").mockRejectedValue(new ApiError("http", "Aguarde", 429, { retryAfterMs: 60000 }));
    await expect(AttemptTracker.ensureAttempt()).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
    expect(AttemptTracker.get()).toBeNull();
  });
});
