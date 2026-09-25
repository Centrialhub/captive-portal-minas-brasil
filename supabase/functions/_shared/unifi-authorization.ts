/** Pure UniFi transport/validation contract. No database writes or implicit retries. */
export type UnifiFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface UnifiStation {
  mac?: string;
  ap_mac?: string;
  essid?: string;
  authorized?: boolean;
  is_guest?: boolean;
  ip?: string;
  assoc_time?: number;
  [key: string]: unknown;
}

export interface UnifiCommandResult {
  status: "accepted" | "rejected" | "unknown";
  command_sent: boolean;
  retryable: boolean;
  reason?: string;
  accepted_at?: string;
  command_sent_at?: string;
  effective_mac: string;
  ap_mac_used?: string | null;
  latency_ms: number;
  http_status?: number;
  evidence?: Record<string, unknown>;
}

export interface UnifiAuthorizationEvidence {
  state: "authorized" | "not_authorized" | "inconclusive";
  found: boolean | null;
  authorized: boolean | null;
  effective_mac: string;
  reason?: string;
  evidence: Record<string, unknown>;
}

/** Accept canonical raw, colon, or hyphen notation; never strip arbitrary text. */
export function canonicalUnifiMac(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^(?:[a-fA-F0-9]{12}|(?:[a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}|(?:[a-fA-F0-9]{2}-){5}[a-fA-F0-9]{2})$/.test(text)) return null;
  return text.replace(/[:-]/g, "").toUpperCase();
}

export function formattedUnifiMac(value: unknown): string | null {
  const canonical = canonicalUnifiMac(value);
  return canonical ? canonical.match(/.{2}/g)!.join(":").toLowerCase() : null;
}

/** Deadline covers headers AND body. Race also bounds custom/mock fetchers. */
export async function fetchUnifiResponse(
  url: string,
  init: RequestInit,
  deadlineAt: number,
  fetcher: UnifiFetcher = fetch,
): Promise<{ status: number; ok: boolean; headers: Headers; body: string }> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("UNIFI_DEADLINE_EXCEEDED");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("UNIFI_DEADLINE_EXCEEDED"));
    }, remaining);
  });
  try {
    return await Promise.race([
      (async () => {
        response = await fetcher(url, { ...init, redirect: "manual", signal: controller.signal });
        if (controller.signal.aborted || Date.now() >= deadlineAt) {
          void response.body?.cancel().catch(() => {});
          throw new Error("UNIFI_DEADLINE_EXCEEDED");
        }
        const body = await response.text();
        if (controller.signal.aborted || Date.now() >= deadlineAt) throw new Error("UNIFI_DEADLINE_EXCEEDED");
        return { status: response.status, ok: response.ok, headers: response.headers, body };
      })(),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function parseUnifiEnvelope(body: string): { rc: string; data?: unknown[]; message?: string } | null {
  try {
    const parsed = object(JSON.parse(body));
    const meta = object(parsed?.meta);
    if (typeof meta?.rc !== "string") return null;
    return {
      rc: meta.rc,
      data: Array.isArray(parsed?.data) ? parsed.data : undefined,
      message: typeof meta.msg === "string" ? meta.msg : undefined,
    };
  } catch { return null; }
}

export async function fetchUnifiStationsStrict(
  url: string,
  init: RequestInit,
  deadlineAt: number,
  fetcher: UnifiFetcher = fetch,
): Promise<{ ok: boolean; data?: UnifiStation[]; headers?: Headers; error?: string; sessionExpired?: boolean }> {
  try {
    const response = await fetchUnifiResponse(url, { ...init, method: "GET" }, deadlineAt, fetcher);
    if (!response.ok) return {
      ok: false, error: `UNIFI_STATIONS_HTTP_${response.status}`,
      sessionExpired: [301, 302, 303, 307, 308, 401, 403].includes(response.status),
    };
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return { ok: false, error: "UNIFI_STATIONS_NON_JSON", sessionExpired: true };
    }
    const parsed = parseUnifiEnvelope(response.body);
    if (!parsed || parsed.rc !== "ok" || !parsed.data || parsed.data.some(row => !object(row))) {
      return { ok: false, error: "UNIFI_STATIONS_INVALID_ENVELOPE" };
    }
    return { ok: true, data: parsed.data as UnifiStation[], headers: response.headers };
  } catch { return { ok: false, error: "UNIFI_STATIONS_UNAVAILABLE" }; }
}

/** Only exact MAC evidence may change the target's authorization state. */
export function exactUnifiEvidence(
  stations: UnifiStation[],
  targetMac: string,
  options: { apMac?: string | null; ssid?: string | null; trustedApMacs?: readonly string[] } = {},
): UnifiAuthorizationEvidence {
  const mac = canonicalUnifiMac(targetMac);
  const base: UnifiAuthorizationEvidence = {
    state: "inconclusive", found: null, authorized: null, effective_mac: mac || "",
    evidence: { observed_at: new Date().toISOString(), exact_mac: true },
  };
  if (!mac) return { ...base, reason: "INVALID_MAC_ADDRESS" };
  const matches = stations.filter(station => canonicalUnifiMac(station.mac) === mac);
  if (matches.length !== 1) return {
    ...base, found: matches.length > 0, reason: matches.length ? "DUPLICATE_STATION_MAC" : "CLIENT_NOT_OBSERVED",
    evidence: { ...base.evidence, found: matches.length > 0, total_stations: stations.length },
  };
  const station = matches[0];
  const expectedAp = options.apMac ? canonicalUnifiMac(options.apMac) : null;
  const observedAp = canonicalUnifiMac(station.ap_mac);
  // The portal AP is an association hint and can become stale while this exact
  // client roams. Only a server-provided mapping for this store can permit that
  // change; an SSID alone cannot establish store membership.
  const trustedAps = new Set((options.trustedApMacs || []).map(canonicalUnifiMac).filter(Boolean));
  const roamedWithinStore = !!expectedAp && !!observedAp && observedAp !== expectedAp &&
    trustedAps.has(expectedAp) && trustedAps.has(observedAp) &&
    typeof options.ssid === "string" && options.ssid.length > 0 && station.essid === options.ssid;
  const evidence = {
    ...base.evidence, found: true, mac, ap_mac: observedAp,
    portal_ap_mac: expectedAp, roamed_within_store: roamedWithinStore,
    essid: typeof station.essid === "string" ? station.essid : null,
    authorized: typeof station.authorized === "boolean" ? station.authorized : null,
  };
  if ((options.apMac && (!expectedAp || (observedAp !== expectedAp && !roamedWithinStore))) ||
      (options.ssid && station.essid !== options.ssid)) {
    return { ...base, found: true, reason: "STATION_CONTEXT_MISMATCH", evidence };
  }
  if (typeof station.authorized !== "boolean") return { ...base, found: true, reason: "INVALID_AUTHORIZATION_FLAG", evidence };
  return {
    state: station.authorized ? "authorized" : "not_authorized", found: true,
    authorized: station.authorized, effective_mac: mac, evidence,
  };
}

/** One POST maximum. Unknown transport outcomes are never called rejections. */
export async function sendUnifiAuthorizeOnce(
  url: string,
  init: RequestInit,
  targetMac: string,
  options: { apMac?: string | null; minutes?: number },
  deadlineAt: number,
  fetcher: UnifiFetcher = fetch,
): Promise<UnifiCommandResult> {
  const startedAt = Date.now();
  const mac = canonicalUnifiMac(targetMac);
  const ap = options.apMac ? formattedUnifiMac(options.apMac) : null;
  const result: UnifiCommandResult = {
    status: "unknown", command_sent: false, retryable: false,
    effective_mac: mac || "", ap_mac_used: ap, latency_ms: 0,
  };
  if (!mac || (options.apMac && !ap)) return { ...result, status: "rejected", reason: "INVALID_MAC_ADDRESS" };
  if (deadlineAt <= Date.now()) return { ...result, retryable: true, reason: "UNIFI_DEADLINE_EXCEEDED" };
  const payload: Record<string, unknown> = {
    cmd: "authorize-guest", mac: formattedUnifiMac(mac),
    minutes: Math.max(1, Math.min(1440, options.minutes ?? 1440)),
  };
  if (ap) payload.ap_mac = ap;
  result.command_sent = true;
  result.command_sent_at = new Date().toISOString();
  try {
    const response = await fetchUnifiResponse(url, {
      ...init, method: "POST", body: JSON.stringify(payload),
    }, deadlineAt, fetcher);
    const parsed = response.headers.get("content-type")?.toLowerCase().includes("application/json")
      ? parseUnifiEnvelope(response.body) : null;
    const common = { ...result, http_status: response.status, latency_ms: Date.now() - startedAt };
    // A proxy/transport failure may follow a committed command. Never retry it here.
    if (response.status >= 500 || !parsed || !response.ok) return {
      ...common, reason: `UNIFI_COMMAND_OUTCOME_UNKNOWN${response.status ? `_${response.status}` : ""}`,
    };
    if (parsed.rc === "ok") return { ...common, status: "accepted", accepted_at: new Date().toISOString() };
    if (parsed.rc === "error") return {
      ...common, status: "rejected", reason: "UNIFI_COMMAND_EXPLICITLY_REJECTED",
      evidence: { explicit_rejection: true, http_status: response.status, controller_rc: "error" },
    };
    return { ...common, reason: "UNIFI_COMMAND_INVALID_RESULT" };
  } catch { return { ...result, latency_ms: Date.now() - startedAt, reason: "UNIFI_COMMAND_OUTCOME_UNKNOWN" }; }
}
