import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";
import {
  extractCsrfFromToken,
  mergeResponseCookies,
  serializeCookieJar,
  type UnifiCookieJar,
} from "../_shared/unifi-cookie.ts";
import { normalizeBrazilianPhone, storedPhoneMatches } from "../_shared/identity.ts";
import { drainAuthorization, reconcileAuthorization, requiredRpc, withOperationDeadline, type AuthOperation } from "../_shared/durable-auth.ts";
import {
  canonicalUnifiMac,
  exactUnifiEvidence,
  fetchUnifiResponse,
  fetchUnifiStationsStrict,
  parseUnifiEnvelope,
  sendUnifiAuthorizeOnce,
  type UnifiStation,
  type UnifiCommandResult,
  type UnifiAuthorizationEvidence,
} from "../_shared/unifi-authorization.ts";
import {
  DEFAULT_MAX_DAILY_ACCESSES,
  hasReachedDailyAccessLimit,
  normalizeDailyAccessLimit,
  startOfDayInTimeZoneIso,
} from "../_shared/daily-access.ts";


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
      .replace(/(password|token|secret|resume_token|access_token|refresh_token|csrf_token|token_hash|session_token_hash)=[^&\r\n,;\s]+/gi, "$1=[REDACTED]")
      .replace(/"(password|token|secret|resume_token|access_token|refresh_token|csrf_token|token_hash|session_token_hash)":\s*"[^"]+"/gi, "\"$1\": \"[REDACTED]\"")
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
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
}

function rateLimitedResponse(blockedUntil: string | null, fallbackSeconds = 60) {
  const seconds = Math.max(1, Math.ceil(blockedUntil
    ? (new Date(blockedUntil).getTime() - Date.now()) / 1000 : fallbackSeconds));
  const response = jsonResponse({ error: "Muitas tentativas. Aguarde para tentar novamente.",
    code: "rate_limited", retry_after_ms: seconds * 1000 }, 429);
  response.headers.set("Retry-After", String(seconds));
  return response;
}

function canonicalUnifiControllerUrl(slug: string): string {
  return `${UNIFI_PROXY_ORIGIN}/${slug}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicProfileEmail(email: unknown): string | null {
  if (typeof email !== "string" || !email) return null;
  return email.endsWith("@wifi.minasbrasilwifi.com.br") ? null : email;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(CLUBEMAIS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
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
  } finally {
    clearTimeout(timeout);
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
  const writes: PromiseLike<unknown>[] = [db.from("portal_events").insert(row).then(({ error }) => {
    if (error) Logger.warn("[logEvent] insert failed", { code: error.code });
  })];

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
    writes.push(db.from("captive_sessions").update(patch).eq("id", args.session_id).then(({ error }) => {
      if (error) Logger.warn("[logEvent] session patch failed", { code: error.code });
    }));
  }
  const task = Promise.all(writes).catch((error) => Logger.warn("[logEvent] write failed", { error: String(error) }));
  // Critical authorization events are transactional in the operation RPC.
  // This only extends the lifetime of supplementary browser/diagnostic events.
  // @ts-ignore Supabase Edge Runtime API
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
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

  // 2) Use an explicit store URL/body hint only when all supplied hints agree.
  // The AP mapping above remains authoritative for the physical location.
  // Reading both sources is necessary because some reverse proxies preserve
  // the JSON body but drop the original query string (and vice versa).
  try {
    const url = new URL(req.url);
    const urlStoreHint = sanitizeString(url.searchParams.get("store"), 64)?.toLowerCase() || null;
    const bodyStoreHint = sanitizeString(requestedStoreHint, 64)?.toLowerCase() || null;
    const attemptStoreHint = sanitizeString(persistedStoreHint, 64)?.toLowerCase() || null;
    const suppliedHints = [attemptStoreHint, bodyStoreHint, urlStoreHint]
      .filter((hint): hint is string => !!hint && isValidSlug(hint));
    const uniqueHints = [...new Set(suppliedHints)];

    if (uniqueHints.length > 1) {
      Logger.warn("Conflicting store hints ignored", {
        has_attempt_hint: !!attemptStoreHint,
        has_body_hint: !!bodyStoreHint,
        has_url_hint: !!urlStoreHint,
      });
    }

    const storeSlug = uniqueHints.length === 1 ? uniqueHints[0] : null;
    if (storeSlug && isValidSlug(storeSlug)) {
      const { data: store } = await db
        .from("stores")
        .select("id, slug, name, city, is_active, post_auth_redirect_url")
        .eq("slug", storeSlug)
        .eq("is_active", true)
        .maybeSingle();

      if (store) {
        Logger.info("Store detected via store hint", { store_slug: store.slug });
        const source = attemptStoreHint
          ? "attempt_store_hint"
          : bodyStoreHint
          ? "request_store_hint"
          : "url_param";
        return storeResult(store, source);
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
      throw new Error("RATE_LIMIT_UNAVAILABLE");
    }

    const result = typeof data === "string" ? JSON.parse(data) : data;
    return {
      allowed: !!result.allowed,
      remaining: result.remaining ?? 0,
      blocked_until: result.blocked_until || null,
    };
  } catch (e) {
    Logger.warn("Rate limit check failed", { error: (e as Error).message });
    throw new Error("RATE_LIMIT_UNAVAILABLE");
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
  if (!effectiveUser || !effectivePass) return { ok: false, error: "UNIFI_SECRET_NOT_CONFIGURED" };
  const deadlineAt = Date.now() + Math.max(0, timeoutMs);
  const baseUrl = loginUrl.replace(/\/api\/(auth\/)?login$/, "");
  const transport = httpClient ? { client: httpClient } : {};
  const headers: Record<string, string> = {
    "Content-Type": "application/json", Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; CaptivePortal/1.0)",
  };
  let cookieJar: UnifiCookieJar = {};
  try {
    // Routing cookies are needed by the proxy. Warm-up shares the login budget.
    try {
      const warm = await fetchUnifiResponse(
        `${baseUrl}/`, { ...transport, method: "GET", headers } as RequestInit,
        Math.min(deadlineAt, Date.now() + 1_000),
      );
      cookieJar = mergeResponseCookies(cookieJar, warm.headers);
      const csrf = warm.headers.get("x-csrf-token");
      if (csrf) headers["X-CSRF-Token"] = csrf;
    } catch { /* Login can still succeed without a warm-up response. */ }
    const cookies = serializeCookieJar(cookieJar);
    if (cookies) headers.Cookie = cookies;
    const response = await fetchUnifiResponse(loginUrl, {
      ...transport, method: "POST", headers,
      body: JSON.stringify({ username: effectiveUser, password: effectivePass, remember: false, strict: true }),
    } as RequestInit, deadlineAt);
    if (!response.ok) return { ok: false, error: `UNIFI_LOGIN_HTTP_${response.status}` };
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return { ok: false, error: "UNIFI_LOGIN_INVALID_ENVELOPE" };
    }
    let loginBody: unknown;
    try { loginBody = JSON.parse(response.body); }
    catch { return { ok: false, error: "UNIFI_LOGIN_INVALID_ENVELOPE" }; }
    if (!loginBody || typeof loginBody !== "object" || Array.isArray(loginBody)) {
      return { ok: false, error: "UNIFI_LOGIN_INVALID_ENVELOPE" };
    }
    const envelope = parseUnifiEnvelope(response.body);
    const isOsEndpoint = /\/api\/auth\/login$/.test(loginUrl);
    // UniFi OS has its own object response. Legacy login requires the standard
    // envelope, and neither endpoint may override an explicit error with cookies.
    if ((!isOsEndpoint || "meta" in loginBody) && envelope?.rc !== "ok") {
      return { ok: false, error: "UNIFI_LOGIN_REJECTED" };
    }
    cookieJar = mergeResponseCookies(cookieJar, response.headers);
    const csrf = response.headers.get("x-csrf-token") || cookieJar.csrf_token;
    if (cookieJar.TOKEN) return {
      ok: true, cookies: cookieJar, isUnifiOs: true,
      csrfToken: csrf || extractCsrfFromToken(cookieJar.TOKEN) || undefined,
    };
    if (cookieJar.unifises) return { ok: true, cookies: cookieJar, isUnifiOs: false, csrfToken: csrf || undefined };
    return { ok: false, error: "UNIFI_LOGIN_NO_AUTH_COOKIE" };
  } catch { return { ok: false, error: "UNIFI_LOGIN_UNAVAILABLE" }; }
}

async function unifiLogin(
  baseUrl: string, httpClient: Deno.HttpClient | null,
  username?: string, password?: string,
  timeoutMs = UNIFI_TIMEOUT_MS,
): Promise<{ ok: boolean; cookies?: UnifiCookieJar; csrfToken?: string; isUnifiOs?: boolean; error?: string }> {
  const deadlineAt = Date.now() + Math.max(0, timeoutMs);
  if (UNIFI_AUTH_MODE === "legacy") {
    return await unifiTryLogin(`${baseUrl}/api/login`, httpClient, username, password, deadlineAt - Date.now());
  }
  if (UNIFI_AUTH_MODE === "unifi-os") {
    return await unifiTryLogin(`${baseUrl}/api/auth/login`, httpClient, username, password, deadlineAt - Date.now());
  }
  // Login negotiation does not issue an authorization command. Both endpoints
  // share one deadline; the external command never falls back after a send.
  const osResult = await unifiTryLogin(
    `${baseUrl}/api/auth/login`, httpClient, username, password,
    Math.min(2_000, Math.max(0, deadlineAt - Date.now()) / 2),
  );
  if (osResult.ok) return osResult;
  return await unifiTryLogin(`${baseUrl}/api/login`, httpClient, username, password, Math.max(0, deadlineAt - Date.now()));
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

type UnifiAuthOptions = {
  apMac?: string | null;
  ssid?: string | null;
  /** APs mapped to the same store by the server; never accepted from the browser. */
  trustedApMacs?: readonly string[];
  minutes?: number;
  allowPortalMacFallback?: boolean;
  deadlineAt?: number;
};

type UnifiAuthResult = {
  ok: boolean;
  error?: string;
  reason?: string;
  effective_mac?: string;
  ap_mac_used?: string | null;
  latency_ms?: number;
  cmd_accepted_at?: string;
  command_sent_at?: string;
  command_outcome?: "accepted" | "rejected" | "unknown";
  last_verify_result?: Record<string, unknown>;
  weak_signal?: boolean;
  station_lookup_fallback?: boolean;
  pending_confirmation?: boolean;
  confirm?: Promise<UnifiAuthResult>;
};

async function unifiFetchStations(
  staUrl: string, headers: Record<string, string>, httpClient: Deno.HttpClient | null,
  timeoutMs = 5_000,
): Promise<{ ok: boolean; sessionExpired?: boolean; data?: UnifiStation[]; error?: string }> {
  return await fetchUnifiStationsStrict(staUrl, {
    headers, ...(httpClient ? { client: httpClient } : {}),
  } as RequestInit, Date.now() + Math.max(0, timeoutMs));
}

function unifiNetworkEndpoint(controllerUrl: string, siteId: string, isUnifiOs: boolean): string {
  const parsed = new URL(controllerUrl);
  const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
  return isUnifiOs
    ? `${parsed.origin}/proxy/network/api/s/${encodeURIComponent(siteId)}`
    : `${baseUrl}/api/s/${encodeURIComponent(siteId)}`;
}

/** A single observation. Absence is unknown; another MAC is never substituted. */
async function unifiCheckAuthorizationOnly(
  controllerUrl: string, siteId: string, clientMac: string,
  username?: string, password?: string,
  options: UnifiAuthOptions = {},
): Promise<UnifiAuthorizationEvidence> {
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + 14_000);
  const mac = canonicalUnifiMac(clientMac);
  const inconclusive = (reason: string): UnifiAuthorizationEvidence => ({
    state: "inconclusive", found: null, authorized: null, effective_mac: mac || "",
    reason, evidence: { observed_at: new Date().toISOString(), reason, exact_mac: true },
  });
  if (!mac) return inconclusive("INVALID_MAC_ADDRESS");
  const httpClient = createUnifiHttpClient();
  try {
    const parsed = new URL(controllerUrl);
    const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
    const login = await unifiLogin(
      baseUrl, httpClient, username, password, Math.min(4_000, Math.max(0, deadlineAt - Date.now())),
    );
    if (!login.ok) return inconclusive(login.error || "UNIFI_LOGIN_FAILED");
    const stations = await fetchUnifiStationsStrict(
      `${unifiNetworkEndpoint(controllerUrl, siteId, !!login.isUnifiOs)}/stat/sta`,
      { headers: buildUnifiHeaders(login), ...(httpClient ? { client: httpClient } : {}) } as RequestInit,
      deadlineAt,
    );
    if (!stations.ok || !stations.data) return inconclusive(stations.error || "UNIFI_STATIONS_UNAVAILABLE");
    return exactUnifiEvidence(stations.data, mac, options);
  } catch { return inconclusive("UNIFI_OBSERVATION_UNAVAILABLE"); }
  finally { try { httpClient?.close(); } catch { /* no effect on evidence */ } }
}

/**
 * Prepare/login, observe the exact station, then send at most one command.
 * Callers persist a fenced send intent first. Unknown never implies rejection.
 */
async function unifiAuthorizeCommandOnly(
  controllerUrl: string, siteId: string, clientMac: string,
  username?: string, password?: string,
  options: UnifiAuthOptions = {},
): Promise<UnifiCommandResult> {
  const startedAt = Date.now();
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, startedAt + 14_000);
  const mac = canonicalUnifiMac(clientMac);
  const unsent = (reason: string, retryable = true): UnifiCommandResult => ({
    status: "unknown", command_sent: false, retryable, reason,
    effective_mac: mac || "", latency_ms: Date.now() - startedAt,
  });
  if (!mac || (options.apMac && !canonicalUnifiMac(options.apMac))) return unsent("INVALID_MAC_ADDRESS", false);
  const httpClient = createUnifiHttpClient();
  try {
    const parsed = new URL(controllerUrl);
    const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
    const login = await unifiLogin(
      baseUrl, httpClient, username, password, Math.min(4_000, Math.max(0, deadlineAt - Date.now())),
    );
    if (!login.ok) return unsent(login.error || "UNIFI_LOGIN_FAILED");
    const networkUrl = unifiNetworkEndpoint(controllerUrl, siteId, !!login.isUnifiOs);
    const init = { headers: buildUnifiHeaders(login), ...(httpClient ? { client: httpClient } : {}) } as RequestInit;
    const stations = await fetchUnifiStationsStrict(
      `${networkUrl}/stat/sta`, init, Math.min(deadlineAt, Date.now() + 3_000),
    );
    if (!stations.ok || !stations.data) return unsent(stations.error || "UNIFI_STATIONS_UNAVAILABLE");
    const observation = exactUnifiEvidence(stations.data, mac, options);
    if (observation.state === "authorized") return {
      status: "accepted", command_sent: false, retryable: false, reason: "ALREADY_AUTHORIZED",
      effective_mac: mac, latency_ms: Date.now() - startedAt, evidence: observation.evidence,
    };
    const trustedFallback = observation.reason === "CLIENT_NOT_OBSERVED" &&
      options.allowPortalMacFallback === true && !!canonicalUnifiMac(options.apMac);
    if (observation.state !== "not_authorized" && !trustedFallback) {
      return { ...unsent(observation.reason || "UNIFI_OBSERVATION_INCONCLUSIVE"), evidence: observation.evidence };
    }
    const exactStation = stations.data.find(station => canonicalUnifiMac(station.mac) === mac);
    const previousCookies = login.cookies || {};
    const currentCookies = mergeResponseCookies(previousCookies, stations.headers!);
    const tokenChanged = currentCookies.TOKEN !== previousCookies.TOKEN;
    const csrfCookieChanged = currentCookies.csrf_token !== previousCookies.csrf_token;
    const responseCsrf = stations.headers!.get("x-csrf-token");
    // A newly rotated TOKEN must not reuse CSRF from the previous token. An
    // explicit response header takes precedence; unchanged sessions retain their
    // established CSRF value when the station response does not replace it.
    const currentCsrf = responseCsrf || (tokenChanged
      ? (currentCookies.TOKEN && extractCsrfFromToken(currentCookies.TOKEN)) ||
        (csrfCookieChanged ? currentCookies.csrf_token : undefined)
      : csrfCookieChanged ? currentCookies.csrf_token : login.csrfToken);
    if (!(login.isUnifiOs ? currentCookies.TOKEN : currentCookies.unifises)) {
      return unsent("UNIFI_SESSION_EXPIRED_DURING_PREFLIGHT");
    }
    const result = await sendUnifiAuthorizeOnce(
      `${networkUrl}/cmd/stamgr`, { ...init, headers: buildUnifiHeaders({ ...login, cookies: currentCookies, csrfToken: currentCsrf || undefined }) }, mac,
      // Exact station evidence already validated this AP, including permitted
      // roaming within the server's store mapping. Never target a stale AP.
      { apMac: exactStation?.ap_mac || options.apMac, minutes: options.minutes },
      deadlineAt,
    );
    return { ...result, latency_ms: Date.now() - startedAt,
      evidence: { ...observation.evidence, ...result.evidence, portal_mac_fallback: trustedFallback } };
  } catch { return unsent("UNIFI_PREPARATION_UNAVAILABLE"); }
  finally { try { httpClient?.close(); } catch { /* no effect on result */ } }
}

/** Compatibility adapter for existing callers, using the same exact evidence. */
async function checkUnifiAuthorizationState(
  controllerUrl: string, siteId: string, mac: string,
  username?: string, password?: string,
  apMac?: string | null, ssid?: string | null,
): Promise<UnifiAuthorizationEvidence> {
  return await unifiCheckAuthorizationOnly(controllerUrl, siteId, mac, username, password, { apMac, ssid });
}

/** Legacy interface with one command and one read, sharing a 14-second budget. */
async function unifiAuthorizeWithRetry(
  controllerUrl: string, siteId: string, mac: string,
  username?: string, password?: string,
  options: UnifiAuthOptions = {},
): Promise<UnifiAuthResult & { attempts: number }> {
  const startedAt = Date.now();
  const bounded = { ...options, deadlineAt: Math.min(options.deadlineAt ?? Infinity, startedAt + 14_000) };
  const command = await unifiAuthorizeCommandOnly(controllerUrl, siteId, mac, username, password, bounded);
  const common = {
    effective_mac: command.effective_mac, ap_mac_used: command.ap_mac_used,
    cmd_accepted_at: command.accepted_at, command_sent_at: command.command_sent_at,
    command_outcome: command.status, attempts: command.command_sent ? 1 : 0,
    station_lookup_fallback: command.evidence?.portal_mac_fallback === true,
  };
  if (command.status === "rejected") return { ...common, ok: false, reason: command.reason, latency_ms: Date.now() - startedAt };
  if (command.status === "unknown") return {
    ...common, ok: false, pending_confirmation: true,
    reason: command.reason, latency_ms: Date.now() - startedAt,
  };
  if (command.reason === "ALREADY_AUTHORIZED") return {
    ...common, ok: true, last_verify_result: command.evidence, latency_ms: Date.now() - startedAt,
  };
  const observed = await unifiCheckAuthorizationOnly(controllerUrl, siteId, mac, username, password, bounded);
  return {
    ...common, ok: observed.state === "authorized",
    pending_confirmation: observed.state !== "authorized",
    reason: observed.state === "authorized" ? undefined : "UNIFI_CONFIRMATION_PENDING",
    last_verify_result: { ...observed.evidence, verify_error: observed.reason || null },
    latency_ms: Date.now() - startedAt,
  };
}

async function authorizeClient(
  db: ReturnType<typeof supabaseAdmin>,
  storeId: string | null, storeSlug: string, clientMac: string | null, sessionId: string, clientIp: string,
  context: { apMac?: string | null; ssid?: string | null } = {},
): Promise<UnifiAuthResult & { userMessage?: string }> {
  // Legacy stores share the safe transport. Every critical write must succeed;
  // an uncertain persistence result is recovered through a controller read.
  const persist = async (patch: Record<string, unknown>, action: string, meta: Record<string, unknown>) => {
    const { data, error } = await db.from("captive_sessions").update(patch).eq("id", sessionId).select("id").single();
    if (error || !data?.id) throw new Error("AUTHORIZATION_PERSISTENCE_UNCERTAIN");
    const { error: auditError } = await db.from("audit_logs").insert({
      store_id: storeId, entity: "session", entity_id: sessionId, action, meta,
    });
    if (auditError) throw new Error("AUTHORIZATION_PERSISTENCE_UNCERTAIN");
  };
  const fail = async (reason: string): Promise<UnifiAuthResult> => {
    await persist({ status: "failed", fail_reason: reason }, "fail", { reason, store_slug: storeSlug });
    return { ok: false, reason };
  };
  if (!storeId) return await fail("NO_STORE_CONFIGURED");
  const { data: store, error: storeError } = await db.from("stores")
    .select("unifi_controller_url, unifi_site_id").eq("id", storeId).maybeSingle();
  if (storeError) throw new Error("AUTHORIZATION_PERSISTENCE_UNCERTAIN");
  if (!store?.unifi_controller_url) return await fail("UNIFI_NOT_CONFIGURED");
  if (!UNIFI_USERNAME || !UNIFI_PASSWORD) return await fail("UNIFI_CREDENTIALS_MISSING");
  if (!clientMac || !canonicalUnifiMac(clientMac)) return await fail("INVALID_MAC_ADDRESS");

  const lock = await db.rpc("rate_limit_hit", {
    p_key: `unifi_auth:store:${storeId}:mac:${clientMac.toUpperCase()}`,
    p_window_seconds: 15, p_max_hits: 1, p_block_seconds: 0,
  });
  if (lock.error || !lock.data) throw new Error("AUTHORIZATION_PERSISTENCE_UNCERTAIN");
  if (lock.data.allowed === false) {
    await persist({ status: "submitted", fail_reason: "WAITING_FOR_DEVICE_OPERATION" },
      "authorize_waiting", { reason: "DEVICE_OPERATION_IN_PROGRESS" });
    // A rate limit is not a terminal controller result or proof of success.
    return { ok: false, reason: "PROCESSING_IN_PROGRESS", pending_confirmation: true,
      userMessage: "Liberação em processamento. Aguarde alguns segundos." };
  }

  const { data: settings, error: settingsError } = await db.from("global_settings")
    .select("session_duration_minutes, max_daily_accesses").eq("id", 1).maybeSingle();
  if (settingsError) throw new Error("AUTHORIZATION_PERSISTENCE_UNCERTAIN");
  const desiredMinutes = settings?.session_duration_minutes ?? 60;
  const maxDailyAccesses = normalizeDailyAccessLimit(settings?.max_daily_accesses);
  if (maxDailyAccesses > 0) {
    const dailyWindowStart = startOfDayInTimeZoneIso();
    const { count: authorizedToday, error: dailyCountError } = await db.from("captive_sessions")
      .select("id", { count: "exact", head: true }).eq("client_mac", clientMac.toUpperCase())
      .eq("status", "authorized").gte("authorized_at", dailyWindowStart);
    if (dailyCountError) throw new Error("AUTHORIZATION_PERSISTENCE_UNCERTAIN");
    if (hasReachedDailyAccessLimit(authorizedToday || 0, maxDailyAccesses)) {
      const reason = "DAILY_ACCESS_LIMIT_REACHED";
      await persist({ status: "failed", fail_reason: reason }, "daily_access_denied", {
        mac: clientMac.toUpperCase(), authorized_today: authorizedToday || 0,
        max_daily_accesses: maxDailyAccesses, window_start: dailyWindowStart, time_zone: "America/Sao_Paulo",
      });
      return { ok: false, reason, userMessage: "O limite diário de acessos deste dispositivo foi atingido." };
    }
  }

  const normalizedApMac = canonicalUnifiMac(context.apMac);
  let allowPortalMacFallback = false;
  if (normalizedApMac) {
    const { data: mappedAp, error: mappedApError } = await db.from("store_access_points")
      .select("store_id").eq("ap_mac", normalizedApMac).maybeSingle();
    if (mappedApError) throw new Error("AUTHORIZATION_PERSISTENCE_UNCERTAIN");
    allowPortalMacFallback = mappedAp?.store_id === storeId;
  }
  const result = await unifiAuthorizeWithRetry(
    store.unifi_controller_url, store.unifi_site_id || "default", clientMac, UNIFI_USERNAME, UNIFI_PASSWORD,
    { apMac: normalizedApMac, ssid: context.ssid || null, minutes: desiredMinutes, allowPortalMacFallback },
  );
  const patch: Record<string, unknown> = { auth_latency_ms: result.latency_ms ?? null };
  if (result.command_sent_at) patch.unifi_authorize_called_at = result.command_sent_at;
  if (result.cmd_accepted_at) patch.unifi_cmd_accepted_at = result.cmd_accepted_at;
  if (result.last_verify_result) patch.unifi_last_verify_result = result.last_verify_result;
  const meta = {
    mac: clientMac, ap_mac: result.ap_mac_used || context.apMac || null,
    store_slug: storeSlug, ip: clientIp, attempts: result.attempts,
    latency_ms: result.latency_ms, reason: result.reason,
    command_outcome: result.command_outcome, station_lookup_fallback: !!result.station_lookup_fallback,
  };
  if (result.ok && result.last_verify_result?.authorized === true) {
    const confirmedAt = new Date().toISOString();
    await persist({ ...patch, status: "authorized", fail_reason: null,
      authorized_at: confirmedAt, unifi_confirmed_at: confirmedAt }, "authorize", meta);
    return result;
  }
  if (result.pending_confirmation || result.command_outcome === "unknown" || result.command_outcome === "accepted") {
    await persist({ ...patch, status: "submitted", fail_reason: "UNIFI_CONFIRMATION_PENDING" }, "authorize_pending", meta);
    return { ...result, ok: false, reason: "PROCESSING_IN_PROGRESS", pending_confirmation: true };
  }
  await persist({ ...patch, status: "failed", fail_reason: result.reason || "UNIFI_COMMAND_REJECTED" }, "fail", meta);
  return result;
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
      phone: { required: true },
      cpf: { required: true },
    },
  });
}


// ========== Internal Housekeeping ==========
async function internalHousekeeping(db: ReturnType<typeof supabaseAdmin>): Promise<Record<string, number>> {
  const now = new Date();

  const { data: staleAttemptRows, error: staleAttemptError } = await db.rpc("expire_stale_auth_attempts");
  if (staleAttemptError) throw new Error(staleAttemptError.message);
  const staleAttemptResult = Array.isArray(staleAttemptRows) ? staleAttemptRows[0] : null;

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
    expired_auth_attempts: staleAttemptResult?.expired_attempts || 0,
    failed_stale_sessions: staleAttemptResult?.failed_sessions || 0,
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
      .select("session_duration_minutes, max_daily_accesses, updated_at")
      .eq("id", 1)
      .maybeSingle();

    if (error) return errorResponse(error.message, 500);

    return jsonResponse({
      session_duration_minutes: data?.session_duration_minutes ?? 1440,
      max_daily_accesses: data?.max_daily_accesses ?? DEFAULT_MAX_DAILY_ACCESSES,
      updated_at: data?.updated_at || null,
    });
  }

  if (req.method === "PUT") {
    const body = await safeParseJson(req);
    if (!body) return errorResponse("JSON inválido");

    const updates: Record<string, number> = {};
    if (Object.prototype.hasOwnProperty.call(body, "session_duration_minutes")) {
      const duration = Number(body.session_duration_minutes);
      if (!Number.isInteger(duration) || duration < 1 || duration > 43200) {
        return errorResponse("session_duration_minutes deve ser um número inteiro entre 1 e 43200");
      }
      updates.session_duration_minutes = duration;
    }

    if (Object.prototype.hasOwnProperty.call(body, "max_daily_accesses")) {
      const maxDailyAccesses = Number(body.max_daily_accesses);
      if (!Number.isInteger(maxDailyAccesses) || maxDailyAccesses < 0 || maxDailyAccesses > 100) {
        return errorResponse("max_daily_accesses deve ser um número inteiro entre 0 e 100");
      }
      updates.max_daily_accesses = maxDailyAccesses;
    }

    const fields = Object.keys(updates);
    if (fields.length === 0) return errorResponse("Informe ao menos uma configuração para atualizar");

    const { data, error } = await db
      .from("global_settings")
      .update(updates)
      .eq("id", 1)
      .select("session_duration_minutes, max_daily_accesses, updated_at")
      .single();

    if (error) return errorResponse(error.message, 500);

    await writeAdminAudit(db, req, userId, "global_settings", "update", {
      meta: {
        fields,
        ...updates,
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
    db.from("global_settings").select("session_duration_minutes, max_daily_accesses, updated_at").eq("id", 1).maybeSingle(),
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
  const attemptExpiryCutoff = now.toISOString();

  const [verifications, rateLimits, oldSessions, authorizedSessions, auditLogs, oauthHandoffs, staleAttempts] = await Promise.all([
    db.from("captive_verifications").select("id", { count: "exact", head: true }).lt("expires_at", verifCutoff).in("status", ["pending", "expired", "locked"]),
    db.from("rate_limits").select("key", { count: "exact", head: true }).lt("updated_at", rateLimitCutoff),
    db.from("captive_sessions").select("id", { count: "exact", head: true }).lt("started_at", sessionCutoff180).in("status", ["started", "submitted", "failed"]),
    db.from("captive_sessions").select("id", { count: "exact", head: true }).lt("started_at", sessionCutoff365).eq("status", "authorized"),
    db.from("audit_logs").select("id", { count: "exact", head: true }).lt("created_at", auditCutoff),
    db.from("oauth_browser_handoffs").select("id", { count: "exact", head: true }).lt("expires_at", now.toISOString()),
    db.from("captive_auth_attempts").select("id", { count: "exact", head: true }).eq("status", "authorizing").lte("expires_at", attemptExpiryCutoff),
  ]);

  const firstError = [verifications, rateLimits, oldSessions, authorizedSessions, auditLogs, oauthHandoffs, staleAttempts].find((result) => result.error)?.error;
  if (firstError) throw new Error(firstError.message);
  return {
    expired_verifications: verifications.count || 0,
    old_rate_limits: rateLimits.count || 0,
    old_sessions: (oldSessions.count || 0) + (authorizedSessions.count || 0),
    old_audit_logs: auditLogs.count || 0,
    expired_oauth_handoffs: oauthHandoffs.count || 0,
    expired_auth_attempts: staleAttempts.count || 0,
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

// ========== Client-side telemetry ==========
async function handleClientEvent(req: Request): Promise<Response> {
  const clientIp = getPublicIp(req) || "unknown";
  const ua = req.headers.get("user-agent")?.slice(0, 500) || null;
  const db = supabaseAdmin();

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  const requestedSessionId = isValidUUID(body.session_id) ? (body.session_id as string) : null;
  let sessionId: string | null = null;
  if (requestedSessionId && isValidUUID(body.attempt_id) && typeof body.resume_token === "string") {
    const state = await readOperation(db, body.attempt_id as string, body.resume_token);
    if (state.session_id === requestedSessionId && !["invalid_capability", "capability_expired", "receipt_stale"].includes(state.disposition)) {
      sessionId = requestedSessionId;
    }
  }
  const eventName = (Validators.string(body.event, 64) || "client_event").toLowerCase();
  const step = "client" as const;
  const status = ["info", "success", "warning", "error"].includes(String(body.status)) ? body.status as any : "info";
  const errorCode = Validators.string(body.error_code, 64);
  const errorMessage = Validators.string(body.error_message, 500);
  const traceId = Validators.string(body.trace_id, 64) || getTraceId(req, body);

  // Rate limit per session/ip - more aggressive for non-critical telemetry
  const rl = await checkRateLimitDb(db, `client-event:${sessionId || clientIp}:${eventName}`, 30, 60, 100);
  if (!rl.allowed) return jsonResponse({ ok: true, throttled: true });

  let payload: Record<string, unknown> | null = null;
  if (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) {
    const source = body.payload as Record<string, unknown>;
    payload = Object.fromEntries(["attempt_id", "operation_id", "online", "source", "reason", "duration_ms",
      "state", "outcome", "mode", "kind", "http_status", "code"]
      .filter((key) => typeof source[key] === "string" || typeof source[key] === "boolean" || typeof source[key] === "number")
      .map((key) => [key, typeof source[key] === "string" ? String(source[key]).slice(0, 100) : source[key]]));
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
    session_patch: sessionId && eventName === "redirect_started"
      ? { redirect_served_at: new Date().toISOString() } : undefined,
  });

  return jsonResponse({ ok: true });
}

// ========== Portal identity and legacy auth helpers ==========

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
  
  const val = await validateAuthAttempt(db, attemptId, resumeToken);
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
interface PortalAuthorizationResult {
  session_id: string | null;
  authorized: boolean;
  redirect_url: string;
  fail_reason?: string;
  replay?: boolean;
  processing?: boolean;
  status?: string;
  operation_id?: string;
  retry_after_ms?: number;
  deadline_at?: string;
  server_now?: string;
  store_slug: string;
  store_id: string | null;
}

type PortalAuthorizationArgs = {
  db: ReturnType<typeof supabaseAdmin>;
  userId: string;
  profile: { full_name: string; cpf_digits: string | null; phone_digits: string | null; email: string; cpf_required?: boolean };
  ctx: AuthAuthorizeContext;
  req: Request;
  authMethod: "password" | "silent" | "google" | "apple" | "identity";
  traceId: string;
  clientIp: string | null;
  userAgent: string | null;
  attemptId: string | null;
  resumeToken: string | null;
};

function publicOperationResult(result: Record<string, any>): Record<string, unknown> {
  return {
    server_now: new Date().toISOString(),
    session_id: result.session_id || null,
    authorized: result.authorized === true,
    processing: result.processing === true,
    status: typeof result.status === "string" ? result.status : undefined,
    operation_id: typeof result.operation_id === "string" ? result.operation_id : undefined,
    retry_after_ms: typeof result.retry_after_ms === "number" ? result.retry_after_ms : undefined,
    deadline_at: typeof result.deadline_at === "string" ? result.deadline_at : undefined,
    redirect_url: result.redirect_url || DEFAULT_REDIRECT_URL,
    fail_reason: result.fail_reason || undefined,
    replay: result.replay === true,
  };
}

async function runAuthorizationWorker(db: ReturnType<typeof supabaseAdmin>, operationId?: string, deadlineAt?: number) {
  return await (operationId ? reconcileAuthorization : drainAuthorization)(db, {
    afterConfirmed: (operation) => {
      const sync = (async () => {
        if (!operation.user_id) return;
        const { data: profile, error } = await db.from("profiles")
          .select("cpf_digits, phone_digits, full_name, email").eq("id", operation.user_id).single();
        if (error) throw new Error("CRM_PROFILE_LOOKUP_FAILED");
        if (profile?.cpf_digits && profile?.phone_digits) await syncWithClubeMais({
          cpf: profile.cpf_digits, phone: profile.phone_digits, name: profile.full_name || "Cliente",
          email: publicProfileEmail(profile.email), store_id: operation.store_id,
        }, db);
      })().catch((error) => Logger.warn("[authorization] CRM sync failed", { error: String(error) }));
      // @ts-ignore Supabase Edge Runtime API
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(sync);
    },
    send: async (operation: AuthOperation) => {
      // Only this preparation region can prove that no adapter/POST began.
      // Keep adapter exceptions outside it: their effects may be unknown.
      let trustedApMacs: string[];
      let deadlineAt: number;
      const preparationDeadline = Math.min(Date.parse(operation.lease_expires_at),
        operation.execution_deadline_at ?? Infinity,
        operation.deadline_at ? Date.parse(operation.deadline_at) : Infinity) - 16_000;
      try {
        if (!operation.user_id) throw new Error("OPERATION_USER_MISSING");
        const block = await withOperationDeadline(() => getActiveUserBlock(db, operation.user_id!),
          preparationDeadline, "BLOCK_LOOKUP_TIMEOUT");
        const { data: privileged, error: roleError } = await withOperationDeadline(signal => db.from("user_roles")
          .select("user_id").eq("user_id", operation.user_id!).eq("role", "admin").abortSignal(signal).maybeSingle(),
          preparationDeadline, "ROLE_LOOKUP_TIMEOUT");
        if (roleError) throw new Error("OPERATION_ROLE_LOOKUP_FAILED");
        if (block || privileged) return { status: "rejected" as const, command_sent: false,
          effective_mac: operation.client_mac, reason: block ? "USER_BLOCKED" : "PRIVILEGED_ACCOUNT",
          evidence: { explicit_rejection: true, command_sent: false } };
        // Configuration changes cannot redirect a queued command to another
        // controller. The immutable intent is checked again at its boundary.
        const { data: store, error } = await withOperationDeadline(signal => db.from("stores")
          .select("slug, is_active, unifi_controller_url, unifi_site_id").eq("id", operation.store_id).abortSignal(signal).single(),
          preparationDeadline, "STORE_LOOKUP_TIMEOUT");
        if (error) throw new Error("STORE_LOOKUP_FAILED");
        if (!store?.is_active || store.slug !== "povao" ||
            store.unifi_controller_url !== operation.controller_key ||
            (store.unifi_site_id || "default") !== operation.site_id) {
          return { status: "rejected" as const, command_sent: false,
            reason: "OPERATION_CONFIGURATION_CHANGED", effective_mac: operation.client_mac,
            evidence: { explicit_rejection: true, command_sent: false } };
        }
        const { data: aps, error: apError } = await withOperationDeadline(signal => db.from("store_access_points")
          .select("ap_mac").eq("store_id", operation.store_id).abortSignal(signal), preparationDeadline, "AP_LOOKUP_TIMEOUT");
        if (apError) throw new Error("AP_LOOKUP_FAILED");
        trustedApMacs = (aps || []).map((ap) => normalizeMac(ap.ap_mac))
          .filter((mac): mac is string => !!mac);
        deadlineAt = Math.min(Date.parse(operation.lease_expires_at) - 2_000,
          operation.deadline_at ? Date.parse(operation.deadline_at) : Infinity,
          operation.execution_deadline_at ? operation.execution_deadline_at - 2_000 : Infinity);
        if (!Number.isFinite(deadlineAt) || deadlineAt - Date.now() < 14_000) {
          throw new Error("PREPARATION_BUDGET_EXHAUSTED");
        }
      } catch (error) {
        const knownCodes = new Set(["OPERATION_USER_MISSING", "OPERATION_ROLE_LOOKUP_FAILED",
          "STORE_LOOKUP_FAILED", "AP_LOOKUP_FAILED", "PREPARATION_BUDGET_EXHAUSTED"]);
        const code = error instanceof Error && knownCodes.has(error.message) ? error.message : "OPERATION_PREPARATION_FAILED";
        return { status: "unknown" as const, command_sent: false, retryable: true,
          reason: code, effective_mac: operation.client_mac, evidence: { command_sent: false } };
      }
      return await unifiAuthorizeCommandOnly(operation.controller_key, operation.site_id,
        operation.client_mac, UNIFI_USERNAME, UNIFI_PASSWORD, {
          apMac: operation.ap_mac, ssid: String(operation.command.ssid || "") || null,
          trustedApMacs,
          minutes: Number(operation.command.minutes),
          allowPortalMacFallback: !!operation.ap_mac && trustedApMacs.includes(normalizeMac(operation.ap_mac) || ""),
          deadlineAt,
        });
    },
    verify: async (operation: AuthOperation) => {
      const preparationDeadline = Math.min(Date.parse(operation.lease_expires_at),
        operation.execution_deadline_at ?? Infinity) - 16_000;
      const { data: aps, error } = await withOperationDeadline(signal => db.from("store_access_points")
        .select("ap_mac").eq("store_id", operation.store_id).abortSignal(signal), preparationDeadline, "AP_LOOKUP_TIMEOUT");
      if (error) throw new Error("AP_LOOKUP_FAILED");
      return await unifiCheckAuthorizationOnly(
        operation.controller_key, operation.site_id, operation.client_mac,
        UNIFI_USERNAME, UNIFI_PASSWORD, {
          apMac: operation.ap_mac, ssid: String(operation.command.ssid || "") || null,
          trustedApMacs: (aps || []).map((ap) => normalizeMac(ap.ap_mac))
            .filter((mac): mac is string => !!mac),
          deadlineAt: Math.min(Date.parse(operation.lease_expires_at) - 2_000,
            operation.execution_deadline_at ? operation.execution_deadline_at - 2_000 : Infinity),
        });
    },
  }, { owner: `durable-${crypto.randomUUID()}`, operationId, limit: operationId ? 1 : 4,
    deadlineAt: deadlineAt ?? (operationId ? Date.now() + 20_000 : undefined) });
}

async function readOperation(db: ReturnType<typeof supabaseAdmin>, attemptId: string, token: string) {
  return await requiredRpc(db, "get_captive_auth_operation", {
    p_attempt_id: attemptId, p_resume_token: token,
  }, { deadlineAt: Date.now() + 3000 }) as Record<string, any>;
}

function authorizationDispositionError(value: Record<string, any>) {
  if (value.disposition === "capability_expired" || value.disposition === "receipt_stale") {
    return { status: 410, body: { error: "Identifique-se novamente para consultar seu acesso.", code: "attempt_expired" } };
  }
  if (value.disposition === "invalid_capability") {
    return { status: 401, body: { error: "Tentativa inválida.", code: "invalid_attempt" } };
  }
  if (value.disposition === "state_inconsistent") {
    return { status: 503, body: { error: "A confirmação precisa ser conciliada. Tente novamente em instantes.",
      code: "AUTHORIZATION_STATE_INCONSISTENT", retry_after_ms: 5000 } };
  }
  return null;
}

function authorizationFailureResponse(error: unknown): Response | null {
  const known = error as { authorizationFailure?: ReturnType<typeof authorizationDispositionError>;
    rpcName?: string; rpcReason?: string };
  let failure = known?.authorizationFailure;
  if (!failure && known?.rpcName === "join_captive_auth_operation") {
    const disposition = ["ATTEMPT_EXPIRED", "AUTHORIZATION_RECEIPT_STALE"].includes(known.rpcReason || "") ? "capability_expired"
      : ["INVALID_RESUME_TOKEN", "ATTEMPT_NOT_FOUND"].includes(known.rpcReason || "") ? "invalid_capability" : null;
    if (disposition) failure = authorizationDispositionError({ disposition });
  }
  return failure ? jsonResponse(failure.body, failure.status) : null;
}

async function persistPortalLead(args: PortalAuthorizationArgs, storeId: string) {
  const { db, profile, userId, ctx } = args;
  const { data: consent, error: consentError } = await db.from("consent_versions")
    .select("version").eq("is_active", true).maybeSingle();
  if (consentError) throw new Error("CONSENT_LOOKUP_FAILED");
  const { data: existing, error: lookupError } = await db.from("leads")
    .select("id").eq("user_id", userId).maybeSingle();
  if (lookupError) throw new Error("LEAD_LOOKUP_FAILED");
  const payload = { user_id: userId, name: profile.full_name,
    email: publicProfileEmail(profile.email), phone: profile.phone_digits, cpf: profile.cpf_digits,
    client_mac: ctx.clientMac, last_seen_at: new Date().toISOString(),
    last_seen_store_id: storeId, store_id: storeId };
  const { error } = existing?.id
    ? await db.from("leads").update(payload).eq("id", existing.id)
    : await db.from("leads").insert({ ...payload, first_seen_at: new Date().toISOString(),
      consented_at: new Date().toISOString(), consent_version: consent?.version || "unavailable" });
  if (error) throw new Error(`LEAD_WRITE_${error.code}`);
}

async function authorizeDurably(args: PortalAuthorizationArgs, storeId: string, storeSlug: string,
  redirectUrl: string): Promise<PortalAuthorizationResult> {
  const { db, attemptId, resumeToken, ctx } = args;
  const fallback = { session_id: null, authorized: false, redirect_url: redirectUrl,
    store_id: storeId, store_slug: storeSlug };
  if (!attemptId || !resumeToken || !ctx.clientMac) return { ...fallback, fail_reason: "MISSING_ATTEMPT_TOKENS" };
  const { data: store, error: storeError } = await db.from("stores")
    .select("unifi_controller_url, unifi_site_id, is_active").eq("id", storeId).single();
  if (storeError) throw new Error("STORE_LOOKUP_FAILED");
  if (!store?.is_active || store.unifi_controller_url !== canonicalUnifiControllerUrl(storeSlug)) {
    return { ...fallback, fail_reason: "UNIFI_NOT_CONFIGURED" };
  }
  const { data: settings, error: settingsError } = await db.from("global_settings")
    .select("session_duration_minutes, max_daily_accesses").eq("id", 1).single();
  if (settingsError || !settings) throw new Error("AUTHORIZATION_SETTINGS_UNAVAILABLE");
  const desiredMinutes = Math.max(1, Math.min(Number(settings.session_duration_minutes) || 40, 1440));
  // The database evaluates the daily limit under the same device lock as join,
  // so two simultaneous attempts cannot bypass it or charge reuse twice.
  const associationKey = await sha256Hex(JSON.stringify([
    storeId, ctx.clientMac, ctx.apMac, ctx.ssid, ctx.captiveTimestamp,
  ]));
  const joined = await requiredRpc(db, "join_captive_auth_operation", {
    p_attempt_id: attemptId, p_session_id: null, p_user_id: args.userId, p_store_id: storeId,
    p_controller_key: store.unifi_controller_url, p_site_id: store.unifi_site_id || "default",
    p_client_mac: ctx.clientMac, p_ap_mac: ctx.apMac, p_association_key: associationKey,
    p_redirect_url: redirectUrl, p_resume_token: resumeToken,
    p_command: { minutes: desiredMinutes, ssid: ctx.ssid,
      max_daily_accesses: normalizeDailyAccessLimit(settings.max_daily_accesses),
      daily_window_start: startOfDayInTimeZoneIso() },
    p_session: { auth_method: args.authMethod, trace_id: args.traceId,
      user_agent: args.userAgent?.slice(0, 500) || null, client_ip: args.clientIp,
      captive_timestamp: ctx.captiveTimestamp, ssid: ctx.ssid },
  }, { deadlineAt: Date.now() + 5000 }) as Record<string, any>;
  const joinError = authorizationDispositionError(joined);
  if (joinError) throw Object.assign(new Error(joinError.body.code), { authorizationFailure: joinError });
  if (joined.disposition === "context_conflict") {
    return { ...fallback, status: "rejected", processing: false,
      fail_reason: "DEVICE_CONTEXT_CONFLICT" };
  }
  if (joined.disposition === "daily_limit") return { ...fallback, fail_reason: "DAILY_ACCESS_LIMIT_REACHED" };
  if (joined.disposition === "unconfirmed_cooldown") return { ...fallback,
    status: "expired_unconfirmed", processing: false, fail_reason: "AUTHORIZATION_UNCONFIRMED",
    retry_after_ms: Number(joined.retry_after_ms) || 30_000 };
  if (!joined.operation?.id) throw new Error(`OPERATION_JOIN_${joined.disposition || "FAILED"}`);
  const leadTask = persistPortalLead(args, storeId).catch((error) => {
    Logger.warn("[authorization] lead persistence failed", { error: String(error), attempt_id: attemptId });
  });
  // @ts-ignore Supabase Edge Runtime API
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(leadTask);
  // One bounded pass improves the common case. The durable outbox and cron
  // continue independently if the request/browser/runtime disappears now.
  const work = await runAuthorizationWorker(db, joined.operation.id);
  if (work.errors.length) Logger.warn("[authorization] deferred to reconciler", { errors: work.errors });
  const state = await readOperation(db, attemptId, resumeToken);
  const stateError = authorizationDispositionError(state);
  if (stateError) throw Object.assign(new Error(stateError.body.code), { authorizationFailure: stateError });
  return { ...fallback, ...publicOperationResult(state) } as PortalAuthorizationResult;
}

async function handleAttemptStatus(req: Request): Promise<Response> {
  const body = await safeParseJson(req);
  const attemptId = typeof body?.attempt_id === "string" ? body.attempt_id : "";
  const token = typeof body?.token === "string" ? body.token : "";
  if (!isValidUUID(attemptId) || token.length < 32 || token.length > 256) {
    return jsonResponse({ error: "Tentativa inválida.", code: "invalid_attempt" }, 401);
  }
  const db = supabaseAdmin();
  let state = await readOperation(db, attemptId, token);
  const initialError = authorizationDispositionError(state);
  if (initialError) return jsonResponse(initialError.body, initialError.status);
  if (state.processing && state.operation_id) {
    const work = await runAuthorizationWorker(db, state.operation_id);
    if (work.errors.length) Logger.warn("[authorization] status recovery deferred", { errors: work.errors });
    state = await readOperation(db, attemptId, token);
  }
  const finalError = authorizationDispositionError(state);
  if (finalError) return jsonResponse(finalError.body, finalError.status);
  let challenge: { token_hash: string } | null = null;
  if (state.authorized === true && state.user_id) {
    challenge = await claimPortalSessionChallenge(db, attemptId, token);
  }
  return jsonResponse({ ...publicOperationResult(state), session_token_hash: challenge?.token_hash });
}

async function handleAuthorizationReconcile(req: Request): Promise<Response> {
  const deadlineAt = Date.now() + 50_000;
  const token = req.headers.get("x-captive-worker-token") || "";
  if (token.length < 32 || token.length > 256) return errorResponse("Unauthorized", 401);
  const db = supabaseAdmin();
  const allowed = await requiredRpc(db, "authorize_captive_auth_worker", { p_token: token },
    { deadlineAt: Math.min(deadlineAt - 2000, Date.now() + 3000) });
  if (allowed !== true) return errorResponse("Unauthorized", 401);
  const result = await runAuthorizationWorker(db, undefined, deadlineAt - 2000);
  const { error: heartbeatError } = await withOperationDeadline(signal => db.rpc("finish_captive_auth_worker",
    { p_failed_count: result.errors.length }).abortSignal(signal), deadlineAt, "WORKER_HEARTBEAT_TIMEOUT");
  if (heartbeatError) throw new Error("WORKER_HEARTBEAT_FAILED");
  if (result.errors.length) Logger.error("[authorization-worker] incomplete pass", { errors: result.errors });
  return jsonResponse({ claimed: result.claimed, applied: result.applied, failed: result.errors.length },
    result.errors.length ? 503 : 200);
}

async function authorizeAuthenticatedUser(args: PortalAuthorizationArgs): Promise<PortalAuthorizationResult> {
  const { db, userId, profile, ctx, req, authMethod, traceId, clientIp, userAgent, attemptId, resumeToken } = args;


  let detected = await detectStoreFromRequest(db, req, ctx.apMac, ctx.storeHint);
  if (!detected.store_id && ctx.clientMac) {
    const discovered = await discoverStoreByClientMac(db, ctx.clientMac);
    if (discovered) detected = discovered;
  }
  const storeSlug = detected.store_slug;
  const storeId = detected.store_id;

  // All entry points, including clients with the old cached JS, enter the same
  // durable coordinator for the active beta. Other stores retain their path.
  if (storeSlug === "povao" && storeId) {
    return await authorizeDurably(args, storeId, storeSlug, detected.redirect_url || DEFAULT_REDIRECT_URL);
  }

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

        if (isFinalized && claim.session_id) {
          const confirmedAt = new Date().toISOString();
          const sessionUpdate: Record<string, unknown> = {
            status: "authorized",
            fail_reason: null,
            authorized_at: confirmedAt,
            unifi_confirmed_at: confirmedAt,
            last_step: "unifi",
            last_error_code: null,
            last_error_message: null,
          };
          if (check.effective_mac && check.effective_mac !== ctx.clientMac) {
            sessionUpdate.original_client_mac = ctx.clientMac;
            sessionUpdate.client_mac = check.effective_mac;
          }
          await db.from("captive_sessions").update(sessionUpdate).eq("id", claim.session_id);
        }

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
    const publicEmail = publicProfileEmail(profile.email);
    const leadPayload: Record<string, unknown> = {
      user_id: userId,
      name: profile.full_name,
      email: publicEmail,
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
      { apMac: ctx.apMac, ssid: ctx.ssid },
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
      normalizedError.includes("connection") || normalizedError.includes("persistence_uncertain");

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
  if (authResult.pending_confirmation) {
    // Polling exhausted its bounded confirmation window. Expire this worker
    // lease now so the next request performs read-only recovery immediately
    // instead of waiting 30 seconds.
    await db.from("captive_auth_attempts").update({
      lease_expires_at: new Date(Date.now() + (authResult.cmd_accepted_at ? 0 : 15_000)).toISOString(),
    }).eq("id", attemptId).eq("lease_owner", leaseOwner).eq("status", "authorizing");
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
    p_result_code: authResult.ok
      ? "SUCCESS"
      : authResult.reason === "DAILY_ACCESS_LIMIT_REACHED" ? "DAILY_LIMIT" : "UNIFI_ERROR"
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

async function _handleRequestPasswordReset(req: Request): Promise<Response> {
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

const PORTAL_IDENTITY_EMAIL_DOMAIN = "wifi.minasbrasilwifi.com.br";

async function boundedPortalSessionChallenge(db: ReturnType<typeof supabaseAdmin>, userId: string,
  deadlineAt = Date.now() + 1500) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const challenge = await Promise.race([
      createPortalSessionChallenge(db, userId, deadlineAt).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); }),
    ]);
    return Date.now() < deadlineAt ? challenge : null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function claimPortalSessionChallenge(db: ReturnType<typeof supabaseAdmin>, attemptId: string, token: string) {
  const deadlineAt = Date.now() + 1500;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const challenge = await Promise.race([
      (async () => {
        const { data: userId, error } = await db.rpc("claim_captive_auth_challenge", {
          p_attempt_id: attemptId, p_resume_token: token,
        });
        if (error || !userId || !active || Date.now() >= deadlineAt) return null;
        return await boundedPortalSessionChallenge(db, userId, deadlineAt);
      })(),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); }),
    ]);
    return active && Date.now() < deadlineAt ? challenge : null;
  } catch {
    return null; // Reusable browser login is optional after network confirmation.
  } finally {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function createPortalSessionChallenge(
  db: ReturnType<typeof supabaseAdmin>,
  userId: string,
  deadlineAt = Infinity,
): Promise<{ token_hash: string } | null> {
  const { data: userResult, error: userError } = await db.auth.admin.getUserById(userId);
  let email = userResult?.user?.email || null;
  if (Date.now() >= deadlineAt) return null;

  if (userError || !userResult?.user) {
    Logger.error("[identity] auth user lookup failed", { code: userError?.code || "AUTH_USER_NOT_FOUND" });
    return null;
  }

  if (!email) {
    email = `portal-${crypto.randomUUID()}@${PORTAL_IDENTITY_EMAIL_DOMAIN}`;
    const { error: updateError } = await db.auth.admin.updateUserById(userId, {
      email,
      email_confirm: true,
    });
    if (updateError) {
      Logger.error("[identity] internal email assignment failed", { code: updateError.code || "AUTH_USER_UPDATE_FAILED" });
      return null;
    }
  }

  // Generate a one-use session challenge without consuming /auth/v1/verify
  // from the shared Edge Function IP. The browser exchanges it only after the
  // UniFi authorization result, preserving the existing reusable session.
  if (Date.now() >= deadlineAt) return null;
  const { data: linkData, error: linkError } = await db.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (Date.now() >= deadlineAt) return null;
  if (linkError || !tokenHash) {
    Logger.error("[identity] session link generation failed", { code: linkError?.code || "SESSION_LINK_FAILED" });
    return null;
  }

  return { token_hash: tokenHash };
}

async function handleIdentity(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const userAgent = req.headers.get("user-agent") || "";
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");
  const traceId = getTraceId(req, body);

  const phoneDigits = normalizeBrazilianPhone(body.phone);
  const cpfDigits = typeof body.cpf === "string" ? body.cpf.replace(/\D/g, "") : "";
  const { ctx, attemptId, resumeToken, error: authError } = await getValidatedAuthContext(db, body, "identity");
  if (authError) return authError;

  // Cached portal versions may repeat identify. An already admitted capability
  // follows its operation without charging the identity limiter or resending.
  if (attemptId && resumeToken) {
    const existing = await readOperation(db, attemptId, resumeToken);
    if (existing.operation_id) {
      return await handleAttemptStatus(new Request(req.url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attempt_id: attemptId, token: resumeToken }),
      }));
    }
  }

  if (!Validators.phone(phoneDigits)) {
    return jsonResponse({ error: "Telefone inválido.", code: "invalid_phone" }, 400);
  }
  if (!Validators.cpf(cpfDigits)) {
    return jsonResponse({ error: "CPF inválido.", code: "invalid_cpf" }, 400);
  }

  try {
    const identityHash = await sha256Hex(`${cpfDigits}:${phoneDigits}`);
    const ipLimit = await checkRateLimitDb(db, `identity:ip:${clientIp || "unknown"}`, 300, 20, 900);
    const identityLimit = await checkRateLimitDb(db, `identity:value:${identityHash}`, 300, 8, 900);
    if (!ipLimit.allowed || !identityLimit.allowed) {
      return rateLimitedResponse(ipLimit.blocked_until || identityLimit.blocked_until, 300);
    }
  } catch (rateLimitError) {
    Logger.error("[identity] rate limiter unavailable", { error: (rateLimitError as Error).message });
    return jsonResponse({ error: "Serviço temporariamente indisponível.", code: "rate_limit_unavailable" }, 503);
  }

  logEvent(db, {
    trace_id: traceId,
    event_type: "identity_started",
    step: "form",
    status: "info",
    client_ip: clientIp,
    user_agent: userAgent,
  });

  const { data: resolutionRows, error: resolutionError } = await db.rpc("resolve_portal_identity", {
    p_cpf_digits: cpfDigits,
    p_phone_digits: phoneDigits,
  });
  const resolution = Array.isArray(resolutionRows) ? resolutionRows[0] : null;

  if (resolutionError || !resolution) {
    Logger.error("[identity] identity resolution failed", { code: resolutionError?.code || "IDENTITY_RESOLUTION_FAILED" });
    return jsonResponse({ error: "Não foi possível validar seus dados.", code: "profile_lookup_failed" }, 500);
  }

  if (resolution.resolution_status === "ambiguous") {
    Logger.warn("[identity] legacy identity is ambiguous", { trace_id: traceId });
    return jsonResponse({
      error: "Encontramos mais de um cadastro antigo com este telefone. Procure o atendimento para confirmar seus dados.",
      code: "identity_ambiguous",
    }, 409);
  }

  if (resolution.resolution_status === "invalid") {
    return jsonResponse({ error: "Dados de identificação inválidos.", code: "invalid_identity" }, 400);
  }

  let profile: {
    id: string;
    full_name: string;
    cpf_digits: string | null;
    phone_digits: string | null;
    email: string;
  } | null = null;

  if (resolution.user_id) {
    const profileLookup = await db
      .from("profiles")
      .select("id, full_name, cpf_digits, phone_digits, email")
      .eq("id", resolution.user_id)
      .maybeSingle();
    if (profileLookup.error || !profileLookup.data) {
      Logger.error("[identity] resolved profile lookup failed", { code: profileLookup.error?.code || "PROFILE_LOOKUP_FAILED" });
      return jsonResponse({ error: "Não foi possível validar seus dados.", code: "profile_lookup_failed" }, 500);
    }
    profile = profileLookup.data;

    if (resolution.resolution_status === "migrated") {
      logEvent(db, {
        trace_id: traceId,
        event_type: "identity_legacy_migrated",
        step: "form",
        status: "success",
        client_ip: clientIp,
        user_agent: userAgent,
      });
    }
  }

  if (!profile) {
    const internalEmail = `portal-${crypto.randomUUID()}@${PORTAL_IDENTITY_EMAIL_DOMAIN}`;
    const { data: created, error: createError } = await db.auth.admin.createUser({
      email: internalEmail,
      email_confirm: true,
      user_metadata: { portal_identity: true },
    });
    if (createError || !created.user?.id) {
      Logger.error("[identity] auth user creation failed", { code: createError?.code || "AUTH_USER_CREATE_FAILED" });
      return jsonResponse({ error: "Não foi possível iniciar sua sessão.", code: "identity_create_failed" }, 500);
    }
    const createdUserId = created.user.id;

    const { data: insertedProfile, error: insertError } = await db
      .from("profiles")
      .insert({
        id: createdUserId,
        full_name: "Cliente",
        cpf_digits: cpfDigits,
        phone_digits: phoneDigits,
        email: internalEmail,
        cpf_required: false,
      })
      .select("id, full_name, cpf_digits, phone_digits, email")
      .single();

    if (insertError || !insertedProfile) {
      try { await db.auth.admin.deleteUser(createdUserId); } catch { /* best-effort rollback */ }
      const isCpfRace = insertError?.code === "23505" || /cpf_digits/i.test(insertError?.message || "");
      if (!isCpfRace) {
        Logger.error("[identity] profile creation failed", { code: insertError?.code || "PROFILE_CREATE_FAILED" });
        return jsonResponse({ error: "Não foi possível salvar seus dados.", code: "profile_create_failed" }, 500);
      }

      const racedLookup = await db
        .from("profiles")
        .select("id, full_name, cpf_digits, phone_digits, email")
        .eq("cpf_digits", cpfDigits)
        .maybeSingle();
      if (racedLookup.error || !racedLookup.data) {
        return jsonResponse({ error: "Não foi possível validar seus dados.", code: "profile_race_failed" }, 409);
      }
      profile = racedLookup.data;
    } else {
      profile = insertedProfile;
    }
  }

  const userId = profile.id;
  const { data: adminRole, error: adminRoleError } = await db
    .from("user_roles")
    .select("user_id")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (adminRoleError) {
    Logger.error("[identity] role check failed", { code: adminRoleError.code || "ROLE_CHECK_FAILED" });
    return jsonResponse({ error: "Serviço temporariamente indisponível.", code: "role_check_failed" }, 503);
  }
  if (adminRole) {
    Logger.warn("[identity] privileged account rejected", { user_id: userId });
    return jsonResponse({ error: "Use o acesso administrativo para esta conta.", code: "privileged_account" }, 403);
  }

  if (await getActiveUserBlock(db, userId)) {
    logEvent(db, {
      trace_id: traceId,
      event_type: "blocked_user_denied",
      step: "form",
      status: "warning",
      error_code: "user_blocked",
      client_ip: clientIp,
    });
    return jsonResponse({ error: "Acesso bloqueado. Procure o atendimento.", code: "user_blocked" }, 403);
  }

  if (!storedPhoneMatches(profile.phone_digits, phoneDigits)) {
    logEvent(db, {
      trace_id: traceId,
      event_type: "identity_mismatch",
      step: "form",
      status: "warning",
      error_code: "identity_mismatch",
      client_ip: clientIp,
      user_agent: userAgent,
    });
    return jsonResponse({
      error: "CPF e telefone não correspondem ao cadastro.",
      code: "identity_mismatch",
    }, 403);
  }

  const result = await authorizeAuthenticatedUser({
    db,
    userId,
    profile,
    ctx,
    req,
    authMethod: "identity",
    traceId,
    clientIp,
    userAgent,
    attemptId,
    resumeToken,
  });

  let sessionChallenge: { token_hash: string } | null = null;
  if (result.authorized) {
    sessionChallenge = result.operation_id && attemptId && resumeToken
      ? await claimPortalSessionChallenge(db, attemptId, resumeToken)
      : await boundedPortalSessionChallenge(db, userId);
    if (!sessionChallenge) {
      // Wi-Fi authorization is already confirmed and must not be reported as
      // failed merely because the reusable browser session could not be
      // minted. The user keeps internet access and can identify again later.
      Logger.warn("[identity] authorized without browser session challenge", { trace_id: traceId });
    }
  }

  if (result.authorized && !result.operation_id && profile.cpf_digits && profile.phone_digits) {
    const crmSync = syncWithClubeMais({
      cpf: profile.cpf_digits,
      name: profile.full_name || "Cliente",
      phone: profile.phone_digits,
      email: publicProfileEmail(profile.email),
      store_id: result.store_id,
    }, db, traceId).catch((error) => {
      Logger.warn("[identity] CRM sync failed", { error: (error as Error).message });
    });
    // @ts-ignore Edge Runtime background task API
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(crmSync);
  }

  logEvent(db, {
    session_id: result.session_id,
    trace_id: traceId,
    store_id: result.store_id,
    event_type: result.authorized ? "identity_success" : result.processing ? "identity_pending" : "identity_failed",
    step: "form",
    status: result.authorized ? "success" : "warning",
    payload: { store_slug: result.store_slug, fail_reason: result.fail_reason },
    client_ip: clientIp,
    user_agent: userAgent,
  });

  return jsonResponse({
    session_id: result.session_id,
    authorized: result.authorized,
    redirect_url: result.redirect_url,
    fail_reason: result.fail_reason,
    processing: result.processing || false,
    status: result.status,
    operation_id: result.operation_id,
    retry_after_ms: result.retry_after_ms,
    deadline_at: result.deadline_at,
    replay: result.replay || false,
    session_token_hash: result.authorized ? sessionChallenge?.token_hash : undefined,
    server_now: new Date().toISOString(),
    trace_id: traceId,
  });
}

async function _handleSignup(req: Request): Promise<Response> {
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

async function _handleLogin(req: Request): Promise<Response> {
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
    const val = await validateAuthAttempt(db, attemptId, resumeToken);
    // val won't be invalid here because getValidatedAuthContext already checked it.
    
    // Protection against user_id swap
    if (val.attempt.user_id && val.attempt.user_id !== userId) {
      Logger.error("[auth] Attempt already linked to another user", { attempt_id: attemptId });
      return jsonResponse({ error: "Esta tentativa pertence a outro usuário.", code: "forbidden_attempt" }, 403);
    }

    if (val.attempt.auth_operation_id) {
      return await handleAttemptStatus(new Request(req.url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attempt_id: attemptId, token: resumeToken }),
      }));
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
      return rateLimitedResponse(rlMac.blocked_until);
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
  if (result.authorized && !result.operation_id && profile?.cpf_digits && profile?.full_name && profile?.phone_digits) {
    const bgSync = (async () => {
      try {
        await syncWithClubeMais({
          cpf: profile.cpf_digits!,
          name: profile.full_name!,
          phone: profile.phone_digits!,
          email: publicProfileEmail(profile.email),
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
    event_type: result.authorized ? "silent_login_success" : result.processing ? "silent_login_pending" : "silent_login_failed",
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
    status: result.status,
    operation_id: result.operation_id,
    retry_after_ms: result.retry_after_ms,
    deadline_at: result.deadline_at,
    server_now: new Date().toISOString(),
    trace_id: traceId,
  });
}


async function _handleUpdateProfile(req: Request): Promise<Response> {
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
    if (path === "/health") return jsonResponse({ status: "ok", authorization_contract: "durable-v1", beta_stores: ["povao"] });
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
      const [{ data: worker, error: workerError }, { count: activeOperations, error: operationError },
        { count: overdueOperations, error: overdueError }, { count: recoveryFailures, error: recoveryError }] = await Promise.all([
        readyDb.from("captive_auth_worker_config")
          .select("enabled,sends_enabled,last_tick_at,last_dispatch_at,last_worker_finished_at,last_worker_failed_count,last_error_code")
          .eq("singleton", true).maybeSingle(),
        readyDb.from("captive_auth_operations").select("id", { count: "exact", head: true })
          .in("status", ["queued", "sending", "verifying"]),
        readyDb.from("captive_auth_operations").select("id", { count: "exact", head: true })
          .in("status", ["queued", "sending", "verifying"])
          .or(`verification_deadline.lt.${new Date(Date.now() - 30_000).toISOString()},and(verification_deadline.is.null,created_at.lt.${new Date(Date.now() - 120_000).toISOString()})`),
        readyDb.from("captive_auth_recovery_failures").select("operation_id", { count: "exact", head: true }),
      ]);
      const tickHealthy = !!worker?.last_tick_at && Date.now() - Date.parse(worker.last_tick_at) < 35_000;
      const dispatchUnanswered = !!worker?.last_dispatch_at &&
        Date.parse(worker.last_dispatch_at) > Date.parse(worker.last_worker_finished_at || "1970-01-01") &&
        Date.now() - Date.parse(worker.last_dispatch_at) > 30_000;
      const reconcilerHealthy = !workerError && !operationError && !overdueError && !recoveryError && !recoveryFailures &&
        worker?.enabled === true && worker.sends_enabled === true && tickHealthy &&
        !worker.last_error_code && !overdueOperations &&
        (!(activeOperations || 0) || (!dispatchUnanswered && !worker.last_worker_failed_count));
      const checks = {
        database: !databaseError,
        unifi_credentials: !!UNIFI_USERNAME && !!UNIFI_PASSWORD,
        controller_configuration: !storesError && invalidStores.length === 0 && (activeStores?.length || 0) > 0,
        invalid_controller_stores: invalidStores.map((store) => store.slug),
        cron_secret: !!CRON_SECRET,
        authorization_reconciler: reconcilerHealthy,
        authorization_active_operations: activeOperations ?? null,
        authorization_overdue_operations: overdueOperations ?? null,
        authorization_recovery_failures: recoveryFailures ?? null,
      };
      const ready = checks.database && checks.unifi_credentials && checks.controller_configuration && reconcilerHealthy;
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
    if (path === "/attempt/init" && req.method === "POST") return await handleAttemptInit(req);
    if (path === "/attempt/status" && req.method === "POST") return await handleAttemptStatus(req);
    if (path === "/identify" && req.method === "POST") return await handleIdentity(req);
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
    if (path === "/cron/auth-reconcile" && req.method === "POST") return await handleAuthorizationReconcile(req);

    return errorResponse("Not found", 404);
  } catch (err) {
    Logger.error("Unhandled error", { error: err });
    const authorizationResponse = authorizationFailureResponse(err);
    if (authorizationResponse) return authorizationResponse;
    return errorResponse("Internal server error", 500);
  }
});


// ========== Authoritative Captive Attempt Handler ==========

/**
 * Validates attempt tokens against the database.
 * Returns the captive parameters if valid and not expired/consumed.
 */
async function validateAuthAttempt(
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
    // Expiring a browser capability must never cancel or regress a committed
    // operation (or a completed result). The reconciler owns its lifetime.
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

async function handleAttemptInit(req: Request): Promise<Response> {
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
    const rl = await checkRateLimitDb(db, `attempt-init:mac:${clientMac}`, 60, 5, 300);
    if (!rl.allowed) return rateLimitedResponse(rl.blocked_until);
  } catch (e) {
    Logger.error("[attempt-init] Rate limiter error", { error: (e as Error).message });
    return errorResponse("Serviço temporariamente indisponível.", 503);
  }

  // Resolve and persist the store before authentication. The explicit store
  // may arrive either in the proxied request URL or in the captive params
  // body; detectStoreFromRequest accepts it only when the supplied hints agree.
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
    Logger.error("[attempt-init] insert failed", { code: insErr?.code || "ATTEMPT_INSERT_FAILED" });
    return errorResponse("Erro ao inicializar transação de login.", 500);
  }

  return jsonResponse({
    attempt_id: attempt.id,
    token: token,
    expires_at: expiresAt.toISOString(),
    store: { slug: detected.store_slug, name: detected.store_name, city: detected.store_city },
    server_now: new Date().toISOString(),
    detection_source: detected.detection_source,
  });
}
