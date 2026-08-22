import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

// ========== Constants ==========
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-trace-id, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

const DEFAULT_REDIRECT_URL = Deno.env.get("POST_AUTH_REDIRECT_URL") || "https://www.drogariaminasbrasil.com.br/";
const UNIFI_TIMEOUT_MS = 10_000;
const UNIFI_RETRY_COUNT = 1;
const MAC_REGEX = /^[0-9A-F]{12}$/;
const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 255;
const MAX_PHONE_LEN = 30;
const MAX_SLUG_LEN = 50;
const DEDUP_WINDOW_SEC = 10;

// GeoIP config
const GEOIP_ENDPOINT = Deno.env.get("GEOIP_ENDPOINT") || "https://ipapi.co/{ip}/json/";
const GEOIP_TIMEOUT_MS = parseInt(Deno.env.get("GEOIP_TIMEOUT_MS") || "1500");
const GEOIP_CACHE_TTL_HOURS = parseInt(Deno.env.get("GEOIP_CACHE_TTL_HOURS") || "168");
const GEOIP_PROVIDER = Deno.env.get("GEOIP_PROVIDER") || "ipapi";

// OTP subsystem removed (Prompt 08)


// Cron secret for scheduled housekeeping
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

// External CRM API (ClubeMais)
const CLUBEMAIS_API_URL = "https://painelzoombox.drogariaminasbrasil.com.br:510/api2/v3/cliente";
const CLUBEMAIS_API_TOKEN = Deno.env.get("CLUBEMAIS_API_TOKEN") || "";

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

// ========== Sanitization & Validation ==========
function sanitizeString(s: unknown, maxLen: number): string | null {
  if (typeof s !== "string") return null;
  return s.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, maxLen) || null;
}

function normalizeMac(mac: unknown): string | null {
  if (typeof mac !== "string" || !mac) return null;
  const clean = mac.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  return clean.length === 12 ? clean : null;
}

function isValidMac(mac: string | null): boolean {
  if (!mac) return false;
  return MAC_REGEX.test(mac);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= MAX_EMAIL_LEN;
}

// Lista de DDDs brasileiros válidos (ANATEL).
const VALID_BR_DDD = new Set([
  11,12,13,14,15,16,17,18,19, 21,22,24,27,28, 31,32,33,34,35,37,38,
  41,42,43,44,45,46,47,48,49, 51,53,54,55, 61,62,63,64,65,66,67,68,69,
  71,73,74,75,77,79, 81,82,83,84,85,86,87,88,89, 91,92,93,94,95,96,97,98,99,
]);

function isValidPhone(phone: string): boolean {
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
}



function isValidCPF(cpf: string): boolean {
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
}

/**
 * Normaliza telefone para E.164 brasileiro (ex: 5531999999999).
 * O webhook do Centrial Hub exige esse formato — sem '+', apenas dígitos com DDI 55.
 */
function toE164BR(phone: string): string {
  let digits = (phone || "").replace(/\D/g, "");
  // Remove zero à esquerda (formato antigo de discagem nacional)
  digits = digits.replace(/^0+/, "");
  // Se já começa com 55 e tem 12-13 dígitos, já está OK
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    return digits;
  }
  // Se tem 10 ou 11 dígitos (DDD + número), prefixar 55
  if (digits.length === 10 || digits.length === 11) {
    return "55" + digits;
  }
  // Fallback: retorna como veio (já validado por isValidPhone)
  return digits;
}

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
    console.warn("[clubemais] Sync skipped: CLUBEMAIS_API_TOKEN not set");
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
    const bodyText = await res.text();
    const latency = Date.now() - t0;

    console.log(`[clubemais] Sync response: status=${status} latency=${latency}ms body=${bodyText.slice(0, 200)}`);

    if (status >= 200 && status < 300) {
      return { ok: true, message: bodyText };
    }
    return { ok: false, sync_status: status, error: bodyText };
  } catch (err) {
    console.error(`[clubemais] Sync exception: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,48}[a-z0-9]$/.test(slug) || /^[a-z0-9]$/.test(slug);
}

function isValidUUID(id: unknown): boolean {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Extract real public IP from request headers (never trust body) */
function getPublicIp(req: Request): string | null {
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp && isValidIp(cfIp)) return cfIp;

  const xForwardedFor = req.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first && isValidIp(first)) return first;
  }

  const xRealIp = req.headers.get("x-real-ip")?.trim();
  if (xRealIp && isValidIp(xRealIp)) return xRealIp;

  return null;
}

function isValidIp(ip: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip.split(".").every((part) => parseInt(part) <= 255);
  }
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":")) return true;
  return false;
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
 * Use this from /start and /submit when a client-supplied session_id is present
 * to eliminate the duplicate-key race when both run concurrently.
 *
 * Pass `protect: true` (used from /start) to avoid overwriting fields that
 * /submit may already have set (status authorized, submitted_at, etc.).
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
  step: "params" | "form" | "otp" | "unifi" | "redirect" | "system" | "client";
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
    (e) => console.warn("[logEvent] insert failed:", (e as Error)?.message),
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
        (e) => console.warn("[recovery] last_seen update failed:", (e as Error)?.message),
      (e) => console.warn("[logEvent] session patch failed:", (e as Error)?.message),
    );
  }
}

// ========== Detect Store ==========
// Priority order (physical truth first — nginx/UniFi may inject ?store=matriz
// as a global fallback, but the AP MAC reflects the real physical location):
//   1. AP MAC -> store_access_points    (deterministic per physical AP — TRUTH)
//   2. ?store=slug query param          (deterministic only if URL is per-store)
//   3. Public IP -> store_public_ips    (fragile: ISP/NAT shared)
//   4. Single active store              (only meaningful in 1-store deployments)
//   5. Generic fallback                 (caller should trigger discoverStoreByClientMac)
async function detectStoreFromRequest(
  db: ReturnType<typeof supabaseAdmin>,
  req: Request,
  apMac?: string | null,
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

  // 1) AP MAC mapping (deterministic per physical AP — works even when all
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
      console.log(`Store detected via AP MAC mapping: ${store.slug} (AP: ${normApMac})`);
      // Fire-and-forget: refresh last_seen_at
      db.from("store_access_points")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("ap_mac", normApMac)
        .then(() => {}, (e) => console.warn("[ap-mac] last_seen update failed:", (e as Error)?.message));
      return storeResult(store, "ap_mac");
    }
  }

  // 2) Check ?store=slug query param (passed by UniFi redirect URL)
  try {
    const url = new URL(req.url);
    const storeSlug = url.searchParams.get("store");
    if (storeSlug && isValidSlug(storeSlug)) {
      const { data: store } = await db
        .from("stores")
        .select("id, slug, name, city, is_active, post_auth_redirect_url")
        .eq("slug", storeSlug)
        .eq("is_active", true)
        .maybeSingle();

      if (store) {
        console.log(`Store detected via ?store= param: ${store.slug}`);
        return storeResult(store, "url_param");
      }
      console.warn(`Store slug "${storeSlug}" from URL not found or inactive`);
    }
  } catch { /* ignore URL parse errors */ }

  // 3) Public IP mapping (legacy fallback)
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
        console.log(`Store detected via IP mapping: ${store.slug} (IP: ${ip})`);
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
    console.log(`Store detected via single-active fallback: ${store.slug}`);
    return storeResult(store, "single_active");
  }

  console.warn(`No store detected (apMac: ${normApMac || "none"}, IP: ${ip || "unknown"}, active stores: ${activeStores?.length || 0})`);
  return fallback;
}

// ========== Auto-Discovery: probe all controllers to find which one sees the client MAC ==========
// Used when detectStoreFromRequest cannot resolve a store deterministically.
// Logs in to every active controller in parallel and queries /stat/sta. If
// exactly one controller has the client MAC associated, that's the store.
// On success, persists ap_mac -> store mapping for future O(1) detection.
async function discoverStoreByClientMac(
  db: ReturnType<typeof supabaseAdmin>,
  clientMac: string,
  apMacHint?: string | null,
): Promise<{ store_id: string | null; store_slug: string; redirect_url: string | null; store_name: string; store_city: string | null; detection_source: string } | null> {
  if (!clientMac || clientMac.length !== 12) return null;

  const { data: stores } = await db
    .from("stores")
    .select("id, slug, name, city, post_auth_redirect_url, unifi_controller_url, unifi_site_id")
    .eq("is_active", true)
    .not("unifi_controller_url", "is", null);

  if (!stores || stores.length === 0) return null;

  const target = clientMac.toLowerCase().match(/.{2}/g)?.join(":") || clientMac.toLowerCase();

  type Hit = { store: typeof stores[number]; apMac: string | null };
  const probes = stores.map(async (store): Promise<Hit | null> => {
    const ctrlUrl = (store.unifi_controller_url || "").replace(/\/+$/, "");
    if (!ctrlUrl) return null;
    const user = UNIFI_USERNAME;
    const pass = UNIFI_PASSWORD;
    if (!user || !pass) {
      console.warn(`[discover] UNIFI_SECRET_NOT_CONFIGURED for store ${store.slug}`);
      return null;
    }
    const siteId = store.unifi_site_id || "default";
    const httpClient = createUnifiHttpClient();
    try {
      const parsed = new URL(ctrlUrl);
      const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
      const login = await unifiLogin(baseUrl, httpClient, user, pass);
      if (!login.ok || !login.cookie) return null;
      const headers: Record<string, string> = {
        Cookie: login.csrfToken
          ? `unifises=${login.cookie}; csrf_token=${login.csrfToken}`
          : `unifises=${login.cookie}`,
      };
      const sta = await unifiFetchStations(`${baseUrl}/api/s/${siteId}/stat/sta`, headers, httpClient);
      if (!sta.ok || !sta.data) return null;
      const match = sta.data.find((s) => (s.mac || "").toLowerCase() === target);
      if (!match) return null;
      return { store, apMac: (match.ap_mac as string) || null };
    } catch (e) {
      console.warn(`[discover] probe ${store.slug} failed:`, (e as Error)?.message);
      return null;
    } finally {
      httpClient?.close();
    }
  });

  const results = (await Promise.all(probes)).filter((r): r is Hit => r !== null);

  if (results.length === 0) {
    console.warn(`[discover] no controller sees client ${clientMac}`);
    return null;
  }
  if (results.length > 1) {
    console.warn(`[discover] AMBIGUOUS: client ${clientMac} visible on ${results.length} controllers: ${results.map((r) => r.store.slug).join(",")} — refusing to guess`);
    return null;
  }

  const winner = results[0];
  console.log(`[discover] client ${clientMac} -> store ${winner.store.slug} (ap=${winner.apMac || "?"})`);

  // Persist AP MAC mapping for future O(1) detection (use AP from probe or hint)
  const apToPersist = (winner.apMac || apMacHint || "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (apToPersist.length === 12) {
    db.from("store_access_points")
      .upsert({
        ap_mac: apToPersist,
        store_id: winner.store.id,
        source: "auto_discovered",
        last_seen_at: new Date().toISOString(),
      }, { onConflict: "ap_mac" })
      .then(
        () => console.log(`[discover] persisted ap ${apToPersist} -> ${winner.store.slug}`),
        (e) => console.warn(`[discover] persist ap failed:`, (e as Error)?.message),
      );
  }

  return {
    store_id: winner.store.id,
    store_slug: winner.store.slug,
    redirect_url: winner.store.post_auth_redirect_url || null,
    store_name: winner.store.name,
    store_city: winner.store.city,
    detection_source: "auto_discovery",
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
      console.warn("Rate limit RPC error:", error.message);
      return { allowed: true, remaining: maxHits, blocked_until: null };
    }

    const result = typeof data === "string" ? JSON.parse(data) : data;
    return {
      allowed: !!result.allowed,
      remaining: result.remaining ?? 0,
      blocked_until: result.blocked_until || null,
    };
  } catch (e) {
    console.warn("Rate limit check failed:", (e as Error).message);
    return { allowed: true, remaining: maxHits, blocked_until: null };
  }
}

// ========== Dedup Map (in-memory) ==========
const dedupMap = new Map<string, number>();

function isDuplicate(key: string): boolean {
  const now = Date.now();
  const last = dedupMap.get(key);
  if (last && now - last < DEDUP_WINDOW_SEC * 1000) return true;
  dedupMap.set(key, now);
  return false;
}

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

async function fetchGeoIp(ip: string): Promise<GeoIpData | null> {
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

async function enrichGeoIp(
  db: ReturnType<typeof supabaseAdmin>,
  ip: string
): Promise<GeoIpData & { source: string }> {
  const { data: cached } = await db
    .from("origin_ip_clusters")
    .select("city, region, country, isp, asn, last_geoip_at")
    .eq("public_ip", ip)
    .maybeSingle();

  if (cached && cached.last_geoip_at) {
    const ageHours = (Date.now() - new Date(cached.last_geoip_at).getTime()) / 3_600_000;
    if (ageHours < GEOIP_CACHE_TTL_HOURS) {
      return {
        city: cached.city, region: cached.region, country: cached.country,
        isp: cached.isp, asn: cached.asn, source: "cache",
      };
    }
  }

  const geoData = await fetchGeoIp(ip);

  if (geoData) {
    await db.from("origin_ip_clusters").upsert(
      {
        public_ip: ip, city: geoData.city, region: geoData.region,
        country: geoData.country, isp: geoData.isp, asn: geoData.asn,
        last_seen_at: new Date().toISOString(),
        last_geoip_at: new Date().toISOString(),
        geoip_provider: GEOIP_PROVIDER,
      },
      { onConflict: "public_ip", ignoreDuplicates: false }
    );
    return { ...geoData, source: "geoip" };
  }

  await db.from("origin_ip_clusters").upsert(
    { public_ip: ip, last_seen_at: new Date().toISOString() },
    { onConflict: "public_ip", ignoreDuplicates: false }
  );

  return { city: null, region: null, country: null, isp: null, asn: null, source: "none" };
}

async function incrementClusterLeadCount(db: ReturnType<typeof supabaseAdmin>, ip: string) {
  try {
    const { data } = await db
      .from("origin_ip_clusters")
      .select("lead_count")
      .eq("public_ip", ip)
      .maybeSingle();

    const newCount = (data?.lead_count || 0) + 1;
    await db
      .from("origin_ip_clusters")
      .update({ lead_count: newCount, last_seen_at: new Date().toISOString() })
      .eq("public_ip", ip);
  } catch (e) {
    console.warn("Failed to increment cluster lead_count:", (e as Error).message);
  }
}


// ========== WhatsApp Webhook Config from DB ==========
interface WhatsAppConfig {
  url: string;
  secret: string | null;
}

async function getWhatsappConfig(
  db: ReturnType<typeof supabaseAdmin>,
  _storeId: string | null
): Promise<WhatsAppConfig | null> {
  // Future: could check per-store config first
  // For now, use global_settings only
  const { data } = await db
    .from("global_settings")
    .select("whatsapp_webhook_url, whatsapp_webhook_secret, whatsapp_webhook_enabled")
    .eq("id", 1)
    .maybeSingle();

  if (!data) return null;
  if (!data.whatsapp_webhook_enabled || !data.whatsapp_webhook_url) return null;

  return {
    url: data.whatsapp_webhook_url,
    secret: data.whatsapp_webhook_secret || null,
  };
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
  username?: string, password?: string
): Promise<{ ok: boolean; cookie?: string; csrfToken?: string; token?: string; error?: string; isUnifiOs?: boolean }> {
   const effectiveUser = username || UNIFI_USERNAME;
   const effectivePass = password || UNIFI_PASSWORD;
   
   if (!effectiveUser || !effectivePass) {
     throw new Error("UNIFI_SECRET_NOT_CONFIGURED");
   }
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), UNIFI_TIMEOUT_MS);

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
    let warmupCookies = "";
    let warmupCsrf = "";
    try {
      const warmAc = new AbortController();
      const warmTimer = setTimeout(() => warmAc.abort(), UNIFI_TIMEOUT_MS);
      const warmOpts: Record<string, unknown> = {
        method: "GET",
        headers: { "User-Agent": baseHeaders["User-Agent"], "Accept": "*/*" },
        signal: warmAc.signal,
        redirect: "manual",
      };
      if (httpClient) warmOpts.client = httpClient;
      const warmRes = await fetch(`${baseUrl}/`, warmOpts as RequestInit);
      clearTimeout(warmTimer);
      const warmSetCookie = warmRes.headers.get("set-cookie") || "";
      warmupCsrf = warmRes.headers.get("x-csrf-token") || "";
      // Extract cookie name=value pairs (drop attributes like Path, HttpOnly)
      warmupCookies = warmSetCookie
        .split(/,(?=[^;]+=)/)
        .map(c => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
      await warmRes.body?.cancel().catch(() => {});
      console.log(`[UniFi] Warmup GET ${baseUrl}/: HTTP ${warmRes.status}, cookies="${warmupCookies.slice(0, 120)}", csrf="${warmupCsrf.slice(0, 40)}"`);
    } catch (e) {
      console.log(`[UniFi] Warmup GET failed (non-fatal): ${(e as Error).message}`);
    }

    // ---- POST login ----
    const headers: Record<string, string> = { ...baseHeaders };
    if (warmupCookies) headers["Cookie"] = warmupCookies;
    if (warmupCsrf) headers["X-CSRF-Token"] = warmupCsrf;

    const payload = {
      username: effectiveUser,
      password: effectivePass,
      remember: false,
      strict: true,
    };

    console.log(`[UniFi] Login attempt: ${loginUrl} (custom client: ${!!httpClient}, warm cookies: ${warmupCookies ? "yes" : "no"})`);
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

    const respSetCookie = res.headers.get("set-cookie") || "";
    const respCsrf = res.headers.get("x-csrf-token") || "";
    const respServer = res.headers.get("server") || "";
    console.log(`[UniFi] Login response ${loginUrl}: HTTP ${res.status} | server="${respServer}" | set-cookie="${respSetCookie.slice(0, 200)}" | x-csrf-token="${respCsrf.slice(0, 40)}"`);

    // UniFi controllers often return 302/303 after successful login — treat 2xx and 3xx as potential success
    if (res.status >= 400) {
      const text = await res.text().catch(() => "");
      console.log(`[UniFi] Login body (HTTP ${res.status}): ${text.slice(0, 500)}`);
      return { ok: false, error: `Login HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    // UniFi OS returns a TOKEN cookie; legacy returns unifises (+ csrf_token)
    const tokenMatch = respSetCookie.match(/TOKEN=([^;]+)/);
    if (tokenMatch) {
      return { ok: true, token: tokenMatch[1], isUnifiOs: true };
    }
    const legacyMatch = respSetCookie.match(/unifises=([^;]+)/);
    if (legacyMatch) {
      // Legacy controllers also issue csrf_token alongside unifises — capture it for subsequent requests
      const csrfMatch = respSetCookie.match(/csrf_token=([^;]+)/);
      return { ok: true, cookie: legacyMatch[1], csrfToken: csrfMatch?.[1], isUnifiOs: false };
    }

    // Some UniFi OS versions return x-csrf-token header instead
    if (respCsrf) {
      return { ok: true, token: respCsrf, isUnifiOs: true };
    }

    return { ok: false, error: "Login succeeded but no auth cookie/token returned" };
  } catch (err) {
    clearTimeout(timeout);
    const msg = (err as Error).name === "AbortError"
      ? `Login timeout after ${UNIFI_TIMEOUT_MS}ms`
      : (err as Error).message;
    return { ok: false, error: msg };
  }
}

/**
 * Login to UniFi controller — tries UniFi OS endpoint first, then legacy.
 */
async function unifiLogin(
  baseUrl: string, httpClient: Deno.HttpClient | null,
  username?: string, password?: string
): Promise<{ ok: boolean; cookie?: string; csrfToken?: string; token?: string; isUnifiOs?: boolean; error?: string }> {
  // Try UniFi OS first: {baseUrl}/api/auth/login
  const osResult = await unifiTryLogin(`${baseUrl}/api/auth/login`, httpClient, username, password);
  if (osResult.ok) {
    console.log("UniFi login succeeded via UniFi OS endpoint");
    return osResult;
  }

  // Always try legacy /api/login as fallback
  console.log(`UniFi OS endpoint failed (${osResult.error?.slice(0, 100)}), trying legacy ${baseUrl}/api/login...`);
  const legacyResult = await unifiTryLogin(`${baseUrl}/api/login`, httpClient, username, password);
  if (legacyResult.ok) {
    console.log("UniFi login succeeded via legacy endpoint (/api/login)");
    return legacyResult;
  }
  return { ok: false, error: `OS: ${osResult.error} | Legacy: ${legacyResult.error}` };
}

// Polling backoff for /stat/sta confirmation (~3s total across 3 attempts).
// Captive assistants typically time out around 5-10s, so we keep this short
// and rely on the hotspot fallback redirect for the final handshake.
const VERIFY_BACKOFF_MS = [500, 1000, 1500];
const RESEND_AFTER_ATTEMPT = 999; // disable mid-poll re-emission (kept for clarity)

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
  pending_confirmation?: boolean; // set when fastReturn=true and CMD accepted
  confirm?: Promise<UnifiAuthResult>; // resolves with the final polling result
};

function isJsonContentType(res: Response): boolean {
  const ct = res.headers.get("content-type") || "";
  return ct.toLowerCase().includes("application/json");
}

async function unifiFetchStations(
  staUrl: string, headers: Record<string, string>, httpClient: Deno.HttpClient | null,
): Promise<{ ok: boolean; sessionExpired?: boolean; data?: UnifiStation[]; error?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(staUrl, {
      method: "GET",
      headers: { Cookie: headers["Cookie"] || "" },
      signal: ac.signal,
      ...(httpClient ? { client: httpClient } : {}),
    } as RequestInit);
    clearTimeout(t);
    if (!res.ok) {
      await res.text().catch(() => "");
      return { ok: false, error: `/stat/sta HTTP ${res.status}` };
    }
    if (!isJsonContentType(res)) {
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

    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, raw: text };
    }
    if (!isJsonContentType(res)) {
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
 *  - (7) Long polling with backoff + command re-emission
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
): Promise<{ state: "authorized" | "not_authorized" | "inconclusive"; effective_mac?: string }> {
  const parsed = new URL(controllerUrl);
  const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
  const httpClient = createUnifiHttpClient();
  
  try {
    const login = await unifiLogin(baseUrl, httpClient, username, password);
    if (!login.ok) return { state: "inconclusive" };
    
    const headers = {
      "Content-Type": "application/json",
      "Cookie": login.isUnifiOs && login.token ? `TOKEN=${login.token}` : (login.cookie ? `unifises=${login.cookie}` : "")
    };
    
    const staUrl = login.isUnifiOs 
      ? `${parsed.origin}/proxy/network/api/s/${siteId}/stat/sta`
      : `${baseUrl}/api/s/${siteId}/stat/sta`;
      
    const formattedMac = mac.replace(/(.{2})(?=.)/g, "$1:").toLowerCase();
    const staRes = await unifiFetchStations(staUrl, headers, httpClient);
    
    if (!staRes.ok || !staRes.data) return { state: "inconclusive" };
    
    // Procura o MAC exato ou via pickEffectiveMac (heurística de randomização)
    const pick = pickEffectiveMac(staRes.data, formattedMac);
    const effectiveMac = pick.mac || formattedMac;
    
    if (pick.candidateCount > 1) return { state: "inconclusive" };
    
    const found = staRes.data.find(s => (s.mac || "").toLowerCase() === effectiveMac);
    if (found) {
      return { 
        state: found.authorized ? "authorized" : "not_authorized",
        effective_mac: effectiveMac.replace(/:/g, "").toUpperCase()
      };
    }
    
    return { state: "not_authorized" };
  } catch (err) {
    console.error("[unifi-check] failed:", err);
    return { state: "inconclusive" };
  } finally {
    try { httpClient?.close(); } catch { }
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

  // Helper: build auth headers from a login result
  const buildHeaders = (login: Awaited<ReturnType<typeof unifiLogin>>): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (login.isUnifiOs && login.token) {
      h["Cookie"] = `TOKEN=${login.token}`;
      h["X-CSRF-Token"] = login.token;
    } else if (login.cookie) {
      h["Cookie"] = login.csrfToken
        ? `unifises=${login.cookie}; csrf_token=${login.csrfToken}`
        : `unifises=${login.cookie}`;
      if (login.csrfToken) h["X-Csrf-Token"] = login.csrfToken;
    }
    return h;
  };

  let closed = false;
  const closeClient = () => { if (!closed) { closed = true; try { httpClient?.close(); } catch { /* ignore */ } } };

  try {
    // Step 1: Fresh login
    let login = await unifiLogin(baseUrl, httpClient, username, password);
    if (!login.ok) { closeClient(); return { ok: false, reason: "UNIFI_LOGIN_FAILED", error: `UniFi login failed: ${login.error}` }; }
    let headers = buildHeaders(login);

    const origin = parsed.origin;
    const stamgrUrls = login.isUnifiOs
      ? [`${origin}/proxy/network/api/s/${siteId}/cmd/stamgr`, `${baseUrl}/api/s/${siteId}/cmd/stamgr`]
      : [`${baseUrl}/api/s/${siteId}/cmd/stamgr`];

    const formattedMac = clientMac.replace(/(.{2})(?=.)/g, "$1:").toLowerCase();

    // Step 2: Pre-fetch stations (causa #1 + #12)
    const staUrl0 = stamgrUrls[0].replace("/cmd/stamgr", "/stat/sta");
    let stationsRes = await unifiFetchStations(staUrl0, headers, httpClient);
    if (stationsRes.sessionExpired) {
      console.warn("[unifi-auth] reason=UNIFI_SESSION_EXPIRED phase=pre-stations action=re-login");
      login = await unifiLogin(baseUrl, httpClient, username, password);
      if (login.ok) { headers = buildHeaders(login); stationsRes = await unifiFetchStations(staUrl0, headers, httpClient); }
    }
    const stations = stationsRes.data || [];

    const pick = pickEffectiveMac(stations, formattedMac, options.apMac, options.ssid);
    let effectiveMac = pick.mac || formattedMac;
    let apMacForPayload = options.apMac || null;

    if (pick.remapped) {
      console.log(`[unifi-auth] reason=MAC_REMAPPED_OK portal=${formattedMac} controller=${effectiveMac} ap=${apMacForPayload || "?"}`);
    } else if (!pick.mac) {
      if (pick.candidateCount > 1) {
        console.warn(`[unifi-auth] reason=MAC_RANDOMIZATION_AMBIGUOUS candidates=${pick.candidateCount} ap=${apMacForPayload || "?"}`);
        closeClient();
        return {
          ok: false,
          reason: "MAC_RANDOMIZATION_AMBIGUOUS",
          error: "Múltiplos dispositivos não autorizados detectados. Desative 'Endereço Wi-Fi privado' nas configurações do celular e tente novamente.",
          latency_ms: Date.now() - startedAt,
        };
      }
    }

    if (!apMacForPayload) {
      const found = stations.find((s) => (s.mac || "").toLowerCase() === effectiveMac);
      if (found?.ap_mac) {
        apMacForPayload = found.ap_mac;
        console.log(`[unifi-auth] reason=AP_MAC_DISCOVERED ap=${apMacForPayload}`);
      } else {
        console.log(`[unifi-auth] reason=AP_MAC_MISSING_FALLBACK mac=${effectiveMac}`);
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
          console.warn("[unifi-auth] reason=UNIFI_SESSION_EXPIRED phase=cmd action=re-login");
          login = await unifiLogin(baseUrl, httpClient, username, password);
          if (login.ok) { headers = buildHeaders(login); cmd = await unifiSendAuthorizeCmd(url, headers, httpClient, buildPayload(mins)); }
        }
        if (cmd.ok && cmd.rcOk) {
          activeUrl = url;
          cmdSentAt = Math.floor(Date.now() / 1000);
          cmdAcceptedAtIso = new Date().toISOString();
          console.log(`[unifi-auth] reason=CMD_ACCEPTED url=${url} mac=${effectiveMac} ap=${apMacForPayload || "-"} minutes=${mins}`);
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
      console.warn(`[unifi-auth] reason=SITE_POLICY_OVERRIDE retrying with minutes=15 (was ${usedMinutes}, error=${lastError})`);
      policyOverride = true;
      usedMinutes = 15;
      accepted = await sendOnce(usedMinutes);
    }
    if (!accepted) {
      closeClient();
      return { ok: false, reason: "UNIFI_CMD_REJECTED", error: lastError || "command rejected", latency_ms: Date.now() - startedAt };
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
            console.warn(`[unifi-auth] reason=UNIFI_SESSION_EXPIRED phase=poll attempt=${attempt} action=re-login`);
            login = await unifiLogin(baseUrl, httpClient, username, password);
            if (login.ok) { headers = buildHeaders(login); staRes = await unifiFetchStations(staUrl, headers, httpClient); }
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
                console.log(`[unifi-auth] reason=AUTH_CONFIRMED mac=${effectiveMac} ap=${found.ap_mac || "-"} ip=${found.ip || "-"} attempts=${attempt} ms=${ms}`);
                return {
                  ok: true, effective_mac: effectiveMac.replace(/:/g, "").toUpperCase(),
                  ap_mac_used: apMacForPayload, latency_ms: ms,
                  cmd_accepted_at: cmdAcceptedAtIso,
                  last_verify_result: { ...lastVerifySnapshot, verify_error: null },
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
          console.warn(`[unifi-auth] poll attempt=${attempt}/${VERIFY_BACKOFF_MS.length}: ${verifyError}`);

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

  // Prompt 07: Server-side idempotency lock (15s)
  // Prevents multiple concurrent UniFi commands for the same MAC
  const lock = await db.rpc("rate_limit_hit", {
    p_key: `unifi_auth:mac:${clientMac.toUpperCase()}`,
    p_window_seconds: 15,
    p_max_hits: 1,
    p_block_seconds: 0,
  });

  if (lock.data?.allowed === false) {
    console.warn(`[authorize] duplicate concurrent request for mac=${clientMac}`);
    // If there's a very recent successful auth (last 30s), just return success
    const { data: recentAuth } = await db
      .from("captive_sessions")
      .select("id, status, unifi_cmd_accepted_at, authorized_at")
      .eq("client_mac", clientMac.toUpperCase())
      .eq("status", "authorized")
      .gte("authorized_at", new Date(Date.now() - 30 * 1000).toISOString())
      .maybeSingle();

    if (recentAuth) {
      console.log(`[authorize] reusing recent authorization for mac=${clientMac}`);
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

  const siteId = store.unifi_site_id || "default";
  const result = await unifiAuthorizeWithRetry(
    store.unifi_controller_url, siteId, clientMac, storeUser, storePass,
    { apMac: context.apMac || null, ssid: context.ssid || null, minutes: desiredMinutes, fastReturn: !!context.fastReturn },
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
      },
    });
    return {
      ok: true,
      cmd_accepted_at: result.cmd_accepted_at,
      last_verify_result: result.last_verify_result || null,
      pending_confirmation: !!result.pending_confirmation,
      confirm: result.confirm,
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
function getControllerBaseForGuestRedirect(controllerUrl: string): string {
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

  return {
    expired_verifications: expiredVerifData?.length || 0,
    old_rate_limits: oldRateLimitData?.length || 0,
    old_sessions: (oldSessionData?.length || 0) + (oldAuthSessionData?.length || 0),
    old_audit_logs: oldAuditData?.length || 0,
  };
}

// ========== Admin Endpoints ==========

async function requireAdmin(req: Request): Promise<{ db: ReturnType<typeof supabaseAdmin>; userId: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);

  const authClient = supabaseAuth(authHeader);
  const token = authHeader.replace("Bearer ", "");

  const { data: userData, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userData?.user) return errorResponse("Unauthorized", 401);

  const userId = userData.user.id;
  const db = supabaseAdmin();

  const { data: roleData } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();

  if (!roleData) return errorResponse("Forbidden: admin role required", 403);
  return { db, userId };
}

// ========== Admin: Global Settings ==========
async function handleAdminSettings(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  if (req.method === "GET") {
    const { data, error } = await db
      .from("global_settings")
      .select("whatsapp_webhook_url, whatsapp_webhook_secret, whatsapp_webhook_enabled, updated_at")
      .eq("id", 1)
      .maybeSingle();

    if (error) return errorResponse(error.message, 500);

    return jsonResponse({
      whatsapp_webhook_url: data?.whatsapp_webhook_url || null,
      whatsapp_webhook_enabled: data?.whatsapp_webhook_enabled || false,
      whatsapp_webhook_secret_configured: !!data?.whatsapp_webhook_secret,
      updated_at: data?.updated_at || null,
    });
  }

  if (req.method === "PUT") {
    const body = await safeParseJson(req);
    if (!body) return errorResponse("Invalid JSON");

    const updateData: Record<string, unknown> = {};

    if (body.whatsapp_webhook_url !== undefined) {
      const url = sanitizeString(body.whatsapp_webhook_url, 500);
      if (url && !url.startsWith("https://")) return errorResponse("URL deve começar com https://");
      updateData.whatsapp_webhook_url = url || null;
    }

    if (body.whatsapp_webhook_enabled !== undefined) {
      updateData.whatsapp_webhook_enabled = !!body.whatsapp_webhook_enabled;
    }

    // Secret: only accept if explicitly provided (replace)
    if (typeof body.whatsapp_webhook_secret === "string") {
      const secret = body.whatsapp_webhook_secret.trim();
      if (secret.length > 0 && secret.length < 8) return errorResponse("Secret deve ter pelo menos 8 caracteres");
      updateData.whatsapp_webhook_secret = secret || null;
    }

    if (Object.keys(updateData).length === 0) return errorResponse("Nenhum campo para atualizar");

    const { error } = await db
      .from("global_settings")
      .update(updateData)
      .eq("id", 1);

    if (error) return errorResponse(error.message, 500);

    return jsonResponse({ ok: true, message: "Configurações atualizadas." });
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

    const { data, error } = await db.from("stores").insert({
      slug, name,
      city: sanitizeString(body.city, 100) || null,
      is_active: body.is_active === false ? false : true,
      post_auth_redirect_url: sanitizeString(body.post_auth_redirect_url, 500) || null,
      unifi_site_id: sanitizeString(body.unifi_site_id, 100) || null,
      unifi_controller_url: sanitizeString(body.unifi_controller_url, 500) || null,
    }).select("id, slug, name").single();
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data, 201);
  }

  if (req.method === "PUT") {
    const body = await safeParseJson(req);
    if (!body || !isValidUUID(body.id)) return errorResponse("Missing or invalid store id");

    const updateData: Record<string, unknown> = {};
    if (body.slug !== undefined) { const s = sanitizeString(body.slug, MAX_SLUG_LEN); if (s && isValidSlug(s)) updateData.slug = s; }
    if (body.name !== undefined) { const n = sanitizeString(body.name, MAX_NAME_LEN); if (n) updateData.name = n; }
    if (body.city !== undefined) updateData.city = sanitizeString(body.city, 100);
    if (body.is_active !== undefined) updateData.is_active = !!body.is_active;
    if (body.post_auth_redirect_url !== undefined) updateData.post_auth_redirect_url = sanitizeString(body.post_auth_redirect_url, 500);
    if (body.unifi_site_id !== undefined) updateData.unifi_site_id = sanitizeString(body.unifi_site_id, 100);
    if (body.unifi_controller_url !== undefined) updateData.unifi_controller_url = sanitizeString(body.unifi_controller_url, 500);
    // Allow updating controller params
    if (body.unifi_site_id !== undefined) updateData.unifi_site_id = sanitizeString(body.unifi_site_id, 100);
    if (body.unifi_controller_url !== undefined) updateData.unifi_controller_url = sanitizeString(body.unifi_controller_url, 500);

    if (Object.keys(updateData).length === 0) return errorResponse("Nenhum campo para atualizar");

    const { data, error } = await db.from("stores").update(updateData).eq("id", body.id as string).select("id, slug, name").single();
    if (error) return errorResponse(error.message, 500);

    await db.from("audit_logs").insert({
      store_id: body.id as string, entity: "store", entity_id: body.id as string,
      action: "update", meta: { updated_by: auth.userId, fields: Object.keys(updateData) },
    });

    return jsonResponse(data);
  }

  if (req.method === "DELETE") {
    const body = await safeParseJson(req);
    if (!body || !isValidUUID(body.id)) return errorResponse("Missing or invalid store id");

    const { error } = await db.from("stores").delete().eq("id", body.id as string);
    if (error) return errorResponse(error.message, 500);

    await db.from("audit_logs").insert({
      store_id: body.id as string, entity: "store", entity_id: body.id as string,
      action: "delete", meta: { deleted_by: auth.userId },
    });
    return jsonResponse({ ok: true });
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminLeads(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const storeId = url.searchParams.get("store_id");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50") || 50), 200);
  const offset = (page - 1) * limit;
  const format = url.searchParams.get("format");

  let query = db
    .from("leads")
    .select("id, store_id, session_id, name, email, phone, cpf, client_mac, created_at, consented_at, consent_version, source, origin_ip, origin_city, origin_region, stores(slug, name)", { count: "exact" })
    .order("created_at", { ascending: false });

  if (storeId && isValidUUID(storeId)) query = query.eq("store_id", storeId);
  if (from) query = query.gte("created_at", from.length === 10 ? `${from}T00:00:00.000Z` : from);
  if (to) query = query.lte("created_at", to.length === 10 ? `${to}T23:59:59.999Z` : to);

  if (format === "csv") {
    query = query.limit(10000);
    const { data, error } = await query;
    if (error) return errorResponse(error.message, 500);

    const headers = ["id", "store_slug", "name", "cpf", "email", "phone", "client_mac", "origin_ip", "origin_city", "origin_region", "created_at", "consent_version"];
    const csvRows = [headers.join(",")];
    for (const lead of data || []) {
      const storeInfo = lead.stores as unknown as { slug: string; name: string } | null;
      csvRows.push([
        lead.id, storeInfo?.slug || "",
        `"${(lead.name || "").replace(/"/g, '""')}"`,
        (lead as any).cpf || "", lead.email || "", lead.phone || "", lead.client_mac || "",
        (lead as any).origin_ip || "", (lead as any).origin_city || "", (lead as any).origin_region || "",
        lead.created_at, lead.consent_version,
      ].join(","));
    }

    return new Response(csvRows.join("\n"), {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="leads_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  query = query.range(offset, offset + limit - 1);
  const { data, count, error } = await query;
  if (error) return errorResponse(error.message, 500);
  return jsonResponse({ data, total: count, page, limit });
}

async function handleAdminConsent(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

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

    if (body.deactivate_previous !== false) {
      await db.from("consent_versions").update({ is_active: false }).eq("is_active", true);
    }

    const { data, error } = await db.from("consent_versions")
      .insert({ version, text, is_active: true })
      .select("id, version, is_active, created_at").single();
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data, 201);
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminSessions(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const storeId = url.searchParams.get("store_id");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50") || 50), 200);
  const offset = (page - 1) * limit;

  let query = db
    .from("captive_sessions")
    .select("id, store_id, client_mac, client_ip, ssid, status, started_at, submitted_at, authorized_at, fail_reason, stores(slug, name)", { count: "exact" })
    .order("started_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (storeId && isValidUUID(storeId)) query = query.eq("store_id", storeId);

  const { data, count, error } = await query;
  if (error) return errorResponse(error.message, 500);
  return jsonResponse({ data, total: count, page, limit });
}

async function handleAdminClusters(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

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
    const csvRows = [headers.join(",")];
    for (const c of data || []) {
      csvRows.push([c.public_ip, c.city || "", c.region || "", c.country || "", c.isp || "", c.asn || "", c.lead_count, c.first_seen_at, c.last_seen_at].join(","));
    }
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
  const { db } = auth;

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
    if (!ip) return errorResponse("public_ip obrigatório");

    const { data, error } = await db.from("store_public_ips")
      .insert({ store_id: body.store_id as string, public_ip: ip, is_active: body.is_active !== false })
      .select("id, store_id, public_ip, is_active")
      .single();
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data, 201);
  }

  if (req.method === "DELETE") {
    const body = await safeParseJson(req);
    if (!body || !isValidUUID(body.id)) return errorResponse("Missing or invalid id");
    const { error } = await db.from("store_public_ips").delete().eq("id", body.id as string);
    if (error) return errorResponse(error.message, 500);
    return jsonResponse({ ok: true });
  }

  return errorResponse("Method not allowed", 405);
}

// ========== Admin: Access Points (AP MAC -> Store mapping) ==========
async function handleAdminAccessPoints(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

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
        console.error(`[admin-aps] UNIFI_SECRET_NOT_CONFIGURED for store ${store.slug}`);
        return errorResponse("Configuração de credenciais UniFi ausente ou incompleta", 500);
      }
      
      const siteId = store.unifi_site_id || "default";
      const httpClient = createUnifiHttpClient();
      try {
        const parsed = new URL(ctrlUrl);
        const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
        const login = await unifiLogin(baseUrl, httpClient, user, pass);
        if (!login.ok || !login.cookie) return errorResponse(`Falha no login UniFi: ${login.error || "unknown"}`, 502);
        const headers: Record<string, string> = {
          Cookie: login.csrfToken
            ? `unifises=${login.cookie}; csrf_token=${login.csrfToken}`
            : `unifises=${login.cookie}`,
        };
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

        return jsonResponse({ imported: upData?.length || rows.length, store_slug: store.slug });
      } catch (err) {
        return errorResponse((err as Error).message, 502);
      } finally {
        httpClient?.close();
      }
    }

    // Manual single upsert
    if (!isValidUUID(body.store_id)) return errorResponse("store_id inválido");
    const macRaw = sanitizeString(body.ap_mac, 32);
    if (!macRaw) return errorResponse("ap_mac obrigatório");

    const { data, error } = await db.from("store_access_points")
      .upsert({
        ap_mac: macRaw, // trigger normalizes
        store_id: body.store_id as string,
        source: "manual",
        name: sanitizeString(body.name, 100),
      }, { onConflict: "ap_mac" })
      .select("ap_mac, store_id, source, name")
      .single();
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data, 201);
  }

  // DELETE /admin/access-points  { ap_mac }
  if (req.method === "DELETE") {
    const body = await safeParseJson(req);
    const macRaw = sanitizeString(body?.ap_mac, 32);
    if (!macRaw) return errorResponse("ap_mac obrigatório");
    const apMac = macRaw.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
    if (apMac.length !== 12) return errorResponse("ap_mac inválido");
    const { error } = await db.from("store_access_points").delete().eq("ap_mac", apMac);
    if (error) return errorResponse(error.message, 500);
    return jsonResponse({ ok: true });
  }

  return errorResponse("Method not allowed", 405);
}



// ========== Diagnostic: Test UniFi Connectivity (Admin Only) ==========
async function handleTestUnifiReach(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const body = await safeParseJson(req);
  const controllerUrl = (body?.controller_url as string) || "";

  // If no URL provided, try to get from a store
  let targetUrl = controllerUrl;
  if (!targetUrl && body?.store_slug) {
    const { data: store } = await db.from("stores")
      .select("unifi_controller_url")
      .eq("slug", body.store_slug as string).maybeSingle();
    targetUrl = store?.unifi_controller_url || "";
  }

  if (!targetUrl) return errorResponse("controller_url ou store_slug obrigatório");

  const baseUrl = targetUrl.replace(/\/+$/, "");
  const results: Record<string, unknown> = {
    controller_url: baseUrl,
    unifi_username_set: !!UNIFI_USERNAME,
    unifi_password_set: !!UNIFI_PASSWORD,
    tests: {},
  };

  // Test 1: TCP connectivity (try fetching the login page)
  const httpClient = createUnifiHttpClient();
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), UNIFI_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: UNIFI_USERNAME || "", password: UNIFI_PASSWORD || "" }),
      signal: ac.signal,
      client: httpClient,
    } as RequestInit);
    clearTimeout(timeout);

    const resText = await res.text().catch(() => "");
    const setCookie = res.headers.get("set-cookie") || "";
    const hasCookie = /unifises=/.test(setCookie);

    (results.tests as Record<string, unknown>).login = {
      status: res.status,
      ok: res.ok,
      has_unifises_cookie: hasCookie,
      response_preview: resText.slice(0, 300),
    };

    // Test 2: If login succeeded, try stamgr endpoint
    if (hasCookie) {
      const cookie = setCookie.match(/unifises=([^;]+)/)?.[1];
      const siteId = (body?.site_id as string) || "default";
      const ac2 = new AbortController();
      const timeout2 = setTimeout(() => ac2.abort(), UNIFI_TIMEOUT_MS);
      // Use a dummy "get" command to test connectivity without authorizing anyone
      const res2 = await fetch(`${baseUrl}/api/s/${siteId}/stat/sta`, {
        method: "GET",
        headers: { "Cookie": `unifises=${cookie}` },
        signal: ac2.signal,
        client: httpClient,
      } as RequestInit);
      clearTimeout(timeout2);
      const res2Text = await res2.text().catch(() => "");
      (results.tests as Record<string, unknown>).stamgr_reach = {
        status: res2.status,
        ok: res2.ok,
        response_preview: res2Text.slice(0, 300),
      };
    }
  } catch (err) {
    const msg = (err as Error).name === "AbortError"
      ? `Timeout after ${UNIFI_TIMEOUT_MS}ms — controller not reachable`
      : (err as Error).message;
    (results.tests as Record<string, unknown>).login = { error: msg };
  } finally {
    httpClient?.close();
  }

  return jsonResponse(results);
}

// ========== Test Endpoint (Admin Only) ==========
async function handleTestAuthorize(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON");

  const storeSlug = sanitizeString(body.store_slug, MAX_SLUG_LEN);
  const mac = normalizeMac(body.mac);
  if (!storeSlug) return errorResponse("store_slug obrigatório");
  if (!mac || !isValidMac(mac)) return errorResponse("MAC inválido (ex: AA:BB:CC:DD:EE:FF)");

  const { data: store } = await db.from("stores")
    .select("id, unifi_controller_url, unifi_site_id")
    .eq("slug", storeSlug).maybeSingle();

  if (!store) return errorResponse("Store not found", 404);
  if (!store.unifi_controller_url) {
    return jsonResponse({ ok: false, reason: "UNIFI_NOT_CONFIGURED", message: "Loja não possui unifi_controller_url configurada." });
  }
  if (!UNIFI_USERNAME || !UNIFI_PASSWORD) {
    return jsonResponse({ ok: false, reason: "UNIFI_CREDENTIALS_MISSING", message: "Secrets UNIFI_USERNAME/UNIFI_PASSWORD não configurados." });
  }

  const siteId = store.unifi_site_id || "default";
  const result = await unifiAuthorizeWithRetry(store.unifi_controller_url, siteId, mac);

  await db.from("audit_logs").insert({
    store_id: store.id, entity: "session", entity_id: null,
    action: result.ok ? "test_authorize_success" : "test_authorize_fail",
    meta: { mac, store_slug: storeSlug, result: result.ok ? "success" : result.error?.slice(0, 300), attempts: result.attempts },
  });

  return jsonResponse({
    ok: result.ok, attempts: result.attempts,
    error: result.ok ? undefined : result.error?.slice(0, 200),
    message: result.ok ? "MAC autorizado com sucesso" : "Falha na autorização",
  });
}

// ========== XML Export (Admin) ==========
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function handleAdminLeadsXml(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

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

  await db.from("audit_logs").insert({
    store_id: resolvedStoreId, entity: "lead", entity_id: null,
    action: "export_xml", meta: { scope, store_slug: storeSlug, from, to, count: rows.length },
  });

  return new Response(xml, {
    headers: { ...corsHeaders, "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` },
  });
}

// ========== Housekeeping (Admin manual) ==========
async function handleHousekeeping(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const cleaned = await internalHousekeeping(db);
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

  console.log("Cron housekeeping completed:", JSON.stringify(cleaned));
  return jsonResponse({ ok: true, cleaned });
}

// ========== Self-contained HTML Portal ==========
async function handlePortalHtml(req: Request, url: URL): Promise<Response> {
  // Deterministic redirect to the canonical React portal
  // Preserves all captive parameters for the SPA to pick up
  const target = new URL("https://minasbrasilwifi.com.br");
  url.searchParams.forEach((value, key) => {
    target.searchParams.set(key, value);
  });
  
  return Response.redirect(target.toString(), 302);
}

/**
 * Deterministic handler for OAuth callbacks (Google/Apple).
 * Ensures session parameters are passed back to the React SPA correctly.
 */
async function handleOAuthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL("https://minasbrasilwifi.com.br");
  
  // Pass through any tokens or codes in the URL (Supabase uses fragments or query params)
  url.searchParams.forEach((v, k) => target.searchParams.set(k, v));
  
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
  const eventName = sanitizeString(body.event, 64) || "client_event";
  const step = (sanitizeString(body.step, 32) || "client") as any;
  const status = (sanitizeString(body.status, 16) || "info") as any;
  const errorCode = sanitizeString(body.error_code, 64);
  const errorMessage = sanitizeString(body.error_message, 500);
  const traceId = sanitizeString(body.trace_id, 64) || getTraceId(req, body);

  // Light rate limit per session/ip — keep cheap, telemetry must not block flow
  const rl = await checkRateLimitDb(db, `client-event:${sessionId || clientIp}`, 60, 60, 60);
  if (!rl.allowed) return jsonResponse({ ok: true, throttled: true });

  let payload: unknown = null;
  try { payload = body.payload && typeof body.payload === "object" ? body.payload : null; } catch { payload = null; }

  logEvent(db, {
    session_id: sessionId,
    trace_id: traceId,
    event_type: `client_${eventName}`.slice(0, 64),
    step,
    status,
    error_code: errorCode || undefined,
    error_message: errorMessage || undefined,
    payload: payload as Record<string, unknown> | null,
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
    clientMac: normalizeMac(body.client_mac),
    apMac: normalizeMac(body.ap_mac),
    ssid: sanitizeString(body.ssid, 64),
    redirectUrl: sanitizeString(body.redirect_url, 500),
    captiveTimestamp: sanitizeString(body.captive_timestamp, 32),
  };
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
 * 1. Uses an atomic lock based on user_id + client_mac within a 15s window.
 * 2. If a session for this user/mac was authorized in the last 30s, returns it immediately.
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
}): Promise<{
  session_id: string | null;
  authorized: boolean;
  redirect_url: string;
  fail_reason?: string;
  store_slug: string;
  store_id: string | null;
}> {
  const { db, userId, profile, ctx, req, authMethod, traceId, clientIp, userAgent, attemptId } = args;


  const detected = await detectStoreFromRequest(db, req, ctx.apMac);
  const storeSlug = detected.store_slug;
  const storeId = detected.store_id;
  const nowIso = new Date().toISOString();
  const leaseOwner = `worker-${traceId || crypto.randomUUID()}`;

  // TRANSACTIONAL CLAIM (PROMPT 06)
  // Replacing pseudo-idempotency (30s window, rate_limit_hit lock, fail-open)
  // with a server-authoritative transactional claim.
  if (!attemptId) {
    // Legacy support or direct signup/login path without attempt_id should ideally have one,
    // but we allow it for now if not explicitly blocked.
    // However, Prompt 06 requires attempt_id for everything that releases Wi-Fi.
    console.error(`[auth] AttemptId missing in authorizeAuthenticatedUser. Method: ${authMethod}`);
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
    p_lease_owner: leaseOwner
  });

  if (claimErr || !claimRes || claimRes.length === 0) {
    console.error("[auth] Claim RPC failed:", claimErr?.message);
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

  // RECOVERY LOGIC (PROMPT 30)
  if (claim.result_status === 'recovery_required') {
    console.warn(`[auth] Recovery required for attempt ${attemptId}. Checking UniFi state...`);
    
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
        Deno.env.get("UNIFI_PASSWORD")
      );

      if (check.state === 'authorized') {
        console.log(`[auth] Recovery successful: MAC ${macToCheck} is already authorized in UniFi.`);
        const finalRedirect = detected.redirect_url || DEFAULT_REDIRECT_URL;
        await db.rpc("finalize_auth_attempt", {
          p_attempt_id: attemptId,
          p_lease_owner: leaseOwner,
          p_session_id: claim.session_id,
          p_authorized: true,
          p_redirect_url: finalRedirect,
          p_fail_reason: null,
          p_result_code: "RECOVERED_ALREADY_AUTHORIZED"
        });
        return {
          session_id: claim.session_id,
          authorized: true,
          redirect_url: finalRedirect,
          store_slug: storeSlug,
          store_id: storeId,
        };
      } else if (check.state === 'not_authorized') {
        console.log(`[auth] Recovery: MAC ${macToCheck} NOT authorized. Releasing for retry.`);
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
    console.log(`[auth] Replay detected for attempt ${attemptId}. Reusing session ${claim.session_id}`);
    return {
      session_id: claim.session_id,
      authorized: claim.authorized,
      redirect_url: claim.redirect_url || (detected.redirect_url || DEFAULT_REDIRECT_URL),
      store_slug: storeSlug,
      store_id: storeId,
    };
  }

  if (claim.result_status === 'processing') {
    console.log(`[auth] Concurrent request active for attempt ${attemptId}.`);
    return {
      session_id: claim.session_id,
      authorized: false,
      redirect_url: detected.redirect_url || DEFAULT_REDIRECT_URL,
      fail_reason: "PROCESSING_IN_PROGRESS",
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
      console.error("[auth] captive_sessions insert failed:", sErr?.message);
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

  // Upsert lead by user_id
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
      await db.from("leads").insert({ ...leadPayload, first_seen_at: nowIso, consent_version: "1.0" });
    }
  } catch (e) {
    console.warn("[auth] lead upsert failed:", (e as Error).message);
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

  const authResult = await authorizeClient(
    db, storeId, storeSlug, ctx.clientMac, sessionId, clientIp || "",
    { apMac: ctx.apMac, ssid: ctx.ssid, fastReturn: false },
  );

  // FINALIZATION (PROMPT 06)
  const finalRedirect = detected.redirect_url || DEFAULT_REDIRECT_URL;
  await db.rpc("finalize_auth_attempt", {
    p_attempt_id: attemptId,
    p_lease_owner: leaseOwner,
    p_session_id: sessionId,
    p_authorized: !!authResult.ok,
    p_redirect_url: finalRedirect,
    p_fail_reason: authResult.ok ? null : (authResult.reason || "AUTHORIZE_FAILED"),
    p_result_code: authResult.ok ? "SUCCESS" : "UNIFI_ERROR"
  });

  return {
    session_id: sessionId,
    authorized: !!authResult.ok,
    redirect_url: finalRedirect,
    fail_reason: authResult.ok ? undefined : (authResult.reason || "AUTHORIZE_FAILED"),
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

/** Compute site base URL for building password-reset redirect */
function getSiteBaseUrl(req: Request): string {
  const origin = req.headers.get("origin") || req.headers.get("referer");
  if (origin) {
    try { const u = new URL(origin); return `${u.protocol}//${u.host}`; } catch { /* ignore */ }
  }
  try {
    const u = new URL(DEFAULT_REDIRECT_URL);
    // Prefer the wifi captive host if configured; otherwise use whatever's in the secret
    return `${u.protocol}//${u.host}`;
  } catch { /* ignore */ }
  return "https://minasbrasilwifi.com.br";
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

  const rl = await checkRateLimitDb(db, `pwreset:ip:${clientIp || "unknown"}:${email}`, 900, 3, 1800);
  if (!rl.allowed) {
    // Still respond with generic OK to avoid enumeration; log the throttle.
    logEvent(db, {
      trace_id: traceId, event_type: "password_reset_rate_limited", step: "form", status: "warning",
      payload: { email_masked: maskEmail(email) }, client_ip: clientIp, user_agent: ua,
    });
    return jsonResponse({ ok: true });
  }

  const siteBase = getSiteBaseUrl(req);
  const redirectTo = `${siteBase}/reset-password`;

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: resetErr } = await anonClient.auth.resetPasswordForEmail(email, { redirectTo });

  logEvent(db, {
    trace_id: traceId,
    event_type: resetErr ? "password_reset_failed" : "password_reset_requested",
    step: "form",
    status: resetErr ? "error" : "info",
    error_message: resetErr?.message,
    payload: { email_masked: maskEmail(email), redirect_to: redirectTo },
    client_ip: clientIp,
    user_agent: ua,
  });

  // Always respond OK to prevent account enumeration
  return jsonResponse({ ok: true });
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.slice(0, Math.min(2, local.length));
  return `${shown}${"*".repeat(Math.max(1, local.length - shown.length))}@${domain}`;
}

async function handleSignup(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const ua = req.headers.get("user-agent") || "";
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");
  const traceId = getTraceId(req, body);

  const name = sanitizeString(body.name, MAX_NAME_LEN);
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
    payload: { email }, client_ip: clientIp, user_agent: ua,
  });

  // Pre-check: CPF already registered? (only when CPF was provided)
  if (cpfDigits) {
    const { data: cpfExists } = await db
      .from("profiles").select("id").eq("cpf_digits", cpfDigits).limit(1).maybeSingle();
    if (cpfExists?.id) {
      logEvent(db, {
        trace_id: traceId, event_type: "signup_failed", step: "form", status: "error",
        error_code: "cpf_already_registered", payload: { email }, client_ip: clientIp,
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
      error_code: code, error_message: createErr?.message, payload: { email }, client_ip: clientIp,
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
    console.error("[signup] profile insert failed:", profErr.message);
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

  const ctx = extractAuthContext(body);
  const attemptId = typeof body.attempt_id === "string" ? body.attempt_id : null;
  const result = await authorizeAuthenticatedUser({
    db, userId, ctx, req, authMethod: "password", traceId, clientIp, userAgent: ua,
    profile: { full_name: name, cpf_digits: cpfDigits || null, phone_digits: phoneDigits || null, email },
    attemptId
  });


  logEvent(db, {
    session_id: result.session_id, trace_id: traceId, event_type: "signup_success",
    step: "form", status: "success", payload: { email, store_slug: result.store_slug }, client_ip: clientIp,
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
  if (!email || !isValidEmail(email) || !password) {
    return jsonResponse({ error: "E-mail ou senha inválidos.", code: "invalid_credentials" }, 400);
  }

  const rlIp = await checkRateLimitDb(db, `login:ip:${clientIp || "unknown"}`, 300, 20, 900);
  if (!rlIp.allowed) {
    return jsonResponse({ error: "Muitas tentativas. Aguarde alguns minutos.", code: "rate_limited" }, 429);
  }
  const rlEmail = await checkRateLimitDb(db, `login:email:${email}`, 300, 5, 900);
  if (!rlEmail.allowed) {
    return jsonResponse({ error: "Muitas tentativas para este e-mail. Aguarde.", code: "rate_limited" }, 429);
  }

  logEvent(db, { trace_id: traceId, event_type: "login_started", step: "form", status: "info", payload: { email }, client_ip: clientIp, user_agent: ua });

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: sessionData, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
  if (signInErr || !sessionData?.session || !sessionData?.user) {
    logEvent(db, {
      trace_id: traceId, event_type: "login_failed", step: "form", status: "error",
      error_code: "invalid_credentials", error_message: signInErr?.message, payload: { email }, client_ip: clientIp,
    });
    return jsonResponse({ error: "E-mail ou senha inválidos.", code: "invalid_credentials" }, 401);
  }

  const userId = sessionData.user.id;

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

  const ctx = extractAuthContext(body);
  const attemptId = typeof body.attempt_id === "string" ? body.attempt_id : null;
  const result = await authorizeAuthenticatedUser({
    db, userId, ctx, req, authMethod: "password", traceId, clientIp, userAgent: ua, profile,
    attemptId
  });


  logEvent(db, {
    session_id: result.session_id, trace_id: traceId, event_type: "login_success",
    step: "form", status: "success", payload: { email, store_slug: result.store_slug }, client_ip: clientIp,
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

  let ctx = extractAuthContext(body);
  
  // Authoritative Attempt Validation
  const attemptId = typeof body.attempt_id === "string" ? body.attempt_id : null;
  const resumeToken = typeof body.resume_token === "string" ? body.resume_token : null;
  
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
  const provider = String((userRes.user.app_metadata as any)?.provider || "").toLowerCase();

  // FOR GOOGLE: attempt_id and resume_token are MANDATORY.
  if (provider === "google") {
    if (!attemptId || !resumeToken) {
      console.error(`[auth] Google login without authoritative tokens. User: ${userId}`);
      return jsonResponse({ error: "Transação de login inválida ou incompleta.", code: "missing_attempt_tokens" }, 403);
    }
  }

  if (attemptId && resumeToken) {
    const val = await validateOAuthAttempt(db, attemptId, resumeToken);
    
    if (val.status === 'invalid') {
      return jsonResponse({ error: val.error || "Tentativa inválida.", code: "invalid_attempt" }, 403);
    }
    
    // Protection against user_id swap
    if (val.attempt.user_id && val.attempt.user_id !== userId) {
      console.error(`[auth] Attempt ${attemptId} already linked to another user`);
      return jsonResponse({ error: "Esta tentativa pertence a outro usuário.", code: "forbidden_attempt" }, 403);
    }

    // handleAuthorizeExisting must support Replay (Prompt 31)
    if (val.status === 'completed') {
      console.log(`[auth] Replay detected for completed attempt ${attemptId}. Reusing persisted result.`);
      
      const { data: sess } = await db.from("captive_sessions")
        .select("id, status")
        .eq("attempt_id", attemptId)
        .maybeSingle();
      
      const storeRes = await detectStoreFromRequest(db, req, val.params?.apMac);

      return jsonResponse({
        session_id: sess?.id || null,
        authorized: true,
        redirect_url: val.attempt.redirect_url || storeRes.redirect_url || DEFAULT_REDIRECT_URL,
        store_slug: storeRes.store_slug,
        store_id: storeRes.store_id,
        auth_method,
        trace_id: traceId,
        replay: true
      });
    }

    // Overwrite context with authoritative parameters from server
    if (val.params) {
      ctx = val.params;
      console.log(`[auth] using authoritative parameters for attempt=${attemptId} mac=${ctx.clientMac}`);
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
      console.error("[authorize-existing] profile auto-create failed:", insErr.message);
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
      payload: { provider, email: emailValue }, client_ip: clientIp,
    });
  }

  // Determine auth method purely from server data (getUser provider)
  const authMethod: "silent" | "google" | "apple" =
    provider === "google" ? "google" :
    provider === "apple" ? "apple" :
    "silent";

  // Check if CPF is required before UniFi authorization
  if (authMethod === "google") {
    const isCpfPending = !profile?.cpf_digits || (profile as any)?.cpf_required === true;
    if (isCpfPending) {
      logEvent(db, {
        trace_id: traceId, event_type: "google_auth_cpf_pending", step: "form", status: "info",
        payload: { email: profile?.email, mac: ctx.clientMac, attempt_id: attemptId }, client_ip: clientIp,
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
    attemptId
  });

  // Authorization results are now handled by finalize_auth_attempt inside authorizeAuthenticatedUser
  // The terminal state update here is redundant but we preserve trace if needed.



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
        console.warn("[authorize-existing] CRM sync failed (bg):", (e as Error).message);
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

  const cpfDigits = typeof body.cpf === "string" ? body.cpf.replace(/\D/g, "") : null;
  const phoneDigits = typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : null;
  const name = typeof body.name === "string" ? sanitizeString(body.name, MAX_NAME_LEN) : null;

  const updatePayload: Record<string, any> = {};
  if (cpfDigits) {
    if (!isValidCPF(cpfDigits)) return errorResponse("CPF inválido.");
    updatePayload.cpf_digits = cpfDigits;
    updatePayload.cpf_required = false;
  }
  if (phoneDigits) {
    if (!isValidPhone(phoneDigits)) return errorResponse("Telefone inválido.");
    updatePayload.phone_digits = phoneDigits;
  }
  if (name) updatePayload.full_name = name;

  if (Object.keys(updatePayload).length === 0) return jsonResponse({ ok: true });

  const { data: userProfile } = await db.from("profiles").select("email").eq("id", userId).maybeSingle();

  // Use the secure RPC instead of direct update to enforce constraints and logic
  const { data: rpcRes, error: rpcErr } = await db.rpc("secure_update_profile", {
    _user_id: userId,
    _full_name: name,
    _phone_digits: phoneDigits,
    _cpf_digits: cpfDigits,
  });

  if (rpcErr || !rpcRes?.ok) {
    if (rpcRes?.error === "CPF_ALREADY_EXISTS") {
      return errorResponse("Este CPF já está cadastrado em outra conta.", 409);
    }
    console.error("[update-profile] RPC failed:", rpcErr || rpcRes?.error);
    return errorResponse("Erro ao atualizar perfil.");
  }

  // Background sync with CRM on profile update
  if (cpfDigits && name && phoneDigits) {
    const bgSync = (async () => {
      try {
        await syncWithClubeMais({
          cpf: cpfDigits,
          name: name,
          phone: phoneDigits,
          email: userProfile?.email || null,
        }, db, traceId);
      } catch (e) {
        console.warn("[update-profile] ClubeMais sync failed (bg):", (e as Error).message);
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
    payload: { fields: Object.keys(updatePayload) }, client_ip: clientIp, user_agent: ua,
  });

  return jsonResponse({ ok: true });
}

// ========== Main Router ==========


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
    if (path === "/health" || path === "/ready") return jsonResponse({ status: "ok" });

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

    if (path === "/oauth/callback") return await handleOAuthCallback(req);
    if (path === "/update-profile" && req.method === "POST") return await handleUpdateProfile(req);
    if (path === "/signup" && req.method === "POST") return await handleSignup(req);
    if (path === "/request-password-reset" && req.method === "POST") return await handleRequestPasswordReset(req);
    if (path === "/authorize-existing" && req.method === "POST") return await handleAuthorizeExisting(req);

    // 3. Admin endpoints (requires service_role/admin auth)
    if (path === "/admin/settings") return await handleAdminSettings(req);
    if (path === "/admin/stores") return await handleAdminStores(req);
    if (path === "/admin/store-ips") return await handleAdminStoreIps(req, url);
    if (path === "/admin/access-points") return await handleAdminAccessPoints(req, url);
    if (path === "/admin/leads-xml" && req.method === "GET") return await handleAdminLeadsXml(req, url);
    if (path === "/admin/leads") return await handleAdminLeads(req, url);
    if (path === "/admin/consent") return await handleAdminConsent(req);
    if (path === "/admin/sessions") return await handleAdminSessions(req, url);
    if (path === "/admin/clusters") return await handleAdminClusters(req, url);
    if (path === "/admin/test-authorize" && req.method === "POST") return await handleTestAuthorize(req);
    if (path === "/admin/test-unifi-reach" && req.method === "POST") return await handleTestUnifiReach(req);
    if (path === "/admin/housekeeping" && req.method === "POST") return await handleHousekeeping(req);

    // 4. System endpoints
    if (path === "/cron/housekeeping" && req.method === "POST") return await handleCronHousekeeping(req);

    return errorResponse("Not found", 404);
  } catch (err) {
    console.error("Unhandled error:", err);
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
  const encoder = new TextEncoder();
  const tokenData = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", tokenData);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const tokenHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

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

  // Interpretation of status (Prompt 31)
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
  };

  return { status, params, attempt };
}

async function handleOAuthInit(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const clientIp = getPublicIp(req);
  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON");

  const rawParams = (body.params || {}) as Record<string, string>;
  const clientMac = normalizeMac(rawParams.id || rawParams.mac);
  
  if (!clientMac) {
    return errorResponse("Endereço MAC do dispositivo não identificado.");
  }

  // Rate limit by IP/MAC
  const rl = await checkRateLimitDb(db, `oauth-init:mac:${clientMac}`, 60, 5, 300);
  if (!rl.allowed) return errorResponse("Muitas tentativas. Aguarde alguns minutos.", 429);


  // Cryptographically strong random token (opaque)
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Hash it for DB storage
  const encoder = new TextEncoder();
  const tokenData = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", tokenData);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const tokenHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

  const { data: attempt, error: insErr } = await db
    .from("captive_auth_attempts")
    .insert({
      resume_token_hash: tokenHash,
      client_mac: clientMac,
      ap_mac: normalizeMac(rawParams.ap),
      ssid: sanitizeString(rawParams.ssid, 64),
      store_hint: sanitizeString(rawParams.store, 64),
      captive_timestamp: sanitizeString(rawParams.t, 32),
      original_url: sanitizeString(body.original_url, 500),
      expires_at: expiresAt.toISOString(),
      status: 'created',
      metadata: { client_ip: clientIp }
    })
    .select("id")
    .single();

  if (insErr || !attempt?.id) {
    console.error("[oauth-init] insert failed:", insErr?.message);
    return errorResponse("Erro ao inicializar transação de login.", 500);
  }

  return jsonResponse({
    attempt_id: attempt.id,
    token: token
  });
}

async function handleOAuthRestart(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const body = await safeParseJson(req);
  if (!body || !body.attempt_id) return errorResponse("Missing attempt_id");

  const attemptId = body.attempt_id as string;
  const { data: oldAttempt } = await db
    .from("captive_auth_attempts")
    .select("*")
    .eq("id", attemptId)
    .maybeSingle();

  if (oldAttempt) {
    // Cancel old one
    await db.from("captive_auth_attempts")
      .update({ status: 'cancelled' })
      .eq("id", attemptId);

    // Create new one with same params
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(token));
    const tokenHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    const { data: newAttempt } = await db
      .from("captive_auth_attempts")
      .insert({
        resume_token_hash: tokenHash,
        client_mac: oldAttempt.client_mac,
        ap_mac: oldAttempt.ap_mac,
        ssid: oldAttempt.ssid,
        store_hint: oldAttempt.store_hint,
        captive_timestamp: oldAttempt.captive_timestamp,
        original_url: oldAttempt.original_url,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        status: 'created'
      })
      .select("id")
      .single();

    if (newAttempt) {
      return jsonResponse({ attempt_id: newAttempt.id, token });
    }
  }

  return errorResponse("Não foi possível reiniciar a sessão.", 500);
}

