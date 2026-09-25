import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { isAuthResult } from "../../../src/lib/auth-outcome";
import { drainAuthorization, reconcileAuthorization, requiredRpc, withOperationDeadline, type AuthOperation } from "./durable-auth";
import { canonicalUnifiMac } from "./unifi-authorization";

// Run the actual Edge handlers and coordinator. Only storage/network/Auth are
// fake; the DTO is shaped like get_captive_auth_operation's flat + nested JSON.
const source = fs.readFileSync(new URL("../captive-portal/index.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("edge.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "publicOperationResult", "readOperation", "authorizeDurably", "handleAttemptStatus",
  "runAuthorizationWorker", "claimPortalSessionChallenge",
  "authorizationDispositionError", "authorizationFailureResponse",
]);
const selected = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text || ""));
if (selected.length !== names.size) throw new Error("Durable handler extraction incomplete");
const compiled = ts.transpileModule(selected.map(node => node.getText(tree)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const ATTEMPT = "12345678-1234-1234-1234-123456789012";
const TOKEN = "a".repeat(64);
const STORE = "store-test";
const USER = "user-test";
const MAC = "001122334455";
const AP = "AABBCCDDEEFF";
const CONTROLLER = "https://unifiproxy.minasbrasilwifi.com.br/povao";
const REDIRECT = "https://example.test/after";

function operationResult(status: string) {
  const timestamp = new Date().toISOString();
  return {
    id: "operation-test", operation_id: "operation-test", status, authorized: status === "confirmed",
    processing: ["queued", "sending", "verifying"].includes(status), fail_reason: null,
    deadline_at: status === "queued" ? null : new Date(Date.now() + 90_000).toISOString(),
    redirect_url: status === "confirmed" ? REDIRECT : null,
    created_at: timestamp, first_sent_at: status === "queued" ? null : timestamp,
    verification_deadline: status === "queued" ? null : new Date(Date.now() + 90_000).toISOString(),
    next_check_at: timestamp, confirmed_at: status === "confirmed" ? timestamp : null,
    authorized_until: status === "confirmed" ? new Date(Date.now() + 40 * 60_000).toISOString() : null,
    completed_at: status === "confirmed" ? timestamp : null, last_error_code: null,
    retry_after_ms: ["queued", "sending", "verifying"].includes(status) ? 2000 : 0,
  };
}

type HarnessOptions = {
  status?: string;
  disposition?: string;
  secondDisposition?: string;
  joinDisposition?: string;
  claims?: boolean;
  recordError?: boolean;
  readError?: boolean;
  challengeError?: boolean;
  challengeStall?: boolean;
  tableError?: string;
  tableStall?: string;
  joinError?: { code: string; message: string };
};
function harness(options: HarnessOptions = {}) {
  let currentStatus = options.status || "queued";
  let hasClaimed = false;
  let challengeClaimed = false;
  let readCount = 0;
  let releaseLookup = () => {};
  const records: Record<string, unknown>[] = [];
  const apQueries: Array<{ field: string; value: unknown }> = [];
  const db = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "join_captive_auth_operation") return {
        data: { disposition: options.joinDisposition || "created",
          operation: options.joinDisposition ? null : operationResult(currentStatus), session_id: "session-test",
          retry_after_ms: 10_000 }, error: options.joinError || null,
      };
      if (name === "get_captive_auth_operation") {
        readCount += 1;
        const disposition = readCount > 1 ? options.secondDisposition || options.disposition : options.disposition;
        if (options.readError) return { data: null, error: { code: "READ_FAILED" } };
        if (disposition === "awaiting_identity") return {
          data: { disposition: "awaiting_identity", status: "awaiting_identity", authorized: false,
            processing: false, session_id: null }, error: null,
        };
        if (disposition) return { data: { disposition, authorized: false, processing: false }, error: null };
        const operation = operationResult(currentStatus);
        return { data: { ...operation, disposition: "found", operation, user_id: USER, session_id: "session-test" }, error: null };
      }
      if (name === "claim_captive_auth_operations") {
        if (!options.claims || hasClaimed) return { data: [], error: null };
        hasClaimed = true;
        const op: AuthOperation = {
          id: "operation-test", user_id: USER, store_id: STORE, controller_key: CONTROLLER,
          site_id: "default", client_mac: MAC, ap_mac: AP, command: { minutes: 40, ssid: "Wifi" },
          state: currentStatus, action: currentStatus === "queued" ? "send" : "verify",
          lease_version: 1, lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
          first_sent_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 90_000).toISOString(),
          command_accepted_at: currentStatus === "verifying" ? new Date().toISOString() : null,
          redirect_url: REDIRECT,
        };
        currentStatus = op.action === "send" ? "sending" : "verifying";
        op.state = currentStatus;
        return { data: [op], error: null };
      }
      if (name === "record_captive_auth_operation") {
        records.push(args);
        if (options.recordError) return { data: null, error: { code: "LOST_RECORD_RESPONSE" } };
        currentStatus = args.p_outcome === "confirmed" ? "confirmed" : args.p_outcome === "rejected" ? "rejected"
          : args.p_outcome === "not_sent" ? "queued" : "verifying";
        return { data: { applied: true }, error: null };
      }
      if (name === "claim_captive_auth_challenge") {
        if (options.challengeStall) return await new Promise<never>(() => {});
        if (challengeClaimed) return { data: null, error: null };
        challengeClaimed = true;
        return { data: USER, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    }),
    from(table: string) {
      const data = table === "stores" ? { slug: "povao", is_active: true, unifi_controller_url: CONTROLLER, unifi_site_id: "default" }
        : table === "global_settings" ? { session_duration_minutes: 40, max_daily_accesses: 0 }
        : table === "store_access_points" ? [{ ap_mac: AP }]
        : table === "profiles" ? { cpf_digits: null, phone_digits: null } : null;
      const result = options.tableError === table
        ? { data: null, error: { code: "SYNTHETIC_TRANSIENT_LOOKUP_FAILURE" } }
        : { data, error: null };
      const lookup = options.tableStall === table ? new Promise<typeof result>(resolve => { releaseLookup = () => resolve(result); }) : Promise.resolve(result);
      const query = { select: () => query, eq: (field: string, value: unknown) => {
        if (table === "store_access_points") apQueries.push({ field, value });
        return query;
      },
      single: () => lookup, maybeSingle: () => lookup,
      abortSignal: () => query,
      then: (resolve: (value: unknown) => unknown) => lookup.then(resolve) };
      return query;
    },
  };
  const send = vi.fn(async () => ({ status: "accepted" as const, command_sent: true,
    effective_mac: MAC, accepted_at: new Date().toISOString() }));
  const verify = vi.fn(async () => ({ state: "inconclusive" as const, found: false, authorized: null,
    effective_mac: MAC, reason: "CLIENT_NOT_OBSERVED", evidence: {} }));
  const mint = vi.fn(async () => {
    if (options.challengeError) throw new Error("OPTIONAL_AUTH_UNAVAILABLE");
    return { token_hash: "one-use-test-hash" };
  });
  const context = vm.createContext({
    Date, Request, Response, setTimeout, clearTimeout, crypto: { randomUUID: () => "test-worker" },
    DEFAULT_REDIRECT_URL: REDIRECT, UNIFI_USERNAME: "fake", UNIFI_PASSWORD: "fake",
    Logger: { info() {}, warn() {}, error() {} }, drainAuthorization, reconcileAuthorization, requiredRpc, withOperationDeadline,
    supabaseAdmin: () => db, safeParseJson: (request: Request) => request.json(),
    jsonResponse: (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }),
    isValidUUID: (value: string) => value === ATTEMPT,
    canonicalUnifiControllerUrl: () => CONTROLLER, sha256Hex: async () => "association-hash",
    normalizeMac: canonicalUnifiMac,
    normalizeDailyAccessLimit: () => 0, startOfDayInTimeZoneIso: () => new Date().toISOString(),
    getActiveUserBlock: async () => null, persistPortalLead: async () => {}, publicProfileEmail: (email: string) => email,
    syncWithClubeMais: async () => {}, boundedPortalSessionChallenge: mint,
    unifiAuthorizeCommandOnly: send, unifiCheckAuthorizationOnly: verify,
  });
  vm.runInContext(compiled, context);
  const status = async () => {
    const response: Response = await context.handleAttemptStatus(new Request("https://portal.test/attempt/status", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attempt_id: ATTEMPT, token: TOKEN }),
    }));
    return { response, body: await response.json() as Record<string, unknown> };
  };
  const initial = async () => context.authorizeDurably({ db, attemptId: ATTEMPT, resumeToken: TOKEN, userId: USER,
    ctx: { clientMac: MAC, apMac: AP, ssid: "Wifi", captiveTimestamp: "test-association" },
    profile: {}, authMethod: "identity", traceId: "trace-test", clientIp: null, userAgent: "test",
  }, STORE, "povao", REDIRECT) as Promise<Record<string, unknown>>;
  return { db, context, initial, status, send, verify, mint, records, apQueries, releaseLookup: () => releaseLookup() };
}

describe("durable Edge handlers and browser wire contract", () => {
  it("initial accepted command returns a valid pending DTO through real worker wiring", async () => {
    const h = harness({ claims: true });
    const result = await h.initial();
    expect(isAuthResult(result)).toBe(true);
    expect(result).toMatchObject({ authorized: false, processing: true, status: "verifying", operation_id: "operation-test", session_id: "session-test" });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(CONTROLLER, "default", MAC, "fake", "fake", expect.objectContaining({
      apMac: AP, ssid: "Wifi", trustedApMacs: [AP], minutes: 40, allowPortalMacFallback: true, deadlineAt: expect.any(Number),
    }));
    expect(h.apQueries).toEqual([{ field: "store_id", value: STORE }]);
    expect(h.records[0]).toMatchObject({ p_outcome: "accepted" });
  });

  it("queued null timestamps are omitted rather than breaking browser validation", async () => {
    const h = harness();
    const { body } = await h.status();
    expect(isAuthResult(body)).toBe(true);
    expect(body.deadline_at).toBeUndefined();
    expect(body).toMatchObject({ authorized: false, processing: true, status: "queued" });
  });

  it("an initialized capability awaiting identity is a valid non-processing DTO", async () => {
    const h = harness({ disposition: "awaiting_identity" });
    const { response, body } = await h.status();
    expect(response.status).toBe(200);
    expect(isAuthResult(body)).toBe(true);
    expect(body).toMatchObject({ authorized: false, processing: false, status: "awaiting_identity" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("confirmed state issues the optional challenge once while subsequent reads remain successful", async () => {
    const h = harness({ status: "confirmed" });
    const first = await h.status();
    const second = await h.status();
    expect(isAuthResult(first.body)).toBe(true);
    expect(first.body).toMatchObject({ authorized: true, processing: false, status: "confirmed", session_token_hash: "one-use-test-hash" });
    expect(second.body).toMatchObject({ authorized: true, status: "confirmed" });
    expect(second.body.session_token_hash).toBeUndefined();
    expect(h.mint).toHaveBeenCalledTimes(1);
  });

  it("optional challenge failure cannot turn confirmed access into an error", async () => {
    const h = harness({ status: "confirmed", challengeError: true });
    const { response, body } = await h.status();
    expect(response.status).toBe(200);
    expect(isAuthResult(body)).toBe(true);
    expect(body).toMatchObject({ authorized: true, status: "confirmed" });
    expect(body.session_token_hash).toBeUndefined();
  });

  it.each(["receipt_stale", "capability_expired"])("returns 410 for %s without a worker or challenge", async disposition => {
    const h = harness({ disposition });
    const { response, body } = await h.status();
    expect(response.status).toBe(410);
    expect(body.code).toBe("attempt_expired");
    expect(h.send).not.toHaveBeenCalled(); expect(h.mint).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid capability", async () => {
    const h = harness({ disposition: "invalid_capability" });
    expect((await h.status()).response.status).toBe(401);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("revalidates capability expiry after a worker finishes during the status request", async () => {
    const h = harness({ status: "verifying", claims: true, secondDisposition: "capability_expired" });
    const { response, body } = await h.status();
    expect(response.status).toBe(410);
    expect(body.code).toBe("attempt_expired");
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("context conflict is a valid rejected DTO rather than an unknown status", async () => {
    const h = harness({ joinDisposition: "context_conflict" });
    const result = await h.initial();
    expect(isAuthResult(result)).toBe(true);
    expect(result).toMatchObject({ status: "rejected", authorized: false, processing: false, fail_reason: "DEVICE_CONTEXT_CONFLICT" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("unconfirmed cooldown is a terminal honest DTO with a retry delay", async () => {
    const h = harness({ joinDisposition: "unconfirmed_cooldown" });
    const result = await h.initial();
    expect(isAuthResult(result)).toBe(true);
    expect(result).toMatchObject({ status: "expired_unconfirmed", authorized: false, processing: false, retry_after_ms: 10_000 });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a lost record RPC response never becomes an invented confirmed result", async () => {
    const h = harness({ claims: true, recordError: true });
    const result = await h.initial();
    expect(isAuthResult(result)).toBe(true);
    expect(result).toMatchObject({ authorized: false, processing: true, status: "sending" });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("status uses read-only exact verification and returns its committed confirmation", async () => {
    const h = harness({ status: "verifying", claims: true });
    h.verify.mockResolvedValueOnce({ state: "authorized", found: true, authorized: true,
      effective_mac: MAC, evidence: { found: true, authorized: true } } as never);
    const { body } = await h.status();
    expect(isAuthResult(body)).toBe(true);
    expect(body.authorized).toBe(true);
    expect(h.verify).toHaveBeenCalledTimes(1); expect(h.send).not.toHaveBeenCalled();
    expect(h.verify).toHaveBeenCalledWith(CONTROLLER, "default", MAC, "fake", "fake", expect.objectContaining({
      apMac: AP, ssid: "Wifi", trustedApMacs: [AP], deadlineAt: expect.any(Number),
    }));
    expect(h.apQueries).toEqual([{ field: "store_id", value: STORE }]);
    expect(h.records[0]).toMatchObject({ p_outcome: "confirmed", p_evidence: { mac: MAC, site_id: "default", controller_key: CONTROLLER } });
  });

  it("database read failures are surfaced rather than converted to success", async () => {
    const h = harness({ readError: true });
    await expect(h.status()).rejects.toThrow("READ_FAILED");
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("synthetic: a stalled optional challenge RPC cannot hold a confirmed response", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ status: "confirmed", challengeStall: true });
      let result: Awaited<ReturnType<typeof h.status>> | undefined;
      void h.status().then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(2000);
      expect(result?.body).toMatchObject({ authorized: true, status: "confirmed" });
      expect(h.mint).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(["user_roles", "store_access_points"])(
    "synthetic: a failed %s lookup before POST preserves proven-unsent recovery", async tableError => {
      const h = harness({ claims: true, tableError });
      const result = await h.initial();
      expect(result.authorized).toBe(false);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.records).toHaveLength(1);
      expect(h.records[0]).toMatchObject({ p_outcome: "not_sent", p_evidence: { command_sent: false } });
    });

  it.each(["state_inconsistent", "receipt_stale", "invalid_capability"])(
    "synthetic: initial authorization does not return an invalid success-shaped DTO for %s", async disposition => {
      const h = harness({ disposition });
      // Accept a typed domain error or a valid explicit failure DTO. A generic
      // ReferenceError from the harness must not make this contract pass.
      const outcome = await h.initial().then(
        value => ({ kind: "result" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      if (outcome.kind === "result") {
        expect(isAuthResult(outcome.value)).toBe(true);
        expect(outcome.value).toMatchObject({ authorized: false, fail_reason: expect.stringMatching(/\S/) });
      } else {
        const expected = disposition === "state_inconsistent" ? /STATE_INCONSISTENT/i
          : disposition === "receipt_stale" ? /RECEIPT_STALE|ATTEMPT.*EXPIRED|CAPABILITY.*EXPIRED/i
            : /INVALID.*CAPABILITY|CAPABILITY.*INVALID|INVALID.*ATTEMPT|ATTEMPT.*INVALID/i;
        expect(outcome.error).toMatchObject({ message: expect.stringMatching(expected) });
      }
      expect(h.send).not.toHaveBeenCalled();
    });

  it.each([["ATTEMPT_EXPIRED", "P0001", 410], ["AUTHORIZATION_RECEIPT_STALE", "P0001", 410],
    ["INVALID_RESUME_TOKEN", "28000", 401]])(
    "maps join SQL exception %s (%s) to HTTP %i without losing its domain reason", async (message, code, status) => {
      const h = harness({ joinError: { message: String(message), code: String(code) } });
      const error = await h.initial().catch(error => error);
      const response: Response = h.context.authorizationFailureResponse(error);
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.code).toBe(status === 410 ? "attempt_expired" : "invalid_attempt");
      expect(h.send).not.toHaveBeenCalled();
    });

  it("does not classify arbitrary P0001 errors as expired or expose raw SQL text", async () => {
    const h = harness({ joinError: { code: "P0001", message: "private SQL value 123" } });
    const error = await h.initial().catch(error => error);
    expect(error.rpcReason).toBeUndefined();
    expect(error.message).not.toContain("private");
    expect(h.context.authorizationFailureResponse(error)).toBeNull();
  });

  it.each(["user_roles", "store_access_points"])(
    "bounds a stalled %s preparation and never sends after its late completion", async tableStall => {
      vi.useFakeTimers();
      try {
        const h = harness({ claims: true, tableStall });
        const result = h.initial();
        await vi.advanceTimersByTimeAsync(4001);
        expect(await result).toMatchObject({ authorized: false, status: "queued", processing: true });
        expect(h.records).toHaveLength(1);
        expect(h.records[0]).toMatchObject({ p_outcome: "not_sent", p_evidence: { command_sent: false } });
        h.releaseLookup();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(h.send).not.toHaveBeenCalled();
        expect(h.records).toHaveLength(1);
      } finally { vi.useRealTimers(); }
    });
});
