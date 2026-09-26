import { afterEach, describe, expect, it, vi } from "vitest";
import { drainAuthorization, withOperationDeadline, type AuthOperation, type OperationDatabase } from "./durable-auth";

// This is a fault/capacity model, not a second implementation used as an oracle
// for SQL correctness. The real coordinator runs against the documented lease,
// immutable-deadline and due-work rules; native PostgreSQL tests those rules.
// Its output describes these supplied conditions, never a production fail rate.
type Scenario = { size: number; initial: "queued" | "accepted"; sendMs: number;
  readMs: number; visibleAfterMs?: number; failFirstReads?: number; failureMode?: "throw" | "inconclusive"; loseFirstRecord?: boolean;
  crashBeforePost?: boolean; seed?: number };
type Row = AuthOperation & { due: number; leaseEnd: number; deadline: number | null;
  terminal: string | null; realPostCount: number; firstSent: number | null;
  controllerVisibleAt: number | null; reads: number; lostRecord: boolean; confirmedAt: number | null };
const origin = Date.parse("2026-09-25T12:00:00Z");

async function scenario(config: Scenario) {
  vi.useFakeTimers(); vi.setSystemTime(origin);
  let random = config.seed || 1;
  const jitter = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % 401; };
  const rows: Row[] = Array.from({ length: config.size }, (_, i) => ({
    id: `fault-${i.toString().padStart(4, "0")}`, store_id: "test-store", user_id: `test-user-${i}`,
    controller_key: "https://controller.invalid/povao", site_id: "default",
    client_mac: `02AA${i.toString(16).padStart(8, "0")}`, ap_mac: "02BB00000001",
    command: { minutes: 40 }, state: config.initial === "queued" ? "queued" : "verifying",
    action: config.initial === "queued" ? "send" : "verify", lease_version: 0,
    lease_expires_at: new Date(origin).toISOString(), leaseEnd: origin, due: origin + 2000,
    deadline: config.initial === "queued" ? null : origin + 90_000,
    deadline_at: config.initial === "queued" ? null : new Date(origin + 90_000).toISOString(),
    firstSent: config.initial === "queued" ? null : origin,
    first_sent_at: config.initial === "queued" ? null : new Date(origin).toISOString(),
    command_accepted_at: config.initial === "queued" ? null : new Date(origin).toISOString(),
    redirect_url: "https://example.invalid/after", terminal: null,
    realPostCount: config.initial === "queued" ? 0 : 1,
    controllerVisibleAt: config.initial === "queued" ? null : origin + (config.visibleAfterMs || 0),
    reads: 0, lostRecord: false, confirmedAt: null,
  }));
  let peak = 0, active = 0;
  const observations: string[] = [];
  const expire = () => {
    for (const row of rows) if (!row.terminal && Date.now() >= (row.deadline === null ? origin + 110_000 : row.deadline + 20_000)) {
      row.terminal = "expired_unconfirmed"; row.leaseEnd = Date.now(); row.lease_version++;
    }
  };
  const db: OperationDatabase = { async rpc(name, args) {
    if (name === "claim_captive_auth_operations") {
      expire();
      const room = Math.max(0, 16 - rows.filter(r => !r.terminal && r.leaseEnd > Date.now()).length);
      const due = rows.filter(r => !r.terminal && r.due <= Date.now() && r.leaseEnd <= Date.now())
        .sort((a,b) => Number(a.state === "queued") - Number(b.state === "queued") ||
          (a.deadline ?? origin + 110_000) - (b.deadline ?? origin + 110_000) || a.due - b.due || a.id.localeCompare(b.id));
      const claimed = due.slice(0, Math.min(room, Number(args.p_limit)));
      for (const row of claimed) {
        row.action = row.state === "queued" ? "send" : "verify";
        row.state = row.action === "send" ? "sending" : "verifying";
        row.firstSent ??= Date.now(); row.deadline ??= row.firstSent + 90_000;
        row.first_sent_at = new Date(row.firstSent).toISOString(); row.deadline_at = new Date(row.deadline).toISOString();
        row.lease_version++; row.leaseEnd = Math.min(Date.now() + 30_000, row.deadline + 20_000);
        row.lease_expires_at = new Date(row.leaseEnd).toISOString(); row.due = row.leaseEnd;
      }
      return { data: claimed.map(r => ({ ...r })), error: null };
    }
    if (name !== "record_captive_auth_operation") throw Error("Unexpected RPC " + name);
    const row = rows.find(r => r.id === args.p_operation_id)!;
    if (row.terminal || row.lease_version !== args.p_lease_version || row.leaseEnd <= Date.now()) return { data: { applied: false }, error: null };
    if (config.loseFirstRecord && !row.lostRecord && row.action === "send") {
      row.lostRecord = true; throw Error("SIMULATED_STORAGE_OUTAGE_AFTER_POST");
    }
    const outcome = String(args.p_outcome);
    if (outcome === "accepted") row.command_accepted_at = new Date(Date.now()).toISOString();
    if (outcome === "confirmed") { row.terminal = "confirmed"; row.confirmedAt = Date.now(); }
    else if (Date.now() >= row.deadline!) row.terminal = "expired_unconfirmed";
    else row.state = "verifying";
    row.leaseEnd = Date.now(); row.due = Date.now() + 2000;
    return { data: { applied: true }, error: null };
  } };
  const enter = () => { active++; peak = Math.max(peak,active); };
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms + (config.seed ? jitter() : 0)));
  const adapters = {
    async send(op: AuthOperation) {
      const row = rows.find(r => r.id === op.id)!;
      if (config.crashBeforePost) throw Error("SIMULATED_WORKER_CRASH_BEFORE_POST");
      enter();
      try {
        row.realPostCount++; row.controllerVisibleAt = Date.now() + config.sendMs + (config.visibleAfterMs || 0);
        await delay(config.sendMs);
        return { status: "accepted" as const, command_sent: true, effective_mac: op.client_mac,
          command_sent_at: new Date(row.firstSent!).toISOString() };
      } finally { active--; }
    },
    async verify(op: AuthOperation) {
      const row = rows.find(r => r.id === op.id)!; enter(); row.reads++;
      try {
        // Match the actual wrapper's AP-preparation subdeadline, including a
        // query that consumes the remaining budget before its error arrives.
        const preparationDeadline = Math.min(Date.parse(op.lease_expires_at), op.execution_deadline_at ?? Infinity) - 16_000;
        await withOperationDeadline(async () => {
          if (row.reads <= (config.failFirstReads || 0) && config.failureMode !== "inconclusive") {
            await delay(config.readMs); throw Error("AP_LOOKUP_FAILED");
          }
        },preparationDeadline,"AP_LOOKUP_TIMEOUT");
        await delay(config.readMs);
        if (row.reads <= (config.failFirstReads || 0)) {
          // Actual runAuthorizationWorker.verify throws when its AP lookup fails,
          // before calling UniFi. Ordinary UniFi HTTP errors instead return the
          // inconclusive observation and release the lease via pending.
          return { state: "inconclusive" as const, found: null, authorized: null,
            effective_mac: op.client_mac, evidence: {} };
        }
        const authorized = row.controllerVisibleAt !== null && Date.now() >= row.controllerVisibleAt;
        return { state: authorized ? "authorized" as const : "not_authorized" as const,
          found: true, authorized, effective_mac: op.client_mac, evidence: { found: true, authorized } };
      } finally { active--; }
    },
  };
  const runs: Promise<void>[] = [];
  for(let tick=1;tick<=15;tick++) setTimeout(() => {
    expire();
    runs.push(drainAuthorization(db,adapters,{ owner: `fault-cron-${tick}`, deadlineAt: Date.now()+48_000 })
      .then(result => { observations.push(...result.errors); }).catch(error => { observations.push(String(error)); }));
  },tick*10_000);
  await vi.advanceTimersByTimeAsync(210_000); await Promise.all(runs); expire();
  return { config,confirmed:rows.filter(r=>r.terminal==="confirmed").length,
    confirmedWithin120s:rows.filter(r=>r.confirmedAt!==null&&r.confirmedAt-origin<=120_000).length,
    expired:rows.filter(r=>r.terminal==="expired_unconfirmed").length, active:rows.filter(r=>!r.terminal).length,
    posts:rows.reduce((s,r)=>s+r.realPostCount,0),duplicatePosts:rows.filter(r=>r.realPostCount>1).length,
    peak, readAttempts:rows.reduce((s,r)=>s+r.reads,0),transientErrors:observations.length,
    lastConfirmationMs:Math.max(0,...rows.map(r=>r.confirmedAt===null?0:r.confirmedAt-origin)) };
}

afterEach(()=>vi.useRealTimers());
describe("second audit: unattended fault and capacity envelope",()=>{
  it.each([
    {size:4,initial:"queued" as const,sendMs:6100,readMs:6100,visibleAfterMs:60_000},
    {size:40,initial:"queued" as const,sendMs:2000,readMs:2000,visibleAfterMs:20_000},
    {size:40,initial:"queued" as const,sendMs:12_000,readMs:12_000},
    {size:40,initial:"accepted" as const,sendMs:0,readMs:6100,visibleAfterMs:60_000},
    {size:80,initial:"accepted" as const,sendMs:0,readMs:6100,visibleAfterMs:60_000},
    {size:40,initial:"accepted" as const,sendMs:0,readMs:6100,failFirstReads:1},
    {size:40,initial:"accepted" as const,sendMs:0,readMs:6100,failFirstReads:1,failureMode:"inconclusive" as const},
  ])("recovers the supplied workload within the agreed 120s objective: %j",async config=>{
    const result=await scenario(config);
    console.info("AUDIT2_CAPACITY",JSON.stringify(result));
    expect(result.duplicatePosts).toBe(0); expect(result.peak).toBeLessThanOrEqual(16);
    expect(result.active).toBe(0);
    expect(result.confirmedWithin120s,JSON.stringify(result)).toBe(config.size);
  });
  it("recovers lost post-result writes without repeating any external command",async()=>{
    const result=await scenario({size:8,initial:"queued",sendMs:500,readMs:500,loseFirstRecord:true});
    console.info("AUDIT2_CAPACITY",JSON.stringify(result));
    expect(result).toMatchObject({confirmedWithin120s:8,posts:8,duplicatePosts:0,active:0});
    expect(result.transientErrors).toBe(8);
  });
  it("fences crash-before-POST ambiguity and terminates honestly instead of retrying a potentially sent command",async()=>{
    const result=await scenario({size:4,initial:"queued",sendMs:0,readMs:500,crashBeforePost:true});
    console.info("AUDIT2_CAPACITY",JSON.stringify(result));
    expect(result).toMatchObject({confirmed:0,expired:4,posts:0,duplicatePosts:0,active:0});
  });
  it("keeps single-send recovery under twenty reproducible jitter schedules",async()=>{
    for(let seed=1;seed<=20;seed++) {
      const result=await scenario({size:8,initial:"queued",sendMs:600,readMs:900,visibleAfterMs:20_000,loseFirstRecord:true,seed});
      expect(result,JSON.stringify(result)).toMatchObject({confirmedWithin120s:8,posts:8,duplicatePosts:0,active:0});
      expect(result.peak).toBeLessThanOrEqual(16); vi.useRealTimers();
    }
  });
});
