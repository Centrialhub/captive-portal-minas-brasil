import { describe, expect, it, vi } from "vitest";
import { reconcileAuthorization, type AuthOperation, type OperationDatabase } from "./durable-auth";

// Deterministic capacity model of the published SQL selection/lease rules.
// This measures the real coordinator with an accelerated clock. Native PG
// separately validates the load counterexample; this is not a network benchmark.
async function unattendedBurst(size: number) {
  const origin = Date.parse("2026-09-25T12:00:00Z");
  let now = origin;
  type Row = AuthOperation & { due: number; leaseEnd: number; outcome: string };
  const rows: Row[] = Array.from({ length: size }, (_, i) => ({
    id: `synthetic-${String(i).padStart(4, "0")}`, store_id: "synthetic-store", user_id: `user-${i}`,
    controller_key: "https://controller.invalid/povao", site_id: "default",
    client_mac: `02AA${i.toString(16).padStart(8, "0").toUpperCase()}`, ap_mac: "02BB00000001",
    command: { minutes: 40, ssid: "Synthetic" }, state: "verifying", action: "verify",
    lease_version: 1, lease_expires_at: new Date(origin).toISOString(),
    first_sent_at: new Date(origin).toISOString(), command_accepted_at: new Date(origin).toISOString(),
    deadline_at: new Date(origin + 90_000).toISOString(), redirect_url: "https://example.invalid",
    due: origin + 2000, leaseEnd: origin, outcome: "verifying",
  }));
  const db: OperationDatabase = {
    async rpc(name, args) {
      if (name === "claim_captive_auth_operations") {
        // expire_captive_auth_operations runs before the SELECT in claim.
        for (const row of rows) if (row.outcome === "verifying" && now >= origin + 110_000) row.outcome = "expired_unconfirmed";
        const claim = rows.filter(row => row.outcome === "verifying" && row.due <= now && row.leaseEnd <= now)
          .sort((a, b) => a.due - b.due || a.id.localeCompare(b.id)).slice(0, Number(args.p_limit));
        for (const row of claim) {
          row.lease_version++;
          row.leaseEnd = Math.min(now + 30_000, origin + 110_000);
          row.lease_expires_at = new Date(row.leaseEnd).toISOString();
          row.due = row.leaseEnd;
        }
        return { data: claim.map(row => ({ ...row })), error: null };
      }
      const row = rows.find(row => row.id === args.p_operation_id)!;
      if (row.lease_version !== args.p_lease_version || now >= row.leaseEnd) return { data: { applied: false }, error: null };
      row.outcome = String(args.p_outcome);
      return { data: { applied: true }, error: null };
    },
  };
  const send = vi.fn(async () => { throw new Error("An accepted command must never be resent"); });
  const verify = vi.fn(async (op: AuthOperation) => ({
    state: "authorized" as const, found: true, authorized: true, effective_mac: op.client_mac,
    evidence: { mac: op.client_mac, found: true, authorized: true },
  }));
  const errors: string[] = [];
  for (let tick = 1; tick <= 12; tick++) {
    now = origin + tick * 10_000;
    const result = await reconcileAuthorization(db, { send, verify }, { owner: `cron-${tick}`, limit: 4, now: () => now });
    errors.push(...result.errors);
  }
  return {
    confirmed: rows.filter(row => row.outcome === "confirmed").length,
    expired: rows.filter(row => row.outcome === "expired_unconfirmed").length,
    reads: verify.mock.calls.length, sends: send.mock.calls.length, errors,
  };
}

describe("synthetic unattended recovery capacity", () => {
  it.each([1, 4, 20, 32, 36, 40, 48, 80])(
    "records all %i already-authorized clients when their browsers disappear", async size => {
      const result = await unattendedBurst(size);
      expect(result.sends).toBe(0);
      expect(result, JSON.stringify({ burst: size, ...result })).toMatchObject({ confirmed: size, expired: 0 });
    });
});
