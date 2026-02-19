import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

// ========== Constants ==========
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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
  // IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip.split(".").every((part) => parseInt(part) <= 255);
  }
  // IPv6 (basic check)
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":")) return true;
  return false;
}

// Legacy helper (kept for compat)
function getClientIp(req: Request): string {
  return getPublicIp(req) || "unknown";
}

function safeParseJson(req: Request): Promise<Record<string, unknown> | null> {
  return req.json().catch(() => null);
}

// ========== Rate Limiting (in-memory, per instance) ==========
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_SUBMIT = 5;
const RATE_LIMIT_MAX_START = 20;

function checkRateLimit(key: string, max: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  if (entry.count > max) return true;
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 120_000);

// ========== Dedup Map ==========
const dedupMap = new Map<string, number>();

function isDuplicate(mac: string, storeId: string): boolean {
  const key = `${storeId}:${mac}`;
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
    // ipapi.co response fields
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
  // Check cache
  const { data: cached } = await db
    .from("origin_ip_clusters")
    .select("city, region, country, isp, asn, last_geoip_at")
    .eq("public_ip", ip)
    .maybeSingle();

  if (cached && cached.last_geoip_at) {
    const ageHours = (Date.now() - new Date(cached.last_geoip_at).getTime()) / 3_600_000;
    if (ageHours < GEOIP_CACHE_TTL_HOURS) {
      return {
        city: cached.city,
        region: cached.region,
        country: cached.country,
        isp: cached.isp,
        asn: cached.asn,
        source: "cache",
      };
    }
  }

  // Fetch from provider
  const geoData = await fetchGeoIp(ip);

  if (geoData) {
    // Upsert cluster with GeoIP data
    await db.from("origin_ip_clusters").upsert(
      {
        public_ip: ip,
        city: geoData.city,
        region: geoData.region,
        country: geoData.country,
        isp: geoData.isp,
        asn: geoData.asn,
        last_seen_at: new Date().toISOString(),
        last_geoip_at: new Date().toISOString(),
        geoip_provider: GEOIP_PROVIDER,
      },
      { onConflict: "public_ip", ignoreDuplicates: false }
    );
    return { ...geoData, source: "geoip" };
  }

  // GeoIP failed — still upsert cluster (no geo data) to track IP
  await db.from("origin_ip_clusters").upsert(
    {
      public_ip: ip,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "public_ip", ignoreDuplicates: false }
  );

  return { city: null, region: null, country: null, isp: null, asn: null, source: "none" };
}

/** Increment lead_count on cluster */
async function incrementClusterLeadCount(db: ReturnType<typeof supabaseAdmin>, ip: string) {
  try {
    // We use a raw RPC-free approach: fetch current and update
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

// ========== UniFi Provider ==========
async function unifiAuthorizeByMac(
  controllerUrl: string,
  apiKeyOrToken: string,
  siteId: string,
  clientMac: string
): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = controllerUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/proxy/network/api/s/${siteId}/cmd/stamgr`;
  const formattedMac = clientMac.replace(/(.{2})(?=.)/g, "$1:").toLowerCase();
  const body = JSON.stringify({
    cmd: "authorize-guest",
    mac: formattedMac,
    minutes: 1440,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": apiKeyOrToken,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UNIFI_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const resText = await res.text();

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${resText.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (err) {
    clearTimeout(timeout);
    const msg = (err as Error).name === "AbortError"
      ? `Timeout after ${UNIFI_TIMEOUT_MS}ms`
      : (err as Error).message;
    return { ok: false, error: msg };
  }
}

async function unifiAuthorizeWithRetry(
  controllerUrl: string,
  token: string,
  siteId: string,
  mac: string
): Promise<{ ok: boolean; error?: string; attempts: number }> {
  let lastError = "";
  for (let attempt = 0; attempt <= UNIFI_RETRY_COUNT; attempt++) {
    const result = await unifiAuthorizeByMac(controllerUrl, token, siteId, mac);
    if (result.ok) return { ok: true, attempts: attempt + 1 };
    lastError = result.error || "Unknown error";
    if (attempt < UNIFI_RETRY_COUNT) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return { ok: false, error: lastError, attempts: UNIFI_RETRY_COUNT + 1 };
}

async function authorizeClient(
  db: ReturnType<typeof supabaseAdmin>,
  storeId: string | null,
  storeSlug: string,
  clientMac: string | null,
  sessionId: string,
  clientIp: string
): Promise<boolean> {
  if (!storeId) {
    await db.from("captive_sessions")
      .update({ status: "failed", fail_reason: "NO_STORE_CONFIGURED" })
      .eq("id", sessionId);
    return false;
  }

  const { data: store } = await db
    .from("stores")
    .select("unifi_controller_url, unifi_api_key_or_token, unifi_site_id")
    .eq("id", storeId)
    .maybeSingle();

  if (!store?.unifi_controller_url || !store?.unifi_api_key_or_token) {
    await db.from("captive_sessions")
      .update({ status: "failed", fail_reason: "UNIFI_NOT_CONFIGURED" })
      .eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId,
      entity: "session",
      entity_id: sessionId,
      action: "fail",
      meta: { reason: "UNIFI_NOT_CONFIGURED", store_slug: storeSlug, ip: clientIp },
    });
    return false;
  }

  if (!clientMac || !isValidMac(clientMac)) {
    await db.from("captive_sessions")
      .update({ status: "failed", fail_reason: "INVALID_MAC_ADDRESS" })
      .eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId,
      entity: "session",
      entity_id: sessionId,
      action: "fail",
      meta: { reason: "INVALID_MAC_ADDRESS", mac: clientMac, store_slug: storeSlug, ip: clientIp },
    });
    return false;
  }

  const siteId = store.unifi_site_id || "default";
  const result = await unifiAuthorizeWithRetry(
    store.unifi_controller_url,
    store.unifi_api_key_or_token,
    siteId,
    clientMac
  );

  if (result.ok) {
    await db.from("captive_sessions")
      .update({ status: "authorized", authorized_at: new Date().toISOString() })
      .eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId,
      entity: "session",
      entity_id: sessionId,
      action: "authorize",
      meta: { mac: clientMac, store_slug: storeSlug, ip: clientIp, attempts: result.attempts },
    });
    return true;
  } else {
    const failReason = result.error?.slice(0, 500) || "UNKNOWN";
    await db.from("captive_sessions")
      .update({ status: "failed", fail_reason: failReason })
      .eq("id", sessionId);
    await db.from("audit_logs").insert({
      store_id: storeId,
      entity: "session",
      entity_id: sessionId,
      action: "fail",
      meta: {
        reason: failReason,
        mac: clientMac,
        store_slug: storeSlug,
        ip: clientIp,
        attempts: result.attempts,
      },
    });
    return false;
  }
}

// ========== Route Handlers ==========

async function handleBootstrap(url: URL): Promise<Response> {
  const db = supabaseAdmin();
  const rawSlug = url.searchParams.get("store") || url.searchParams.get("s");

  // Fetch active consent (always needed)
  const { data: consent } = await db
    .from("consent_versions")
    .select("version, text")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // If no store provided, return generic bootstrap
  if (!rawSlug) {
    return jsonResponse({
      store: { slug: null, name: "Wi-Fi Drogaria Minas Brasil", city: null },
      consent: consent || null,
      required_fields: {
        name: { required: true },
        email: { required: false },
        phone: { required: false },
        at_least_one_contact: true,
      },
    });
  }

  const slug = sanitizeString(rawSlug, MAX_SLUG_LEN);
  if (!slug || !isValidSlug(slug)) return errorResponse("Invalid store slug");

  const { data: store } = await db
    .from("stores")
    .select("id, slug, name, city, is_active")
    .eq("slug", slug)
    .maybeSingle();

  if (!store) {
    // Store not found — still return generic so portal can work
    return jsonResponse({
      store: { slug, name: "Wi-Fi Drogaria Minas Brasil", city: null },
      consent: consent || null,
      required_fields: {
        name: { required: true },
        email: { required: false },
        phone: { required: false },
        at_least_one_contact: true,
      },
    });
  }

  if (!store.is_active) return errorResponse("Esta loja está temporariamente indisponível.", 403);

  return jsonResponse({
    store: { slug: store.slug, name: store.name, city: store.city },
    consent: consent || null,
    required_fields: {
      name: { required: true },
      email: { required: false },
      phone: { required: false },
      at_least_one_contact: true,
    },
  });
}

async function handleStart(req: Request): Promise<Response> {
  const clientIp = getPublicIp(req) || "unknown";

  if (checkRateLimit(`start:${clientIp}`, RATE_LIMIT_MAX_START)) {
    return errorResponse("Muitas requisições. Aguarde um momento.", 429);
  }

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  const db = supabaseAdmin();

  // Try to resolve store (optional)
  let storeId: string | null = null;
  const storeSlug = sanitizeString(body.store_slug, MAX_SLUG_LEN);

  if (storeSlug && isValidSlug(storeSlug)) {
    const { data: store } = await db
      .from("stores")
      .select("id, is_active")
      .eq("slug", storeSlug)
      .maybeSingle();
    if (store?.is_active) storeId = store.id;
  }

  const mac = normalizeMac(body.client_mac);
  const apMac = normalizeMac(body.ap_mac);

  const { data: session, error } = await db
    .from("captive_sessions")
    .insert({
      store_id: storeId,
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
    store_id: storeId,
    entity: "session",
    entity_id: session.id,
    action: "create",
    meta: { client_mac: mac, ip: clientIp, store_slug: storeSlug },
  });

  return jsonResponse({ session_id: session.id });
}

async function handleSubmit(req: Request): Promise<Response> {
  const clientIp = getPublicIp(req);
  const clientIpStr = clientIp || "unknown";

  if (checkRateLimit(`submit:${clientIpStr}`, RATE_LIMIT_MAX_SUBMIT)) {
    return errorResponse("Muitas tentativas. Aguarde um minuto.", 429);
  }

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  // Validate required fields
  const name = sanitizeString(body.name, MAX_NAME_LEN);
  if (!name) return errorResponse("Nome é obrigatório");

  const email = sanitizeString(body.email, MAX_EMAIL_LEN);
  const phone = sanitizeString(body.phone, MAX_PHONE_LEN);

  if (!email && !phone) return errorResponse("Informe ao menos e-mail ou telefone");
  if (email && !isValidEmail(email)) return errorResponse("E-mail inválido");
  if (phone && !isValidPhone(phone)) return errorResponse("Telefone inválido");

  const consentVersion = sanitizeString(body.consent_version, 20);
  if (!consentVersion) return errorResponse("Consentimento é obrigatório");

  const sessionId = body.session_id;
  if (sessionId && !isValidUUID(sessionId)) return errorResponse("session_id inválido");

  const clientMac = normalizeMac(body.client_mac);
  if (body.client_mac && !clientMac) {
    console.warn("Invalid MAC provided:", typeof body.client_mac === "string" ? body.client_mac.slice(0, 20) : "non-string");
  }

  const db = supabaseAdmin();

  // Resolve store (optional)
  let storeId: string | null = null;
  let storeSlug = sanitizeString(body.store_slug, MAX_SLUG_LEN) || "geral";
  let redirectUrl: string | null = null;

  const rawSlug = sanitizeString(body.store_slug, MAX_SLUG_LEN);
  if (rawSlug && isValidSlug(rawSlug)) {
    const { data: store } = await db
      .from("stores")
      .select("id, is_active, post_auth_redirect_url")
      .eq("slug", rawSlug)
      .maybeSingle();
    if (store?.is_active) {
      storeId = store.id;
      storeSlug = rawSlug;
      redirectUrl = store.post_auth_redirect_url || null;
    }
  }

  // Validate consent version
  const { data: consent } = await db
    .from("consent_versions")
    .select("version, text")
    .eq("version", consentVersion)
    .maybeSingle();

  if (!consent) return errorResponse("Versão de consentimento inválida");

  // Dedup check
  if (clientMac && storeId && isDuplicate(clientMac, storeId)) {
    return errorResponse("Cadastro duplicado detectado. Aguarde alguns segundos.", 429);
  }

  // Compute consent text hash
  const consentTextHash = consent.text
    ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(consent.text)).then((buf) =>
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
      )
    : null;

  // GeoIP enrichment (non-blocking — won't fail the request)
  let geoData: GeoIpData & { source: string } = {
    city: null, region: null, country: null, isp: null, asn: null, source: "none"
  };

  if (clientIp) {
    try {
      geoData = await enrichGeoIp(db, clientIp);
    } catch (e) {
      console.warn("GeoIP enrichment failed:", (e as Error).message);
    }
  }

  // Create lead — MUST succeed even if UniFi/GeoIP fails
  const { data: lead, error: leadError } = await db
    .from("leads")
    .insert({
      store_id: storeId,
      session_id: sessionId || null,
      name,
      email: email || null,
      phone: phone || null,
      client_mac: clientMac,
      consented_at: new Date().toISOString(),
      consent_version: consentVersion,
      consent_text_hash: consentTextHash,
      source: "captive_portal",
      origin_ip: clientIp,
      origin_city: geoData.city,
      origin_region: geoData.region,
      origin_country: geoData.country,
      origin_isp: geoData.isp,
      origin_asn: geoData.asn,
      origin_source: geoData.source,
    })
    .select("id")
    .single();

  if (leadError) {
    console.error("Lead insert error:", leadError.message);
    await db.from("audit_logs").insert({
      store_id: storeId,
      entity: "lead",
      entity_id: null,
      action: "fail",
      meta: {
        error_message: leadError.message.slice(0, 300),
        ip: clientIpStr,
        store_slug: storeSlug,
        mac: clientMac,
      },
    });
    return errorResponse("Erro ao salvar cadastro. Tente novamente.", 500);
  }

  // Increment cluster lead count (fire-and-forget)
  if (clientIp) {
    incrementClusterLeadCount(db, clientIp).catch((e) =>
      console.warn("incrementClusterLeadCount failed:", (e as Error).message)
    );
  }

  // Update session status
  if (sessionId) {
    await db.from("captive_sessions")
      .update({
        status: "submitted",
        submitted_at: new Date().toISOString(),
        client_mac: clientMac,
      })
      .eq("id", sessionId);
  }

  // Audit lead creation
  await db.from("audit_logs").insert({
    store_id: storeId,
    entity: "lead",
    entity_id: lead.id,
    action: "create",
    meta: { session_id: sessionId, mac: clientMac, ip: clientIpStr, store_slug: storeSlug, origin_city: geoData.city },
  });

  // Attempt UniFi authorization (non-blocking for lead)
  let authorized = false;
  if (sessionId && clientMac && storeId) {
    try {
      authorized = await authorizeClient(db, storeId, storeSlug, clientMac, sessionId as string, clientIpStr);
    } catch (err) {
      console.error("UniFi authorization error:", (err as Error).message);
      await db.from("audit_logs").insert({
        store_id: storeId,
        entity: "session",
        entity_id: sessionId,
        action: "fail",
        meta: {
          reason: "UNIFI_EXCEPTION",
          error_message: (err as Error).message.slice(0, 300),
          mac: clientMac,
          ip: clientIpStr,
          store_slug: storeSlug,
        },
      });
    }
  }

  const resolvedRedirectUrl = redirectUrl || DEFAULT_REDIRECT_URL;

  await db.from("audit_logs").insert({
    store_id: storeId,
    entity: "session",
    entity_id: sessionId || null,
    action: "redirect",
    meta: { store_slug: storeSlug, redirect_url: resolvedRedirectUrl, authorized },
  });

  return jsonResponse({
    ok: true,
    authorized,
    redirect_url: resolvedRedirectUrl,
    message: authorized
      ? "Acesso liberado! Você já pode navegar."
      : "Cadastro realizado. Caso a internet não libere automaticamente, desconecte e reconecte ao WiFi.",
  });
}

// ========== Admin Endpoints ==========

async function requireAdmin(req: Request): Promise<{ db: ReturnType<typeof supabaseAdmin>; userId: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Unauthorized", 401);
  }

  const authClient = supabaseAuth(authHeader);
  const token = authHeader.replace("Bearer ", "");

  const { data: userData, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userData?.user) {
    if (userErr) console.warn("Auth error:", userErr.message);
    return errorResponse("Unauthorized", 401);
  }

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

async function handleAdminStores(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  if (req.method === "GET") {
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

    const { data, error } = await db
      .from("stores")
      .insert({
        slug,
        name,
        city: sanitizeString(body.city, 100) || null,
        is_active: body.is_active === false ? false : true,
        post_auth_redirect_url: sanitizeString(body.post_auth_redirect_url, 500) || null,
        unifi_site_id: sanitizeString(body.unifi_site_id, 100) || null,
        unifi_controller_url: sanitizeString(body.unifi_controller_url, 500) || null,
        unifi_api_key_or_token: typeof body.unifi_api_key_or_token === "string"
          ? body.unifi_api_key_or_token.trim().slice(0, 500) || null
          : null,
      })
      .select("id, slug, name")
      .single();
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data, 201);
  }

  if (req.method === "PUT") {
    const body = await safeParseJson(req);
    if (!body || !isValidUUID(body.id)) return errorResponse("Missing or invalid store id");

    const updateData: Record<string, unknown> = {};
    if (body.slug !== undefined) {
      const s = sanitizeString(body.slug, MAX_SLUG_LEN);
      if (s && isValidSlug(s)) updateData.slug = s;
    }
    if (body.name !== undefined) {
      const n = sanitizeString(body.name, MAX_NAME_LEN);
      if (n) updateData.name = n;
    }
    if (body.city !== undefined) updateData.city = sanitizeString(body.city, 100);
    if (body.is_active !== undefined) updateData.is_active = !!body.is_active;
    if (body.post_auth_redirect_url !== undefined) updateData.post_auth_redirect_url = sanitizeString(body.post_auth_redirect_url, 500);
    if (body.unifi_site_id !== undefined) updateData.unifi_site_id = sanitizeString(body.unifi_site_id, 100);
    if (body.unifi_controller_url !== undefined) updateData.unifi_controller_url = sanitizeString(body.unifi_controller_url, 500);
    if (body.unifi_api_key_or_token !== undefined) {
      updateData.unifi_api_key_or_token = typeof body.unifi_api_key_or_token === "string"
        ? body.unifi_api_key_or_token.trim().slice(0, 500) || null
        : null;
    }

    if (Object.keys(updateData).length === 0) return errorResponse("Nenhum campo para atualizar");

    const { data, error } = await db
      .from("stores")
      .update(updateData)
      .eq("id", body.id as string)
      .select("id, slug, name")
      .single();
    if (error) return errorResponse(error.message, 500);
    return jsonResponse(data);
  }

  if (req.method === "DELETE") {
    const body = await safeParseJson(req);
    if (!body || !isValidUUID(body.id)) return errorResponse("Missing or invalid store id");

    const { error } = await db
      .from("stores")
      .delete()
      .eq("id", body.id as string);
    if (error) return errorResponse(error.message, 500);

    await db.from("audit_logs").insert({
      store_id: body.id as string,
      entity: "store",
      entity_id: body.id as string,
      action: "delete",
      meta: { deleted_by: auth.userId },
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
    .select("id, store_id, session_id, name, email, phone, client_mac, created_at, consented_at, consent_version, source, origin_ip, origin_city, origin_region, stores(slug, name)", { count: "exact" })
    .order("created_at", { ascending: false });

  if (storeId && isValidUUID(storeId)) query = query.eq("store_id", storeId);
  if (from) query = query.gte("created_at", from.length === 10 ? `${from}T00:00:00.000Z` : from);
  if (to) query = query.lte("created_at", to.length === 10 ? `${to}T23:59:59.999Z` : to);

  if (format === "csv") {
    query = query.limit(10000);
    const { data, error } = await query;
    if (error) return errorResponse(error.message, 500);

    const headers = ["id", "store_slug", "name", "email", "phone", "client_mac", "origin_ip", "origin_city", "origin_region", "created_at", "consent_version"];
    const csvRows = [headers.join(",")];
    for (const lead of data || []) {
      const storeInfo = lead.stores as unknown as { slug: string; name: string } | null;
      csvRows.push(
        [
          lead.id,
          storeInfo?.slug || "",
          `"${(lead.name || "").replace(/"/g, '""')}"`,
          lead.email || "",
          lead.phone || "",
          lead.client_mac || "",
          (lead as any).origin_ip || "",
          (lead as any).origin_city || "",
          (lead as any).origin_region || "",
          lead.created_at,
          lead.consent_version,
        ].join(",")
      );
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
    const { data, error } = await db
      .from("consent_versions")
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

    const { data, error } = await db
      .from("consent_versions")
      .insert({ version, text, is_active: true })
      .select("id, version, is_active, created_at")
      .single();
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

// ========== Admin: Origin IP Clusters ==========
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
      csvRows.push([
        c.public_ip,
        c.city || "",
        c.region || "",
        c.country || "",
        c.isp || "",
        c.asn || "",
        c.lead_count,
        c.first_seen_at,
        c.last_seen_at,
      ].join(","));
    }

    return new Response(csvRows.join("\n"), {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="clusters_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  const { data, count, error } = await (query as any).range(offset, offset + limit - 1);
  if (error) return errorResponse(error.message, 500);

  return jsonResponse({ data, total: count, page, limit });
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

  const { data: store } = await db
    .from("stores")
    .select("id, unifi_controller_url, unifi_api_key_or_token, unifi_site_id")
    .eq("slug", storeSlug)
    .maybeSingle();

  if (!store) return errorResponse("Store not found", 404);
  if (!store.unifi_controller_url || !store.unifi_api_key_or_token) {
    return jsonResponse({
      ok: false,
      reason: "UNIFI_NOT_CONFIGURED",
      message: "Loja não possui configuração UniFi completa.",
    });
  }

  const siteId = store.unifi_site_id || "default";
  const result = await unifiAuthorizeWithRetry(
    store.unifi_controller_url,
    store.unifi_api_key_or_token,
    siteId,
    mac
  );

  await db.from("audit_logs").insert({
    store_id: store.id,
    entity: "session",
    entity_id: null,
    action: result.ok ? "test_authorize_success" : "test_authorize_fail",
    meta: {
      mac,
      store_slug: storeSlug,
      result: result.ok ? "success" : result.error?.slice(0, 300),
      attempts: result.attempts,
    },
  });

  return jsonResponse({
    ok: result.ok,
    attempts: result.attempts,
    error: result.ok ? undefined : result.error?.slice(0, 200),
    message: result.ok ? "MAC autorizado com sucesso" : "Falha na autorização",
  });
}

// ========== XML Export (Admin) ==========

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function handleAdminLeadsXml(req: Request, url: URL): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const storeSlug = url.searchParams.get("store_slug");
  const scope = storeSlug ? "store" : (url.searchParams.get("scope") || "all");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  let query = db
    .from("leads")
    .select("id, name, email, phone, client_mac, created_at, consented_at, consent_version, origin_ip, origin_city, origin_region, stores(slug, name)")
    .order("created_at", { ascending: false })
    .limit(10000);

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
    store_id: resolvedStoreId,
    entity: "lead",
    entity_id: null,
    action: "export_xml",
    meta: { scope, store_slug: storeSlug, from, to, count: rows.length },
  });

  return new Response(xml, {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
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
    // Public portal endpoints
    if (path === "/bootstrap" && req.method === "GET") {
      return await handleBootstrap(url);
    }
    if (path === "/start" && req.method === "POST") {
      return await handleStart(req);
    }
    if (path === "/submit" && req.method === "POST") {
      return await handleSubmit(req);
    }

    // Admin endpoints
    if (path === "/admin/stores") return await handleAdminStores(req);
    if (path === "/admin/leads-xml" && req.method === "GET") return await handleAdminLeadsXml(req, url);
    if (path === "/admin/leads") return await handleAdminLeads(req, url);
    if (path === "/admin/consent") return await handleAdminConsent(req);
    if (path === "/admin/sessions") return await handleAdminSessions(req, url);
    if (path === "/admin/clusters") return await handleAdminClusters(req, url);
    if (path === "/admin/test-authorize" && req.method === "POST") return await handleTestAuthorize(req);

    return errorResponse("Not found", 404);
  } catch (err) {
    console.error("Unhandled error:", err);
    return errorResponse("Internal server error", 500);
  }
});
