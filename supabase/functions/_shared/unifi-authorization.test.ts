import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalUnifiMac,
  exactUnifiEvidence,
  fetchUnifiResponse,
  fetchUnifiStationsStrict,
  sendUnifiAuthorizeOnce,
} from "./unifi-authorization";

const MAC = "001122334455";
const AP = "AABBCCDDEEFF";
const ROAM_AP = "AABBCCDDEE00";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

afterEach(() => vi.useRealTimers());

describe("exact UniFi evidence", () => {
  it("normalizes MAC delimiters without accepting arbitrary stripped text", () => {
    expect(canonicalUnifiMac("aa:bb:cc:dd:ee:ff")).toBe(AP);
    expect(canonicalUnifiMac("aa-bb-cc-dd-ee-ff")).toBe(AP);
    expect(canonicalUnifiMac("xxx001122334455")).toBeNull();
    expect(canonicalUnifiMac("00:11-22:33:44:55")).toBeNull();
  });

  it("does not authorize the sole other client or infer rejection from absence", () => {
    const result = exactUnifiEvidence([
      { mac: "00:11:22:33:44:66", authorized: true },
    ], MAC);
    expect(result).toMatchObject({ state: "inconclusive", found: false, authorized: null, reason: "CLIENT_NOT_OBSERVED" });
  });

  it.each([undefined, null, "false", "true", 1, 0])("rejects non-boolean authorized=%s", value => {
    expect(exactUnifiEvidence([{ mac: MAC, authorized: value as boolean }], MAC)).toMatchObject({
      state: "inconclusive", reason: "INVALID_AUTHORIZATION_FLAG",
    });
  });

  it("only uses a single exact MAC matching the association context", () => {
    const station = { mac: "00:11:22:33:44:55", ap_mac: "aa:bb:cc:dd:ee:ff", essid: "Wifi", authorized: true };
    expect(exactUnifiEvidence([station], MAC, { apMac: AP, ssid: "Wifi" }).state).toBe("authorized");
    expect(exactUnifiEvidence([station], MAC, { apMac: "AABBCCDDEE00" }).reason).toBe("STATION_CONTEXT_MISMATCH");
    expect(exactUnifiEvidence([station], MAC, { ssid: "Other" }).reason).toBe("STATION_CONTEXT_MISMATCH");
    expect(exactUnifiEvidence([station, station], MAC).reason).toBe("DUPLICATE_STATION_MAC");
    expect(exactUnifiEvidence([{ ...station, authorized: false }], MAC).state).toBe("not_authorized");
  });

  it("accepts exact MAC roaming only within the server's store AP mapping and same SSID", () => {
    const result = exactUnifiEvidence([
      { mac: "00:11:22:33:44:55", ap_mac: "aa:bb:cc:dd:ee:00", essid: "Wifi", authorized: true },
    ], MAC, { apMac: AP, ssid: "Wifi", trustedApMacs: ["aa:bb:cc:dd:ee:ff", ROAM_AP] });
    expect(result).toMatchObject({ state: "authorized", effective_mac: MAC, authorized: true,
      evidence: { mac: MAC, ap_mac: ROAM_AP, portal_ap_mac: AP, roamed_within_store: true } });
  });

  it.each([
    { name: "foreign observed AP", trustedApMacs: [AP], ssid: "Wifi", observedSsid: "Wifi" },
    { name: "unmapped portal AP", trustedApMacs: [ROAM_AP], ssid: "Wifi", observedSsid: "Wifi" },
    { name: "missing mapping", trustedApMacs: undefined, ssid: "Wifi", observedSsid: "Wifi" },
    { name: "missing expected SSID", trustedApMacs: [AP, ROAM_AP], ssid: undefined, observedSsid: "Wifi" },
    { name: "empty expected SSID", trustedApMacs: [AP, ROAM_AP], ssid: "", observedSsid: "Wifi" },
    { name: "missing observed SSID", trustedApMacs: [AP, ROAM_AP], ssid: "Wifi", observedSsid: undefined },
    { name: "different SSID", trustedApMacs: [AP, ROAM_AP], ssid: "Wifi", observedSsid: "Other" },
  ])("keeps roaming inconclusive for $name", ({ trustedApMacs, ssid, observedSsid }) => {
    expect(exactUnifiEvidence([{ mac: MAC, ap_mac: ROAM_AP, essid: observedSsid, authorized: true }], MAC,
      { apMac: AP, ssid, trustedApMacs })).toMatchObject({
      state: "inconclusive", authorized: null, reason: "STATION_CONTEXT_MISMATCH",
    });
  });

  it("never uses roaming permission to choose a different or duplicate client MAC", () => {
    const options = { apMac: AP, ssid: "Wifi", trustedApMacs: [AP, ROAM_AP] };
    const station = { mac: MAC, ap_mac: ROAM_AP, essid: "Wifi", authorized: true };
    expect(exactUnifiEvidence([{ ...station, mac: "001122334466" }], MAC, options))
      .toMatchObject({ state: "inconclusive", reason: "CLIENT_NOT_OBSERVED" });
    expect(exactUnifiEvidence([station, { ...station, ap_mac: AP }], MAC, options))
      .toMatchObject({ state: "inconclusive", reason: "DUPLICATE_STATION_MAC" });
  });
});

describe("UniFi response validation", () => {
  it.each([
    {}, { data: [] }, { meta: { rc: "error" }, data: [] }, { meta: { rc: "ok" } },
    { meta: { rc: "ok" }, data: [null] }, { meta: { rc: "ok" }, data: {} },
  ])("does not turn anomalous JSON into a successful empty list", async body => {
    const result = await fetchUnifiStationsStrict("https://controller.test/stat/sta", {}, Date.now() + 1000, async () => json(body));
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
  });

  it("accepts an explicitly successful empty station list as an observation only", async () => {
    const result = await fetchUnifiStationsStrict("https://controller.test/stat/sta", {}, Date.now() + 1000,
      async () => json({ meta: { rc: "ok" }, data: [] }));
    expect(result).toEqual({ ok: true, data: [] });
    expect(exactUnifiEvidence(result.data!, MAC).state).toBe("inconclusive");
  });

  it("bounds a body that stalls after successful headers even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const response = new Response(new ReadableStream({ start() {} }), { status: 200 });
    const result = fetchUnifiResponse("https://controller.test/stall", {}, Date.now() + 100,
      async (_url, init) => { signal = init.signal; return response; });
    const assertion = expect(result).rejects.toThrow("UNIFI_DEADLINE_EXCEEDED");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
});

describe("single UniFi authorization command", () => {
  it("formats target and AP canonically and accepts only explicit controller rc=ok", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ cmd: "authorize-guest", mac: "00:11:22:33:44:55", ap_mac: "aa:bb:cc:dd:ee:ff", minutes: 60 });
      return json({ meta: { rc: "ok" }, data: [] });
    });
    const result = await sendUnifiAuthorizeOnce("https://controller.test/cmd", {}, MAC, { apMac: AP, minutes: 60 }, Date.now() + 1000, fetcher);
    expect(result).toMatchObject({ status: "accepted", command_sent: true, retryable: false });
    expect(result.accepted_at).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => json({ meta: { rc: "ok" } }, 502),
    () => json({ meta: { rc: "error" } }, 503),
    () => new Response("<html>login</html>", { status: 200 }),
    () => new Response("{broken", { status: 200, headers: { "content-type": "application/json" } }),
    () => json({ data: [] }),
    () => json({ meta: { rc: "unknown" } }),
    () => new Response(null, { status: 302, headers: { location: "/login" } }),
  ])("keeps ambiguous replies unknown without automatic resend", async makeResponse => {
    const fetcher = vi.fn(async () => makeResponse());
    const result = await sendUnifiAuthorizeOnce("https://controller.test/cmd", {}, MAC, {}, Date.now() + 1000, fetcher);
    expect(result).toMatchObject({ status: "unknown", command_sent: true, retryable: false });
    expect(result.accepted_at).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains unknown after a network error that may follow command application", async () => {
    const fetcher = vi.fn(async () => { throw new Error("connection reset after server commit"); });
    const result = await sendUnifiAuthorizeOnce("https://controller.test/cmd", {}, MAC, {}, Date.now() + 1000, fetcher);
    expect(result).toMatchObject({ status: "unknown", command_sent: true, retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("marks only an explicit successful HTTP controller error as rejected", async () => {
    const result = await sendUnifiAuthorizeOnce("https://controller.test/cmd", {}, MAC, {}, Date.now() + 1000,
      async () => json({ meta: { rc: "error", msg: "policy rejected" } }));
    expect(result).toMatchObject({ status: "rejected", command_sent: true, reason: "UNIFI_COMMAND_EXPLICITLY_REJECTED" });
  });

  it("does not send after the deadline and differentiates an unsent operation", async () => {
    const fetcher = vi.fn(async () => json({ meta: { rc: "ok" } }));
    expect(await sendUnifiAuthorizeOnce("https://controller.test/cmd", {}, MAC, {}, Date.now() - 1, fetcher)).toMatchObject({
      status: "unknown", command_sent: false, retryable: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a POST body timeout remains unknown and produces exactly one command", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start() {} }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const result = sendUnifiAuthorizeOnce("https://controller.test/cmd", {}, MAC, {}, Date.now() + 100, fetcher);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ status: "unknown", command_sent: true, retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
