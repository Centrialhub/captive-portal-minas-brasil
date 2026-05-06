/**
 * Shared utilities for the captive portal.
 */

export function getApiBase(): string {
  const host = window.location.hostname;
  if (host === "wifi.guedesepaixao.com.br" || host.endsWith(".vercel.app")) {
    return "/api/captive-portal";
  }
  return "https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal";
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

export function buildSubmitPayload(fields: {
  session_id?: string;
  name: string;
  email: string;
  phone: string;
  cpf: string;
  client_mac?: string;
  consent_version: string;
}) {
  const q = getQueryParams();
  return {
    session_id: fields.session_id || undefined,
    name: fields.name,
    email: fields.email || "",
    phone: fields.phone,
    cpf: fields.cpf,
    client_mac: fields.client_mac || q.client_mac || "",
    consent_version: fields.consent_version,
  };
}

export type PortalStep = "loading" | "form" | "otp" | "success" | "error";
