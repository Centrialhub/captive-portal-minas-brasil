/**
 * Shared utilities for the captive portal.
 * Used by both React (App.tsx) and can be referenced for the HTML fallback logic.
 */

export function getApiBase(): string {
  const host = window.location.hostname;
  if (host === "wifi.guedesepaixao.com.br" || host.endsWith(".vercel.app")) {
    return "/api/captive-portal";
  }
  return "https://fqamejlyytrhovawgtwg.supabase.co/functions/v1/captive-portal";
}

export function getQueryParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    client_mac: p.get("id") || p.get("mac") || undefined,
    ap_mac: p.get("ap") || undefined,
    ssid: p.get("ssid") || undefined,
    redirect_url: p.get("url") || undefined,
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
  return {
    session_id: fields.session_id || undefined,
    name: fields.name,
    email: fields.email || "",
    phone: fields.phone,
    cpf: fields.cpf,
    client_mac: fields.client_mac || getQueryParams().client_mac || "",
    consent_version: fields.consent_version,
  };
}

export type PortalStep = "loading" | "form" | "otp" | "success" | "error";
