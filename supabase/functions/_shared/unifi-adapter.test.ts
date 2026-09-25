import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as authorization from "./unifi-authorization";
import * as cookies from "./unifi-cookie";

// Execute the real Edge adapter bodies with an injected network. This avoids
// importing Deno.serve or copying the implementation into a mock adapter.
const source = fs.readFileSync(new URL("../captive-portal/index.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("edge.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "unifiTryLogin", "unifiLogin", "buildUnifiHeaders", "unifiNetworkEndpoint",
  "unifiCheckAuthorizationOnly", "unifiAuthorizeCommandOnly", "unifiAuthorizeWithRetry",
  "authorizeClient",
]);
const selected = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text || ""));
if (selected.length !== names.size) throw new Error("Edge adapter extraction incomplete");
const compiled = ts.transpileModule(selected.map(node => node.getText(tree)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const MAC = "001122334455";
const AP = "AABBCCDDEEFF";
const ROAM_AP = "AABBCCDDEE00";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});

type NetworkOptions = {
  stations?: authorization.UnifiStation[];
  command?: () => Response;
  login?: () => Promise<Response>;
};
function harness(options: NetworkOptions = {}) {
  const commands: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/login")) return options.login
      ? await options.login()
      : json({ meta: { rc: "ok" } }, 200, { "set-cookie": "unifises=fake; HttpOnly" });
    if (url.endsWith("/stat/sta")) return json({ meta: { rc: "ok" }, data: options.stations || [] });
    if (url.endsWith("/cmd/stamgr")) {
      commands.push(JSON.parse(String(init.body)));
      return options.command ? options.command() : json({ meta: { rc: "ok" } });
    }
    return new Response("warmup", { status: 200, headers: { "set-cookie": "unifi_controller=povao" } });
  });
  const context = vm.createContext({
    ...authorization, ...cookies, Date, URL, UNIFI_TIMEOUT_MS: 10_000,
    UNIFI_USERNAME: "test", UNIFI_PASSWORD: "test", UNIFI_AUTH_MODE: "legacy",
    normalizeDailyAccessLimit: () => 0,
    createUnifiHttpClient: () => null,
    // Shared transport functions receive the same network fake as the wrapper.
    fetchUnifiResponse: (url: string, init: RequestInit, deadline: number) => authorization.fetchUnifiResponse(url, init, deadline, fetcher),
    fetchUnifiStationsStrict: (url: string, init: RequestInit, deadline: number) => authorization.fetchUnifiStationsStrict(url, init, deadline, fetcher),
    sendUnifiAuthorizeOnce: (url: string, init: RequestInit, mac: string, opts: { apMac?: string; minutes?: number }, deadline: number) => authorization.sendUnifiAuthorizeOnce(url, init, mac, opts, deadline, fetcher),
  });
  vm.runInContext(compiled, context);
  const command = (opts: Record<string, unknown> = {}) => context.unifiAuthorizeCommandOnly(
    "https://controller.test/povao", "default", MAC, undefined, undefined, opts,
  ) as Promise<authorization.UnifiCommandResult>;
  return { context, command, fetcher, commands };
}

function legacyDatabase(options: { locked?: boolean; writeError?: boolean } = {}) {
  const writes: Array<{ table: string; payload: Record<string, unknown> }> = [];
  return {
    writes,
    async rpc() { return { data: { allowed: !options.locked }, error: null }; },
    from(table: string) {
      let payload: Record<string, unknown> | undefined;
      const response = () => {
        if (payload) {
          writes.push({ table, payload });
          return options.writeError ? { error: { code: "TEST_WRITE_FAILURE" } } : { data: { id: "current-session" }, error: null };
        }
        return { data: table === "stores" ? { unifi_controller_url: "https://controller.test/povao", unifi_site_id: "default" }
          : table === "global_settings" ? { session_duration_minutes: 1 } : null, error: null };
      };
      const query = {
        select() { return query; }, eq() { return query; },
        update(value: Record<string, unknown>) { payload = value; return query; },
        insert(value: Record<string, unknown>) { payload = value; return query; },
        maybeSingle: async () => response(), single: async () => response(),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve),
      };
      return query;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("Edge adapter integration without production network", () => {
  it("does not use another station as identity and requires explicit trusted fallback", async () => {
    const h = harness({ stations: [{ mac: "001122334466", authorized: false, ap_mac: AP, essid: "Wifi" }] });
    expect(await h.command({ apMac: AP, ssid: "Wifi" })).toMatchObject({ status: "unknown", command_sent: false, reason: "CLIENT_NOT_OBSERVED" });
    expect(h.commands).toHaveLength(0);
    expect(await h.command({ apMac: AP, ssid: "Wifi", allowPortalMacFallback: true })).toMatchObject({ status: "accepted", command_sent: true });
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatchObject({ mac: "00:11:22:33:44:55", ap_mac: "aa:bb:cc:dd:ee:ff" });
  });

  it("does not accept fallback without a mapped AP context", async () => {
    const h = harness();
    expect(await h.command({ allowPortalMacFallback: true })).toMatchObject({ command_sent: false });
    expect(h.commands).toHaveLength(0);
  });

  it("does not send for a conflicting exact association", async () => {
    const h = harness({ stations: [{ mac: MAC, ap_mac: "AABBCCDDEE00", authorized: false }] });
    expect(await h.command({ apMac: AP, allowPortalMacFallback: true })).toMatchObject({ command_sent: false, reason: "STATION_CONTEXT_MISMATCH" });
    expect(h.commands).toHaveLength(0);
  });

  it("sends to the observed trusted AP while retaining the exact client MAC across roaming", async () => {
    const stations = [{ mac: MAC, ap_mac: ROAM_AP, essid: "Wifi", authorized: false }];
    const h = harness({ stations });
    const options = { apMac: AP, ssid: "Wifi", trustedApMacs: [AP, ROAM_AP] };
    expect(await h.command(options)).toMatchObject({ status: "accepted", command_sent: true,
      effective_mac: MAC, evidence: { ap_mac: ROAM_AP, portal_ap_mac: AP, roamed_within_store: true } });
    expect(h.commands).toEqual([expect.objectContaining({ mac: "00:11:22:33:44:55", ap_mac: "aa:bb:cc:dd:ee:00" })]);
    stations[0] = { ...stations[0], ap_mac: AP, authorized: true };
    expect(await h.context.unifiCheckAuthorizationOnly("https://controller.test/povao", "default", MAC,
      undefined, undefined, options)).toMatchObject({ state: "authorized", effective_mac: MAC });
    expect(h.commands).toHaveLength(1);
  });

  it("confirms an already authorized roaming client without a new command", async () => {
    const h = harness({ stations: [{ mac: MAC, ap_mac: ROAM_AP, essid: "Wifi", authorized: true }] });
    const options = { apMac: AP, ssid: "Wifi", trustedApMacs: [AP, ROAM_AP] };
    expect(await h.command(options)).toMatchObject({ reason: "ALREADY_AUTHORIZED", command_sent: false });
    expect(await h.context.unifiCheckAuthorizationOnly("https://controller.test/povao", "default", MAC,
      undefined, undefined, options)).toMatchObject({ state: "authorized", evidence: { roamed_within_store: true } });
    expect(h.commands).toHaveLength(0);
  });

  it.each([
    { name: "foreign AP", ssid: "Wifi", trustedApMacs: [AP] },
    { name: "missing SSID", ssid: undefined, trustedApMacs: [AP, ROAM_AP] },
    { name: "different SSID", ssid: "Other", trustedApMacs: [AP, ROAM_AP] },
  ])("does not send or confirm a roaming exact MAC with $name", async ({ ssid, trustedApMacs }) => {
    const h = harness({ stations: [{ mac: MAC, ap_mac: ROAM_AP, essid: "Wifi", authorized: true }] });
    const options = { apMac: AP, ssid, trustedApMacs, allowPortalMacFallback: true };
    expect(await h.command(options)).toMatchObject({ status: "unknown", command_sent: false, reason: "STATION_CONTEXT_MISMATCH" });
    expect(await h.context.unifiCheckAuthorizationOnly("https://controller.test/povao", "default", MAC,
      undefined, undefined, options)).toMatchObject({ state: "inconclusive" });
    expect(h.commands).toHaveLength(0);
  });

  it("roaming permissions preserve absence fallback on the portal AP and reject duplicate MACs", async () => {
    const stations = [{ mac: "001122334466", ap_mac: ROAM_AP, essid: "Wifi", authorized: true }];
    const h = harness({ stations });
    const options = { apMac: AP, ssid: "Wifi", trustedApMacs: [AP, ROAM_AP] };
    expect(await h.command(options)).toMatchObject({ command_sent: false, reason: "CLIENT_NOT_OBSERVED" });
    expect(await h.command({ ...options, allowPortalMacFallback: true })).toMatchObject({ command_sent: true });
    expect(h.commands[0]).toMatchObject({ mac: "00:11:22:33:44:55", ap_mac: "aa:bb:cc:dd:ee:ff" });
    stations.splice(0, 1, { mac: MAC, ap_mac: ROAM_AP, essid: "Wifi", authorized: false },
      { mac: MAC, ap_mac: AP, essid: "Wifi", authorized: false });
    expect(await h.command({ ...options, allowPortalMacFallback: true })).toMatchObject({ command_sent: false, reason: "DUPLICATE_STATION_MAC" });
    expect(h.commands).toHaveLength(1);
  });

  it("reuses exact current controller evidence without emitting a command", async () => {
    const h = harness({ stations: [{ mac: MAC, ap_mac: AP, authorized: true }] });
    const result = await h.command({ apMac: AP });
    expect(result).toMatchObject({ status: "accepted", command_sent: false, reason: "ALREADY_AUTHORIZED", evidence: { authorized: true, exact_mac: true } });
    expect(result.accepted_at).toBeUndefined();
    expect(h.commands).toHaveLength(0);
  });

  it("legacy compatibility does not resend an ambiguous accepted-or-lost command", async () => {
    const h = harness({ stations: [{ mac: MAC, authorized: false }], command: () => json({ meta: { rc: "ok" } }, 502) });
    const result = await h.context.unifiAuthorizeWithRetry("https://controller.test/povao", "default", MAC);
    expect(result).toMatchObject({ ok: false, command_outcome: "unknown", pending_confirmation: true, attempts: 1 });
    expect(result.cmd_accepted_at).toBeUndefined();
    expect(h.commands).toHaveLength(1);
  });

  it("keeps observation of absent exact MAC inconclusive", async () => {
    const h = harness({ stations: [{ mac: "001122334466", authorized: true }] });
    expect(await h.context.unifiCheckAuthorizationOnly("https://controller.test/povao", "default", MAC)).toMatchObject({
      state: "inconclusive", found: false, authorized: null,
    });
    expect(h.commands).toHaveLength(0);
  });

  it("an absolute lease deadline expires preparation before any command can be sent", async () => {
    vi.useFakeTimers();
    const h = harness({ login: () => new Promise(() => {}) });
    const result = h.command({ apMac: AP, allowPortalMacFallback: true, deadlineAt: Date.now() + 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ status: "unknown", command_sent: false });
    expect(h.commands).toHaveLength(0);
  });

  it("an explicit rejection retains its evidence through the Edge wrapper", async () => {
    const h = harness({ stations: [{ mac: MAC, authorized: false }], command: () => json({ meta: { rc: "error" } }) });
    expect(await h.command({ minutes: 1 })).toMatchObject({
      status: "rejected", evidence: { explicit_rejection: true, controller_rc: "error" },
    });
    expect(h.commands[0].minutes).toBe(1);
  });

  it("legacy device exclusion remains pending without a false reuse or terminal failure", async () => {
    const h = harness();
    const db = legacyDatabase({ locked: true });
    expect(await h.context.authorizeClient(db, "store", "other", MAC, "current-session", "192.0.2.1")).toMatchObject({
      ok: false, pending_confirmation: true, reason: "PROCESSING_IN_PROGRESS",
    });
    expect(db.writes[0]).toMatchObject({ table: "captive_sessions", payload: { status: "submitted" } });
    expect(h.commands).toHaveLength(0);
  });

  it("legacy persistence errors after controller success are surfaced for recovery", async () => {
    const h = harness({ stations: [{ mac: MAC, authorized: true }] });
    const db = legacyDatabase({ writeError: true });
    await expect(h.context.authorizeClient(db, "store", "other", MAC, "current-session", "192.0.2.1"))
      .rejects.toThrow("AUTHORIZATION_PERSISTENCE_UNCERTAIN");
    expect(h.commands).toHaveLength(0);
  });

  it("legacy unknown POST persists pending even without an accepted timestamp", async () => {
    const h = harness({ stations: [{ mac: MAC, authorized: false }], command: () => json({}, 502) });
    const db = legacyDatabase();
    const result = await h.context.authorizeClient(db, "store", "other", MAC, "current-session", "192.0.2.1");
    expect(result).toMatchObject({ ok: false, pending_confirmation: true, command_outcome: "unknown" });
    expect(result.cmd_accepted_at).toBeUndefined();
    expect(db.writes[0]).toMatchObject({ table: "captive_sessions", payload: { status: "submitted", fail_reason: "UNIFI_CONFIRMATION_PENDING" } });
    expect(h.commands).toHaveLength(1);
  });
});
