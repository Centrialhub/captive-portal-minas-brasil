/**
 * Shared utilities for the captive portal.
 */

/**
 * Public HTTPS base URL for the captive portal.
 *
 * The controllers now serve valid public certificates, so we can safely stay
 * on HTTPS end-to-end. HTTPS is also required for Google/Apple OAuth.
 */
export const PUBLIC_CAPTIVE_BASE_URL = "https://minasbrasilwifi.com.br";


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
 * Centralized logic to resolve the final destination after authorization.
 * Follows a strict priority and safety matrix.
 */
export function resolvePostAuthRedirect(
  backendUrl?: string | null,
  captiveUrl?: string | null
): string {
  const corporateFallback = "https://www.drogariaminasbrasil.com.br/";
  
  // Priority 1: Backend-provided URL (store-specific redirect)
  if (backendUrl && isSafeRedirect(backendUrl)) {
    return normalizeRedirectUrl(backendUrl);
  }
  
  // Priority 2: Original captive 'url' parameter
  if (captiveUrl && isSafeRedirect(captiveUrl)) {
    return normalizeRedirectUrl(captiveUrl);
  }
  
  // Fallback final
  return corporateFallback;
}

/**
 * Checks if a URL is safe to be used as a post-auth destination.
 */
export function isSafeRedirect(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url, PUBLIC_CAPTIVE_BASE_URL);
    
    // Protocol must be HTTPS (or we at least reject non-standard ones)
    // We strictly prefer HTTPS for the final destination.
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    
    const h = u.hostname.toLowerCase();
    
    // Block raw IPs
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
    
    // Block specific prohibited hosts
    const blockedHosts = [
      "minasbrasilwifi.com.br",
      "31.97.170.23",
      "187.77.48.59",
      "rwificontroller",
    ];
    if (blockedHosts.some(bh => h.includes(bh))) return false;
    
    // Block Supabase
    if (h.endsWith("supabase.co") || h.endsWith(".supabase.co")) return false;
    
    // Block non-standard ports
    if (u.port && u.port !== "80" && u.port !== "443") return false;
    
    // Block controller guest paths
    if (u.pathname.indexOf("/guest/s/") === 0) return false;
    
    // Block dangerous schemes
    if (/^(javascript|data|file):/i.test(url)) return false;

    return true;
  } catch {
    return false;
  }
}

function normalizeRedirectUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.toString();
  } catch {
    return url;
  }
}

export function sanitizeCaptiveRedirect(url: string | null | undefined): string {
  const q = getQueryParams();
  return resolvePostAuthRedirect(null, url || q.redirect_url);
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

/**
 * Validates a Brazilian CPF number using the official algorithm.
 * Rejects known invalid patterns (all same digits).
 * Returns true for formally valid CPFs; does NOT check if it exists at Receita Federal.
 */
export function isValidCPF(cpf: string): boolean {
  const digits = (cpf || "").replace(/\D/g, "");
  if (digits.length !== 11) return false;
  // Reject all same digits
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const calcDV = (base: string, weights: number[]): number => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) {
      sum += parseInt(base[i], 10) * weights[i];
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  const firstDV = calcDV(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (firstDV !== parseInt(digits[9], 10)) return false;

  const secondDV = calcDV(digits.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (secondDV !== parseInt(digits[10], 10)) return false;

  return true;
}

/**
 * Formats a raw CPF string into 000.000.000-00.
 * Non-digit characters are stripped first.
 */
export function formatCPF(value: string): string {
  const digits = (value || "").replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
}
