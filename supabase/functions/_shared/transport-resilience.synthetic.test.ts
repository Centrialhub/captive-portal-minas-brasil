import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as transport from "./unifi-authorization";
import * as cookies from "./unifi-cookie";
import { drainAuthorization, reconcileAuthorization, requiredRpc, withOperationDeadline, type AuthOperation } from "./durable-auth";
import { isAuthResult } from "../../../src/lib/auth-outcome";

// Execute current Edge function bodies, rather than a rewritten adapter. The
// only network implementation below is a closed synthetic router; there is no
// native fetch fallback and every controller name ends in .invalid.
const source = fs.readFileSync(new URL("../captive-portal/index.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("edge.ts", source, ts.ScriptTarget.Latest, true);
function compile(names: string[]) {
  const selected = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ""));
  if (selected.length !== names.length) throw new Error("Transport resilience extraction incomplete");
  return ts.transpileModule(selected.map(node => node.getText(tree)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}
const adapters = compile(["unifiTryLogin", "unifiLogin", "buildUnifiHeaders", "unifiNetworkEndpoint",
  "unifiAuthorizeCommandOnly", "unifiCheckAuthorizationOnly"]);
const handlers = compile(["publicOperationResult", "readOperation", "handleAttemptStatus", "runAuthorizationWorker",
  "claimPortalSessionChallenge", "authorizationDispositionError", "authorizeDurably", "checkRateLimitDb", "handleIdentity"]);
const ROOT = "https://controller.invalid/povao";
const MAC = "001122334455", AP = "AABBCCDDEEFF", ATTEMPT = "52870b9b-d690-48fa-835e-232fa17cda00";
const TOKEN = "synthetic-capability-00000000000000", USER = "synthetic-user", STORE = "synthetic-store";
const OPTIONS = { apMac: AP, ssid: "Wifi", trustedApMacs: [AP], minutes: 40, allowPortalMacFallback: true };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
const response = (data: unknown, error: unknown = null) => ({ data, error });
const profile = { id: USER, full_name: "Synthetic", cpf_digits: "52998224725", phone_digits: "38999999999", email: "synthetic@example.invalid" };
function baseContext(db: unknown) {
  return { ...transport, ...cookies, Date, URL, Request, Response, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "synthetic-worker" },
    drainAuthorization, reconcileAuthorization, requiredRpc, withOperationDeadline,
    UNIFI_TIMEOUT_MS: 10000, UNIFI_AUTH_MODE: "legacy", UNIFI_USERNAME: "synthetic", UNIFI_PASSWORD: "synthetic",
    DEFAULT_REDIRECT_URL: "https://destination.invalid/connected", PORTAL_IDENTITY_EMAIL_DOMAIN: "identity.invalid",
    createUnifiHttpClient: () => null, supabaseAdmin: () => db,
    fetch: () => { throw new Error("REAL_NETWORK_PROHIBITED"); },
    Logger: { warn() {}, info() {}, error() {} }, logEvent: () => {},
    safeParseJson: (request: Request) => request.json(), jsonResponse: json,
    errorResponse: (message: string, status = 400) => json({ error: message }, status),
    isValidUUID: (value: string) => value === ATTEMPT,
    canonicalUnifiControllerUrl: () => ROOT, normalizeMac: transport.canonicalUnifiMac,
    getActiveUserBlock: async () => null, persistPortalLead: async () => {},
    publicProfileEmail: (value: string) => value, syncWithClubeMais: async () => {},
    boundedPortalSessionChallenge: async () => null, sha256Hex: async () => "synthetic-hash",
    normalizeDailyAccessLimit: () => 0, startOfDayInTimeZoneIso: () => new Date().toISOString(),
  };
}
function query(data: unknown, waiting?: Promise<unknown>) {
  const result = waiting || Promise.resolve(response(data));
  const builder = { select: () => builder, eq: () => builder, abortSignal: () => builder,
    single: () => result, maybeSingle: () => result,
    then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => result.then(resolve, reject) };
  return builder;
}
type RequestRecord = { url: string; method: string; headers: Headers; body: string; time: number };
type NetworkRule = (request: RequestRecord) => Response | Promise<Response> | undefined;

function transportHarness(rule: NetworkRule = () => undefined, loseRecord = false) {
  const requests: RequestRecord[] = [], records: Record<string, unknown>[] = [];
  let controllerAuthorized = false, logins = 0, leaseUntil = 0, due = 0, sendIntent = false;
  let state = "queued", version = 0, firstSent: string | null = null, acceptedAt: string | null = null;
  const snapshot = () => ({ id: "operation", operation_id: "operation", status: state,
    authorized: state === "confirmed", processing: ["queued", "sending", "verifying"].includes(state),
    retry_after_ms: 2000, deadline_at: firstSent ? new Date(Date.parse(firstSent) + 90000).toISOString() : null,
    redirect_url: "https://destination.invalid/connected", fail_reason: null });
  // Only one operation is modeled. Claim exclusion, 30s fencing, not_sent's
  // 5s due time and flat+nested GET are the actual SQL RPC contract; this is
  // cross-layer wiring coverage, not a substitute for native PostgreSQL tests.
  const db = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "get_captive_auth_operation") return response({ ...snapshot(), operation: snapshot(), disposition: "found", user_id: USER, session_id: "session" });
      if (name === "claim_captive_auth_challenge") return response(null);
      if (name === "claim_captive_auth_operations") {
        if (["confirmed", "rejected"].includes(state) || leaseUntil > Date.now() || due > Date.now()) return response([]);
        const action = sendIntent ? "verify" : "send";
        sendIntent = true; firstSent ||= new Date().toISOString(); version += 1;
        leaseUntil = Date.now() + 30000; state = action === "send" ? "sending" : "verifying";
        const op: AuthOperation = { id: "operation", user_id: USER, store_id: STORE, controller_key: ROOT,
          site_id: "default", client_mac: MAC, ap_mac: AP, command: { minutes: 40, ssid: "Wifi" },
          state, action, lease_version: version, lease_expires_at: new Date(leaseUntil).toISOString(),
          first_sent_at: firstSent, command_accepted_at: acceptedAt,
          deadline_at: new Date(Date.parse(firstSent) + 90000).toISOString(), redirect_url: null };
        return response([op]);
      }
      if (name === "record_captive_auth_operation") {
        records.push(args);
        if (loseRecord) { loseRecord = false; return response(null, { code: "CONNECTION_LOST" }); }
        if (args.p_lease_version !== version || Date.now() >= leaseUntil) return response({ applied: false, disposition: "stale_lease" });
        leaseUntil = 0;
        if (args.p_outcome === "accepted") acceptedAt ||= new Date().toISOString();
        if (args.p_outcome === "not_sent") { state = "queued"; sendIntent = false; due = Date.now() + 5000; }
        else { state = args.p_outcome === "confirmed" ? "confirmed" : "verifying"; due = Date.now() + 2000; }
        return response({ applied: true });
      }
      throw new Error(`Unexpected RPC ${name}`);
    }),
    from(table: string) {
      return query(table === "stores" ? { slug: "povao", is_active: true, unifi_controller_url: ROOT, unifi_site_id: "default" }
        : table === "store_access_points" ? [{ ap_mac: AP }] : table === "profiles" ? { cpf_digits: null } : null);
    },
  };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const request = { url, method: init.method || "GET", headers: new Headers(init.headers), body: String(init.body || ""), time: Date.now() };
    requests.push(request);
    const supplied = await rule(request);
    if (supplied) return supplied;
    if (url === `${ROOT}/`) return new Response("warm", { headers: { "set-cookie": "unifi_controller=povao" } });
    if (url === `${ROOT}/api/login`) {
      logins += 1;
      return json({ meta: { rc: "ok" } }, 200, { "set-cookie": `unifises=session-${logins}`, "x-csrf-token": `csrf-${logins}` });
    }
    if (url === `${ROOT}/api/s/default/stat/sta`) return json({ meta: { rc: "ok" }, data: [{ mac: MAC, ap_mac: AP, essid: "Wifi", authorized: controllerAuthorized }] });
    if (url === `${ROOT}/api/s/default/cmd/stamgr`) { controllerAuthorized = true; return json({ meta: { rc: "ok" } }); }
    throw new Error(`Unexpected synthetic endpoint ${url}`);
  });
  const context = vm.createContext({ ...baseContext(db),
    fetchUnifiResponse: (url: string, init: RequestInit, deadline: number) => transport.fetchUnifiResponse(url, init, deadline, fetcher),
    fetchUnifiStationsStrict: (url: string, init: RequestInit, deadline: number) => transport.fetchUnifiStationsStrict(url, init, deadline, fetcher),
    sendUnifiAuthorizeOnce: (url: string, init: RequestInit, mac: string, options: { apMac?: string; minutes?: number }, deadline: number) => transport.sendUnifiAuthorizeOnce(url, init, mac, options, deadline, fetcher),
  });
  vm.runInContext(adapters + handlers, context);
  return { requests, records, db, commands: () => requests.filter(request => request.url.endsWith("/cmd/stamgr")),
    applyAtController: () => { controllerAuthorized = true; },
    command: () => context.unifiAuthorizeCommandOnly(ROOT, "default", MAC, "synthetic", "synthetic", OPTIONS),
    status: async () => {
      const result = await context.handleAttemptStatus(new Request("https://portal.invalid/attempt/status", {
        method: "POST", body: JSON.stringify({ attempt_id: ATTEMPT, token: TOKEN }),
      })) as Response;
      return result.json();
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-09-25T20:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("second audit: actual handler, coordinator and UniFi transport", () => {
  it.each([401, 429, 502])("keeps a committed POST with HTTP %s uncertain, then confirms using a fresh login without resend", async status => {
    const h = transportHarness(request => {
      if (request.url.endsWith("/cmd/stamgr")) {
        h.applyAtController();
        return json({ meta: { rc: "error" } }, status, { "set-cookie": "unifises=deleted; Max-Age=0", "retry-after": "30" });
      }
    });
    const first = await h.status();
    expect(isAuthResult(first)).toBe(true);
    expect(first).toMatchObject({ authorized: false, processing: true, status: "verifying" });
    expect(h.records[0]).toMatchObject({ p_outcome: "unknown", p_evidence: { command_sent: true } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await h.status()).toMatchObject({ authorized: true, status: "confirmed" });
    expect(h.commands()).toHaveLength(1);
    const reads = h.requests.filter(request => request.url.endsWith("/stat/sta"));
    expect(reads).toHaveLength(2);
    expect(reads[1].headers.get("cookie")).toContain("unifises=session-2");
    expect(reads[1].headers.get("x-csrf-token")).toBe("csrf-2");
  });

  it("recovers an applied command after both a truncated response and a failed record RPC, with lease-fenced verification only", async () => {
    const h = transportHarness(request => {
      if (request.url.endsWith("/cmd/stamgr")) {
        h.applyAtController();
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"meta":{"rc":"ok"}'));
          controller.error(new Error("synthetic socket reset during body"));
        } }), { headers: { "content-type": "application/json" } });
      }
    }, true);
    expect(await h.status()).toMatchObject({ authorized: false, processing: true, status: "sending" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(await h.status()).toMatchObject({ authorized: false });
    expect(h.requests.filter(request => request.url.endsWith("/stat/sta"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(21000);
    expect(await h.status()).toMatchObject({ authorized: true, status: "confirmed" });
    expect(h.commands()).toHaveLength(1);
    expect(h.records.map(record => record.p_outcome)).toEqual(["unknown", "confirmed"]);
  });

  it.each(["401", "truncated"])("a %s preflight remains known unsent and a later fresh session can send once", async failure => {
    let first = true;
    const h = transportHarness(request => {
      if (first && request.url.endsWith("/stat/sta")) {
        first = false;
        return failure === "401" ? json({ meta: { rc: "error" } }, 401)
          : new Response('{"meta":{"rc":"ok"},"data":[', { headers: { "content-type": "application/json" } });
      }
    });
    expect(await h.status()).toMatchObject({ authorized: false, processing: true, status: "queued" });
    expect(h.commands()).toHaveLength(0);
    expect(h.records[0]).toMatchObject({ p_outcome: "not_sent", p_evidence: { command_sent: false } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await h.status()).toMatchObject({ authorized: false, status: "verifying" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await h.status()).toMatchObject({ authorized: true, status: "confirmed" });
    expect(h.commands()).toHaveLength(1);
    expect(h.commands()[0].headers.get("cookie")).toContain("unifises=session-2");
  });

  it.each(["login", "preflight"])("A2-T02: preserves Retry-After for a proven-unsent %s 429 so scheduling can respect the controller cooldown", async phase => {
    const h = transportHarness(request => {
      if ((phase === "login" && request.url.endsWith("/api/login")) || (phase === "preflight" && request.url.endsWith("/stat/sta"))) {
        return json({ meta: { rc: "error", msg: "rate limited" } }, 429, { "retry-after": "30" });
      }
    });
    const result = await h.command();
    expect(result).toMatchObject({ status: "unknown", command_sent: false, retryable: true });
    expect(h.commands()).toHaveLength(0);
    expect(result.retry_after_ms).toBe(30000);
  });

  it("A2-T03: a timed-out AP lookup during verification does not prevent the next healthy status read from confirming", async () => {
    const h = transportHarness();
    expect(await h.status()).toMatchObject({ authorized: false, status: "verifying" });
    await vi.advanceTimersByTimeAsync(2000);
    const original = h.db.from.bind(h.db);
    let failOnce = true;
    h.db.from = (table: string) => {
      if (table === "store_access_points" && failOnce) {
        failOnce = false;
        return query(null, new Promise(resolve => setTimeout(() => resolve(response(null, { code: "SYNTHETIC_AP_LOOKUP_FAILURE" })), 6100)));
      }
      return original(table);
    };
    const startedAt = Date.now();
    let completedAt: number | undefined;
    const failedRead = h.status().then(result => { completedAt = Date.now(); return result; });
    await vi.advanceTimersByTimeAsync(6100);
    expect(await failedRead).toMatchObject({ authorized: false, status: "verifying" });
    // Inline status has 20s total and reserves 16s for the adapter/record.
    // Preparation therefore times out in 4s; the scheduled 6.1s lookup error
    // arrives after this response and cannot become the observed failure.
    expect(completedAt).toBeDefined();
    expect(completedAt! - startedAt).toBeLessThanOrEqual(6100);
    expect(h.commands()).toHaveLength(1);
    expect(h.requests.filter(request => request.url.endsWith("/stat/sta"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    // Allow the full ordinary SQL retry range (1..10s), without prescribing
    // whether recovery records pending or uses an equivalent fenced release.
    // No new command is necessary or permitted to recover.
    expect(await h.status(), `AP lookup response completed after ${completedAt! - startedAt}ms; the healthy read is still waiting for its old lease`)
      .toMatchObject({ authorized: true, status: "confirmed" });
    expect(h.commands()).toHaveLength(1);
  });
});

describe("second audit: admission before the durable operation exists", () => {
  it.each(["rate_limit_hit", "resolve_portal_identity", "createUser"])("A2-T01: bounds a stalled %s dependency before the 120s authorization objective expires", async stalled => {
    let release!: () => void, finished = false;
    const held = new Promise<ReturnType<typeof response>>(resolve => { release = () => resolve(response(null, { code: "SYNTHETIC_OFFLINE" })); });
    const db = {
      rpc: vi.fn(async (name: string) => {
        if (name === stalled) return held;
        if (name === "get_captive_auth_operation") return response({ disposition: "awaiting_identity", authorized: false, processing: false, status: "awaiting_identity" });
        if (name === "rate_limit_hit") return response({ allowed: true, remaining: 10 });
        if (name === "resolve_portal_identity") return response([{ resolution_status: "new", user_id: null }]);
        throw new Error(`Unexpected RPC ${name}`);
      }),
      auth: { admin: { createUser: vi.fn(() => held) } },
    };
    const authorize = vi.fn(async () => ({ authorized: false }));
    const context = vm.createContext({ ...baseContext(db),
      getPublicIp: () => "192.0.2.1", getTraceId: () => "synthetic", normalizeBrazilianPhone: (value: string) => value,
      Validators: { phone: () => true, cpf: () => true }, getValidatedAuthContext: async () => ({
        ctx: { clientMac: MAC, apMac: AP, ssid: "Wifi" }, attemptId: ATTEMPT, resumeToken: TOKEN,
      }), authorizeAuthenticatedUser: authorize,
    });
    vm.runInContext(handlers, context);
    const run = (context.handleIdentity(new Request("https://portal.invalid/identify", { method: "POST",
      body: JSON.stringify({ phone: profile.phone_digits, cpf: profile.cpf_digits, attempt_id: ATTEMPT, resume_token: TOKEN }) })) as Promise<Response>)
      .then(() => { finished = true; }, () => { finished = true; });
    try {
      await vi.advanceTimersByTimeAsync(120001);
      expect(authorize).not.toHaveBeenCalled();
      expect(finished, `identify remained pending after 120s in ${stalled}, with no durable operation`).toBe(true);
    } finally { release(); await run; }
  });

  it.each(["stores", "global_settings"])("A2-T01: bounds the %s read before join, instead of leaving a valid identified client outside recovery", async stalled => {
    let release!: () => void, finished = false;
    const held = new Promise<ReturnType<typeof response>>(resolve => { release = () => resolve(response(null, { code: "SYNTHETIC_OFFLINE" })); });
    const db = { rpc: vi.fn(async () => { throw new Error("JOIN_MUST_NOT_RUN_WITHOUT_CONFIGURATION"); }),
      from: (table: string) => query(table === "stores" ? { is_active: true, unifi_controller_url: ROOT, unifi_site_id: "default" }
        : { session_duration_minutes: 40, max_daily_accesses: 0 }, table === stalled ? held : undefined) };
    const context = vm.createContext(baseContext(db));
    vm.runInContext(handlers, context);
    const run = (context.authorizeDurably({ db, attemptId: ATTEMPT, resumeToken: TOKEN, userId: USER, profile,
      ctx: { clientMac: MAC, apMac: AP, ssid: "Wifi", captiveTimestamp: "synthetic" },
      authMethod: "identity", traceId: "synthetic", clientIp: "192.0.2.1", userAgent: "synthetic",
    }, STORE, "povao", "https://destination.invalid/") as Promise<unknown>)
      .then(() => { finished = true; }, () => { finished = true; });
    try {
      await vi.advanceTimersByTimeAsync(120001);
      expect(db.rpc).not.toHaveBeenCalled();
      expect(finished, `authorizeDurably remained pending after 120s before join (${stalled})`).toBe(true);
    } finally { release(); await run; }
  });
});
