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
  // Strip control characters, trim, enforce max length
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

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
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

// Periodic cleanup to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 120_000);

// ========== Dedup Map (same MAC within DEDUP_WINDOW_SEC) ==========
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
    // Brief delay before retry
    if (attempt < UNIFI_RETRY_COUNT) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return { ok: false, error: lastError, attempts: UNIFI_RETRY_COUNT + 1 };
}

async function authorizeClient(
  db: ReturnType<typeof supabaseAdmin>,
  storeId: string,
  storeSlug: string,
  clientMac: string | null,
  sessionId: string,
  clientIp: string
): Promise<boolean> {
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
  const rawSlug = url.searchParams.get("store");
  if (!rawSlug) return errorResponse("Missing 'store' parameter");

  const slug = sanitizeString(rawSlug, MAX_SLUG_LEN);
  if (!slug || !isValidSlug(slug)) return errorResponse("Invalid store slug");

  const db = supabaseAdmin();

  const { data: store } = await db
    .from("stores")
    .select("id, slug, name, city, is_active")
    .eq("slug", slug)
    .maybeSingle();

  if (!store) return errorResponse("Store not found", 404);
  if (!store.is_active) return errorResponse("Esta loja está temporariamente indisponível.", 403);

  const { data: consent } = await db
    .from("consent_versions")
    .select("version, text")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

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
  const clientIp = getClientIp(req);

  if (checkRateLimit(`start:${clientIp}`, RATE_LIMIT_MAX_START)) {
    return errorResponse("Muitas requisições. Aguarde um momento.", 429);
  }

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  const storeSlug = sanitizeString(body.store_slug, MAX_SLUG_LEN);
  if (!storeSlug || !isValidSlug(storeSlug)) return errorResponse("Invalid store_slug");

  const db = supabaseAdmin();

  const { data: store } = await db
    .from("stores")
    .select("id, is_active")
    .eq("slug", storeSlug)
    .maybeSingle();

  if (!store) return errorResponse("Store not found", 404);
  if (!store.is_active) return errorResponse("Loja inativa", 403);

  const mac = normalizeMac(body.client_mac);
  const apMac = normalizeMac(body.ap_mac);

  const { data: session, error } = await db
    .from("captive_sessions")
    .insert({
      store_id: store.id,
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
    store_id: store.id,
    entity: "session",
    entity_id: session.id,
    action: "create",
    meta: { client_mac: mac, ip: clientIp, store_slug: storeSlug },
  });

  return jsonResponse({ session_id: session.id });
}

async function handleSubmit(req: Request): Promise<Response> {
  const clientIp = getClientIp(req);

  if (checkRateLimit(`submit:${clientIp}`, RATE_LIMIT_MAX_SUBMIT)) {
    return errorResponse("Muitas tentativas. Aguarde um minuto.", 429);
  }

  const body = await safeParseJson(req);
  if (!body) return errorResponse("Invalid JSON body");

  // --- Validate & sanitize all inputs ---
  const storeSlug = sanitizeString(body.store_slug, MAX_SLUG_LEN);
  if (!storeSlug || !isValidSlug(storeSlug)) return errorResponse("Loja inválida");

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
    // MAC was provided but invalid — log but don't block
    console.warn("Invalid MAC provided:", typeof body.client_mac === "string" ? body.client_mac.slice(0, 20) : "non-string");
  }

  const db = supabaseAdmin();

  // Validate store
  const { data: store } = await db
    .from("stores")
    .select("id, is_active, post_auth_redirect_url")
    .eq("slug", storeSlug)
    .maybeSingle();

  if (!store) return errorResponse("Loja não encontrada", 404);
  if (!store.is_active) return errorResponse("Loja inativa", 403);

  // Validate consent version
  const { data: consent } = await db
    .from("consent_versions")
    .select("version, text")
    .eq("version", consentVersion)
    .maybeSingle();

  if (!consent) return errorResponse("Versão de consentimento inválida");

  // Dedup check: same MAC + store within DEDUP_WINDOW_SEC
  if (clientMac && isDuplicate(clientMac, store.id)) {
    return errorResponse("Cadastro duplicado detectado. Aguarde alguns segundos.", 429);
  }

  // Compute consent text hash for LGPD traceability
  const consentTextHash = consent.text
    ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(consent.text)).then((buf) =>
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
      )
    : null;

  // Create lead — this MUST succeed even if UniFi fails
  const { data: lead, error: leadError } = await db
    .from("leads")
    .insert({
      store_id: store.id,
      session_id: sessionId || null,
      name,
      email: email || null,
      phone: phone || null,
      client_mac: clientMac,
      consented_at: new Date().toISOString(),
      consent_version: consentVersion,
      consent_text_hash: consentTextHash,
      source: "captive_portal",
    })
    .select("id")
    .single();

  if (leadError) {
    console.error("Lead insert error:", leadError.message);
    // Audit the failure
    await db.from("audit_logs").insert({
      store_id: store.id,
      entity: "lead",
      entity_id: null,
      action: "fail",
      meta: {
        error_message: leadError.message.slice(0, 300),
        ip: clientIp,
        store_slug: storeSlug,
        mac: clientMac,
      },
    });
    return errorResponse("Erro ao salvar cadastro. Tente novamente.", 500);
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
    store_id: store.id,
    entity: "lead",
    entity_id: lead.id,
    action: "create",
    meta: { session_id: sessionId, mac: clientMac, ip: clientIp, store_slug: storeSlug },
  });

  // Attempt UniFi authorization (non-blocking for lead)
  let authorized = false;
  if (sessionId && clientMac) {
    try {
      authorized = await authorizeClient(db, store.id, storeSlug, clientMac, sessionId as string, clientIp);
    } catch (err) {
      console.error("UniFi authorization error:", (err as Error).message);
      // Lead is already saved, just log the failure
      await db.from("audit_logs").insert({
        store_id: store.id,
        entity: "session",
        entity_id: sessionId,
        action: "fail",
        meta: {
          reason: "UNIFI_EXCEPTION",
          error_message: (err as Error).message.slice(0, 300),
          mac: clientMac,
          ip: clientIp,
          store_slug: storeSlug,
        },
      });
    }
  }

  // Resolve redirect URL: store override > env > default
  const resolvedRedirectUrl = (store as any).post_auth_redirect_url || DEFAULT_REDIRECT_URL;

  // Audit redirect
  await db.from("audit_logs").insert({
    store_id: store.id,
    entity: "session",
    entity_id: sessionId || null,
    action: "redirect",
    meta: { store_slug: storeSlug, redirect_url: resolvedRedirectUrl, authorized },
  });

  // Never expose technical errors to the user
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

  // Usar getUser em vez de getClaims para melhor compatibilidade
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
    // Never return api tokens even to admin GET list
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
    .select("id, store_id, session_id, name, email, phone, client_mac, created_at, consented_at, consent_version, source, stores(slug, name)", { count: "exact" })
    .order("created_at", { ascending: false });

  if (storeId && isValidUUID(storeId)) query = query.eq("store_id", storeId);
  if (from) query = query.gte("created_at", from.length === 10 ? `${from}T00:00:00.000Z` : from);
  if (to) query = query.lte("created_at", to.length === 10 ? `${to}T23:59:59.999Z` : to);

  if (format === "csv") {
    query = query.limit(10000);
    const { data, error } = await query;
    if (error) return errorResponse(error.message, 500);

    const headers = ["id", "store_slug", "name", "email", "phone", "client_mac", "created_at", "consent_version"];
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
    .select("id, name, email, phone, client_mac, created_at, consented_at, consent_version, stores(slug, name)")
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
    xml += `    <created_at>${escapeXml(lead.created_at)}</created_at>\n`;
    xml += `    <consented_at>${escapeXml(lead.consented_at)}</consented_at>\n`;
    xml += `    <consent_version>${escapeXml(lead.consent_version)}</consent_version>\n`;
    xml += `  </lead>\n`;
  }

  xml += `</leads_export>`;

  const filename = storeSlug ? `leads_${storeSlug}_${dateStamp}.xml` : `leads_all_${dateStamp}.xml`;

  // Audit export
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
    if (path === "/admin/test-authorize" && req.method === "POST") return await handleTestAuthorize(req);

    return errorResponse("Not found", 404);
  } catch (err) {
    console.error("Unhandled error:", err);
    return errorResponse("Internal server error", 500);
  }
});
