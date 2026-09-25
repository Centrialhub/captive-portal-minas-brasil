// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({ initAttempt: vi.fn() }));
vi.mock("./api", async importOriginal => ({
  ...await importOriginal<typeof import("./api")>(), api: wire,
}));

const baseTime = Date.parse("2026-09-25T20:00:00Z");
const recordKey = "mb_auth_attempt_v2";
const query = "/?store=povao&id=02:00:00:00:00:01&ap=02:00:00:00:00:11&t=1";
const capability = (id = "original") => ({
  attempt_id: `synthetic-${id}`, token: `synthetic-token-${id}`,
  server_now: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(),
});

class TabStorage implements Storage {
  private entries = new Map<string, string>();
  denied = false;
  constructor(copy?: TabStorage) {
    if (copy) this.entries = new Map(copy.entries);
  }
  get length() { return this.entries.size; }
  clear() { this.guard(); this.entries.clear(); }
  key(index: number) { this.guard(); return [...this.entries.keys()][index] ?? null; }
  getItem(key: string) { this.guard(); return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.guard(); this.entries.set(key, value); }
  removeItem(key: string) { this.guard(); this.entries.delete(key); }
  private guard() { if (this.denied) throw new DOMException("Synthetic storage disabled", "SecurityError"); }
}

describe("second-round attempt storage and document resilience", () => {
  let clock: Performance;
  let documentNumber: number;
  async function newDocument(storage: TabStorage) {
    const startedAt = clock.now();
    const documentPerformance = { timeOrigin: baseTime + ++documentNumber, now: () => clock.now() - startedAt };
    const focus = () => {
      vi.stubGlobal("sessionStorage", storage);
      vi.stubGlobal("performance", documentPerformance);
    };
    focus();
    vi.resetModules();
    const { AttemptTracker } = await import("./attempt-tracker");
    return { tracker: AttemptTracker, focus, storage };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    clock = performance;
    documentNumber = 0;
    vi.resetAllMocks();
    window.history.replaceState(null, "", query);
    wire.initAttempt.mockImplementation(async () => capability());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("isolates independently opened tabs and never shares their bearer tokens through module memory", async () => {
    wire.initAttempt.mockResolvedValueOnce(capability("tab-a")).mockResolvedValueOnce(capability("tab-b"));
    const first = await newDocument(new TabStorage());
    const a = await first.tracker.ensureAttempt();
    first.tracker.markSubmitted(a.attempt_id);
    const second = await newDocument(new TabStorage());
    expect(second.tracker.get()).toBeNull();
    const b = await second.tracker.ensureAttempt();
    expect(b.token).not.toBe(a.token);
    second.tracker.clear();
    first.focus();
    expect(first.tracker.get()).toMatchObject({ attempt_id: a.attempt_id, submitted: true });
    expect(wire.initAttempt).toHaveBeenCalledTimes(2);
  });

  it("marks a copied opener receipt for protected revalidation without mutating the original tab", async () => {
    const first = await newDocument(new TabStorage());
    const a = await first.tracker.ensureAttempt();
    first.tracker.markConfirmed(a.attempt_id);
    first.tracker.markRedirectAttempted(a.attempt_id);
    const second = await newDocument(new TabStorage(first.storage));
    expect(second.tracker.get()).toMatchObject({ attempt_id: a.attempt_id, submitted: true, redirect_attempted: true, requires_verification: true });
    second.tracker.clear();
    first.focus();
    expect(first.tracker.get()?.attempt_id).toBe(a.attempt_id);
    expect(wire.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("keeps copied pre-submit tabs independent, explicitly exposing the backend idempotency boundary", async () => {
    const first = await newDocument(new TabStorage());
    const a = await first.tracker.ensureAttempt();
    const second = await newDocument(new TabStorage(first.storage));
    expect(second.tracker.get()?.requires_verification).toBe(true);
    first.focus();
    first.tracker.markSubmitted(a.attempt_id);
    second.focus();
    expect(second.tracker.get()).toMatchObject({ attempt_id: a.attempt_id, submitted: false });
    // An opener clone is independent sessionStorage, not a cross-tab mutex.
    expect(wire.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("restores a pending capability after actual module loss and rejects it when authoritative server time has expired", async () => {
    const storage = new TabStorage();
    const first = await newDocument(storage);
    const a = await first.tracker.ensureAttempt();
    first.tracker.markSubmitted(a.attempt_id);
    await vi.advanceTimersByTimeAsync(600001);
    const restored = await newDocument(storage);
    expect(restored.tracker.get()).toMatchObject({ attempt_id: a.attempt_id, submitted: true, requires_verification: true });
    restored.tracker.validateFromServer(a.attempt_id, new Date().toISOString());
    expect(restored.tracker.get()).toBeNull();
    expect(wire.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("documents that process death with denied storage loses the capability instead of inventing a confirmed receipt", async () => {
    const storage = new TabStorage();
    storage.denied = true;
    const first = await newDocument(storage);
    const a = await first.tracker.ensureAttempt();
    first.tracker.markSubmitted(a.attempt_id);
    expect(first.tracker.get()?.submitted).toBe(true);
    const restored = await newDocument(storage);
    expect(restored.tracker.get()).toBeNull();
    expect(wire.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("revalidates a stale disk record when marking submitted could not persist before process death", async () => {
    const storage = new TabStorage();
    const first = await newDocument(storage);
    const a = await first.tracker.ensureAttempt();
    storage.denied = true;
    first.tracker.markSubmitted(a.attempt_id);
    expect(first.tracker.get()?.submitted).toBe(true);
    storage.denied = false;
    const restored = await newDocument(storage);
    expect(restored.tracker.get()).toMatchObject({ attempt_id: a.attempt_id, submitted: false, requires_verification: true });
    expect(wire.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not trust a persisted local confirmation after repeated reloads or client clock rollback", async () => {
    const storage = new TabStorage();
    const first = await newDocument(storage);
    const a = await first.tracker.ensureAttempt();
    first.tracker.markConfirmed(a.attempt_id);
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(baseTime - (i + 1) * 86400000);
      const restored = await newDocument(storage);
      expect(restored.tracker.get()).toMatchObject({ attempt_id: a.attempt_id, expires_at: a.expires_at, requires_verification: true });
      restored.tracker.validateFromServer(a.attempt_id);
      expect(restored.tracker.get()?.requires_verification).toBe(true);
    }
    expect(wire.initAttempt).toHaveBeenCalledTimes(1);
  });

  it("discards a stored receipt on store change and does not resurrect it when history returns to the original query", async () => {
    const storage = new TabStorage();
    const first = await newDocument(storage);
    const a = await first.tracker.ensureAttempt();
    first.tracker.markConfirmed(a.attempt_id);
    window.history.replaceState(null, "", query.replace("store=povao", "store=synthetic-other"));
    expect(first.tracker.get()).toBeNull();
    window.history.replaceState(null, "", query);
    const restored = await newDocument(storage);
    expect(restored.tracker.get()).toBeNull();
    expect(storage.getItem(recordKey)).toBeNull();
    expect(wire.initAttempt).toHaveBeenCalledTimes(1);
  });
});
