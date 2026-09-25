import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_WORKER_POLICY, drainAuthorization, reconcileAuthorization, requiredRpc, withOperationDeadline,
  type AuthOperation, type OperationDatabase } from "./durable-auth";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function scenario() {
  let clock = Date.parse("2026-09-25T12:00:00Z");
  const op: AuthOperation = {
    id: "operation-1", store_id: "store-1", controller_key: "https://controller.example/povao",
    site_id: "default", client_mac: "aa:bb:cc:dd:ee:01", ap_mac: "aa:bb:cc:dd:ee:02",
    command: { minutes: 40 }, state: "queued", action: "send", lease_version: 0,
    lease_expires_at: "", first_sent_at: null, deadline_at: null, redirect_url: "https://example.com",
  };
  let sentIntent = false;
  let activeLease = 0;
  let terminal = false;
  let failWrite = false;
  const records: Record<string, unknown>[] = [];
  const db: OperationDatabase = {
    async rpc(name, args) {
      if (name === "claim_captive_auth_operations") {
        if (activeLease > clock || terminal) return { data: [], error: null };
        const action = sentIntent ? "verify" : "send";
        sentIntent = true;
        activeLease = clock + 30_000;
        op.first_sent_at ||= new Date(clock).toISOString();
        op.deadline_at ||= new Date(clock + 90_000).toISOString();
        op.lease_expires_at = new Date(activeLease).toISOString();
        op.lease_version += 1;
        return { data: [{ ...op, action }], error: null };
      }
      if (failWrite) { failWrite = false; return { data: null, error: { code: "DB_FAILURE" } }; }
      if (args.p_lease_version !== op.lease_version || clock >= activeLease) {
        return { data: { applied: false, disposition: "stale_lease" }, error: null };
      }
      records.push(args);
      activeLease = 0;
      terminal = args.p_outcome === "confirmed" || args.p_outcome === "rejected";
      return { data: { applied: true }, error: null };
    },
  };
  const send = vi.fn(async () => ({ status: "accepted" as const, command_sent: true,
    effective_mac: "AABBCCDDEE01", accepted_at: new Date(clock).toISOString() }));
  const verify = vi.fn(async () => ({ state: "inconclusive" as const,
    found: false, authorized: null, effective_mac: "AABBCCDDEE01", evidence: {} }));
  const run = () => reconcileAuthorization(db, { send, verify }, { owner: "worker", now: () => clock });
  return { run, records, send, verify, op, db, advance: (ms: number) => { clock += ms; },
    failWrite: () => { failWrite = true; }, now: () => clock };
}

describe("durable authorization boundary", () => {
  it("confirms after 40 seconds with one command and no rate-limit request", async () => {
    const s = scenario();
    await s.run();
    for (let i = 0; i < 4; i++) { s.advance(10_000); await s.run(); }
    s.verify.mockResolvedValueOnce({ state: "authorized", found: true, authorized: true,
      effective_mac: "AABBCCDDEE01", evidence: {} } as never);
    await s.run();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.records.at(-1)?.p_outcome).toBe("confirmed");
    expect(s.records.at(-1)?.p_evidence).toMatchObject({ mac: s.op.client_mac,
      site_id: "default", controller_key: s.op.controller_key, authorized: true, found: true });
  });

  it("only verifies a POST whose response was lost", async () => {
    const s = scenario();
    s.send.mockResolvedValueOnce({ status: "unknown", command_sent: true,
      effective_mac: "AABBCCDDEE01", reason: "UNIFI_COMMAND_OUTCOME_UNKNOWN" } as never);
    await s.run(); s.advance(5_000); await s.run();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(s.records.map(r => r.p_outcome)).toEqual(["unknown", "pending"]);
  });

  it("a database failure after POST preserves intent and recovers without resend", async () => {
    const s = scenario(); s.failWrite();
    expect((await s.run()).errors).toHaveLength(1);
    expect((await s.run()).claimed).toBe(0);
    s.advance(31_000); await s.run();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.verify).toHaveBeenCalledTimes(1);
  });

  it("a crash inside the sender leaves later workers on verification", async () => {
    const s = scenario(); s.send.mockRejectedValueOnce(new Error("worker interrupted"));
    await s.run(); s.advance(31_000); await s.run();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.verify).toHaveBeenCalledTimes(1);
  });

  it("twenty concurrent callers do not multiply sends", async () => {
    const s = scenario();
    await Promise.all(Array.from({ length: 20 }, () => s.run()));
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("never persists another MAC as confirmed", async () => {
    const s = scenario(); await s.run();
    s.verify.mockResolvedValueOnce({ state: "authorized", found: true, authorized: true,
      effective_mac: "AABBCCDDEE99", evidence: {} } as never);
    await s.run();
    expect(s.records.at(-1)).toMatchObject({ p_outcome: "pending", p_error_code: "CONFIRMATION_MAC_MISMATCH" });
  });

  it("stale worker cannot report an applied conclusion", async () => {
    const s = scenario();
    s.send.mockImplementationOnce(async () => {
      s.advance(31_000);
      return { status: "accepted", command_sent: true, effective_mac: "AABBCCDDEE01", accepted_at: "" };
    });
    expect((await s.run()).applied).toBe(0);
    expect(s.records).toHaveLength(0);
  });

  it("never calls a controller when the claim RPC fails", async () => {
    const send = vi.fn(), verify = vi.fn();
    await expect(reconcileAuthorization({ rpc: async () => ({ data: null, error: { code: "DB_OFFLINE" } }) },
      { send, verify }, { owner: "worker" })).rejects.toThrow("DB_OFFLINE");
    expect(send).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
  });
});

describe("absolute operation deadlines", () => {
  it.each([0, -1, Number.NaN, Infinity])("does not start work with an expired or invalid deadline %s", async deadline => {
    const start = vi.fn(async () => "unused");
    await expect(withOperationDeadline(start, deadline, "EXPIRED", () => 0)).rejects.toThrow("EXPIRED");
    expect(start).not.toHaveBeenCalled();
  });

  it("aborts a hanging transport and rejects even when that transport ignores abort", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const late = deferred<string>();
    let signal: AbortSignal | undefined;
    const pending = withOperationDeadline(value => { signal = value; return late.promise; }, 100, "DEADLINE");
    const assertion = expect(pending).rejects.toThrow("DEADLINE");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
    late.resolve("late success");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a completed Promise after a runtime pause before the timeout callback runs", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    await expect(withOperationDeadline(async () => { vi.setSystemTime(101); return "late"; }, 100, "DEADLINE"))
      .rejects.toThrow("DEADLINE");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes cancellation to a PostgREST builder and preserves the default non-deadline contract", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const pendingResponse = deferred<{ data: unknown; error: null }>();
    let signal: AbortSignal | undefined;
    const request = Object.assign(pendingResponse.promise, { abortSignal: (value: AbortSignal) => {
      signal = value; return pendingResponse.promise;
    } });
    const db = { rpc: vi.fn(() => request) };
    const deadline = requiredRpc(db, "claim", {}, { deadlineAt: 100 });
    const assertion = expect(deadline).rejects.toThrow("claim:DEADLINE_EXCEEDED");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
    pendingResponse.resolve({ data: ["late"], error: null });
    expect(await requiredRpc({ rpc: async () => ({ data: ["compatible"], error: null }) }, "read", {})).toEqual(["compatible"]);
  });

  it("retains only symbolic RPC domain reasons while using a deadline", async () => {
    const call = (message: string) => requiredRpc({ rpc: async () => ({ data: null, error: { code: "P0001", message } }) },
      "join_captive_auth_operation", {}, { deadlineAt: Date.now() + 1000 });
    await expect(call("ATTEMPT_EXPIRED")).rejects.toMatchObject({ rpcName: "join_captive_auth_operation",
      rpcCode: "P0001", rpcReason: "ATTEMPT_EXPIRED" });
    await expect(call("private user content in SQL detail")).rejects.toMatchObject({ rpcReason: undefined });
  });

  it("a timed-out claim never invokes an adapter when its response later arrives", async () => {
    vi.useFakeTimers();
    const s = scenario();
    const original = s.db.rpc.bind(s.db);
    const gate = deferred<void>();
    s.db.rpc = async (name, args) => {
      const result = await original(name, args);
      if (name === "claim_captive_auth_operations") await gate.promise;
      return result;
    };
    const running = reconcileAuthorization(s.db, s, { owner: "worker", now: s.now, deadlineAt: s.now() + 20_000 });
    const assertion = expect(running).rejects.toThrow("claim_captive_auth_operations:DEADLINE_EXCEEDED");
    await vi.advanceTimersByTimeAsync(0);
    s.advance(20_000); await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(s.send).not.toHaveBeenCalled(); expect(s.verify).not.toHaveBeenCalled();
    // The delayed RPC may already have committed its send intent. Only an
    // expired-lease verification is safe; the abandoned caller cannot send.
    s.db.rpc = original; s.advance(11_000);
    await s.run();
    expect(s.send).not.toHaveBeenCalled(); expect(s.verify).toHaveBeenCalledTimes(1);
  });

  it("does not call an adapter when claim completes after an absolute deadline without a timer firing", async () => {
    const s = scenario();
    const original = s.db.rpc.bind(s.db);
    s.db.rpc = async (name, args) => { const result = await original(name, args); s.advance(20_001); return result; };
    await expect(reconcileAuthorization(s.db, s, { owner: "worker", now: s.now, deadlineAt: s.now() + 20_000 }))
      .rejects.toThrow("claim_captive_auth_operations:DEADLINE_EXCEEDED");
    expect(s.send).not.toHaveBeenCalled(); expect(s.verify).not.toHaveBeenCalled();
  });

  it("a hanging record after POST stays uncertain and a late commit cannot trigger another send", async () => {
    vi.useFakeTimers();
    const s = scenario();
    const original = s.db.rpc.bind(s.db);
    const gate = deferred<void>();
    s.db.rpc = async (name, args) => {
      if (name === "record_captive_auth_operation") await gate.promise;
      return await original(name, args);
    };
    const running = reconcileAuthorization(s.db, s, { owner: "worker", now: s.now, deadlineAt: s.now() + 20_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.send).toHaveBeenCalledTimes(1);
    s.advance(20_000); await vi.advanceTimersByTimeAsync(20_000);
    expect(await running).toMatchObject({ applied: 0, errors: [expect.stringContaining("record_captive_auth_operation:DEADLINE_EXCEEDED")] });
    gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    s.db.rpc = original;
    await s.run();
    expect(s.send).toHaveBeenCalledTimes(1); expect(s.verify).toHaveBeenCalledTimes(1);
    expect(s.records.map(record => record.p_outcome)).toEqual(["accepted", "pending"]);
  });
});

describe("bounded authorization draining", () => {
  function workload(latencyMs: number) {
    let claims = 0, active = 0, maximumActive = 0;
    const db: OperationDatabase = { rpc: vi.fn(async (name, args) => {
      if (name !== "claim_captive_auth_operations") return { data: { applied: true }, error: null };
      claims += 1;
      expect(args.p_limit).toBe(AUTH_WORKER_POLICY.batchSize);
      const data: AuthOperation[] = Array.from({ length: Number(args.p_limit) }, (_, index) => ({
        id: `${claims}-${index}`, user_id: "user", store_id: "store", controller_key: "https://controller.invalid",
        client_mac: "AABBCCDDEE01", ap_mac: null, site_id: "default", command: { minutes: 40 },
        state: "sending", action: "send", lease_version: 1,
        lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
        first_sent_at: new Date(Date.now()).toISOString(), deadline_at: new Date(Date.now() + 90_000).toISOString(),
        redirect_url: null,
      }));
      return { data, error: null };
    }) };
    const send = vi.fn(async (operation: AuthOperation) => {
      active += 1; maximumActive = Math.max(maximumActive, active);
      expect(operation.execution_deadline_at).toBe(AUTH_WORKER_POLICY.wallTimeMs);
      await new Promise(resolve => setTimeout(resolve, latencyMs));
      active -= 1;
      return { status: "accepted" as const, command_sent: true, effective_mac: operation.client_mac };
    });
    return { db, send, verify: vi.fn(), counts: () => ({ claims, active, maximumActive }) };
  }

  it("never exceeds four concurrent adapters or ten fast batches", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const s = workload(100);
    const running = drainAuthorization(s.db, s, { owner: "worker" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running).toMatchObject({ claimed: 40, applied: 40, errors: [] });
    expect(s.counts()).toEqual({ claims: 10, active: 0, maximumActive: 4 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops taking new batches when a 14 second adapter leaves less than the minimum budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const s = workload(14_000);
    const running = drainAuthorization(s.db, s, { owner: "worker" });
    await vi.advanceTimersByTimeAsync(42_000);
    expect(await running).toMatchObject({ claimed: 12, applied: 12, errors: [] });
    expect(s.counts()).toEqual({ claims: 3, active: 0, maximumActive: 4 });
    expect(Date.now()).toBeLessThan(AUTH_WORKER_POLICY.wallTimeMs);
  });

  it("a never-resolving drain claim is bounded by the shared wall deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const db = { rpc: vi.fn(() => new Promise<never>(() => {})) };
    const adapters = { send: vi.fn(), verify: vi.fn() };
    const running = drainAuthorization(db, adapters, { owner: "worker" });
    const assertion = expect(running).rejects.toThrow("claim_captive_auth_operations:DEADLINE_EXCEEDED");
    await vi.advanceTimersByTimeAsync(AUTH_WORKER_POLICY.wallTimeMs);
    await assertion;
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(adapters.send).not.toHaveBeenCalled(); expect(adapters.verify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
