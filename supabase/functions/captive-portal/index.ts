import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

// ========== Constants ==========
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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

function safeParseJson(req: Request): Promise<Record<string, unknown> | null> {
  return req.json().catch(() => null);
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

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.secret) {
      headers["Authorization"] = `Bearer ${config.secret}`;
    }

    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        phone,
        code,
        store_name: storeName,
        store_id: storeId,
        session_id: sessionId,
        public_ip: clientIp,
        expires_at: expiresAt,
        type: "otp_verification",
      }),
    });
    if (!res.ok) {
      console.error("WhatsApp webhook HTTP error:", res.status);
      return { sent: false, error: `Webhook retornou HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error("WhatsApp webhook error:", (e as Error).message);
    return { sent: false, error: "Erro de rede ao enviar código." };
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

/** Create a Deno HTTP client that tolerates self-signed certs */
function createUnifiHttpClient(): Deno.HttpClient {
  const opts: Deno.CreateHttpClientOptions = {};
  if (UNIFI_CA_CERT) {
    opts.caCerts = [UNIFI_CA_CERT];
  }
  return Deno.createHttpClient(opts);
}

/**
 * Try login on a specific endpoint, return cookie or TOKEN header.
 */
async function unifiTryLogin(
  loginUrl: string, httpClient: Deno.HttpClient
): Promise<{ ok: boolean; cookie?: string; token?: string; error?: string; isUnifiOs?: boolean }> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), UNIFI_TIMEOUT_MS);
  try {
    const res = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: UNIFI_USERNAME, password: UNIFI_PASSWORD }),
      signal: ac.signal,
      client: httpClient,
    } as RequestInit);
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Login HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    // UniFi OS returns a TOKEN cookie; legacy returns unifises
    const setCookie = res.headers.get("set-cookie") || "";
    const tokenMatch = setCookie.match(/TOKEN=([^;]+)/);
    if (tokenMatch) {
      return { ok: true, token: tokenMatch[1], isUnifiOs: true };
    }
    const legacyMatch = setCookie.match(/unifises=([^;]+)/);
    if (legacyMatch) {
      return { ok: true, cookie: legacyMatch[1], isUnifiOs: false };
    }

    // Some UniFi OS versions return x-csrf-token header instead
    const csrfToken = res.headers.get("x-csrf-token");
    if (csrfToken) {
      return { ok: true, token: csrfToken, isUnifiOs: true };
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
  baseUrl: string, httpClient: Deno.HttpClient
): Promise<{ ok: boolean; cookie?: string; token?: string; isUnifiOs?: boolean; error?: string }> {
  // Try UniFi OS first: /api/auth/login
  const osResult = await unifiTryLogin(`${baseUrl}/api/auth/login`, httpClient);
  if (osResult.ok) {
    console.log("UniFi login succeeded via UniFi OS endpoint (/api/auth/login)");
    return osResult;
  }

  // Always try legacy /api/login as fallback (not just on 404)
  // Legacy controllers may return various errors for /api/auth/login
  console.log(`UniFi OS endpoint failed (${osResult.error?.slice(0, 100)}), trying legacy /api/login...`);
  const legacyResult = await unifiTryLogin(`${baseUrl}/api/login`, httpClient);
  if (legacyResult.ok) {
    console.log("UniFi login succeeded via legacy endpoint (/api/login)");
    return legacyResult;
  }
  return { ok: false, error: `OS: ${osResult.error} | Legacy: ${legacyResult.error}` };
}

/**
 * Authorize a guest MAC via UniFi controller (supports both OS and legacy).
 */
async function unifiAuthorizeByMac(
  controllerUrl: string, siteId: string, clientMac: string
): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = controllerUrl.replace(/\/+$/, "");
  const httpClient = createUnifiHttpClient();

  try {
    // Step 1: Login (auto-detects OS vs legacy)
    const login = await unifiLogin(baseUrl, httpClient);
    if (!login.ok) return { ok: false, error: `UniFi login failed: ${login.error}` };

    // Step 2: Authorize guest
    const formattedMac = clientMac.replace(/(.{2})(?=.)/g, "$1:").toLowerCase();
    const body = JSON.stringify({ cmd: "authorize-guest", mac: formattedMac, minutes: 15 });

    // Build auth headers based on login type
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (login.isUnifiOs && login.token) {
      headers["Cookie"] = `TOKEN=${login.token}`;
      headers["X-CSRF-Token"] = login.token;
    } else if (login.cookie) {
      headers["Cookie"] = `unifises=${login.cookie}`;
    }

    // Determine authorize URL — try OS path first if login was OS
    const authUrls = login.isUnifiOs
      ? [
          `${baseUrl}/proxy/network/api/s/${siteId}/cmd/stamgr`,
          `${baseUrl}/api/s/${siteId}/cmd/stamgr`,
        ]
      : [`${baseUrl}/api/s/${siteId}/cmd/stamgr`];

    let lastError = "";
    for (const url of authUrls) {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), UNIFI_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: ac.signal,
          client: httpClient,
        } as RequestInit);
        clearTimeout(timeout);

        const resText = await res.text();
        if (res.ok) {
          console.log(`UniFi authorize response from ${url}: ${resText.slice(0, 300)}`);
          // UniFi returns 200 even for errors — check rc field
          try {
            const resJson = JSON.parse(resText);
            if (resJson?.meta?.rc === "error") {
              lastError = `UniFi rejected: ${resJson.meta.msg || "unknown error"}`;
              console.warn(lastError);
              continue; // try next URL if available
            }
          } catch {
            // Not JSON — treat HTTP 200 as success
          }
          console.log(`UniFi authorize succeeded via ${url}`);
          return { ok: true };
        }
        lastError = `HTTP ${res.status}: ${resText.slice(0, 200)}`;
        console.warn(`UniFi authorize failed at ${url}: ${lastError}`);
        // If 404, try next URL
        if (res.status === 404) continue;
        return { ok: false, error: lastError };
      } catch (err) {
        clearTimeout(timeout);
        lastError = (err as Error).name === "AbortError"
          ? `Timeout after ${UNIFI_TIMEOUT_MS}ms`
          : (err as Error).message;
        console.warn(`UniFi authorize error at ${url}: ${lastError}`);
      }
    }
    return { ok: false, error: lastError };
  } finally {
    httpClient.close();
  }
}

async function unifiAuthorizeWithRetry(
  controllerUrl: string, siteId: string, mac: string
): Promise<{ ok: boolean; error?: string; attempts: number }> {
  let lastError = "";
  for (let attempt = 0; attempt <= UNIFI_RETRY_COUNT; attempt++) {
    const result = await unifiAuthorizeByMac(controllerUrl, siteId, mac);
    if (result.ok) return { ok: true, attempts: attempt + 1 };
    lastError = result.error || "Unknown error";
    if (attempt < UNIFI_RETRY_COUNT) await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, error: lastError, attempts: UNIFI_RETRY_COUNT + 1 };
}

async function authorizeClient(
  db: ReturnType<typeof supabaseAdmin>,
  storeId: string | null, storeSlug: string, clientMac: string | null, sessionId: string, clientIp: string
): Promise<boolean> {
  if (!storeId) {
    await db.from("captive_sessions").update({ status: "failed", fail_reason: "NO_STORE_CONFIGURED" }).eq("id", sessionId);
    return false;
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
    return false;
  }

  if (!UNIFI_USERNAME || !UNIFI_PASSWORD) {
    await db.from("captive_sessions").update({ status: "failed", fail_reason: "UNIFI_CREDENTIALS_MISSING" }).eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId, entity: "session", entity_id: sessionId,
      action: "fail", meta: { reason: "UNIFI_CREDENTIALS_MISSING", store_slug: storeSlug, ip: clientIp },
    });
    return false;
  }

  if (!clientMac || !isValidMac(clientMac)) {
    await db.from("captive_sessions").update({ status: "failed", fail_reason: "INVALID_MAC_ADDRESS" }).eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId, entity: "session", entity_id: sessionId,
      action: "fail", meta: { reason: "INVALID_MAC_ADDRESS", mac: clientMac, store_slug: storeSlug, ip: clientIp },
    });
    return false;
  }

  const siteId = store.unifi_site_id || "default";
  const result = await unifiAuthorizeWithRetry(store.unifi_controller_url, siteId, clientMac);

  if (result.ok) {
    await db.from("captive_sessions").update({ status: "authorized", authorized_at: new Date().toISOString() }).eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId, entity: "session", entity_id: sessionId,
      action: "authorize", meta: { mac: clientMac, store_slug: storeSlug, ip: clientIp, attempts: result.attempts },
    });
    return true;
  } else {
    const failReason = result.error?.slice(0, 500) || "UNKNOWN";
    await db.from("captive_sessions").update({ status: "failed", fail_reason: failReason }).eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId, entity: "session", entity_id: sessionId,
      action: "fail", meta: { reason: failReason, mac: clientMac, store_slug: storeSlug, ip: clientIp, attempts: result.attempts },
    });
    return false;
  }
}

// ========== Route Handlers ==========

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
  const clientIp = getPublicIp(req) || "unknown";
  const db = supabaseAdmin();

  // Distributed rate limit
  const rl = await checkRateLimitDb(db, `ip:${clientIp}`, 60, 20, 120);
  if (!rl.allowed) return errorResponse("Muitas requisições. Aguarde um momento.", 429);

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  // Detect store: ?store=slug > IP mapping > single active store
  const detected = await detectStoreFromRequest(db, req);

  const mac = normalizeMac(body.client_mac);
  const apMac = normalizeMac(body.ap_mac);

  const { data: session, error } = await db
    .from("captive_sessions")
    .insert({
      store_id: detected.store_id,
      client_mac: mac,
      client_ip: sanitizeString(body.client_ip, 45) || clientIp,
      ap_mac: apMac,
      ssid: sanitizeString(body.ssid, 64),
      user_agent: sanitizeString(body.user_agent, 500) || req.headers.get("user-agent")?.slice(0, 500),
      redirect_url: sanitizeString(body.redirect_url, 2000),
      status: "started",
    })
    .select("id")
    .single();

  if (error) {
    console.error("Session insert error:", error.message);
    return errorResponse("Erro ao iniciar sessão", 500);
  }

  await db.from("audit_logs").insert({
    store_id: detected.store_id, entity: "session", entity_id: session.id,
    action: "create", meta: { client_mac: mac, ip: clientIp, store_slug: detected.store_slug },
  });

  return jsonResponse({ session_id: session.id });
}

async function handleSubmit(req: Request): Promise<Response> {
  const clientIp = getPublicIp(req);
  const clientIpStr = clientIp || "unknown";
  const db = supabaseAdmin();

  // Distributed rate limits
  const rlIp = await checkRateLimitDb(db, `submit:ip:${clientIpStr}`, 60, 5, 120);
  if (!rlIp.allowed) return errorResponse("Muitas tentativas. Aguarde um minuto.", 429);

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  const name = sanitizeString(body.name, MAX_NAME_LEN);
  if (!name) return errorResponse("Nome é obrigatório");

  const email = sanitizeString(body.email, MAX_EMAIL_LEN);
  const phone = sanitizeString(body.phone, MAX_PHONE_LEN);
  const cpf = sanitizeString(body.cpf, 20);

  if (!cpf) return errorResponse("CPF é obrigatório");
  if (!phone || !isValidPhone(phone)) return errorResponse("Telefone válido é obrigatório");
  if (email && !isValidEmail(email)) return errorResponse("E-mail inválido");

  const consentVersion = sanitizeString(body.consent_version, 20);
  if (!consentVersion) return errorResponse("Consentimento é obrigatório");

  const sessionId = body.session_id;
  if (sessionId && !isValidUUID(sessionId)) return errorResponse("session_id inválido");

  const clientMac = normalizeMac(body.client_mac);

  // Rate limit by MAC too
  if (clientMac) {
    const rlMac = await checkRateLimitDb(db, `submit:mac:${clientMac}`, 60, 5, 120);
    if (!rlMac.allowed) return errorResponse("Muitas tentativas para este dispositivo.", 429);
  }

  // Detect store: ?store=slug > IP mapping > single active store
  const detected = await detectStoreFromRequest(db, req);
  const storeId = detected.store_id;
  const storeSlug = detected.store_slug;
  const redirectUrl = detected.redirect_url;

  // Validate consent
  const { data: consent } = await db.from("consent_versions").select("version, text").eq("version", consentVersion).maybeSingle();
  if (!consent) return errorResponse("Versão de consentimento inválida");

  // Dedup check
  const dedupKey = `${storeId || "none"}:${clientMac || clientIpStr}`;
  if (isDuplicate(dedupKey)) return errorResponse("Cadastro duplicado detectado. Aguarde alguns segundos.", 429);

  // Consent text hash
  const consentTextHash = consent.text
    ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(consent.text)).then((buf) =>
        Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("")
      )
    : null;

  // GeoIP enrichment
  let geoData: GeoIpData & { source: string } = { city: null, region: null, country: null, isp: null, asn: null, source: "none" };
  if (clientIp) {
    try { geoData = await enrichGeoIp(db, clientIp); } catch (e) {
      console.warn("GeoIP enrichment failed:", (e as Error).message);
    }
  }

  // Create lead (idempotent: check if already exists for this session)
  let leadId: string;
  if (sessionId) {
    const { data: existingLead } = await db
      .from("leads")
      .select("id")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (existingLead) {
      leadId = existingLead.id;
    } else {
      const { data: lead, error: leadError } = await db.from("leads").insert({
        store_id: storeId, session_id: sessionId || null, name,
        email: email || null, phone: phone || null, cpf: cpf || null, client_mac: clientMac,
        consented_at: new Date().toISOString(), consent_version: consentVersion,
        consent_text_hash: consentTextHash, source: "captive_portal",
        origin_ip: clientIp, origin_city: geoData.city, origin_region: geoData.region,
        origin_country: geoData.country, origin_isp: geoData.isp, origin_asn: geoData.asn,
        origin_source: geoData.source,
      }).select("id").single();
      if (leadError) {
        console.error("Lead insert error:", leadError.message);
        return errorResponse("Erro ao salvar cadastro. Tente novamente.", 500);
      }
      leadId = lead.id;
    }
  } else {
    const { data: lead, error: leadError } = await db.from("leads").insert({
      store_id: storeId, session_id: null, name,
      email: email || null, phone: phone || null, cpf: cpf || null, client_mac: clientMac,
      consented_at: new Date().toISOString(), consent_version: consentVersion,
      consent_text_hash: consentTextHash, source: "captive_portal",
      origin_ip: clientIp, origin_city: geoData.city, origin_region: geoData.region,
      origin_country: geoData.country, origin_isp: geoData.isp, origin_asn: geoData.asn,
      origin_source: geoData.source,
    }).select("id").single();
    if (leadError) {
      console.error("Lead insert error:", leadError.message);
      return errorResponse("Erro ao salvar cadastro. Tente novamente.", 500);
    }
    leadId = lead.id;
  }

  // Increment cluster
  if (clientIp) {
    incrementClusterLeadCount(db, clientIp).catch((e) =>
      console.warn("incrementClusterLeadCount failed:", (e as Error).message)
    );
  }

  // Update session
  if (sessionId) {
    await db.from("captive_sessions")
      .update({ status: "submitted", submitted_at: new Date().toISOString(), client_mac: clientMac })
      .eq("id", sessionId);
  }

  // Generate OTP code
  const otpCode = generateOtpCode();
  const otpHash = await hashOtp(otpCode);
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_SECONDS * 1000).toISOString();

  // Expire any existing pending for this session
  if (sessionId) {
    await db.from("captive_verifications")
      .update({ status: "expired" })
      .eq("session_id", sessionId)
      .eq("status", "pending");
  }

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
    console.error("Verification insert error:", verError.message);
  }

  // Send WhatsApp code via DB config
  const storeName = detected.store_name || "Drogaria Minas Brasil";
  const whatsappResult = await sendWhatsAppCode(db, storeId, phone, otpCode, storeName, sessionId as string | null, clientIp, expiresAt);

  if (!whatsappResult.sent) {
    console.warn("WhatsApp code not sent:", whatsappResult.error);
    // Don't fail the flow — lead is saved, verification is pending
    // but warn the user
  }

  await db.from("audit_logs").insert({
    store_id: storeId, entity: "lead", entity_id: leadId,
    action: "create", meta: { session_id: sessionId, mac: clientMac, ip: clientIpStr, store_slug: storeSlug, origin_city: geoData.city, whatsapp_sent: whatsappResult.sent },
  });

  const resolvedRedirectUrl = redirectUrl || DEFAULT_REDIRECT_URL;

  return jsonResponse({
    ok: true,
    authorized: false,
    redirect_url: resolvedRedirectUrl,
    requires_verification: true,
    message: whatsappResult.sent
      ? "Código de verificação enviado para seu WhatsApp."
      : "Cadastro salvo. " + (whatsappResult.error || "Código não pôde ser enviado."),
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
  const clientIp = getPublicIp(req) || "unknown";
  const db = supabaseAdmin();

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  const sessionId = body.session_id;
  if (!isValidUUID(sessionId)) return errorResponse("session_id inválido");

  const code = sanitizeString(body.code, 6);
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) return errorResponse("Código inválido");

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
    return errorResponse("Código expirado. Solicite um novo.", 410);
  }

  // Check attempts
  if (verification.attempts >= OTP_MAX_ATTEMPTS) {
    await db.from("captive_verifications").update({ status: "locked" }).eq("id", verification.id);
    return errorResponse("Número máximo de tentativas atingido.", 429);
  }

  // Increment attempts
  await db.from("captive_verifications").update({ attempts: verification.attempts + 1 }).eq("id", verification.id);

  // Verify hash
  const inputHash = await hashOtp(code);
  if (inputHash !== verification.code_hash) {
    const remaining = OTP_MAX_ATTEMPTS - verification.attempts - 1;
    return errorResponse(`Código incorreto. ${remaining} tentativa(s) restante(s).`);
  }

  // Code is correct!
  await db.from("captive_verifications").update({
    status: "verified",
    verified_at: new Date().toISOString(),
  }).eq("id", verification.id);

  // Authorize client via UniFi
  const { data: session } = await db
    .from("captive_sessions")
    .select("client_mac, store_id, redirect_url")
    .eq("id", sessionId as string)
    .maybeSingle();

  let authorized = false;
  let redirectUrl: string | null = null;

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
      // Check daily authorization limit (max 2 per MAC per day)
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const { count: dailyAuthCount } = await db
        .from("captive_sessions")
        .select("id", { count: "exact", head: true })
        .eq("client_mac", session.client_mac)
        .eq("status", "authorized")
        .gte("authorized_at", todayStart.toISOString());

      if ((dailyAuthCount ?? 0) >= 2) {
        console.warn(`[verify-code] Daily auth limit reached for MAC ${session.client_mac} (count=${dailyAuthCount})`);
        await db.from("captive_sessions")
          .update({ status: "failed", fail_reason: "DAILY_LIMIT_REACHED" })
          .eq("id", sessionId as string);
      } else {
        try {
          authorized = await authorizeClient(db, storeId, storeSlug, session.client_mac, sessionId as string, clientIp);
        } catch (err) {
          console.error("UniFi authorization error:", (err as Error).message);
        }
      }
    } else {
      // Log why authorization was skipped
      const reason = !storeId ? "store_id missing" : "client_mac missing";
      console.warn(`[verify-code] UniFi authorization skipped: ${reason} (session=${sessionId})`);

      // Mark as "submitted" (verified but not authorized) instead of falsely "authorized"
      await db.from("captive_sessions")
        .update({ status: "submitted", fail_reason: `SKIPPED:${reason}` })
        .eq("id", sessionId as string);
    }
  }

  const resolvedRedirectUrl = redirectUrl || session?.redirect_url || DEFAULT_REDIRECT_URL;

  // Check if daily limit was the reason for no authorization
  const dailyLimitReached = !authorized && session?.client_mac && storeId
    ? (await db.from("captive_sessions").select("fail_reason").eq("id", sessionId as string).maybeSingle())?.data?.fail_reason === "DAILY_LIMIT_REACHED"
    : false;

  let message: string;
  if (authorized) {
    message = "Código verificado! Acesso liberado.";
  } else if (dailyLimitReached) {
    message = "Você atingiu o limite de 2 acessos por dia. Tente novamente amanhã.";
  } else if (!session?.client_mac) {
    message = "Cadastro salvo! Para liberar o WiFi, reconecte à rede.";
  } else {
    message = "Cadastro salvo! Houve um problema na liberação automática. Tente reconectar ao WiFi.";
  }

  return jsonResponse({
    ok: true,
    authorized,
    redirect_url: resolvedRedirectUrl,
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
    httpClient.close();
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
  const clientMac = (qp.get("id") || qp.get("mac") || "").replace(/'/g, "");
  const redirectParam = (qp.get("url") || "").replace(/'/g, "");
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
var API='${API_BASE}';
var clientMac='${clientMac}';
var sessionId=null;
var consentVersion='offline-fallback';
var redirectUrl='${redirectParam}'||null;
var resendTimer=null,resendSeconds=0;
var form=document.getElementById('portal-form');
var consentCheck=document.getElementById('consent-check');
var submitBtn=document.getElementById('submit-btn');
var errorDiv=document.getElementById('error-msg');
consentCheck.addEventListener('change',function(){submitBtn.disabled=!consentCheck.checked;});
function req(method,path,body,cb,timeout){
var x=new XMLHttpRequest();x.open(method,API+path,true);
x.setRequestHeader('Content-Type','application/json');x.timeout=timeout||15000;
x.onload=function(){try{cb(null,JSON.parse(x.responseText));}catch(e){cb('Erro ao processar.');}};
x.onerror=x.ontimeout=function(){cb('Erro de conex\\u00e3o.');};
x.send(body?JSON.stringify(body):null);
}
req('GET','/bootstrap',null,function(e,d){
if(d&&d.store&&d.store.name){document.getElementById('store-info').textContent=d.store.city?d.store.name+' \\u2014 '+d.store.city:d.store.name;}
if(d&&d.consent){document.getElementById('consent-text').textContent=d.consent.text;consentVersion=d.consent.version||consentVersion;}
},5000);
req('POST','/start',{client_mac:clientMac,user_agent:navigator.userAgent},function(e,d){if(d&&d.session_id)sessionId=d.session_id;},6000);
function showErr(el,m){el.textContent=m;el.style.display='block';}
function hideErr(el){el.style.display='none';}
form.addEventListener('submit',function(ev){
ev.preventDefault();hideErr(errorDiv);submitBtn.disabled=true;submitBtn.textContent='Enviando...';
var fd=new FormData(form);
req('POST','/submit',{session_id:sessionId,name:fd.get('name'),email:fd.get('email')||'',phone:fd.get('phone'),cpf:fd.get('cpf'),client_mac:clientMac,consent_version:consentVersion},function(err,r){
if(err){showErr(errorDiv,err);submitBtn.disabled=false;submitBtn.textContent='Conectar ao Wi-Fi';return;}
if(r.error){showErr(errorDiv,r.error);submitBtn.disabled=false;submitBtn.textContent='Conectar ao Wi-Fi';return;}
if(r.requires_verification){redirectUrl=r.redirect_url||redirectUrl;showOtp(fd.get('phone'));return;}
redirectUrl=r.redirect_url||redirectUrl;showSuccess(r.message||'Cadastro realizado!',!!r.authorized);
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
req('POST','/verify-code',{session_id:sessionId,code:code},function(err,r){
if(err){showErr(oe,err);btn.disabled=false;btn.textContent='Verificar c\\u00f3digo';return;}
if(r.error){showErr(oe,r.error);btn.disabled=false;btn.textContent='Verificar c\\u00f3digo';document.querySelectorAll('.otp-input').forEach(function(i){i.value='';});document.querySelector('.otp-input').focus();return;}
redirectUrl=r.redirect_url||redirectUrl;showSuccess(r.message||'C\\u00f3digo verificado!',true);
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
if(redirectUrl){document.getElementById('success-redirect').style.display='block';document.getElementById('redirect-link').href=redirectUrl;if(auth)setTimeout(function(){location.replace(redirectUrl);},1500);}
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

// ========== Main Router ==========

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/captive-portal/, "");

  try {
    // Self-contained HTML portal (for captive assistant that can't reach Vercel)
    // Also handle UniFi's /guest/s/default/ redirect path as an alias
    if (
      (path === "/portal" || path === "/portal/" || path.startsWith("/guest/s/")) &&
      req.method === "GET"
    ) return await handlePortalHtml(req, url);

    // Public portal endpoints
    if (path === "/bootstrap" && req.method === "GET") return await handleBootstrap(req);
    if (path === "/start" && req.method === "POST") return await handleStart(req);
    if (path === "/submit" && req.method === "POST") return await handleSubmit(req);
    if (path === "/request-code" && req.method === "POST") return await handleRequestCode(req);
    if (path === "/verify-code" && req.method === "POST") return await handleVerifyCode(req);

    // Temporary diagnostic — remove after testing
    if (path === "/diag/unifi-ping" && req.method === "POST") {
      const b = await safeParseJson(req);
      const ctrlUrl = (b?.controller_url as string || "").replace(/\/+$/, "");
      if (!ctrlUrl) return errorResponse("controller_url required");
      const httpClient = createUnifiHttpClient();
      try {
        // First do a simple GET to see what the controller returns
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), UNIFI_TIMEOUT_MS);
        let rootInfo = "";
        try {
          const rootRes = await fetch(ctrlUrl, { signal: ac.signal, client: httpClient } as RequestInit);
          clearTimeout(t);
          rootInfo = `GET / → ${rootRes.status}, headers: ${JSON.stringify(Object.fromEntries([...rootRes.headers.entries()].slice(0, 10)))}`;
        } catch (e) {
          clearTimeout(t);
          rootInfo = `GET / error: ${(e as Error).message}`;
        }

        // Try all known login endpoints
        const endpoints = [
          "/api/auth/login",           // UniFi OS
          "/api/login",                // Legacy standalone
          "/proxy/network/api/login",  // UDM Network app
        ];
        const results: Record<string, string> = {};
        for (const ep of endpoints) {
          const login = await unifiTryLogin(`${ctrlUrl}${ep}`, httpClient);
          if (login.ok) {
            return jsonResponse({ reachable: true, type: ep, login_ok: true, has_token: !!login.token, has_cookie: !!login.cookie, root: rootInfo });
          }
          results[ep] = login.error || "unknown error";
        }
        return jsonResponse({ reachable: true, login_ok: false, endpoints_tried: results, root: rootInfo });
      } catch (err) {
        return jsonResponse({ reachable: false, error: (err as Error).message });
      } finally {
        httpClient.close();
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
