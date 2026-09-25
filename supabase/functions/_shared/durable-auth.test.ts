import { describe, expect, it, vi } from "vitest";
import { reconcileAuthorization, type AuthOperation, type OperationDatabase } from "./durable-auth";

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
