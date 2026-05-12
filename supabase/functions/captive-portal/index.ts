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

// OTP config
const OTP_PEPPER = Deno.env.get("OTP_PEPPER") || "default-pepper-change-me";
const OTP_EXPIRES_SECONDS = parseInt(Deno.env.get("OTP_EXPIRES_SECONDS") || "300");
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_RESENDS = 3;
const OTP_RESEND_COOLDOWN_SEC = 60;

// Cron secret for scheduled housekeeping
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

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

function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
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
async function upsertCaptiveSession(
  db: ReturnType<typeof supabaseAdmin>,
  payload: Record<string, unknown>,
): Promise<{ error: { message: string; code?: string } | null }> {
  const { error } = await db
    .from("captive_sessions")
    .upsert(payload, { onConflict: "id", ignoreDuplicates: false });
  if (error) return { error: { message: error.message, code: (error as any).code } };
  return { error: null };
}

function isDuplicateKeyError(msg?: string | null): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return m.includes("duplicate key") || m.includes("23505");
}

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
  step: "params" | "form" | "otp" | "unifi" | "redirect" | "system";
  status?: "info" | "success" | "warning" | "error";
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
      () => {},
      (e) => console.warn("[logEvent] session patch failed:", (e as Error)?.message),
    );
  }
}

// ========== Detect Store (slug param > IP > single active fallback) ==========
async function detectStoreFromRequest(
  db: ReturnType<typeof supabaseAdmin>,
  req: Request
): Promise<{ store_id: string | null; store_slug: string; redirect_url: string | null; store_name: string; store_city: string | null }> {

  const fallback = {
    store_id: null as string | null,
    store_slug: "geral",
    redirect_url: null as string | null,
    store_name: "Wi-Fi Drogaria Minas Brasil",
    store_city: null as string | null,
  };

  const storeResult = (s: { id: string; slug: string; name: string; city: string | null; post_auth_redirect_url: string | null }) => ({
    store_id: s.id,
    store_slug: s.slug,
    redirect_url: s.post_auth_redirect_url || null,
    store_name: s.name,
    store_city: s.city,
  });

  // 1) Check ?store=slug query param (passed by UniFi redirect URL)
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
        return storeResult(store);
      }
      console.warn(`Store slug "${storeSlug}" from URL not found or inactive`);
    }
  } catch { /* ignore URL parse errors */ }

  // 2) Check IP mapping (existing logic)
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
        return storeResult(store);
      }
    }
  }

  // 3) Fallback: if exactly one active store exists, use it
  const { data: activeStores } = await db
    .from("stores")
    .select("id, slug, name, city, post_auth_redirect_url")
    .eq("is_active", true)
    .limit(2);

  if (activeStores && activeStores.length === 1) {
    const store = activeStores[0];
    console.log(`Store detected via single-active fallback: ${store.slug}`);
    return storeResult(store);
  }

  console.warn(`No store detected (IP: ${ip || "unknown"}, active stores: ${activeStores?.length || 0})`);
  return fallback;
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

// ========== OTP Helpers ==========
function generateOtpCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, "0");
}

async function hashOtp(code: string): Promise<string> {
  const data = new TextEncoder().encode(code + OTP_PEPPER);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

async function sendWhatsAppCode(
  db: ReturnType<typeof supabaseAdmin>,
  storeId: string | null,
  phone: string,
  code: string,
  storeName: string,
  sessionId: string | null,
  clientIp: string | null,
  expiresAt: string
): Promise<{ sent: boolean; error?: string }> {
  const config = await getWhatsappConfig(db, storeId);
  if (!config) {
    console.warn("WhatsApp webhook not configured");
    return { sent: false, error: "Webhook WhatsApp não configurado." };
  }

  // Internal hard timeout so the webhook can never hang the function.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.secret) {
      headers["Authorization"] = `Bearer ${config.secret}`;
    }

    const phoneE164 = toE164BR(phone);
    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        phone: phoneE164,
        phone_raw: phone,
        code,
        store_name: storeName,
        store_id: storeId,
        session_id: sessionId,
        public_ip: clientIp,
        expires_at: expiresAt,
        type: "otp_verification",
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.error("WhatsApp webhook HTTP error:", res.status);
      return { sent: false, error: `Webhook retornou HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    clearTimeout(timer);
    const isAbort = (e as Error).name === "AbortError";
    console.error("WhatsApp webhook error:", isAbort ? "timeout (8s)" : (e as Error).message);
    return { sent: false, error: isAbort ? "Timeout ao enviar código." : "Erro de rede ao enviar código." };
  }
}

// ========== UniFi Provider (Legacy Cookie Auth) ==========
const UNIFI_USERNAME = Deno.env.get("UNIFI_USERNAME") || "";
const UNIFI_PASSWORD = Deno.env.get("UNIFI_PASSWORD") || "";
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

  try {
    // Step 1: Fresh login
    let login = await unifiLogin(baseUrl, httpClient, username, password);
    if (!login.ok) return { ok: false, reason: "UNIFI_LOGIN_FAILED", error: `UniFi login failed: ${login.error}` };
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
      // Couldn't find any candidate. Try anyway with portal MAC, but flag ambiguity if multiple were close.
      if (pick.candidateCount > 1) {
        console.warn(`[unifi-auth] reason=MAC_RANDOMIZATION_AMBIGUOUS candidates=${pick.candidateCount} ap=${apMacForPayload || "?"}`);
        return {
          ok: false,
          reason: "MAC_RANDOMIZATION_AMBIGUOUS",
          error: "Múltiplos dispositivos não autorizados detectados. Desative 'Endereço Wi-Fi privado' nas configurações do celular e tente novamente.",
          latency_ms: Date.now() - startedAt,
        };
      }
      // candidateCount === 0 → station list might be stale; proceed with portal MAC
    }

    // Auto-discover ap_mac if missing (causa #12)
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
          // Logical failure — possible site policy rejection (causa #9)
          lastError = `rc!=ok msg=${cmd.rcMsg || "none"}`;
          if (!policyOverride && /authoriz|reject|policy|limit|timeout/i.test(cmd.rcMsg || "")) {
            return false; // signal caller to retry with safe minutes
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
      // Retry once with safe 15 minutes (causa #9)
      console.warn(`[unifi-auth] reason=SITE_POLICY_OVERRIDE retrying with minutes=15 (was ${usedMinutes}, error=${lastError})`);
      policyOverride = true;
      usedMinutes = 15;
      accepted = await sendOnce(usedMinutes);
    }
    if (!accepted) {
      return { ok: false, reason: "UNIFI_CMD_REJECTED", error: lastError || "command rejected", latency_ms: Date.now() - startedAt };
    }

    // Step 4: Polling with backoff + re-emission (causa #7)
    const staUrl = activeUrl.replace("/cmd/stamgr", "/stat/sta");
    let confirmed = false;
    let verifyError = "controller did not confirm authorized client";
    let weakSignal = false;
    let lastVerifySnapshot: Record<string, unknown> = { mac: effectiveMac, found: false };

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
          // STRICT: only authorized=true is treated as confirmed liberation.
          // Having an IP / is_guest / recent assoc is NOT enough — captive
          // clients can satisfy those even while still blocked.
          if (found.authorized === true) {
            confirmed = true;
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
    httpClient?.close();
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
  context: { apMac?: string | null; ssid?: string | null } = {},
): Promise<{ ok: boolean; reason?: string; userMessage?: string; cmd_accepted_at?: string; last_verify_result?: Record<string, unknown> | null }> {
  if (!storeId) {
    await db.from("captive_sessions").update({ status: "failed", fail_reason: "NO_STORE_CONFIGURED" }).eq("id", sessionId);
    return { ok: false, reason: "NO_STORE_CONFIGURED" };
  }

  const { data: store } = await db
    .from("stores")
    .select("unifi_controller_url, unifi_site_id, unifi_username, unifi_password")
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

  const storeUser = store.unifi_username || UNIFI_USERNAME;
  const storePass = store.unifi_password || UNIFI_PASSWORD;

  if (!storeUser || !storePass) {
    await db.from("captive_sessions").update({ status: "failed", fail_reason: "UNIFI_CREDENTIALS_MISSING" }).eq("id", sessionId);
    return { ok: false, reason: "UNIFI_CREDENTIALS_MISSING" };
  }

  if (!clientMac || !isValidMac(clientMac)) {
    await db.from("captive_sessions").update({ status: "failed", fail_reason: "INVALID_MAC_ADDRESS" }).eq("id", sessionId);
    return { ok: false, reason: "INVALID_MAC_ADDRESS" };
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
    { apMac: context.apMac || null, ssid: context.ssid || null, minutes: desiredMinutes },
  );

  // Persist UniFi audit columns regardless of outcome
  const auditUpdate: Record<string, unknown> = {};
  if (result.cmd_accepted_at) auditUpdate.unifi_cmd_accepted_at = result.cmd_accepted_at;
  if (result.last_verify_result) auditUpdate.unifi_last_verify_result = result.last_verify_result;

  if (result.ok) {
    Object.assign(auditUpdate, {
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
      },
    });
    return { ok: true, cmd_accepted_at: result.cmd_accepted_at, last_verify_result: result.last_verify_result || null };
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
      email: { required: false },
      phone: { required: true },
      at_least_one_contact: true,
    },
  });
}

async function handleStart(req: Request): Promise<Response> {
  const t0 = Date.now();
  const clientIp = getPublicIp(req) || "unknown";
  const ua = req.headers.get("user-agent")?.slice(0, 500) || null;
  const db = supabaseAdmin();

  const rl = await checkRateLimitDb(db, `start:ip:${clientIp}`, 60, 100, 120);
  if (!rl.allowed) return errorResponse("Muitas requisições. Aguarde um momento.", 429);

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  const traceId = getTraceId(req, body);
  const detected = await detectStoreFromRequest(db, req);

  const mac = normalizeMac(body.client_mac);
  const apMac = normalizeMac(body.ap_mac);
  const captiveTimestamp = sanitizeString(body.captive_timestamp, 32);
  const originalUnifiParams = (body.original_unifi_url_params && typeof body.original_unifi_url_params === "object")
    ? body.original_unifi_url_params
    : null;

  const reqUrl = new URL(req.url);
  console.log(`[portal-params] trace=${traceId} id=${mac} ap=${apMac} ssid=${body.ssid} url=${body.redirect_url} t=${captiveTimestamp} site=${body.site}`);

  // Log params reception (no session yet)
  logEvent(db, {
    trace_id: traceId, store_id: detected.store_id,
    event_type: "params_received", step: "params", status: "info",
    payload: {
      raw: Object.fromEntries(reqUrl.searchParams),
      normalized: { client_mac: mac, ap_mac: apMac, ssid: body.ssid, captive_timestamp: captiveTimestamp, site: body.site },
      original_unifi_url_params: originalUnifiParams,
      store_slug: detected.store_slug,
    },
    client_ip: clientIp, user_agent: ua,
  });

  // Allow the frontend to supply a session_id (UUID generated client-side)
  // so /start and /submit can converge on the same row.
  const suppliedSessionId = isValidUUID(body.session_id) ? (body.session_id as string) : null;

  const paramFields: Record<string, unknown> = {
    client_mac: mac,
    ap_mac: apMac,
    ssid: sanitizeString(body.ssid, 64),
    user_agent: sanitizeString(body.user_agent, 500) || ua,
    redirect_url: sanitizeString(body.redirect_url, 2000),
    captive_timestamp: captiveTimestamp,
    original_unifi_url_params: originalUnifiParams,
    trace_id: traceId,
    params_received_at: new Date().toISOString(),
    last_step: "params",
    client_ip: sanitizeString(body.client_ip, 45) || clientIp,
  };

  logEvent(db, {
    session_id: suppliedSessionId, trace_id: traceId, store_id: detected.store_id,
    event_type: "session_upsert_started", step: "params", status: "info",
    client_ip: clientIp, user_agent: ua,
  });

  if (suppliedSessionId) {
    // Check if already exists; if so, only update parameter fields and don't
    // overwrite advanced fields (status, submitted_at, authorized_at, ...).
    const { data: existing } = await db
      .from("captive_sessions")
      .select("id, status, submitted_at, authorized_at")
      .eq("id", suppliedSessionId)
      .maybeSingle();

    if (existing) {
      const { error: upErr } = await db
        .from("captive_sessions")
        .update(paramFields)
        .eq("id", suppliedSessionId);
      if (upErr) {
        logEvent(db, {
          session_id: suppliedSessionId, trace_id: traceId, store_id: detected.store_id,
          event_type: "session_upsert_failed", step: "params", status: "error",
          error_code: "SESSION_UPDATE_ERROR", error_message: upErr.message,
          latency_ms: Date.now() - t0, client_ip: clientIp, user_agent: ua,
        });
      } else {
        logEvent(db, {
          session_id: suppliedSessionId, trace_id: traceId, store_id: detected.store_id,
          event_type: "session_upsert_success", step: "params", status: "success",
          payload: { recovered: true },
          latency_ms: Date.now() - t0, client_ip: clientIp, user_agent: ua,
        });
      }
      return jsonResponse({ session_id: suppliedSessionId, trace_id: traceId, recovered: true });
    }

    // Doesn't exist yet — try idempotent upsert (handles race with /submit).
    const insertPayload = {
      id: suppliedSessionId,
      store_id: detected.store_id,
      status: "started",
      ...paramFields,
    };
    const { error: upsertErr } = await upsertCaptiveSession(db, insertPayload);
    if (upsertErr) {
      const code = isDuplicateKeyError(upsertErr.message) ? "SESSION_DUPLICATE_RACE" : "SESSION_UPSERT_ERROR";
      logEvent(db, {
        session_id: suppliedSessionId, trace_id: traceId, store_id: detected.store_id,
        event_type: "session_upsert_failed", step: "params", status: "error",
        error_code: code, error_message: upsertErr.message,
        latency_ms: Date.now() - t0, client_ip: clientIp, user_agent: ua,
      });
      // Still return the supplied id — /submit will be the source of truth.
      return jsonResponse({ session_id: suppliedSessionId, trace_id: traceId, recovered: code === "SESSION_DUPLICATE_RACE" });
    }
    logEvent(db, {
      session_id: suppliedSessionId, trace_id: traceId, store_id: detected.store_id,
      event_type: "session_upsert_success", step: "params", status: "success",
      payload: { created: true, store_slug: detected.store_slug },
      latency_ms: Date.now() - t0, client_ip: clientIp, user_agent: ua,
    });
    await db.from("audit_logs").insert({
      store_id: detected.store_id, entity: "session", entity_id: suppliedSessionId,
      action: "create", meta: { client_mac: mac, ip: clientIp, store_slug: detected.store_slug, trace_id: traceId },
    });
    return jsonResponse({ session_id: suppliedSessionId, trace_id: traceId });
  }

  // No supplied id — let DB generate one (legacy path).
  const insertPayload: Record<string, unknown> = {
    store_id: detected.store_id,
    status: "started",
    ...paramFields,
  };
  const { data: session, error } = await db
    .from("captive_sessions")
    .insert(insertPayload)
    .select("id")
    .single();

  if (error) {
    console.error("Session insert error:", error.message);
    logEvent(db, {
      trace_id: traceId, store_id: detected.store_id,
      event_type: "session_upsert_failed", step: "params", status: "error",
      error_code: "SESSION_INSERT_ERROR", error_message: error.message,
      latency_ms: Date.now() - t0, client_ip: clientIp, user_agent: ua,
    });
    return errorResponse("Erro ao iniciar sessão", 500);
  }

  logEvent(db, {
    session_id: session.id, trace_id: traceId, store_id: detected.store_id,
    event_type: "session_upsert_success", step: "params", status: "success",
    latency_ms: Date.now() - t0,
    payload: { client_mac: mac, ap_mac: apMac, ssid: body.ssid, store_slug: detected.store_slug },
    client_ip: clientIp, user_agent: ua,
  });

  await db.from("audit_logs").insert({
    store_id: detected.store_id, entity: "session", entity_id: session.id,
    action: "create", meta: { client_mac: mac, ip: clientIp, store_slug: detected.store_slug, trace_id: traceId },
  });

  return jsonResponse({ session_id: session.id, trace_id: traceId });
}

async function handleSubmit(req: Request): Promise<Response> {
  const t0 = Date.now();
  const clientIp = getPublicIp(req);
  const clientIpStr = clientIp || "unknown";
  const ua = req.headers.get("user-agent")?.slice(0, 500) || null;
  const db = supabaseAdmin();

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  const traceId = getTraceId(req, body);

  const name = sanitizeString(body.name, MAX_NAME_LEN);
  const email = sanitizeString(body.email, MAX_EMAIL_LEN);
  const phone = sanitizeString(body.phone, MAX_PHONE_LEN);
  const cpf = sanitizeString(body.cpf, 20);
  const consentVersion = sanitizeString(body.consent_version, 20);
  let sessionId = body.session_id as string | undefined;

  // Validation with structured logging
  const failValidation = (code: string, msg: string) => {
    logEvent(db, {
      session_id: sessionId && isValidUUID(sessionId) ? sessionId : null,
      trace_id: traceId,
      event_type: "form_validation_failed", step: "form", status: "error",
      error_code: code, error_message: msg,
      payload: {
        missing: {
          name: !name, phone: !phone, cpf: !cpf, consent_version: !consentVersion,
          email_invalid: !!(email && !isValidEmail(email)),
          session_id_invalid: !!(sessionId && !isValidUUID(sessionId)),
          phone_invalid: !!(phone && !isValidPhone(phone)),
        },
        has_name: !!name,
        phone_length: phone ? phone.replace(/\D/g, "").length : 0,
        cpf_length: cpf ? cpf.replace(/\D/g, "").length : 0,
        has_email: !!email,
        consent_version: consentVersion,
      },
      client_ip: clientIp, user_agent: ua,
    });
    return jsonResponse({ error: msg, code: "VALIDATION_ERROR", validation_code: code }, 400);
  };

  if (!name) return failValidation("NAME_REQUIRED", "Nome é obrigatório");
  if (!cpf) return failValidation("CPF_REQUIRED", "CPF é obrigatório");
  if (!phone || !isValidPhone(phone)) return failValidation("PHONE_INVALID", "Telefone válido é obrigatório");
  if (email && !isValidEmail(email)) return failValidation("EMAIL_INVALID", "E-mail inválido");
  if (!consentVersion) return failValidation("CONSENT_REQUIRED", "Consentimento é obrigatório");
  if (sessionId && !isValidUUID(sessionId)) return failValidation("SESSION_ID_INVALID", "session_id inválido");

  const clientMac = normalizeMac(body.client_mac);

  console.log(`[submit] trace=${traceId} session=${sessionId || "none"} mac=${clientMac || "none"} ip=${clientIpStr}`);

  // Detect store: ?store=slug > IP mapping > single active store
  const detected = await detectStoreFromRequest(db, req);
  const storeId = detected.store_id;
  const storeSlug = detected.store_slug;
  const redirectUrl = detected.redirect_url;

  const submitCaptiveTs = sanitizeString(body.captive_timestamp, 32);
  const submitUnifiParams = (body.original_unifi_url_params && typeof body.original_unifi_url_params === "object")
    ? body.original_unifi_url_params
    : null;
  console.log(`[portal-params] (submit) id=${clientMac} ap=${normalizeMac(body.ap_mac)} ssid=${body.ssid} url=${body.redirect_url} t=${submitCaptiveTs}`);

  // Captive assistants can lose API responses. /submit is therefore the source
  // of truth: if the frontend supplied a UUID, guarantee that session exists
  // via idempotent upsert (avoids races with the background /start).
  logEvent(db, {
    session_id: sessionId && isValidUUID(sessionId) ? sessionId : null,
    trace_id: traceId, store_id: storeId,
    event_type: "submit_session_upsert_started", step: "form", status: "info",
    client_ip: clientIp, user_agent: ua,
  });

  const submitParamFields: Record<string, unknown> = {
    store_id: storeId,
    client_mac: clientMac,
    client_ip: clientIpStr,
    ap_mac: normalizeMac(body.ap_mac),
    ssid: sanitizeString(body.ssid, 64),
    user_agent: sanitizeString(body.user_agent, 500) || ua,
    redirect_url: sanitizeString(body.redirect_url, 2000),
    captive_timestamp: submitCaptiveTs,
    original_unifi_url_params: submitUnifiParams,
    trace_id: traceId,
    last_step: "form",
  };

  if (sessionId) {
    // Idempotent upsert by id. Don't overwrite advanced fields if a row
    // already exists (status, submitted_at, authorized_at).
    const { data: existingSession } = await db
      .from("captive_sessions")
      .select("id, status, submitted_at, authorized_at")
      .eq("id", sessionId)
      .maybeSingle();

    if (existingSession) {
      // Backfill only safe fields; never downgrade status/timeline.
      const updateFields: Record<string, unknown> = { trace_id: traceId, last_step: "form" };
      if (clientMac) updateFields.client_mac = clientMac;
      const apMacNorm = normalizeMac(body.ap_mac);
      if (apMacNorm) updateFields.ap_mac = apMacNorm;
      if (body.ssid) updateFields.ssid = sanitizeString(body.ssid, 64);
      if (body.redirect_url) updateFields.redirect_url = sanitizeString(body.redirect_url, 2000);
      if (submitCaptiveTs) updateFields.captive_timestamp = submitCaptiveTs;
      if (submitUnifiParams) updateFields.original_unifi_url_params = submitUnifiParams;
      const { error: upErr } = await db.from("captive_sessions").update(updateFields).eq("id", sessionId);
      if (upErr) {
        logEvent(db, {
          session_id: sessionId, trace_id: traceId, store_id: storeId,
          event_type: "submit_session_upsert_failed", step: "form", status: "warning",
          error_code: "SUPPLIED_UPDATE_ERROR", error_message: upErr.message,
          client_ip: clientIp, user_agent: ua,
        });
      } else {
        logEvent(db, {
          session_id: sessionId, trace_id: traceId, store_id: storeId,
          event_type: "submit_session_upsert_success", step: "form", status: "success",
          payload: { recovered: true }, client_ip: clientIp, user_agent: ua,
        });
      }
    } else {
      const insertPayload = {
        id: sessionId,
        status: "started",
        params_received_at: new Date().toISOString(),
        ...submitParamFields,
      };
      const { error: upsertErr } = await upsertCaptiveSession(db, insertPayload);
      if (upsertErr) {
        const isRace = isDuplicateKeyError(upsertErr.message);
        const code = isRace ? "SESSION_DUPLICATE_RACE" : "SUPPLIED_UPSERT_ERROR";
        logEvent(db, {
          session_id: sessionId, trace_id: traceId, store_id: storeId,
          event_type: "submit_session_upsert_failed", step: "form", status: isRace ? "warning" : "error",
          error_code: code, error_message: upsertErr.message,
          client_ip: clientIp, user_agent: ua,
        });
        if (!isRace) return jsonResponse({ error: "Erro ao iniciar sessão. Tente novamente.", code: "SESSION_UPSERT_ERROR" }, 500);
        // On race, the row exists thanks to /start — proceed.
      } else {
        logEvent(db, {
          session_id: sessionId, trace_id: traceId, store_id: storeId,
          event_type: "submit_session_upsert_success", step: "form", status: "success",
          payload: { created: true }, client_ip: clientIp, user_agent: ua,
        });
      }
      console.log(`[submit] upserted supplied session=${sessionId}`);
    }
  } else {
    const { data: recoveredSession, error: sessionError } = await db
      .from("captive_sessions")
      .insert({
        status: "started",
        params_received_at: new Date().toISOString(),
        ...submitParamFields,
      })
      .select("id")
      .single();
    if (sessionError || !recoveredSession?.id) {
      console.error("[submit] Recovery session insert error:", sessionError?.message);
      logEvent(db, {
        trace_id: traceId, store_id: storeId,
        event_type: "submit_session_upsert_failed", step: "form", status: "error",
        error_code: "RECOVERY_INSERT_ERROR", error_message: sessionError?.message || "unknown",
        client_ip: clientIp, user_agent: ua,
      });
      return jsonResponse({ error: "Erro ao iniciar sessão. Tente novamente.", code: "SESSION_UPSERT_ERROR" }, 500);
    }
    sessionId = recoveredSession.id;
    logEvent(db, {
      session_id: sessionId, trace_id: traceId, store_id: storeId,
      event_type: "submit_session_upsert_success", step: "form", status: "success",
      payload: { created_no_id: true }, client_ip: clientIp, user_agent: ua,
    });
    console.log(`[submit] recovered missing session=${sessionId}`);
  }

  // Log form_submitted (after session is guaranteed)
  logEvent(db, {
    session_id: sessionId, trace_id: traceId, store_id: storeId,
    event_type: "form_submitted", step: "form", status: "success",
    payload: { has_email: !!email, has_cpf: !!cpf, phone_masked: phone?.replace(/^(\d{2})\d+(\d{2})$/, "$1***$2"), client_mac: clientMac, ap_mac: normalizeMac(body.ap_mac), ssid: body.ssid, store_slug: storeSlug, captive_timestamp: submitCaptiveTs },
    session_patch: { form_submitted_at: new Date().toISOString() },
    client_ip: clientIp, user_agent: ua,
  });

  // Idempotent recovery: if this session already has a pending verification,
  // return immediately so retries don't pile up. Cheap single query.
  const { data: existingVer } = await db
    .from("captive_verifications")
    .select("id, expires_at")
    .eq("session_id", sessionId as string)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingVer && new Date(existingVer.expires_at) > new Date()) {
    console.log(`[submit] recovered existing pending verification session=${sessionId} (${Date.now() - t0}ms)`);
    logEvent(db, {
      session_id: sessionId, trace_id: traceId, store_id: storeId,
      event_type: "otp_already_pending", step: "otp", status: "info",
      latency_ms: Date.now() - t0, client_ip: clientIp, user_agent: ua,
    });
    return jsonResponse({
      ok: true,
      session_id: sessionId,
      trace_id: traceId,
      authorized: false,
      redirect_url: redirectUrl || DEFAULT_REDIRECT_URL,
      requires_verification: true,
      recovered: true,
      message: "Código de verificação já enviado para seu WhatsApp.",
    });
  }

  // Generate OTP code FIRST so we can insert verification immediately.
  const otpCode = generateOtpCode();
  const otpHash = await hashOtp(otpCode);
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_SECONDS * 1000).toISOString();

  // Insert lead (minimum required fields). consent_text_hash, audit, geoip
  // are all enriched in background to keep the response fast for captive
  // portal clients on flaky walled-garden networks.
  const { data: lead, error: leadError } = await db.from("leads").insert({
    store_id: storeId,
    session_id: sessionId,
    name,
    email: email || null,
    phone: phone || null,
    cpf: cpf || null,
    client_mac: clientMac,
    consented_at: new Date().toISOString(),
    consent_version: consentVersion,
    source: "captive_portal",
    origin_ip: clientIp,
  }).select("id").single();

  if (leadError || !lead) {
    console.error("[submit] Lead insert error:", leadError?.message);
    logEvent(db, {
      session_id: sessionId, trace_id: traceId, store_id: storeId,
      event_type: "lead_insert_failed", step: "form", status: "error",
      error_code: "LEAD_INSERT_ERROR", error_message: leadError?.message || "unknown",
      client_ip: clientIp, user_agent: ua,
    });
    return jsonResponse({ error: "Erro ao salvar cadastro. Tente novamente.", code: "LEAD_INSERT_ERROR" }, 500);
  }
  const leadId = lead.id;

  // Insert verification (required to gate the OTP step).
  const { error: verError } = await db.from("captive_verifications").insert({
    store_id: storeId,
    session_id: sessionId,
    lead_id: leadId,
    phone,
    code_hash: otpHash,
    status: "pending",
    expires_at: expiresAt,
  });

  if (verError) {
    console.error("[submit] Verification insert error:", verError.message);
    logEvent(db, {
      session_id: sessionId, trace_id: traceId, store_id: storeId,
      event_type: "verification_insert_failed", step: "otp", status: "error",
      error_code: "VERIFICATION_INSERT_ERROR", error_message: verError.message,
      client_ip: clientIp, user_agent: ua,
    });
    return jsonResponse({ error: "Erro ao gerar código de verificação. Tente novamente.", code: "VERIFICATION_INSERT_ERROR" }, 500);
  }

  // Everything else runs in background — keep response fast.
  const storeName = detected.store_name || "Drogaria Minas Brasil";
  const bgWork = (async () => {
    try {
      // Update session status (non-essential for client)
      db.from("captive_sessions")
        .update({ status: "submitted", submitted_at: new Date().toISOString(), client_mac: clientMac })
        .eq("id", sessionId as string)
        .then(() => {}, () => {});

      // Send WhatsApp OTP (the critical background task).
      const otpStartedAt = Date.now();
      const r = await sendWhatsAppCode(db, storeId, phone, otpCode, storeName, sessionId as string | null, clientIp, expiresAt);
      const otpLatency = Date.now() - otpStartedAt;
      if (!r.sent) {
        console.warn("[submit] WhatsApp not sent (bg):", r.error);
        logEvent(db, {
          session_id: sessionId, trace_id: traceId, store_id: storeId,
          event_type: "otp_send_failed", step: "otp", status: "error",
          error_code: "WHATSAPP_SEND_FAILED", error_message: r.error || "unknown",
          latency_ms: otpLatency, client_ip: clientIp, user_agent: ua,
        });
      } else {
        console.log(`[submit] WhatsApp OTP sent session=${sessionId}`);
        logEvent(db, {
          session_id: sessionId, trace_id: traceId, store_id: storeId,
          event_type: "otp_sent", step: "otp", status: "success",
          latency_ms: otpLatency,
          payload: { phone_masked: phone?.replace(/^(\d{2})\d+(\d{2})$/, "$1***$2") },
          session_patch: { otp_sent_at: new Date().toISOString() },
          client_ip: clientIp, user_agent: ua,
        });
      }

      // Audit + GeoIP enrichment
      db.from("audit_logs").insert({
        store_id: storeId, entity: "lead", entity_id: leadId,
        action: "create",
        meta: { session_id: sessionId, mac: clientMac, ip: clientIpStr, store_slug: storeSlug, trace_id: traceId },
      }).then(() => {}, () => {});

      if (clientIp) {
        const geo = await enrichGeoIp(db, clientIp).catch(() => null);
        if (geo) {
          db.from("leads").update({
            origin_city: geo.city, origin_region: geo.region, origin_country: geo.country,
            origin_isp: geo.isp, origin_asn: geo.asn, origin_source: geo.source,
          }).eq("id", leadId).then(() => {}, () => {});
        }
        incrementClusterLeadCount(db, clientIp).catch(() => {});
      }
    } catch (e) {
      console.warn("[submit] background work failed:", (e as Error)?.message);
    }
  })();
  // @ts-ignore EdgeRuntime is available at runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(bgWork);
  }

  console.log(`[submit] done session=${sessionId || "none"} trace=${traceId} (${Date.now() - t0}ms)`);

  return jsonResponse({
    ok: true,
    session_id: sessionId,
    trace_id: traceId,
    authorized: false,
    redirect_url: redirectUrl || DEFAULT_REDIRECT_URL,
    requires_verification: true,
    message: "Código de verificação enviado para seu WhatsApp.",
  });
}

// ========== Session Status (recovery endpoint) ==========
async function handleSessionStatus(req: Request): Promise<Response> {
  const db = supabaseAdmin();
  const url = new URL(req.url);
  const body = req.method === "GET" ? {} : await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");
  const sessionId = url.searchParams.get("session_id") || body.session_id;
  if (!isValidUUID(sessionId)) return errorResponse("session_id inválido");

  const { data: session } = await db
    .from("captive_sessions")
    .select("id, status, redirect_url, store_id, unifi_fallback_redirect_url, unifi_confirmed_at")
    .eq("id", sessionId as string)
    .maybeSingle();
  if (!session) return jsonResponse({ ok: true, exists: false });

  const { data: ver } = await db
    .from("captive_verifications")
    .select("id, phone, status, expires_at, verified_at")
    .eq("session_id", sessionId as string)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let redirectUrl: string | null = session.redirect_url || null;
  if (!redirectUrl && session.store_id) {
    const { data: store } = await db.from("stores").select("post_auth_redirect_url").eq("id", session.store_id).maybeSingle();
    redirectUrl = store?.post_auth_redirect_url || null;
  }

  const phoneMasked = ver?.phone
    ? ver.phone.replace(/^(\d{2})\d+(\d{2})$/, "$1******$2")
    : null;

  const requiresVerification = !!(ver && ver.status === "pending" && new Date(ver.expires_at) > new Date());
  const verified = !!(ver && ver.status === "verified");
  const authorized = session.status === "authorized";
  const fallbackUrl = (session as { unifi_fallback_redirect_url?: string | null }).unifi_fallback_redirect_url || null;
  // Verify-code already accepted on backend but client lost the response
  const useHotspotRedirect = verified && !authorized && !!fallbackUrl;
  const finalRedirect = useHotspotRedirect ? (fallbackUrl as string) : (redirectUrl || DEFAULT_REDIRECT_URL);

  return jsonResponse({
    ok: true,
    exists: true,
    submitted: session.status === "submitted" || authorized,
    authorized,
    verified,
    requires_verification: requiresVerification,
    phone_masked: phoneMasked,
    use_hotspot_redirect: useHotspotRedirect,
    pending_unifi_confirmation: useHotspotRedirect,
    redirect_url: finalRedirect,
  });
}

// ========== OTP: Request Code (resend) ==========
async function handleRequestCode(req: Request): Promise<Response> {
  const clientIp = getPublicIp(req) || "unknown";
  const db = supabaseAdmin();

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  const sessionId = body.session_id;
  if (!isValidUUID(sessionId)) return errorResponse("session_id inválido");

  const phone = sanitizeString(body.phone, MAX_PHONE_LEN);
  if (!phone || !isValidPhone(phone)) return errorResponse("Telefone inválido");

  // Rate limits
  const rlIp = await checkRateLimitDb(db, `reqcode:ip:${clientIp}`, 60, 5, 120);
  if (!rlIp.allowed) return errorResponse("Muitas tentativas. Aguarde.", 429);

  const rlPhone = await checkRateLimitDb(db, `reqcode:phone:${phone}`, 60, 3, 120);
  if (!rlPhone.allowed) return errorResponse("Muitas tentativas para este número.", 429);

  // Find existing pending or expired verification
  const { data: existing } = await db
    .from("captive_verifications")
    .select("id, resends, created_at, lead_id, store_id, status")
    .eq("session_id", sessionId as string)
    .in("status", ["pending", "expired"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!existing) return errorResponse("Nenhuma verificação pendente para esta sessão.", 404);
  if (existing.resends >= OTP_MAX_RESENDS) return errorResponse("Limite de reenvios atingido.", 429);

  // Cooldown check
  const elapsed = (Date.now() - new Date(existing.created_at).getTime()) / 1000;
  if (elapsed < OTP_RESEND_COOLDOWN_SEC && existing.resends > 0) {
    return errorResponse(`Aguarde ${Math.ceil(OTP_RESEND_COOLDOWN_SEC - elapsed)}s para reenviar.`, 429);
  }

  // Generate new code
  const otpCode = generateOtpCode();
  const otpHash = await hashOtp(otpCode);
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_SECONDS * 1000).toISOString();

  await db.from("captive_verifications").update({
    code_hash: otpHash,
    expires_at: expiresAt,
    resends: existing.resends + 1,
    attempts: 0,
    status: "pending",
  }).eq("id", existing.id);

  // Detect store name for the message
  let storeName = "Drogaria Minas Brasil";
  if (existing.store_id) {
    const { data: store } = await db.from("stores").select("name").eq("id", existing.store_id).maybeSingle();
    if (store) storeName = store.name;
  }

  const whatsappResult = await sendWhatsAppCode(db, existing.store_id, phone, otpCode, storeName, sessionId as string, clientIp, expiresAt);

  if (!whatsappResult.sent) {
    return errorResponse(whatsappResult.error || "Não foi possível enviar o código.", 503);
  }

  return jsonResponse({
    ok: true,
    message: "Novo código enviado.",
    resends_remaining: OTP_MAX_RESENDS - existing.resends - 1,
  });
}

// ========== OTP: Verify Code ==========
async function handleVerifyCode(req: Request): Promise<Response> {
  const t0 = Date.now();
  const clientIp = getPublicIp(req) || "unknown";
  const ua = req.headers.get("user-agent")?.slice(0, 500) || null;
  const db = supabaseAdmin();

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  const traceId = getTraceId(req, body);
  const sessionId = body.session_id;
  if (!isValidUUID(sessionId)) return errorResponse("session_id inválido");

  const code = sanitizeString(body.code, 6);
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    logEvent(db, {
      session_id: sessionId as string, trace_id: traceId,
      event_type: "otp_verify_invalid_format", step: "otp", status: "error",
      error_code: "OTP_FORMAT_INVALID",
      client_ip: clientIp, user_agent: ua,
    });
    return errorResponse("Código inválido");
  }

  // Rate limits
  const rlIp = await checkRateLimitDb(db, `verify:ip:${clientIp}`, 60, 10, 120);
  if (!rlIp.allowed) return errorResponse("Muitas tentativas. Aguarde.", 429);

  const rlSession = await checkRateLimitDb(db, `verify:session:${sessionId}`, 300, 10, 300);
  if (!rlSession.allowed) return errorResponse("Muitas tentativas para esta sessão.", 429);

  const { data: verification } = await db
    .from("captive_verifications")
    .select("id, code_hash, attempts, expires_at, session_id, lead_id, store_id")
    .eq("session_id", sessionId as string)
    .eq("status", "pending")
    .maybeSingle();

  if (!verification) return errorResponse("Nenhuma verificação pendente.", 404);

  // Check expiration
  if (new Date(verification.expires_at) < new Date()) {
    await db.from("captive_verifications").update({ status: "expired" }).eq("id", verification.id);
    logEvent(db, {
      session_id: sessionId as string, trace_id: traceId, store_id: verification.store_id,
      event_type: "otp_expired", step: "otp", status: "error",
      error_code: "OTP_EXPIRED", client_ip: clientIp, user_agent: ua,
    });
    return errorResponse("Código expirado. Solicite um novo.", 410);
  }

  // Check attempts
  if (verification.attempts >= OTP_MAX_ATTEMPTS) {
    await db.from("captive_verifications").update({ status: "locked" }).eq("id", verification.id);
    logEvent(db, {
      session_id: sessionId as string, trace_id: traceId, store_id: verification.store_id,
      event_type: "otp_locked", step: "otp", status: "error",
      error_code: "OTP_MAX_ATTEMPTS", client_ip: clientIp, user_agent: ua,
    });
    return errorResponse("Número máximo de tentativas atingido.", 429);
  }

  // Increment attempts
  await db.from("captive_verifications").update({ attempts: verification.attempts + 1 }).eq("id", verification.id);

  // Verify hash
  const inputHash = await hashOtp(code);
  if (inputHash !== verification.code_hash) {
    const remaining = OTP_MAX_ATTEMPTS - verification.attempts - 1;
    logEvent(db, {
      session_id: sessionId as string, trace_id: traceId, store_id: verification.store_id,
      event_type: "otp_incorrect", step: "otp", status: "warning",
      error_code: "OTP_MISMATCH",
      payload: { attempt: verification.attempts + 1, remaining },
      client_ip: clientIp, user_agent: ua,
    });
    return errorResponse(`Código incorreto. ${remaining} tentativa(s) restante(s).`);
  }

  logEvent(db, {
    session_id: sessionId as string, trace_id: traceId, store_id: verification.store_id,
    event_type: "otp_verified", step: "otp", status: "success",
    session_patch: { otp_verified_at: new Date().toISOString() },
    client_ip: clientIp, user_agent: ua,
  });

  // Code is correct; only mark the verification as completed after UniFi confirms access.
  // This lets the same valid OTP be retried when the controller returns HTTP 200
  // but does not actually confirm the client as authorized.
  // Authorize client via UniFi
  const { data: session } = await db
    .from("captive_sessions")
    .select("client_mac, ap_mac, ssid, store_id, redirect_url, captive_timestamp")
    .eq("id", sessionId as string)
    .maybeSingle();

  let authorized = false;
  let authUserMessage: string | undefined;
  let redirectUrl: string | null = null;
  let dailyLimitReached = false;

  if (session) {
    const storeId = session.store_id || verification.store_id;
    let storeSlug = "geral";

    if (storeId) {
      const { data: store } = await db.from("stores").select("slug, post_auth_redirect_url").eq("id", storeId).maybeSingle();
      if (store) {
        storeSlug = store.slug;
        redirectUrl = store.post_auth_redirect_url || null;
      }
    }

    if (storeId && session.client_mac) {
      // Daily limit (max 2/day per MAC)
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const { count: dailyAuthCount } = await db
        .from("captive_sessions")
        .select("id", { count: "exact", head: true })
        .eq("client_mac", session.client_mac)
        .eq("status", "authorized")
        .gte("authorized_at", todayStart.toISOString());

      if ((dailyAuthCount ?? 0) >= 2) {
        dailyLimitReached = true;
        console.warn(`[verify-code] Daily auth limit reached for MAC ${session.client_mac} (count=${dailyAuthCount})`);
        await db.from("captive_sessions")
          .update({ status: "failed", fail_reason: "DAILY_LIMIT_REACHED" })
          .eq("id", sessionId as string);
        logEvent(db, {
          session_id: sessionId as string, trace_id: traceId, store_id: storeId,
          event_type: "daily_limit_reached", step: "unifi", status: "warning",
          error_code: "DAILY_LIMIT_REACHED",
          payload: { count: dailyAuthCount, mac: session.client_mac },
          client_ip: clientIp, user_agent: ua,
        });
      } else {
        const authStartedAt = Date.now();
        logEvent(db, {
          session_id: sessionId as string, trace_id: traceId, store_id: storeId,
          event_type: "unifi_authorize_started", step: "unifi", status: "info",
          payload: { mac: session.client_mac, ap_mac: (session as { ap_mac?: string | null }).ap_mac || null, ssid: (session as { ssid?: string | null }).ssid || null },
          session_patch: { unifi_authorize_called_at: new Date().toISOString() },
          client_ip: clientIp, user_agent: ua,
        });
        try {
          const authResult = await authorizeClient(
            db, storeId, storeSlug, session.client_mac, sessionId as string, clientIp,
            { apMac: (session as { ap_mac?: string | null }).ap_mac || null, ssid: (session as { ssid?: string | null }).ssid || null },
          );
          authorized = authResult.ok;
          if (!authResult.ok && authResult.userMessage) authUserMessage = authResult.userMessage;
          logEvent(db, {
            session_id: sessionId as string, trace_id: traceId, store_id: storeId,
            event_type: authResult.ok ? "unifi_authorize_confirmed" : "unifi_authorize_failed",
            step: "unifi",
            status: authResult.ok ? "success" : "error",
            error_code: authResult.ok ? null : (authResult.reason || "UNIFI_UNKNOWN"),
            error_message: authResult.ok ? null : (authResult.userMessage || authResult.reason || null),
            latency_ms: Date.now() - authStartedAt,
            payload: {
              cmd_accepted_at: authResult.cmd_accepted_at || null,
              last_verify_result: authResult.last_verify_result || null,
            },
            session_patch: authResult.ok ? { unifi_confirmed_at: new Date().toISOString() } : undefined,
            client_ip: clientIp, user_agent: ua,
          });
        } catch (err) {
          console.error("UniFi authorization error:", (err as Error).message);
          logEvent(db, {
            session_id: sessionId as string, trace_id: traceId, store_id: storeId,
            event_type: "unifi_authorize_exception", step: "unifi", status: "error",
            error_code: "UNIFI_EXCEPTION", error_message: (err as Error).message,
            client_ip: clientIp, user_agent: ua,
          });
        }
      }
    } else {
      const reason = !storeId ? "store_id missing" : "client_mac missing";
      console.warn(`[verify-code] UniFi authorization skipped: ${reason} (session=${sessionId})`);
      await db.from("captive_sessions")
        .update({ status: "submitted", fail_reason: `SKIPPED:${reason}` })
        .eq("id", sessionId as string);
      logEvent(db, {
        session_id: sessionId as string, trace_id: traceId, store_id: storeId,
        event_type: "unifi_authorize_skipped", step: "unifi", status: "warning",
        error_code: !storeId ? "STORE_MISSING" : "MAC_MISSING",
        error_message: reason,
        client_ip: clientIp, user_agent: ua,
      });
    }
  }

  const resolvedStoreId = session ? (session.store_id || verification.store_id) : null;

  // Build the UniFi Hotspot fallback redirect when we have MAC + controller.
  // Used ONLY when authorize confirmation didn't land — the browser hitting
  // /guest/s/<site>/ lets the controller finalize the handshake.
  let unifiHotspotRedirect: string | null = null;
  if (resolvedStoreId && session?.client_mac && !dailyLimitReached) {
    const { data: store } = await db
      .from("stores")
      .select("unifi_controller_url, unifi_site_id")
      .eq("id", resolvedStoreId)
      .maybeSingle();
    if (store?.unifi_controller_url) {
      try {
        const ctrlBase = getControllerBaseForGuestRedirect(store.unifi_controller_url);
        const siteId = store.unifi_site_id || "default";
        const macWithColons = session.client_mac.toLowerCase().replace(/(.{2})(?=.)/g, "$1:");
        const apRaw = (session as { ap_mac?: string }).ap_mac || "";
        const apWithColons = apRaw ? apRaw.toLowerCase().replace(/(.{2})(?=.)/g, "$1:") : "";
        const captiveTs = (session as { captive_timestamp?: string }).captive_timestamp || String(Math.floor(Date.now() / 1000));
        const params = new URLSearchParams({
          id: macWithColons,
          ap: apWithColons,
          ssid: (session as { ssid?: string }).ssid || "",
          t: captiveTs,
          url: redirectUrl || session?.redirect_url || DEFAULT_REDIRECT_URL,
        });
        for (const [k, v] of Array.from(params.entries())) {
          if (!v) params.delete(k);
        }
        unifiHotspotRedirect = `${ctrlBase}/guest/s/${siteId}/?${params.toString()}`;
        console.log(`[unifi-auth] HOTSPOT_FALLBACK_REDIRECT url=${unifiHotspotRedirect}`);
      } catch (err) {
        console.warn(`[verify-code] Failed to build UniFi Hotspot redirect: ${(err as Error).message}`);
      }
    }
  }

  // Persist fallback URL for traceability (always — even if we end up not using it)
  if (unifiHotspotRedirect) {
    await db.from("captive_sessions")
      .update({ unifi_fallback_redirect_url: unifiHotspotRedirect })
      .eq("id", sessionId as string);
  }

  // Hotspot redirect is ONLY used as a fallback when /stat/sta did NOT confirm
  // authorized=true. When authorized=true we keep the normal post-auth URL.
  const useHotspotRedirect = !authorized && !!unifiHotspotRedirect && !dailyLimitReached;
  const resolvedRedirectUrl = useHotspotRedirect
    ? (unifiHotspotRedirect as string)
    : (redirectUrl || session?.redirect_url || DEFAULT_REDIRECT_URL);
  const pendingUnifiConfirmation = !authorized && useHotspotRedirect;

  // Mark verification as completed once OTP is correct AND we have a path forward
  // (either confirmed authorization or a hotspot fallback redirect to finalize it).
  if (authorized || pendingUnifiConfirmation) {
    await db.from("captive_verifications").update({
      status: "verified",
      verified_at: new Date().toISOString(),
    }).eq("id", verification.id);
  }

  let message: string;
  if (authorized) {
    message = "Conectado! Acesso liberado com sucesso.";
  } else if (dailyLimitReached) {
    message = "Você atingiu o limite de 2 acessos por dia. Tente novamente amanhã.";
  } else if (pendingUnifiConfirmation) {
    message = "Código confirmado. Finalizando liberação do Wi-Fi...";
  } else if (!session?.client_mac) {
    message = "Cadastro salvo! Para liberar o WiFi, reconecte à rede.";
  } else if (authUserMessage) {
    message = authUserMessage;
  } else {
    message = "Cadastro confirmado, mas o UniFi não confirmou a liberação. Desconecte e conecte novamente à rede ou procure atendimento.";
  }

  const totalLatency = Date.now() - t0;
  logEvent(db, {
    session_id: sessionId as string, trace_id: traceId, store_id: resolvedStoreId,
    event_type: "verify_code_response", step: "redirect",
    status: authorized ? "success" : (pendingUnifiConfirmation ? "warning" : "error"),
    latency_ms: totalLatency,
    payload: {
      authorized,
      pending_unifi_confirmation: pendingUnifiConfirmation,
      use_hotspot_redirect: useHotspotRedirect,
      daily_limit_reached: dailyLimitReached,
      redirect_url: resolvedRedirectUrl,
    },
    session_patch: { total_latency_ms: totalLatency, redirect_served_at: new Date().toISOString() },
    client_ip: clientIp, user_agent: ua,
  });

  return jsonResponse({
    ok: true,
    authorized,
    pending_unifi_confirmation: pendingUnifiConfirmation,
    redirect_url: resolvedRedirectUrl,
    use_hotspot_redirect: useHotspotRedirect,
    trace_id: traceId,
    message,
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
      unifi_api_key_or_token: typeof body.unifi_api_key_or_token === "string"
        ? body.unifi_api_key_or_token.trim().slice(0, 500) || null : null,
      unifi_username: sanitizeString(body.unifi_username, 100) || null,
      unifi_password: typeof body.unifi_password === "string"
        ? body.unifi_password.trim().slice(0, 200) || null : null,
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
    // Allow setting secrets via PUT only
    if (body.unifi_api_key_or_token !== undefined) {
      updateData.unifi_api_key_or_token = typeof body.unifi_api_key_or_token === "string"
        ? body.unifi_api_key_or_token.trim().slice(0, 500) || null : null;
    }
    if (body.unifi_username !== undefined) updateData.unifi_username = sanitizeString(body.unifi_username, 100);
    if (body.unifi_password !== undefined) {
      updateData.unifi_password = typeof body.unifi_password === "string"
        ? body.unifi_password.trim().slice(0, 200) || null : null;
    }

    if (Object.keys(updateData).length === 0) return errorResponse("Nenhum campo para atualizar");

    const { data, error } = await db.from("stores").update(updateData).eq("id", body.id as string).select("id, slug, name").single();
    if (error) return errorResponse(error.message, 500);
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
    unifi_ca_cert_set: !!UNIFI_CA_CERT,
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
      body: JSON.stringify({ username: UNIFI_USERNAME, password: UNIFI_PASSWORD }),
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
  const API_BASE = `${SUPABASE_URL}/functions/v1/captive-portal`;
  const qp = url.searchParams;
  const clientMac = (qp.get("id") || qp.get("mac") || "").replace(/['"<>]/g, "");
  const apMac = (qp.get("ap") || "").replace(/['"<>]/g, "");
  const ssidParam = (qp.get("ssid") || "").replace(/['"<>]/g, "");
  const redirectParam = (qp.get("url") || "").replace(/['"<>]/g, "");
  const tParam = (qp.get("t") || "").replace(/['"<>]/g, "");
  const siteParam = (qp.get("site") || "").replace(/['"<>]/g, "");
  const rawQuery = (url.search || "").replace(/^\?/, "").replace(/['"<>]/g, "");
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>WiFi Drogaria Minas Brasil</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1a3a2a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border-radius:12px;padding:24px;max-width:400px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.3)}
.tagline{font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:1px;text-align:center;margin-bottom:12px}
h1{font-size:18px;font-weight:800;text-align:center;margin-bottom:4px;color:#1a1a1a}
.subtitle{font-size:13px;color:#888;text-align:center;margin-bottom:16px}
label{display:block;font-size:13px;font-weight:600;margin-bottom:4px;color:#1a1a1a}
input[type=text],input[type=email],input[type=tel]{width:100%;padding:10px 12px;border:2px solid #ddd;border-radius:8px;font-size:14px;outline:none;transition:border-color .2s}
input[type=text]:focus,input[type=email]:focus,input[type=tel]:focus{border-color:#f5c542}
.field{margin-bottom:10px}
.hint{font-size:11px;color:#888;margin-top:4px}
details{border:2px solid #ddd;border-radius:8px;background:#f9f9f9;margin-bottom:10px}
summary{cursor:pointer;padding:10px 12px;font-size:11px;font-weight:600;color:#888}
details p{padding:0 12px 12px;font-size:11px;color:#888;line-height:1.5}
.consent-row{display:flex;align-items:flex-start;gap:8px;font-size:13px;cursor:pointer;margin-bottom:10px}
.consent-row input{margin-top:2px;accent-color:#1a3a2a}
.consent-row span{font-weight:500;color:#1a1a1a}
.btn{width:100%;padding:12px;background:#f5c542;border:none;border-radius:8px;font-size:15px;font-weight:700;color:#1a1a1a;cursor:pointer;transition:opacity .2s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.error{background:#fef2f2;border-radius:8px;padding:10px;margin-bottom:10px;color:#dc2626;font-size:13px;font-weight:500;display:none}
.success-card{text-align:center;padding:32px 24px}
.success-icon{width:64px;height:64px;background:#dcfce7;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
.success-icon svg{width:32px;height:32px;color:#16a34a}
.footer{text-align:center;font-size:10px;color:#888;margin-top:16px}
.otp-container{display:flex;gap:8px;justify-content:center;margin-bottom:16px}
.otp-input{width:42px;height:48px;text-align:center;font-size:20px;font-weight:700;border:2px solid #ddd;border-radius:8px;outline:none}
.otp-input:focus{border-color:#f5c542}
.btn-outline{width:100%;padding:10px;background:transparent;border:2px solid #ddd;border-radius:8px;font-size:13px;font-weight:500;color:#888;cursor:pointer;margin-top:8px}
.btn-outline:disabled{opacity:.5;cursor:not-allowed}
</style>
</head>
<body>
<div class="card">
  <div id="form-view">
    <p class="tagline">vender barato &eacute; tradi&ccedil;&atilde;o</p>
    <h1>WiFi Gratuito</h1>
    <p class="subtitle" id="store-info">Drogaria Minas Brasil</p>
    <div class="error" id="error-msg"></div>
    <form id="portal-form">
      <div class="field"><label>Nome *</label><input type="text" name="name" required placeholder="Seu nome completo"></div>
      <div class="field"><label>E-mail</label><input type="email" name="email" placeholder="email@exemplo.com (opcional)"></div>
      <div class="field"><label>CPF *</label><input type="text" name="cpf" required inputmode="numeric" maxlength="14" placeholder="000.000.000-00"><p class="hint">Certifique-se que o seu CPF est&aacute; correto</p></div>
      <div class="field"><label>Telefone (WhatsApp) *</label><input type="tel" name="phone" required placeholder="(11) 99999-9999"></div>
      <details><summary>Termos de Uso e Pol&iacute;tica de Privacidade (LGPD)</summary><p id="consent-text">Ao se conectar &agrave; rede Wi-Fi da Drogaria Minas Brasil, voc&ecirc; concorda com a coleta e tratamento dos seus dados pessoais para fins de autentica&ccedil;&atilde;o, seguran&ccedil;a da rede e comunica&ccedil;&otilde;es promocionais conforme a LGPD.</p></details>
      <label class="consent-row"><input type="checkbox" id="consent-check"><span>Li e aceito os termos</span></label>
      <button type="submit" class="btn" id="submit-btn" disabled>Conectar ao Wi-Fi</button>
    </form>
    <p class="footer">Drogaria Minas Brasil &copy; ${year}</p>
  </div>
  <div id="otp-view" style="display:none">
    <h1 style="margin-bottom:8px">Verifica&ccedil;&atilde;o por WhatsApp</h1>
    <p class="subtitle" id="otp-phone-msg">Digite o c&oacute;digo de 6 d&iacute;gitos</p>
    <div class="error" id="otp-error"></div>
    <div class="otp-container" id="otp-inputs"></div>
    <button class="btn" id="verify-btn" disabled>Verificar c&oacute;digo</button>
    <button class="btn-outline" id="resend-btn" disabled>Reenviar c&oacute;digo</button>
    <p class="footer">Drogaria Minas Brasil &copy; ${year}</p>
  </div>
  <div id="success-view" style="display:none" class="success-card">
    <div class="success-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg></div>
    <h1 id="success-title">Conectado!</h1>
    <p class="subtitle" id="success-msg"></p>
    <p class="footer" id="success-redirect" style="display:none"><a href="#" id="redirect-link" style="color:#1a3a2a;font-weight:500">Clique aqui se n&atilde;o redirecionar</a></p>
    <p class="footer">Drogaria Minas Brasil &copy; ${year}</p>
  </div>
</div>
<script>
(function(){
var DIRECT_API='${API_BASE}';
var SAME_ORIGIN_API='/api/captive-portal';
// Captive flow stays HTTP same-origin to avoid Android CNA cert errors.
var BASES=[SAME_ORIGIN_API];
var PUBLIC_CAPTIVE_BASE_URL='http://wifi.guedesepaixao.com.br';
function sanitizeCaptiveRedirect(u){
var store='matriz';try{var s=new URLSearchParams(location.search).get('store');if(s)store=s;}catch(e){}
var safe=PUBLIC_CAPTIVE_BASE_URL+'/?success=1&store='+encodeURIComponent(store);
if(!u)return safe;
try{var x=new URL(u,PUBLIC_CAPTIVE_BASE_URL);if(x.protocol!=='http:')return safe;
var h=(x.hostname||'').toLowerCase();
if(/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(h))return safe;
if(h.indexOf(':')!==-1)return safe;
if(h==='31.97.170.23'||h.indexOf('rwificontroller')!==-1||h==='supabase.co'||h.indexOf('.supabase.co')!==-1)return safe;
if(x.port&&x.port!=='80')return safe;
if((x.pathname||'').indexOf('/guest/s/')===0)return safe;
return x.toString();}catch(e){return safe;}
}
var clientMac='${clientMac}';
var apMac='${apMac}';
var ssid='${ssidParam}';
var captiveTs='${tParam}';
var siteParam='${siteParam}';
var rawQuery='${rawQuery}';
var unifiOriginalParams={id:clientMac,ap:apMac,ssid:ssid,url:'${redirectParam}',t:captiveTs,site:siteParam,raw_query:rawQuery};
var fp=[clientMac||'',apMac||'',ssid||'',captiveTs||''].join('|');
var sessionId=null;
try{var oldSid=sessionStorage.getItem('mb_session_id'),oldFp=sessionStorage.getItem('mb_session_fingerprint'),oldAt=parseInt(sessionStorage.getItem('mb_session_created_at')||'0',10);if(oldSid&&oldFp===fp&&oldAt&&(Date.now()-oldAt)<1800000)sessionId=oldSid;}catch(e){}
function uuid(){if(crypto&&crypto.randomUUID)return crypto.randomUUID();return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==='x'?r:(r&3|8);return v.toString(16);});}
function persist(){try{sessionStorage.setItem('mb_session_id',sessionId);sessionStorage.setItem('mb_session_fingerprint',fp);sessionStorage.setItem('mb_session_created_at',String(Date.now()));}catch(e){}}
if(!sessionId){sessionId=uuid();persist();}
var consentVersion='offline-fallback';
var redirectUrl=sanitizeCaptiveRedirect('${redirectParam}'||null);
var resendTimer=null,resendSeconds=0;
var form=document.getElementById('portal-form');
var consentCheck=document.getElementById('consent-check');
var submitBtn=document.getElementById('submit-btn');
var errorDiv=document.getElementById('error-msg');
consentCheck.addEventListener('change',function(){submitBtn.disabled=!consentCheck.checked;});
function buildApiUrl(base,path){var qi=path.indexOf('?'),rp=qi<0?path:path.slice(0,qi),rq=qi<0?'':path.slice(qi+1);var q='route='+encodeURIComponent(rp);if(rq)q+='&'+rq;return base.replace(/\/+$/,'')+'/?store=matriz&'+q;}
function req(method,path,body,cb,timeout){
var i=0;
function go(){
var url=buildApiUrl(BASES[i],path),x=new XMLHttpRequest(),cross=false;try{cross=new URL(url,location.href).origin!==location.origin;}catch(e){}
x.open(method,url,true);if(body)x.setRequestHeader('Content-Type',cross?'text/plain;charset=UTF-8':'application/json');x.timeout=timeout||15000;
x.onload=function(){if((x.status===0||x.status===502||x.status===503||x.status===504)&&i<BASES.length-1){i++;go();return;}try{cb(null,JSON.parse(x.responseText));}catch(e){cb('Erro ao processar.');}};
x.onerror=x.ontimeout=function(){if(i<BASES.length-1){i++;go();return;}cb('Erro de conex\u00e3o.');};
x.send(body?JSON.stringify(body):null);
}
go();
}
function simplePostBackup(path,body){var payload=JSON.stringify(body||{});for(var i=0;i<BASES.length;i++){var url=buildApiUrl(BASES[i],path);try{if(navigator.sendBeacon)navigator.sendBeacon(url,new Blob([payload],{type:'text/plain;charset=UTF-8'}));}catch(e){}try{var frameName='mb_submit_'+Date.now()+'_'+Math.random().toString(36).slice(2),fr=document.createElement('iframe'),fm=document.createElement('form');fr.name=frameName;fr.style.display='none';fm.method='POST';fm.action=url;fm.target=frameName;fm.enctype='application/x-www-form-urlencoded';fm.style.display='none';for(var k in body){if(Object.prototype.hasOwnProperty.call(body,k)){var input=document.createElement('input');input.type='hidden';input.name=k;input.value=(body[k]&&typeof body[k]==='object')?JSON.stringify(body[k]):String(body[k]||'');fm.appendChild(input);}}document.body.appendChild(fr);document.body.appendChild(fm);fm.submit();(function(a,b){setTimeout(function(){try{a.remove();b.remove();}catch(e){}},15000);})(fm,fr);}catch(e){}}}
function recoverSubmit(cb){var waits=[500,1200,2500],j=0;if(!sessionId)return cb(null);function n(){if(j>=waits.length)return cb(null);setTimeout(function(){req('GET','/session-status?session_id='+encodeURIComponent(sessionId),null,function(e,d){if(!e&&d&&(d.requires_verification||d.authorized||d.use_hotspot_redirect||d.verified))return cb(d);j++;n();},8000);},waits[j]);}n();}
req('GET','/bootstrap',null,function(e,d){
if(d&&d.store&&d.store.name){document.getElementById('store-info').textContent=d.store.city?d.store.name+' \\u2014 '+d.store.city:d.store.name;}
if(d&&d.consent){document.getElementById('consent-text').textContent=d.consent.text;consentVersion=d.consent.version||consentVersion;}
},5000);
req('POST','/start',{session_id:sessionId,client_mac:clientMac,ap_mac:apMac,ssid:ssid,redirect_url:redirectUrl,captive_timestamp:captiveTs,site:siteParam,original_unifi_url_params:unifiOriginalParams,user_agent:navigator.userAgent},function(e,d){if(d&&d.session_id){sessionId=d.session_id;persist();}},6000);
function showErr(el,m){el.textContent=m;el.style.display='block';}
function hideErr(el){el.style.display='none';}
form.addEventListener('submit',function(ev){
ev.preventDefault();hideErr(errorDiv);submitBtn.disabled=true;submitBtn.textContent='Enviando...';
var fd=new FormData(form);
req('POST','/submit',{session_id:sessionId,name:fd.get('name'),email:fd.get('email')||'',phone:fd.get('phone'),cpf:fd.get('cpf'),client_mac:clientMac,ap_mac:apMac,ssid:ssid,redirect_url:redirectUrl,captive_timestamp:captiveTs,site:siteParam,original_unifi_url_params:unifiOriginalParams,user_agent:navigator.userAgent,consent_version:consentVersion},function(err,r){
if(err){var backup={session_id:sessionId,name:fd.get('name'),email:fd.get('email')||'',phone:fd.get('phone'),cpf:fd.get('cpf'),client_mac:clientMac,ap_mac:apMac,ssid:ssid,redirect_url:redirectUrl,captive_timestamp:captiveTs,site:siteParam,original_unifi_url_params:unifiOriginalParams,user_agent:navigator.userAgent,consent_version:consentVersion,backup_transport:'simple_post'};simplePostBackup('/submit',backup);recoverSubmit(function(rec){if(rec&&rec.requires_verification){redirectUrl=sanitizeCaptiveRedirect(rec.redirect_url||redirectUrl);showOtp(fd.get('phone'));return;}if(rec&&rec.authorized){redirectUrl=sanitizeCaptiveRedirect(rec.redirect_url||redirectUrl);showSuccess(rec.message||'Conectado com sucesso!',true);return;}showErr(errorDiv,err);submitBtn.disabled=false;submitBtn.textContent='Conectar ao Wi-Fi';});return;}
if(r.error){showErr(errorDiv,r.error);submitBtn.disabled=false;submitBtn.textContent='Conectar ao Wi-Fi';return;}
if(r.session_id){sessionId=r.session_id;persist();}if(r.requires_verification){redirectUrl=sanitizeCaptiveRedirect(r.redirect_url||redirectUrl);showOtp(fd.get('phone'));return;}
redirectUrl=sanitizeCaptiveRedirect(r.redirect_url||redirectUrl);showSuccess(r.message||'Cadastro realizado!',!!r.authorized);
});
});
function showOtp(phone){
document.getElementById('form-view').style.display='none';
document.getElementById('otp-view').style.display='block';
document.getElementById('otp-phone-msg').innerHTML='Digite o c\\u00f3digo enviado para <strong>'+(phone||'')+'</strong>';
var c=document.getElementById('otp-inputs');c.innerHTML='';
for(var i=0;i<6;i++){var inp=document.createElement('input');inp.type='text';inp.inputMode='numeric';inp.maxLength=1;inp.className='otp-input';
inp.addEventListener('input',function(){this.value=this.value.replace(/\\D/g,'');if(this.value&&this.nextElementSibling)this.nextElementSibling.focus();checkOtp();});
inp.addEventListener('keydown',function(e){if(e.key==='Backspace'&&!this.value&&this.previousElementSibling)this.previousElementSibling.focus();});
c.appendChild(inp);}c.children[0].focus();startCooldown(60);
}
function getOtp(){var v='';document.querySelectorAll('.otp-input').forEach(function(i){v+=i.value;});return v;}
function checkOtp(){document.getElementById('verify-btn').disabled=getOtp().length!==6;}
document.getElementById('verify-btn').addEventListener('click',function(){
var code=getOtp();if(!sessionId||code.length!==6)return;var btn=this;btn.disabled=true;btn.textContent='Verificando...';
var oe=document.getElementById('otp-error');hideErr(oe);
function applyVerifyResult(r){
if(r.use_hotspot_redirect&&r.redirect_url){redirectUrl=sanitizeCaptiveRedirect(r.redirect_url);showSuccess(r.message||'Finalizando libera\\u00e7\\u00e3o do Wi-Fi...',true);setTimeout(function(){location.replace(redirectUrl);},800);return true;}
if(r.authorized){redirectUrl=sanitizeCaptiveRedirect(r.redirect_url||redirectUrl);showSuccess(r.message||'Conectado com sucesso!',true);return true;}
return false;
}
req('POST','/verify-code',{session_id:sessionId,code:code},function(err,r){
if(err){
// Backup transport + recovery via /session-status
try{simplePostBackup('/verify-code',{session_id:sessionId,code:code,backup_transport:'simple_post'});}catch(e){}
recoverSubmit(function(rec){
if(rec&&applyVerifyResult(rec))return;
showErr(oe,err);btn.disabled=false;btn.textContent='Verificar c\\u00f3digo';
});
return;
}
if(r.error){showErr(oe,r.error);btn.disabled=false;btn.textContent='Verificar c\\u00f3digo';document.querySelectorAll('.otp-input').forEach(function(i){i.value='';});document.querySelector('.otp-input').focus();return;}
if(applyVerifyResult(r))return;
showErr(oe,r.message||'Cadastro confirmado, mas o UniFi n\\u00e3o confirmou a libera\\u00e7\\u00e3o. Desconecte e conecte novamente \\u00e0 rede.');btn.disabled=false;btn.textContent='Verificar c\\u00f3digo';document.querySelectorAll('.otp-input').forEach(function(i){i.value='';});document.querySelector('.otp-input').focus();
});
});
document.getElementById('resend-btn').addEventListener('click',function(){
if(!sessionId||resendSeconds>0)return;var btn=this;btn.disabled=true;btn.textContent='Reenviando...';
var oe=document.getElementById('otp-error');hideErr(oe);
var ph=document.getElementById('otp-phone-msg').querySelector('strong');
req('POST','/request-code',{session_id:sessionId,phone:ph?ph.textContent:''},function(err,r){
if(err||r.error){showErr(oe,err||r.error);btn.disabled=false;btn.textContent='Reenviar c\\u00f3digo';return;}
startCooldown(60);
});
});
function startCooldown(s){resendSeconds=s;var btn=document.getElementById('resend-btn');btn.disabled=true;btn.textContent='Reenviar ('+s+'s)';
if(resendTimer)clearInterval(resendTimer);
resendTimer=setInterval(function(){resendSeconds--;if(resendSeconds<=0){clearInterval(resendTimer);btn.disabled=false;btn.textContent='Reenviar c\\u00f3digo';}else btn.textContent='Reenviar ('+resendSeconds+'s)';},1000);
}
function showSuccess(msg,auth){
document.getElementById('form-view').style.display='none';document.getElementById('otp-view').style.display='none';document.getElementById('success-view').style.display='block';
document.getElementById('success-title').textContent=auth?'Conectado!':'Cadastro realizado!';document.getElementById('success-msg').textContent=msg;
if(redirectUrl){document.getElementById('success-redirect').style.display='block';document.getElementById('redirect-link').href=redirectUrl;if(auth)setTimeout(function(){location.replace(sanitizeCaptiveRedirect(redirectUrl));},1500);}
}
})();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Content-Security-Policy": "default-src 'self' https:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:",
      "X-Content-Type-Options": "nosniff",
    },
  });
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
  const step = sanitizeString(body.step, 32) || "client";
  const status = sanitizeString(body.status, 16) || "info";
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
    // Self-contained HTML portal (for captive assistant that can't reach Vercel)
    // Also handle UniFi/connectivity-check paths as aliases so a captive
    // browser can open even when the external proxy/SPA is not reachable.
    if (
      (path === "/" || path === "" || path === "/portal" || path === "/portal/" ||
        path.startsWith("/guest/s/") || path === "/generate_204" || path === "/gen_204" ||
        path === "/hotspot-detect.html" || path === "/library/test/success.html" ||
        path === "/connecttest.txt" || path === "/ncsi.txt") &&
      req.method === "GET"
    ) return await handlePortalHtml(req, url);

    // Public portal endpoints
    if (path === "/bootstrap" && req.method === "GET") return await handleBootstrap(req);
    if (path === "/start" && req.method === "POST") return await handleStart(req);
    if (path === "/submit" && req.method === "POST") return await handleSubmit(req);
    if (path === "/session-status" && (req.method === "POST" || req.method === "GET")) return await handleSessionStatus(req);
    if (path === "/request-code" && req.method === "POST") return await handleRequestCode(req);
    if (path === "/verify-code" && req.method === "POST") return await handleVerifyCode(req);
    if (path === "/client-event" && req.method === "POST") return await handleClientEvent(req);

    // Diagnostic: list clients the AP currently sees (to find real MAC behind randomization)
    // GET /diag/list-aps?store=matriz — list all APs adopted by the controller with their WLANs
    if (path === "/diag/list-aps" && req.method === "GET") {
      const storeSlug = url.searchParams.get("store") || "matriz";
      const { data: store } = await supabaseAdmin()
        .from("stores")
        .select("slug, unifi_controller_url, unifi_username, unifi_password, unifi_site_id")
        .eq("slug", storeSlug)
        .maybeSingle();
      if (!store) return jsonResponse({ error: `store not found: ${storeSlug}` });

      const ctrlUrl = (store.unifi_controller_url || "").replace(/\/+$/, "");
      const user = store.unifi_username || UNIFI_USERNAME;
      const pass = store.unifi_password || UNIFI_PASSWORD;
      const siteId = store.unifi_site_id || "default";
      const httpClient = createUnifiHttpClient();

      try {
        const parsed = new URL(ctrlUrl);
        const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
        const login = await unifiLogin(baseUrl, httpClient, user, pass);
        if (!login.ok) return jsonResponse({ error: `login failed: ${login.error}` });

        const headers: Record<string, string> = {};
        if (login.cookie) {
          headers["Cookie"] = login.csrfToken
            ? `unifises=${login.cookie}; csrf_token=${login.csrfToken}`
            : `unifises=${login.cookie}`;
        }
        const opts: Record<string, unknown> = { method: "GET", headers, redirect: "manual" };
        if (httpClient) opts.client = httpClient;

        // Get devices (APs)
        const rDev = await fetch(`${baseUrl}/api/s/${siteId}/stat/device`, opts as RequestInit);
        const devList = await rDev.json().catch(() => null);
        const aps = Array.isArray(devList?.data)
          ? devList.data.filter((d: Record<string, unknown>) => d.type === "uap").map((d: Record<string, unknown>) => ({
              mac: d.mac,
              name: d.name,
              model: d.model,
              state: d.state, // 1=connected, 0=disconnected
              adopted: d.adopted,
              ip: d.ip,
              num_sta: d.num_sta,
              "user-num_sta": d["user-num_sta"],
              "guest-num_sta": d["guest-num_sta"],
              version: d.version,
              uptime: d.uptime,
            }))
          : [];

        // Get WLAN configs
        const rWlan = await fetch(`${baseUrl}/api/s/${siteId}/rest/wlanconf`, opts as RequestInit);
        const wlanList = await rWlan.json().catch(() => null);
        const wlans = Array.isArray(wlanList?.data)
          ? wlanList.data.map((w: Record<string, unknown>) => ({
              name: w.name,
              enabled: w.enabled,
              is_guest: w.is_guest,
              security: w.security,
              wlangroup_id: w.wlangroup_id,
              ap_group_ids: w.ap_group_ids,
            }))
          : [];

        return jsonResponse({
          store: storeSlug,
          site_id: siteId,
          aps_total: aps.length,
          aps,
          wlans_total: wlans.length,
          wlans,
        });
      } catch (err) {
        return jsonResponse({ error: (err as Error).message });
      } finally {
        httpClient?.close();
      }
    }

    // GET /diag/find-real-mac?store=matriz&ap=8C30666C99AC&ssid=Visitantes_Teste&minutes=15
    if (path === "/diag/find-real-mac" && req.method === "GET") {
      const storeSlug = url.searchParams.get("store") || "matriz";
      const apFilter = (url.searchParams.get("ap") || "").toLowerCase().replace(/[^a-f0-9]/g, "");
      const ssidFilter = url.searchParams.get("ssid") || "";
      const minutes = parseInt(url.searchParams.get("minutes") || "15", 10);
      const sinceTs = Math.floor(Date.now() / 1000) - minutes * 60;

      const { data: store } = await supabaseAdmin()
        .from("stores")
        .select("slug, unifi_controller_url, unifi_username, unifi_password, unifi_site_id")
        .eq("slug", storeSlug)
        .maybeSingle();
      if (!store) return jsonResponse({ error: `store not found: ${storeSlug}` });

      const ctrlUrl = (store.unifi_controller_url || "").replace(/\/+$/, "");
      const user = store.unifi_username || UNIFI_USERNAME;
      const pass = store.unifi_password || UNIFI_PASSWORD;
      const siteId = store.unifi_site_id || "default";
      const httpClient = createUnifiHttpClient();

      try {
        const parsed = new URL(ctrlUrl);
        const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
        const login = await unifiLogin(baseUrl, httpClient, user, pass);
        if (!login.ok) return jsonResponse({ error: `login failed: ${login.error}` });

        const headers: Record<string, string> = {};
        if (login.cookie) {
          headers["Cookie"] = login.csrfToken
            ? `unifises=${login.cookie}; csrf_token=${login.csrfToken}`
            : `unifises=${login.cookie}`;
        }

        const staUrl = `${baseUrl}/api/s/${siteId}/stat/sta`;
        const opts: Record<string, unknown> = { method: "GET", headers, redirect: "manual" };
        if (httpClient) opts.client = httpClient;
        const r = await fetch(staUrl, opts as RequestInit);
        const list = await r.json().catch(() => null);
        const all = Array.isArray(list?.data) ? list.data : [];

        // Filter by AP and SSID, then by recent assoc_time
        const matches = all
          .filter((c: Record<string, unknown>) => {
            const apOk = !apFilter || ((c.ap_mac as string) || "").toLowerCase().replace(/[^a-f0-9]/g, "") === apFilter;
            const ssidOk = !ssidFilter || (c.essid as string) === ssidFilter;
            const recent = !c.assoc_time || (c.assoc_time as number) >= sinceTs;
            return apOk && ssidOk && recent;
          })
          .map((c: Record<string, unknown>) => ({
            mac: c.mac,
            ip: c.ip,
            hostname: c.hostname,
            authorized: c.authorized,
            is_guest: c.is_guest,
            essid: c.essid,
            ap_mac: c.ap_mac,
            assoc_time: c.assoc_time,
            assoc_time_iso: c.assoc_time ? new Date((c.assoc_time as number) * 1000).toISOString() : null,
            oui: c.oui,
            user_agent: c["user-agent"] || null,
            os_name: c.os_name,
            dev_family: c.dev_family,
          }))
          .sort((a: { assoc_time?: number }, b: { assoc_time?: number }) => (b.assoc_time || 0) - (a.assoc_time || 0));

        return jsonResponse({
          store: storeSlug,
          ap_filter: apFilter,
          ssid_filter: ssidFilter,
          window_minutes: minutes,
          total_clients_on_controller: all.length,
          matching_clients: matches.length,
          clients: matches,
        });
      } catch (err) {
        return jsonResponse({ error: (err as Error).message });
      } finally {
        httpClient?.close();
      }
    }

    // GET /diag/find-ssid?store=matriz&ssid=MINASBRASIL_CLIENTES&mac=xx:xx
    // Lists all sites on the controller, searches for the SSID in each,
    // and (optionally) tries to authorize the MAC on the site that owns the SSID.
    if (path === "/diag/find-ssid" && req.method === "GET") {
      const storeSlug = url.searchParams.get("store") || "matriz";
      const targetSsid = url.searchParams.get("ssid") || "MINASBRASIL_CLIENTES";
      const testMac = url.searchParams.get("mac") || undefined;

      const { data: store } = await supabaseAdmin()
        .from("stores")
        .select("slug, unifi_controller_url, unifi_username, unifi_password")
        .eq("slug", storeSlug)
        .maybeSingle();
      if (!store) return jsonResponse({ error: `store not found: ${storeSlug}` });

      const ctrlUrl = (store.unifi_controller_url || "").replace(/\/+$/, "");
      const user = store.unifi_username || UNIFI_USERNAME;
      const pass = store.unifi_password || UNIFI_PASSWORD;
      const httpClient = createUnifiHttpClient();

      try {
        const parsed = new URL(ctrlUrl);
        const baseUrl = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
        const login = await unifiLogin(baseUrl, httpClient, user, pass);
        if (!login.ok) return jsonResponse({ error: `login failed: ${login.error}` });

        const headers: Record<string, string> = {};
        if (login.cookie) {
          headers["Cookie"] = login.csrfToken
            ? `unifises=${login.cookie}; csrf_token=${login.csrfToken}`
            : `unifises=${login.cookie}`;
        }
        const opts: Record<string, unknown> = { method: "GET", headers, redirect: "manual" };
        if (httpClient) opts.client = httpClient;

        // 1. List all sites
        const sitesRes = await fetch(`${baseUrl}/api/self/sites`, opts as RequestInit);
        const sitesJson = await sitesRes.json().catch(() => null);
        const sites = Array.isArray(sitesJson?.data) ? sitesJson.data : [];

        // 2. For each site: list WLANs and clients with the target SSID
        const findings: Array<Record<string, unknown>> = [];
        for (const s of sites) {
          const siteName = (s as Record<string, unknown>).name as string;
          const siteDesc = (s as Record<string, unknown>).desc as string;
          const entry: Record<string, unknown> = { site_name: siteName, site_desc: siteDesc };

          // Check WLANs
          try {
            const wlanRes = await fetch(`${baseUrl}/api/s/${siteName}/rest/wlanconf`, opts as RequestInit);
            const wlanJson = await wlanRes.json().catch(() => null);
            const wlans = Array.isArray(wlanJson?.data) ? wlanJson.data : [];
            const matchingWlans = wlans
              .filter((w: Record<string, unknown>) => (w.name as string) === targetSsid)
              .map((w: Record<string, unknown>) => ({
                name: w.name,
                enabled: w.enabled,
                security: w.security,
                is_guest: w.is_guest,
                ap_group_ids: w.ap_group_ids,
              }));
            entry.wlans_matching = matchingWlans;
          } catch (e) {
            entry.wlans_error = (e as Error).message;
          }

          // Check live clients on this SSID
          try {
            const staRes = await fetch(`${baseUrl}/api/s/${siteName}/stat/sta`, opts as RequestInit);
            const staJson = await staRes.json().catch(() => null);
            const stas = Array.isArray(staJson?.data) ? staJson.data : [];
            const matchingStas = stas.filter(
              (c: Record<string, unknown>) => (c.essid as string) === targetSsid
            );
            entry.client_count_total = stas.length;
            entry.client_count_on_ssid = matchingStas.length;
            entry.sample_macs_on_ssid = matchingStas
              .slice(0, 5)
              .map((c: Record<string, unknown>) => ({
                mac: c.mac,
                authorized: c.authorized,
                ap_mac: c.ap_mac,
              }));
          } catch (e) {
            entry.sta_error = (e as Error).message;
          }

          // 3. If user passed a mac AND this site has clients on the target SSID, try authorize
          if (testMac && (entry.client_count_on_ssid as number) > 0) {
            const authResult = await unifiAuthorizeByMac(ctrlUrl, siteName, testMac, user, pass);
            entry.authorize_test = { mac: testMac, ok: authResult.ok, error: authResult.error };
          }

          findings.push(entry);
        }

        return jsonResponse({
          store: storeSlug,
          target_ssid: targetSsid,
          test_mac: testMac,
          total_sites: sites.length,
          findings,
        });
      } catch (err) {
        return jsonResponse({ error: (err as Error).message });
      } finally {
        httpClient?.close();
      }
    }

    // Temporary diagnostic — accepts GET (uses ?store=) or POST (body overrides)
    if (path === "/diag/unifi-ping" && (req.method === "GET" || req.method === "POST")) {
      const b = req.method === "POST" ? await safeParseJson(req) : null;
      const storeSlug = (b?.store as string) || url.searchParams.get("store") || "matriz";

      // Load store credentials from DB
      const { data: store, error: storeErr } = await supabaseAdmin()
        .from("stores")
        .select("slug, unifi_controller_url, unifi_username, unifi_password, unifi_site_id")
        .eq("slug", storeSlug)
        .maybeSingle();
      if (storeErr || !store) {
        return jsonResponse({ error: `store not found: ${storeSlug}`, db_error: storeErr?.message });
      }

      const ctrlUrl = ((b?.controller_url as string) || store.unifi_controller_url || "").replace(/\/+$/, "");
      const user = (b?.username as string) || store.unifi_username || UNIFI_USERNAME;
      const pass = (b?.password as string) || store.unifi_password || UNIFI_PASSWORD;

      if (!ctrlUrl) return jsonResponse({ error: "controller_url not configured" });
      if (!user || !pass) return jsonResponse({ error: "username/password not configured", has_user: !!user, has_pass: !!pass });

      const httpClient = createUnifiHttpClient();
      const out: Record<string, unknown> = {
        store: store.slug,
        controller_url: ctrlUrl,
        username_used: user,
        password_len: pass.length,
      };

      try {
        // Probe root
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), UNIFI_TIMEOUT_MS);
          const opts: Record<string, unknown> = { method: "GET", signal: ac.signal, redirect: "manual" };
          if (httpClient) opts.client = httpClient;
          const r = await fetch(`${ctrlUrl}/`, opts as RequestInit);
          clearTimeout(t);
          const body = (await r.text().catch(() => "")).slice(0, 200);
          out.root_probe = { status: r.status, server: r.headers.get("server"), set_cookie: (r.headers.get("set-cookie") || "").slice(0, 200), body_preview: body };
        } catch (e) {
          out.root_probe = { error: (e as Error).message };
        }

        // Try all known login endpoints
        const endpoints = ["/api/auth/login", "/api/login", "/proxy/network/api/login"];
        const results: Record<string, unknown> = {};
        for (const ep of endpoints) {
          const login = await unifiTryLogin(`${ctrlUrl}${ep}`, httpClient, user, pass);
          results[ep] = {
            ok: login.ok,
            error: login.error,
            has_token: !!login.token,
            has_cookie: !!login.cookie,
          };
          if (login.ok) {
            out.login_ok = true;
            out.successful_endpoint = ep;
            out.endpoints_tried = results;

            // Optional: also test authorize-guest if ?mac= provided
            const testMac = url.searchParams.get("mac") || (b?.mac as string | undefined);
            if (testMac) {
              const siteId = url.searchParams.get("site_id") || (b?.site_id as string | undefined) || store.unifi_site_id || "default";
              const authResult = await unifiAuthorizeByMac(ctrlUrl, siteId, testMac, user, pass);
              out.authorize_test = {
                mac: testMac,
                site_id: siteId,
                ok: authResult.ok,
                error: authResult.error,
              };
            }
            return jsonResponse(out);
          }
        }
        out.login_ok = false;
        out.endpoints_tried = results;
        return jsonResponse(out);
      } catch (err) {
        out.fatal_error = (err as Error).message;
        return jsonResponse(out);
      } finally {
        httpClient?.close();
      }
    }

    // Cron endpoint
    if (path === "/cron/housekeeping" && req.method === "POST") return await handleCronHousekeeping(req);

    // Admin endpoints
    if (path === "/admin/settings") return await handleAdminSettings(req);
    if (path === "/admin/stores") return await handleAdminStores(req);
    if (path === "/admin/store-ips") return await handleAdminStoreIps(req, url);
    if (path === "/admin/leads-xml" && req.method === "GET") return await handleAdminLeadsXml(req, url);
    if (path === "/admin/leads") return await handleAdminLeads(req, url);
    if (path === "/admin/consent") return await handleAdminConsent(req);
    if (path === "/admin/sessions") return await handleAdminSessions(req, url);
    if (path === "/admin/clusters") return await handleAdminClusters(req, url);
    if (path === "/admin/test-authorize" && req.method === "POST") return await handleTestAuthorize(req);
    if (path === "/admin/test-unifi-reach" && req.method === "POST") return await handleTestUnifiReach(req);
    if (path === "/admin/housekeeping" && req.method === "POST") return await handleHousekeeping(req);

    return errorResponse("Not found", 404);
  } catch (err) {
    console.error("Unhandled error:", err);
    return errorResponse("Internal server error", 500);
  }
});
