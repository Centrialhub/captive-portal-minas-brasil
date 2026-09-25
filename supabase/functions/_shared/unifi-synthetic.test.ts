import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as transport from "./unifi-authorization";
import * as cookies from "./unifi-cookie";

// Real Edge function bodies, synthetic HTTP only. The injected fetcher rejects
// unexpected endpoints, so this suite cannot contact a controller.
const source = fs.readFileSync(new URL("../captive-portal/index.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("edge.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["unifiTryLogin", "unifiLogin", "buildUnifiHeaders", "unifiNetworkEndpoint",
  "unifiAuthorizeCommandOnly", "unifiCheckAuthorizationOnly"]);
const selected = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text || ""));
if (selected.length !== names.size) throw new Error("Synthetic adapter extraction incomplete");
const compiled = ts.transpileModule(selected.map(node => node.getText(tree)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const ROOT = "https://controller.invalid/povao";
const MAC = "001122334455";
const AP = "AABBCCDDEEFF";
const CONTEXT = { apMac: AP, ssid: "Wifi", trustedApMacs: [AP], minutes: 40 };
const station = (authorized = false) => ({ mac: MAC, ap_mac: AP, essid: "Wifi", authorized });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
const delay = <T>(milliseconds: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), milliseconds));
type RequestRecord = { url: string; method: string; headers: Headers; body: string; time: number; redirect?: RequestRedirect };
type Handler = (request: RequestRecord) => Response | Promise<Response> | undefined;

function harness(handler: Handler = () => undefined, mode = "legacy") {
  const requests: RequestRecord[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const request = { url, method: init.method || "GET", headers: new Headers(init.headers),
      body: String(init.body || ""), time: Date.now(), redirect: init.redirect };
    requests.push(request);
    const supplied = await handler(request);
    if (supplied) return supplied;
    if (url === `${ROOT}/`) return new Response("warm", { headers: { "set-cookie": "unifi_controller=povao; Path=/" } });
    if (url.endsWith("/api/login")) return json({ meta: { rc: "ok" } }, 200, { "set-cookie": "unifises=session-1; HttpOnly" });
    if (url.endsWith("/stat/sta")) return json({ meta: { rc: "ok" }, data: [station()] });
    if (url.endsWith("/cmd/stamgr")) return json({ meta: { rc: "ok" }, data: [] });
    throw new Error(`Unexpected synthetic endpoint: ${url}`);
  });
  const context = vm.createContext({ ...transport, ...cookies, Date, URL,
    UNIFI_TIMEOUT_MS: 10_000, UNIFI_USERNAME: "synthetic", UNIFI_PASSWORD: "synthetic", UNIFI_AUTH_MODE: mode,
    createUnifiHttpClient: () => null,
    fetch: () => { throw new Error("Real network prohibited"); },
    fetchUnifiResponse: (url: string, init: RequestInit, deadline: number) => transport.fetchUnifiResponse(url, init, deadline, fetcher),
    fetchUnifiStationsStrict: (url: string, init: RequestInit, deadline: number) => transport.fetchUnifiStationsStrict(url, init, deadline, fetcher),
    sendUnifiAuthorizeOnce: (url: string, init: RequestInit, mac: string, options: { apMac?: string; minutes?: number }, deadline: number) =>
      transport.sendUnifiAuthorizeOnce(url, init, mac, options, deadline, fetcher),
  });
  vm.runInContext(compiled, context);
  return {
    requests,
    commands: () => requests.filter(request => request.url.endsWith("/cmd/stamgr")),
    command: (options: Record<string, unknown> = {}) => context.unifiAuthorizeCommandOnly(ROOT, "default", MAC,
      undefined, undefined, { ...CONTEXT, ...options }) as Promise<transport.UnifiCommandResult>,
    verify: () => context.unifiCheckAuthorizationOnly(ROOT, "default", MAC,
      undefined, undefined, CONTEXT) as Promise<transport.UnifiAuthorizationEvidence>,
    login: (timeout = 4000) => context.unifiLogin(ROOT, null, undefined, undefined, timeout) as Promise<{ ok: boolean; error?: string }>,
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("synthetic transport failures through real UniFi adapters", () => {
  it("retains uncertainty after the controller commits but its partial response errors, then confirms by read only", async () => {
    let committed = false;
    const h = harness(request => {
      if (request.url.endsWith("/stat/sta")) return json({ meta: { rc: "ok" }, data: [station(committed)] });
      if (request.url.endsWith("/cmd/stamgr")) {
        committed = true;
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"meta":{"rc":"ok"}'));
          controller.error(new Error("synthetic socket closed after partial response"));
        } }), { headers: { "content-type": "application/json" } });
      }
    });
    expect(await h.command()).toMatchObject({ status: "unknown", command_sent: true, retryable: false });
    expect(await h.verify()).toMatchObject({ state: "authorized", effective_mac: MAC });
    expect(h.commands()).toHaveLength(1);
  });

  it("does not claim a controller rejection when transport loses an outbound request before application", async () => {
    const h = harness(request => {
      if (request.url.endsWith("/cmd/stamgr")) throw new Error("synthetic connection reset during request upload");
    });
    expect(await h.command()).toMatchObject({ status: "unknown", command_sent: true, retryable: false });
    expect(await h.verify()).toMatchObject({ state: "not_authorized" });
    expect(h.commands()).toHaveLength(1);
  });

  it("shares the full 14 second deadline across warm-up, login, station headers and the command body", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const h = harness(request => {
      if (request.url === `${ROOT}/`) return delay(900, new Response("warm"));
      if (request.url.endsWith("/api/login")) return delay(2900, json({ meta: { rc: "ok" } }, 200, { "set-cookie": "unifises=s" }));
      if (request.url.endsWith("/stat/sta")) return delay(2900, json({ meta: { rc: "ok" }, data: [station()] }));
      if (request.url.endsWith("/cmd/stamgr")) return new Response(new ReadableStream({ start(controller) {
        setTimeout(() => { controller.enqueue(new TextEncoder().encode('{"meta":{"rc":"ok"}}')); controller.close(); }, 7400);
      } }), { headers: { "content-type": "application/json" } });
    });
    let completed = false;
    const pending = h.command().then(value => { completed = true; return value; });
    await vi.advanceTimersByTimeAsync(13999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: "unknown", command_sent: true });
    expect(h.commands()).toHaveLength(1);
    expect(h.commands()[0].time).toBe(6700);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.commands()).toHaveLength(1);
  });

  it("stops before POST when the station body fails after valid headers", async () => {
    const h = harness(request => {
      if (request.url.endsWith("/stat/sta")) return new Response(new ReadableStream({ start(controller) {
        controller.error(new Error("synthetic failed station response body"));
      } }), { headers: { "content-type": "application/json" } });
    });
    expect(await h.command()).toMatchObject({ status: "unknown", command_sent: false, retryable: true });
    expect(h.commands()).toHaveLength(0);
  });

  it.each(["headers", "body"])("SYN-U1 rejects an acknowledgment received after a runtime pause at %s", async phase => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const fetcher = vi.fn(async () => {
      if (phase === "headers") vi.setSystemTime(101);
      const response = json({ meta: { rc: "ok" } });
      if (phase === "body") {
        const read = response.text.bind(response);
        response.text = async () => { const result = await read(); vi.setSystemTime(101); return result; };
      }
      return response;
    });
    // Moving Date without advancing timers models an overdue timer whose callback
    // has not run yet after a suspended runtime resumes its resolved promise.
    expect(await transport.sendUnifiAuthorizeOnce("https://controller.invalid/cmd", {}, MAC, {}, 100, fetcher))
      .toMatchObject({ status: "unknown", command_sent: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("synthetic authentication and session rollover", () => {
  it.each([
    { name: "redirect with an auth cookie", reply: () => new Response(null, { status: 302,
      headers: { "set-cookie": "unifises=redirect-placeholder", location: "https://unexpected.invalid/login" } }) },
    { name: "explicit JSON login rejection with an auth cookie", reply: () => json({ meta: { rc: "error", msg: "invalid credentials" } },
      200, { "set-cookie": "unifises=rejected-placeholder" }) },
  ])("SYN-U2 refuses $name", async ({ reply }) => {
    const h = harness(request => request.url.endsWith("/api/login") ? reply() : undefined);
    expect((await h.login()).ok).toBe(false);
    expect(h.requests.every(request => request.redirect === "manual")).toBe(true);
  });

  it("negotiates OS then legacy login within a single deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const h = harness(request => {
      if (request.url.endsWith("/api/auth/login")) return new Promise<Response>(() => {});
      if (request.url.endsWith("/api/login")) return delay(1000, json({ meta: { rc: "ok" } }, 200, { "set-cookie": "unifises=legacy" }));
    }, "auto");
    const result = h.login();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toMatchObject({ ok: true });
    expect(Date.now()).toBe(3000);
    expect(h.commands()).toHaveLength(0);
  });

  it.each([{ body: {} }, { body: { meta: { rc: "unexpected" } } }, { body: { meta: {} } }, { body: [] }])("legacy login rejects malformed success JSON $body even with a session cookie", async ({ body }) => {
    const h = harness(request => request.url.endsWith("/api/login")
      ? json(body, 200, { "set-cookie": "unifises=placeholder" }) : undefined);
    expect((await h.login()).ok).toBe(false);
    expect(h.commands()).toHaveLength(0);
  });

  it("OS login cannot use TOKEN to override an explicit controller rejection", async () => {
    const h = harness(request => request.url.endsWith("/api/auth/login")
      ? json({ meta: { rc: "error" } }, 200, { "set-cookie": "TOKEN=placeholder" }) : undefined, "unifi-os");
    expect((await h.login()).ok).toBe(false);
    expect(h.commands()).toHaveLength(0);
  });

  it("preserves proxy routing and derives CSRF from the OS token without following redirects", async () => {
    const payload = btoa(JSON.stringify({ csrfToken: "csrf-in-token" })).replace(/=/g, "");
    const token = `header.${payload}.signature`;
    const h = harness(request => request.url.endsWith("/api/auth/login")
      ? json({ unique_id: "synthetic-os" }, 200, { "set-cookie": `TOKEN=${token}; HttpOnly` }) : undefined, "unifi-os");
    expect(await h.command()).toMatchObject({ status: "accepted" });
    const command = h.commands()[0];
    expect(command.url).toBe("https://controller.invalid/proxy/network/api/s/default/cmd/stamgr");
    expect(command.headers.get("cookie")).toContain("unifi_controller=povao");
    expect(command.headers.get("cookie")).toContain(`TOKEN=${token}`);
    expect(command.headers.get("x-csrf-token")).toBe("csrf-in-token");
    expect(h.requests.every(request => request.redirect === "manual")).toBe(true);
  });

  it("SYN-U3 carries a session and CSRF rotation from station response into the command", async () => {
    const h = harness(request => {
      if (request.url.endsWith("/stat/sta")) return json({ meta: { rc: "ok" }, data: [station()] }, 200,
        { "set-cookie": "unifises=session-2; HttpOnly", "x-csrf-token": "csrf-2" });
      if (request.url.endsWith("/cmd/stamgr")) {
        const correct = request.headers.get("cookie")?.includes("unifises=session-2") && request.headers.get("x-csrf-token") === "csrf-2";
        return correct ? json({ meta: { rc: "ok" } }) : json({ meta: { rc: "error", msg: "expired session" } }, 401);
      }
    });
    expect(await h.command()).toMatchObject({ status: "accepted", command_sent: true });
    expect(h.commands()).toHaveLength(1);
  });

  it("derives fresh CSRF from a rotated OS token instead of reusing the login header", async () => {
    const token = (csrf: string) => `header.${btoa(JSON.stringify({ csrfToken: csrf })).replace(/=/g, "")}.signature`;
    const h = harness(request => {
      if (request.url.endsWith("/api/auth/login")) return json({ unique_id: "synthetic-os" }, 200,
        { "set-cookie": `TOKEN=${token("old-csrf")}`, "x-csrf-token": "old-csrf" });
      if (request.url.endsWith("/stat/sta")) return json({ meta: { rc: "ok" }, data: [station()] }, 200,
        { "set-cookie": `TOKEN=${token("new-csrf")}` });
      if (request.url.endsWith("/cmd/stamgr")) {
        expect(request.headers.get("cookie")).toContain(`TOKEN=${token("new-csrf")}`);
        expect(request.headers.get("cookie")).toContain("unifi_controller=povao");
        expect(request.headers.get("x-csrf-token")).toBe("new-csrf");
      }
    }, "unifi-os");
    expect(await h.command()).toMatchObject({ status: "accepted", command_sent: true });
    expect(h.commands()).toHaveLength(1);
  });

  it("keeps an expired authentication session proven unsent when the station response revokes it", async () => {
    const h = harness(request => request.url.endsWith("/stat/sta")
      ? json({ meta: { rc: "ok" }, data: [station()] }, 200, { "set-cookie": "unifises=deleted; Max-Age=0" }) : undefined);
    expect(await h.command()).toMatchObject({ status: "unknown", command_sent: false, retryable: true,
      reason: "UNIFI_SESSION_EXPIRED_DURING_PREFLIGHT" });
    expect(h.commands()).toHaveLength(0);
  });

  it.each(["Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"])("SYN-U4 removes nonempty auth cookies invalidated with %s", attribute => {
    expect(cookies.mergeSetCookieValues({ unifises: "old", unifi_controller: "povao" },
      [`unifises=deleted; ${attribute}; Path=/`])).toEqual({ unifi_controller: "povao" });
  });
});

describe("synthetic changing station context and malformed HTTP success", () => {
  it.each(["ap_mac", "essid"])("does not falsely confirm when %s disappears after an accepted command", async missing => {
    let readCount = 0;
    const h = harness(request => {
      if (request.url.endsWith("/stat/sta")) {
        readCount += 1;
        const observed: Record<string, unknown> = station(readCount > 1);
        if (readCount > 1) delete observed[missing];
        return json({ meta: { rc: "ok" }, data: [observed] });
      }
    });
    expect(await h.command()).toMatchObject({ status: "accepted", command_sent: true });
    expect(await h.verify()).toMatchObject({ state: "inconclusive", authorized: null, reason: "STATION_CONTEXT_MISMATCH" });
    expect(h.commands()).toHaveLength(1);
  });

  it.each(["0001122334455", "00112233445G", "prefix001122334455", "00:11-22:33:44:55"])("does not turn near MAC %s into an exact observed device", async mac => {
    const h = harness(request => request.url.endsWith("/stat/sta")
      ? json({ meta: { rc: "ok" }, data: [{ ...station(true), mac }] }) : undefined);
    expect(await h.command()).toMatchObject({ command_sent: false, reason: "CLIENT_NOT_OBSERVED" });
    expect(await h.verify()).toMatchObject({ state: "inconclusive", found: false });
    expect(h.commands()).toHaveLength(0);
  });

  it.each([201, 202, 206])("HTTP %s cannot conceal an explicit station-envelope error", async status => {
    const h = harness(request => request.url.endsWith("/stat/sta")
      ? json({ meta: { rc: "error" }, data: [station(true)] }, status) : undefined);
    expect(await h.command()).toMatchObject({ command_sent: false });
    expect(await h.verify()).toMatchObject({ state: "inconclusive", authorized: null });
    expect(h.commands()).toHaveLength(0);
  });

  it.each([{ authorized: [] }, { authorized: {} }, { authorized: "true" }, { authorized: 1 }])("HTTP 200 authorized=$authorized never confirms by truthiness", async ({ authorized }) => {
    const h = harness(request => request.url.endsWith("/stat/sta")
      ? json({ meta: { rc: "ok" }, data: [{ ...station(), authorized }] }) : undefined);
    expect(await h.command()).toMatchObject({ command_sent: false, reason: "INVALID_AUTHORIZATION_FLAG" });
    expect(await h.verify()).toMatchObject({ state: "inconclusive", authorized: null });
    expect(h.commands()).toHaveLength(0);
  });
});
