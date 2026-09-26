// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { AttemptTracker } from "./attempt-tracker";

const attemptKey = "mb_auth_attempt_v2";
const cooldownKey = "mb_auth_cooldowns_v1";
let elapsed = 0;
const capability = () => ({ attempt_id: "synthetic-cooldown", token: "synthetic-token-no-authority",
  server_now: "2026-09-26T18:00:00Z", expires_at: "2026-09-26T18:10:00Z" });

async function reloadTracker(origin?: number) {
  vi.stubGlobal("performance", { timeOrigin: origin, now: () => elapsed });
  vi.resetModules();
  return (await import("./attempt-tracker")).AttemptTracker;
}

describe("persistent status cooldowns", () => {
  beforeEach(() => {
    elapsed = 0;
    vi.stubGlobal("performance", { timeOrigin: 1000, now: () => elapsed });
    AttemptTracker.clear(true);
    sessionStorage.clear();
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:01&ap=02:00:00:00:00:11&t=1");
    vi.spyOn(api, "initAttempt").mockResolvedValue(capability());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    AttemptTracker.clear(true);
    sessionStorage.clear();
  });

  it("separates initialization and status waits, and never shortens an existing minimum", async () => {
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.deferStatus(attempt.attempt_id, 30000);
    expect(AttemptTracker.cooldownRemaining()).toBe(0);
    expect(sessionStorage.getItem(cooldownKey)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("mb_status_cooldowns_v1")!)).toHaveLength(1);
    AttemptTracker.deferInitialization(10000);
    elapsed = 5000;
    AttemptTracker.deferStatus(attempt.attempt_id, 1000);
    expect(AttemptTracker.statusCooldownRemaining()).toBe(25000);
    expect(AttemptTracker.cooldownRemaining()).toBe(5000);
    elapsed = 30000;
    expect(AttemptTracker.statusCooldownRemaining()).toBe(0);
  });

  it.each([86400000, -86400000])("restores only the saved remainder despite a civil-clock change of %i ms", async offset => {
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.markSubmitted(attempt.attempt_id);
    AttemptTracker.deferStatus(attempt.attempt_id, 30000);
    elapsed = 7000;
    expect(AttemptTracker.statusCooldownRemaining()).toBe(23000);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(capability().server_now) + offset);
    elapsed = 0;
    const restored = await reloadTracker(2000);
    expect(restored.get()).toMatchObject({ attempt_id: attempt.attempt_id, token: attempt.token, submitted: true, requires_verification: true });
    expect(restored.statusCooldownRemaining()).toBe(23000);
    elapsed = 22999;
    expect(restored.statusCooldownRemaining()).toBe(1);
    elapsed = 23000;
    expect(restored.statusCooldownRemaining()).toBe(0);
    expect(api.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("keeps same-document memory and reload recovery distinct when timeOrigin is unavailable", async () => {
    vi.stubGlobal("performance", { now: () => elapsed });
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.markSubmitted(attempt.attempt_id);
    AttemptTracker.deferStatus(attempt.attempt_id, 30000);
    elapsed = 10000;
    expect(AttemptTracker.get()?.requires_verification).toBe(false);
    expect(AttemptTracker.statusCooldownRemaining()).toBe(20000);
    // A large unrelated performance.now must not expire the previous document's capability.
    elapsed = 900000;
    const restored = await reloadTracker();
    expect(restored.get()).toMatchObject({ attempt_id: attempt.attempt_id, requires_verification: true });
    expect(restored.statusCooldownRemaining()).toBe(20000);
    elapsed += 20000;
    expect(restored.statusCooldownRemaining()).toBe(0);
    restored.validateFromServer(attempt.attempt_id, "2026-09-26T18:09:30Z");
    expect(restored.get()?.requires_verification).toBe(false);
    elapsed += 30000;
    expect(restored.get()).toBeNull();
  });

  it("conservatively restores legacy records with no usable clock identity", async () => {
    const attempt = await AttemptTracker.ensureAttempt();
    const legacy = { ...attempt, clock_origin: undefined, clock_id: undefined };
    sessionStorage.setItem(attemptKey, JSON.stringify(legacy));
    sessionStorage.setItem(cooldownKey, JSON.stringify([{ context: attempt.context, until_ms: 30000, remaining_ms: 17000 }]));
    elapsed = 900000;
    const restored = await reloadTracker();
    expect(restored.get()).toMatchObject({ attempt_id: attempt.attempt_id, requires_verification: true });
    expect(restored.cooldownRemaining()).toBe(17000);
    expect(restored.statusCooldownRemaining()).toBe(0);
  });

  it("does not transfer a status cooldown to another capability or captive context", async () => {
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.deferStatus(attempt.attempt_id, 30000);
    sessionStorage.setItem(attemptKey, JSON.stringify({ ...attempt, attempt_id: "synthetic-other", token: "other-token" }));
    const restored = await reloadTracker(1000);
    expect(restored.statusCooldownRemaining()).toBe(0);
    restored.deferStatus(attempt.attempt_id, 50000); // A stale response cannot defer the new attempt.
    expect(restored.statusCooldownRemaining()).toBe(0);
    restored.deferStatus("synthetic-other", 12000);
    expect(restored.statusCooldownRemaining()).toBe(12000);
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:02&t=2");
    expect(restored.statusCooldownRemaining()).toBe(0);
    expect(restored.get()).toBeNull();
  });

  it("keeps status waiting usable in memory when session storage is denied", async () => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error("synthetic storage denial"); });
    }
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.deferStatus(attempt.attempt_id, 30000);
    elapsed = 12000;
    expect(AttemptTracker.statusCooldownRemaining()).toBe(18000);
    expect(AttemptTracker.get()?.attempt_id).toBe(attempt.attempt_id);
    AttemptTracker.clear();
    expect(AttemptTracker.statusCooldownRemaining()).toBe(0);
  });

  it("retains initialization throttling after a capability is cleared", async () => {
    const attempt = await AttemptTracker.ensureAttempt();
    AttemptTracker.deferInitialization(10000);
    AttemptTracker.deferStatus(attempt.attempt_id, 30000);
    AttemptTracker.clear();
    expect(AttemptTracker.cooldownRemaining()).toBe(10000);
    expect(AttemptTracker.statusCooldownRemaining()).toBe(0);
  });

  it("repairs a corrupt same-document deadline without overflowing or prolonging the timer", async () => {
    const attempt = await AttemptTracker.ensureAttempt();
    sessionStorage.setItem("mb_status_cooldowns_v1", JSON.stringify([{
      context: attempt.context, attempt_id: attempt.attempt_id, clock_id: "origin-1000",
      until_ms: 1e30, remaining_ms: 30000,
    }]));
    const restored = await reloadTracker(1000);
    expect(restored.statusCooldownRemaining()).toBe(30000);
    elapsed = 7000;
    expect(restored.statusCooldownRemaining()).toBe(23000);
    expect(JSON.parse(sessionStorage.getItem("mb_status_cooldowns_v1")!)[0].until_ms).toBe(30000);
    elapsed = 30000;
    expect(restored.statusCooldownRemaining()).toBe(0);
  });
});
