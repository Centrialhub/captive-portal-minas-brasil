/**
 * Shared utilities for the captive portal.
 */

/**
 * Public HTTP base URL for the captive portal.
 *
 * The Android Captive Network Assistant aborts with a certificate error if
 * we redirect the client to HTTPS during the captive flow. We MUST keep the
 * client in HTTP same-origin while the user is being authorized.
 */
export const PUBLIC_CAPTIVE_BASE_URL = "http://wifi.guedesepaixao.com.br";

/** Kept exported for backward-compat. NOT used as a client fallback anymore. */
export const SUPABASE_DIRECT_BASE =
  "https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal";

/**
 * Returns the API base for portal calls.
 *
 * Always uses the same-origin proxy `/api/captive-portal`. The previous
 * HTTPS Supabase fallback was removed because it forced the captive
 * assistant onto an HTTPS host before the user was authorized, triggering
 * certificate errors on Android.
 */
export function getApiBase(): string {
  return "/api/captive-portal";
}

/**
 * Returns a safe HTTP URL that we can hand to `window.location.href` during
 * the captive flow. Blocks HTTPS, controller hosts, raw IPs and Supabase
 * direct URLs — anything that would trigger the Android CNA cert error.
 */
export function sanitizeCaptiveRedirect(url: string | null | undefined): string {
  const store = (() => {
    try {
      return new URLSearchParams(window.location.search).get("store") || "matriz";
    } catch { return "matriz"; }
  })();
  const safeFallback = `${PUBLIC_CAPTIVE_BASE_URL}/?success=1&store=${encodeURIComponent(store)}`;
  if (!url) return safeFallback;
  try {
    const u = new URL(url, PUBLIC_CAPTIVE_BASE_URL);
    if (u.protocol !== "http:") return safeFallback;
    const h = u.hostname.toLowerCase();
    if (
      h === "31.97.170.23" ||
      h.indexOf("rwificontroller") !== -1 ||
      h.endsWith("supabase.co") ||
      h.endsWith(".supabase.co")
    ) return safeFallback;
    if (u.port === "8443") return safeFallback;
    return u.toString();
  } catch {
    return safeFallback;
  }
}

const TRACE_KEY = "mb_trace_id";

export function getOrCreateTraceId(): string {
  try {
    const existing = sessionStorage.getItem(TRACE_KEY);
    if (existing && existing.length <= 64) return existing;
  } catch { /* ignore */ }
  const t = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try { sessionStorage.setItem(TRACE_KEY, t); } catch { /* ignore */ }
  return t;
}

export function traceHeaders(): Record<string, string> {
  return { "x-trace-id": getOrCreateTraceId() };
}

export interface UnifiQueryParams {
  client_mac?: string;
  ap_mac?: string;
  ssid?: string;
  redirect_url?: string;
  captive_timestamp?: string;
  site?: string;
  raw_query?: string;
}

export function getQueryParams(): UnifiQueryParams {
  const p = new URLSearchParams(window.location.search);
  return {
    client_mac: p.get("id") || p.get("mac") || undefined,
    ap_mac: p.get("ap") || undefined,
    ssid: p.get("ssid") || undefined,
    redirect_url: p.get("url") || undefined,
    captive_timestamp: p.get("t") || undefined,
    site: p.get("site") || undefined,
    raw_query: window.location.search.replace(/^\?/, "") || undefined,
  };
}

export interface SubmitPayload {
  session_id?: string;
  name: string;
  email: string;
  phone: string;
  cpf: string;
  client_mac: string;
  ap_mac: string;
  ssid: string;
  redirect_url: string;
  captive_timestamp: string;
  site: string;
  original_unifi_url_params: {
    id: string;
    ap: string;
    ssid: string;
    url: string;
    t: string;
    site: string;
    raw_query: string;
  };
  user_agent: string;
  consent_version: string;
}

export function buildSubmitPayload(fields: {
  session_id?: string;
  name: string;
  email: string;
  phone: string;
  cpf: string;
  client_mac?: string;
  consent_version: string;
}): SubmitPayload {
  const q = getQueryParams();
  const phoneDigits = (fields.phone || "").replace(/\D/g, "");
  const cpfDigits = (fields.cpf || "").replace(/\D/g, "");
  const clientMac = fields.client_mac || q.client_mac || "";
  const apMac = q.ap_mac || "";
  const ssid = q.ssid || "";
  const redirectUrl = q.redirect_url || "";
  const captiveTs = q.captive_timestamp || "";
  const site = q.site || "";
  const rawQuery = q.raw_query || "";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return {
    session_id: fields.session_id || undefined,
    name: fields.name,
    email: fields.email || "",
    phone: phoneDigits,
    cpf: cpfDigits,
    client_mac: clientMac,
    ap_mac: apMac,
    ssid,
    redirect_url: redirectUrl,
    captive_timestamp: captiveTs,
    site,
    original_unifi_url_params: {
      id: clientMac,
      ap: apMac,
      ssid,
      url: redirectUrl,
      t: captiveTs,
      site,
      raw_query: rawQuery,
    },
    user_agent: ua,
    consent_version: fields.consent_version,
  };
}

export type PortalStep = "loading" | "form" | "otp" | "success" | "error";
