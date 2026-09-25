import { describe, expect, it, vi } from "vitest";
import { drainAuthorization, type AuthOperation, type OperationDatabase } from "./durable-auth";

// Deterministic capacity model of the published SQL selection/lease rules.
// This measures the real coordinator with an accelerated clock. Native PG
// separately validates the load counterexample; this is not a network benchmark.
async function unattendedBurst(size: number, latencyMs = 0) {
  const origin = Date.parse("2026-09-25T12:00:00Z");
  let now = origin;
  const clock = () => latencyMs ? Date.now() : now;
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
        now = clock();
        // expire_captive_auth_operations runs before the SELECT in claim.
        for (const row of rows) if (row.outcome === "verifying" && now >= origin + 110_000) row.outcome = "expired_unconfirmed";
        const freeSlots = Math.max(0, 16 - rows.filter(row => row.outcome === "verifying" && row.leaseEnd > now).length);
        const claim = rows.filter(row => row.outcome === "verifying" && row.due <= now && row.leaseEnd <= now)
          .sort((a, b) => a.due - b.due || a.id.localeCompare(b.id)).slice(0, Math.min(freeSlots, Number(args.p_limit)));
        for (const row of claim) {
          row.lease_version++;
          row.leaseEnd = Math.min(now + 30_000, origin + 110_000);
          row.lease_expires_at = new Date(row.leaseEnd).toISOString();
          row.due = row.leaseEnd;
        }
        return { data: claim.map(row => ({ ...row })), error: null };
      }
      const row = rows.find(row => row.id === args.p_operation_id)!;
      now = clock();
      if (row.lease_version !== args.p_lease_version || now >= row.leaseEnd) return { data: { applied: false }, error: null };
      row.outcome = String(args.p_outcome);
      return { data: { applied: true }, error: null };
    },
  };
  const send = vi.fn(async () => { throw new Error("An accepted command must never be resent"); });
  let concurrentReads = 0;
  let peakReads = 0;
  const verify = vi.fn(async (op: AuthOperation) => {
    concurrentReads++;
    peakReads = Math.max(peakReads, concurrentReads);
    try {
      if (latencyMs) await new Promise(resolve => setTimeout(resolve, latencyMs));
      return { state: "authorized" as const, found: true, authorized: true, effective_mac: op.client_mac,
        evidence: { mac: op.client_mac, found: true, authorized: true } };
    } finally { concurrentReads--; }
  });
  const errors: string[] = [];
  if (latencyMs) {
    vi.useFakeTimers();
    vi.setSystemTime(origin);
    try {
      const runs: Promise<void>[] = [];
      for (let tick = 1; tick <= 12; tick++) {
        setTimeout(() => {
          runs.push(drainAuthorization(db, { send, verify }, { owner: `cron-${tick}`, now: clock })
            .then(result => { errors.push(...result.errors); }));
        }, tick * 10_000);
      }
      await vi.advanceTimersByTimeAsync(160_000);
      await Promise.all(runs);
    } finally { vi.useRealTimers(); }
  } else {
    for (let tick = 1; tick <= 12; tick++) {
      now = origin + tick * 10_000;
      const result = await drainAuthorization(db, { send, verify }, { owner: `cron-${tick}`, now: clock });
      errors.push(...result.errors);
    }
  }
  return {
    confirmed: rows.filter(row => row.outcome === "confirmed").length,
    expired: rows.filter(row => row.outcome === "expired_unconfirmed").length,
    reads: verify.mock.calls.length, sends: send.mock.calls.length, errors, peakReads,
  };
}

describe("synthetic unattended recovery capacity", () => {
  it.each([1, 4, 20, 32, 36, 40, 48, 80])(
    "records all %i already-authorized clients when their browsers disappear", async size => {
      const result = await unattendedBurst(size);
      expect(result.sends).toBe(0);
      expect(result, JSON.stringify({ burst: size, ...result })).toMatchObject({ confirmed: size, expired: 0 });
    });
  it.each([[40, 6100], [40, 14000], [80, 6100], [80, 14000]])(
    "confirms %i accepted operations with %i ms reads and overlapping ten-second cron ticks", async (size, latencyMs) => {
      const result = await unattendedBurst(size, latencyMs);
      expect(result.sends).toBe(0);
      expect(result, JSON.stringify({ size, latencyMs, ...result })).toMatchObject({ confirmed: size, expired: 0, errors: [] });
      expect(result.peakReads).toBeLessThanOrEqual(16);
    });
});
