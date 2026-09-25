// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { AttemptTracker } from "./attempt-tracker";

const capability = (id: string) => ({
  attempt_id: "synthetic-" + id, token: "synthetic-token-" + id,
  expires_at: new Date(Date.now() + 600000).toISOString(),
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
    AttemptTracker.clear();
    window.history.replaceState(null, "", "/?store=povao&id=02:00:00:00:00:01&ap=02:00:00:00:00:11&t=1");
  });
  afterEach(() => { vi.restoreAllMocks(); AttemptTracker.clear(); });

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
