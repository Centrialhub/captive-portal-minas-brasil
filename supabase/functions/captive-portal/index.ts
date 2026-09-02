import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";
import {
  extractCsrfFromToken,
  isLikelyExpiredSessionResponse,
  mergeResponseCookies,
  serializeCookieJar,
  type UnifiCookieJar,
} from "../_shared/unifi-cookie.ts";


// ========== Constants ==========
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-trace-id, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "Content-Disposition, X-Export-Limit, X-Export-Count",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

const DEFAULT_REDIRECT_URL = Deno.env.get("POST_AUTH_REDIRECT_URL") || "https://www.drogariaminasbrasil.com.br/";
const UNIFI_PROXY_ORIGIN = "https://unifiproxy.minasbrasilwifi.com.br";
const UNIFI_TIMEOUT_MS = 10_000;
const UNIFI_DISCOVERY_LOGIN_TIMEOUT_MS = 3_000;
const UNIFI_DISCOVERY_STATIONS_TIMEOUT_MS = 3_000;
const UNIFI_RETRY_COUNT = 1;
const unifiAuthModeValue = (Deno.env.get("UNIFI_AUTH_MODE") || "legacy").toLowerCase();
const UNIFI_AUTH_MODE = unifiAuthModeValue === "auto" || unifiAuthModeValue === "unifi-os"
  ? unifiAuthModeValue
  : "legacy";
const MAC_REGEX = /^[0-9A-F]{12}$/;
const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 255;
// MAX_PHONE_LEN removed as it was unused
const MAX_SLUG_LEN = 50;
const DEDUP_WINDOW_SEC = 10;
const VALID_BR_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99
]);

// GeoIP config
const GEOIP_ENDPOINT = Deno.env.get("GEOIP_ENDPOINT") || "https://ipapi.co/{ip}/json/";
const GEOIP_TIMEOUT_MS = parseInt(Deno.env.get("GEOIP_TIMEOUT_MS") || "1500");
const _GEOIP_CACHE_TTL_HOURS = parseInt(Deno.env.get("GEOIP_CACHE_TTL_HOURS") || "168");
const _GEOIP_PROVIDER = Deno.env.get("GEOIP_PROVIDER") || "ipapi";

// Legacy OTP subsystem removed.


// Cron secret for scheduled housekeeping
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

// External CRM API (ClubeMais)
const CLUBEMAIS_API_URL = "https://painelzoombox.drogariaminasbrasil.com.br:510/api2/v3/cliente";
const CLUBEMAIS_API_TOKEN = Deno.env.get("CLUBEMAIS_API_TOKEN") || "";


/** Structured logger with redaction for common secret-bearing fields. */
const Logger = {
  redact(s: string): string {
    return s
      .replace(/([Cc]ookie|[Ss]et-[Cc]ookie|[Aa]uthorization):\s*[^\r\n,;]+/gi, "$1: [REDACTED]")
      .replace(/(password|token|secret|resume_token|access_token|refresh_token|csrf_token)=[^&\r\n,;\s]+/gi, "$1=[REDACTED]")
      .replace(/"(password|token|secret|resume_token|access_token|refresh_token|csrf_token)":\s*"[^"]+"/gi, "\"$1\": \"[REDACTED]\"")
      .replace(/Bearer\s+[a-zA-Z0-9\-\._~\+/]+=*/gi, "Bearer [REDACTED]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
      .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[REDACTED_CPF]")
      .replace(/\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b|\b[0-9A-F]{12}\b/gi, "[REDACTED_MAC]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]");
  },
  info(msg: string, meta?: any) {
    const payload = meta ? ` | ${JSON.stringify(meta)}` : "";
    console.log(this.redact(`[INFO] ${msg}${payload}`));
  },
  warn(msg: string, meta?: any) {
    const payload = meta ? ` | ${JSON.stringify(meta)}` : "";
    console.warn(this.redact(`[WARN] ${msg}${payload}`));
  },
  error(msg: string, meta?: any) {
    const payload = meta ? ` | ${JSON.stringify(meta)}` : "";
    console.error(this.redact(`[ERROR] ${msg}${payload}`));
  }
};

// ========== Helpers ==========
function supabaseAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseAuth(authHeader: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
}

function canonicalUnifiControllerUrl(slug: string): string {
  return `${UNIFI_PROXY_ORIGIN}/${slug}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ========== Sanitization & Validation ==========
// ========== Sanitization & Validation ==========

const Validators = {
  string(s: unknown, maxLen: number): string | null {
    if (typeof s !== "string") return null;
    return s.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, maxLen) || null;
  },

  mac(mac: unknown): string | null {
    if (typeof mac !== "string" || !mac) return null;
    const clean = mac.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
    return clean.length === 12 && MAC_REGEX.test(clean) ? clean : null;
  },

  email(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= MAX_EMAIL_LEN;
  },

  phone(phone: string): boolean {
    let digits = phone.replace(/\D/g, "");
    if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
      digits = digits.slice(2);
    }
    if (digits.length !== 10 && digits.length !== 11) return false;
    const ddd = parseInt(digits.slice(0, 2), 10);
    if (!VALID_BR_DDD.has(ddd)) return false;
    if (digits.length === 11 && digits[2] !== "9") return false;
    if (digits.length === 10 && !/^[2-5]/.test(digits.slice(2, 3))) return false;
    return true;
  },

  cpf(cpf: string): boolean {
    const digits = (cpf || "").replace(/\D/g, "");
    if (digits.length !== 11) return false;
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
  },

  uuid(id: unknown): boolean {
    return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  },

  slug(slug: string): boolean {
    return /^[a-z0-9][a-z0-9_-]{0,48}[a-z0-9]$/.test(slug) || /^[a-z0-9]$/.test(slug);
  },

  ip(ip: string): boolean {
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return ip.split(".").every((part) => parseInt(part) <= 255);
    }
    if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":")) return true;
    return false;
  }
};


// Phone normalization is performed at validation boundaries.

/**
 * Sync lead with external CRM API (ClubeMais).
 * POST /api2/v3/cliente
 */
async function syncWithClubeMais(lead: {
  cpf: string;
  name: string;
  phone: string;
  email?: string | null;
  store_id?: string | null;
}, db: any, traceId?: string | null): Promise<{ ok: boolean; message?: string; error?: string; sync_status?: number }> {
  if (!CLUBEMAIS_API_TOKEN) {
    Logger.warn("[clubemais] sync skipped: token not configured");
    return { ok: false, error: "TOKEN_MISSING" };
  }

  const cpfOnlyDigits = lead.cpf.replace(/\D/g, "");
  const phoneOnlyDigits = lead.phone.replace(/\D/g, "");
  
  // Try to find the store slug to use as idlojacliente if needed, 
  // though typically it might be a specific ID.
  let storeSlug = "matriz";
  if (lead.store_id) {
    const { data: store } = await db.from("stores").select("slug").eq("id", lead.store_id).maybeSingle();
    if (store) storeSlug = store.slug;
  }

  const payload = {
    token: CLUBEMAIS_API_TOKEN,
    cpfcnpj: cpfOnlyDigits,
    nome: lead.name,
    celular: phoneOnlyDigits,
    email: lead.email || "",
    aceitesms: "S",
    idlojacliente: storeSlug, // Using slug as identifier
    idmodulo: "portal_wifi",
  };

  const t0 = Date.now();
  try {
    const res = await fetch(CLUBEMAIS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const status = res.status;
    await res.arrayBuffer();
    const duration = Date.now() - t0;

    Logger.info("[clubemais] sync completed", { trace_id: traceId, status, latency_ms: duration });

    if (res.ok) {
      return { ok: true, sync_status: status };
    }
    
    Logger.error("[clubemais] sync rejected", { trace_id: traceId, status });
    return { ok: false, sync_status: status, error: "API_ERROR" };
  } catch (err: any) {
    Logger.error("[clubemais] sync exception", { trace_id: traceId, error: err.message });
    return { ok: false, error: "NETWORK_ERROR" };
  }
}

/** Extract real public IP from request headers (never trust body) */
function getPublicIp(req: Request): string | null {
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp && Validators.ip(cfIp)) return cfIp;

  // The same-origin Nginx proxy overwrites X-Real-IP with the captive
  // client's address. Supabase may prepend its own hop to X-Forwarded-For,
  // which previously made the VPS address appear as the customer.
  const xRealIp = req.headers.get("x-real-ip")?.trim();
  if (xRealIp && Validators.ip(xRealIp)) return xRealIp;

  const xForwardedFor = req.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first && Validators.ip(first)) return first;
  }

  return null;
}

async function safeParseJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return await req.json();
    }
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const data = await req.formData();
      const out: Record<string, unknown> = {};
      for (const [key, value] of data.entries()) {
        const text = typeof value === "string" ? value : value.name;
        if ((key === "original_unifi_url_params" || key === "payload") && text.trim().startsWith("{")) {
          try { out[key] = JSON.parse(text); } catch { out[key] = text; }
        } else {
          out[key] = text;
        }
      }
      return out;
    }
    // Accept text/plain (used by client to avoid CORS preflight in cross-origin
    // fallback) and any unknown content-type that might still carry JSON.
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Idempotent upsert of a captive_sessions row by id.
 * Use this when a client-supplied session_id is present
 * to eliminate the duplicate-key race when both run concurrently.
 */


// ========== Trace ID + Event Logging ==========
function getTraceId(req: Request, body?: Record<string, unknown> | null): string {
  const fromHeader = req.headers.get("x-trace-id")?.trim();
  if (fromHeader && fromHeader.length <= 64) return fromHeader;
  const fromBody = body && typeof body.trace_id === "string" ? body.trace_id.trim() : "";
  if (fromBody && fromBody.length <= 64) return fromBody;
  return (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface LogEventArgs {
  session_id?: string | null;
  trace_id?: string | null;
  store_id?: string | null;
  event_type: string;
  step: "params" | "form" | "unifi" | "redirect" | "system" | "client";
  status?: "info" | "success" | "warning" | "error" | "warn";
  error_code?: string | null;
  error_message?: string | null;
  latency_ms?: number | null;
  payload?: Record<string, unknown> | null;
  client_ip?: string | null;
  user_agent?: string | null;
  /** When provided, also patches captive_sessions with these fields. */
  session_patch?: Record<string, unknown>;
}

/** Fire-and-forget event logger. Inserts into portal_events and optionally
 *  updates captive_sessions timeline columns. Never throws. */
function logEvent(db: ReturnType<typeof supabaseAdmin>, args: LogEventArgs): void {
  const row = {
    session_id: args.session_id || null,
    trace_id: args.trace_id || null,
    store_id: args.store_id || null,
    event_type: args.event_type,
    step: args.step,
    status: args.status || "info",
    error_code: args.error_code || null,
    error_message: args.error_message || null,
    latency_ms: args.latency_ms ?? null,
    payload: args.payload || null,
    client_ip: args.client_ip || null,
    user_agent: args.user_agent ? args.user_agent.slice(0, 500) : null,
  };
  db.from("portal_events").insert(row).then(
    () => {},
    (e) => Logger.warn("[logEvent] insert failed", { error: (e as Error)?.message }),
  );

  if (args.session_id) {
    const patch: Record<string, unknown> = {
      last_step: args.step,
      ...(args.session_patch || {}),
    };
    if (args.trace_id) patch.trace_id = args.trace_id;
    if (args.status === "error") {
      if (args.error_code) patch.last_error_code = args.error_code;
      if (args.error_message) patch.last_error_message = args.error_message.slice(0, 500);
    }
    db.from("captive_sessions").update(patch).eq("id", args.session_id).then(
      () => {},
      (e) => Logger.warn("[logEvent] session patch failed", { error: (e as any)?.message }),
    );
  }
}

// ========== Detect Store ==========
// Priority order:
//   1. Store already resolved and persisted in the server-side attempt
//   2. AP MAC -> store_access_points (opportunistic server-managed cache)
//   3. Public IP -> store_public_ips (legacy fallback)
//   4. Single active store (only meaningful in 1-store deployments)
// Browser-controlled ?store= values are deliberately not authoritative.
async function detectStoreFromRequest(
  db: ReturnType<typeof supabaseAdmin>,
  req: Request,
  apMac?: string | null,
  persistedStoreHint?: string | null,
  requestedStoreHint?: string | null,
): Promise<{ store_id: string | null; store_slug: string; redirect_url: string | null; store_name: string; store_city: string | null; detection_source: string }> {

  const fallback = {
    store_id: null as string | null,
    store_slug: "geral",
    redirect_url: null as string | null,
    store_name: "Wi-Fi Drogaria Minas Brasil",
    store_city: null as string | null,
    detection_source: "fallback_none",
  };

  const storeResult = (s: { id: string; slug: string; name: string; city: string | null; post_auth_redirect_url: string | null }, source: string) => ({
    store_id: s.id,
    store_slug: s.slug,
    redirect_url: s.post_auth_redirect_url || null,
    store_name: s.name,
    store_city: s.city,
    detection_source: source,
  });

  // 1) A store persisted by /oauth/init has already been resolved on the
  // server and survives the browser handoff/OAuth callback.
  if (persistedStoreHint && isValidSlug(persistedStoreHint)) {
    const { data: store } = await db
      .from("stores")
      .select("id, slug, name, city, is_active, post_auth_redirect_url")
      .eq("slug", persistedStoreHint)
      .eq("is_active", true)
      .maybeSingle();
    if (store) return storeResult(store, "attempt_store_hint");
  }

  // 2) AP MAC mapping (deterministic per physical AP — works even when all
  //    controllers share IP/SSID/walled garden). Takes priority over ?store=
  //    because nginx may inject a fallback param that masks the real store.
  const normApMac = (apMac || "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (normApMac.length === 12) {
    const { data: apMapping } = await db
      .from("store_access_points")
      .select("store_id, stores!inner(id, slug, name, city, is_active, post_auth_redirect_url)")
      .eq("ap_mac", normApMac)
      .maybeSingle();

    const store = (apMapping as { stores?: { id: string; slug: string; name: string; city: string | null; is_active: boolean; post_auth_redirect_url: string | null } } | null)?.stores;
    if (store?.is_active) {
      Logger.info("Store detected via AP mapping", { store_slug: store.slug });
      // Fire-and-forget: refresh last_seen_at
      db.from("store_access_points")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("ap_mac", normApMac)
        .then(() => {}, (e) => Logger.warn("[ap-mac] last_seen update failed", { error: (e as any)?.message }));
      return storeResult(store, "ap_mac");
    }
  }

  // 3) Resolve explicit store hints from both transport surfaces. The AP
  // mapping above remains authoritative. Reverse proxies may preserve the
  // JSON body while dropping the original query string (or vice versa), so
  // accept the hint only when every supplied value agrees.
  try {
    const url = new URL(req.url);
    const urlStoreHint = sanitizeString(url.searchParams.get("store"), 64)?.toLowerCase() || null;
    const bodyStoreHint = sanitizeString(requestedStoreHint, 64)?.toLowerCase() || null;
    const suppliedHints = [bodyStoreHint, urlStoreHint]
      .filter((hint): hint is string => !!hint && isValidSlug(hint));
    const uniqueHints = [...new Set(suppliedHints)];

    if (uniqueHints.length > 1) {
      Logger.warn("Conflicting request store hints ignored", {
        has_body_hint: !!bodyStoreHint,
        has_url_hint: !!urlStoreHint,
      });
    }

    const storeSlug = uniqueHints.length === 1 ? uniqueHints[0] : null;
    if (storeSlug) {
      const { data: store } = await db
        .from("stores")
        .select("id, slug, name, city, is_active, post_auth_redirect_url")
        .eq("slug", storeSlug)
        .eq("is_active", true)
        .maybeSingle();

      if (store) {
        Logger.info("Store detected via request store hint", { store_slug: store.slug });
        return storeResult(store, bodyStoreHint ? "request_store_hint" : "url_param");
      }
      Logger.warn("Request store hint not found or inactive");
    }
  } catch {
    Logger.warn("Request store hint parsing failed");
  }

  // 4) Public IP mapping (legacy fallback)
  const ip = getPublicIp(req);
  if (ip) {
    const { data: ipMapping } = await db
      .from("store_public_ips")
      .select("store_id")
      .eq("public_ip", ip)
      .eq("is_active", true)
      .maybeSingle();

    if (ipMapping?.store_id) {
      const { data: store } = await db
        .from("stores")
        .select("id, slug, name, city, is_active, post_auth_redirect_url")
        .eq("id", ipMapping.store_id)
        .maybeSingle();

      if (store?.is_active) {
        Logger.info("Store detected via network mapping", { store_slug: store.slug });
        return storeResult(store, "public_ip");
      }
    }
  }

  // 4) Single-active fallback
  const { data: activeStores } = await db
    .from("stores")
    .select("id, slug, name, city, post_auth_redirect_url")
    .eq("is_active", true)
    .limit(2);

  if (activeStores && activeStores.length === 1) {
    const store = activeStores[0];
    Logger.info("Store detected via single-active fallback", { store_slug: store.slug });
    return storeResult(store, "single_active");
  }

  Logger.warn("No store detected", { active_store_count: activeStores?.length || 0 });
  return fallback;
}

// ========== Auto-Discovery: probe controllers for the exact client MAC ==========
// AP mappings are a cache, never a provisioning requirement. Only the AP MAC
// returned by the controller is learned; URL parameters are not trusted for
// cache writes. Ambiguous results fail closed.
async function discoverStoreByClientMac(
  db: ReturnType<typeof supabaseAdmin>,
  clientMac: string,
): Promise<{ store_id: string; store_slug: string; redirect_url: string | null; store_name: string; store_city: string | null; detection_source: string } | null> {
  const normalizedClientMac = normalizeMac(clientMac);
  if (!normalizedClientMac || !UNIFI_USERNAME || !UNIFI_PASSWORD) return null;

  const formattedClientMac = normalizedClientMac.replace(/(.{2})(?=.)/g, "$1:").toLowerCase();
  const { data: stores, error } = await db
    .from("stores")
    .select("id, slug, name, city, post_auth_redirect_url, unifi_controller_url, unifi_site_id")
    .eq("is_active", true)
    .not("unifi_controller_url", "is", null);

  if (error || !stores?.length) {
    Logger.warn("[store-discovery] no controllers available", { code: error?.code || null });
    return null;
  }

  const probes = await Promise.allSettled(stores.map(async (store) => {
    const parsed = new URL(store.unifi_controller_url as string);
    const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
    const httpClient = createUnifiHttpClient();
    try {
      const login = await unifiLogin(
        baseUrl,
        httpClient,
        UNIFI_USERNAME,
        UNIFI_PASSWORD,
        UNIFI_DISCOVERY_LOGIN_TIMEOUT_MS,
      );
      if (!login.ok) return null;
      const siteId = store.unifi_site_id || "default";
      const staUrl = login.isUnifiOs
        ? `${parsed.origin}/proxy/network/api/s/${siteId}/stat/sta`
        : `${baseUrl}/api/s/${siteId}/stat/sta`;
      const stations = await unifiFetchStations(
        staUrl,
        buildUnifiHeaders(login),
        httpClient,
        UNIFI_DISCOVERY_STATIONS_TIMEOUT_MS,
      );
      if (!stations.ok || !stations.data) return null;
      const station = stations.data.find((item) => (item.mac || "").toLowerCase() === formattedClientMac);
      return station ? { store, station } : null;
    } finally {
      try { httpClient?.close(); } catch (_) { /* ignore close error */ }
    }
  }));

  const matches = probes.flatMap((probe) =>
    probe.status === "fulfilled" && probe.value ? [probe.value] : []
  );
  if (matches.length !== 1) {
    Logger.warn("[store-discovery] exact client match was not unique", {
      matches: matches.length,
      controllers: stores.length,
    });
    return null;
  }

  const { store, station } = matches[0];
  const learnedApMac = normalizeMac(station.ap_mac);
  if (learnedApMac) {
    await db.from("store_access_points").upsert({
      ap_mac: learnedApMac,
      store_id: store.id,
      source: "auto_discovered",
      last_seen_at: new Date().toISOString(),
    }, { onConflict: "ap_mac" }).then(
      () => {},
      (e) => Logger.warn("[store-discovery] AP cache update failed", { error: (e as Error)?.message }),
    );
  }

  Logger.info("[store-discovery] store detected via exact controller station", { store_slug: store.slug });
  return {
    store_id: store.id,
    store_slug: store.slug,
    redirect_url: store.post_auth_redirect_url || null,
    store_name: store.name,
    store_city: store.city,
    detection_source: "controller_station",
  };
}

// ========== Distributed Rate Limiting (Postgres) ==========
async function checkRateLimitDb(
  db: ReturnType<typeof supabaseAdmin>,
  key: string,
  windowSeconds: number,
  maxHits: number,
  blockSeconds = 0
): Promise<{ allowed: boolean; remaining: number; blocked_until: string | null }> {
  try {
    const { data, error } = await db.rpc("rate_limit_hit", {
      p_key: key,
      p_window_seconds: windowSeconds,
      p_max_hits: maxHits,
      p_block_seconds: blockSeconds,
    });

    if (error) {
      Logger.warn("Rate limit RPC error", { error: error.message });
      return { allowed: true, remaining: maxHits, blocked_until: null };
    }

    const result = typeof data === "string" ? JSON.parse(data) : data;
    return {
      allowed: !!result.allowed,
      remaining: result.remaining ?? 0,
      blocked_until: result.blocked_until || null,
    };
  } catch (e) {
    Logger.warn("Rate limit check failed", { error: (e as Error).message });
    return { allowed: true, remaining: maxHits, blocked_until: null };
  }
}

// ========== Dedup Map (in-memory) ==========
const dedupMap = new Map<string, number>();

// isDuplicate removed as it was unused

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of dedupMap) {
    if (now - ts > DEDUP_WINDOW_SEC * 2000) dedupMap.delete(key);
  }
}, 30_000);

// ========== GeoIP ==========
interface GeoIpData {
  city: string | null;
  region: string | null;
  country: string | null;
  isp: string | null;
  asn: string | null;
}

async function _fetchGeoIp(ip: string): Promise<GeoIpData | null> {
  const url = GEOIP_ENDPOINT.replace("{ip}", encodeURIComponent(ip));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEOIP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      city: data.city || null,
      region: data.region || data.region_name || null,
      country: data.country_name || data.country || null,
      isp: data.org || null,
      asn: data.asn || null,
    };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

// enrichGeoIp removed as it was unused

async function _enrichGeoIp(
  _db: ReturnType<typeof supabaseAdmin>,
  _ip: string
): Promise<GeoIpData & { source: string }> {
  return { city: null, region: null, country: null, isp: null, asn: null, source: "none" };
}

// incrementClusterLeadCount removed as it was unused
async function _incrementClusterLeadCount(_db: ReturnType<typeof supabaseAdmin>, _ip: string) {
}





// ========== UniFi Provider (Legacy Cookie Auth) ==========
const UNIFI_USERNAME = Deno.env.get("UNIFI_USERNAME");
const UNIFI_PASSWORD = Deno.env.get("UNIFI_PASSWORD");
const UNIFI_CA_CERT_RAW = Deno.env.get("UNIFI_CA_CERT") || "";

/** Normalize PEM cert that may have lost newlines in env var storage */
function normalizePem(pem: string): string {
  if (!pem) return "";
  // Remove existing newlines/spaces around markers
  let s = pem.trim();
  // If it's all on one line, reconstruct proper PEM format
  if (!s.includes("\n")) {
    s = s
      .replace(/-----BEGIN CERTIFICATE-----\s*/, "")
      .replace(/\s*-----END CERTIFICATE-----/, "")
      .replace(/\s+/g, "");
    // Split into 64-char lines
    const lines: string[] = [];
    for (let i = 0; i < s.length; i += 64) {
      lines.push(s.slice(i, i + 64));
    }
    return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
  }
  return s;
}

const UNIFI_CA_CERT = normalizePem(UNIFI_CA_CERT_RAW);

/** Create a Deno HTTP client that tolerates self-signed certs.
 *  Returns null when no CA cert is configured — callers should use standard fetch. */
function createUnifiHttpClient(): Deno.HttpClient | null {
  if (!UNIFI_CA_CERT) return null;
  return Deno.createHttpClient({ caCerts: [UNIFI_CA_CERT] });
}

/**
 * Try login on a specific endpoint, return cookie or TOKEN header.
 */
async function unifiTryLogin(
  loginUrl: string, httpClient: Deno.HttpClient | null,
  username?: string, password?: string,
  timeoutMs = UNIFI_TIMEOUT_MS,
): Promise<{ ok: boolean; cookies?: UnifiCookieJar; csrfToken?: string; error?: string; isUnifiOs?: boolean }> {
   const effectiveUser = username || UNIFI_USERNAME;
   const effectivePass = password || UNIFI_PASSWORD;
   
   if (!effectiveUser || !effectivePass) {
     throw new Error("UNIFI_SECRET_NOT_CONFIGURED");
   }
  const ac = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  // Derive base URL (strip /api/login or /api/auth/login) for warm-up GET + Referer
  const baseUrl = loginUrl.replace(/\/api\/(auth\/)?login$/, "");

  // Minimal headers — UniFi legacy controllers reject Origin/Referer as CSRF (returns 403).
  // Tested manually: payload {username,password} with Content-Type only → HTTP 200.
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; CaptivePortal/1.0)",
  };

  try {
    // ---- Warm-up GET to capture initial session cookies (JSESSIONID/csrf_token) ----
    let cookieJar: UnifiCookieJar = {};
    let warmupCsrf = "";
    let warmTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const warmAc = new AbortController();
      warmTimer = setTimeout(() => warmAc.abort(), timeoutMs);
      const warmOpts: Record<string, unknown> = {
        method: "GET",
        headers: { "User-Agent": baseHeaders["User-Agent"], "Accept": "*/*" },
        signal: warmAc.signal,
        redirect: "manual",
      };
      if (httpClient) warmOpts.client = httpClient;
      const warmRes = await fetch(`${baseUrl}/`, warmOpts as RequestInit);
      warmupCsrf = warmRes.headers.get("x-csrf-token") || "";
      cookieJar = mergeResponseCookies(cookieJar, warmRes.headers);
      await warmRes.body?.cancel().catch(() => {});
      Logger.info(`[UniFi] Warmup GET ${baseUrl}/: HTTP ${warmRes.status}`);
    } catch (e) {
      Logger.info(`[UniFi] Warmup GET failed (non-fatal): ${(e as Error).message}`);
    } finally {
      if (warmTimer !== undefined) clearTimeout(warmTimer);
    }

    // ---- POST login ----
    const headers: Record<string, string> = { ...baseHeaders };
    const warmupCookies = serializeCookieJar(cookieJar);
    if (warmupCookies) headers["Cookie"] = warmupCookies;
    if (warmupCsrf) headers["X-CSRF-Token"] = warmupCsrf;

    const payload = {
      username: effectiveUser,
      password: effectivePass,
      remember: false,
      strict: true,
    };

    Logger.info(`[UniFi] Login attempt: ${loginUrl} (custom client: ${!!httpClient}, warm cookies: ${warmupCookies ? "yes" : "no"})`);
    timeout = setTimeout(() => ac.abort(), timeoutMs);
    const fetchOpts: Record<string, unknown> = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
      redirect: "manual",
    };
    if (httpClient) fetchOpts.client = httpClient;
    const res = await fetch(loginUrl, fetchOpts as RequestInit);
    clearTimeout(timeout);
    timeout = undefined;

    const respCsrf = res.headers.get("x-csrf-token") || "";
    const respServer = res.headers.get("server") || "";
    cookieJar = mergeResponseCookies(cookieJar, res.headers);
    Logger.info(`[UniFi] Login response ${loginUrl}: HTTP ${res.status} | server="${respServer}"`);

    // UniFi controllers often return 302/303 after successful login — treat 2xx and 3xx as potential success
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => {});
      Logger.info(`[UniFi] Login failed (HTTP ${res.status})`);
      return { ok: false, error: `Login HTTP ${res.status}` };
    }

    // UniFi OS returns TOKEN; legacy returns unifises (+ csrf_token). Keep the
    // routing cookie emitted by the external proxy alongside auth cookies.
    const token = cookieJar.TOKEN;
    if (token) {
      await res.body?.cancel().catch(() => {});
      return {
        ok: true,
        cookies: cookieJar,
        csrfToken: respCsrf || cookieJar.csrf_token || extractCsrfFromToken(token) || undefined,
        isUnifiOs: true,
      };
    }
    if (cookieJar.unifises) {
      await res.body?.cancel().catch(() => {});
      return {
        ok: true,
        cookies: cookieJar,
        csrfToken: respCsrf || cookieJar.csrf_token || undefined,
        isUnifiOs: false,
      };
    }

    await res.body?.cancel().catch(() => {});
    return { ok: false, error: "Login succeeded but no auth cookie/token returned" };
  } catch (err) {
    if (timeout !== undefined) clearTimeout(timeout);
    const msg = (err as Error).name === "AbortError"
      ? `Login timeout after ${timeoutMs}ms`
      : (err as Error).message;
    return { ok: false, error: msg };
  }
}

/**
 * Login to UniFi controller — tries UniFi OS endpoint first, then legacy.
 */
async function unifiLogin(
  baseUrl: string, httpClient: Deno.HttpClient | null,
  username?: string, password?: string,
  timeoutMs = UNIFI_TIMEOUT_MS,
): Promise<{ ok: boolean; cookies?: UnifiCookieJar; csrfToken?: string; isUnifiOs?: boolean; error?: string }> {
  if (UNIFI_AUTH_MODE === "legacy") {
    const result = await unifiTryLogin(`${baseUrl}/api/login`, httpClient, username, password, timeoutMs);
    if (result.ok) Logger.info("UniFi login succeeded via legacy endpoint");
    return result;
  }

  if (UNIFI_AUTH_MODE === "unifi-os") {
    const result = await unifiTryLogin(`${baseUrl}/api/auth/login`, httpClient, username, password, timeoutMs);
    if (result.ok) Logger.info("UniFi login succeeded via UniFi OS endpoint");
    return result;
  }

  // Auto mode is intended only for migrations between controller families.
  const osResult = await unifiTryLogin(`${baseUrl}/api/auth/login`, httpClient, username, password, timeoutMs);
  if (osResult.ok) {
    Logger.info("UniFi login succeeded via UniFi OS endpoint");
    return osResult;
  }

  // Always try legacy /api/login as fallback
  Logger.info("UniFi OS endpoint failed; trying legacy login", { error: osResult.error?.slice(0, 100) });
  const legacyResult = await unifiTryLogin(`${baseUrl}/api/login`, httpClient, username, password, timeoutMs);
  if (legacyResult.ok) {
    Logger.info("UniFi login succeeded via legacy endpoint");
    return legacyResult;
  }
  return { ok: false, error: `OS: ${osResult.error} | Legacy: ${legacyResult.error}` };
}

function buildUnifiHeaders(
  login: Awaited<ReturnType<typeof unifiLogin>>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  const cookies = serializeCookieJar(login.cookies || {});
  if (cookies) headers.Cookie = cookies;
  if (login.csrfToken) headers["X-CSRF-Token"] = login.csrfToken;
  return headers;
}

// Polling backoff for /stat/sta confirmation (~3s total across 3 attempts).
// Captive assistants typically time out around 5-10s, so we keep this short
// and rely on the hotspot fallback redirect for the final handshake.
const VERIFY_BACKOFF_MS = [400, 800, 1500, 2500];
// RESEND_AFTER_ATTEMPT removed as it was unused

interface UnifiStation {
  mac?: string;
  ap_mac?: string;
  essid?: string;
  authorized?: boolean;
  is_guest?: boolean;
  ip?: string;
  hostname?: string;
  assoc_time?: number;
  use_fixedip?: boolean;
  [k: string]: unknown;
}

type UnifiAuthOptions = {
  apMac?: string | null;
  ssid?: string | null;
  minutes?: number;
  // The portal MAC may be absent from /stat/sta while the client is still in
  // the pre-authorization captive state. Only enable this fallback after the
  // AP MAC has been verified server-side as belonging to the same store.
  allowPortalMacFallback?: boolean;
  // When true, return ok as soon as the controller acknowledges the
  // authorize-guest command (CMD_ACCEPTED), and continue /stat/sta polling
  // in the background. Lets the client get a response in ~700ms instead of
  // ~2.5s, preventing iOS/Android CNA from closing the window before we
  // render the success screen.
  fastReturn?: boolean;
};

type UnifiAuthResult = {
  ok: boolean;
  error?: string;
  reason?: string; // standardized fail_reason code
  effective_mac?: string; // MAC actually authorized (may differ from input)
  ap_mac_used?: string | null;
  latency_ms?: number;
  cmd_accepted_at?: string; // ISO when controller accepted authorize-guest
  last_verify_result?: Record<string, unknown>; // diagnostic snapshot
  weak_signal?: boolean; // station has IP/is_guest/recentAssoc but authorized!=true
  station_lookup_fallback?: boolean;
  pending_confirmation?: boolean; // set when fastReturn=true and CMD accepted
  confirm?: Promise<UnifiAuthResult>; // resolves with the final polling result
};

function isJsonContentType(res: Response): boolean {
  const ct = res.headers.get("content-type") || "";
  return ct.toLowerCase().includes("application/json");
}

async function unifiFetchStations(
  staUrl: string, headers: Record<string, string>, httpClient: Deno.HttpClient | null,
  timeoutMs = 5_000,
): Promise<{ ok: boolean; sessionExpired?: boolean; data?: UnifiStation[]; error?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(staUrl, {
      method: "GET",
      headers,
      signal: ac.signal,
      ...(httpClient ? { client: httpClient } : {}),
    } as RequestInit);
    clearTimeout(t);
    const jsonResponse = isJsonContentType(res);
    if (!res.ok) {
      await res.text().catch(() => "");
      return {
        ok: false,
        sessionExpired: isLikelyExpiredSessionResponse(res.status, jsonResponse),
        error: `/stat/sta HTTP ${res.status}`,
      };
    }
    if (!jsonResponse) {
      await res.text().catch(() => "");
      return { ok: false, sessionExpired: true, error: "/stat/sta returned non-JSON (cookie likely expired)" };
    }
    const list = await res.json().catch(() => null) as { data?: UnifiStation[] } | null;
    return { ok: true, data: Array.isArray(list?.data) ? list!.data! : [] };
  } catch (err) {
    clearTimeout(t);
    return { ok: false, error: (err as Error).name === "AbortError" ? "/stat/sta timeout" : (err as Error).message };
  }
}

/**
 * Picks the MAC the controller actually sees for this client.
 * Causa #1: MAC randomization mitigation.
 *  1. Exact match on portalMac → use it.
 *  2. Otherwise, look for unauthorized stations on same ap_mac/ssid, recent assoc_time → if exactly one, use it.
 */
function pickEffectiveMac(
  stations: UnifiStation[],
  portalMacFormatted: string, // aa:bb:cc:dd:ee:ff
  apMac?: string | null,
  ssid?: string | null,
): { mac: string | null; remapped: boolean; candidateCount: number } {
  const target = portalMacFormatted.toLowerCase();
  const exact = stations.find((s) => (s.mac || "").toLowerCase() === target);
  if (exact) return { mac: target, remapped: false, candidateCount: 1 };

  // Strict remap window: only if exactly 1 unauthorized candidate on the
  // same AP+SSID in the last 2 minutes. UniFi's `id` URL param is the source
  // of truth; remapping is only a last-resort fallback.
  const apNorm = (apMac || "").toLowerCase().replace(/[^a-f0-9]/g, "");
  const cutoff = Math.floor(Date.now() / 1000) - 2 * 60;
  const candidates = stations.filter((s) => {
    if (s.authorized === true) return false;
    if (apNorm) {
      const sa = (s.ap_mac || "").toLowerCase().replace(/[^a-f0-9]/g, "");
      if (!sa || sa !== apNorm) return false;
    }
    if (ssid && s.essid && s.essid !== ssid) return false;
    if (typeof s.assoc_time === "number" && s.assoc_time < cutoff) return false;
    return true;
  });

  if (candidates.length === 1 && candidates[0].mac) {
    return { mac: candidates[0].mac.toLowerCase(), remapped: true, candidateCount: 1 };
  }
  return { mac: null, remapped: false, candidateCount: candidates.length };
}

/**
 * Send authorize-guest command. Returns parsed result + cookie/header diagnostics.
 * Causa #11: detects HTML response (expired cookie) so caller can re-login.
 */
async function unifiSendAuthorizeCmd(
  url: string, headers: Record<string, string>, httpClient: Deno.HttpClient | null,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; sessionExpired?: boolean; rcOk?: boolean; rcMsg?: string; error?: string; raw?: string }> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), UNIFI_TIMEOUT_MS);
  try {
    const fetchOpts: Record<string, unknown> = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
      redirect: "manual",
    };
    if (httpClient) fetchOpts.client = httpClient;
    const res = await fetch(url, fetchOpts as RequestInit);
    clearTimeout(timeout);
    const text = await res.text();
    const jsonResponse = isJsonContentType(res);

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        sessionExpired: isLikelyExpiredSessionResponse(res.status, jsonResponse),
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        raw: text,
      };
    }
    if (!jsonResponse) {
      return { ok: false, status: res.status, sessionExpired: true, error: "non-JSON response (cookie likely expired)", raw: text };
    }
    let parsed: { meta?: { rc?: string; msg?: string } } | null = null;
    try { parsed = JSON.parse(text); } catch {
      return { ok: false, status: res.status, error: `JSON parse failed: ${text.slice(0, 120)}`, raw: text };
    }
    const rcOk = parsed?.meta?.rc === "ok";
    return { ok: true, status: res.status, rcOk, rcMsg: parsed?.meta?.msg, raw: text };
  } catch (err) {
    clearTimeout(timeout);
    return {
      ok: false, status: 0,
      error: (err as Error).name === "AbortError" ? `Timeout after ${UNIFI_TIMEOUT_MS}ms` : (err as Error).message,
    };
  }
}

/**
 * Authorize a guest MAC via UniFi controller with all 5 mitigations:
 *  - (1) MAC remapping for randomized clients
 *  - (7) Bounded polling with backoff; accepted commands are never re-emitted
 *  - (9) Explicit minutes parameter with fallback
 *  - (11) Session-expired detection with re-login
 *  - (12) ap_mac in payload (auto-discovered if missing)
 */
async function checkUnifiAuthorizationState(
  controllerUrl: string,
  siteId: string,
  mac: string,
  username?: string,
  password?: string,
  apMac?: string | null,
  ssid?: string | null,
): Promise<{ state: "authorized" | "not_authorized" | "inconclusive"; effective_mac?: string }> {
  const parsed = new URL(controllerUrl);
  const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
  const httpClient = createUnifiHttpClient();
  
  try {
    const login = await unifiLogin(baseUrl, httpClient, username, password);
    if (!login.ok) return { state: "inconclusive" };
    
    const headers = buildUnifiHeaders(login);
    
    const staUrl = login.isUnifiOs 
      ? `${parsed.origin}/proxy/network/api/s/${siteId}/stat/sta`
      : `${baseUrl}/api/s/${siteId}/stat/sta`;
      
    const formattedMac = mac.replace(/(.{2})(?=.)/g, "$1:").toLowerCase();
    const staRes = await unifiFetchStations(staUrl, headers, httpClient);
    
    if (!staRes.ok || !staRes.data) return { state: "inconclusive" };
    
    // Never infer a different station without AP/SSID context. An absent exact
    // client is inconclusive and must not trigger another state-changing call.
    const pick = pickEffectiveMac(staRes.data, formattedMac, apMac, ssid);
    if (!pick.mac || pick.candidateCount > 1) return { state: "inconclusive" };
    const effectiveMac = pick.mac;
    
    const found = staRes.data.find(s => (s.mac || "").toLowerCase() === effectiveMac);
    if (found) {
      return { 
        state: found.authorized ? "authorized" : "not_authorized",
        effective_mac: effectiveMac.replace(/:/g, "").toUpperCase()
      };
    }
    
    return { state: "not_authorized" };
  } catch (err) {
    Logger.error("[unifi-check] failed", { error: err });
    return { state: "inconclusive" };
  } finally {
    try { httpClient?.close(); } catch (_) { /* ignore close error */ }
  }
}

async function unifiAuthorizeByMac(
  controllerUrl: string, siteId: string, clientMac: string,
  username?: string, password?: string,
  options: UnifiAuthOptions = {},
): Promise<UnifiAuthResult> {
  const startedAt = Date.now();
  const parsed = new URL(controllerUrl);
  const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
  const httpClient = createUnifiHttpClient();

  const desiredMinutes = Math.max(5, Math.min(1440, options.minutes ?? 1440));

  let closed = false;
  const closeClient = () => { if (!closed) { closed = true; try { httpClient?.close(); } catch { /* ignore */ } } };

  try {
    // Step 1: Fresh login
    let login = await unifiLogin(baseUrl, httpClient, username, password);
    if (!login.ok) { closeClient(); return { ok: false, reason: "UNIFI_LOGIN_FAILED", error: `UniFi login failed: ${login.error}` }; }
    let headers = buildUnifiHeaders(login);

    const origin = parsed.origin;
    const stamgrUrls = login.isUnifiOs
      ? [`${origin}/proxy/network/api/s/${siteId}/cmd/stamgr`, `${baseUrl}/api/s/${siteId}/cmd/stamgr`]
      : [`${baseUrl}/api/s/${siteId}/cmd/stamgr`];

    const formattedMac = clientMac.replace(/(.{2})(?=.)/g, "$1:").toLowerCase();

    // Step 2: Pre-fetch stations (causa #1 + #12)
    const staUrl0 = stamgrUrls[0].replace("/cmd/stamgr", "/stat/sta");
    let stationsRes = await unifiFetchStations(staUrl0, headers, httpClient);
    if (stationsRes.sessionExpired) {
      Logger.warn("[unifi-auth] reason=UNIFI_SESSION_EXPIRED phase=pre-stations action=re-login");
      login = await unifiLogin(baseUrl, httpClient, username, password);
      if (login.ok) { headers = buildUnifiHeaders(login); stationsRes = await unifiFetchStations(staUrl0, headers, httpClient); }
    }
    if (!stationsRes.ok || !stationsRes.data) {
      closeClient();
      return {
        ok: false,
        reason: "UNIFI_STATION_LOOKUP_FAILED",
        error: stationsRes.error || "Não foi possível confirmar o cliente na controladora.",
        latency_ms: Date.now() - startedAt,
      };
    }
    const stations = stationsRes.data;

    const pick = pickEffectiveMac(stations, formattedMac, options.apMac, options.ssid);
    let effectiveMac = pick.mac;
    let stationLookupFallback = false;
    if (!effectiveMac) {
      if (pick.candidateCount > 1) {
        closeClient();
        Logger.warn("[unifi-auth] reason=MAC_RANDOMIZATION_AMBIGUOUS", { candidates: pick.candidateCount, ap_mac: options.apMac || null });
        return {
          ok: false,
          reason: "MAC_RANDOMIZATION_AMBIGUOUS",
          error: "Múltiplos dispositivos não autorizados foram encontrados neste ponto de acesso. Reconecte-se à rede e tente novamente.",
          latency_ms: Date.now() - startedAt,
        };
      }
      if (options.allowPortalMacFallback && options.apMac) {
        // The AP/store binding was checked against store_access_points by
        // authorizeClient. The controller command remains authoritative: if
        // this MAC is truly unknown, stamgr rejects it and no access is opened.
        effectiveMac = formattedMac;
        stationLookupFallback = true;
        Logger.warn("[unifi-auth] reason=PORTAL_MAC_FALLBACK", {
          ap_mac: options.apMac,
          ssid: options.ssid || null,
          stations_seen: stations.length,
        });
      } else {
        closeClient();
        Logger.warn("[unifi-auth] reason=CLIENT_NOT_FOUND_ON_CONTROLLER", { ap_mac: options.apMac || null, ssid: options.ssid || null });
        return {
          ok: false,
          reason: "CLIENT_NOT_FOUND_ON_CONTROLLER",
          error: "O dispositivo não foi localizado na controladora desta unidade.",
          latency_ms: Date.now() - startedAt,
        };
      }
    }

    const selectedStation = stations.find((s) => (s.mac || "").toLowerCase() === effectiveMac);
    let apMacForPayload = selectedStation?.ap_mac || options.apMac || null;

    if (pick.remapped) {
      Logger.info(`[unifi-auth] reason=MAC_REMAPPED_OK portal=${formattedMac} controller=${effectiveMac} ap=${apMacForPayload || "?"}`);
    }

    if (!apMacForPayload) {
      const found = stations.find((s) => (s.mac || "").toLowerCase() === effectiveMac);
      if (found?.ap_mac) {
        apMacForPayload = found.ap_mac;
        Logger.info(`[unifi-auth] reason=AP_MAC_DISCOVERED ap=${apMacForPayload}`);
      } else {
        Logger.info(`[unifi-auth] reason=AP_MAC_MISSING_FALLBACK mac=${effectiveMac}`);
      }
    }

    // Step 3: Send authorize-guest with minutes + ap_mac (causa #9 + #12)
    const buildPayload = (mins: number): Record<string, unknown> => {
      const p: Record<string, unknown> = { cmd: "authorize-guest", mac: effectiveMac, minutes: mins };
      if (apMacForPayload) p.ap_mac = apMacForPayload.toLowerCase();
      return p;
    };

    let activeUrl = "";
    let lastError = "";
    let cmdSentAt = 0;
    let cmdAcceptedAtIso: string | undefined;
    let usedMinutes = desiredMinutes;
    let policyOverride = false;

    const sendOnce = async (mins: number): Promise<boolean> => {
      for (const url of stamgrUrls) {
        let cmd = await unifiSendAuthorizeCmd(url, headers, httpClient, buildPayload(mins));
        if (cmd.sessionExpired) {
          Logger.warn("[unifi-auth] reason=UNIFI_SESSION_EXPIRED phase=cmd action=re-login");
          login = await unifiLogin(baseUrl, httpClient, username, password);
          if (login.ok) { headers = buildUnifiHeaders(login); cmd = await unifiSendAuthorizeCmd(url, headers, httpClient, buildPayload(mins)); }
        }
        if (cmd.ok && cmd.rcOk) {
          activeUrl = url;
          cmdSentAt = Math.floor(Date.now() / 1000);
          cmdAcceptedAtIso = new Date().toISOString();
          Logger.info(`[unifi-auth] reason=CMD_ACCEPTED url=${url} mac=${effectiveMac} ap=${apMacForPayload || "-"} minutes=${mins}`);
          return true;
        }
        if (cmd.ok && !cmd.rcOk) {
          lastError = `rc!=ok msg=${cmd.rcMsg || "none"}`;
          if (!policyOverride && /authoriz|reject|policy|limit|timeout/i.test(cmd.rcMsg || "")) {
            return false;
          }
          continue;
        }
        if (cmd.status === 404) { lastError = cmd.error || "404"; continue; }
        lastError = cmd.error || `HTTP ${cmd.status}`;
      }
      return false;
    };

    let accepted = await sendOnce(usedMinutes);
    if (!accepted && /msg=/i.test(lastError) && !policyOverride) {
      Logger.warn("[unifi-auth] reason=SITE_POLICY_OVERRIDE", { retry_minutes: 15, previous_minutes: usedMinutes, error: lastError });
      policyOverride = true;
      usedMinutes = 15;
      accepted = await sendOnce(usedMinutes);
    }
    if (!accepted) {
      closeClient();
      return {
        ok: false,
        reason: "UNIFI_CMD_REJECTED",
        error: lastError || "command rejected",
        latency_ms: Date.now() - startedAt,
        station_lookup_fallback: stationLookupFallback,
      };
    }

    // Step 4: Polling extracted into closure so we can run it in the
    // background when fastReturn is set.
    const pollConfirmation = async (): Promise<UnifiAuthResult> => {
      const staUrl = activeUrl.replace("/cmd/stamgr", "/stat/sta");
      let verifyError = "controller did not confirm authorized client";
      let weakSignal = false;
      let lastVerifySnapshot: Record<string, unknown> = { mac: effectiveMac, found: false };

      try {
        for (let attempt = 1; attempt <= VERIFY_BACKOFF_MS.length; attempt++) {
          let staRes = await unifiFetchStations(staUrl, headers, httpClient);
          if (staRes.sessionExpired) {
            Logger.warn(`[unifi-auth] reason=UNIFI_SESSION_EXPIRED phase=poll`, { attempt });
            login = await unifiLogin(baseUrl, httpClient, username, password);
            if (login.ok) { headers = buildUnifiHeaders(login); staRes = await unifiFetchStations(staUrl, headers, httpClient); }
          }
          if (staRes.ok && staRes.data) {
            const found = staRes.data.find((s) => (s.mac || "").toLowerCase() === effectiveMac);
            if (found) {
              const hasIp = !!found.ip;
              const recentAssoc = typeof found.assoc_time === "number" && found.assoc_time >= cmdSentAt - 2;
              const ms = Date.now() - startedAt;
              lastVerifySnapshot = {
                mac: effectiveMac, found: true,
                authorized: found.authorized === true,
                is_guest: !!found.is_guest,
                ip: found.ip || null,
                essid: found.essid || null,
                ap_mac: found.ap_mac || null,
                assoc_time: found.assoc_time || null,
                recent_assoc: recentAssoc,
                attempt, latency_ms: ms,
              };
              if (found.authorized === true) {
                Logger.info(`[unifi-auth] reason=AUTH_CONFIRMED mac=${effectiveMac} ap=${found.ap_mac || "-"} ip=${found.ip || "-"} attempts=${attempt} ms=${ms}`);
                return {
                  ok: true, effective_mac: effectiveMac.replace(/:/g, "").toUpperCase(),
                  ap_mac_used: apMacForPayload, latency_ms: ms,
                  cmd_accepted_at: cmdAcceptedAtIso,
                  last_verify_result: { ...lastVerifySnapshot, verify_error: null },
                  station_lookup_fallback: stationLookupFallback,
                };
              }
              if (hasIp && recentAssoc && found.is_guest) {
                weakSignal = true;
                verifyError = `WEAK_SIGNAL_ONLY: station has IP/is_guest/recentAssoc but authorized!=true (mac=${effectiveMac} ip=${found.ip})`;
              } else {
                verifyError = `MAC ${effectiveMac} found but authorized=${String(found.authorized)} ip=${found.ip || "-"}`;
              }
            } else {
              lastVerifySnapshot = { mac: effectiveMac, found: false, total_stations: staRes.data.length, attempt };
              verifyError = `MAC ${effectiveMac} not in /stat/sta (total=${staRes.data.length})`;
            }
          } else if (staRes.error) {
            verifyError = staRes.error;
            lastVerifySnapshot = { mac: effectiveMac, found: false, sta_error: staRes.error, attempt };
          }
          Logger.warn("[unifi-auth] poll not confirmed", { attempt, total_attempts: VERIFY_BACKOFF_MS.length, error: verifyError });

          if (attempt < VERIFY_BACKOFF_MS.length) {
            await new Promise((r) => setTimeout(r, VERIFY_BACKOFF_MS[attempt - 1]));
          }
        }

        return {
          ok: false,
          reason: "UNIFI_200_BUT_NOT_CONFIRMED",
          error: verifyError,
          effective_mac: effectiveMac.replace(/:/g, "").toUpperCase(),
          ap_mac_used: apMacForPayload,
          latency_ms: Date.now() - startedAt,
          cmd_accepted_at: cmdAcceptedAtIso,
          last_verify_result: { ...lastVerifySnapshot, verify_error: verifyError },
          weak_signal: weakSignal,
          station_lookup_fallback: stationLookupFallback,
        };
      } finally {
        closeClient();
      }
    };

    if (options.fastReturn) {
      // Return immediately on CMD_ACCEPTED; polling continues in background.
      return {
        ok: true,
        effective_mac: effectiveMac.replace(/:/g, "").toUpperCase(),
        ap_mac_used: apMacForPayload,
        latency_ms: Date.now() - startedAt,
        cmd_accepted_at: cmdAcceptedAtIso,
        pending_confirmation: true,
        station_lookup_fallback: stationLookupFallback,
        confirm: pollConfirmation(),
      };
    }

    return await pollConfirmation();
  } catch (err) {
    closeClient();
    throw err;
  }
}

async function unifiAuthorizeWithRetry(
  controllerUrl: string, siteId: string, mac: string,
  username?: string, password?: string,
  options: UnifiAuthOptions = {},
): Promise<UnifiAuthResult & { attempts: number }> {
  let last: UnifiAuthResult = { ok: false, error: "Unknown error" };
  for (let attempt = 0; attempt <= UNIFI_RETRY_COUNT; attempt++) {
    last = await unifiAuthorizeByMac(controllerUrl, siteId, mac, username, password, options);
    if (last.ok) return { ...last, attempts: attempt + 1 };
    // rc=ok means the controller has already accepted the state-changing
    // command. Never send it again merely because read-after-write polling was
    // inconclusive; the attempt recovery path will perform a read-only check.
    if (last.cmd_accepted_at) return { ...last, pending_confirmation: true, attempts: attempt + 1 };
    // Don't retry user-actionable errors (e.g., randomization ambiguity)
    if (last.reason === "MAC_RANDOMIZATION_AMBIGUOUS") return { ...last, attempts: attempt + 1 };
    if (attempt < UNIFI_RETRY_COUNT) await new Promise((r) => setTimeout(r, 1000));
  }
  return { ...last, attempts: UNIFI_RETRY_COUNT + 1 };
}

async function authorizeClient(
  db: ReturnType<typeof supabaseAdmin>,
  storeId: string | null, storeSlug: string, clientMac: string | null, sessionId: string, clientIp: string,
  context: { apMac?: string | null; ssid?: string | null; fastReturn?: boolean } = {},
): Promise<{ ok: boolean; reason?: string; userMessage?: string; cmd_accepted_at?: string; last_verify_result?: Record<string, unknown> | null; pending_confirmation?: boolean; confirm?: Promise<UnifiAuthResult> }> {
  if (!storeId) {
    await db.from("captive_sessions").update({ status: "failed", fail_reason: "NO_STORE_CONFIGURED" }).eq("id", sessionId);
    return { ok: false, reason: "NO_STORE_CONFIGURED" };
  }

  const { data: store } = await db
    .from("stores")
    .select("unifi_controller_url, unifi_site_id")
    .eq("id", storeId)
    .maybeSingle();

  if (!store?.unifi_controller_url) {
    await db.from("captive_sessions").update({ status: "failed", fail_reason: "UNIFI_NOT_CONFIGURED" }).eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId, entity: "session", entity_id: sessionId,
      action: "fail", meta: { reason: "UNIFI_NOT_CONFIGURED", store_slug: storeSlug, ip: clientIp },
    });
    return { ok: false, reason: "UNIFI_NOT_CONFIGURED" };
  }

  const storeUser = UNIFI_USERNAME;
  const storePass = UNIFI_PASSWORD;

  if (!storeUser || !storePass) {
    await db.from("captive_sessions").update({ status: "failed", fail_reason: "UNIFI_CREDENTIALS_MISSING" }).eq("id", sessionId);
    return { ok: false, reason: "UNIFI_CREDENTIALS_MISSING" };
  }

  if (!clientMac || !isValidMac(clientMac)) {
    await db.from("captive_sessions").update({ status: "failed", fail_reason: "INVALID_MAC_ADDRESS" }).eq("id", sessionId);
    return { ok: false, reason: "INVALID_MAC_ADDRESS" };
  }

  // Store-scoped MAC idempotency lock. The same private MAC may legitimately
  // appear in a different store and must be authorized on that controller.
  const lock = await db.rpc("rate_limit_hit", {
    p_key: `unifi_auth:store:${storeId}:mac:${clientMac.toUpperCase()}`,
    p_window_seconds: 15,
    p_max_hits: 1,
    p_block_seconds: 0,
  });

  if (lock.data?.allowed === false) {
    Logger.warn("[authorize] duplicate concurrent request suppressed", { session_id: sessionId });
    // If there's a very recent successful auth (last 30s), just return success
    const { data: recentAuth } = await db
      .from("captive_sessions")
      .select("id, status, unifi_cmd_accepted_at, authorized_at")
      .eq("store_id", storeId)
      .eq("client_mac", clientMac.toUpperCase())
      .eq("status", "authorized")
      .gte("authorized_at", new Date(Date.now() - 30 * 1000).toISOString())
      .maybeSingle();

    if (recentAuth) {
      Logger.info("[authorize] recent authorization reused", { session_id: sessionId });
      return { ok: true, cmd_accepted_at: recentAuth.unifi_cmd_accepted_at };
    }

    return { ok: false, reason: "RATE_LIMIT_HIT", userMessage: "Liberação em processamento. Aguarde alguns segundos." };
  }

  const { data: settings } = await db
    .from("global_settings")
    .select("session_duration_minutes")
    .eq("id", 1)
    .maybeSingle();
  const desiredMinutes = settings?.session_duration_minutes ?? 60;

  // A controller may omit a not-yet-authorized captive client from /stat/sta.
  // Permit a direct command with the portal-provided MAC only when the AP was
  // independently mapped to this exact store in our server-side registry.
  const normalizedApMac = normalizeMac(context.apMac);
  let allowPortalMacFallback = false;
  if (normalizedApMac) {
    const { data: mappedAp, error: mappedApError } = await db
      .from("store_access_points")
      .select("store_id")
      .eq("ap_mac", normalizedApMac)
      .maybeSingle();
    allowPortalMacFallback = !mappedApError && mappedAp?.store_id === storeId;
    if (mappedApError) {
      Logger.warn("[authorize] AP trust lookup failed", { code: mappedApError.code || "AP_LOOKUP_FAILED" });
    }
  }

  const siteId = store.unifi_site_id || "default";
  const result = await unifiAuthorizeWithRetry(
    store.unifi_controller_url, siteId, clientMac, storeUser, storePass,
    {
      apMac: normalizedApMac,
      ssid: context.ssid || null,
      minutes: desiredMinutes,
      fastReturn: !!context.fastReturn,
      allowPortalMacFallback,
    },
  );

  // Persist UniFi audit columns regardless of outcome
  const auditUpdate: Record<string, unknown> = {};
  if (result.cmd_accepted_at) auditUpdate.unifi_cmd_accepted_at = result.cmd_accepted_at;
  if (result.last_verify_result) auditUpdate.unifi_last_verify_result = result.last_verify_result;

  if (result.ok) {
    Object.assign(auditUpdate, {
      // When fastReturn ack'd CMD but not yet confirmed, mark as authorized
      // optimistically; the background confirm will downgrade to "failed" if
      // /stat/sta doesn't see the MAC.
      status: "authorized",
      authorized_at: new Date().toISOString(),
      auth_latency_ms: result.latency_ms ?? null,
    });
    if (result.effective_mac && result.effective_mac !== clientMac) {
      auditUpdate.original_client_mac = clientMac;
      auditUpdate.client_mac = result.effective_mac;
    }
    await db.from("captive_sessions").update(auditUpdate).eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId, entity: "session", entity_id: sessionId,
      action: "authorize",
      meta: {
        mac: result.effective_mac || clientMac,
        ap_mac: result.ap_mac_used || context.apMac || null,
        store_slug: storeSlug, ip: clientIp,
        attempts: result.attempts, latency_ms: result.latency_ms,
        pending_confirmation: !!result.pending_confirmation,
        station_lookup_fallback: !!result.station_lookup_fallback,
      },
    });
    return {
      ok: true,
      cmd_accepted_at: result.cmd_accepted_at,
      last_verify_result: result.last_verify_result || null,
      pending_confirmation: !!result.pending_confirmation,
      confirm: result.confirm,
    };
  } else if (result.pending_confirmation && result.cmd_accepted_at) {
    Object.assign(auditUpdate, {
      status: "submitted",
      fail_reason: "UNIFI_CONFIRMATION_PENDING",
      auth_latency_ms: result.latency_ms ?? null,
    });
    await db.from("captive_sessions").update(auditUpdate).eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId, entity: "session", entity_id: sessionId,
      action: "authorize_pending",
      meta: {
        reason: result.reason,
        mac: result.effective_mac || clientMac,
        ap_mac: result.ap_mac_used || context.apMac || null,
        store_slug: storeSlug,
        attempts: result.attempts,
        latency_ms: result.latency_ms,
      },
    });
    return {
      ok: false,
      reason: "PROCESSING_IN_PROGRESS",
      cmd_accepted_at: result.cmd_accepted_at,
      last_verify_result: result.last_verify_result || null,
      pending_confirmation: true,
    };
  } else {
    const failReason = (result.reason || result.error || "UNKNOWN").slice(0, 500);
    Object.assign(auditUpdate, {
      status: "failed",
      fail_reason: failReason,
      auth_latency_ms: result.latency_ms ?? null,
    });
    await db.from("captive_sessions").update(auditUpdate).eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId, entity: "session", entity_id: sessionId,
      action: "fail",
      meta: {
        reason: result.reason, error: result.error,
        mac: clientMac, ap_mac: context.apMac || null,
        store_slug: storeSlug, ip: clientIp,
        attempts: result.attempts, latency_ms: result.latency_ms,
        weak_signal: result.weak_signal || false,
        station_lookup_fallback: !!result.station_lookup_fallback,
      },
    });
    const userMessage = result.reason === "MAC_RANDOMIZATION_AMBIGUOUS" ? result.error : undefined;
    return {
      ok: false, reason: result.reason, userMessage,
      cmd_accepted_at: result.cmd_accepted_at,
      last_verify_result: result.last_verify_result || null,
    };
  }
}

/**
 * Build the controller base URL for /guest/s/<site>/ fallback redirects.
 * Preserves any path prefix the controller URL was configured with — we never
 * silently drop it. If the controller is reachable only at the origin root,
 * configure the controller URL accordingly.
 */
// getControllerBaseForGuestRedirect removed as it was unused
async function _getControllerBaseForGuestRedirect(controllerUrl: string): Promise<string> {
  const u = new URL(controllerUrl);
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${path}`;
}

async function handleBootstrap(req: Request): Promise<Response> {
  const db = supabaseAdmin();

  // Detect store: ?store=slug > IP mapping > single active store
  const detected = await detectStoreFromRequest(db, req);

  const { data: consent } = await db
    .from("consent_versions")
    .select("version, text")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return jsonResponse({
    store: { slug: detected.store_slug, name: detected.store_name, city: detected.store_city },
    consent: consent || null,
    required_fields: {
      name: { required: true },
      email: { required: true },
      phone: { required: true },
      at_least_one_contact: true,
    },
  });
}


// ========== Internal Housekeeping ==========
async function internalHousekeeping(db: ReturnType<typeof supabaseAdmin>): Promise<Record<string, number>> {
  const now = new Date();

  // 1. Delete expired verifications older than 30 days
  const verifCutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  const { data: expiredVerifData } = await db
    .from("captive_verifications")
    .delete()
    .lt("expires_at", verifCutoff)
    .in("status", ["pending", "expired", "locked"])
    .select("id");

  // 2. Clean old rate limits (older than 1 day)
  const { data: oldRateLimitData } = await db
    .from("rate_limits")
    .delete()
    .lt("updated_at", new Date(now.getTime() - 86400000).toISOString())
    .select("key");

  // 3. Delete old non-authorized sessions older than 180 days
  const sessionCutoff180 = new Date(now.getTime() - 180 * 86400000).toISOString();
  const { data: oldSessionData } = await db
    .from("captive_sessions")
    .delete()
    .lt("started_at", sessionCutoff180)
    .in("status", ["started", "submitted", "failed"])
    .select("id");

  // 4. Delete authorized sessions older than 365 days
  const sessionCutoff365 = new Date(now.getTime() - 365 * 86400000).toISOString();
  const { data: oldAuthSessionData } = await db
    .from("captive_sessions")
    .delete()
    .lt("started_at", sessionCutoff365)
    .eq("status", "authorized")
    .select("id");

  // 5. Truncate audit_logs older than 180 days
  const auditCutoff = new Date(now.getTime() - 180 * 86400000).toISOString();
  const { data: oldAuditData } = await db
    .from("audit_logs")
    .delete()
    .lt("created_at", auditCutoff)
    .select("id");

  const { data: expiredHandoffData } = await db
    .from("oauth_browser_handoffs")
    .delete()
    .lt("expires_at", now.toISOString())
    .select("id");

  return {
    expired_verifications: expiredVerifData?.length || 0,
    old_rate_limits: oldRateLimitData?.length || 0,
    old_sessions: (oldSessionData?.length || 0) + (oldAuthSessionData?.length || 0),
    old_audit_logs: oldAuditData?.length || 0,
    expired_oauth_handoffs: expiredHandoffData?.length || 0,
  };
}

// ========== Admin Endpoints ==========

function escapeCsvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function sanitizeHttpUrl(value: unknown, options: { httpsOnly?: boolean } = {}): string | null {
  const sanitized = sanitizeString(value, 500);
  if (!sanitized) return null;
  try {
    const parsed = new URL(sanitized);
    if (parsed.username || parsed.password) return null;
    if (options.httpsOnly && parsed.protocol !== "https:") return null;
    if (!options.httpsOnly && parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function getActiveUserBlock(
  db: ReturnType<typeof supabaseAdmin>,
  userId: string,
): Promise<{ reason: string; blocked_at: string; expires_at: string | null } | null> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("user_blocks")
    .select("reason, blocked_at, expires_at")
    .eq("user_id", userId)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .maybeSingle();

  if (error) {
    Logger.error("Failed to check user block", { user_id: userId, error: error.message });
    throw new Error("USER_BLOCK_CHECK_FAILED");
  }
  return data || null;
}

async function getActiveBlockedUserIds(
  db: ReturnType<typeof supabaseAdmin>,
  userIds: string[],
): Promise<Set<string>> {
  const uniqueIds = [...new Set(userIds.filter((id) => isValidUUID(id)))];
  if (uniqueIds.length === 0) return new Set();
  const { data, error } = await db
    .from("user_blocks")
    .select("user_id, expires_at")
    .in("user_id", uniqueIds);
  if (error) {
    Logger.error("Failed to load user blocks", { error: error.message });
    throw new Error("USER_BLOCK_LIST_FAILED");
  }
  const now = Date.now();
  return new Set((data || [])
    .filter((row: { expires_at: string | null }) => !row.expires_at || new Date(row.expires_at).getTime() > now)
    .map((row: { user_id: string }) => row.user_id));
}

async function writeAdminAudit(
  db: ReturnType<typeof supabaseAdmin>,
  req: Request,
  actorUserId: string,
  entity: string,
  action: string,
  options: {
    entityId?: string | null;
    storeId?: string | null;
    meta?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const { error } = await db.from("audit_logs").insert({
    store_id: options.storeId || null,
    entity,
    entity_id: options.entityId || null,
    action,
    meta: {
      actor_user_id: actorUserId,
      actor_ip: forwardedFor,
      user_agent: sanitizeString(req.headers.get("user-agent"), 300),
      ...(options.meta || {}),
    },
  });

  if (error) Logger.error("Failed to persist admin audit", { entity, action, error: error.message });
}

async function requireAdmin(req: Request): Promise<{ db: ReturnType<typeof supabaseAdmin>; userId: string; userEmail: string | null } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);

  const authClient = supabaseAuth(authHeader);
  const token = authHeader.replace("Bearer ", "");

  const { data: userData, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userData?.user) return errorResponse("Unauthorized", 401);

  const userId = userData.user.id;
  const db = supabaseAdmin();

  const [{ data: roleData }, activeBlock] = await Promise.all([
    db.from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle(),
    getActiveUserBlock(db, userId),
  ]);

  if (activeBlock) return errorResponse("Forbidden: user is blocked", 403);
  if (!roleData) return errorResponse("Forbidden: admin role required", 403);
  return { db, userId, userEmail: userData.user.email || null };
}

// ========== Admin: Current Operator ==========
async function handleAdminMe(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  await writeAdminAudit(auth.db, req, auth.userId, "admin_session", "login");
  return jsonResponse({ id: auth.userId, email: auth.userEmail, role: "admin" });
}

// ========== Admin: Users, Roles and Blocking ==========
async function handleAdminUsers(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db, userId: actorUserId } = auth;

  if (req.method === "GET") {
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50") || 50), 100);
    const search = (sanitizeString(url.searchParams.get("q"), 120) || "").toLocaleLowerCase("pt-BR");
    const status = url.searchParams.get("status") || "all";

    const { data: authUsersData, error: usersError } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersError) return errorResponse(usersError.message, 500);

    const authUsers = authUsersData.users || [];
    const userIds = authUsers.map((user) => user.id);
    const [rolesResult, profilesResult, blocksResult] = userIds.length
      ? await Promise.all([
          db.from("user_roles").select("user_id, role").in("user_id", userIds),
          db.from("profiles").select("id, full_name, email, phone_digits, cpf_digits").in("id", userIds),
          db.from("user_blocks").select("user_id, reason, blocked_at, expires_at").in("user_id", userIds),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }];

    const roleByUser = new Map((rolesResult.data || []).map((row: { user_id: string; role: string }) => [row.user_id, row.role]));
    const profileByUser = new Map((profilesResult.data || []).map((row: { id: string }) => [row.id, row]));
    const blockByUser = new Map((blocksResult.data || []).map((row: { user_id: string }) => [row.user_id, row]));
    const now = Date.now();

    const normalized = authUsers.map((user) => {
      const profile = profileByUser.get(user.id) as { full_name?: string; email?: string; phone_digits?: string | null; cpf_digits?: string | null } | undefined;
      const block = blockByUser.get(user.id) as { reason?: string; blocked_at?: string; expires_at?: string | null } | undefined;
      const blocked = !!block && (!block.expires_at || new Date(block.expires_at).getTime() > now);
      const role = roleByUser.get(user.id) || null;
      return {
        id: user.id,
        email: user.email || profile?.email || null,
        phone: user.phone || profile?.phone_digits || null,
        name: profile?.full_name || null,
        cpf: profile?.cpf_digits || null,
        role,
        blocked,
        block_reason: blocked ? block?.reason || null : null,
        blocked_at: blocked ? block?.blocked_at || null : null,
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at || null,
        email_confirmed_at: user.email_confirmed_at || null,
      };
    }).filter((user) => {
      if (status === "blocked" && !user.blocked) return false;
      if (status === "admin" && user.role !== "admin") return false;
      if (status === "active" && user.blocked) return false;
      if (!search) return true;
      return [user.name, user.email, user.phone, user.cpf]
        .some((value) => value?.toLocaleLowerCase("pt-BR").includes(search));
    });

    const offset = (page - 1) * limit;
    return jsonResponse({
      data: normalized.slice(offset, offset + limit),
      total: normalized.length,
      page,
      limit,
      truncated: authUsers.length >= 1000,
    });
  }

  const body = await safeParseJson(req);
  if (!body) return errorResponse("JSON inválido");

  if (req.method === "POST" && body.action === "invite_admin") {
    const email = sanitizeString(body.email, MAX_EMAIL_LEN)?.toLowerCase();
    if (!email || !isValidEmail(email)) return errorResponse("E-mail inválido");

    const { data, error } = await db.auth.admin.inviteUserByEmail(email);
    if (error || !data.user) return errorResponse(error?.message || "Não foi possível convidar o usuário", 500);

    const { error: roleError } = await db.from("user_roles")
      .upsert({ user_id: data.user.id, role: "admin" }, { onConflict: "user_id,role" });
    if (roleError) {
      await db.auth.admin.deleteUser(data.user.id);
      return errorResponse(roleError.message, 500);
    }

    await writeAdminAudit(db, req, actorUserId, "user", "invite_admin", {
      entityId: data.user.id,
      meta: { invited_email: email },
    });
    return jsonResponse({ id: data.user.id, email, role: "admin" }, 201);
  }

  if (req.method !== "PUT") return errorResponse("Method not allowed", 405);
  if (!isValidUUID(body.user_id)) return errorResponse("user_id inválido");
  const targetUserId = body.user_id as string;
  const action = sanitizeString(body.action, 40);

  if ((action === "block" || action === "revoke_admin") && targetUserId === actorUserId) {
    return errorResponse("Você não pode bloquear ou remover o próprio acesso administrativo", 409);
  }

  if (action === "block") {
    const reason = sanitizeString(body.reason, 500);
    if (!reason || reason.trim().length < 3) return errorResponse("Informe o motivo do bloqueio");

    const { error: banError } = await db.auth.admin.updateUserById(targetUserId, { ban_duration: "876000h" });
    if (banError) return errorResponse(banError.message, 500);

    const { error: blockError } = await db.from("user_blocks").upsert({
      user_id: targetUserId,
      reason,
      blocked_by: actorUserId,
      blocked_at: new Date().toISOString(),
      expires_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (blockError) {
      await db.auth.admin.updateUserById(targetUserId, { ban_duration: "none" });
      return errorResponse(blockError.message, 500);
    }

    await db.from("leads").update({
      marketing_status: "blocked",
      marketing_status_reason: reason,
      marketing_updated_at: new Date().toISOString(),
      marketing_updated_by: actorUserId,
    }).eq("user_id", targetUserId).neq("marketing_status", "anonymized");

    await writeAdminAudit(db, req, actorUserId, "user", "block", {
      entityId: targetUserId,
      meta: { reason },
    });
    return jsonResponse({ ok: true, blocked: true });
  }

  if (action === "unblock") {
    const { error: unbanError } = await db.auth.admin.updateUserById(targetUserId, { ban_duration: "none" });
    if (unbanError) return errorResponse(unbanError.message, 500);
    const { error: deleteError } = await db.from("user_blocks").delete().eq("user_id", targetUserId);
    if (deleteError) return errorResponse(deleteError.message, 500);

    await writeAdminAudit(db, req, actorUserId, "user", "unblock", { entityId: targetUserId });
    return jsonResponse({ ok: true, blocked: false });
  }

  if (action === "grant_admin") {
    const { error } = await db.from("user_roles")
      .upsert({ user_id: targetUserId, role: "admin" }, { onConflict: "user_id,role" });
    if (error) return errorResponse(error.message, 500);
    await writeAdminAudit(db, req, actorUserId, "user", "grant_admin", { entityId: targetUserId });
    return jsonResponse({ ok: true, role: "admin" });
  }

  if (action === "revoke_admin") {
    const { count } = await db.from("user_roles")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin");
    if ((count || 0) <= 1) return errorResponse("Não é permitido remover o último administrador", 409);

    const { error } = await db.from("user_roles")
      .delete()
      .eq("user_id", targetUserId)
      .eq("role", "admin");
    if (error) return errorResponse(error.message, 500);
    await writeAdminAudit(db, req, actorUserId, "user", "revoke_admin", { entityId: targetUserId });
    return jsonResponse({ ok: true, role: null });
  }

  return errorResponse("Ação de usuário inválida");
}

// ========== Admin: Global Settings ==========
async function handleAdminSettings(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db, userId } = auth;

  if (req.method === "GET") {
    const { data, error } = await db
      .from("global_settings")
      .select("session_duration_minutes, updated_at")
      .eq("id", 1)
      .maybeSingle();

    if (error) return errorResponse(error.message, 500);

    return jsonResponse({
      session_duration_minutes: data?.session_duration_minutes ?? 1440,
      updated_at: data?.updated_at || null,
    });
  }

  if (req.method === "PUT") {
    const body = await safeParseJson(req);
    if (!body) return errorResponse("JSON inválido");

    const duration = Number(body.session_duration_minutes);
    if (!Number.isInteger(duration) || duration < 1 || duration > 43200) {
      return errorResponse("session_duration_minutes deve ser um número inteiro entre 1 e 43200");
    }

    const { data, error } = await db
      .from("global_settings")
      .update({ session_duration_minutes: duration })
      .eq("id", 1)
      .select("session_duration_minutes, updated_at")
      .single();

    if (error) return errorResponse(error.message, 500);

    await writeAdminAudit(db, req, userId, "global_settings", "update", {
      meta: {
        fields: ["session_duration_minutes"],
        session_duration_minutes: duration,
      },
    });

    return jsonResponse(data);
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminStores(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  if (req.method === "GET") {
    // NEVER return secrets in GET
    const { data, error } = await db
      .from("stores")
      .select("id, slug, name, city, is_active, post_auth_redirect_url, unifi_site_id, unifi_controller_url, created_at, updated_at")
      .order("created_at", { ascending: false });
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data);
  }

  if (req.method === "POST") {
    const body = await safeParseJson(req);
    if (!body) return errorResponse("Invalid JSON");

    const slug = sanitizeString(body.slug, MAX_SLUG_LEN);
    const name = sanitizeString(body.name, MAX_NAME_LEN);
    if (!slug || !isValidSlug(slug)) return errorResponse("Slug inválido");
    if (!name) return errorResponse("Nome obrigatório");

    const controllerUrl = canonicalUnifiControllerUrl(slug);
    const redirectUrl = body.post_auth_redirect_url ? sanitizeHttpUrl(body.post_auth_redirect_url, { httpsOnly: true }) : null;
    if (body.unifi_controller_url) {
      const supplied = sanitizeHttpUrl(body.unifi_controller_url, { httpsOnly: true })?.replace(/\/+$/, "");
      if (supplied !== controllerUrl) {
        return errorResponse(`A URL da controladora é gerenciada automaticamente: ${controllerUrl}`);
      }
    }
    if (body.post_auth_redirect_url && !redirectUrl) return errorResponse("Redirecionamento deve usar uma URL HTTPS válida");

    const { data, error } = await db.from("stores").insert({
      slug, name,
      city: sanitizeString(body.city, 100) || null,
      is_active: body.is_active === false ? false : true,
      post_auth_redirect_url: redirectUrl,
      unifi_site_id: sanitizeString(body.unifi_site_id, 100) || "default",
      unifi_controller_url: controllerUrl,
    }).select("id, slug, name").single();
    if (error) return errorResponse(error.code === "23505" ? "Já existe uma loja com este slug" : error.message, error.code === "23505" ? 409 : 500);

    await writeAdminAudit(db, req, auth.userId, "store", "create", {
      entityId: data.id,
      storeId: data.id,
      meta: { slug: data.slug },
    });
    return jsonResponse(data, 201);
  }

  if (req.method === "PUT") {
    const body = await safeParseJson(req);
    if (!body || !isValidUUID(body.id)) return errorResponse("Missing or invalid store id");

    const { data: currentStore, error: currentStoreError } = await db
      .from("stores")
      .select("slug")
      .eq("id", body.id as string)
      .maybeSingle();
    if (currentStoreError || !currentStore) return errorResponse("Loja não encontrada", 404);

    const updateData: Record<string, unknown> = {};
    if (body.slug !== undefined) { const s = sanitizeString(body.slug, MAX_SLUG_LEN); if (s && isValidSlug(s)) updateData.slug = s; }
    if (body.name !== undefined) { const n = sanitizeString(body.name, MAX_NAME_LEN); if (n) updateData.name = n; }
    if (body.city !== undefined) updateData.city = sanitizeString(body.city, 100);
    if (body.is_active !== undefined) updateData.is_active = !!body.is_active;
    if (body.post_auth_redirect_url !== undefined) {
      if (body.post_auth_redirect_url === "" || body.post_auth_redirect_url === null) updateData.post_auth_redirect_url = null;
      else {
        const redirectUrl = sanitizeHttpUrl(body.post_auth_redirect_url, { httpsOnly: true });
        if (!redirectUrl) return errorResponse("Redirecionamento deve usar uma URL HTTPS válida");
        updateData.post_auth_redirect_url = redirectUrl;
      }
    }
    if (body.unifi_site_id !== undefined) updateData.unifi_site_id = sanitizeString(body.unifi_site_id, 100);
    const effectiveSlug = (updateData.slug as string | undefined) || currentStore.slug;
    const controllerUrl = canonicalUnifiControllerUrl(effectiveSlug);
    if (body.unifi_controller_url !== undefined && body.unifi_controller_url !== null && body.unifi_controller_url !== "") {
      const supplied = sanitizeHttpUrl(body.unifi_controller_url, { httpsOnly: true })?.replace(/\/+$/, "");
      if (supplied !== controllerUrl) {
        return errorResponse(`A URL da controladora é gerenciada automaticamente: ${controllerUrl}`);
      }
    }
    updateData.unifi_controller_url = controllerUrl;
    if (!updateData.unifi_site_id && body.unifi_site_id === "") updateData.unifi_site_id = "default";
    if (Object.keys(updateData).length === 0) return errorResponse("Nenhum campo para atualizar");

    const { data, error } = await db.from("stores").update(updateData).eq("id", body.id as string).select("id, slug, name").single();
    if (error) return errorResponse(error.message, 500);

    await writeAdminAudit(db, req, auth.userId, "store", "update", {
      storeId: body.id as string,
      entityId: body.id as string,
      meta: { fields: Object.keys(updateData) },
    });

    return jsonResponse(data);
  }

  if (req.method === "DELETE") {
    return errorResponse("Exclusão definitiva de loja desabilitada. Desative a loja para preservar leads e histórico.", 405);
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminLeads(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db, userId } = auth;
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  const storeId = url.searchParams.get("store_id");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const search = (sanitizeString(url.searchParams.get("q"), 120) || "").replace(/[,%().]/g, " ").trim();
  const marketingStatus = url.searchParams.get("marketing_status");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50") || 50), 200);
  const offset = (page - 1) * limit;
  const format = url.searchParams.get("format");
  const audience = url.searchParams.get("audience");

  let query = db
    .from("leads")
    .select("id, user_id, store_id, session_id, name, email, phone, cpf, client_mac, created_at, first_seen_at, last_seen_at, consented_at, consent_version, source, origin_ip, origin_city, origin_region, marketing_status, marketing_status_reason, marketing_updated_at, anonymized_at, stores(slug, name, city)", { count: "exact" })
    .order("last_seen_at", { ascending: false });

  if (storeId && isValidUUID(storeId)) query = query.eq("store_id", storeId);
  if (from) query = query.gte("last_seen_at", from.length === 10 ? `${from}T00:00:00.000Z` : from);
  if (to) query = query.lte("last_seen_at", to.length === 10 ? `${to}T23:59:59.999Z` : to);
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,cpf.ilike.%${search}%`);
  if (marketingStatus && ["eligible", "opted_out", "blocked", "anonymized"].includes(marketingStatus)) {
    query = query.eq("marketing_status", marketingStatus);
  }

  if (format === "csv") {
    const marketingExport = audience === "marketing";
    if (marketingExport) query = query.eq("marketing_status", "eligible");
    query = query.limit(10000);
    const { data, error } = await query;
    if (error) return errorResponse(error.message, 500);

    const blockedUserIds = marketingExport
      ? await getActiveBlockedUserIds(db, (data || []).map((lead) => lead.user_id).filter(Boolean) as string[])
      : new Set<string>();
    const exportRows = (data || []).filter((lead) => !marketingExport || !lead.user_id || !blockedUserIds.has(lead.user_id));
    const headers = marketingExport
      ? ["nome", "email", "telefone", "loja", "codigo_loja", "cidade_loja", "primeiro_cadastro_em", "ultima_atividade_em", "consentimento_em", "versao_consentimento"]
      : ["id", "store_slug", "name", "cpf", "email", "phone", "client_mac", "origin_ip", "origin_city", "origin_region", "created_at", "last_seen_at", "consent_version"];
    const csvRows = [headers.map(escapeCsvCell).join(",")];
    for (const lead of exportRows) {
      const storeInfo = lead.stores as unknown as { slug: string; name: string; city: string | null } | null;
      const row = marketingExport
        ? [
            lead.name || "", lead.email || "", lead.phone || "",
            storeInfo?.name || "", storeInfo?.slug || "", storeInfo?.city || "",
            lead.first_seen_at || lead.created_at, lead.last_seen_at || lead.created_at,
            lead.consented_at, lead.consent_version,
          ]
        : [
            lead.id, storeInfo?.slug || "", lead.name || "",
            (lead as any).cpf || "", lead.email || "", lead.phone || "", lead.client_mac || "",
            (lead as any).origin_ip || "", (lead as any).origin_city || "", (lead as any).origin_region || "",
            lead.created_at, lead.last_seen_at || lead.created_at, lead.consent_version,
          ];
      csvRows.push(row.map(escapeCsvCell).join(","));
    }

    await writeAdminAudit(db, req, userId, "lead", "export_csv", {
      storeId: storeId && isValidUUID(storeId) ? storeId : null,
      meta: { audience: marketingExport ? "marketing" : "technical", from, to, count: exportRows.length, search: search || null },
    });

    const filenamePrefix = marketingExport ? "leads_marketing" : "leads";

    return new Response(`\uFEFF${csvRows.join("\r\n")}`, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filenamePrefix}_${new Date().toISOString().slice(0, 10)}.csv"`,
        "X-Export-Limit": "10000",
        "X-Export-Count": String(exportRows.length),
      },
    });
  }

  query = query.range(offset, offset + limit - 1);
  const { data, count, error } = await query;
  if (error) return errorResponse(error.message, 500);
  const blockedUserIds = await getActiveBlockedUserIds(db, (data || []).map((lead) => lead.user_id).filter(Boolean) as string[]);
  return jsonResponse({
    data: (data || []).map((lead) => ({
      ...lead,
      user_blocked: !!lead.user_id && blockedUserIds.has(lead.user_id),
    })),
    total: count,
    page,
    limit,
  });
}

async function handleAdminLeadActions(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  if (req.method !== "PUT") return errorResponse("Method not allowed", 405);
  const { db, userId } = auth;

  const body = await safeParseJson(req);
  if (!body || !isValidUUID(body.lead_id)) return errorResponse("lead_id inválido");
  const leadId = body.lead_id as string;
  const action = sanitizeString(body.action, 40);
  const reason = sanitizeString(body.reason, 500);
  const { data: lead, error: leadError } = await db.from("leads")
    .select("id, user_id, marketing_status")
    .eq("id", leadId)
    .maybeSingle();
  if (leadError) return errorResponse(leadError.message, 500);
  if (!lead) return errorResponse("Lead não encontrado", 404);

  const now = new Date().toISOString();
  if (action === "allow_marketing" || action === "opt_out" || action === "block_marketing") {
    if (lead.marketing_status === "anonymized") return errorResponse("Um lead anonimizado não pode ser reativado", 409);
    const status = action === "allow_marketing" ? "eligible" : action === "opt_out" ? "opted_out" : "blocked";
    if (status !== "eligible" && (!reason || reason.length < 3)) return errorResponse("Informe o motivo da alteração");
    const { error } = await db.from("leads").update({
      marketing_status: status,
      marketing_status_reason: status === "eligible" ? null : reason,
      marketing_updated_at: now,
      marketing_updated_by: userId,
    }).eq("id", leadId).neq("marketing_status", "anonymized");
    if (error) return errorResponse(error.message, 500);
    await writeAdminAudit(db, req, userId, "lead", action, {
      entityId: leadId,
      meta: { reason: status === "eligible" ? null : reason },
    });
    return jsonResponse({ ok: true, marketing_status: status });
  }

  if (action === "anonymize") {
    if (!reason || reason.length < 3) return errorResponse("Informe o motivo da anonimização");
    const { error } = await db.from("leads").update({
      name: "Anonimizado",
      email: null,
      phone: null,
      cpf: null,
      client_mac: null,
      origin_ip: null,
      origin_city: null,
      origin_region: null,
      origin_country: null,
      origin_isp: null,
      origin_asn: null,
      marketing_status: "anonymized",
      marketing_status_reason: reason,
      marketing_updated_at: now,
      marketing_updated_by: userId,
      anonymized_at: now,
    }).eq("id", leadId);
    if (error) return errorResponse(error.message, 500);

    await writeAdminAudit(db, req, userId, "lead", "anonymize", {
      entityId: leadId,
      meta: { reason, auth_account_preserved: !!lead.user_id },
    });
    return jsonResponse({ ok: true, marketing_status: "anonymized" });
  }

  return errorResponse("Ação de lead inválida");
}

async function handleAdminConsent(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db, userId } = auth;

  if (req.method === "GET") {
    const { data, error } = await db.from("consent_versions")
      .select("id, version, text, is_active, created_at")
      .order("created_at", { ascending: false });
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data);
  }

  if (req.method === "POST") {
    const body = await safeParseJson(req);
    if (!body) return errorResponse("Invalid JSON");
    const version = sanitizeString(body.version, 20);
    const text = sanitizeString(body.text, 10000);
    if (!version) return errorResponse("version é obrigatória");
    if (!text) return errorResponse("text é obrigatório");

    const { data, error } = await db.from("consent_versions")
      .insert({ version, text, is_active: false })
      .select("id, version, is_active, created_at").single();
    if (error) return errorResponse(error.message, 500);

    if (body.deactivate_previous !== false) {
      const { error: deactivateError } = await db.from("consent_versions")
        .update({ is_active: false })
        .eq("is_active", true)
        .neq("id", data.id);
      if (deactivateError) {
        await db.from("consent_versions").delete().eq("id", data.id);
        return errorResponse(deactivateError.message, 500);
      }
    }

    const { data: activated, error: activateError } = await db.from("consent_versions")
      .update({ is_active: true })
      .eq("id", data.id)
      .select("id, version, is_active, created_at")
      .single();
    if (activateError) return errorResponse(activateError.message, 500);

    await writeAdminAudit(db, req, userId, "consent_version", "publish", {
      entityId: data.id,
      meta: { version },
    });
    return jsonResponse(activated, 201);
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminSessions(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  const storeId = url.searchParams.get("store_id");
  const status = sanitizeString(url.searchParams.get("status"), 30);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const search = (sanitizeString(url.searchParams.get("q"), 120) || "").replace(/[,%().]/g, " ").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50") || 50), 200);
  const offset = (page - 1) * limit;

  let query = db
    .from("captive_sessions")
    .select("id, store_id, user_id, client_mac, client_ip, ap_mac, ssid, status, started_at, submitted_at, authorized_at, fail_reason, trace_id, last_step, unifi_authorize_called_at, unifi_cmd_accepted_at, unifi_confirmed_at, unifi_last_verify_result, stores(slug, name)", { count: "exact" })
    .order("started_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (storeId && isValidUUID(storeId)) query = query.eq("store_id", storeId);
  if (status) query = query.eq("status", status);
  if (from) query = query.gte("started_at", from.length === 10 ? `${from}T00:00:00.000Z` : from);
  if (to) query = query.lte("started_at", to.length === 10 ? `${to}T23:59:59.999Z` : to);
  if (search) query = query.or(`client_mac.ilike.%${search}%,client_ip.ilike.%${search}%,trace_id.ilike.%${search}%`);

  const { data, count, error } = await query;
  if (error) return errorResponse(error.message, 500);
  return jsonResponse({ data, total: count, page, limit });
}

async function handleAdminAudit(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);
  const { db } = auth;

  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50") || 50), 200);
  const offset = (page - 1) * limit;
  const entity = sanitizeString(url.searchParams.get("entity"), 80);
  const action = sanitizeString(url.searchParams.get("action"), 80);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  let query = db.from("audit_logs")
    .select("id, store_id, entity, entity_id, action, meta, created_at", { count: "exact" })
    .order("created_at", { ascending: false });
  if (entity) query = query.eq("entity", entity);
  if (action) query = query.eq("action", action);
  if (from) query = query.gte("created_at", from.length === 10 ? `${from}T00:00:00.000Z` : from);
  if (to) query = query.lte("created_at", to.length === 10 ? `${to}T23:59:59.999Z` : to);

  const { data, count, error } = await query.range(offset, offset + limit - 1);
  if (error) return errorResponse(error.message, 500);
  return jsonResponse({ data, total: count, page, limit });
}

async function handleAdminDiagnostics(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  if (req.method !== "GET") return errorResponse("Method not allowed", 405);
  const { db, userId } = auth;

  const storeId = url.searchParams.get("store_id");
  const traceId = sanitizeString(url.searchParams.get("trace_id"), 120);
  const probe = url.searchParams.get("probe") === "true";
  if (storeId && !isValidUUID(storeId)) return errorResponse("store_id inválido");

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let sessionQuery = db.from("captive_sessions")
    .select("id, status, fail_reason, trace_id, client_mac, client_ip, started_at, authorized_at, stores(slug, name)")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(500);
  if (storeId) sessionQuery = sessionQuery.eq("store_id", storeId);

  const [storesResult, settingsResult, consentResult, sessionsResult] = await Promise.all([
    db.from("stores")
      .select("id, slug, name, city, is_active, unifi_controller_url, unifi_site_id, post_auth_redirect_url")
      .order("name"),
    db.from("global_settings").select("session_duration_minutes, updated_at").eq("id", 1).maybeSingle(),
    db.from("consent_versions").select("id, version, created_at").eq("is_active", true).maybeSingle(),
    sessionQuery,
  ]);

  if (storesResult.error) return errorResponse(storesResult.error.message, 500);
  if (settingsResult.error) return errorResponse(settingsResult.error.message, 500);
  if (consentResult.error) return errorResponse(consentResult.error.message, 500);
  if (sessionsResult.error) return errorResponse(sessionsResult.error.message, 500);

  const sessions = sessionsResult.data || [];
  const statusCounts = sessions.reduce((acc: Record<string, number>, session: { status: string }) => {
    acc[session.status] = (acc[session.status] || 0) + 1;
    return acc;
  }, {});
  const failCounts = sessions.reduce((acc: Record<string, number>, session: { status: string; fail_reason: string | null }) => {
    if (session.status !== "authorized") {
      const reason = session.fail_reason || "sem_motivo_registrado";
      acc[reason] = (acc[reason] || 0) + 1;
    }
    return acc;
  }, {});

  const stores = storesResult.data || [];
  const selectedStore = storeId ? stores.find((store: { id: string }) => store.id === storeId) || null : null;
  const activeStores = stores.filter((store: { is_active: boolean }) => store.is_active);
  const incompleteStores = activeStores.filter((store: { unifi_controller_url: string | null; unifi_site_id: string | null }) => !store.unifi_controller_url || !store.unifi_site_id);

  let controllerProbe: Record<string, unknown> | null = null;
  if (probe) {
    if (!selectedStore) return errorResponse("Selecione uma loja para testar a controladora");
    if (!selectedStore.unifi_controller_url) {
      controllerProbe = { ok: false, code: "CONTROLLER_URL_MISSING", message: "URL da controladora não configurada" };
    } else if (!UNIFI_USERNAME || !UNIFI_PASSWORD) {
      controllerProbe = { ok: false, code: "UNIFI_SECRET_NOT_CONFIGURED", message: "Credenciais UniFi ausentes no ambiente" };
    } else {
      const startedAt = Date.now();
      const httpClient = createUnifiHttpClient();
      try {
        const parsed = new URL(selectedStore.unifi_controller_url);
        const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
        const login = await unifiLogin(baseUrl, httpClient, UNIFI_USERNAME, UNIFI_PASSWORD);
        if (!login.ok) {
          controllerProbe = { ok: false, code: "UNIFI_LOGIN_FAILED", message: login.error || "Falha no login", latency_ms: Date.now() - startedAt };
        } else {
          const headers = buildUnifiHeaders(login);
          const siteId = selectedStore.unifi_site_id || "default";
          const options: Record<string, unknown> = { method: "GET", headers, redirect: "manual" };
          if (httpClient) options.client = httpClient;
          const response = await fetch(`${baseUrl}/api/s/${siteId}/stat/device`, options as RequestInit);
          const payload = await response.json().catch(() => null);
          const devices = Array.isArray(payload?.data) ? payload.data : [];
          controllerProbe = {
            ok: response.ok,
            code: response.ok ? "OK" : "UNIFI_DEVICE_QUERY_FAILED",
            http_status: response.status,
            access_points: devices.filter((device: Record<string, unknown>) => device.type === "uap").length,
            latency_ms: Date.now() - startedAt,
          };
        }
      } catch (error) {
        controllerProbe = { ok: false, code: "UNIFI_PROBE_FAILED", message: (error as Error).message, latency_ms: Date.now() - startedAt };
      } finally {
        httpClient?.close();
      }

    }

    await writeAdminAudit(db, req, userId, "store", "diagnostic_probe", {
      entityId: selectedStore.id,
      storeId: selectedStore.id,
      meta: { ok: controllerProbe?.ok === true, code: controllerProbe?.code || null },
    });
  }

  let traceEvents: unknown[] = [];
  if (traceId) {
    const { data, error } = await db.from("portal_events")
      .select("id, session_id, trace_id, event_type, step, status, error_code, error_message, payload, created_at")
      .eq("trace_id", traceId)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) return errorResponse(error.message, 500);
    traceEvents = data || [];
  }

  return jsonResponse({
    generated_at: new Date().toISOString(),
    database: { ok: true },
    settings: settingsResult.data || null,
    active_consent: consentResult.data || null,
    stores: {
      total: stores.length,
      active: activeStores.length,
      incomplete: incompleteStores.map((store: { id: string; slug: string; name: string }) => ({ id: store.id, slug: store.slug, name: store.name })),
    },
    selected_store: selectedStore,
    controller_probe: controllerProbe,
    sessions_24h: {
      total: sessions.length,
      status_counts: statusCounts,
      top_failures: Object.entries(failCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, count]) => ({ reason, count })),
      recent_failures: sessions.filter((session: { status: string }) => session.status !== "authorized").slice(0, 25),
    },
    trace_events: traceEvents,
  });
}

async function handleAdminClusters(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db, userId } = auth;

  const city = url.searchParams.get("city");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const format = url.searchParams.get("format");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50") || 50), 500);
  const offset = (page - 1) * limit;

  let query = db
    .from("origin_ip_clusters")
    .select("id, public_ip, city, region, country, isp, asn, lead_count, first_seen_at, last_seen_at, geoip_provider", { count: "exact" })
    .order("last_seen_at", { ascending: false });

  if (city) query = (query as any).ilike("city", `%${city}%`);
  if (from) query = query.gte("last_seen_at", from.length === 10 ? `${from}T00:00:00.000Z` : from);
  if (to) query = query.lte("last_seen_at", to.length === 10 ? `${to}T23:59:59.999Z` : to);

  if (format === "csv") {
    const { data, error } = await (query as any).limit(10000);
    if (error) return errorResponse(error.message, 500);

    const headers = ["public_ip", "city", "region", "country", "isp", "asn", "lead_count", "first_seen_at", "last_seen_at"];
    const csvRows = [headers.map(escapeCsvCell).join(",")];
    for (const c of data || []) {
      csvRows.push([c.public_ip, c.city || "", c.region || "", c.country || "", c.isp || "", c.asn || "", c.lead_count, c.first_seen_at, c.last_seen_at].map(escapeCsvCell).join(","));
    }
    await writeAdminAudit(db, req, userId, "origin_ip_cluster", "export_csv", {
      meta: { city, from, to, count: data?.length || 0 },
    });
    return new Response(csvRows.join("\n"), {
      headers: { ...corsHeaders, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="clusters_${new Date().toISOString().slice(0, 10)}.csv"` },
    });
  }

  const { data, count, error } = await (query as any).range(offset, offset + limit - 1);
  if (error) return errorResponse(error.message, 500);
  return jsonResponse({ data, total: count, page, limit });
}

// ========== Admin: Store Public IPs ==========
async function handleAdminStoreIps(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db, userId } = auth;

  if (req.method === "GET") {
    const storeId = url.searchParams.get("store_id");
    let query = db.from("store_public_ips")
      .select("id, store_id, public_ip, is_active, created_at, stores(slug, name)")
      .order("created_at", { ascending: false });
    if (storeId && isValidUUID(storeId)) query = query.eq("store_id", storeId);
    const { data, error } = await query;
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data);
  }

  if (req.method === "POST") {
    const body = await safeParseJson(req);
    if (!body) return errorResponse("Invalid JSON");
    if (!isValidUUID(body.store_id)) return errorResponse("store_id inválido");
    const ip = sanitizeString(body.public_ip, 45);
    if (!ip || !Validators.ip(ip)) return errorResponse("public_ip inválido");

    const { data, error } = await db.from("store_public_ips")
      .insert({ store_id: body.store_id as string, public_ip: ip, is_active: body.is_active !== false })
      .select("id, store_id, public_ip, is_active")
      .single();
    if (error) return errorResponse(error.message, 500);
    await writeAdminAudit(db, req, userId, "store_public_ip", "create", {
      entityId: data.id,
      storeId: data.store_id,
      meta: { public_ip: data.public_ip },
    });
    return jsonResponse(data, 201);
  }

  if (req.method === "DELETE") {
    const body = await safeParseJson(req);
    if (!body || !isValidUUID(body.id)) return errorResponse("Missing or invalid id");
    const { data: existing } = await db.from("store_public_ips")
      .select("id, store_id, public_ip")
      .eq("id", body.id as string)
      .maybeSingle();
    const { error } = await db.from("store_public_ips").delete().eq("id", body.id as string);
    if (error) return errorResponse(error.message, 500);
    await writeAdminAudit(db, req, userId, "store_public_ip", "delete", {
      entityId: body.id as string,
      storeId: existing?.store_id || null,
      meta: { public_ip: existing?.public_ip || null },
    });
    return jsonResponse({ ok: true });
  }

  return errorResponse("Method not allowed", 405);
}

// ========== Admin: Access Points (AP MAC -> Store mapping) ==========
async function handleAdminAccessPoints(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db, userId } = auth;

  // GET /admin/access-points[?store_id=uuid]  -> list mappings
  if (req.method === "GET") {
    const storeId = url.searchParams.get("store_id");
    let query = db.from("store_access_points")
      .select("ap_mac, store_id, source, name, last_seen_at, created_at, stores(slug, name)")
      .order("created_at", { ascending: false });
    if (storeId && isValidUUID(storeId)) query = query.eq("store_id", storeId);
    const { data, error } = await query;
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data);
  }

  // POST /admin/access-points
  //   { ap_mac, store_id, name? }                              -> manual upsert
  //   { action: "import_from_controller", store_id }           -> bulk import via /stat/device
  if (req.method === "POST") {
    const body = await safeParseJson(req);
    if (!body) return errorResponse("Invalid JSON");

    // Bulk import action
    if (body.action === "import_from_controller") {
      if (!isValidUUID(body.store_id)) return errorResponse("store_id inválido");
      const { data: store } = await db.from("stores")
        .select("id, slug, unifi_controller_url, unifi_site_id")
        .eq("id", body.store_id as string)
        .maybeSingle();
      if (!store?.unifi_controller_url) return errorResponse("Loja sem controladora configurada");

      const ctrlUrl = store.unifi_controller_url.replace(/\/+$/, "");
      const user = UNIFI_USERNAME;
      const pass = UNIFI_PASSWORD;
      
      if (!user || !pass) {
        Logger.error("[admin-aps] UNIFI_SECRET_NOT_CONFIGURED", { store_slug: store.slug });
        return errorResponse("Configuração de credenciais UniFi ausente ou incompleta", 500);
      }
      
      const siteId = store.unifi_site_id || "default";
      const httpClient = createUnifiHttpClient();
      try {
        const parsed = new URL(ctrlUrl);
        const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
        const login = await unifiLogin(baseUrl, httpClient, user, pass);
        if (!login.ok || !serializeCookieJar(login.cookies || {})) {
          return errorResponse(`Falha no login UniFi: ${login.error || "unknown"}`, 502);
        }
        const headers = buildUnifiHeaders(login);
        const opts: Record<string, unknown> = { method: "GET", headers, redirect: "manual" };
        if (httpClient) opts.client = httpClient;
        const rDev = await fetch(`${baseUrl}/api/s/${siteId}/stat/device`, opts as RequestInit);
        const devList = await rDev.json().catch(() => null);
        const aps = Array.isArray(devList?.data)
          ? devList.data.filter((d: Record<string, unknown>) => d.type === "uap" && typeof d.mac === "string")
          : [];

        const rows = aps.map((d: Record<string, unknown>) => ({
          ap_mac: (d.mac as string),
          store_id: store.id,
          source: "imported",
          name: (d.name as string) || null,
        }));

        if (rows.length === 0) return jsonResponse({ imported: 0, message: "Nenhum AP (uap) encontrado na controladora" });

        const { error: upErr, data: upData } = await db
          .from("store_access_points")
          .upsert(rows, { onConflict: "ap_mac" })
          .select("ap_mac");
        if (upErr) return errorResponse(upErr.message, 500);

        const imported = upData?.length || rows.length;
        await writeAdminAudit(db, req, userId, "store_access_point", "import", {
          storeId: store.id,
          meta: { imported, store_slug: store.slug },
        });
        return jsonResponse({ imported, store_slug: store.slug });
      } catch (err) {
        return errorResponse((err as Error).message, 502);
      } finally {
        httpClient?.close();
      }
    }

    // Manual single upsert
    if (!isValidUUID(body.store_id)) return errorResponse("store_id inválido");
    const macRaw = sanitizeString(body.ap_mac, 32);
    const normalizedMac = normalizeMac(macRaw);
    if (!normalizedMac) return errorResponse("ap_mac inválido");

    const { data, error } = await db.from("store_access_points")
      .upsert({
        ap_mac: normalizedMac,
        store_id: body.store_id as string,
        source: "manual",
        name: sanitizeString(body.name, 100),
      }, { onConflict: "ap_mac" })
      .select("ap_mac, store_id, source, name")
      .single();
    if (error) return errorResponse(error.message, 500);
    await writeAdminAudit(db, req, userId, "store_access_point", "upsert", {
      storeId: body.store_id as string,
      meta: { ap_mac: normalizedMac, source: "manual" },
    });
    return jsonResponse(data, 201);
  }

  // DELETE /admin/access-points  { ap_mac }
  if (req.method === "DELETE") {
    const body = await safeParseJson(req);
    const macRaw = sanitizeString(body?.ap_mac, 32);
    if (!macRaw) return errorResponse("ap_mac obrigatório");
    const apMac = macRaw.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
    if (apMac.length !== 12) return errorResponse("ap_mac inválido");
    const { data: existing } = await db.from("store_access_points")
      .select("ap_mac, store_id")
      .eq("ap_mac", apMac)
      .maybeSingle();
    const { error } = await db.from("store_access_points").delete().eq("ap_mac", apMac);
    if (error) return errorResponse(error.message, 500);
    await writeAdminAudit(db, req, userId, "store_access_point", "delete", {
      storeId: existing?.store_id || null,
      meta: { ap_mac: apMac },
    });
    return jsonResponse({ ok: true });
  }

  return errorResponse("Method not allowed", 405);
}





// ========== XML Export (Admin) ==========
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function handleAdminLeadsXml(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db, userId } = auth;

  const storeSlug = url.searchParams.get("store_slug");
  const scope = storeSlug ? "store" : (url.searchParams.get("scope") || "all");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  let query = db.from("leads")
    .select("id, name, cpf, email, phone, client_mac, created_at, consented_at, consent_version, origin_ip, origin_city, origin_region, stores(slug, name)")
    .order("created_at", { ascending: false }).limit(10000);

  let resolvedStoreId: string | null = null;
  if (storeSlug) {
    const { data: storeData } = await db.from("stores").select("id").eq("slug", storeSlug).maybeSingle();
    if (!storeData) return errorResponse("Store not found", 404);
    resolvedStoreId = storeData.id;
    query = query.eq("store_id", storeData.id);
  }
  if (from) query = query.gte("created_at", from.length === 10 ? `${from}T00:00:00.000Z` : from);
  if (to) query = query.lte("created_at", to.length === 10 ? `${to}T23:59:59.999Z` : to);

  const { data: leads, error } = await query;
  if (error) return errorResponse(error.message, 500);

  const rows = leads || [];
  const now = new Date().toISOString();
  const dateStamp = now.slice(0, 10).replace(/-/g, "");

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<leads_export>\n`;
  xml += `  <generated_at>${escapeXml(now)}</generated_at>\n`;
  xml += `  <scope>${escapeXml(scope)}</scope>\n`;
  if (storeSlug) xml += `  <store_slug>${escapeXml(storeSlug)}</store_slug>\n`;
  xml += `  <count>${rows.length}</count>\n`;

  for (const lead of rows) {
    const storeInfo = lead.stores as unknown as { slug: string; name: string } | null;
    xml += `  <lead>\n`;
    xml += `    <id>${escapeXml(lead.id)}</id>\n`;
    xml += `    <store_slug>${escapeXml(storeInfo?.slug || "")}</store_slug>\n`;
    xml += `    <store_name>${escapeXml(storeInfo?.name || "")}</store_name>\n`;
    xml += `    <name>${escapeXml(lead.name || "")}</name>\n`;
    if ((lead as any).cpf) xml += `    <cpf>${escapeXml((lead as any).cpf)}</cpf>\n`;
    if (lead.email) xml += `    <email>${escapeXml(lead.email)}</email>\n`;
    if (lead.phone) xml += `    <phone>${escapeXml(lead.phone)}</phone>\n`;
    if (lead.client_mac) xml += `    <client_mac>${escapeXml(lead.client_mac)}</client_mac>\n`;
    if ((lead as any).origin_ip) xml += `    <origin_ip>${escapeXml((lead as any).origin_ip)}</origin_ip>\n`;
    if ((lead as any).origin_city) xml += `    <origin_city>${escapeXml((lead as any).origin_city)}</origin_city>\n`;
    if ((lead as any).origin_region) xml += `    <origin_region>${escapeXml((lead as any).origin_region)}</origin_region>\n`;
    xml += `    <created_at>${escapeXml(lead.created_at)}</created_at>\n`;
    xml += `    <consented_at>${escapeXml(lead.consented_at)}</consented_at>\n`;
    xml += `    <consent_version>${escapeXml(lead.consent_version)}</consent_version>\n`;
    xml += `  </lead>\n`;
  }

  xml += `</leads_export>`;
  const filename = storeSlug ? `leads_${storeSlug}_${dateStamp}.xml` : `leads_all_${dateStamp}.xml`;

  await writeAdminAudit(db, req, userId, "lead", "export_xml", {
    storeId: resolvedStoreId,
    meta: { scope, store_slug: storeSlug, from, to, count: rows.length },
  });

  return new Response(xml, {
    headers: { ...corsHeaders, "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` },
  });
}

// ========== Housekeeping (Admin manual) ==========
async function previewHousekeeping(db: ReturnType<typeof supabaseAdmin>): Promise<Record<string, number>> {
  const now = new Date();
  const verifCutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  const rateLimitCutoff = new Date(now.getTime() - 86400000).toISOString();
  const sessionCutoff180 = new Date(now.getTime() - 180 * 86400000).toISOString();
  const sessionCutoff365 = new Date(now.getTime() - 365 * 86400000).toISOString();
  const auditCutoff = new Date(now.getTime() - 180 * 86400000).toISOString();

  const [verifications, rateLimits, oldSessions, authorizedSessions, auditLogs, oauthHandoffs] = await Promise.all([
    db.from("captive_verifications").select("id", { count: "exact", head: true }).lt("expires_at", verifCutoff).in("status", ["pending", "expired", "locked"]),
    db.from("rate_limits").select("key", { count: "exact", head: true }).lt("updated_at", rateLimitCutoff),
    db.from("captive_sessions").select("id", { count: "exact", head: true }).lt("started_at", sessionCutoff180).in("status", ["started", "submitted", "failed"]),
    db.from("captive_sessions").select("id", { count: "exact", head: true }).lt("started_at", sessionCutoff365).eq("status", "authorized"),
    db.from("audit_logs").select("id", { count: "exact", head: true }).lt("created_at", auditCutoff),
    db.from("oauth_browser_handoffs").select("id", { count: "exact", head: true }).lt("expires_at", now.toISOString()),
  ]);

  const firstError = [verifications, rateLimits, oldSessions, authorizedSessions, auditLogs, oauthHandoffs].find((result) => result.error)?.error;
  if (firstError) throw new Error(firstError.message);
  return {
    expired_verifications: verifications.count || 0,
    old_rate_limits: rateLimits.count || 0,
    old_sessions: (oldSessions.count || 0) + (authorizedSessions.count || 0),
    old_audit_logs: auditLogs.count || 0,
    expired_oauth_handoffs: oauthHandoffs.count || 0,
  };
}

async function handleHousekeeping(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db, userId } = auth;

  const body = await safeParseJson(req);
  if (!body) return errorResponse("JSON inválido");
  if (body.dry_run !== false) {
    const wouldRemove = await previewHousekeeping(db);
    return jsonResponse({ ok: true, dry_run: true, would_remove: wouldRemove });
  }

  if (body.confirmation !== "EXCLUIR DADOS EXPIRADOS") {
    return errorResponse("Confirmação inválida. Faça a simulação antes de executar.", 409);
  }

  const cleaned = await internalHousekeeping(db);
  await writeAdminAudit(db, req, userId, "system", "housekeeping", {
    meta: { cleaned },
  });
  return jsonResponse({ ok: true, cleaned });
}

// ========== Housekeeping (Cron) ==========
async function handleCronHousekeeping(req: Request): Promise<Response> {
  // Authenticate via CRON_SECRET
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!CRON_SECRET || !token || token !== CRON_SECRET) {
    return errorResponse("Unauthorized", 401);
  }

  const db = supabaseAdmin();
  const cleaned = await internalHousekeeping(db);

  Logger.info("Cron housekeeping completed");
  return jsonResponse({ ok: true, cleaned });
}

// ========== Self-contained HTML Portal ==========
async function handlePortalHtml(_req: Request, url: URL): Promise<Response> {
  // Deterministic redirect to the canonical React portal
  // Preserves all captive parameters for the SPA to pick up
  const target = new URL("https://minasbrasilwifi.com.br");
  url.searchParams.forEach((value, key) => {
    if (key !== "attempt_id" && key !== "resume_token") target.searchParams.set(key, value);
  });
  
  return Response.redirect(target.toString(), 302);
}

/**
 * Deterministic handler for OAuth callbacks (Google/Apple).
 * Ensures session parameters are passed back to the React SPA correctly.
 */
async function handleOAuthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL("https://minasbrasilwifi.com.br/oauth/callback");
  const allowed = new Set(["code", "error", "error_code", "error_description"]);
  
  url.searchParams.forEach((value, key) => {
    if (allowed.has(key)) target.searchParams.set(key, value);
  });
  
  // The React app will detect the hash/params and complete the sign-in
  return Response.redirect(target.toString(), 302);
}

// ========== Client-side telemetry ==========
async function handleClientEvent(req: Request): Promise<Response> {
  const clientIp = getPublicIp(req) || "unknown";
  const ua = req.headers.get("user-agent")?.slice(0, 500) || null;
  const db = supabaseAdmin();

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  const sessionId = isValidUUID(body.session_id) ? (body.session_id as string) : null;
  const eventName = (Validators.string(body.event, 64) || "client_event").toLowerCase();
  const step = (Validators.string(body.step, 32) || "client") as any;
  const status = (Validators.string(body.status, 16) || "info") as any;
  const errorCode = Validators.string(body.error_code, 64);
  const errorMessage = Validators.string(body.error_message, 500);
  const traceId = Validators.string(body.trace_id, 64) || getTraceId(req, body);

  // Rate limit per session/ip - more aggressive for non-critical telemetry
  const rl = await checkRateLimitDb(db, `client-event:${sessionId || clientIp}:${eventName}`, 30, 60, 100);
  if (!rl.allowed) return jsonResponse({ ok: true, throttled: true });

  let payload: Record<string, unknown> | null = null;
  if (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) {
    payload = body.payload as Record<string, unknown>;
  }

  // Fire and forget logging
  logEvent(db, {
    session_id: sessionId,
    trace_id: traceId,
    event_type: `client_${eventName}`.slice(0, 64),
    step,
    status,
    error_code: errorCode || undefined,
    error_message: errorMessage || undefined,
    payload,
    client_ip: clientIp,
    user_agent: ua,
  });

  return jsonResponse({ ok: true });
}

// ========== Auth (email + password) handlers ==========

interface AuthAuthorizeContext {
  clientMac: string | null;
  apMac: string | null;
  ssid: string | null;
  redirectUrl: string | null;
  captiveTimestamp: string | null;
  storeHint?: string | null;
}

function extractAuthContext(body: Record<string, unknown>): AuthAuthorizeContext {
  return {
    clientMac: Validators.mac(body.client_mac),
    apMac: Validators.mac(body.ap_mac),
    ssid: Validators.string(body.ssid, 64),
    redirectUrl: Validators.string(body.redirect_url, 500),
    captiveTimestamp: Validators.string(body.captive_timestamp, 32),
    storeHint: Validators.string(body.store_hint ?? body.store, 64),
  };
}

async function getValidatedAuthContext(
  db: ReturnType<typeof supabaseAdmin>,
  body: Record<string, unknown>,
  contextName: string
): Promise<{ ctx: AuthAuthorizeContext; attemptId: string | null; resumeToken: string | null; error?: Response }> {
  const initialCtx = extractAuthContext(body);
  const attemptId = typeof body.attempt_id === "string" ? body.attempt_id : null;
  const resumeToken = typeof body.resume_token === "string" ? body.resume_token : null;

  if (!attemptId && !resumeToken) {
    return { 
      ctx: initialCtx, 
      attemptId: null, 
      resumeToken: null, 
      error: jsonResponse({ 
        error: "Tentativa server-side obrigatória não encontrada. Inicie o processo novamente.", 
        code: "ATTEMPT_REQUIRED" 
      }, 403) 
    };
  }

  if (!attemptId || !resumeToken) {
    return { 
      ctx: initialCtx, 
      attemptId, 
      resumeToken, 
      error: jsonResponse({ 
        error: "Contrato inválido: attempt_id e resume_token devem ser fornecidos em par.", 
        code: "INVALID_ATTEMPT_PAIR" 
      }, 400) 
    };
  }
  
  const val = await validateOAuthAttempt(db, attemptId, resumeToken);
  if (val.status === 'invalid') {
    return { 
      ctx: initialCtx, 
      attemptId, 
      resumeToken, 
      error: jsonResponse({ 
        error: val.error || "Tentativa expirada ou inválida. Por favor, reinicie o processo.", 
        code: "invalid_attempt" 
      }, 403) 
    };
  }
  
  if (val.params) {
    Logger.info(`[${contextName}] auth context validated`, { attempt_id: attemptId });
    return { ctx: val.params, attemptId, resumeToken };
  }
  
  return { ctx: initialCtx, attemptId, resumeToken };


}


/**
 * Runs authorization for a logged-in user after signup/login/silent-login.
 * Creates (or reuses) a captive_sessions row for this visit, upserts
 * leads by user_id, and calls unifiAuthorize on the detected store.
 */
/**
 * Creates (or reuses) a captive_sessions row for this visit, upserts
 * leads by user_id, and calls unifiAuthorize on the detected store.
 * 
 * IMPLEMENTS SERVER-SIDE IDEMPOTENCY:
 * 1. Uses a server-authoritative transactional claim (attempt_id).
 * 2. If a session is already completed, returns the cached result.
 */
async function authorizeAuthenticatedUser(args: {
  db: ReturnType<typeof supabaseAdmin>;
  userId: string;
  profile: { full_name: string; cpf_digits: string | null; phone_digits: string | null; email: string; cpf_required?: boolean };
  ctx: AuthAuthorizeContext;
  req: Request;
  authMethod: "password" | "silent" | "google" | "apple";
  traceId: string;
  clientIp: string | null;
  userAgent: string | null;
  attemptId: string | null;
  resumeToken: string | null;
}): Promise<{
  session_id: string | null;
  authorized: boolean;
  redirect_url: string;
  fail_reason?: string;
  replay?: boolean;
  processing?: boolean;
  store_slug: string;
  store_id: string | null;
}> {
  const { db, userId, profile, ctx, req, authMethod, traceId, clientIp, userAgent, attemptId, resumeToken } = args;


  let detected = await detectStoreFromRequest(db, req, ctx.apMac, ctx.storeHint);
  if (!detected.store_id && ctx.clientMac) {
    const discovered = await discoverStoreByClientMac(db, ctx.clientMac);
    if (discovered) detected = discovered;
  }
  const storeSlug = detected.store_slug;
  const storeId = detected.store_id;

  if (attemptId && storeId) {
    await db.from("captive_auth_attempts").update({
      store_id: storeId,
      store_hint: storeSlug,
      store_detection_source: detected.detection_source,
    }).eq("id", attemptId);
  }
  const nowIso = new Date().toISOString();
  // A trace id is shared by retries and concurrent requests, so it must never
  // be used as lease ownership. Every invocation gets an unguessable owner.
  const leaseOwner = `worker-${crypto.randomUUID()}`;

  // TRANSACTIONAL CLAIM
  // Implements server-authoritative transactional claim to prevent concurrent authorizations.
  if (!attemptId) {
    // Valid attempt_id and resume_token are required for everything that releases Wi-Fi.
    Logger.error("[auth] attempt capability missing", { auth_method: authMethod });
    if (!attemptId || !resumeToken) {
      return {
        session_id: null,
        authorized: false,
        redirect_url: detected.redirect_url || DEFAULT_REDIRECT_URL,
        fail_reason: "MISSING_ATTEMPT_TOKENS",
        store_slug: storeSlug,
        store_id: storeId,
      };
    }
    return {
      session_id: null,
      authorized: false,
      redirect_url: detected.redirect_url || DEFAULT_REDIRECT_URL,
      fail_reason: "MISSING_ATTEMPT_ID",
      store_slug: storeSlug,
      store_id: storeId,
    };
  }

  const { data: claimRes, error: claimErr } = await db.rpc("claim_auth_attempt", {
    p_attempt_id: attemptId,
    p_user_id: userId,
    p_lease_owner: leaseOwner,
    p_resume_token: resumeToken
  });

  if (claimErr || !claimRes || claimRes.length === 0) {
    Logger.error("[auth] claim RPC failed", { code: claimErr?.code || "CLAIM_FAILED" });
    return {
      session_id: null,
      authorized: false,
      redirect_url: detected.redirect_url || DEFAULT_REDIRECT_URL,
      fail_reason: "CLAIM_FAILED",
      store_slug: storeSlug,
      store_id: storeId,
    };
  }

  const claim = claimRes[0];

  // RECOVERY LOGIC
  if (claim.result_status === 'recovery_required') {
    Logger.warn("[auth] Recovery required; checking UniFi state", { attempt_id: attemptId });
    
    const { data: store } = await db.from("stores").select("unifi_controller_url, unifi_site_id").eq("id", storeId).maybeSingle();
    
    if (store?.unifi_controller_url) {
      // Usar MAC da sessão se existir (pode ser o effective_mac persistido), fallback para context.
      let macToCheck = ctx.clientMac;
      if (claim.session_id) {
        const { data: sess } = await db.from("captive_sessions").select("client_mac").eq("id", claim.session_id).maybeSingle();
        if (sess?.client_mac) macToCheck = sess.client_mac;
      }

      const check = await checkUnifiAuthorizationState(
        store.unifi_controller_url,
        store.unifi_site_id,
        macToCheck || "",
        Deno.env.get("UNIFI_USERNAME"),
        Deno.env.get("UNIFI_PASSWORD"),
        ctx.apMac,
        ctx.ssid,
      );

      if (check.state === 'authorized') {
        Logger.info("[auth] recovery confirmed an existing controller authorization", { attempt_id: attemptId });
        const finalRedirect = detected.redirect_url || DEFAULT_REDIRECT_URL;
        const { data: finalizeRes } = await db.rpc("finalize_auth_attempt", {
          p_attempt_id: attemptId,
          p_lease_owner: leaseOwner,
          p_session_id: claim.session_id,
          p_authorized: true,
          p_redirect_url: finalRedirect,
          p_fail_reason: null,
          p_result_code: "RECOVERED_ALREADY_AUTHORIZED"
        });

        const isFinalized = Array.isArray(finalizeRes) && finalizeRes[0]?.finalized;

        return {
          session_id: claim.session_id,
          authorized: isFinalized ? (finalizeRes[0]?.authorized ?? false) : false,
          redirect_url: isFinalized ? (finalizeRes[0]?.redirect_url ?? finalRedirect) : finalRedirect,
          fail_reason: isFinalized ? undefined : "FINALIZE_RECOVERY_FAILED",
          store_slug: storeSlug,
          store_id: storeId,
        };
      } else if (check.state === 'not_authorized') {
        Logger.info("[auth] recovery found no controller authorization; retry released", { attempt_id: attemptId });
        await db.rpc("release_auth_retry", {
          p_attempt_id: attemptId,
          p_lease_owner: leaseOwner
        });
        return {
          session_id: claim.session_id,
          authorized: false,
          redirect_url: detected.redirect_url || DEFAULT_REDIRECT_URL,
          fail_reason: "RETRY_REQUIRED",
          store_slug: storeSlug,
          store_id: storeId,
        };
      }
    }

    // Inconclusive or no store
    return {
      session_id: claim.session_id,
      authorized: false,
      redirect_url: detected.redirect_url || DEFAULT_REDIRECT_URL,
      fail_reason: "PROCESSING_IN_PROGRESS",
      store_slug: storeSlug,
      store_id: storeId,
    };
  }

  if (claim.result_status === 'failed') {
    return {
      session_id: claim.session_id,
      authorized: claim.authorized,
      redirect_url: claim.redirect_url || (detected.redirect_url || DEFAULT_REDIRECT_URL),
      fail_reason: claim.fail_reason,
      store_slug: storeSlug,
      store_id: storeId,
    };
  }

  if (claim.result_status === 'completed') {
    Logger.info(`[auth] Replay detected for attempt ${attemptId}`);
    return {
      session_id: claim.session_id,
      authorized: claim.authorized,
      redirect_url: claim.redirect_url || (detected.redirect_url || DEFAULT_REDIRECT_URL),
      store_slug: storeSlug,
      store_id: storeId,
      replay: true,
    };
  }

  if (claim.result_status === 'processing') {
    Logger.info(`[auth] Concurrent request active`, { attempt_id: attemptId });
    return {
      session_id: claim.session_id,
      authorized: false,
      redirect_url: detected.redirect_url || DEFAULT_REDIRECT_URL,
      fail_reason: "PROCESSING_IN_PROGRESS",
      processing: true,
      store_slug: storeSlug,
      store_id: storeId,
    };
  }

  // STATUS: claimed=true. Only now we proceed to authorizeClient.
  let sessionId = claim.session_id;

  // If we don't have a sessionId, we need to create one.
  if (!sessionId) {
    const sessionInsert: Record<string, unknown> = {
      store_id: storeId,
      user_id: userId,
      auth_method: authMethod,
      status: "submitted",
      client_mac: ctx.clientMac,
      ap_mac: ctx.apMac,
      ssid: ctx.ssid,
      redirect_url: ctx.redirectUrl,
      captive_timestamp: ctx.captiveTimestamp,
      trace_id: traceId,
      submitted_at: nowIso,
      form_submitted_at: nowIso,
      params_received_at: nowIso,
      last_step: "form",
      user_agent: userAgent ? userAgent.slice(0, 500) : null,
      client_ip: clientIp,
      attempt_id: attemptId
    };

    const { data: session, error: sErr } = await db
      .from("captive_sessions")
      .insert(sessionInsert)
      .select("id")
      .single();

    if (sErr || !session?.id) {
      Logger.error("[auth] captive_sessions insert failed", { error: sErr?.message });
      // Finalize as failed so the claim is released
      await db.rpc("finalize_auth_attempt", {
        p_attempt_id: attemptId,
        p_lease_owner: leaseOwner,
        p_session_id: null,
        p_authorized: false,
        p_fail_reason: "SESSION_INSERT_FAILED",
        p_result_code: "DB_ERROR"
      });
      return {
        session_id: null,
        authorized: false,
        redirect_url: detected.redirect_url || DEFAULT_REDIRECT_URL,
        fail_reason: "SESSION_INSERT_FAILED",
        store_slug: storeSlug,
        store_id: storeId,
      };
    }
    sessionId = session.id;
  }

  const { data: activeConsent } = await db
    .from("consent_versions")
    .select("version")
    .eq("is_active", true)
    .maybeSingle();

  // Upsert lead by user_id. Never hard-code a consent version: the active
  // server-side record is authoritative for both password and Google flows.
  try {
    const { data: existingLead } = await db
      .from("leads")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    const leadPayload: Record<string, unknown> = {
      user_id: userId,
      name: profile.full_name,
      email: profile.email,
      phone: profile.phone_digits,
      cpf: profile.cpf_digits,
      client_mac: ctx.clientMac,
      last_seen_at: nowIso,
      last_seen_store_id: storeId,
      store_id: storeId,
    };
    if (existingLead?.id) {
      await db.from("leads").update(leadPayload).eq("id", existingLead.id);
    } else {
      await db.from("leads").insert({
        ...leadPayload,
        first_seen_at: nowIso,
        consented_at: nowIso,
        consent_version: activeConsent?.version || "unavailable",
      });
    }
  } catch (e) {
    Logger.warn("[auth] lead upsert failed", { error: (e as Error).message });
  }

  logEvent(db, {
    session_id: sessionId,
    trace_id: traceId,
    store_id: storeId,
    event_type: "unifi_authorize_from_auth_flow",
    step: "unifi",
    status: "info",
    payload: { auth_method: authMethod, store_slug: storeSlug, attempt_id: attemptId },
    client_ip: clientIp,
    user_agent: userAgent,
  });

  let authResult: { ok: boolean; reason?: string; userMessage?: string; cmd_accepted_at?: string; last_verify_result?: Record<string, unknown> | null; pending_confirmation?: boolean; confirm?: Promise<any> };
  
  try {
    authResult = await authorizeClient(
      db, storeId, storeSlug, ctx.clientMac, sessionId, clientIp || "",
      { apMac: ctx.apMac, ssid: ctx.ssid, fastReturn: false },
    );
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    Logger.error(`[auth] authorizeClient exception for attempt ${attemptId}:`, errorMsg);
    
    // Log exception event
    logEvent(db, {
      session_id: sessionId,
      trace_id: traceId,
      store_id: storeId,
      event_type: "unifi_authorize_exception",
      step: "unifi",
      status: "error",
      error_code: "AUTHORIZE_CLIENT_EXCEPTION",
      error_message: errorMsg,
      payload: { auth_method: authMethod, store_slug: storeSlug, attempt_id: attemptId },
      client_ip: clientIp,
      user_agent: userAgent,
    });

    // A network/timeout exception can happen after the controller accepted the
    // command. Keep the attempt in authorizing until its lease expires so the
    // recovery path performs a read-only UniFi check. Marking it failed here
    // would make a successful controller command unrecoverable.
    const normalizedError = errorMsg.toLowerCase();
    const isAmbiguous = normalizedError.includes("fetch") ||
      normalizedError.includes("timeout") ||
      normalizedError.includes("network") ||
      normalizedError.includes("connection");

    if (!isAmbiguous) {
      const { data: finalizeFailure, error: finalizeFailureError } = await db.rpc("finalize_auth_attempt", {
        p_attempt_id: attemptId,
        p_lease_owner: leaseOwner,
        p_session_id: sessionId,
        p_authorized: false,
        p_fail_reason: "AUTHORIZE_INTERNAL_ERROR",
        p_result_code: "FAILED"
      });
      const failureRecord = Array.isArray(finalizeFailure) ? finalizeFailure[0] : null;
      if (finalizeFailureError || !failureRecord?.finalized) {
        Logger.error("[auth] failed to persist internal authorization error", {
          code: finalizeFailureError?.code || failureRecord?.status_final || "FINALIZE_FAILED"
        });
      }
    }

    return {
      session_id: sessionId,
      authorized: false,
      redirect_url: detected.redirect_url || DEFAULT_REDIRECT_URL,
      fail_reason: isAmbiguous ? "PROCESSING_IN_PROGRESS" : "INTERNAL_ERROR",
      store_slug: storeSlug,
      store_id: storeId,
    };
  }

  // Persist the controller result before returning success.
  const finalRedirect = detected.redirect_url || DEFAULT_REDIRECT_URL;

  // The controller accepted the command, but the station endpoint did not yet
  // reflect it. Keep the attempt under its existing lease so recovery performs
  // a read-only confirmation instead of sending a second authorization command.
  if (authResult.pending_confirmation && authResult.cmd_accepted_at) {
    return {
      session_id: sessionId,
      authorized: false,
      redirect_url: finalRedirect,
      fail_reason: "PROCESSING_IN_PROGRESS",
      processing: true,
      store_slug: storeSlug,
      store_id: storeId,
    };
  }

  const { data: finalizeRes, error: finalizeErr } = await db.rpc("finalize_auth_attempt", {
    p_attempt_id: attemptId,
    p_lease_owner: leaseOwner,
    p_session_id: sessionId,
    p_authorized: !!authResult.ok,
    p_redirect_url: finalRedirect,
    p_fail_reason: authResult.ok ? null : (authResult.reason || "AUTHORIZE_FAILED"),
    p_result_code: authResult.ok ? "SUCCESS" : "UNIFI_ERROR"
  });

  const finalRecord = Array.isArray(finalizeRes) ? finalizeRes[0] : null;
  const isActuallyFinalized = !!finalRecord?.finalized;
  const isActuallyAuthorized = isActuallyFinalized && !!finalRecord?.authorized;

  if (finalizeErr || !isActuallyFinalized) {
    Logger.error("[auth] Finalization failed", { attempt_id: attemptId, error: finalizeErr?.message || finalRecord?.status_final });
  }

  return {
    session_id: sessionId,
    authorized: isActuallyAuthorized,
    redirect_url: isActuallyAuthorized ? (finalRecord?.redirect_url || finalRedirect) : finalRedirect,
    fail_reason: isActuallyAuthorized ? undefined : (authResult.reason || finalRecord?.status_final || "AUTHORIZE_FAILED"),
    store_slug: storeSlug,
    store_id: storeId,
  };
}


function validatePasswordStrength(pw: unknown): { ok: boolean; reason?: string } {
  if (typeof pw !== "string" || pw.length < 8) return { ok: false, reason: "weak_password" };
  if (pw.length > 200) return { ok: false, reason: "weak_password" };
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return { ok: false, reason: "weak_password" };
  return { ok: true };
}

function getPasswordResetRedirect(): string {
  const configured = Deno.env.get("PASSWORD_RESET_REDIRECT_URL") ||
    "https://minasbrasilwifi.com.br/reset-password";
  try {
    const url = new URL(configured);
    if (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      return url.toString();
    }
  } catch { /* fall through to the canonical URL */ }
  return "https://minasbrasilwifi.com.br/reset-password";
}

async function handleRequestPasswordReset(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const ua = req.headers.get("user-agent") || "";
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");
  const traceId = getTraceId(req, body);

  const email = sanitizeString(body.email, MAX_EMAIL_LEN)?.toLowerCase() || null;
  if (!email || !isValidEmail(email)) {
    return jsonResponse({ error: "E-mail inválido.", code: "invalid_email" }, 400);
  }

  const emailHash = await sha256Hex(email);
  const rl = await checkRateLimitDb(db, `pwreset:ip:${clientIp || "unknown"}:${emailHash}`, 900, 3, 1800);
  if (!rl.allowed) {
    // Still respond with generic OK to avoid enumeration; log the throttle.
    logEvent(db, {
      trace_id: traceId, event_type: "password_reset_rate_limited", step: "form", status: "warning",
      payload: null, client_ip: clientIp, user_agent: ua,
    });
    return jsonResponse({ ok: true });
  }

  const redirectTo = getPasswordResetRedirect();

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: resetErr } = await anonClient.auth.resetPasswordForEmail(email, { redirectTo });

  logEvent(db, {
    trace_id: traceId,
    event_type: resetErr ? "password_reset_failed" : "password_reset_requested",
    step: "form",
    status: resetErr ? "error" : "info",
    payload: { redirect_to: redirectTo },
    client_ip: clientIp,
    user_agent: ua,
  });

  // Always respond OK to prevent account enumeration
  return jsonResponse({ ok: true });
}

async function handleSignup(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const ua = req.headers.get("user-agent") || "";
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");
  const traceId = getTraceId(req, body);

  const name = sanitizeString(body.name, MAX_NAME_LEN);
  const { ctx, attemptId, resumeToken, error: authErr } = await getValidatedAuthContext(db, body, "signup");
  if (authErr) return authErr;

  const email = sanitizeString(body.email, MAX_EMAIL_LEN)?.toLowerCase() || null;

  const cpfDigits = typeof body.cpf === "string" ? body.cpf.replace(/\D/g, "") : "";
  const phoneDigits = typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!name || name.length < 2) {
    return jsonResponse({ error: "Nome inválido.", code: "invalid_name" }, 400);
  }
  if (!email || !isValidEmail(email)) {
    return jsonResponse({ error: "E-mail inválido.", code: "invalid_email" }, 400);
  }
  // CPF is now OPTIONAL (Google/Apple accounts don't provide it).
  // If sent, must be a valid CPF.
  if (cpfDigits && !isValidCPF(cpfDigits)) {
    return jsonResponse({ error: "CPF inválido.", code: "invalid_cpf" }, 400);
  }
  // Phone is optional too now.
  if (phoneDigits && !isValidPhone(phoneDigits)) {
    return jsonResponse({ error: "Telefone inválido.", code: "invalid_phone" }, 400);
  }
  const pwCheck = validatePasswordStrength(password);
  if (!pwCheck.ok) {
    return jsonResponse({ error: "A senha deve ter ao menos 8 caracteres, com letras e números.", code: "weak_password" }, 400);
  }

  const rl = await checkRateLimitDb(db, `signup:ip:${clientIp || "unknown"}`, 3600, 5, 1800);
  if (!rl.allowed) {
    return jsonResponse({ error: "Muitas tentativas. Aguarde alguns minutos.", code: "rate_limited" }, 429);
  }

  logEvent(db, {
    trace_id: traceId, event_type: "signup_started", step: "form", status: "info",
    payload: null, client_ip: clientIp, user_agent: ua,
  });

  // Pre-check: CPF already registered? (only when CPF was provided)
  if (cpfDigits) {
    const { data: cpfExists } = await db
      .from("profiles").select("id").eq("cpf_digits", cpfDigits).limit(1).maybeSingle();
    if (cpfExists?.id) {
      logEvent(db, {
        trace_id: traceId, event_type: "signup_failed", step: "form", status: "error",
        error_code: "cpf_already_registered", payload: null, client_ip: clientIp,
      });
      return jsonResponse({
        error: "Este CPF já possui conta. Entre com o e-mail cadastrado ou recupere a senha.",
        code: "cpf_already_registered",
      }, 409);
    }
  }


  // Create auth user (email confirmed so captive flow can proceed)
  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: name,
      cpf_digits: cpfDigits || null,
      phone_digits: phoneDigits || null,
    },
  });



  if (createErr || !created?.user?.id) {
    const msg = (createErr?.message || "").toLowerCase();
    let code = "signup_failed";
    let userMsg = "Não foi possível criar a conta. Tente novamente.";
    let httpStatus = 400;
    if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
      code = "email_already_registered";
      userMsg = "Este e-mail já possui conta. Faça login ou recupere a senha.";
      httpStatus = 409;
    } else if (msg.includes("password")) {
      code = "weak_password";
      userMsg = "Senha muito fraca.";
    }
    logEvent(db, {
      trace_id: traceId, event_type: "signup_failed", step: "form", status: "error",
      error_code: code, payload: null, client_ip: clientIp,
    });
    return jsonResponse({ error: userMsg, code }, httpStatus);
  }

  const userId = created.user.id;

  // Insert profile
  const { error: profErr } = await db.from("profiles").insert({
    id: userId,
    full_name: name,
    cpf_digits: cpfDigits || null,
    phone_digits: phoneDigits || null,
    email,
  });

  if (profErr) {
    Logger.error("[signup] profile insert failed", { code: profErr.code || "PROFILE_INSERT_FAILED" });
    // Roll back the auth user so retry works
    try { await db.auth.admin.deleteUser(userId); } catch { /* ignore */ }
    // Postgres unique_violation on profiles_cpf_digits_key → race with another signup
    const isCpfDup = (profErr.code === "23505") || /cpf_digits/i.test(profErr.message || "");
    if (isCpfDup) {
      logEvent(db, {
        trace_id: traceId, event_type: "signup_failed", step: "form", status: "error",
        error_code: "cpf_already_registered", error_message: profErr.message, client_ip: clientIp,
      });
      return jsonResponse({
        error: "Este CPF já possui conta. Entre com o e-mail cadastrado ou recupere a senha.",
        code: "cpf_already_registered",
      }, 409);
    }
    logEvent(db, {
      trace_id: traceId, event_type: "signup_failed", step: "form", status: "error",
      error_code: "profile_insert_failed", error_message: profErr.message, client_ip: clientIp,
    });
    return jsonResponse({ error: "Erro ao criar perfil.", code: "profile_insert_failed" }, 500);
  }

  // Sign in to get tokens
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: sessionData, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
  if (signInErr || !sessionData?.session) {
    logEvent(db, {
      trace_id: traceId, event_type: "signup_failed", step: "form", status: "error",
      error_code: "post_signup_signin_failed", error_message: signInErr?.message, client_ip: clientIp,
    });
    return jsonResponse({ error: "Conta criada, mas não foi possível entrar. Tente fazer login.", code: "post_signup_signin_failed" }, 500);
  }

  // Already validated at start of handleSignup




  const result = await authorizeAuthenticatedUser({
    db, userId, ctx, req, authMethod: "password", traceId, clientIp, userAgent: ua,
    profile: { full_name: name, cpf_digits: cpfDigits || null, phone_digits: phoneDigits || null, email },
    attemptId,
    resumeToken
  });


  logEvent(db, {
    session_id: result.session_id, trace_id: traceId, event_type: "signup_success",
    step: "form", status: "success", payload: { store_slug: result.store_slug }, client_ip: clientIp,
  });

  return jsonResponse({
    session_id: result.session_id,
    authorized: result.authorized,
    redirect_url: result.redirect_url,
    fail_reason: result.fail_reason,
    access_token: sessionData.session.access_token,
    refresh_token: sessionData.session.refresh_token,
    trace_id: traceId,
  });
}

async function handleLogin(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const ua = req.headers.get("user-agent") || "";
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");
  const traceId = getTraceId(req, body);

  const email = sanitizeString(body.email, MAX_EMAIL_LEN)?.toLowerCase() || null;
  const password = typeof body.password === "string" ? body.password : "";
  const { ctx, attemptId, resumeToken, error: authErr } = await getValidatedAuthContext(db, body, "login");
  if (authErr) return authErr;

  if (!email || !isValidEmail(email) || !password) {

    return jsonResponse({ error: "E-mail ou senha inválidos.", code: "invalid_credentials" }, 400);
  }

  const rlIp = await checkRateLimitDb(db, `login:ip:${clientIp || "unknown"}`, 300, 20, 900);
  if (!rlIp.allowed) {
    return jsonResponse({ error: "Muitas tentativas. Aguarde alguns minutos.", code: "rate_limited" }, 429);
  }
  const emailHash = await sha256Hex(email);
  const rlEmail = await checkRateLimitDb(db, `login:email:${emailHash}`, 300, 5, 900);
  if (!rlEmail.allowed) {
    return jsonResponse({ error: "Muitas tentativas para este e-mail. Aguarde.", code: "rate_limited" }, 429);
  }

  logEvent(db, { trace_id: traceId, event_type: "login_started", step: "form", status: "info", payload: null, client_ip: clientIp, user_agent: ua });

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: sessionData, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
  if (signInErr || !sessionData?.session || !sessionData?.user) {
    logEvent(db, {
      trace_id: traceId, event_type: "login_failed", step: "form", status: "error",
      error_code: "invalid_credentials", payload: null, client_ip: clientIp,
    });
    return jsonResponse({ error: "E-mail ou senha inválidos.", code: "invalid_credentials" }, 401);
  }

  const userId = sessionData.user.id;
  if (await getActiveUserBlock(db, userId)) {
    logEvent(db, {
      trace_id: traceId, event_type: "blocked_user_denied", step: "form", status: "warning",
      error_code: "user_blocked", client_ip: clientIp,
    });
    return jsonResponse({ error: "Acesso bloqueado. Procure o atendimento.", code: "user_blocked" }, 403);
  }

  // Load profile
  const { data: profile, error: profErr } = await db
    .from("profiles").select("full_name, cpf_digits, phone_digits, email").eq("id", userId).maybeSingle();
  if (profErr || !profile) {
    logEvent(db, {
      trace_id: traceId, event_type: "login_failed", step: "form", status: "error",
      error_code: "profile_not_found", error_message: profErr?.message, client_ip: clientIp,
    });
    return jsonResponse({ error: "Perfil não encontrado. Faça um novo cadastro.", code: "profile_not_found" }, 404);
  }

  // Already validated at start of handleLogin



  const result = await authorizeAuthenticatedUser({
    db, userId, ctx, req, authMethod: "password", traceId, clientIp, userAgent: ua, profile,
    attemptId,
    resumeToken
  });


  logEvent(db, {
    session_id: result.session_id,
    trace_id: traceId,
    event_type: result.authorized ? "login_success" : "login_failed",
    step: "form",
    status: result.authorized ? "success" : "warning",
    error_code: result.authorized ? null : (result.fail_reason || "WIFI_NOT_AUTHORIZED"),
    payload: { store_slug: result.store_slug, fail_reason: result.fail_reason || null },
    client_ip: clientIp,
  });

  return jsonResponse({
    session_id: result.session_id,
    authorized: result.authorized,
    redirect_url: result.redirect_url,
    fail_reason: result.fail_reason,
    access_token: sessionData.session.access_token,
    refresh_token: sessionData.session.refresh_token,
    trace_id: traceId,
  });
}

async function handleAuthorizeExisting(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const ua = req.headers.get("user-agent") || "";
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");
  const traceId = getTraceId(req, body);

  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken || accessToken.length < 20) {
    return jsonResponse({ needs_login: true, error: "missing_token" }, 401);
  }

  // Validate token via getUser (project rule: use getUser, not getClaims)
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data: userRes, error: userErr } = await anonClient.auth.getUser(accessToken);
  if (userErr || !userRes?.user?.id) {
    logEvent(db, {
      trace_id: traceId, event_type: "silent_login_failed", step: "form", status: "warning",
      error_code: "invalid_token", error_message: userErr?.message, client_ip: clientIp,
    });
    return jsonResponse({ needs_login: true, error: "invalid_token" }, 401);
  }
  const userId = userRes.user.id;
  const activeBlock = await getActiveUserBlock(db, userId);
  if (activeBlock) {
    logEvent(db, {
      trace_id: traceId, event_type: "blocked_user_denied", step: "form", status: "warning",
      error_code: "user_blocked", client_ip: clientIp,
    });
    return jsonResponse({ error: "Acesso bloqueado. Procure o atendimento.", code: "user_blocked" }, 403);
  }
  const provider = String((userRes.user.app_metadata as any)?.provider || "").toLowerCase();
  const authMethod: "silent" | "google" | "apple" =
    provider === "google" ? "google" :
    provider === "apple" ? "apple" :
    "silent";

  const { ctx: validatedCtx, attemptId, resumeToken, error: authErr } = await getValidatedAuthContext(db, body, "authorize-existing");
  if (authErr) return authErr;

  const ctx = validatedCtx;

  if (attemptId && resumeToken) {
    const val = await validateOAuthAttempt(db, attemptId, resumeToken);
    // val won't be invalid here because getValidatedAuthContext already checked it.
    
    // Protection against user_id swap
    if (val.attempt.user_id && val.attempt.user_id !== userId) {
      Logger.error("[auth] Attempt already linked to another user", { attempt_id: attemptId });
      return jsonResponse({ error: "Esta tentativa pertence a outro usuário.", code: "forbidden_attempt" }, 403);
    }

    // Replay a previously persisted result without a new controller command.
    if (val.status === 'completed') {
      Logger.info("[auth] Replay detected; reusing persisted result", { attempt_id: attemptId });
      
      const { data: sess } = await db.from("captive_sessions")
        .select("id, status")
        .eq("attempt_id", attemptId)
        .maybeSingle();
      
      const storeRes = await detectStoreFromRequest(db, req, ctx.apMac, ctx.storeHint);

      return jsonResponse({
        session_id: sess?.id || null,
        authorized: true,
        redirect_url: val.attempt.redirect_url || storeRes.redirect_url || DEFAULT_REDIRECT_URL,
        store_slug: storeRes.store_slug,
        store_id: storeRes.store_id,
        auth_method: authMethod,
        trace_id: traceId,
        replay: true
      });
    }
  } else {
    // Both missing (allowed for non-authoritative paths like direct email login)
    // but google auth MUST have tokens
    if (authMethod === "google") {
      Logger.warn("[auth] Google login rejected because attempt tokens are missing");
      return jsonResponse({ error: "Transação de login inválida ou incompleta.", code: "missing_attempt_tokens" }, 403);
    }
  }

  if (ctx.clientMac) {
    const rlMac = await checkRateLimitDb(db, `authexisting:mac:${ctx.clientMac}`, 60, 20, 60);
    if (!rlMac.allowed) {
      return jsonResponse({ error: "Muitas tentativas. Aguarde.", code: "rate_limited" }, 429);
    }
  }

  const { data: existingProfile } = await db
    .from("profiles")
    .select("full_name, cpf_digits, phone_digits, email, cpf_required")
    .eq("id", userId)
    .maybeSingle();

  let profile = existingProfile;

  // Auto-provision profile for OAuth users (Google/Apple) on first sign-in.
  if (!profile) {
    const meta = (userRes.user.user_metadata || {}) as Record<string, unknown>;
    const fullName =
      (typeof meta.full_name === "string" && meta.full_name) ||
      (typeof meta.name === "string" && meta.name) ||
      (typeof meta.given_name === "string" && meta.given_name) ||
      (userRes.user.email ? userRes.user.email.split("@")[0] : "Cliente");
    const emailValue = userRes.user.email || (typeof meta.email === "string" ? meta.email : null);
    if (!emailValue) {
      return jsonResponse({ needs_login: true, error: "profile_missing_email" }, 400);
    }
    const { error: insErr } = await db.from("profiles").insert({
      id: userId,
      full_name: String(fullName).slice(0, MAX_NAME_LEN),
      email: emailValue.toLowerCase(),
      cpf_digits: null,
      phone_digits: null,
      cpf_required: true,
    });
    if (insErr) {
      Logger.error("[authorize-existing] profile auto-create failed", { code: insErr.code || "PROFILE_CREATE_FAILED" });
      return jsonResponse({ needs_login: true, error: "profile_create_failed" }, 500);
    }
    profile = {
      full_name: String(fullName),
      email: emailValue.toLowerCase(),
      cpf_digits: null,
      phone_digits: null,
      cpf_required: true,
    } as any;
    logEvent(db, {
      trace_id: traceId, event_type: "profile_auto_created", step: "form", status: "info",
      payload: { provider }, client_ip: clientIp,
    });
  }

  // authMethod is already determined earlier to support replay logic

  // Check if CPF is required before UniFi authorization
  // Authoritative CPF validation.
  const storedCpf = profile?.cpf_digits || "";
  const isCpfInvalid = !Validators.cpf(storedCpf);
  
  if (authMethod === "google") {
    if (profile?.cpf_required || isCpfInvalid) {
      logEvent(db, {
        trace_id: traceId, event_type: "google_auth_cpf_pending", step: "form", status: "info",
        payload: { attempt_id: attemptId, cpf_invalid: isCpfInvalid }, client_ip: clientIp,
      });

      // Atomic link attempt to user before CPF step
      if (attemptId) {
        await db.from("captive_auth_attempts").update({ user_id: userId }).eq("id", attemptId);
      }

      return jsonResponse({
        needs_cpf: true,
        authorized: false,
        auth_method: "google",
        profile: {
          full_name: profile?.full_name,
          email: profile?.email
        },
        trace_id: traceId,
      });
    }
  }

  const result = await authorizeAuthenticatedUser({
    db, userId, ctx, req, authMethod, traceId, clientIp, userAgent: ua, 
    profile: profile as any,
    attemptId,
    resumeToken
  });



  // Background sync with CRM on authenticated login success (if lead is complete)
  if (result.authorized && profile?.cpf_digits && profile?.full_name && profile?.phone_digits) {
    const bgSync = (async () => {
      try {
        await syncWithClubeMais({
          cpf: profile.cpf_digits!,
          name: profile.full_name!,
          phone: profile.phone_digits!,
          email: profile.email,
          store_id: result.store_id || null,
        }, db, traceId);
      } catch (e) {
        Logger.warn("[authorize-existing] CRM sync failed", { error: (e as Error).message });
      }
    })();
    // @ts-ignore
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(bgSync);
    }
  }

  logEvent(db, {
    session_id: result.session_id, trace_id: traceId,
    event_type: result.authorized ? "silent_login_success" : "silent_login_failed",
    step: "form", status: result.authorized ? "success" : "warning",
    payload: { store_slug: result.store_slug, fail_reason: result.fail_reason, auth_method: authMethod }, client_ip: clientIp,
  });

  return jsonResponse({
    session_id: result.session_id,
    authorized: result.authorized,
    redirect_url: result.redirect_url,
    fail_reason: result.fail_reason,
    store_slug: result.store_slug,
    store_id: result.store_id,
    auth_method: authMethod,
    replay: result.replay || false,
    processing: result.processing || false,
    trace_id: traceId,
  });
}


async function handleUpdateProfile(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const ua = req.headers.get("user-agent") || "";
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");
  const traceId = getTraceId(req, body);

  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) return errorResponse("Unauthorized", 401);

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data: userRes, error: userErr } = await anonClient.auth.getUser(accessToken);
  if (userErr || !userRes?.user?.id) return errorResponse("Unauthorized", 401);
  const userId = userRes.user.id;
  if (await getActiveUserBlock(db, userId)) {
    return jsonResponse({ error: "Acesso bloqueado. Procure o atendimento.", code: "user_blocked" }, 403);
  }

  const cpfDigits = typeof body.cpf === "string" ? body.cpf.replace(/\D/g, "") : null;
  const phoneDigits = typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : null;
  const name = typeof body.name === "string" ? sanitizeString(body.name, MAX_NAME_LEN) : null;
  const consentVersion = Validators.string(body.consent_version, 64);

  if (phoneDigits) {
    if (!isValidPhone(phoneDigits)) return errorResponse("Telefone inválido.");
  }

  if (!cpfDigits && !phoneDigits && !name) return jsonResponse({ ok: true });

  // --- CPF Handle ---
  if (cpfDigits) {
    const { data: activeConsent, error: consentError } = await db
      .from("consent_versions")
      .select("version")
      .eq("is_active", true)
      .maybeSingle();
    if (consentError || !activeConsent?.version || consentVersion !== activeConsent.version) {
      return jsonResponse({
        error: "Leia e aceite os termos de privacidade atuais para continuar.",
        code: "CONSENT_REQUIRED",
      }, 409);
    }
    if (!Validators.cpf(cpfDigits)) {
      Logger.warn("[update-profile] invalid CPF rejected", { trace_id: traceId });
      return errorResponse("CPF inválido.", 400);
    }

    const { data: cpfRes, error: cpfErr } = await db.rpc("secure_set_cpf", {
      _user_id: userId,
      _cpf_digits: cpfDigits,
    });

    if (cpfErr || !cpfRes?.ok) {
      const err = cpfErr?.message || cpfRes?.error || "CPF_UPDATE_FAILED";
      if (err === "CPF_ALREADY_EXISTS") {
        return errorResponse("Este CPF já está cadastrado em outra conta.", 409);
      }
      Logger.error("[update-profile] secure_set_cpf failed", { trace_id: traceId, code: err });
      return errorResponse("Erro ao atualizar CPF.", 400);
    }
    Logger.info("[update-profile] CPF stored", { trace_id: traceId });
  }

  // --- Profile Update (Name/Phone) ---
  if (name || phoneDigits) {
    const { data: profileRes, error: profileErr } = await db.rpc("secure_update_profile", {
      _user_id: userId,
      _full_name: name,
      _phone_digits: phoneDigits,
    });

    if (profileErr || !profileRes?.ok) {
      Logger.error("[update-profile] secure_update_profile failed", {
        trace_id: traceId,
        code: profileErr?.code || profileRes?.error || "PROFILE_UPDATE_FAILED"
      });
      return errorResponse("Erro ao atualizar perfil.");
    }
  }

  // Background sync with CRM on profile update
  if (cpfDigits && name && phoneDigits) {
    const { data: userProfile } = await db.from("profiles").select("email").eq("id", userId).maybeSingle();
    const bgSync = (async () => {
      try {
        await syncWithClubeMais({
          cpf: cpfDigits,
          name: name,
          phone: phoneDigits,
          email: userProfile?.email || null,
        }, db, traceId);
      } catch (e) {
        Logger.warn("[update-profile] ClubeMais sync failed", { error: (e as Error).message });
      }
    })();
    // @ts-ignore
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(bgSync);
    }
  }

  logEvent(db, {
    trace_id: traceId, event_type: "profile_updated", step: "form", status: "success",
    payload: {
      fields: [cpfDigits ? "cpf" : null, phoneDigits ? "phone" : null, name ? "name" : null].filter(Boolean),
      consent_version: cpfDigits ? consentVersion : null,
    },
    client_ip: clientIp,
    user_agent: ua,
  });

  return jsonResponse({ ok: true });
}

// ========== Main Router ==========


function isValidUUID(id: unknown): boolean { return Validators.uuid(id); }
function isValidMac(mac: string | null): boolean { return Validators.mac(mac) !== null; }
function sanitizeString(s: unknown, maxLen: number): string | null { return Validators.string(s, maxLen); }
function normalizeMac(mac: unknown): string | null { return Validators.mac(mac); }
function isValidEmail(email: string): boolean { return Validators.email(email); }
function isValidPhone(phone: string): boolean { return Validators.phone(phone); }
function isValidCPF(cpf: string): boolean { return Validators.cpf(cpf); }
function isValidSlug(slug: string): boolean { return Validators.slug(slug); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const routeFallback = url.searchParams.get("route");
  const path = routeFallback && routeFallback.startsWith("/")
    ? routeFallback
    : url.pathname.replace(/^\/captive-portal/, "");

  try {
    // 1. System/Health endpoints
    if (path === "/health") return jsonResponse({ status: "ok" });
    if (path === "/ready") {
      const readyDb = supabaseAdmin();
      const { error: databaseError } = await readyDb
        .from("global_settings")
        .select("id")
        .eq("id", 1)
        .maybeSingle();
      const { data: activeStores, error: storesError } = await readyDb
        .from("stores")
        .select("slug, unifi_controller_url, unifi_site_id")
        .eq("is_active", true);
      const invalidStores = (activeStores || []).filter((store) =>
        store.unifi_controller_url !== canonicalUnifiControllerUrl(store.slug) ||
        !store.unifi_site_id
      );
      const checks = {
        database: !databaseError,
        unifi_credentials: !!UNIFI_USERNAME && !!UNIFI_PASSWORD,
        controller_configuration: !storesError && invalidStores.length === 0 && (activeStores?.length || 0) > 0,
        invalid_controller_stores: invalidStores.map((store) => store.slug),
        cron_secret: !!CRON_SECRET,
      };
      const ready = checks.database && checks.unifi_credentials && checks.controller_configuration;
      return jsonResponse({ status: ready ? "ready" : "degraded", checks }, ready ? 200 : 503);
    }

    // 2. Redirect standard captive aliases to React portal
    if (
      (path === "/" || path === "" || path === "/portal" || path === "/portal/" ||
        path.startsWith("/guest/s/") || path === "/generate_204" || path === "/gen_204" ||
        path === "/hotspot-detect.html" || path === "/library/test/success.html" ||
        path === "/connecttest.txt" || path === "/ncsi.txt") &&
      req.method === "GET"
    ) return await handlePortalHtml(req, url);


    // 2. Public portal endpoints
    if (path === "/bootstrap" && req.method === "GET") return await handleBootstrap(req);
    if (path === "/client-event" && req.method === "POST") return await handleClientEvent(req);
    if (path === "/login" && req.method === "POST") return await handleLogin(req);
  if (path === "/oauth/init" && req.method === "POST") return await handleOAuthInit(req);
  if (path === "/oauth/restart" && req.method === "POST") return await handleOAuthRestart(req);
  if (path === "/oauth/handoff/create" && req.method === "POST") return await handleOAuthHandoffCreate(req);
  if (path === "/oauth/handoff/claim" && req.method === "POST") return await handleOAuthHandoffClaim(req);

    if (path === "/oauth/callback") return await handleOAuthCallback(req);
    if (path === "/update-profile" && req.method === "POST") return await handleUpdateProfile(req);
    if (path === "/signup" && req.method === "POST") return await handleSignup(req);
    if (path === "/request-password-reset" && req.method === "POST") return await handleRequestPasswordReset(req);
    if (path === "/authorize-existing" && req.method === "POST") return await handleAuthorizeExisting(req);

    // 3. Admin endpoints (requires service_role/admin auth)
    if (path === "/admin/me") return await handleAdminMe(req);
    if (path === "/admin/users") return await handleAdminUsers(req, url);
    if (path === "/admin/settings") return await handleAdminSettings(req);
    if (path === "/admin/stores") return await handleAdminStores(req);
    if (path === "/admin/store-ips") return await handleAdminStoreIps(req, url);
    if (path === "/admin/access-points") return await handleAdminAccessPoints(req, url);
    if (path === "/admin/leads-xml" && req.method === "GET") return await handleAdminLeadsXml(req, url);
    if (path === "/admin/leads/actions") return await handleAdminLeadActions(req);
    if (path === "/admin/leads") return await handleAdminLeads(req, url);
    if (path === "/admin/consent") return await handleAdminConsent(req);
    if (path === "/admin/sessions") return await handleAdminSessions(req, url);
    if (path === "/admin/diagnostics") return await handleAdminDiagnostics(req, url);
    if (path === "/admin/audit") return await handleAdminAudit(req, url);
    if (path === "/admin/clusters") return await handleAdminClusters(req, url);
    
    
    if (path === "/admin/housekeeping" && req.method === "POST") return await handleHousekeeping(req);

    // 4. System endpoints
    if (path === "/cron/housekeeping" && req.method === "POST") return await handleCronHousekeeping(req);

    return errorResponse("Not found", 404);
  } catch (err) {
    Logger.error("Unhandled error", { error: err });
    return errorResponse("Internal server error", 500);
  }
});


// ========== Authoritative OAuth Transaction Handler ==========

/**
 * Validates attempt tokens against the database.
 * Returns the captive parameters if valid and not expired/consumed.
 */
async function validateOAuthAttempt(
  db: any,
  attemptId: string,
  token: string
): Promise<{
  status: 'active' | 'processing' | 'completed' | 'invalid';
  params?: AuthAuthorizeContext;
  error?: string;
  attempt?: any;
}> {
  if (!isValidUUID(attemptId) || !token) {
    return { status: 'invalid', error: "Parâmetros de tentativa inválidos." };
  }

  // Tokens are stored hashed in DB
  const tokenHash = await sha256Hex(token);

  const { data: attempt, error: fetchErr } = await db
    .from("captive_auth_attempts")
    .select("*")
    .eq("id", attemptId)
    .maybeSingle();

  if (fetchErr || !attempt) {
    return { status: 'invalid', error: "Tentativa de login não encontrada." };
  }

  // Constant-time comparison using a simple equality for the hash
  if (attempt.resume_token_hash !== tokenHash) {
    return { status: 'invalid', error: "Transação de login inválida." };
  }

  if (attempt.status === 'expired' || new Date(attempt.expires_at) < new Date()) {
    if (attempt.status !== 'expired') {
      await db.from("captive_auth_attempts").update({ status: 'expired' }).eq("id", attemptId);
    }
    return { status: 'invalid', error: "Esta tentativa expirou. Inicie o processo novamente." };
  }

  // Terminal states (failed, cancelled) are invalid
  if (attempt.status === 'failed' || attempt.status === 'cancelled') {
    return { status: 'invalid', error: `Esta tentativa foi finalizada com erro ou cancelada (status: ${attempt.status}).` };
  }

  // Interpret persisted attempt state.
  let status: 'active' | 'processing' | 'completed' | 'invalid' = 'active';
  if (attempt.status === 'authorized') {
    status = 'completed';
  } else if (attempt.status === 'authorizing' || attempt.status === 'verifying') {
    status = 'processing';
  }

  const params: AuthAuthorizeContext = {
    clientMac: attempt.client_mac,
    apMac: attempt.ap_mac,
    ssid: attempt.ssid,
    redirectUrl: attempt.original_url, 
    captiveTimestamp: attempt.captive_timestamp,
    storeHint: attempt.store_hint,
  };

  return { status, params, attempt };
}

async function handleOAuthInit(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const ua = req.headers.get("user-agent");
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Requisição inválida (JSON esperado).");

  const rawParams = (body.params || {}) as Record<string, string>;
  const clientMac = normalizeMac(rawParams.id || rawParams.mac);
  const apMac = normalizeMac(rawParams.ap);
  
  if (!clientMac) {
    return errorResponse("Endereço MAC do dispositivo não identificado.");
  }

  // Rate limit by IP/MAC fail-closed
  try {
    const rl = await checkRateLimitDb(db, `oauth-init:mac:${clientMac}`, 60, 5, 300);
    if (!rl.allowed) return errorResponse("Muitas tentativas. Aguarde alguns minutos.", 429);
  } catch (e) {
    Logger.error("[oauth-init] Rate limiter error", { error: (e as Error).message });
    return errorResponse("Serviço temporariamente indisponível.", 503);
  }

  // Resolve the store before sending the customer through authentication.
  // This prevents a successful Google/CPF flow from ending in
  // NO_STORE_CONFIGURED and makes the result survive a browser handoff.
  let detected = await detectStoreFromRequest(
    db,
    req,
    apMac,
    null,
    sanitizeString(rawParams.store, 64),
  );
  if (!detected.store_id) {
    const discovered = await discoverStoreByClientMac(db, clientMac);
    if (discovered) detected = discovered;
  }
  if (!detected.store_id) {
    logEvent(db, {
      trace_id: getTraceId(req, body),
      store_id: null,
      event_type: "store_resolution_failed_before_auth",
      step: "params",
      status: "error",
      error_code: "STORE_NOT_RESOLVED",
      payload: {
        has_ap_mac: !!apMac,
        has_store_hint: !!sanitizeString(rawParams.store, 64),
        has_url_store_hint: !!new URL(req.url).searchParams.get("store"),
      },
      client_ip: clientIp,
      user_agent: ua,
    });
    return jsonResponse({
      error: "Não foi possível identificar esta unidade. Reconecte-se ao Wi-Fi e tente novamente.",
      code: "STORE_NOT_RESOLVED",
    }, 409);
  }

  // Cryptographically strong random token (opaque)
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Hash it for DB storage
  const tokenHash = await sha256Hex(token);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

  const { data: attempt, error: insErr } = await db
    .from("captive_auth_attempts")
    .insert({
      resume_token_hash: tokenHash,
      client_mac: clientMac,
      ap_mac: apMac,
      ssid: sanitizeString(rawParams.ssid, 64),
      store_id: detected.store_id,
      store_hint: detected.store_slug,
      store_detection_source: detected.detection_source,
      captive_timestamp: sanitizeString(rawParams.t, 32),
      original_url: sanitizeString(body.original_url as string, 500),
      expires_at: expiresAt.toISOString(),
      status: 'created',
      metadata: {
        client_ip: clientIp,
        user_agent: ua,
        requested_redirect_url: sanitizeString(rawParams.url, 500),
        supplied_store_hint: sanitizeString(rawParams.store, 64),
      }
    })
    .select("id")
    .single();

  if (insErr || !attempt?.id) {
    Logger.error("[oauth-init] insert failed", { code: insErr?.code || "ATTEMPT_INSERT_FAILED" });
    return errorResponse("Erro ao inicializar transação de login.", 500);
  }

  return jsonResponse({
    attempt_id: attempt.id,
    token: token,
    store: { slug: detected.store_slug, name: detected.store_name, city: detected.store_city },
    detection_source: detected.detection_source,
  });
}

async function handleOAuthHandoffCreate(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Requisição inválida (JSON esperado).");

  const attemptId = typeof body.attempt_id === "string" ? body.attempt_id : "";
  const resumeToken = typeof body.resume_token === "string" ? body.resume_token : "";
  const validation = await validateOAuthAttempt(db, attemptId, resumeToken);
  if (validation.status !== "active" || !validation.attempt) {
    return jsonResponse({ error: "Tentativa inválida ou expirada.", code: "INVALID_ATTEMPT" }, 403);
  }

  const rateLimit = await checkRateLimitDb(db, `oauth-handoff:${attemptId}`, 60, 3, 300);
  if (!rateLimit.allowed) return errorResponse("Muitas tentativas. Aguarde alguns minutos.", 429);

  const codeBytes = new Uint8Array(32);
  crypto.getRandomValues(codeBytes);
  const code = Array.from(codeBytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const codeHash = await sha256Hex(code);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const { error } = await db.from("oauth_browser_handoffs").upsert({
    attempt_id: attemptId,
    code_hash: codeHash,
    expires_at: expiresAt,
    claimed_at: null,
  }, { onConflict: "attempt_id" });
  if (error) {
    Logger.error("[oauth-handoff] create failed", { code: error.code || "HANDOFF_CREATE_FAILED" });
    return errorResponse("Não foi possível preparar a abertura no navegador.", 500);
  }

  await db.from("captive_auth_attempts").update({ status: "oauth_redirected" }).eq("id", attemptId);
  logEvent(db, {
    trace_id: getTraceId(req, body),
    store_id: validation.attempt.store_id || null,
    event_type: "oauth_browser_handoff_created",
    step: "params",
    status: "success",
    client_ip: clientIp,
    user_agent: req.headers.get("user-agent"),
  });

  return jsonResponse({
    handoff_url: `https://minasbrasilwifi.com.br/oauth/continue?handoff=${code}`,
    expires_at: expiresAt,
  });
}

async function handleOAuthHandoffClaim(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const body = await safeParseJson(req);
  const code = typeof body?.handoff === "string" ? body.handoff.trim() : "";
  if (!/^[a-f0-9]{64}$/i.test(code)) {
    return jsonResponse({ error: "Transferência inválida.", code: "HANDOFF_INVALID" }, 400);
  }

  const codeHash = await sha256Hex(code.toLowerCase());
  const rateLimit = await checkRateLimitDb(db, `oauth-handoff-claim:${clientIp || "unknown"}`, 60, 10, 300);
  if (!rateLimit.allowed) return errorResponse("Muitas tentativas. Aguarde alguns minutos.", 429);

  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const tokenHash = await sha256Hex(token);

  const { data, error } = await db.rpc("claim_oauth_browser_handoff", {
    p_code_hash: codeHash,
    p_new_resume_token_hash: tokenHash,
  });
  const claim = Array.isArray(data) ? data[0] : null;
  if (error || !claim?.attempt_id) {
    Logger.warn("[oauth-handoff] invalid or expired claim", { code: error?.code || "HANDOFF_CLAIM_FAILED" });
    return jsonResponse({ error: "Esta transferência expirou ou já foi utilizada.", code: "HANDOFF_EXPIRED" }, 410);
  }

  logEvent(db, {
    trace_id: getTraceId(req, body),
    event_type: "oauth_browser_handoff_claimed",
    step: "params",
    status: "success",
    client_ip: clientIp,
    user_agent: req.headers.get("user-agent"),
  });

  return jsonResponse({
    attempt_id: claim.attempt_id,
    token,
    params: {
      id: claim.client_mac,
      ap: claim.ap_mac || undefined,
      ssid: claim.ssid || undefined,
      store: claim.store_hint || undefined,
      t: claim.captive_timestamp || undefined,
      url: claim.requested_redirect_url || undefined,
    },
  });
}

async function handleOAuthRestart(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const body = await safeParseJson(req);
  
  if (!body || !body.attempt_id || !body.resume_token) {
    return errorResponse("Parâmetros attempt_id e resume_token são obrigatórios.", 400);
  }

  const attemptId = body.attempt_id as string;
  const resumeToken = body.resume_token as string;

  // 1. Rate Limit fail-closed
  try {
    const rl = await checkRateLimitDb(db, `oauth-restart:ip:${clientIp || 'unknown'}`, 60, 3, 300);
    if (!rl.allowed) return errorResponse("Muitas tentativas de reinício. Aguarde.", 429);
    
    const rlMac = await checkRateLimitDb(db, `oauth-restart:attempt:${attemptId}`, 60, 3, 300);
    if (!rlMac.allowed) return errorResponse("Limite de reinício excedido para esta tentativa.", 429);
  } catch (e) {
    Logger.error("[oauth-restart] Rate limiter unavailable", { error: (e as Error).message });
    return errorResponse("Serviço temporariamente indisponível.", 503);
  }

  // 2. Executar RPC transacional
  const { data, error } = await db.rpc("safe_restart_oauth_attempt", {
    p_attempt_id: attemptId,
    p_resume_token: resumeToken,
    p_client_ip: clientIp
  });

  if (error || !data || data.length === 0) {
    const msg = error?.message || "Erro ao reiniciar sessão.";
    Logger.error("[oauth-restart] RPC failed", { code: error?.code || "OAUTH_RESTART_FAILED" });
    
    if (msg === 'INVALID_TOKEN' || msg === 'ATTEMPT_NOT_FOUND') {
      return errorResponse("Transação inválida ou token incorreto.", 403);
    }
    if (msg === 'INVALID_STATE_FOR_RESTART') {
      return errorResponse("Esta sessão não pode ser reiniciada no estado atual.", 400);
    }
    
    return errorResponse("Não foi possível reiniciar a sessão.", 500);
  }

  const result = data[0];
  return jsonResponse({
    attempt_id: result.new_attempt_id,
    token: result.new_token
  });
}
